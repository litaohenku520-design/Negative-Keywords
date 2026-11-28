# -*- coding: utf-8 -*-
"""
配置管理模块 - 多店铺独立规则目录、加载/保存
"""
import os
import sys
import json
import shutil
import threading

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
_STORES_DIR = os.path.join(_BACKEND_DIR, 'stores')
_STORES_META_FILE = os.path.join(_STORES_DIR, 'stores.json')
_STORE_LOCK = threading.RLock()

_DEFAULT_STORES_META = {
    'active_store_id': 'default',
    'stores': [
        {'id': 'default', 'name': '默认主店 (US)', 'marketplace': 'US'},
        {'id': 'suanpot-us', 'name': 'suanpot-us (美国站)', 'marketplace': 'US'},
    ],
}


def _sanitize_store_id(store_id: str) -> str:
    cleaned = ''.join(c for c in (store_id or '').strip() if c.isalnum() or c in ('-', '_'))
    return cleaned or 'default'


def _ensure_stores_meta() -> dict:
    with _STORE_LOCK:
        os.makedirs(_STORES_DIR, exist_ok=True)
        if not os.path.exists(_STORES_META_FILE):
            with open(_STORES_META_FILE, 'w', encoding='utf-8') as f:
                json.dump(_DEFAULT_STORES_META, f, ensure_ascii=False, indent=2)
            return json.loads(json.dumps(_DEFAULT_STORES_META))
        try:
            with open(_STORES_META_FILE, 'r', encoding='utf-8-sig') as f:
                data = json.load(f)
            if not isinstance(data, dict) or not isinstance(data.get('stores'), list):
                raise ValueError('invalid stores.json')
            return data
        except Exception:
            return json.loads(json.dumps(_DEFAULT_STORES_META))


def _save_stores_meta(data: dict) -> None:
    with _STORE_LOCK:
        os.makedirs(_STORES_DIR, exist_ok=True)
        with open(_STORES_META_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)


def get_stores_state() -> dict:
    meta = _ensure_stores_meta()
    active_id = meta.get('active_store_id') or 'default'
    stores = meta.get('stores') or []
    active_store = next((s for s in stores if s.get('id') == active_id), None)
    if not active_store and stores:
        active_store = stores[0]
        active_id = active_store.get('id', 'default')
    return {
        'active_store_id': active_id,
        'active_store': active_store,
        'stores': stores,
    }


def get_store_config_dir(store_id: str | None = None) -> str:
    sid = _sanitize_store_id(store_id or get_stores_state()['active_store_id'])
    store_dir = os.path.join(_STORES_DIR, sid)
    os.makedirs(store_dir, exist_ok=True)
    cid_file = os.path.join(store_dir, 'campaign_id_mappings.json')
    if not os.path.exists(cid_file):
        with open(cid_file, 'w', encoding='utf-8') as f:
            json.dump([], f, ensure_ascii=False, indent=2)
    return store_dir


def switch_active_store(store_id: str) -> dict:
    sid = _sanitize_store_id(store_id)
    with _STORE_LOCK:
        meta = _ensure_stores_meta()
        stores = meta.get('stores') or []
        if not any(s.get('id') == sid for s in stores):
            raise ValueError(f'店铺不存在: {sid}')
        get_store_config_dir(sid)
        meta['active_store_id'] = sid
        _save_stores_meta(meta)
        return get_stores_state()


def create_or_update_store(store_id: str, name: str, marketplace: str = 'US', copy_from: str | None = None) -> dict:
    sid = _sanitize_store_id(store_id)
    clean_name = (name or sid).strip()
    clean_mkt = (marketplace or 'US').strip().upper()
    with _STORE_LOCK:
        meta = _ensure_stores_meta()
        stores = meta.get('stores') or []
        existing = next((s for s in stores if s.get('id') == sid), None)
        if existing:
            existing['name'] = clean_name
            existing['marketplace'] = clean_mkt
        else:
            stores.append({'id': sid, 'name': clean_name, 'marketplace': clean_mkt})
        meta['stores'] = stores

        store_dir = os.path.join(_STORES_DIR, sid)
        os.makedirs(store_dir, exist_ok=True)
        cid_file = os.path.join(store_dir, 'campaign_id_mappings.json')
        if not os.path.exists(cid_file):
            with open(cid_file, 'w', encoding='utf-8') as f:
                json.dump([], f, ensure_ascii=False, indent=2)

        meta['active_store_id'] = sid
        _save_stores_meta(meta)
        return get_stores_state()


def get_config_dir():
    """获取当前共享配置根目录（可通过 NEG_PLUGIN_CONFIG_DIR 覆盖）。"""
    env_dir = os.environ.get('NEG_PLUGIN_CONFIG_DIR', '').strip()
    if env_dir:
        os.makedirs(env_dir, exist_ok=True)
        return env_dir
    return _BACKEND_DIR


def _get_campaign_id_file(store_id: str | None = None) -> str:
    return os.path.join(get_store_config_dir(store_id), 'campaign_id_mappings.json')


def load_rules_from_file():
    """加载共享规则配置 + 当前激活店铺的 campaign_id_mappings"""
    config_path = os.path.join(get_config_dir(), 'rules_config.json')
    data = None
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r', encoding='utf-8-sig') as f:
                data = json.load(f)
        except Exception as e:
            print(f"加载规则配置失败: {e}")
    if data is None:
        return None
    cid_path = _get_campaign_id_file()
    mappings = []
    if os.path.exists(cid_path):
        try:
            with open(cid_path, 'r', encoding='utf-8-sig') as f:
                loaded_m = json.load(f)
                if isinstance(loaded_m, list):
                    mappings = loaded_m
        except Exception as e:
            print(f"加载店铺 Campaign ID 映射失败: {e}")
    data['campaign_id_mappings'] = mappings
    return data


def save_rules_to_file(rules_dict):
    """保存共享规则到根目录 rules_config.json，并仅将 campaign_id_mappings 保存到当前店铺"""
    config_path = os.path.join(get_config_dir(), 'rules_config.json')
    cid_path = _get_campaign_id_file()
    try:
        to_save = dict(rules_dict or {})
        mappings = to_save.pop('campaign_id_mappings', None)
        with open(config_path, 'w', encoding='utf-8') as f:
            json.dump(to_save, f, ensure_ascii=False, indent=2)
        if mappings is not None:
            with open(cid_path, 'w', encoding='utf-8') as f:
                json.dump(mappings if isinstance(mappings, list) else [], f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"保存规则配置失败: {e}")
        return False


def load_api_config():
    """从配置文件加载 API 配置"""
    config_file = os.path.join(_BACKEND_DIR, 'api_config.json')
    if os.path.exists(config_file):
        try:
            with open(config_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"加载API配置失败: {e}")
    return {}


def save_api_config(api_config):
    """保存 API 配置到文件"""
    config_file = os.path.join(_BACKEND_DIR, 'api_config.json')
    try:
        with open(config_file, 'w', encoding='utf-8') as f:
            json.dump(api_config, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"保存API配置失败: {e}")
        return False
