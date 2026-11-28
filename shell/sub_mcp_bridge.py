# -*- coding: utf-8 -*-
"""
Discover AMZN 子插件 MCP 路由器 (sub_mcp_bridge.py)
===================================================
按需惰性启动并托管本机已安装的亚马逊 Node.js MCP 插件进程，
使 Discover AMZN 统一工作台能够在一处界面内无缝调用所有插件的完整前后端能力。
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

SHELL_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = SHELL_DIR.parent
TOOLS_ROOT = PLUGIN_ROOT / "tools"

SUB_PLUGIN_SPECS: dict[str, dict[str, Any]] = {
    "amz-ops-planner": {
        "folder": "ops-planner",
        "title": "运营计划",
        "entry_tool": "open_planner",
        "entry_args": {},
        "args_extra": [f"--data-dir={(TOOLS_ROOT / 'ops-planner' / 'server' / 'data').as_posix()}"],
    },
    "upbestks-ad-scout": {
        "folder": "ad-scout",
        "title": "广告推广侦察",
        "entry_tool": "open_ad_scout",
        "entry_args": {},
        "args_extra": [],
    },
    "upbestks-sales-hub": {
        "folder": "sales-hub",
        "title": "销售看板",
        "entry_tool": "open_sales_dashboard",
        "entry_args": {},
        "args_extra": [],
    },
    "upbestks-weekly-planner": {
        "folder": "weekly-planner",
        "title": "周广告优化",
        "entry_tool": "open_plan",
        "entry_args": {},
        "args_extra": [],
    },
    "upbestks-erp-workbench": {
        "folder": "erp-workbench",
        "title": "库存销售分析",
        "entry_tool": "open_workbench",
        "entry_args": {"tab": "inventory"},
        "args_extra": [],
    },
    "upbestks-product-hub": {
        "folder": "product-hub",
        "title": "产品库",
        "entry_tool": "open_product_dashboard",
        "entry_args": {},
        "args_extra": [],
    },
    "xydc-asin-analyzer": {
        "folder": "xydc-asin-analyzer",
        "title": "西柚竞品分析",
        "entry_tool": "open_asin_analyzer",
        "entry_args": {},
        "args_extra": [],
    },
}


class _NodeMcpClient:
    def __init__(self, plugin_id: str, spec: dict[str, Any]):
        self.plugin_id = plugin_id
        self.spec = spec
        self.plugin_dir = TOOLS_ROOT / spec["folder"]
        self.server_script = self.plugin_dir / "server" / "server.mjs"
        self.html_path = self.plugin_dir / "server" / "dist" / "app.html"
        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()
        self._req_id = 0
        self._initialized = False

    def _ensure_started(self) -> None:
        if self._proc is not None and self._proc.poll() is None and self._initialized:
            return
        if not self.server_script.exists():
            raise FileNotFoundError(f"未找到子插件服务端: {self.server_script}")

        cmd = ["node", str(self.server_script), *(self.spec.get("args_extra") or [])]
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        self._proc = subprocess.Popen(
            cmd,
            cwd=str(self.plugin_dir),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=creationflags,
        )
        self._initialized = False
        self._rpc_raw("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "discover-amzn-host", "version": "2.0.0"},
        })
        self._notify_raw("notifications/initialized", {})
        self._initialized = True

    def _notify_raw(self, method: str, params: dict) -> None:
        assert self._proc and self._proc.stdin
        payload = json.dumps({"jsonrpc": "2.0", "method": method, "params": params}, ensure_ascii=False)
        self._proc.stdin.write(payload + "\n")
        self._proc.stdin.flush()

    def _rpc_raw(self, method: str, params: dict, timeout: float = 30.0) -> Any:
        assert self._proc and self._proc.stdin and self._proc.stdout
        self._req_id += 1
        rid = self._req_id
        payload = json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}, ensure_ascii=False)
        self._proc.stdin.write(payload + "\n")
        self._proc.stdin.flush()

        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self._proc.stdout.readline()
            if not line:
                rc = self._proc.poll()
                raise RuntimeError(f"子插件 {self.plugin_id} 进程意外退出 (code={rc})")
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("id") == rid:
                if "error" in msg and msg["error"]:
                    raise RuntimeError(str(msg["error"]))
                return msg.get("result")
        raise TimeoutError(f"子插件 {self.plugin_id} 调用 {method} 超时")

    def call_tool(self, tool_name: str, arguments: dict | None = None, timeout: float = 30.0) -> dict:
        with self._lock:
            self._ensure_started()
            return self._rpc_raw(
                "tools/call",
                {"name": tool_name, "arguments": arguments or {}},
                timeout=timeout,
            ) or {}

    def read_html(self) -> str:
        if not self.html_path.exists():
            return f"<html><body><h3>子插件 {self.plugin_id} 缺少 dist/app.html</h3></body></html>"
        return self.html_path.read_text(encoding="utf-8")


_CLIENTS: dict[str, _NodeMcpClient] = {}
_CLIENTS_LOCK = threading.Lock()


def _get_client(plugin_id: str) -> _NodeMcpClient:
    if plugin_id not in SUB_PLUGIN_SPECS:
        raise ValueError(f"未知子插件: {plugin_id}")
    with _CLIENTS_LOCK:
        if plugin_id not in _CLIENTS:
            _CLIENTS[plugin_id] = _NodeMcpClient(plugin_id, SUB_PLUGIN_SPECS[plugin_id])
        return _CLIENTS[plugin_id]


def get_sub_plugin_html(plugin_id: str) -> str:
    return _get_client(plugin_id).read_html()


def open_sub_plugin(plugin_id: str) -> dict:
    spec = SUB_PLUGIN_SPECS.get(plugin_id)
    if not spec:
        raise ValueError(f"未知子插件: {plugin_id}")
    client = _get_client(plugin_id)
    entry_tool = spec["entry_tool"]
    entry_args = spec.get("entry_args") or {}
    result = client.call_tool(entry_tool, entry_args)
    return {
        "pluginId": plugin_id,
        "title": spec["title"],
        "entryTool": entry_tool,
        "entryArgs": entry_args,
        "toolResult": result,
    }


def call_sub_plugin_tool(plugin_id: str, tool_name: str, arguments: dict | None = None) -> dict:
    client = _get_client(plugin_id)
    return client.call_tool(tool_name, arguments or {})
