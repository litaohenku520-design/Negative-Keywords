# -*- coding: utf-8 -*-
"""
统一日志系统
=============
提供结构化日志记录、错误监控、日志轮转。
支持控制台输出、文件记录、HTTP 上报。
"""
import os
import sys
import json
import logging
import traceback
import threading
from datetime import datetime
from pathlib import Path
from logging.handlers import RotatingFileHandler

# 日志目录
LOG_DIR = Path(__file__).parent.parent / 'logs'
LOG_DIR.mkdir(parents=True, exist_ok=True)

# 日志级别
LOG_LEVELS = {
    'debug': logging.DEBUG,
    'info': logging.INFO,
    'warning': logging.WARNING,
    'error': logging.ERROR,
    'critical': logging.CRITICAL,
}

# 内存中的最近日志（供前端 /api/logs 查询）
_recent_logs = []
_recent_logs_lock = threading.Lock()
MAX_RECENT_LOGS = 500


class StructuredFormatter(logging.Formatter):
    """结构化日志格式化器（JSON 格式）"""

    def format(self, record):
        log_entry = {
            'timestamp': datetime.fromtimestamp(record.created).isoformat(),
            'level': record.levelname.lower(),
            'logger': record.name,
            'message': record.getMessage(),
            'module': record.module,
            'line': record.lineno,
        }
        if record.exc_info and record.exc_info[0]:
            log_entry['exception'] = {
                'type': record.exc_info[0].__name__,
                'message': str(record.exc_info[1]),
                'traceback': traceback.format_exception(*record.exc_info),
            }
        # 添加自定义字段
        if hasattr(record, 'extra_fields'):
            log_entry.update(record.extra_fields)
        return json.dumps(log_entry, ensure_ascii=False)


class RecentLogHandler(logging.Handler):
    """内存日志处理器（供前端查询）"""

    def emit(self, record):
        try:
            log_entry = {
                'timestamp': datetime.fromtimestamp(record.created).isoformat(),
                'level': record.levelname.lower(),
                'logger': record.name,
                'message': record.getMessage(),
                'module': record.module,
                'line': record.lineno,
            }
            if record.exc_info and record.exc_info[0]:
                log_entry['exception'] = str(record.exc_info[1])
            with _recent_logs_lock:
                _recent_logs.append(log_entry)
                if len(_recent_logs) > MAX_RECENT_LOGS:
                    _recent_logs.pop(0)
        except Exception:
            pass


def setup_logger(name: str = 'erp', level: str = 'info') -> logging.Logger:
    """设置并返回命名日志器"""
    logger = logging.getLogger(name)
    logger.setLevel(LOG_LEVELS.get(level, logging.INFO))

    # 避免重复添加处理器
    if logger.handlers:
        return logger

    # 控制台输出（人类可读）
    console_handler = logging.StreamHandler(sys.stdout)
    console_format = '%(asctime)s [%(levelname)s] %(name)s: %(message)s'
    console_handler.setFormatter(logging.Formatter(console_format, datefmt='%H:%M:%S'))
    logger.addHandler(console_handler)

    # 文件日志（结构化 JSON）
    file_handler = RotatingFileHandler(
        LOG_DIR / f'{name}.log',
        maxBytes=10 * 1024 * 1024,  # 10MB
        backupCount=5,
        encoding='utf-8',
    )
    file_handler.setFormatter(StructuredFormatter())
    logger.addHandler(file_handler)

    # 错误日志单独文件
    error_handler = RotatingFileHandler(
        LOG_DIR / f'{name}_error.log',
        maxBytes=10 * 1024 * 1024,
        backupCount=3,
        encoding='utf-8',
    )
    error_handler.setLevel(logging.WARNING)
    error_handler.setFormatter(StructuredFormatter())
    logger.addHandler(error_handler)

    # 内存日志（供前端查询）
    recent_handler = RecentLogHandler()
    recent_handler.setLevel(logging.INFO)
    logger.addHandler(recent_handler)

    return logger


# 创建默认日志器 - v4.1.6 修复: PyInstaller frozen 模式下 _MEIPASS 是只读临时目录,
# RotatingFileHandler 会失败导致 setup_logger 抛错, 整个 logger 模块没法完成初始化
# 解决: 失败时 fallback 到简单的 console-only logger
try:
    logger = setup_logger()
except Exception:
    import traceback as _tb
    sys.stderr.write(f'[logger] setup_logger failed: {_tb.format_exc()}\n')
    sys.stderr.flush()
    # Fallback: 简单 logger, 只输出到 stderr
    logger = logging.getLogger('erp')
    logger.setLevel(logging.INFO)
    if not logger.handlers:
        _h = logging.StreamHandler(sys.stderr)
        _h.setFormatter(logging.Formatter('%(asctime)s [%(levelname)s] %(name)s: %(message)s'))
        logger.addHandler(_h)


def get_recent_logs(level: str = None, limit: int = 100) -> list:
    """获取最近的日志"""
    with _recent_logs_lock:
        logs = list(_recent_logs)
    if level:
        logs = [l for l in logs if l['level'] == level.lower()]
    return logs[-limit:]


def log_with_fields(logger_instance, level: str, message: str, **fields):
    """记录带额外字段的日志"""
    record = logging.LogRecord(
        name=logger_instance.name,
        level=LOG_LEVELS.get(level, logging.INFO),
        pathname=__file__,
        lineno=0,
        msg=message,
        args=None,
        exc_info=None,
    )
    record.extra_fields = fields
    logger_instance.handle(record)


# ============ 前端错误上报 ============

class FrontendErrorReporter:
    """前端错误上报处理器"""

    def __init__(self):
        self.errors = []
        self._lock = threading.Lock()

    def report(self, error_data: dict) -> dict:
        """上报前端错误"""
        error_entry = {
            'timestamp': datetime.now().isoformat(),
            'type': error_data.get('type', 'unknown'),
            'message': error_data.get('message', ''),
            'stack': error_data.get('stack', ''),
            'url': error_data.get('url', ''),
            'userAgent': error_data.get('userAgent', ''),
        }
        with self._lock:
            self.errors.append(error_entry)
            if len(self.errors) > 200:
                self.errors.pop(0)

        # 记录到日志文件
        logger.error(f"前端错误: {error_entry['message']}")
        log_with_fields(logger, 'error', f"前端错误: {error_entry['message']}",
                       error_type=error_entry['type'],
                       error_url=error_entry['url'])

        return {'status': 'received', 'id': len(self.errors)}

    def get_errors(self, limit: int = 50) -> list:
        """获取最近的错误"""
        with self._lock:
            return list(self.errors)[-limit:]


# 全局错误上报器
frontend_error_reporter = FrontendErrorReporter()