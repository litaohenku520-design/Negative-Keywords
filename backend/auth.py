# -*- coding: utf-8 -*-
"""独立插件模式下的轻量认证与辅助模块 stub（仅服务本机 MCP Server 内部调用）"""


def authenticate(*args, **kwargs):
    return {"ok": True, "user": "plugin-local", "token": "local-plugin-token"}


def validate_request(*args, **kwargs):
    return True


def logout(*args, **kwargs):
    return True


def change_password(*args, **kwargs):
    return {"ok": False, "error": "disabled in standalone plugin mode"}
