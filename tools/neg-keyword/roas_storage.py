"""Store-scoped ROAS configuration persistence for Discover amzn."""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path

from config import get_stores_state
from git_sync import schedule_sync_to_github


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
ROAS_DATA_DIR = PLUGIN_ROOT / 'tools' / 'erp-workbench' / 'server' / 'data' / 'roas'
STORE_CONFIG_DIR = ROAS_DATA_DIR / 'stores'
BACKUP_DIR = ROAS_DATA_DIR / 'backups'
_LOCK = threading.RLock()
_MAX_CONFIG_BYTES = 2 * 1024 * 1024


def _shop_key(shop_key: str | None = None) -> str:
    value = str(shop_key or get_stores_state().get('active_store_id') or 'default').strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', value):
        raise ValueError('店铺标识无效')
    return value


def _config_path(shop_key: str) -> Path:
    return STORE_CONFIG_DIR / f'{shop_key}.json'


def _read_json(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text(encoding='utf-8-sig'))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f'读取 ROAS 配置失败: {exc}') from exc
    return value if isinstance(value, dict) else None


def load_roas_backup(shop_key: str | None = None, latest_backup: bool = False) -> dict | None:
    """Load one store's latest config or its latest explicit backup snapshot."""
    sid = _shop_key(shop_key)
    with _LOCK:
        if latest_backup:
            folder = BACKUP_DIR / sid
            if folder.is_dir():
                snapshots = sorted(folder.glob('roas-merge-config-*.json'))
                if snapshots:
                    return _read_json(snapshots[-1])
        return _read_json(_config_path(sid))


def _write_json_atomic(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f'.{path.stem}-', suffix='.tmp', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def save_roas_backup(shop_key: str | None, payload: object, create_snapshot: bool = False) -> dict:
    """Persist structured presets/config, optionally making a recoverable snapshot."""
    sid = _shop_key(shop_key)
    if not isinstance(payload, dict):
        raise ValueError('配置内容必须是对象')
    encoded_size = len(json.dumps(payload, ensure_ascii=False).encode('utf-8'))
    if encoded_size > _MAX_CONFIG_BYTES:
        raise ValueError('ROAS 配置超过 2 MB 限制')

    custom_presets = payload.get('customPresets', [])
    builtin_overrides = payload.get('builtinOverrides', {})
    last_config = payload.get('lastConfig')
    judge_templates = payload.get('judgeTemplates', [])
    if not isinstance(custom_presets, list) or not isinstance(builtin_overrides, dict):
        raise ValueError('ROAS 预设配置格式无效')
    if last_config is not None and not isinstance(last_config, dict):
        raise ValueError('ROAS 最近配置格式无效')
    if not isinstance(judge_templates, list):
        raise ValueError('判定模板配置格式无效')

    saved_at = datetime.now(timezone.utc).isoformat(timespec='seconds')
    normalized = {
        'customPresets': custom_presets,
        'builtinOverrides': builtin_overrides,
        'lastConfig': last_config,
        'judgeTemplates': judge_templates,
        'savedAt': saved_at,
    }
    with _LOCK:
        _write_json_atomic(_config_path(sid), normalized)
        if create_snapshot:
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
            snapshot = BACKUP_DIR / sid / f'roas-merge-config-{timestamp}.json'
            _write_json_atomic(snapshot, normalized)

    schedule_sync_to_github(f'ROAS config [{sid}]')
    return {'success': True, 'savedAt': saved_at, 'shop': sid, 'syncQueued': True}
