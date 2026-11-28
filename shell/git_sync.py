# -*- coding: utf-8 -*-
"""
GitHub 实时同步模块 (git_sync.py)
==================================
将独立插件内的规则配置（rules_config.json 及分店铺 stores/）自动 commit 并 push 到 GitHub。
支持：
- 同步模式（用于「一键同步配置」按钮，立即返回 commit hash 或状态）
- 异步防抖模式（用于平时保存/修改规则时后台静默推送，不阻塞 UI）
"""
from __future__ import annotations

import os
import subprocess
import threading
import time

PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_GIT_LOCK = threading.Lock()
_DEBOUNCE_LOCK = threading.Lock()
_DEBOUNCE_TIMER: threading.Timer | None = None
_LAST_SYNC_STATUS: dict = {
    "ok": True,
    "changed": False,
    "commit": "",
    "message": "尚未同步",
    "timestamp": "",
}


def get_last_sync_status() -> dict:
    return dict(_LAST_SYNC_STATUS)


def pull_from_github(timeout: int = 10) -> dict:
    """启动或刷新时从 GitHub origin/main 拉取最新配置与店铺数据。"""
    with _GIT_LOCK:
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        try:
            rc_f, _, err_f = _run_git(["fetch", "origin", "main"], timeout=timeout)
            if rc_f != 0:
                return {"ok": False, "updated": False, "message": err_f or "git fetch failed", "timestamp": ts}
            rc_cnt, out_cnt, _ = _run_git(["rev-list", "--count", "HEAD..origin/main"], timeout=5)
            behind = int(out_cnt) if (rc_cnt == 0 and out_cnt.isdigit()) else 0
            if behind == 0:
                return {"ok": True, "updated": False, "message": "本地已是 GitHub 最新版本", "timestamp": ts}
            rc_rb, out_rb, err_rb = _run_git(["pull", "--rebase", "--autostash", "origin", "main"], timeout=max(timeout, 15))
            if rc_rb != 0:
                _run_git(["rebase", "--abort"], timeout=5)
                return {"ok": False, "updated": False, "message": err_rb or out_rb or "git pull --rebase failed", "timestamp": ts}
            return {"ok": True, "updated": True, "message": f"已从 GitHub 拉取 {behind} 个新提交", "timestamp": ts}
        except Exception as exc:
            return {"ok": False, "updated": False, "message": str(exc), "timestamp": ts}


def _run_git(args: list[str], timeout: int = 25) -> tuple[int, str, str]:
    proc = subprocess.run(
        ["git", *args],
        cwd=PLUGIN_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    return proc.returncode, (proc.stdout or "").strip(), (proc.stderr or "").strip()


def sync_to_github(reason: str = "update neg-keyword rules", timeout: int = 25) -> dict:
    """将规则配置文件同步提交并推送到 GitHub 远程仓库。"""
    global _LAST_SYNC_STATUS
    with _GIT_LOCK:
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        try:
            # 1. 暂存所有工具的规则与业务数据目录（避免误提交临时文件）
            add_targets = [
                "tools/neg-keyword/rules_config.json",
                "tools/neg-keyword/stores",
                "tools/neg-keyword/ai_templates.json",
                "tools/neg-keyword/knowledge_base.json",
                "tools/ops-planner/server/data",
                "tools/sales-hub/server/data",
                "tools/weekly-planner/server/data",
                "tools/erp-workbench/server/data",
                "tools/xydc-asin-analyzer/server/data",
            ]
            existing = [
                t for t in add_targets
                if os.path.exists(os.path.join(PLUGIN_ROOT, t))
            ]
            if not existing:
                _LAST_SYNC_STATUS = {
                    "ok": False, "changed": False, "commit": "",
                    "message": "未找到可同步的规则文件", "timestamp": ts,
                }
                return dict(_LAST_SYNC_STATUS)

            rc, _, err = _run_git(["add", "--", *existing], timeout=10)
            if rc != 0:
                raise RuntimeError(f"git add 失败: {err}")

            # 2. 检查是否有已暂存变更
            rc_diff, _, _ = _run_git(["diff", "--cached", "--quiet"], timeout=10)
            has_staged_changes = (rc_diff != 0)

            commit_hash = ""
            if has_staged_changes:
                msg = f"sync: {reason}"
                rc_c, _, err_c = _run_git(["commit", "-m", msg], timeout=15)
                if rc_c != 0:
                    raise RuntimeError(f"git commit 失败: {err_c}")

            rc_rev, out_rev, _ = _run_git(["rev-parse", "--short", "HEAD"], timeout=5)
            if rc_rev == 0:
                commit_hash = out_rev

            # 3. 检查本地是否领先远程（包括之前未推成功的提交）
            rc_ahead, out_ahead, _ = _run_git(["rev-list", "--count", "origin/main..main"], timeout=10)
            ahead_count = int(out_ahead) if (rc_ahead == 0 and out_ahead.isdigit()) else (1 if has_staged_changes else 0)

            if ahead_count == 0 and not has_staged_changes:
                _LAST_SYNC_STATUS = {
                    "ok": True,
                    "changed": False,
                    "commit": commit_hash,
                    "message": f"GitHub 已是最新 ({commit_hash})",
                    "timestamp": ts,
                }
                return dict(_LAST_SYNC_STATUS)

            # 4. 推送到 origin main（若远程有新提交导致 rejected，自动 pull --rebase 后重试一次）
            rc_p, out_p, err_p = _run_git(["push", "origin", "main"], timeout=timeout)
            if rc_p != 0 and ("fetch first" in (err_p + out_p) or "non-fast-forward" in (err_p + out_p) or "rejected" in (err_p + out_p)):
                _run_git(["fetch", "origin", "main"], timeout=15)
                rc_rb, out_rb, err_rb = _run_git(["rebase", "origin/main", "-X", "theirs"], timeout=20)
                if rc_rb != 0:
                    _run_git(["rebase", "--abort"], timeout=10)
                    raise RuntimeError(err_rb or out_rb or "git rebase failed")
                rc_rev2, out_rev2, _ = _run_git(["rev-parse", "--short", "HEAD"], timeout=5)
                if rc_rev2 == 0:
                    commit_hash = out_rev2
                rc_p, out_p, err_p = _run_git(["push", "origin", "main"], timeout=timeout)
            if rc_p != 0:
                raise RuntimeError(err_p or out_p or "git push failed")

            _LAST_SYNC_STATUS = {
                "ok": True,
                "changed": True,
                "commit": commit_hash,
                "message": f"已实时同步至 GitHub ({commit_hash})",
                "timestamp": ts,
            }
            return dict(_LAST_SYNC_STATUS)
        except Exception as e:
            _LAST_SYNC_STATUS = {
                "ok": False,
                "changed": False,
                "commit": "",
                "message": f"GitHub 同步失败: {e}",
                "timestamp": ts,
            }
            return dict(_LAST_SYNC_STATUS)


def schedule_sync_to_github(reason: str = "auto save rules", delay_sec: float = 1.5) -> None:
    """异步防抖推送：连续保存时合并为一次 git commit & push，不阻塞请求返回。"""
    global _DEBOUNCE_TIMER
    with _DEBOUNCE_LOCK:
        if _DEBOUNCE_TIMER is not None:
            _DEBOUNCE_TIMER.cancel()
        _DEBOUNCE_TIMER = threading.Timer(delay_sec, sync_to_github, kwargs={"reason": reason})
        _DEBOUNCE_TIMER.daemon = True
        _DEBOUNCE_TIMER.start()
