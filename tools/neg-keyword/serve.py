# -*- coding: utf-8 -*-
"""
HTTP服务模式模块 - 为ERP前端提供分类API
从 neg_keyword_tool.py 拆分
"""
import sys
import os
import json
import copy
import re
import time   # v5.0-hotfix(2026-08-28): 热重载后台线程 _watcher_loop 需要 time.sleep()
import hashlib  # v5.0-hotfix(2026-08-29): 热重载改用内容哈希判断变更 + 启动备份校验
import shutil
import tempfile
import threading
from datetime import datetime
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

from config import (
    get_config_dir,
    load_rules_from_file,
    save_rules_to_file,
    load_api_config,
    get_stores_state,
    switch_active_store,
    create_or_update_store,
)
from git_sync import (
    sync_to_github,
    schedule_sync_to_github,
    get_last_sync_status,
    pull_from_github,
    backup_all_to_github_and_gdrive,
)
from roas_storage import load_roas_backup, save_roas_backup
from rules import get_default_rules
from normalization import normalize_keyword
from matching import (
    find_matching_group,
    find_matching_group_in_target,
    is_de_base_model_deny_exception,
    prepare_matcher,
)
from neg_audit_engine import run_audit, generate_audit_csv, generate_audit_xlsx
from auth import authenticate, validate_request, logout as auth_logout, change_password
# v4.1.6 修复: 在 PyInstaller frozen + integrated_backends._load_module_from_file 双重加载场景下,
# `from logger import setup_logger` 会因为模块名字冲突无法获取 setup_logger 名字。
# 改用 import logger 然后从 module 属性拿, 这样即使模块初始化中途抛错 setup_logger 仍在 module.__dict__ 里。
import logger as _logger_mod
import sys as _sys
print(f"[serve debug] logger module: {_logger_mod}", file=_sys.stderr)
print(f"[serve debug] logger.__file__: {getattr(_logger_mod, '__file__', 'NO_FILE')}", file=_sys.stderr)
print(f"[serve debug] logger dir: {[x for x in dir(_logger_mod) if not x.startswith('_')]}", file=_sys.stderr)
if not hasattr(_logger_mod, 'setup_logger'):
    # 重新从磁盘加载
    import importlib.util as _ilu
    _spec = _ilu.spec_from_file_location('logger_via_serve', os.path.join(os.path.dirname(__file__), 'logger.py'))
    _mod = _ilu.module_from_spec(_spec)
    _sys.modules['logger'] = _mod  # 覆盖
    _spec.loader.exec_module(_mod)
    print(f"[serve debug] reloaded logger from disk", file=_sys.stderr)
    _logger_mod = _mod
setup_logger = _logger_mod.setup_logger
get_recent_logs = _logger_mod.get_recent_logs
frontend_error_reporter = _logger_mod.frontend_error_reporter
logger = setup_logger()
from folder_watch_service import (
    get_watch_service, reload_watch_dir, resolve_watch_dir,
    _save_watch_dir_to_config, DEFAULT_WATCH_DIR
)
from database import query as db_query, query_one as db_query_one, set_sync_checkpoint
from folder_watch_service import get_watch_service, parse_and_import_file, ensure_watch_dir


_ACTIVE_SERVER = None
_ACTIVE_FOLDER_WATCH = None
_ACTIVE_SERVER_THREAD = None
_ACTIVE_SERVER_LOCK = threading.RLock()

# Amazon 搜索词经常把型号和产品类型连写，例如：
#   11procase / maxwallet / 17wallet / a17hülle
# 这类词中产品类型词前面没有 ``\b``，旧的单词边界正则会漏判，随后
# 被 require_case 误加上“无壳类词”。这里只放产品类型词，不把颜色、
# 人群词等普通 keep_case_words 当作壳类词，避免扩大误保留范围。
_JOINED_SHELL_SUFFIXES = (
    'cases', 'case', 'covers', 'cover', 'wallets', 'wallet',
    'folios', 'folio', 'pouches', 'pouch', 'holders', 'holder',
    'sleeves', 'sleeve', 'bumpers', 'bumper', 'holsters', 'holster',
    'casings', 'casing', 'shells', 'shell',
    # 常见欧洲站点壳类词的连写形式
    'hüllen', 'hülle', 'hullen', 'hulle', 'hoesjes', 'hoesje',
    'funda', 'fundas', 'carcasa', 'carcasas', 'coque', 'coques',
    'etui', 'etuis', 'custodia', 'custodie', 'capinha', 'capinhas',
    'estojo', 'estojos', 'pokrowiec', 'pokrowce', 'fodral', 'fodraler',
    'deksel', 'deksler', 'kotelo', 'kotelot', 'pouzdro', 'pouzdra',
    'kılıf', 'kilif', 'чехол', 'чехлы', 'калъф', 'калъфи',
)
_JOINED_SHELL_SUFFIX_RE = re.compile(
    r'(?<!\w)(?P<stem>\w+?)(?P<shell>'
    + '|'.join(re.escape(word) for word in _JOINED_SHELL_SUFFIXES)
    + r')(?!\w)',
    re.IGNORECASE,
)
_JOINED_MODEL_STEMS = frozenset({
    'pro', 'max', 'promax', 'promac', 'plus', 'ultra', 'fe', 'se',
    'lite', 'mini', 'air', 'note', 'edge', 'fold', 'flip', 'stylus',
    'power', 'play', 'prime', 'core', 'neo', 'premax', '5g', '4g',
})


def _looks_like_seeded_incomplete_config(saved, bundled, defaults):
    """只识别被内置默认值覆盖的明显残缺配置，避免误覆盖用户的有效空配置。

    触发条件要求基础词表逐项等于代码默认值，同时多个应有数据的规则集合
    一起稀缺；单独清空任意一个列表不会触发恢复。
    """
    if not isinstance(saved, dict) or not isinstance(bundled, dict):
        return False
    for key in ('deny_brands', 'deny_models', 'keep_case_words'):
        if saved.get(key, defaults.get(key)) != defaults.get(key):
            return False

    model_groups = saved.get('model_groups') or []
    alias_rules = saved.get('alias_rules') or []
    deny_library = saved.get('deny_model_library') or []
    campaign_map = saved.get('campaign_group_map') or {}
    default_group_count = len(defaults.get('model_groups') or [])
    if not isinstance(model_groups, list) or not isinstance(alias_rules, list):
        return False
    if not isinstance(deny_library, list) or not isinstance(campaign_map, dict):
        return False
    if len(model_groups) > max(8, default_group_count):
        return False
    if alias_rules or len(deny_library) > 1 or campaign_map:
        return False

    # 必须存在可信且明显更完整的随包规则副本，才允许自动恢复。
    return (
        len(bundled.get('model_groups') or []) >= 50
        and len(bundled.get('alias_rules') or []) >= 100
        and len(bundled.get('deny_model_library') or []) >= 50
        and len(bundled.get('campaign_group_map') or {}) >= 100
        and len(bundled.get('usa_model_groups') or []) >= 50
        and len(bundled.get('usa_alias_rules') or []) >= 50
    )


def _merge_recovered_config(bundled, saved):
    """以完整随包快照恢复规则，同时保留快照外的本机设置和否词库自定义项。"""
    recovered = copy.deepcopy(bundled)
    if not isinstance(recovered, dict):
        recovered = {}
    if isinstance(saved, dict):
        for key, value in saved.items():
            if key not in recovered:
                recovered[key] = copy.deepcopy(value)

        # 当前配置中同名的自定义库记录与完整记录合并，非空词条不丢失。
        library = recovered.get('deny_model_library') or []
        if not isinstance(library, list):
            library = []
        current_library = saved.get('deny_model_library') or []
        for entry in current_library:
            if not isinstance(entry, dict):
                continue
            name = str(entry.get('name') or '').strip().casefold()
            match = next((item for item in library
                          if isinstance(item, dict)
                          and str(item.get('name') or '').strip().casefold() == name), None)
            if match is None:
                library.append(copy.deepcopy(entry))
                continue
            for key, value in entry.items():
                if isinstance(value, list):
                    values = match.get(key) if isinstance(match.get(key), list) else []
                    seen = {json.dumps(v, ensure_ascii=False, sort_keys=True) for v in values}
                    for item in value:
                        signature = json.dumps(item, ensure_ascii=False, sort_keys=True)
                        if signature not in seen:
                            values.append(copy.deepcopy(item))
                            seen.add(signature)
                    match[key] = values
                elif key not in match or match[key] in (None, ''):
                    match[key] = copy.deepcopy(value)
                elif key == 'enabled' and isinstance(value, bool):
                    # 保留当前明确设置的启用/停用状态。
                    match[key] = value
        recovered['deny_model_library'] = library
    return recovered


def _write_json_atomic(path, value):
    """原子保存 JSON，避免进程中断时留下被截断的规则文件。"""
    return _write_text_atomic(path, json.dumps(value, ensure_ascii=False, indent=2))


def _write_text_atomic(path, content):
    """原子保存已序列化文本，供比较后写盘时复用序列化结果。"""
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix='.rules_config.', suffix='.tmp', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        # Windows 上正在运行的 ERP/启动器可能短暂打开配置文件做热重载，
        # 此时原子替换会返回 WinError 5/32/33。短暂重试，避免 UI 误报成功、
        # 但规则只留在当前进程内存中的情况。
        for attempt in range(100):
            try:
                os.replace(temp_path, path)
                break
            except OSError as exc:
                if getattr(exc, 'winerror', None) not in (5, 32, 33) or attempt == 99:
                    raise
                time.sleep(0.1)
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def _file_matches_text(path, expected):
    """判断文本文件是否已是目标内容，避免无变化时重复 fsync 写盘。"""
    try:
        if not os.path.isfile(path):
            return False
        with open(path, 'r', encoding='utf-8') as handle:
            return handle.read() == expected
    except OSError:
        return False


def _copy_file_if_different(source, target):
    """只在内容不同时复制配置镜像，避免反复触发磁盘/杀毒扫描。"""
    source_abs = os.path.abspath(source)
    target_abs = os.path.abspath(target)
    if os.path.normcase(source_abs) == os.path.normcase(target_abs):
        return False

    try:
        if os.path.isfile(target) and os.path.getsize(source) == os.path.getsize(target):
            identical = True
            with open(source, 'rb') as source_handle, open(target, 'rb') as target_handle:
                while True:
                    source_chunk = source_handle.read(1024 * 1024)
                    target_chunk = target_handle.read(1024 * 1024)
                    if source_chunk != target_chunk:
                        identical = False
                        break
                    if not source_chunk:
                        break
            if identical:
                return False
    except OSError:
        # 目标暂不可读时，仍按原有策略尝试覆盖；失败由调用方记录。
        pass

    import shutil
    shutil.copy2(source, target)
    return True


def _write_json_atomic_if_changed(path, value):
    """保留原子写盘与 fsync；目标内容未变时跳过写入。"""
    serialized = json.dumps(value, ensure_ascii=False, indent=2)
    if _file_matches_text(path, serialized):
        return False
    _write_text_atomic(path, serialized)
    return True


def stop_server(timeout=5.0):
    """优雅停止当前内嵌 HTTP 服务并释放监听端口。"""
    global _ACTIVE_SERVER, _ACTIVE_FOLDER_WATCH, _ACTIVE_SERVER_THREAD
    with _ACTIVE_SERVER_LOCK:
        server = _ACTIVE_SERVER
        folder_watch = _ACTIVE_FOLDER_WATCH
        server_thread = _ACTIVE_SERVER_THREAD

    if server is not None:
        try:
            # shutdown() 要在 serve_forever() 所在线程之外调用。
            if server_thread is not threading.current_thread() and server_thread and server_thread.is_alive():
                server.shutdown()
                server_thread.join(timeout=max(0.1, float(timeout)))
        except Exception as e:
            print(f'HTTP 服务停止请求失败: {e}')
        finally:
            try:
                server.server_close()
            except Exception:
                pass

    if folder_watch:
        try:
            folder_watch.stop()
        except Exception:
            pass

    with _ACTIVE_SERVER_LOCK:
        if _ACTIVE_SERVER is server:
            _ACTIVE_SERVER = None
            _ACTIVE_FOLDER_WATCH = None
            _ACTIVE_SERVER_THREAD = None


def serve_mode():
    """Start a local HTTP server for the ERP frontend to call.
    Usage: python main.py --serve [--port 19876]
    API:
      POST /classify  {"items":[...], "site":"usa"}  -> {"results":[...], "total":N}
      GET  /health    -> {"status":"ok"}
    """
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--port', type=int, default=int(os.environ.get('AMZ_NEG_PORT', 19876)), help='Port to listen on')
    args, _ = parser.parse_known_args()

    # ═══ 独立插件模式：以本插件 backend/rules_config.json 为唯一主源 ═══
    import shutil
    _backend_dir = os.path.dirname(os.path.abspath(__file__))
    _backend_cfg = os.path.join(_backend_dir, 'rules_config.json')
    _BACKUP_KEEP = 10
    try:
        if os.path.exists(_backend_cfg):
            _bak_dir = os.path.join(_backend_dir, 'backups')
            os.makedirs(_bak_dir, exist_ok=True)
            _ts = datetime.now().strftime('%Y%m%d_%H%M%S')
            _bak_path = os.path.join(_bak_dir, f'rules_config_{_ts}.json')
            if not os.path.exists(_bak_path):
                shutil.copy2(_backend_cfg, _bak_path)
            _baks = sorted(
                (f for f in os.listdir(_bak_dir)
                 if re.fullmatch(r'rules_config_\d{8}_\d{6}\.json', f)),
                reverse=True
            )
            for _old in _baks[_BACKUP_KEEP:]:
                try:
                    os.remove(os.path.join(_bak_dir, _old))
                except Exception:
                    pass
    except Exception as _e:
        print(f'[启动备份] 跳过: {_e}')

    # 启动时先从 GitHub origin/main 拉取最新共享规则与各店铺 Campaign ID
    try:
        _pull_res = pull_from_github(timeout=8)
        print(f"[GitHub 启动拉取] {_pull_res.get('message')}")
    except Exception as _pe:
        print(f"[GitHub 启动拉取] 跳过: {_pe}")

    # Load config once at startup
    saved_rules = load_rules_from_file()
    defaults = get_default_rules()

    if saved_rules:
        deny_brands = saved_rules.get('deny_brands', defaults['deny_brands'])
        deny_models = saved_rules.get('deny_models', defaults['deny_models'])
        keep_case_words = saved_rules.get('keep_case_words', defaults['keep_case_words'])
        deny_model_library = saved_rules.get('deny_model_library', [])
        screen_protector_words = saved_rules.get('screen_protector_words',
            ['screen protector', 'screen film', 'screen glass', 'tempered glass',
             'panzerglass', 'displayschutz', 'displayschutzfolie', 'schutzglas', 'schutzfolie'])
        model_groups = saved_rules.get('model_groups',
            saved_rules.get('usa_model_groups', defaults['model_groups']))
        alias_rules = saved_rules.get('alias_rules',
            saved_rules.get('usa_alias_rules', defaults['alias_rules']))
        usa_model_groups = saved_rules.get('usa_model_groups', model_groups)
        usa_alias_rules = saved_rules.get('usa_alias_rules', alias_rules)
        campaign_group_map = saved_rules.get('campaign_group_map', {})
        # Campaign ID 映射属于否词导出所需的业务配置，跟随 rules_config.json 持久化。
        campaign_id_mappings = saved_rules.get('campaign_id_mappings', [])
        # v5.1(2026-08-31): 壳类词开关 / 竞品品牌开关持久化。
        #   原先此处硬编码 True，且 _save_rules_to_disk 的白名单不含这两个键，
        #   导致用户在否词工具页切换开关后：内存生效，但刷新/重启即回弹到 True。
        saved_require_case = saved_rules.get('require_case', True)
        saved_intercept_brand = saved_rules.get('intercept_brand', True)
    else:
        deny_brands = defaults['deny_brands']
        deny_models = defaults['deny_models']
        keep_case_words = defaults['keep_case_words']
        deny_model_library = []
        screen_protector_words = ['screen protector', 'screen film', 'screen glass', 'tempered glass',
                                   'panzerglass', 'displayschutz', 'displayschutzfolie', 'schutzglas', 'schutzfolie']
        model_groups = defaults['model_groups']
        alias_rules = defaults['alias_rules']
        usa_model_groups = defaults['model_groups']
        usa_alias_rules = defaults['alias_rules']
        campaign_group_map = {}
        campaign_id_mappings = []
        saved_require_case = True
        saved_intercept_brand = True

    class _DummyApp:
        pass
    app = _DummyApp()
    app.deny_brands = deny_brands
    app.deny_models = deny_models
    app.keep_case_words = keep_case_words
    app.deny_model_library = deny_model_library
    app.screen_protector_words = screen_protector_words
    app.model_groups = model_groups
    app.alias_rules = alias_rules
    app.usa_model_groups = usa_model_groups
    app.usa_alias_rules = usa_alias_rules

    # v3.1-rc4 (2026-09-04) startup lint: 检查 deny_model_library 是否含 brands 反咬
    _BITE_BACK_BRANDS = {'samsung', 'huawei', 'xiaomi', 'redmi', 'pixel', 'iphone', 'oneplus', 'moto', 'lg', 'mi', 'note'}
    _lint_warns = 0
    for _m in app.deny_model_library:
        _bite_kws = [k for k in _m.get('keywords', []) if k.lower() in _BITE_BACK_BRANDS]
        if _bite_kws:
            _lint_warns += 1
            print(f"[serve LINT] {_m.get('name')}: deny 规则含 brands 反咬 {len(_bite_kws)} 个: {_bite_kws[:3]}", flush=True)
    if _lint_warns:
        print(f"[serve LINT] 共 {_lint_warns} 条 deny 规则含 brands 反咬, 建议删除 (使用 merge_universal_config.py 自动修)", flush=True)
    else:
        print(f"[serve LINT] ✅ {len(app.deny_model_library)} 条 deny 规则无 brands 反咬", flush=True)

    # v3.1-rc4 通用化: 检查 usa_model_groups 是否与 model_groups 同步
    if app.usa_model_groups and app.usa_model_groups != app.model_groups:
        print(f"[serve LINT WARN] usa_model_groups != model_groups, 建议统一为通用配置 (164 机型 vs {len(app.usa_model_groups)} 机型)", flush=True)
    # v5.1: 从磁盘配置恢复开关状态（原为硬编码 True，重启即丢）
    app.require_case = bool(saved_require_case)
    app.intercept_brand = bool(saved_intercept_brand)
    app.campaign_group_map = campaign_group_map
    app.campaign_id_mappings = campaign_id_mappings if isinstance(campaign_id_mappings, list) else []
    app.campaign_group_name_cache = {}

    # ═══ 热重载钩子：监控 AppData 主副本变更,自动 reload 到内存 ═══
    # 设计目的: 用户在否词工具页面点「保存配置」后,前端的 /api/sync-config
    # 会把内存配置写回 AppData; 本钩子通过 mtime 轮询检测该写入, 并自动
    # 把磁盘最新版重新加载进内存,实现「点保存即生效」零重启闭环。
    # 抑制逻辑: 写后窗口内不触发(避免 /api/sync-config 自己写完触发自己 reload)。
    import threading as _thr
    _appdata_path = os.path.join(get_config_dir(), 'rules_config.json')
    # v5.0-hotfix(2026-08-29): 改用「内容哈希」而非 mtime 判断变更。
    # 原因: 用 shutil.copy2 从备份恢复文件时会保留备份的旧 mtime,
    # 若该 mtime 早于进程启动时记录的基准, watcher 会误判"文件未变化"
    # 而静默跳过 reload —— 表现为"文件已是最新但页面仍显示旧数据"。
    # 内容哈希只看字节内容, 与 mtime 无关, 可彻底规避该问题。
    def _file_digest(path):
        """返回文件内容的 md5 摘要; 文件不存在或读取失败返回 None"""
        try:
            with open(path, 'rb') as _f:
                return hashlib.md5(_f.read()).hexdigest()
        except Exception:
            return None

    _appdata_mtime_at_load = os.path.getmtime(_appdata_path) if os.path.exists(_appdata_path) else 0.0
    _appdata_digest_at_load = _file_digest(_appdata_path)
    _appdata_self_write_ts = [0.0]   # 用 list 让内部闭包可写
    _appdata_write_guard_sec = 3.0   # 自我写入后 3 秒内忽略 reload

    def _hot_reload_from_disk():
        """从 AppData 主副本重新加载所有词表/规则到 app 实例"""
        try:
            saved = load_rules_from_file()
            if not saved:
                return False
            app.deny_brands = saved.get('deny_brands', app.deny_brands)
            app.deny_models = saved.get('deny_models', app.deny_models)
            app.keep_case_words = saved.get('keep_case_words', app.keep_case_words)
            app.screen_protector_words = saved.get('screen_protector_words', app.screen_protector_words)
            app.model_groups = saved.get('model_groups', saved.get('usa_model_groups', app.model_groups))
            app.alias_rules = saved.get('alias_rules', saved.get('usa_alias_rules', app.alias_rules))
            app.deny_model_library = saved.get('deny_model_library', app.deny_model_library)
            app.campaign_group_map = saved.get('campaign_group_map', app.campaign_group_map)
            app.campaign_id_mappings = saved.get('campaign_id_mappings', app.campaign_id_mappings)
            if not isinstance(app.campaign_id_mappings, list):
                app.campaign_id_mappings = []
            app.usa_model_groups = saved.get('usa_model_groups', app.model_groups)
            app.usa_alias_rules = saved.get('usa_alias_rules', app.alias_rules)
            app.campaign_group_name_cache = {}
            # 清除正则缓存,确保新词表立即生效
            app._brand_re = None
            app._case_re = None
            app._deny_model_re = None
            app._screen_protector_re = None
            return True
        except Exception as e:
            print(f'[hot-reload] 失败: {e}')
            return False

    def _watcher_loop():
        """后台线程: 每 2 秒检查一次 AppData 内容哈希, 有变更则 reload。

        v5.0-hotfix(2026-08-29): 判定依据从 mtime 改为内容哈希。
        mtime 会被 shutil.copy2 等"保留时间戳"的复制方式干扰(旧 mtime 让
        watcher 误以为文件没变), 内容哈希不受任何时间戳影响, 只看字节。
        """
        last_digest = _appdata_digest_at_load
        while True:
            try:
                if os.path.exists(_appdata_path):
                    cur_digest = _file_digest(_appdata_path)
                    now = time.time()
                    # 内容有变化 且 不在自我写入保护窗口内
                    if (cur_digest and cur_digest != last_digest
                            and (now - _appdata_self_write_ts[0]) > _appdata_write_guard_sec):
                        # 再保险: 间隔 0.3s 复算一次哈希,确认写入已完成(避免半写状态)
                        time.sleep(0.3)
                        if not os.path.exists(_appdata_path):
                            continue
                        stable_digest = _file_digest(_appdata_path)
                        if stable_digest == cur_digest:
                            last_digest = cur_digest
                            with _lock:
                                ok = _hot_reload_from_disk()
                                if ok:
                                    print(f'[hot-reload] AppData 内容变更已自动 reload (md5={cur_digest[:8]})')
            except Exception as e:
                print(f'[hot-reload] watcher 异常: {e}')
            time.sleep(2.0)

    _watcher_thread = _thr.Thread(target=_watcher_loop, daemon=True)
    _watcher_thread.start()
    print(f'[hot-reload] 监控线程已启动 (file={_appdata_path}, interval=2s)')

    def _persistent_backend_file():
        """返回可持久化的源码后端配置目标。

        开发模式的 ``neg-keyword-backend/rules_config.json`` 可以作为同步副本。
        PyInstaller one-file 的 ``_MEIPASS`` 是临时解压目录，即使目录存在，
        退出后也会被删除；旧版还可能只把 serve.py 放在 PYZ 中，导致
        ``dirname(__file__)`` 根本不是物理目录。打包模式统一以 AppData 为
        后端持久化源，避免把临时目录误报为同步失败或在重启时丢配置。
        """
        backend_dir = os.path.dirname(os.path.abspath(__file__))
        if not os.path.isdir(backend_dir):
            return None
        if getattr(sys, 'frozen', False):
            meipass = getattr(sys, '_MEIPASS', None)
            if meipass:
                try:
                    path_norm = os.path.normcase(os.path.abspath(backend_dir))
                    meipass_norm = os.path.normcase(os.path.abspath(meipass))
                    if os.path.commonpath([path_norm, meipass_norm]) == meipass_norm:
                        return None
                except (ValueError, OSError):
                    return None
        return os.path.join(backend_dir, 'rules_config.json')

    # Lock for thread-safe classification
    _lock = threading.Lock()

    def _save_rules_to_disk():
        """同步保存权威配置与后端根目录副本；Public/Dist 留给手动同步更新。"""
        config_dir = get_config_dir()
        source_file = os.path.join(config_dir, 'rules_config.json')

        disk_config = load_rules_from_file() or {}
        rules_dict = {
            'deny_brands': app.deny_brands,
            'deny_models': app.deny_models,
            'keep_case_words': app.keep_case_words,
            'screen_protector_words': app.screen_protector_words,
            'model_groups': app.model_groups,
            'alias_rules': app.alias_rules,
            'deny_model_library': app.deny_model_library,
            'campaign_group_map': app.campaign_group_map,
            'campaign_id_mappings': app.campaign_id_mappings,
            # 老版本 USA 字段仍写入快照，兼容历史配置恢复及其他客户端。
            'usa_model_groups': app.usa_model_groups,
            'usa_alias_rules': app.usa_alias_rules,
            # v5.1(2026-08-31): 加进落盘白名单，否则开关永远写不进 rules_config.json
            'require_case': app.require_case,
            'intercept_brand': app.intercept_brand,
        }
        for k, v in disk_config.items():
            if k not in rules_dict:
                rules_dict[k] = v

        try:
            if not save_rules_to_file(rules_dict):
                return False
        except Exception as e:
            print(f"保存规则配置失败: {e}")
            return False

        backend_file = _persistent_backend_file()
        if backend_file:
            try:
                target_dir = os.path.dirname(backend_file)
                if os.path.isdir(target_dir):
                    _copy_file_if_different(source_file, backend_file)
            except Exception as e:
                # AppData 已原子落盘，镜像复制失败不影响本次配置持久化。
                print(f"同步到 Backend 失败: {e}")
        schedule_sync_to_github(f"auto save ({get_stores_state().get('active_store_id', 'default')})")
        return True

    # 数据类型→表名映射（白名单，防 SQL 注入）
    DATA_TYPE_TABLE_MAP = {
        'ad_campaign': 'campaigns',
        'keyword': 'keywords',
        'search_term': 'search_terms',
        'inventory': 'inventory',
    }

    class RequestHandler(BaseHTTPRequestHandler):
        def do_OPTIONS(self):
            self.send_response(200)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'POST, GET, PUT, DELETE, OPTIONS')
            # 前端登录后由全局 fetch 包装器为 /api/* 请求补充
            # Authorization 和 X-Client；缺少这两个预检允许头时，浏览器会
            # 在请求真正到达 /api/sync/check 前直接拦截，页面误报“后端离线”。
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client')
            self.send_header('Access-Control-Max-Age', '600')
            self.end_headers()

        def _parse_query_params(self):
            from urllib.parse import urlparse, parse_qs
            parsed = urlparse(self.path)
            params = {k: v[0] for k, v in parse_qs(parsed.query).items()}
            return parsed.path, params

        def do_GET(self):
            path, params = self._parse_query_params()
            if path == '/health':
                self._json_response({'status': 'ok', 'version': '1.3'})
            elif path.startswith('/sub/'):
                plugin_id = path[len('/sub/'):].strip('/')
                try:
                    from sub_mcp_bridge import get_sub_plugin_html
                    html = get_sub_plugin_html(plugin_id)
                    body = html.encode('utf-8')
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/html; charset=utf-8')
                    self.send_header('Cache-Control', 'no-store')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except Exception as e:
                    self._json_response({'error': str(e)}, 404)
            elif path == '/api/stores':
                self._json_response(get_stores_state())
            elif path == '/api/roas-merge-config':
                try:
                    backup = load_roas_backup(
                        params.get('shop'),
                        latest_backup=params.get('backup') == 'latest',
                    )
                    self._json_response(backup or {'success': False, 'message': '该店铺还没有 ROAS 后端配置'})
                except ValueError as exc:
                    self._json_response({'success': False, 'message': str(exc)}, 400)
            elif path == '/api/git-sync/status':
                self._json_response(get_last_sync_status())
            elif path == '/api/config':
                with _lock:
                    self._json_response({
                        'deny_brands': app.deny_brands,
                        'deny_models': app.deny_models,
                        'keep_case_words': app.keep_case_words,
                        'screen_protector_words': app.screen_protector_words,
                        'model_groups': app.model_groups,
                        'alias_rules': app.alias_rules,
                        'deny_model_library': app.deny_model_library,
                        'usa_model_groups': app.usa_model_groups,
                        'usa_alias_rules': app.usa_alias_rules,
                        'campaign_id_mappings': app.campaign_id_mappings,
                        # v5.1(2026-08-31): 回传开关状态，供前端回显（原不返回，前端只能硬编码默认 true）
                        'require_case': app.require_case,
                        'intercept_brand': app.intercept_brand,
                    })
            elif path == '/api/campaign-id-mappings':
                with _lock:
                    saved = load_rules_from_file()
                    if isinstance(saved, dict) and isinstance(saved.get('campaign_id_mappings'), list):
                        app.campaign_id_mappings = saved['campaign_id_mappings']
                    self._json_response({'mappings': app.campaign_id_mappings})
            elif path == '/api/campaign-map':
                with _lock:
                    self._json_response(app.campaign_group_map)
            elif path == '/api/model-groups':
                with _lock:
                    self._json_response({'groups': app.model_groups})
            elif path == '/api/deny-library':
                with _lock:
                    self._json_response({'library': app.deny_model_library})
            elif path == '/api/alias-rules':
                with _lock:
                    self._json_response({'rules': app.alias_rules})
            elif path == '/api/logs':
                logs = get_recent_logs(level=params.get('level'), limit=int(params.get('limit', 100)))
                self._json_response({'logs': logs})

            elif path == '/api/errors':
                errors = frontend_error_reporter.get_errors(limit=100)
                self._json_response({'errors': errors})

            elif path == '/auth/verify':
                auth_header = self.headers.get('Authorization', '')
                if not auth_header.startswith('Bearer '):
                    self._json_response({'status': 'error', 'message': '未提供令牌'}, 401)
                    return
                user = validate_request(auth_header[7:])
                if user:
                    self._json_response({'status': 'success', 'user': user})
                else:
                    self._json_response({'status': 'error', 'message': '令牌无效或已过期'}, 401)

            # ============ 监控目录配置 ============
            elif path == '/api/sync/watch-folder':
                self._json_response({
                    'watch_folder': resolve_watch_dir(),
                    'default_folder': DEFAULT_WATCH_DIR,
                    'is_custom': resolve_watch_dir() != DEFAULT_WATCH_DIR,
                })

            # ============ 实时同步 API ============
            elif path == '/api/sync/check':
                store_key = params.get('store_key', 'default')
                # 查最新一条 folder_import 日志。
                # 注意：sync_log.created_at 由 SQLite datetime('now') 生成（UTC，格式 YYYY-MM-DD HH:MM:SS），
                # 而 sync_checkpoint.last_sync_at 为 UTC ISO（格式 YYYY-MM-DDTHH:MM:SS）。
                # 这里用 strftime 把 created_at 统一成 ISO 格式，保证两边同基准、同格式后再做字符串比较。
                import_logs = db_query(
                    "SELECT *, strftime('%Y-%m-%dT%H:%M:%S', created_at) AS created_at_iso "
                    "FROM sync_log WHERE sync_type = 'folder_import' ORDER BY id DESC LIMIT 1"
                )
                last_import_info = None
                if import_logs:
                    entry = import_logs[0]
                    last_import_info = {
                        'filename': entry.get('message', ''),
                        'imported_at': entry.get('created_at', ''),
                        'imported_at_iso': entry.get('created_at_iso', ''),
                        'item_count': entry.get('item_count', 0),
                    }

                # 查 sync_checkpoint 中各 data_type 的最新同步时间
                checkpoints = db_query(
                    "SELECT data_type, last_sync_at FROM sync_checkpoint WHERE store_key = ?",
                    [store_key]
                )
                # 若有 folder_import 记录但 checkpoint 为空或更旧 → has_new_data
                has_new_data = False
                if import_logs and last_import_info:
                    last_import_time = last_import_info.get('imported_at_iso', '') or import_logs[0].get('created_at', '')
                    if not checkpoints:
                        # 有导入记录但从未拉取过 → 有新数据
                        has_new_data = True
                    else:
                        # 任一 data_type 的 last_sync_at 早于最近导入时间 → 有新数据
                        for cp in checkpoints:
                            cp_time = cp.get('last_sync_at', '')
                            if cp_time < last_import_time:
                                has_new_data = True
                                break

                self._json_response({
                    'has_new_data': has_new_data,
                    'last_import': last_import_info,
                    'checkpoints': checkpoints,
                })

            elif path.startswith('/api/sync/data/'):
                # 提取 data_type（路径中 /api/sync/data/ 后面的部分）
                data_type = path[len('/api/sync/data/'):]
                store_key = params.get('store_key', 'default')
                since_row_id = int(params.get('since_row_id', 0))

                # 白名单映射
                table = DATA_TYPE_TABLE_MAP.get(data_type)
                if table is None:
                    self._json_response({'error': f'未知数据类型: {data_type}'}, 400)
                    return

                # 查询增量数据（用 _rowid_ 显式取 SQLite 内部行号，便于前端跟踪检查点）
                rows = db_query(
                    f"SELECT _rowid_ AS _rowid, * FROM {table} WHERE _rowid_ > ? ORDER BY _rowid_ ASC LIMIT 5000",
                    [since_row_id]
                )
                next_row_id = since_row_id
                if rows:
                    next_row_id = rows[-1].get('_rowid', since_row_id)

                # 更新同步检查点
                try:
                    set_sync_checkpoint(data_type, store_key, last_row_id=next_row_id)
                except Exception as e:
                    print(f"  更新检查点失败: {e}")

                self._json_response({
                    'rows': rows,
                    'next_row_id': next_row_id,
                    'count': len(rows),
                })

            elif path == '/api/aba-rank/state':
                try:
                    from aba_rank_service import get_aba_rank_state
                    self._json_response(get_aba_rank_state(
                        target_path=params.get('target_path') or None,
                        source_path=params.get('source_path') or None,
                    ))
                except Exception as e:
                    self._json_response({'error': str(e)}, 500)

            else:
                self.send_error(404)

        def _get_client_ip(self):
            """获取客户端 IP"""
            # 在反向代理后获取真实 IP
            forwarded = self.headers.get('X-Forwarded-For', '')
            if forwarded:
                return forwarded.split(',')[0].strip()
            return self.client_address[0]

        def do_POST(self):
            path, params = self._parse_query_params()
            if path == '/api/roas-merge-config':
                content_length = int(self.headers.get('Content-Length', 0))
                if content_length > 2 * 1024 * 1024:
                    self._json_response({'success': False, 'message': 'ROAS 配置超过 2 MB 限制'}, 413)
                    return
                body = self.rfile.read(content_length).decode('utf-8-sig')
                try:
                    payload = json.loads(body)
                except json.JSONDecodeError as exc:
                    self._json_response({'success': False, 'message': f'Invalid JSON: {exc}'}, 400)
                    return
                try:
                    result = save_roas_backup(
                        params.get('shop'),
                        payload,
                        create_snapshot=params.get('backup') in ('1', 'true', 'latest'),
                    )
                    self._json_response(result)
                except ValueError as exc:
                    self._json_response({'success': False, 'message': str(exc)}, 400)
                except OSError as exc:
                    self._json_response({'success': False, 'message': f'保存 ROAS 配置失败: {exc}'}, 500)
                return

            # ============ 认证端点 ============
            if self.path == '/auth/login':
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8-sig')
                try:
                    data = json.loads(body)
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return
                result = authenticate(
                    data.get('username', ''),
                    data.get('password', ''),
                    self._get_client_ip()
                )
                if result['status'] == 'success':
                    self._json_response(result)
                else:
                    self._json_response(result, 401)
                return

            elif self.path == '/auth/logout':
                auth_header = self.headers.get('Authorization', '')
                if auth_header.startswith('Bearer '):
                    auth_logout(auth_header[7:])
                self._json_response({'status': 'success'})
                return

            elif self.path == '/auth/verify':
                auth_header = self.headers.get('Authorization', '')
                if not auth_header.startswith('Bearer '):
                    self._json_response({'status': 'error', 'message': '未提供令牌'}, 401)
                    return
                user = validate_request(auth_header[7:])
                if user:
                    self._json_response({'status': 'success', 'user': user})
                else:
                    self._json_response({'status': 'error', 'message': '令牌无效或已过期'}, 401)
                return

            elif self.path == '/auth/change-password':
                auth_header = self.headers.get('Authorization', '')
                if not auth_header.startswith('Bearer '):
                    self._json_response({'status': 'error', 'message': '未提供令牌'}, 401)
                    return
                user = validate_request(auth_header[7:])
                if not user:
                    self._json_response({'status': 'error', 'message': '令牌无效'}, 401)
                    return
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8-sig')
                try:
                    data = json.loads(body)
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return
                result = change_password(
                    user['username'],
                    data.get('oldPassword', ''),
                    data.get('newPassword', '')
                )
                self._json_response(result)
                return

            # ============ 错误上报端点 ============
            elif self.path == '/api/errors/report':
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8-sig')
                try:
                    data = json.loads(body)
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return
                errors = data.get('errors', [])
                for err in errors:
                    frontend_error_reporter.report(err)
                self._json_response({'status': 'received', 'count': len(errors)})
                return

            elif self.path == '/api/logs':
                from urllib.parse import urlparse, parse_qs
                params = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
                level = params.get('level')
                limit = int(params.get('limit', 100))
                logs = get_recent_logs(level=level, limit=limit)
                self._json_response({'logs': logs})
                return

            elif self.path == '/api/errors':
                errors = frontend_error_reporter.get_errors(limit=100)
                self._json_response({'errors': errors})
                return

            # ============ 原有端点 ============
            if self.path == '/classify':
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8-sig')
                try:
                    input_data = json.loads(body)
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return

                items = input_data.get('items', [])
                require_case = input_data.get('require_case', True)
                intercept_brand = input_data.get('intercept_brand', True)
                site = input_data.get('site', 'usa').lower()

                # ═══ 通用化配置路由 (v3.1-rc4 2026-09-04) ═══
                # 所有站点使用同一份 model_groups / alias_rules (通用化)
                # 老代码 usa_model_groups/eu_model_groups/de_model_groups 字段已废弃但保留兼容
                is_usa = site in ('usa', 'us', 'us.com')
                # 统一用通用 model_groups (无论 USA / EU / DE)
                groups = getattr(app, 'model_groups', [])
                aliases = getattr(app, 'alias_rules', [])
                # 同一个分类批次内配置不变，预编译一次即可；避免每条搜索词
                # 重复扫描 2.5 万条拓词、排序机型组和编译正则。
                matcher = prepare_matcher(groups, aliases)
                # 兼容老配置: 如果 usa_model_groups != model_groups, 警告
                if hasattr(app, 'usa_model_groups') and app.usa_model_groups != groups:
                    import sys
                    print(f"[serve WARN] usa_model_groups != model_groups, 建议统一通用配置 (site={site})", file=sys.stderr)

                def _resolve_campaign_group(name_val):
                    """按活动名/机型号查找映射组：
                    精确匹配 → 忽略大小写 → 归一化(去 /、-、空格) → 剥离末尾 /5G /4G 后缀变体
                    → 从活动名分段提取机型代码（如 SP_IP14ProMax_Broad → IP14ProMax）。
                    返回组名字符串，找不到返回 None。"""
                    if not name_val:
                        return None
                    s = str(name_val).strip()
                    if not s:
                        return None
                    direct = app.campaign_group_map.get(s, None)
                    if direct:
                        return direct
                    s_low = s.lower()
                    for _k in app.campaign_group_map:
                        if _k.lower() == s_low:
                            return app.campaign_group_map[_k]
                    # 活动名通常会在机型映射键后追加投放结构，例如
                    # `REVVL/V+-PU-CK-自动`、`IP17Pro-自动-Light Brown`。
                    # 旧逻辑随后按 `/` 和 `-` 拆分，会把 `REVVL/V+` 拆散，
                    # 导致活动丢失目标组并退化为全局机型猜测。先做带分隔符的
                    # 前缀匹配，且要求分隔符边界，避免 A17 误匹配 A170。
                    for _k in app.campaign_group_map:
                        _k_low = str(_k).strip().lower()
                        if not _k_low or len(_k_low) < 3:
                            continue
                        if re.match(r'^' + re.escape(_k_low) + r'(?=$|[-_\s])', s_low):
                            return app.campaign_group_map[_k]
                    # 归一化候选集合：去掉 /、-、空格，并生成剥离末尾 5G/4G 后的变体
                    _strip_sep = lambda x: re.sub(r'[/\s\-]', '', x)
                    forms = {_strip_sep(s_low)}
                    for suf in ('/5g', '/4g'):
                        if len(s_low) > len(suf) and s_low.endswith(suf):
                            forms.add(_strip_sep(s_low[: -len(suf)]))
                    for suf in ('5g', '4g'):
                        if len(s_low) > len(suf) and s_low.endswith(suf):
                            forms.add(s_low[: -len(suf)])
                        ns = _strip_sep(s_low)
                        if len(ns) > len(suf) and ns.endswith(suf):
                            forms.add(ns[: -len(suf)])
                    for _k in app.campaign_group_map:
                        _k_low = _k.lower()
                        _k_forms = {_strip_sep(_k_low)}
                        for suf in ('/5g', '/4g'):
                            if len(_k_low) > len(suf) and _k_low.endswith(suf):
                                _k_forms.add(_strip_sep(_k_low[: -len(suf)]))
                        _kn = _strip_sep(_k_low)
                        for suf in ('5g', '4g'):
                            if len(_kn) > len(suf) and _kn.endswith(suf):
                                _k_forms.add(_kn[: -len(suf)])
                        if _k_forms & forms:
                            return app.campaign_group_map[_k]

                    # ═══ 新增：从活动名分段提取机型代码 ═══
                    # 处理格式如 SP_IP14ProMax_Broad、SP_IP14ProMax、SP-IP14ProMax-Broad
                    # 按 _、-、空格、/、. 等分隔符拆分，检查每个分段是否匹配映射表
                    _parts = re.split(r'[_\-/\s.]+', s)
                    for _part in _parts:
                        if not _part or len(_part) < 3:
                            continue
                        # 精确匹配分段
                        _direct = app.campaign_group_map.get(_part, None)
                        if _direct:
                            return _direct
                        # 忽略大小写匹配分段
                        _part_low = _part.lower()
                        for _k in app.campaign_group_map:
                            if _k.lower() == _part_low:
                                return app.campaign_group_map[_k]
                        # 归一化分段后再匹配（去分隔符）
                        _part_norm = re.sub(r'[/\s\-]', '', _part_low)
                        for _k in app.campaign_group_map:
                            _k_norm = re.sub(r'[/\s\-]', '', _k.lower())
                            if _k_norm == _part_norm:
                                return app.campaign_group_map[_k]

                    return None

                results = []
                with _lock:
                    app.require_case = require_case
                    app.intercept_brand = intercept_brand
                    for item in items:
                        term = item.get('term', '').lower()
                        campaign = item.get('campaign', '') or item.get('campaignName', '')
                        row_model_override = item.get('rowModel', '')
                        target_group_name_override = item.get('targetGroupName', '')

                        row_model = row_model_override or None
                        target_group_name = target_group_name_override
                        if not target_group_name and (campaign or row_model):
                            # 映射查找：精确 → 忽略大小写 → 归一化(去 /、空格并剥离 /5G /4G 后缀)
                            target_group_name = _resolve_campaign_group(campaign)
                            if not target_group_name:
                                target_group_name = _resolve_campaign_group(row_model)

                        # ═══ 新分类逻辑 v3：详细原因聚合 ════════════════════════
                        # 否定原因（用 / 连接全部命中项）：
                        #   未匹配{目标组}的拓词 / 无壳类词 / 含竞品品牌:{b1},{b2} /
                        #   含机型否词库词[{kw}]({机型}) / 含型号否词:{model}
                        # 保留原因：匹配{组}+壳类词 / 匹配{组}的拓词
                        # ═════════════════════════════════════════════════════════
                        norm_term = normalize_keyword(term)
                        tag = 'deny'
                        reason = ''

                        # 确认目标组（来自 Campaign 映射或 rowModel 映射）
                        mapped_group_name = target_group_name or None

                        # 对形如 IP18Pro-... 的新活动，若尚未建立 Campaign 映射，
                        # 禁止全局匹配到旧机型（例如 iPhone 15）后直接生成错误否词。
                        # 先进入待审，提示运营补充映射，这是比跨机型误否更安全的行为。
                        unmapped_phone_code = None
                        if not mapped_group_name:
                            for _candidate in (campaign, row_model):
                                _m = re.match(
                                    r'^\s*(IP\d+(?:ProMax|Pro|Plus|e)?)(?=$|[-_/\s])',
                                    str(_candidate or ''),
                                    flags=re.IGNORECASE,
                                )
                                if _m:
                                    unmapped_phone_code = _m.group(1)
                                    break

                        def _hit_case_word(t):
                            """快速壳类词匹配：预编译正则，避免逐词遍历"""
                            # Amazon 搜索词经常把复合词连写：phonecases、phonecovers。
                            # 单独匹配 `case/cover` 要求词边界，会漏掉这类合法的手机壳词，
                            # 进而把明确的壳类搜索词误判为“无壳类词”。
                            compound = re.search(r'\b(?:phone|cellphone|mobilephone)(?:cases?|covers?)\b', t)
                            if compound:
                                return compound.group(0)

                            # 型号与壳类词连写：11procase、maxwallet、17wallet、a17hülle。
                            # 只有“型号数字+类型词”或常见型号变体+类型词才认定，
                            # 避免 showcase / walletless 等普通词被误当作壳类词。
                            for joined in _JOINED_SHELL_SUFFIX_RE.finditer(t):
                                stem = joined.group('stem').lower()
                                if any(ch.isdigit() for ch in stem) or stem in _JOINED_MODEL_STEMS:
                                    return joined.group('shell').lower()

                            if getattr(app, '_case_re', None) is None:
                                valid = [w for w in app.keep_case_words if w and w.strip()]
                                app._case_re = re.compile(r'\b(' + '|'.join(re.escape(w.lower()) for w in valid) + r')(?:\b|(?=[a-z]))')
                            m = app._case_re.search(t)
                            if m:
                                return m.group(1)
                            return None

                        def _hit_brands(t):
                            """快速品牌匹配：预编译正则"""
                            if getattr(app, '_brand_re', None) is None:
                                valid = [b for b in app.deny_brands if b and b.strip()]
                                app._brand_re = re.compile(r'\b(' + '|'.join(re.escape(b.lower()) for b in valid) + r')(?:\b|(?=[a-z]))')
                            return list(app._brand_re.findall(t))

                        def _hit_deny_library(t, target_group=None):
                            """返回 [(kw, 机型显示名), ...] 命中机型否词库的条目（最多3条），使用预编译正则加速

                            v3.1-rc4 (2026-09-04) 修复: target_group=None 时直接 return []
                            原因: 全库扫描会触发 brands 反咬 (smartphonehülle samsung 会被
                            iPhone 7/8/SE_deny 命中因 keywords 含 'samsung')
                            调用方必须传 mapped_group_name 或 gname (find_matching_group 结果)
                            """
                            if not target_group:
                                # 无目标组 → 不查 deny 库 (已经 tag='deny' 是其他原因)
                                return []
                            # ⚠️ 组内限定：target_group 非空时只精确匹配与该组关联的否词条目。
                            # _norm 剥离 _deny/-deny 后缀仅用于关联主组与其否词库变体，
                            # 且使用 == 精确相等匹配（非子串匹配），
                            # 因此 A 组的否词库词不会匹配到 B 组。
                            _norm = lambda s: re.sub(r'\s+', '', (s or '').lower()).replace('_deny', '').replace('-deny', '')
                            tg_norm = _norm(target_group)
                            library = []
                            for item in app.deny_model_library:
                                linked = item.get('linked_models') or [item.get('name', '')]
                                # 精确匹配：只取与目标组完全对应的否词条目，避免子串匹配导致父机型泄漏到子机型
                                if any(tg_norm == _norm(m) for m in linked):
                                    library.append(item)
                            hits = []
                            for item in library:
                                for kw in item.get('keywords', []):
                                    if kw and kw.strip():
                                        kl = kw.lower()
                                        if re.search(r'\b' + re.escape(kl) + r'\b', t):
                                            # DE站仅豁免指定基础机型对应的 e 变体否词；
                                            # 不影响其他站点，也不把 e 全局视为可忽略后缀。
                                            if is_de_base_model_deny_exception(site, target_group, kw):
                                                continue
                                            model_name = (item.get('linked_models') or [item.get('name', '')])[0]
                                            # 账户搜索词里 `mac` 是用户对 `max` 的常见拼写变体。
                                            # 保留原有否定命中，但导出原因统一显示为 max，避免把
                                            # 用户想否定的 max 词误解释成 Mac 电脑词。
                                            report_kw = 'max' if kl == 'mac' else kw
                                            hits.append((report_kw, model_name))
                                            break
                                if len(hits) >= 3:
                                    return hits
                            return hits

                        def _hit_deny_models(t):
                            """快速型号否词匹配：预编译正则"""
                            if getattr(app, '_deny_model_re', None) is None:
                                valid = [m for m in app.deny_models if m and m.strip()]
                                app._deny_model_re = re.compile(r'\b(' + '|'.join(re.escape(m.lower()) for m in valid) + r')(?:\b|(?=[a-z]))')
                            m = app._deny_model_re.search(t)
                            if m:
                                return m.group(1)
                            return None

                        def _hit_screen_protector(t):
                            """检查搜索词是否命中屏幕保护膜词"""
                            if not app.screen_protector_words:
                                return False
                            if getattr(app, '_screen_protector_re', None) is None:
                                valid = [w for w in app.screen_protector_words if w and w.strip()]
                                if not valid:
                                    return False
                                app._screen_protector_re = re.compile(r'\b(' + '|'.join(re.escape(w.lower()) for w in valid) + r')(?:\b|(?=[a-z]))')
                            return bool(app._screen_protector_re.search(t))

                        def _strip_screen_protector_words(t):
                            """剔除搜索词中命中的屏幕保护膜词子串（用于判断是否还有真实壳类词）
                            保护膜词优先于拓词/壳类词判定：screen protector 命中后剔除，
                            剩余部分若无真实壳类词（case/cover 等）则直接否掉。"""
                            if not app.screen_protector_words:
                                return t
                            if getattr(app, '_screen_protector_re', None) is None:
                                valid = [w for w in app.screen_protector_words if w and w.strip()]
                                if not valid:
                                    return t
                                app._screen_protector_re = re.compile(r'\b(' + '|'.join(re.escape(w.lower()) for w in valid) + r')(?:\b|(?=[a-z]))')
                            return app._screen_protector_re.sub(' ', t)

                        case_word = _hit_case_word(norm_term)

                        if mapped_group_name:
                            # ── 有目标映射组：只检查目标组 ──
                            # ═══ 修复：透传 marketplace，激活 EU 站 SKU 守卫（Bug1）═══
                            gname, mtype, mkeyword = find_matching_group_in_target(
                                norm_term, groups, mapped_group_name, aliases, marketplace=site, matcher=matcher,
                                alias_target_resolver=_resolve_campaign_group)
                            if gname:
                                tag = 'keep'
                                # 区分 壳类词 / 拓词
                                if case_word:
                                    reason = f'匹配{gname}壳类词' if str(gname).rstrip().endswith('+') else f'匹配{gname}+壳类词'
                                else:
                                    reason = f'匹配{gname}的拓词'
                                # ═══ 修复：匹配到机型组时，仍需检查竞品品牌/需壳类词/否词库 ═══
                                # 竞品品牌优先拦截（开关开启且命中品牌 → 改否掉）
                                deny_reasons = []
                                if app.intercept_brand:
                                    brands = _hit_brands(norm_term)
                                    if brands:
                                        deny_reasons.append('含竞品品牌:' + ','.join(brands))
                                # ═══ 屏幕保护膜词优先判定（独立规则）═══
                                # 命中保护膜词（screen protector/tempered glass 等）且剔除后
                                # 无真实壳类词（case/cover 等）→ 直接否掉，优先于拓词匹配。
                                # protector 留在 keep_case_words 中（属壳类词），
                                # 但 screen protector 类复合词命中时以保护膜词判定为准。
                                _hit_sp = _hit_screen_protector(norm_term)
                                if _hit_sp and not _hit_case_word(_strip_screen_protector_words(norm_term)):
                                    deny_reasons.append('仅屏幕保护膜词')
                                # 需壳类词模式：匹配到组但无壳类词 → 否掉（仅机型词=否掉）
                                if app.require_case and not case_word and '仅屏幕保护膜词' not in deny_reasons:
                                    deny_reasons.append('无壳类词')
                                # 否词库二次检查：匹配了拓词但命中否词库 → 改为否定
                                deny_hits = list(_hit_deny_library(norm_term, mapped_group_name))
                                for kw, mn in deny_hits:
                                    deny_reasons.append(f'含机型否词库词[{kw}]({mn})')
                                if deny_reasons:
                                    tag = 'deny'
                                    reason = '/'.join([reason] + deny_reasons)
                            else:
                                # 目标组不匹配 → 聚合全部否词原因
                                tag = 'deny'
                                parts = [f'未匹配{mapped_group_name}的拓词']
                                # 壳类特征缺失（仅在需壳类词时作为原因）
                                if app.require_case and not case_word:
                                    if _hit_screen_protector(norm_term):
                                        parts.append('仅屏幕保护膜词')
                                    else:
                                        parts.append('无壳类词')
                                # 竞品品牌（仅在拦截品牌开启时）
                                if app.intercept_brand:
                                    brands = _hit_brands(norm_term)
                                    if brands:
                                        parts.append('含竞品品牌:' + ','.join(brands))
                                # 机型否词库（仅查与目标组关联的条目，避免跨机型误判）
                                for kw, mn in _hit_deny_library(norm_term, mapped_group_name):
                                    parts.append(f'含机型否词库词[{kw}]({mn})')
                                # 型号否词
                                dm = _hit_deny_models(norm_term)
                                if dm:
                                    parts.append(f'含型号否词:{dm}')
                                reason = '/'.join(parts)
                        elif unmapped_phone_code:
                            tag = 'review'
                            reason = f'活动未映射：{unmapped_phone_code}，未进行全局机型猜测，请先配置对应机型组'
                        else:
                            # ── 无目标映射组：遍历所有组查找匹配，命中则保留 ──
                            # ═══ 修复：透传 marketplace，激活 EU 站 SKU 守卫（Bug1）═══
                            gname, mtype, mkeyword = find_matching_group(
                                norm_term, groups, aliases, marketplace=site, matcher=matcher)
                            if gname:
                                # 匹配到任一机型组 → 保留，写明原因
                                tag = 'keep'
                                if case_word:
                                    reason = f'匹配{gname}壳类词' if str(gname).rstrip().endswith('+') else f'匹配{gname}+壳类词'
                                else:
                                    reason = f'匹配{gname}的拓词'
                                # ═══ 修复：匹配到机型组时，仍需检查竞品品牌/需壳类词/否词库 ═══
                                # 竞品品牌优先拦截（开关开启且命中品牌 → 改否掉）
                                deny_reasons = []
                                if app.intercept_brand:
                                    brands = _hit_brands(norm_term)
                                    if brands:
                                        deny_reasons.append('含竞品品牌:' + ','.join(brands))
                                # ═══ 屏幕保护膜词优先判定（独立规则）═══
                                # 命中保护膜词且剔除后无真实壳类词 → 直接否掉，优先于拓词匹配
                                _hit_sp = _hit_screen_protector(norm_term)
                                if _hit_sp and not _hit_case_word(_strip_screen_protector_words(norm_term)):
                                    deny_reasons.append('仅屏幕保护膜词')
                                # 需壳类词模式：匹配到组但无壳类词 → 否掉（仅机型词=否掉）
                                if app.require_case and not case_word and '仅屏幕保护膜词' not in deny_reasons:
                                    deny_reasons.append('无壳类词')
                                # 否词库二次检查：匹配了拓词但命中否词库 → 改为否定
                                deny_hits = list(_hit_deny_library(norm_term, gname))
                                for kw, mn in deny_hits:
                                    deny_reasons.append(f'含机型否词库词[{kw}]({mn})')
                                if deny_reasons:
                                    tag = 'deny'
                                    reason = '/'.join([reason] + deny_reasons)
                            else:
                                # 未匹配任何组 → 聚合品牌/壳类原因
                                # v3.1-rc4 (2026-09-04) 修复: 无目标组时不再查 deny 库
                                # 原因: 全库扫描会触发 brands 反咬 (e.g. smartphonehülle samsung
                                # 会被 iPhone 7/8/SE_deny 命中, 因 keywords 含 'samsung')
                                # 已经 tag='deny' 是其他原因 (竞品品牌/缺壳类词/缺型号), 不需要额外 deny 库
                                tag = 'deny'
                                parts = []
                                # 竞品品牌（仅在拦截品牌开启时）
                                if app.intercept_brand:
                                    brands = _hit_brands(norm_term)
                                    if brands:
                                        parts.append('含竞品品牌:' + ','.join(brands))
                                # 型号否词（仍然检查）
                                dm = _hit_deny_models(norm_term)
                                if dm:
                                    parts.append(f'含型号否词:{dm}')
                                # 壳类特征缺失（仅在需壳类词时作为原因）
                                if app.require_case and not case_word:
                                    if _hit_screen_protector(norm_term):
                                        parts.append('仅屏幕保护膜词')
                                    else:
                                        parts.append('无壳类词')
                                if not parts:
                                    parts.append('未匹配任一机型组的拓词')
                                reason = '/'.join(parts)

                        results.append({
                            'tag': tag,
                            'reason': reason,
                            'rowModel': row_model,
                            'targetGroupName': mapped_group_name or '',
                        })

                self._json_response({'results': results, 'total': len(results)})

            # ============ 否词结果AI审核端点 ============
            elif self.path == '/api/neg-audit':
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8-sig')
                try:
                    input_data = json.loads(body)
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return

                items = input_data.get('items', [])
                if not items:
                    self._json_response({'error': '缺少分类结果数据'}, 400)
                    return

                with _lock:
                    report = run_audit(
                        items=items,
                        model_groups=app.model_groups,
                        deny_brands=app.deny_brands,
                        keep_case_words=app.keep_case_words,
                        deny_model_library=app.deny_model_library,
                        alias_rules=app.alias_rules,
                    )

                # 可选：生成CSV修正清单
                csv_output = generate_audit_csv(report) if input_data.get('format_csv') else ''

                # ═══ 自动存档审核结果到桌面AMZ ERP导出文件目录 ═══
                try:
                    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
                    # 与启动器 /api/export/save 共用用户指定的默认导出目录。
                    # DISCOVER_EXPORT_DIR 可由启动器或部署环境覆盖。
                    _export_dir = os.environ.get(
                        'DISCOVER_EXPORT_DIR',
                        os.path.join(os.path.expanduser('~'), 'Desktop', '探险者ERP导出文件目录'),
                    )
                    report_dir = os.path.join(_export_dir, 'audit_reports')
                    os.makedirs(report_dir, exist_ok=True)
                    # 1. 保存CSV修正清单（带时间戳）
                    if csv_output:
                        csv_path = os.path.join(report_dir, f'否词审核修正清单_{timestamp}.csv')
                        with open(csv_path, 'w', encoding='utf-8-sig', newline='') as f:
                            f.write(csv_output)
                    # 2. 保存JSON审核报告（带时间戳）
                    json_path = os.path.join(report_dir, f'否词审核报告_{timestamp}.json')
                    with open(json_path, 'w', encoding='utf-8') as f:
                        json.dump(report, f, ensure_ascii=False, indent=2, default=str)
                    # 3. 保存多Sheet Excel（分类分页展示）
                    xlsx_path = os.path.join(report_dir, f'否词审核修正清单_{timestamp}.xlsx')
                    generate_audit_xlsx(report, xlsx_path)
                    logger.info(f"否词审核结果已存档: CSV/JSON/XLSX 共3个文件")
                except Exception as _audit_save_err:
                    logger.warning(f"否词审核结果存档失败: {_audit_save_err}")

                self._json_response({
                    'report': report,
                    'csv': csv_output,
                    'saved_dir': 'audit_reports',
                })
                return

            elif self.path == '/api/config':
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8-sig')
                try:
                    data = json.loads(body)
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return
                with _lock:
                    if 'deny_brands' in data:
                        app.deny_brands = data['deny_brands']
                        app._brand_re = None  # 清除缓存，下次 _hit_brands 重新编译
                    if 'deny_models' in data:
                        app.deny_models = data['deny_models']
                        app._deny_model_re = None  # 清除缓存，下次 _hit_deny_models 重新编译
                    if 'keep_case_words' in data:
                        app.keep_case_words = data['keep_case_words']
                        app._case_re = None  # 清除缓存，下次 _hit_case_word 重新编译
                    if 'screen_protector_words' in data:
                        app.screen_protector_words = data['screen_protector_words']
                        app._screen_protector_re = None  # 清除缓存，下次 _hit_screen_protector 重新编译
                    if 'deny_model_library' in data:
                        app.deny_model_library = data['deny_model_library']
                    if 'model_groups' in data:
                        app.model_groups = data['model_groups']
                    if 'alias_rules' in data:
                        app.alias_rules = data['alias_rules']
                    if 'usa_model_groups' in data:
                        app.usa_model_groups = data['usa_model_groups']
                    if 'usa_alias_rules' in data:
                        app.usa_alias_rules = data['usa_alias_rules']
                    saved = _save_rules_to_disk()
                if not saved:
                    self._json_response({
                        'status': 'error', 'persisted': False,
                        'error': '规则配置未能写入磁盘，请稍后重试',
                    }, 500)
                    return
                self._json_response({'status': 'ok', 'message': 'Config updated and saved'})
            elif self.path == '/api/campaign-id-mappings':
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8-sig')
                try:
                    data = json.loads(body)
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return
                mappings = data.get('mappings', []) if isinstance(data, dict) else []
                if not isinstance(mappings, list):
                    self._json_response({'error': 'mappings must be an array'}, 400)
                    return
                with _lock:
                    # 仅存储可序列化对象，避免异常导入值污染规则配置文件。
                    app.campaign_id_mappings = [item for item in mappings if isinstance(item, dict)]
                    saved = _save_rules_to_disk()
                if not saved:
                    self._json_response({
                        'status': 'error', 'persisted': False,
                        'error': 'Campaign ID 映射未能写入磁盘，请稍后重试',
                    }, 500)
                    return
                self._json_response({'status': 'ok', 'count': len(app.campaign_id_mappings)})
            elif self.path == '/api/campaign-map':
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8-sig')
                try:
                    data = json.loads(body)
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return
                with _lock:
                    if isinstance(data, dict) and 'map' in data:
                        app.campaign_group_map = data['map']
                    elif isinstance(data, dict):
                        app.campaign_group_map = data
                    saved = _save_rules_to_disk()
                if not saved:
                    self._json_response({
                        'status': 'error', 'persisted': False,
                        'error': '规则配置未能写入磁盘，请稍后重试',
                    }, 500)
                    return
                self._json_response({'status': 'ok', 'count': len(app.campaign_group_map)})
            elif self.path == '/api/model-groups':
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8-sig')
                try:
                    data = json.loads(body)
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return
                if not isinstance(data, dict):
                    self._json_response({'error': 'JSON body must be an object'}, 400)
                    return

                with _lock:
                    if data.get('action') == 'update_group':
                        group_index = data.get('index')
                        patch = data.get('patch')
                        if (not isinstance(group_index, int) or isinstance(group_index, bool)
                                or not isinstance(patch, dict)):
                            self._json_response({'error': 'index and patch are required'}, 400)
                            return
                        if group_index < 0 or group_index >= len(app.model_groups):
                            self._json_response({'error': 'model group index is out of range'}, 400)
                            return
                        current_group = app.model_groups[group_index]
                        if not isinstance(current_group, dict):
                            self._json_response({'error': 'model group entry is invalid'}, 400)
                            return
                        updated_group = dict(current_group)
                        if 'keywords' in patch:
                            keywords = patch['keywords']
                            if (not isinstance(keywords, list)
                                    or any(not isinstance(word, str) for word in keywords)):
                                self._json_response({'error': 'keywords must be an array of strings'}, 400)
                                return
                            updated_group['keywords'] = keywords
                        if 'enabled' in patch:
                            if not isinstance(patch['enabled'], bool):
                                self._json_response({'error': 'enabled must be a boolean'}, 400)
                                return
                            updated_group['enabled'] = patch['enabled']
                        if not any(key in patch for key in ('keywords', 'enabled')):
                            self._json_response({'error': 'patch contains no supported fields'}, 400)
                            return
                        app.model_groups[group_index] = updated_group
                    else:
                        groups = data.get('groups', [])
                        if not isinstance(groups, list):
                            self._json_response({'error': 'groups must be an array'}, 400)
                            return
                        app.model_groups = groups
                    saved = _save_rules_to_disk()
                if not saved:
                    self._json_response({
                        'status': 'error', 'persisted': False,
                        'error': '规则配置未能写入磁盘，请稍后重试',
                    }, 500)
                    return
                self._json_response({'status': 'ok', 'count': len(app.model_groups)})
            elif self.path == '/api/deny-library':
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8-sig')
                try:
                    data = json.loads(body)
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return
                with _lock:
                    app.deny_model_library = data.get('library', [])
                    saved = _save_rules_to_disk()
                if not saved:
                    self._json_response({
                        'status': 'error', 'persisted': False,
                        'error': '规则配置未能写入磁盘，请稍后重试',
                    }, 500)
                    return
                self._json_response({'status': 'ok', 'count': len(app.deny_model_library)})
            elif self.path == '/api/alias-rules':
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8-sig')
                try:
                    data = json.loads(body)
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return
                rules = data.get('rules', [])
                with _lock:
                    app.alias_rules = rules
                    saved = _save_rules_to_disk()
                if not saved:
                    self._json_response({
                        'status': 'error', 'persisted': False,
                        'error': '规则配置未能写入磁盘，请稍后重试',
                    }, 500)
                    return
                self._json_response({'status': 'ok', 'count': len(rules)})
            elif self.path == '/api/config/partial':
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8-sig')
                try:
                    data = json.loads(body)
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return
                updated = []
                with _lock:
                    for key, value in data.items():
                        if hasattr(app, key):
                            setattr(app, key, value)
                            updated.append(key)
                    if updated:
                        # ═══ 修复：词表类配置更新后清除正则缓存，下次分类重新编译 ═══
                        # setattr 直接覆盖列表但不会清 _brand_re/_case_re 等缓存正则，
                        # 导致新增品牌/壳类词/型号否词/屏幕保护膜词不生效，需重启才生效。
                        if any(k in updated for k in ('deny_brands', 'keep_case_words',
                                                      'deny_models', 'screen_protector_words')):
                            app._brand_re = None
                            app._case_re = None
                            app._deny_model_re = None
                            app._screen_protector_re = None
                            print('[config/partial] 词表更新，已清除正则缓存')
                    saved = _save_rules_to_disk()
                if not saved:
                    self._json_response({
                        'status': 'error', 'persisted': False,
                        'error': '规则配置未能写入磁盘，请稍后重试',
                    }, 500)
                    return
                self._json_response({'status': 'ok', 'updated': updated})
            elif self.path == '/api/export/save':
                import base64
                content_length = int(self.headers.get('Content-Length', 0))
                raw_body = self.rfile.read(content_length).decode('utf-8-sig') if content_length else '{}'
                try:
                    data = json.loads(raw_body) if raw_body.strip() else {}
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return
                file_name = os.path.basename((data.get('fileName') or 'export.xlsx').strip()) or 'export.xlsx'
                b64 = data.get('base64Content') or ''
                if not b64:
                    self._json_response({'error': 'base64Content 不能为空'}, 400)
                    return
                try:
                    raw_bytes = base64.b64decode(b64)
                    desktop_dir = os.path.join(os.path.expanduser('~'), 'Desktop')
                    export_dir = os.path.join(desktop_dir, 'AMZ否词导出') if os.path.isdir(desktop_dir) else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'exports')
                    os.makedirs(export_dir, exist_ok=True)
                    target_path = os.path.join(export_dir, file_name)
                    with open(target_path, 'wb') as f:
                        f.write(raw_bytes)
                    self._json_response({'status': 'ok', 'path': target_path, 'fileName': file_name, 'size': len(raw_bytes)})
                except Exception as e:
                    self._json_response({'error': f'导出写盘失败: {e}'}, 500)
            elif self.path == '/api/stores/switch':
                content_length = int(self.headers.get('Content-Length', 0))
                raw_body = self.rfile.read(content_length).decode('utf-8-sig') if content_length else '{}'
                try:
                    data = json.loads(raw_body) if raw_body.strip() else {}
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return
                store_id = (data.get('store_id') or '').strip()
                if not store_id:
                    self._json_response({'error': 'store_id 不能为空'}, 400)
                    return
                try:
                    with _lock:
                        state = switch_active_store(store_id)
                        _hot_reload_from_disk()
                    schedule_sync_to_github(f"switch store -> {store_id}")
                    self._json_response({'status': 'ok', **state})
                except Exception as e:
                    self._json_response({'error': str(e)}, 400)
            elif self.path == '/api/stores/create':
                content_length = int(self.headers.get('Content-Length', 0))
                raw_body = self.rfile.read(content_length).decode('utf-8-sig') if content_length else '{}'
                try:
                    data = json.loads(raw_body) if raw_body.strip() else {}
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return
                store_id = (data.get('store_id') or data.get('name') or '').strip()
                name = (data.get('name') or store_id).strip()
                marketplace = (data.get('marketplace') or 'US').strip().upper()
                copy_from = (data.get('copy_from') or '').strip() or None
                if not store_id:
                    self._json_response({'error': '店铺 ID 或名称不能为空'}, 400)
                    return
                try:
                    with _lock:
                        state = create_or_update_store(store_id, name, marketplace, copy_from=copy_from)
                        _hot_reload_from_disk()
                    schedule_sync_to_github(f"create store {store_id}")
                    self._json_response({'status': 'ok', **state})
                except Exception as e:
                    self._json_response({'error': str(e)}, 400)
            elif self.path == '/api/backup/full':
                res = backup_all_to_github_and_gdrive("manual full backup from UI")
                self._json_response(res)
            elif self.path == '/api/gemini-audit':
                import urllib.request
                import urllib.error
                content_length = int(self.headers.get('Content-Length', 0))
                raw_body = self.rfile.read(content_length).decode('utf-8-sig') if content_length else '{}'
                try:
                    data = json.loads(raw_body) if raw_body.strip() else {}
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return

                api_cfg = load_api_config() or {}
                api_key = (data.get('api_key') or api_cfg.get('gemini_api_key') or '').strip()
                if not api_key:
                    self._json_response({'error': '未配置 Gemini API Key，请先在 api_config.json 中配置'}, 400)
                    return

                rows = data.get('rows') or []
                if not isinstance(rows, list) or len(rows) == 0:
                    self._json_response({'error': '没有需要复核的否词记录'}, 400)
                    return

                site = str(data.get('site') or 'US').upper()
                preferred_model = str(data.get('model') or api_cfg.get('gemini_model') or 'gemini-3-flash-preview').strip()
                models_to_try = [preferred_model] + [m for m in ('gemini-3-flash-preview', 'gemini-flash-latest', 'gemini-2.5-flash-lite') if m != preferred_model]

                batch_rows = rows[:100]
                compact_items = [
                    {
                        'idx': i,
                        'campaign': str(r.get('campaign') or ''),
                        'targetGroup': str(r.get('targetGroup') or r.get('targetGroupName') or ''),
                        'searchTerm': str(r.get('searchTerm') or ''),
                        'reason': str(r.get('reason') or ''),
                    }
                    for i, r in enumerate(batch_rows)
                ]
                prompt = (
                    f"你是亚马逊手机壳广告（站点 {site}）的资深否定关键词审计专家。\n"
                    "以下是系统判定为【否掉 (deny)】的客户搜索词列表，请你逐条核查是否存在【误否】。\n"
                    "判断原则：\n"
                    "1. 如果搜索词明确指向目标机型组（包括德/法/西/意语的壳类词如 hülle/klapphülle/coque/funda/custodia，或纯机型词、合理缩写/空格变体、官方型号代码、该机型的通用兼容机型），但被系统误否了，标为 false_deny（误否）。\n"
                    "2. 如果搜索词明显是其他手机型号、不相关配件（如钢化膜/充电器/手表带）或无关泛词，标为 correct_deny（确认否掉）。\n"
                    "3. 如果无法确定（如信息不足），标为 uncertain。\n"
                    "请严格仅输出 JSON 数组，不要输出 markdown 代码块或其他文字，每项格式为："
                    '{"idx": 0, "verdict": "false_deny|correct_deny|uncertain", "note": "简短中文理由"}\n'
                    f"待核查列表：\n{json.dumps(compact_items, ensure_ascii=False)}"
                )

                last_err = ''
                used_model = preferred_model
                parsed_list = None
                for mname in models_to_try:
                    url = f"https://generativelanguage.googleapis.com/v1beta/models/{mname}:generateContent?key={api_key}"
                    req_body = json.dumps({
                        'contents': [{'parts': [{'text': prompt}]}],
                        'generationConfig': {'responseMimeType': 'application/json', 'temperature': 0.1},
                    }, ensure_ascii=False).encode('utf-8')
                    req = urllib.request.Request(url, data=req_body, headers={'Content-Type': 'application/json'}, method='POST')
                    try:
                        with urllib.request.urlopen(req, timeout=45) as resp:
                            resp_json = json.loads(resp.read().decode('utf-8'))
                        text_out = resp_json['candidates'][0]['content']['parts'][0]['text'].strip()
                        if text_out.startswith('```'):
                            text_out = re.sub(r'^```(?:json)?\s*|\s*```$', '', text_out, flags=re.S)
                        parsed_list = json.loads(text_out)
                        used_model = mname
                        break
                    except urllib.error.HTTPError as e:
                        last_err = f"HTTP {e.code}: {e.read().decode('utf-8', errors='replace')[:200]}"
                    except Exception as e:
                        last_err = str(e)

                if not isinstance(parsed_list, list):
                    self._json_response({'error': f'Gemini 调用失败: {last_err}'}, 502)
                    return

                by_idx = {int(item.get('idx')): item for item in parsed_list if isinstance(item, dict) and 'idx' in item}
                merged_results = []
                for i, orig in enumerate(batch_rows):
                    ai = by_idx.get(i, {})
                    merged_results.append({
                        'key': orig.get('key', i),
                        'campaign': orig.get('campaign', ''),
                        'searchTerm': orig.get('searchTerm', ''),
                        'targetGroup': orig.get('targetGroup') or orig.get('targetGroupName') or '',
                        'reason': orig.get('reason', ''),
                        'verdict': ai.get('verdict', 'uncertain'),
                        'note': ai.get('note', ''),
                    })
                false_denies = [x for x in merged_results if x['verdict'] == 'false_deny']
                self._json_response({
                    'status': 'ok',
                    'model': used_model,
                    'audited_count': len(merged_results),
                    'false_deny_count': len(false_denies),
                    'results': merged_results,
                })
            elif self.path == '/api/gemini-chat':
                import urllib.request
                import urllib.error
                content_length = int(self.headers.get('Content-Length', 0))
                raw_body = self.rfile.read(content_length).decode('utf-8-sig') if content_length else '{}'
                try:
                    data = json.loads(raw_body) if raw_body.strip() else {}
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return

                api_cfg = load_api_config() or {}
                api_key = (data.get('api_key') or api_cfg.get('gemini_api_key') or '').strip()
                if not api_key:
                    self._json_response({'error': '未配置 Gemini API Key，请先在 api_config.json 中配置'}, 400)
                    return

                messages = data.get('messages') or []
                if not isinstance(messages, list) or not messages:
                    self._json_response({'error': '消息不能为空'}, 400)
                    return

                module_key = str(data.get('module') or 'planner')
                module_label = str(data.get('moduleLabel') or module_key)
                store_id = str(data.get('storeId') or get_stores_state().get('active_store_id') or 'default')
                store_name = str(data.get('storeName') or store_id)
                marketplace = str(data.get('marketplace') or 'US')
                extra_ctx = str(data.get('extraContext') or '')[:3000]

                # 采集当前模块与店铺的轻量实时上下文摘要
                plugin_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
                ctx_lines = [
                    f"当前模块: {module_label} ({module_key})",
                    f"当前店铺: {store_name} (ID={store_id}, 站点={marketplace})",
                ]
                try:
                    if module_key == 'neg':
                        ctx_lines.append(
                            f"否词共享规则: 机型组 {len(app.model_groups)} 个, 品牌否词 {len(app.deny_brands)} 个, "
                            f"型号否词 {len(app.deny_models)} 个, 当前店铺 Campaign ID 映射 {len(app.campaign_id_mappings)} 条"
                        )
                    elif module_key == 'planner':
                        pfile = (
                            os.path.join(plugin_root, 'tools', 'ops-planner', 'server', 'data', 'planner_data.json')
                            if store_id == 'default'
                            else os.path.join(plugin_root, 'tools', 'ops-planner', 'server', 'data', 'stores', store_id, 'planner_data.json')
                        )
                        if os.path.exists(pfile):
                            pd = json.load(open(pfile, encoding='utf-8'))
                            tasks = pd.get('tasks', [])
                            okrs = pd.get('okrs', [])
                            top_tasks = [f"- [{t.get('status','')}] {t.get('title','')}" for t in tasks[:15]]
                            ctx_lines.append(f"运营计划: 共 {len(tasks)} 条任务, {len(okrs)} 条 OKR。\n最近任务:\n" + "\n".join(top_tasks))
                    elif module_key == 'weekly-planner':
                        wp_dir = (
                            os.path.join(plugin_root, 'tools', 'weekly-planner', 'server', 'data')
                            if store_id == 'default'
                            else os.path.join(plugin_root, 'tools', 'weekly-planner', 'server', 'data', 'stores', store_id)
                        )
                        wp_file = os.path.join(wp_dir, 'upbestks_data.json')
                        if os.path.exists(wp_file):
                            wd = json.load(open(wp_file, encoding='utf-8'))
                            ctx_lines.append(f"周广告复盘数据: d7={len(wd.get('d7',[]))} 行, d14={len(wd.get('d14',[]))} 行, auto_up={len(wd.get('auto_up',[]))} 行")
                        else:
                            ctx_lines.append("周广告复盘数据: 当前店铺暂无数据")
                    elif module_key == 'ad-scout':
                        ad_file = os.path.join(plugin_root, 'tools', 'ad-scout', 'server', 'data', 'stores', store_id, 'ad_analytics.json')
                        if os.path.exists(ad_file):
                            ad = json.load(open(ad_file, encoding='utf-8'))
                            ctx_lines.append(f"广告数据汇总: meta={json.dumps(ad.get('meta',{}), ensure_ascii=False)}, summary={json.dumps(ad.get('summary',{}), ensure_ascii=False)}")
                        else:
                            ctx_lines.append("广告数据汇总: 当前店铺暂无数据")
                except Exception as _ce:
                    ctx_lines.append(f"(上下文读取提示: {_ce})")

                if extra_ctx:
                    ctx_lines.append(f"前端附加信息:\n{extra_ctx}")

                system_text = (
                    "你是 Discover amzn 亚马逊全能运营工作台的内置 Gemini AI 专家助手。\n"
                    "你可以针对用户当前所在的模块与店铺进行数据分析、规则检查、异常排查、广告出价/否词建议、选品/补货诊断等任何工作。\n"
                    "请用简洁、结构化、可直接落地的中文回答。\n\n"
                    + "\n".join(ctx_lines)
                )

                gemini_contents = []
                for msg in messages[-16:]:
                    role = 'model' if msg.get('role') == 'assistant' else 'user'
                    text = str(msg.get('content') or '').strip()
                    if text:
                        gemini_contents.append({'role': role, 'parts': [{'text': text}]})

                preferred_model = str(data.get('model') or api_cfg.get('gemini_model') or 'gemini-3-flash-preview').strip()
                models_to_try = [preferred_model] + [m for m in ('gemini-3-flash-preview', 'gemini-flash-latest', 'gemini-2.5-flash-lite') if m != preferred_model]

                last_err = ''
                reply_text = None
                used_model = preferred_model
                for mname in models_to_try:
                    url = f"https://generativelanguage.googleapis.com/v1beta/models/{mname}:generateContent?key={api_key}"
                    req_body = json.dumps({
                        'systemInstruction': {'parts': [{'text': system_text}]},
                        'contents': gemini_contents,
                        'generationConfig': {'temperature': 0.3},
                    }, ensure_ascii=False).encode('utf-8')
                    req = urllib.request.Request(url, data=req_body, headers={'Content-Type': 'application/json'}, method='POST')
                    try:
                        with urllib.request.urlopen(req, timeout=45) as resp:
                            resp_json = json.loads(resp.read().decode('utf-8'))
                        reply_text = resp_json['candidates'][0]['content']['parts'][0]['text'].strip()
                        used_model = mname
                        break
                    except urllib.error.HTTPError as e:
                        last_err = f"HTTP {e.code}: {e.read().decode('utf-8', errors='replace')[:200]}"
                    except Exception as e:
                        last_err = str(e)

                if reply_text is None:
                    self._json_response({'error': f'Gemini 对话失败: {last_err}'}, 502)
                    return

                self._json_response({'status': 'ok', 'model': used_model, 'reply': reply_text})
            elif self.path == '/api/sync-config':
                sync_started = time.perf_counter()
                synced = []
                errors = []
                updated = []
                unchanged = []
                sync_notes = []

                with _lock:
                    store_state = get_stores_state()
                    active_sid = store_state.get('active_store_id', 'default')
                    source_file = os.path.join(get_config_dir(), 'rules_config.json')
                    current_config = {
                        'deny_brands': app.deny_brands,
                        'deny_models': app.deny_models,
                        'keep_case_words': app.keep_case_words,
                        'screen_protector_words': app.screen_protector_words,
                        'model_groups': app.model_groups,
                        'alias_rules': app.alias_rules,
                        'deny_model_library': app.deny_model_library,
                        'campaign_group_map': app.campaign_group_map,
                        'campaign_id_mappings': app.campaign_id_mappings,
                        'usa_model_groups': app.usa_model_groups,
                        'usa_alias_rules': app.usa_alias_rules,
                        'require_case': app.require_case,
                        'intercept_brand': app.intercept_brand,
                    }
                    disk_config = load_rules_from_file() or {}
                    for k, v in disk_config.items():
                        if k not in current_config:
                            current_config[k] = v

                    try:
                        changed_local = _write_json_atomic_if_changed(source_file, current_config)
                        label = f'店铺[{active_sid}]'
                        synced.append(label)
                        (updated if changed_local else unchanged).append(label)
                    except Exception as e:
                        errors.append(f'本地规则写入失败: {e}')

                git_res = sync_to_github(f"sync config [{active_sid}]")
                if git_res.get('ok'):
                    synced.append('GitHub')
                    if git_res.get('changed'):
                        updated.append(f"GitHub({git_res.get('commit', '')})")
                    else:
                        unchanged.append(f"GitHub({git_res.get('commit', '最新')})")
                else:
                    errors.append(git_res.get('message') or 'GitHub 推送失败')

                self._json_response({
                    'status': 'ok' if not errors else 'partial',
                    'synced': synced,
                    'errors': errors,
                    'warnings': sync_notes,
                    'file_size': os.path.getsize(source_file) if os.path.exists(source_file) else 0,
                    'updated': updated,
                    'unchanged': unchanged,
                    'git': git_res,
                    'duration_ms': round((time.perf_counter() - sync_started) * 1000, 1),
                })
            elif self.path == '/api/reload':
                with _lock:
                    ok = _hot_reload_from_disk()
                    if ok:
                        self._json_response({'status': 'ok', 'msg': 'Config reloaded from disk'})
                    else:
                        self._json_response({'status': 'error', 'msg': 'Failed to load config'}, 500)

            # ============ 实时同步 API ============
            elif self.path == '/api/sync/trigger':
                try:
                    watch_service = get_watch_service()
                    imported_count = watch_service.scan_once()
                    self._json_response({
                        'status': 'ok',
                        'imported_count': imported_count,
                    })
                except Exception as e:
                    self._json_response({'status': 'error', 'message': str(e)}, 500)

            elif self.path == '/api/sync/watch-folder':
                content_length = int(self.headers.get('Content-Length', 0) or 0)
                body = self.rfile.read(content_length).decode('utf-8') if content_length else '{}'
                try:
                    data = json.loads(body or '{}')
                except json.JSONDecodeError:
                    self._json_response({'error': 'Invalid JSON'}, 400)
                    return
                new_dir = (data.get('watch_folder') or '').strip()
                if not new_dir:
                    self._json_response({'error': 'watch_folder 不能为空'}, 400)
                    return
                # 校验目录名合法（Windows 路径）
                if not os.path.isabs(new_dir):
                    self._json_response({'error': '请填写绝对路径，如 C:\\Users\\xxx\\Desktop\\AmazonReports'}, 400)
                    return
                try:
                    watch_service = get_watch_service()
                    ok = watch_service.update_watch_dir(new_dir)
                    if ok:
                        self._json_response({
                            'status': 'ok',
                            'watch_folder': watch_service.watch_dir,
                            'message': '监控目录已更新',
                        })
                    else:
                        self._json_response({'status': 'error', 'message': '目录更新失败'}, 500)
                except Exception as e:
                    self._json_response({'status': 'error', 'message': str(e)}, 500)
            elif self.path == '/api/aba-rank/import':
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8-sig') if content_length else '{}'
                try:
                    data = json.loads(body) if body.strip() else {}
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return
                try:
                    from aba_rank_service import import_aba_and_update
                    res = import_aba_and_update(
                        source_path=data.get('source_path') or None,
                        target_path=data.get('target_path') or None,
                        file_base64=data.get('file_base64') or None,
                        file_name=data.get('file_name') or None,
                        run_excel_recalc=data.get('run_excel_recalc', True),
                    )
                    self._json_response(res)
                except Exception as e:
                    self._json_response({'error': str(e)}, 500)
            elif self.path == '/api/aba-rank/open-excel':
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8-sig') if content_length else '{}'
                try:
                    data = json.loads(body) if body.strip() else {}
                except json.JSONDecodeError:
                    data = {}
                try:
                    from aba_rank_service import DEFAULT_TARGET_PATH
                    target = Path(data.get('target_path') or DEFAULT_TARGET_PATH)
                    if not target.exists():
                        self._json_response({'error': f'文件不存在: {target}'}, 404)
                        return
                    os.startfile(str(target))
                    self._json_response({'ok': True, 'path': str(target)})
                except Exception as e:
                    self._json_response({'error': str(e)}, 500)
            # ============ ASIN 智能否定与导出 API ============
            elif self.path == '/api/asin/audit-batch':
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8-sig') if content_length else '{}'
                try:
                    data = json.loads(body) if body.strip() else {}
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return
                try:
                    import asin_audit_service
                    items = data.get('items') or []
                    country = str(data.get('country') or 'US').strip().upper()
                    mappings = data.get('campaign_id_mappings') or app.campaign_id_mappings or []
                    judged_records = asin_audit_service.audit_records_full(items, country=country, campaign_id_mappings=mappings)
                    self._json_response({'ok': True, 'records': judged_records, 'count': len(judged_records)})
                except Exception as e:
                    logger.exception(f'Error in /api/asin/audit-batch: {e}')
                    self._json_response({'error': str(e)}, 500)
            elif self.path == '/api/asin/export-folder':
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8-sig') if content_length else '{}'
                try:
                    data = json.loads(body) if body.strip() else {}
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return
                try:
                    import asin_audit_service
                    records = data.get('records') or []
                    country = str(data.get('country') or 'US').strip().upper()
                    scope = str(data.get('scope') or 'campaign').strip()
                    output_dir = data.get('output_dir') or None
                    res = asin_audit_service.export_asin_audit_folder(records, country=country, scope=scope, output_dir=output_dir)
                    self._json_response(res)
                except Exception as e:
                    logger.exception(f'Error in /api/asin/export-folder: {e}')
                    self._json_response({'error': str(e)}, 500)
            elif self.path == '/api/asin/open-folder':
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8-sig') if content_length else '{}'
                try:
                    data = json.loads(body) if body.strip() else {}
                except json.JSONDecodeError as e:
                    self._json_response({'error': f'Invalid JSON: {e}'}, 400)
                    return
                try:
                    import asin_audit_service
                    folder_path = data.get('folder_path') or ''
                    ok = asin_audit_service.open_folder_in_explorer(folder_path)
                    self._json_response({'ok': ok, 'folder_path': folder_path})
                except Exception as e:
                    logger.exception(f'Error in /api/asin/open-folder: {e}')
                    self._json_response({'error': str(e)}, 500)
            else:
                self.send_error(404)

        def _json_response(self, data, status=200):
            body = json.dumps(data, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):
            pass  # Suppress request logging

    global _ACTIVE_SERVER, _ACTIVE_FOLDER_WATCH, _ACTIVE_SERVER_THREAD
    port = args.port
    host = os.environ.get('AMZ_NEG_HOST', '127.0.0.1')
    try:
        server = ThreadingHTTPServer((host, port), RequestHandler)
    except OSError:
        server = ThreadingHTTPServer((host, 0), RequestHandler)
    with _ACTIVE_SERVER_LOCK:
        _ACTIVE_SERVER = server
        _ACTIVE_FOLDER_WATCH = None
        _ACTIVE_SERVER_THREAD = threading.current_thread()

    # 启动文件夹监控服务（实时数据同步）
    try:
        ensure_watch_dir()
        folder_watch = get_watch_service()
        folder_watch.start()
        with _ACTIVE_SERVER_LOCK:
            if _ACTIVE_SERVER is server:
                _ACTIVE_FOLDER_WATCH = folder_watch
        print(f'FolderWatchService started -> {os.environ.get("AMZ_WATCH_FOLDER", "~/Desktop/AmazonReports")}')
    except Exception as e:
        print(f'FolderWatchService 启动失败: {e}')
        folder_watch = None

    print(f'NegKeywordTool server listening on http://127.0.0.1:{port}')
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nShutting down...')
        print('Server stopped.')
    finally:
        if folder_watch:
            try:
                folder_watch.stop()
            except Exception:
                pass
        try:
            server.server_close()
        except Exception:
            pass
        with _ACTIVE_SERVER_LOCK:
            if _ACTIVE_SERVER is server:
                _ACTIVE_SERVER = None
                _ACTIVE_FOLDER_WATCH = None
                _ACTIVE_SERVER_THREAD = None


# v5.1-hotfix(2026-08-31): serve.py 之前没有 if __name__ == '__main__' 块，
# 导致 python serve.py --serve --port 19876 直接退出（看似"卡"，实际 exit 0）。
# PyInstaller EXE 因为注入入口直接调 serve_mode() 所以能起来，但 dev 模式失效。
if __name__ == '__main__':
    serve_mode()
