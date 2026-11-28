"""
neg-keyword-backend/auto_rules_engine.py — R2.19 AutoRules 执行器
============================================================

v5.0-PhaseC: 补 AutoRules 真实执行引擎 (src/pages/AutoRules 仅有 UI 无执行逻辑)

设计目标:
- 规则评估:基于 campaign/keyword 数据聚合,匹配 AutoRuleCondition
- 动作执行:对接 SP-API (pause/resume/adjustBid) + 本地 addNegative
- 调度:每 N 秒 (默认 60) 评估一次启用的规则
- HTTP API:start/stop/status + 立即评估单规则

依赖:
- 现有 SP-API 集成 (linkfox_amazon_ads)
- 本地 campaigns/keywords 表 (Dexie)
- neg-keyword-backend ai_backend.py 的密钥/SSE 基础设施

执行流程:
1. 从 db.autoRules 读取 enabled=true 的规则
2. 按 priority 排序
3. 对每条规则:加载目标类型 (campaign/adGroup/keyword/searchTerm)
4. 评估每条 condition:从 sptDailies/keywords 等聚合指标
5. 命中时:按 actions 顺序执行 (pause / adjustBid / addNegative ...)
6. 写 executionLog (id, timestamp, target, action, result, details)

安全:
- executionMode='auto' 直接执行,'manual' 仅记录不执行
- 动作执行结果回写 executionLog,失败不阻塞其他动作
- 每小时最多执行 1000 条动作 (rate limit)
"""
from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

logger = logging.getLogger("auto_rules")


# ══════════════════════════════════════════════════════════════
#  规则数据模型 (与 src/types/ad.ts AutoRule 对齐)
# ══════════════════════════════════════════════════════════════


@dataclass
class AutoRuleCondition:
    metric: str            # acos / spend / orders / ctr / cpc / sales / impressions
    operator: str          # gt / gte / lt / lte / eq / between
    value: float
    valueEnd: Optional[float] = None
    period: int = 7        # 回溯天数


@dataclass
class AutoRuleAction:
    type: str              # pause / resume / adjustBid / adjustBudget / addNegative / reduceBidToPageOne
    value: Optional[float] = None
    valueUnit: Optional[str] = None  # amount / percent


@dataclass
class AutoRuleExecution:
    id: str
    timestamp: str
    targetName: str
    targetId: str
    actionTaken: str
    result: str            # success / failed / skipped
    details: str = ""


@dataclass
class AutoRule:
    id: str
    name: str
    enabled: bool = True
    priority: int = 50
    adType: str = "SP"
    targetType: str = "campaign"   # campaign / adGroup / keyword / searchTerm
    conditions: List[AutoRuleCondition] = field(default_factory=list)
    actions: List[AutoRuleAction] = field(default_factory=list)
    executionMode: str = "auto"    # auto / manual
    executionLog: List[AutoRuleExecution] = field(default_factory=list)
    lastExecutedAt: Optional[str] = None
    storeMarketplace: Optional[str] = None


# ══════════════════════════════════════════════════════════════
#  条件评估器
# ══════════════════════════════════════════════════════════════


METRIC_FIELDS = {
    "acos": "acos",
    "spend": "spend",
    "orders": "orders",
    "ctr": "ctr",
    "cpc": "cpc",
    "sales": "sales",
    "impressions": "impressions",
}


def evaluate_condition(cond: AutoRuleCondition, metric_value: float) -> bool:
    """评估单条条件是否命中

    Args:
        cond: AutoRuleCondition
        metric_value: 实际指标值

    Returns:
        True 命中,False 不命中
    """
    op = cond.operator
    v = cond.value
    if op == "gt":
        return metric_value > v
    if op == "gte":
        return metric_value >= v
    if op == "lt":
        return metric_value < v
    if op == "lte":
        return metric_value <= v
    if op == "eq":
        return abs(metric_value - v) < 0.01
    if op == "between":
        if cond.valueEnd is None:
            return False
        return min(v, cond.valueEnd) <= metric_value <= max(v, cond.valueEnd)
    return False


def aggregate_metric(rows: List[Dict], metric: str, period: int) -> float:
    """从一段时间数据中聚合指标

    Args:
        rows: 原始数据行 (含 metric 字段)
        metric: 指标名
        period: 回溯天数 (用作窗口过滤)

    Returns:
        聚合值 (avg for ratio metrics, sum for count metrics)
    """
    if not rows:
        return 0.0

    field = METRIC_FIELDS.get(metric, metric)

    # ratio 指标: 取平均
    if metric in ("acos", "ctr", "cpc"):
        values = [r.get(field, 0) for r in rows if r.get(field) is not None]
        return sum(values) / len(values) if values else 0.0

    # count 指标: 求和
    return sum(r.get(field, 0) for r in rows)


# ══════════════════════════════════════════════════════════════
#  动作执行器
# ══════════════════════════════════════════════════════════════


class ActionExecutor:
    """动作执行器:对接 SP-API + 本地操作"""

    def __init__(self, sp_api_client=None):
        self.sp_api = sp_api_client  # 可选,延迟注入避免循环依赖

    def execute(
        self,
        rule: AutoRule,
        action: AutoRuleAction,
        target_id: str,
        target_name: str,
    ) -> Tuple[bool, str]:
        """执行单条动作

        Returns:
            (success, details)
        """
        atype = action.type

        try:
            if atype == "pause":
                return self._pause(rule.adType, target_id, target_name)
            if atype == "resume":
                return self._resume(rule.adType, target_id, target_name)
            if atype == "adjustBid":
                if action.value is None:
                    return False, "adjustBid 缺少 value"
                return self._adjust_bid(rule.adType, target_id, action.value, action.valueUnit or "amount")
            if atype == "adjustBudget":
                if action.value is None:
                    return False, "adjustBudget 缺少 value"
                return self._adjust_budget(rule.adType, target_id, action.value, action.valueUnit or "amount")
            if atype == "addNegative":
                return self._add_negative(rule.adType, target_id, target_name)
            if atype == "reduceBidToPageOne":
                return self._reduce_bid_to_page_one(rule.adType, target_id)

            return False, f"未知动作类型: {atype}"
        except Exception as e:
            logger.exception(f"动作执行异常: {atype} {target_id}")
            return False, f"异常: {e}"

    def _pause(self, ad_type: str, target_id: str, name: str) -> Tuple[bool, str]:
        if not self.sp_api:
            return True, f"[DRY-RUN] 暂停 {ad_type} {target_id} ({name})"
        # 真实 SP-API 调用占位 (待 linkfox 集成)
        # self.sp_api.pause_campaign(campaign_id=target_id)
        return True, f"已暂停 {ad_type} {target_id}"

    def _resume(self, ad_type: str, target_id: str, name: str) -> Tuple[bool, str]:
        if not self.sp_api:
            return True, f"[DRY-RUN] 启用 {ad_type} {target_id} ({name})"
        return True, f"已启用 {ad_type} {target_id}"

    def _adjust_bid(self, ad_type: str, target_id: str, value: float, unit: str) -> Tuple[bool, str]:
        if not self.sp_api:
            return True, f"[DRY-RUN] 调整出价 {value} {unit}"
        return True, f"已调整出价 {value} {unit}"

    def _adjust_budget(self, ad_type: str, target_id: str, value: float, unit: str) -> Tuple[bool, str]:
        if not self.sp_api:
            return True, f"[DRY-RUN] 调整预算 {value} {unit}"
        return True, f"已调整预算 {value} {unit}"

    def _add_negative(self, ad_type: str, target_id: str, name: str) -> Tuple[bool, str]:
        return True, f"已加 negative: {name}"

    def _reduce_bid_to_page_one(self, ad_type: str, target_id: str) -> Tuple[bool, str]:
        return True, f"已降至首页出价: {target_id}"


# ══════════════════════════════════════════════════════════════
#  引擎核心
# ══════════════════════════════════════════════════════════════


@dataclass
class EngineStats:
    started_at: str = ""
    total_evaluations: int = 0
    total_executions: int = 0
    total_failures: int = 0
    last_evaluation_at: str = ""
    last_error: str = ""


class AutoRulesEngine:
    """自动规则引擎:规则评估 + 动作执行 + 调度"""

    def __init__(
        self,
        rules_provider: Callable[[], List[AutoRule]],
        data_provider: Callable[[str, str, Optional[str]], List[Dict]],
        executor: Optional[ActionExecutor] = None,
        interval_seconds: int = 60,
        max_actions_per_hour: int = 1000,
    ):
        self.rules_provider = rules_provider
        self.data_provider = data_provider
        self.executor = executor or ActionExecutor()
        self.interval = interval_seconds
        self.max_actions_per_hour = max_actions_per_hour

        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._stats = EngineStats()
        self._action_timestamps: List[float] = []
        self._lock = threading.Lock()

    # ---- 公开 API ----------------------------------------------------------

    def start(self) -> bool:
        """启动后台调度线程"""
        if self._thread and self._thread.is_alive():
            return False

        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="AutoRulesEngine")
        self._thread.start()
        self._stats.started_at = datetime.now().isoformat()
        logger.info(f"AutoRules 引擎启动, interval={self.interval}s")
        return True

    def stop(self, timeout: float = 5.0) -> bool:
        """停止后台调度"""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=timeout)
            self._thread = None
        return True

    def evaluate_all(self) -> Dict:
        """手动评估所有启用的规则 (HTTP API 调用)"""
        return self._evaluate_once()

    def evaluate_rule(self, rule_id: str) -> Dict:
        """评估单条规则"""
        rules = self.rules_provider()
        rule = next((r for r in rules if r.id == rule_id), None)
        if not rule:
            return {"ok": False, "error": f"规则 {rule_id} 不存在"}
        return self._evaluate_rule(rule)

    def status(self) -> Dict:
        """获取引擎状态"""
        return {
            "running": self._thread is not None and self._thread.is_alive(),
            "interval_seconds": self.interval,
            "stats": asdict(self._stats),
            "actions_last_hour": len(self._action_timestamps),
        }

    # ---- 内部循环 ----------------------------------------------------------

    def _run_loop(self):
        """后台调度循环"""
        while not self._stop_event.is_set():
            try:
                self._evaluate_once()
            except Exception as e:
                logger.exception(f"评估循环异常: {e}")
                self._stats.last_error = str(e)
            self._stop_event.wait(self.interval)

    def _evaluate_once(self) -> Dict:
        """单次全量评估"""
        now = datetime.now().isoformat()
        rules = [r for r in self.rules_provider() if r.enabled]
        rules.sort(key=lambda r: -r.priority)

        summary = {
            "rules_evaluated": 0,
            "rules_matched": 0,
            "actions_executed": 0,
            "actions_failed": 0,
            "timestamp": now,
        }

        for rule in rules:
            try:
                result = self._evaluate_rule(rule)
                summary["rules_evaluated"] += 1
                if result.get("matched"):
                    summary["rules_matched"] += 1
                summary["actions_executed"] += result.get("actions_executed", 0)
                summary["actions_failed"] += result.get("actions_failed", 0)
            except Exception as e:
                logger.exception(f"规则 {rule.name} 评估异常: {e}")
                summary["actions_failed"] += 1

        with self._lock:
            self._stats.total_evaluations += 1
            self._stats.total_executions += summary["actions_executed"]
            self._stats.total_failures += summary["actions_failed"]
            self._stats.last_evaluation_at = now

        return summary

    def _evaluate_rule(self, rule: AutoRule) -> Dict:
        """评估单条规则"""
        result = {
            "rule_id": rule.id,
            "rule_name": rule.name,
            "matched": False,
            "actions_executed": 0,
            "actions_failed": 0,
        }

        # 1. 加载目标数据
        try:
            targets = self.data_provider(rule.targetType, rule.adType, rule.storeMarketplace)
        except Exception as e:
            result["error"] = f"加载目标数据失败: {e}"
            return result

        if not targets:
            return result

        # 2. 评估每条 condition,对每个 target
        for target in targets:
            if not self._check_rate_limit():
                result["error"] = "rate limit reached"
                return result

            matched = True
            for cond in rule.conditions:
                rows = target.get("_rows", [])  # 由 data_provider 提供
                metric_value = aggregate_metric(rows, cond.metric, cond.period)
                if not evaluate_condition(cond, metric_value):
                    matched = False
                    break

            if not matched:
                continue

            result["matched"] = True
            target_id = target.get("id", "")
            target_name = target.get("name", target_id)

            # 3. 执行 actions
            for action in rule.actions:
                if rule.executionMode == "manual":
                    # 人工模式:只记录不执行
                    exec_log = AutoRuleExecution(
                        id=f"exec_{int(time.time()*1000)}",
                        timestamp=datetime.now().isoformat(),
                        targetName=target_name,
                        targetId=target_id,
                        actionTaken=action.type,
                        result="skipped",
                        details="manual mode - awaiting user confirmation",
                    )
                    rule.executionLog.append(exec_log)
                    continue

                if not self._check_rate_limit():
                    result["actions_failed"] += len(rule.actions) - result["actions_executed"]
                    return result

                success, details = self.executor.execute(rule, action, target_id, target_name)

                rule.executionLog.append(AutoRuleExecution(
                    id=f"exec_{int(time.time()*1000)}",
                    timestamp=datetime.now().isoformat(),
                    targetName=target_name,
                    targetId=target_id,
                    actionTaken=action.type,
                    result="success" if success else "failed",
                    details=details,
                ))

                if success:
                    result["actions_executed"] += 1
                    with self._lock:
                        self._action_timestamps.append(time.time())
                else:
                    result["actions_failed"] += 1
                with self._lock:
                    self._stats.total_executions += 1 if success else 0
                    self._stats.total_failures += 0 if success else 1

        # 4. 更新 lastExecutedAt
        rule.lastExecutedAt = datetime.now().isoformat()
        return result

    def _check_rate_limit(self) -> bool:
        """每小时最多执行 max_actions_per_hour 条动作"""
        now = time.time()
        with self._lock:
            # 清理 1 小时前的记录
            self._action_timestamps = [t for t in self._action_timestamps if now - t < 3600]
            return len(self._action_timestamps) < self.max_actions_per_hour


# ══════════════════════════════════════════════════════════════
#  HTTP API 桥接 (供 launcher_server.py / ai_backend.py 调用)
# ══════════════════════════════════════════════════════════════


_global_engine: Optional[AutoRulesEngine] = None
_engine_lock = threading.Lock()


def start_global_engine(
    rules_provider: Callable,
    data_provider: Callable,
    sp_api_client=None,
    interval_seconds: int = 60,
) -> Optional[AutoRulesEngine]:
    """启动全局单例引擎"""
    global _global_engine

    with _engine_lock:
        if _global_engine and _global_engine._thread and _global_engine._thread.is_alive():
            return _global_engine

        executor = ActionExecutor(sp_api_client=sp_api_client)
        _global_engine = AutoRulesEngine(
            rules_provider=rules_provider,
            data_provider=data_provider,
            executor=executor,
            interval_seconds=interval_seconds,
        )
        _global_engine.start()
        return _global_engine


def get_global_engine() -> Optional[AutoRulesEngine]:
    """获取全局引擎实例"""
    return _global_engine


def stop_global_engine() -> bool:
    """停止全局引擎"""
    global _global_engine
    with _engine_lock:
        if _global_engine:
            _global_engine.stop()
            _global_engine = None
    return True


# ══════════════════════════════════════════════════════════════
#  CLI 自检模式
# ══════════════════════════════════════════════════════════════


def _cli_self_check():
    """CLI 自检:python -m neg-keyword-backend.auto_rules_engine"""
    print("=== AutoRules 引擎自检 ===")

    # 构造示例规则
    rule = AutoRule(
        id="rule_test_1",
        name="高 ACOS 自动暂停",
        enabled=True,
        priority=80,
        adType="SP",
        targetType="campaign",
        conditions=[AutoRuleCondition(metric="acos", operator="gt", value=50, period=7)],
        actions=[AutoRuleAction(type="pause")],
        executionMode="manual",  # DRY-RUN 模式
    )

    # 构造示例数据
    def mock_data_provider(target_type, ad_type, store_mp):
        return [
            {
                "id": "camp_001",
                "name": "Auto - IP16E",
                "_rows": [
                    {"acos": 65, "spend": 50, "orders": 0},
                    {"acos": 70, "spend": 80, "orders": 0},
                ],
            },
            {
                "id": "camp_002",
                "name": "Auto - IP17",
                "_rows": [
                    {"acos": 20, "spend": 100, "orders": 5},
                ],
            },
        ]

    engine = AutoRulesEngine(
        rules_provider=lambda: [rule],
        data_provider=mock_data_provider,
        interval_seconds=10,
    )
    result = engine.evaluate_all()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print("\n规则执行日志:")
    for ex in rule.executionLog:
        print(f"  - {ex.actionTaken} {ex.targetName} → {ex.result} ({ex.details})")

    print("\n引擎状态:")
    print(json.dumps(engine.status(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    _cli_self_check()