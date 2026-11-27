# -*- coding: utf-8 -*-
"""
配置管理模块 - 配置文件路径、加载/保存
从 neg_keyword_tool.py 拆分
"""
import os
import sys
import json
import shutil


def get_config_dir():
    """获取独立插件配置目录（默认即本插件 backend/ 目录，可通过 NEG_PLUGIN_CONFIG_DIR 覆盖）。"""
    env_dir = os.environ.get('NEG_PLUGIN_CONFIG_DIR', '').strip()
    if env_dir:
        os.makedirs(env_dir, exist_ok=True)
        return env_dir
    return os.path.dirname(os.path.abspath(__file__))


def load_rules_from_file():
    """从配置文件加载规则"""
    config_path = os.path.join(get_config_dir(), 'rules_config.json')
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r', encoding='utf-8-sig') as f:
                return json.load(f)
        except Exception as e:
            print(f"加载规则配置失败: {e}")
    return None


def save_rules_to_file(rules_dict):
    """保存规则到配置文件"""
    config_path = os.path.join(get_config_dir(), 'rules_config.json')
    try:
        with open(config_path, 'w', encoding='utf-8') as f:
            json.dump(rules_dict, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"保存规则配置失败: {e}")
        return False


def load_api_config():
    """从配置文件加载 API 配置"""
    config_file = os.path.join(get_config_dir(), 'api_config.json')
    if os.path.exists(config_file):
        try:
            with open(config_file, 'r', encoding='utf-8') as f:
                config = json.load(f)
                return config.get('secret_id', ''), config.get('secret_key', '')
        except Exception as e:
            print(f"加载API配置失败: {e}")
    return '', ''


def save_api_config(secret_id, secret_key):
    """保存 API 配置到配置文件"""
    config_file = os.path.join(get_config_dir(), 'api_config.json')
    try:
        config = {'secret_id': secret_id, 'secret_key': secret_key}
        with open(config_file, 'w', encoding='utf-8') as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"保存API配置失败: {e}")
        return False
