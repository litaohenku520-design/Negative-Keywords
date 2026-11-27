# -*- coding: utf-8 -*-
"""独立插件模式下的轻量 database stub（不读写原 ERP 的 ai_audit.db）"""


def query(*args, **kwargs):
    return []


def query_one(*args, **kwargs):
    return None


def set_sync_checkpoint(*args, **kwargs):
    return None
