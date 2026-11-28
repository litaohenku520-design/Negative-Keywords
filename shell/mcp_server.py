# -*- coding: utf-8 -*-
"""
UPBestKS 否词工具 MCP Server (stdio JSON-RPC 2.0 + MCP App UI)
==============================================================
纯 Python 标准库实现：
- 内部在后台线程启动独立的 serve.py HTTP 服务（127.0.0.1:空闲端口），
  直接以插件内 backend/rules_config.json 作为唯一独立规则源。
- 为 Antigravity Agent 提供否词分类、审计、规则查询与受控更新工具。
- 为否词工作台 UI (MCP App: ui://neg-keyword/app.html) 提供 app_api_request 透传。
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

# 严格保护 MCP stdio 通道：强制 UTF-8 编码，所有普通 print 输出重定向到 stderr
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
_MCP_STDOUT = sys.stdout
sys.stdout = sys.stderr

SHELL_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = SHELL_DIR.parent
NEG_BACKEND_DIR = PLUGIN_ROOT / "tools" / "neg-keyword"
UI_HTML_PATH = SHELL_DIR / "ui" / "dist" / "app.html"
RULES_PATH = NEG_BACKEND_DIR / "rules_config.json"
BACKUPS_DIR = NEG_BACKEND_DIR / "backups"

for _p in (str(SHELL_DIR), str(NEG_BACKEND_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

APP_URI = "ui://neg-keyword/app.html"
SERVER_NAME = "upbestks-neg-keyword"
SERVER_VERSION = "1.0.0"

_EMBEDDED_BASE_URL: str | None = None
_EMBEDDED_LOCK = threading.Lock()


def _ensure_embedded_server() -> str:
    """惰性启动内置 serve.py HTTP 服务（随机空闲端口），返回 base URL。"""
    global _EMBEDDED_BASE_URL
    with _EMBEDDED_LOCK:
        if _EMBEDDED_BASE_URL:
            return _EMBEDDED_BASE_URL

        import serve  # noqa: WPS433

        # 优先绑定固定端口 19890（配合 MCP App frameDomains CSP），若被占用则自动回退空闲端口
        os.environ["AMZ_NEG_PORT"] = "19890"
        orig_argv = sys.argv
        sys.argv = ["serve.py", "--serve", "--port", "19890"]
        try:
            t = threading.Thread(target=serve.serve_mode, daemon=True, name="neg-embedded-http")
            t.start()
        finally:
            sys.argv = orig_argv

        deadline = time.time() + 10.0
        while time.time() < deadline:
            srv = getattr(serve, "_ACTIVE_SERVER", None)
            if srv is not None:
                port = srv.server_address[1]
                if port:
                    _EMBEDDED_BASE_URL = f"http://127.0.0.1:{port}"
                    return _EMBEDDED_BASE_URL
            time.sleep(0.05)
        raise RuntimeError("内置否词 HTTP 服务启动超时")


def _http_call(method: str, path: str, body: dict | list | str | None = None, timeout: int = 120) -> dict | list:
    base_url = _ensure_embedded_server()
    if not path.startswith("/"):
        path = "/" + path
    url = base_url + path
    data_bytes = None
    headers = {"Accept": "application/json"}
    if body is not None and method.upper() not in ("GET", "HEAD"):
        if isinstance(body, str):
            data_bytes = body.encode("utf-8")
        else:
            data_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"

    req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} {path}: {err_body}") from e


def _load_rules_json() -> dict:
    with open(RULES_PATH, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def _backup_rules_file() -> str:
    BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    bak = BACKUPS_DIR / f"rules_config_{ts}.json"
    if not bak.exists() and RULES_PATH.exists():
        shutil.copy2(RULES_PATH, bak)
    return str(bak)


def _rules_summary_dict() -> dict:
    cfg = _load_rules_json()
    return {
        "rules_path": str(RULES_PATH),
        "require_case": cfg.get("require_case", True),
        "intercept_brand": cfg.get("intercept_brand", True),
        "counts": {
            "model_groups": len(cfg.get("model_groups") or []),
            "alias_rules": len(cfg.get("alias_rules") or []),
            "deny_model_library": len(cfg.get("deny_model_library") or []),
            "campaign_group_map": len(cfg.get("campaign_group_map") or {}),
            "deny_brands": len(cfg.get("deny_brands") or []),
            "deny_models": len(cfg.get("deny_models") or []),
            "keep_case_words": len(cfg.get("keep_case_words") or []),
            "screen_protector_words": len(cfg.get("screen_protector_words") or []),
        },
    }


TOOLS = [
    {
        "name": "open_neg_workbench",
        "title": "Discover amzn",
        "description": "打开 Discover amzn 亚马逊运营集成工作台（默认主页面为运营计划，侧边栏集成否词助手、搜索词劣词优化、广告数据汇总、周广告复盘优化、销售采购与补货、库存销售分析、产品库、西柚竞品分析）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "module": {
                    "type": "string",
                    "enum": ["planner", "neg", "roas", "ad-scout", "sales-hub", "weekly-planner", "erp-workbench", "product-hub", "xydc", "aba-rank"],
                    "description": "可选：初始打开的功能模块（默认 planner=运营计划）",
                }
            },
        },
        "_meta": {
            "ui": {"resourceUri": APP_URI},
            "com.google.antigravity/ui": {
                "entrypoints": [
                    {"type": "aux_pane", "title": "Discover amzn"},
                    {"type": "global", "title": "Discover amzn"},
                ]
            },
        },
    },
    {
        "name": "app_api_request",
        "description": "仅供 Discover amzn 工作台 UI 调用的否词后端接口透传。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "method": {"type": "string", "default": "GET"},
                "path": {"type": "string"},
                "body": {},
            },
            "required": ["path"],
        },
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_sub_mcp_open",
        "description": "仅供 Discover amzn 工作台 UI 调用的子插件启动与初始数据拉取。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "pluginId": {"type": "string"},
                "storeId": {"type": "string"},
            },
            "required": ["pluginId"],
        },
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_sub_mcp_call",
        "description": "仅供 Discover amzn 工作台 UI 调用的子插件工具透传。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "pluginId": {"type": "string"},
                "toolName": {"type": "string"},
                "arguments": {"type": "object"},
                "storeId": {"type": "string"},
            },
            "required": ["pluginId", "toolName"],
        },
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "get_neg_rules_summary",
        "description": "获取独立维护的 rules_config.json 规则库统计概要（机型组、别名规则、否词库、品牌词、Campaign映射等数量）。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "query_neg_rules",
        "description": "按模块查询 rules_config.json 中的具体规则，支持关键词过滤和分页。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "section": {
                    "type": "string",
                    "enum": [
                        "model_groups",
                        "alias_rules",
                        "deny_model_library",
                        "campaign_group_map",
                        "deny_brands",
                        "deny_models",
                        "keep_case_words",
                        "screen_protector_words",
                    ],
                    "description": "要查询的配置区块",
                },
                "keyword": {"type": "string", "description": "可选过滤关键词（不区分大小写）"},
                "limit": {"type": "integer", "default": 30},
                "offset": {"type": "integer", "default": 0},
            },
            "required": ["section"],
        },
    },
    {
        "name": "classify_search_terms",
        "description": "调用否词引擎对搜索词列表执行自动分类（deny/keep/review），并给出命中规则与原因。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "description": "待分类条目列表，每项至少包含 searchTerm 和 campaign（可选）",
                    "items": {
                        "type": "object",
                        "properties": {
                            "searchTerm": {"type": "string"},
                            "campaign": {"type": "string"},
                            "adGroup": {"type": "string"},
                        },
                        "required": ["searchTerm"],
                    },
                },
                "site": {"type": "string", "default": "usa", "description": "站点，如 usa, uk, de, fr, it, es, ca, jp"},
                "require_case": {"type": "boolean", "default": True},
                "intercept_brand": {"type": "boolean", "default": True},
            },
            "required": ["items"],
        },
    },
    {
        "name": "audit_neg_results",
        "description": "调用 neg_audit_engine 对分类结果进行误否、冲突词、机型错配、漏否垃圾词等深度审计。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "rows": {
                    "type": "array",
                    "description": "分类后的结果行（包含 searchTerm/campaign/tag/reason 等）",
                    "items": {"type": "object"},
                },
                "site": {"type": "string", "default": "usa"},
            },
            "required": ["rows"],
        },
    },
    {
        "name": "update_neg_rules_partial",
        "description": "受控更新 rules_config.json 的指定字段（如 deny_brands/keep_case_words/campaign_group_map 等），更新前自动备份到 backups/。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "patch": {
                    "type": "object",
                    "description": "要合并更新的顶层键值对",
                },
            },
            "required": ["patch"],
        },
    },
]


def _handle_tool_call(name: str, args: dict) -> dict:
    if name == "open_neg_workbench":
        # 后台预热内置 HTTP 服务，避免首次点击面板时等待规则加载
        threading.Thread(target=_ensure_embedded_server, daemon=True).start()
        summary = _rules_summary_dict()
        mod = args.get("module")
        if mod:
            summary["module"] = mod
        return {
            "content": [{"type": "text", "text": json.dumps(summary, ensure_ascii=False, indent=2)}],
            "structuredContent": summary,
        }

    if name == "app_sub_mcp_open":
        from sub_mcp_bridge import open_sub_plugin  # noqa: WPS433
        from config import get_stores_state  # noqa: WPS433

        plugin_id = str(args.get("pluginId") or "").strip()
        store_id = str(args.get("storeId") or get_stores_state().get("active_store_id") or "default").strip()
        base_url = _ensure_embedded_server()
        res = open_sub_plugin(plugin_id, store_id=store_id)
        res["subUrl"] = f"{base_url}/sub/{plugin_id}"
        return {
            "content": [{"type": "text", "text": json.dumps(res, ensure_ascii=False)}],
            "structuredContent": res,
        }

    if name == "app_sub_mcp_call":
        from sub_mcp_bridge import call_sub_plugin_tool  # noqa: WPS433
        from config import get_stores_state  # noqa: WPS433

        plugin_id = str(args.get("pluginId") or "").strip()
        tool_name = str(args.get("toolName") or "").strip()
        tool_args = args.get("arguments") or {}
        store_id = str(args.get("storeId") or get_stores_state().get("active_store_id") or "default").strip()
        res = call_sub_plugin_tool(plugin_id, tool_name, tool_args, store_id=store_id)
        return {
            "content": [{"type": "text", "text": json.dumps(res, ensure_ascii=False)}],
            "structuredContent": res,
        }

    if name == "app_api_request":
        method = str(args.get("method") or "GET").upper()
        path = str(args.get("path") or "")
        body = args.get("body")
        data = _http_call(method, path, body=body)
        return {
            "content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}],
            "structuredContent": {"ok": True, "data": data},
        }

    if name == "get_neg_rules_summary":
        summary = _rules_summary_dict()
        return {"content": [{"type": "text", "text": json.dumps(summary, ensure_ascii=False, indent=2)}]}

    if name == "query_neg_rules":
        section = args["section"]
        kw = (args.get("keyword") or "").strip().lower()
        limit = max(1, min(int(args.get("limit") or 30), 200))
        offset = max(0, int(args.get("offset") or 0))
        cfg = _load_rules_json()
        raw = cfg.get(section)
        if isinstance(raw, list):
            filtered = [
                item for item in raw
                if not kw or kw in json.dumps(item, ensure_ascii=False).lower()
            ]
            total = len(filtered)
            items = filtered[offset : offset + limit]
        elif isinstance(raw, dict):
            pairs = [
                {k: v} for k, v in raw.items()
                if not kw or kw in k.lower() or kw in json.dumps(v, ensure_ascii=False).lower()
            ]
            total = len(pairs)
            items = pairs[offset : offset + limit]
        else:
            total = 0
            items = []
        return {
            "content": [{
                "type": "text",
                "text": json.dumps({"section": section, "total": total, "offset": offset, "limit": limit, "items": items}, ensure_ascii=False, indent=2),
            }]
        }

    if name == "classify_search_terms":
        raw_items = args.get("items") or []
        norm_items = [
            {**it, "term": it.get("term") or it.get("searchTerm") or ""}
            for it in raw_items if isinstance(it, dict)
        ]
        payload = {
            "items": norm_items,
            "site": args.get("site") or "usa",
            "require_case": args.get("require_case", True),
            "intercept_brand": args.get("intercept_brand", True),
        }
        res = _http_call("POST", "/classify", body=payload)
        return {"content": [{"type": "text", "text": json.dumps(res, ensure_ascii=False, indent=2)}]}

    if name == "audit_neg_results":
        from neg_audit_engine import run_audit  # noqa: WPS433

        rows = args.get("rows") or []
        site = args.get("site") or "usa"
        report = run_audit(rows, site=site) if "site" in run_audit.__code__.co_varnames else run_audit(rows)
        return {"content": [{"type": "text", "text": json.dumps(report, ensure_ascii=False, indent=2)}]}

    if name == "update_neg_rules_partial":
        patch = args.get("patch")
        if not isinstance(patch, dict) or not patch:
            raise ValueError("patch 必须是非空对象")
        backup_path = _backup_rules_file()
        res = _http_call("POST", "/api/config/partial", body=patch)
        return {
            "content": [{
                "type": "text",
                "text": json.dumps({"ok": True, "backup": backup_path, "result": res}, ensure_ascii=False, indent=2),
            }]
        }

    raise ValueError(f"Unknown tool: {name}")


def _read_ui_html() -> str:
    if UI_HTML_PATH.exists():
        return UI_HTML_PATH.read_text(encoding="utf-8")
    return "<html><body><h3>否词工具 UI 尚未构建（缺少 ui/dist/app.html）</h3></body></html>"


def _send_json_rpc(obj: dict) -> None:
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    _MCP_STDOUT.write(line)
    _MCP_STDOUT.flush()


def _handle_request(req: dict) -> dict | None:
    req_id = req.get("id")
    method = req.get("method")
    params = req.get("params") or {}

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": params.get("protocolVersion") or "2024-11-05",
                "capabilities": {
                    "tools": {},
                    "resources": {},
                },
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            },
        }
    if method == "notifications/initialized":
        return None
    if method == "ping":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        try:
            res = _handle_tool_call(params.get("name", ""), params.get("arguments") or {})
            return {"jsonrpc": "2.0", "id": req_id, "result": res}
        except Exception as e:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "isError": True,
                    "content": [{"type": "text", "text": f"Error: {e}"}],
                },
            }
    if method == "resources/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "resources": [
                    {
                        "uri": APP_URI,
                        "name": "Discover amzn",
                        "mimeType": "text/html;profile=mcp-app",
                        "_meta": {
                            "ui": {
                                "prefersBorder": False,
                                "csp": {
                                    "frameDomains": ["http://127.0.0.1:19890", "http://localhost:19890"],
                                },
                            }
                        },
                    }
                ]
            },
        }
    if method == "resources/read":
        uri = params.get("uri")
        if uri == APP_URI:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "contents": [
                        {
                            "uri": APP_URI,
                            "mimeType": "text/html;profile=mcp-app",
                            "text": _read_ui_html(),
                            "_meta": {
                                "ui": {
                                    "prefersBorder": False,
                                    "csp": {
                                        "frameDomains": ["http://127.0.0.1:19890", "http://localhost:19890"],
                                    },
                                }
                            },
                        }
                    ]
                },
            }
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": f"Unknown resource: {uri}"}}

    if req_id is not None:
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}
    return None


def main() -> None:
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            _send_json_rpc({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(e)}})
            continue
        resp = _handle_request(req)
        if resp is not None:
            _send_json_rpc(resp)


if __name__ == "__main__":
    main()
