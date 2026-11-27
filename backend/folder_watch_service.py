# -*- coding: utf-8 -*-
"""独立插件模式下的轻量 folder_watch_service stub"""
import os

DEFAULT_WATCH_DIR = os.path.dirname(os.path.abspath(__file__))


def get_watch_service(*args, **kwargs):
    return None


def reload_watch_dir(*args, **kwargs):
    return DEFAULT_WATCH_DIR


def resolve_watch_dir(*args, **kwargs):
    return DEFAULT_WATCH_DIR


def _save_watch_dir_to_config(*args, **kwargs):
    return None


def parse_and_import_file(*args, **kwargs):
    return {"ok": False, "error": "folder watch disabled in standalone plugin"}


def ensure_watch_dir(*args, **kwargs):
    return DEFAULT_WATCH_DIR
