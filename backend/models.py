# -*- coding: utf-8 -*-
"""
机型数据模块 - 同义词库、机型映射表
从 neg_keyword_tool.py 拆分
"""

# ============== 机型同义词扩展库 ==============
MODEL_SYNONYMS = {
    'iphone se 2': [
        'iphone se 2', 'iphone se2', 'ipse2', 'iphone se 2020', 'se 2020',
        'iphone 2020', 'se2020',
    ],
    's25 fe': [
        's25 fe', 's25fe', 's25f', 's 25 fe', 's 25fe', 's25 f',
        'galaxy s25 fe', 'galaxy s25fe', 'galaxy s25f', 'galaxy s 25 fe',
        'samsung s25 fe', 'samsung s25fe', 'samsung s25f', 'samsung s 25 fe',
        'sm-s936', 'sm-s937', 'sm s936', 'sm s937',
        'fe 25', 'galaxy fe 2025', 'samsung fe 2025',
        's25fe case', 's25 fe case', 'for s25 fe', 'fit s25 fe',
    ],
    's24': [
        's24', 's 24', 'galaxy s24', 'samsung s24',
        'galaxy 24', 'samsung galaxy 24', '24',
        'sm-s921', 'sm-s922', 'sm-s926', 'sm s921', 'sm s922', 'sm s926',
        's24 ultra', 's24+', 's24 plus', 'galaxy s24 ultra',
        's24fe', 's24 fe', 'galaxy s24 fe',
    ],
    'a55': [
        'a55', 'a 55', 'galaxy a55', 'samsung a55',
        'sm-a556', 'sm-a557', 'sm a556', 'sm a557',
        'a55 case', 'a55壳', 'for a55',
    ],
    'a35': [
        'a35', 'a 35', 'galaxy a35', 'samsung a35',
        'sm-a356', 'sm a356',
    ],
    's23': [
        's23', 's 23', 'galaxy s23', 'samsung s23',
        'sm-s911', 'sm-s912', 'sm s911', 'sm s912',
    ],
    's22': [
        's22', 's 22', 'galaxy s22', 'samsung s22',
        'sm-s911', 'sm-s906', 'sm s911', 'sm s906',
    ],
    'xs max': [
        'xs max', 'xsmax', 'x s max', 'iphone xs max', 'iphonexsmax',
        'i phone xs max', 'iphone x s max', 'iphone 10 max', 'iphone10max',
        'apple xs max', 'applexsmax', 'apple iphone xs max',
        '10 max', '10s max', 'iphone 10s max',
        'x max', 'iphone x max',
    ],
    'xs': [
        'xs', 'x s', 'iphone xs', 'iphonexs',
        'i phone xs', 'iphone 10s', 'iphone10s',
        'apple xs', 'iphne xs',
    ],
    'ipx': [
        'iphone x', 'iphonex', 'i phone x', 'apple iphone x',
        'iphone 10', 'iphone10', 'ipx',
    ],
    '16e': [
        '16e', '16 e', 'iphone 16e', 'iphone16e', 'i phone 16e',
        'apple 16e', 'apple iphone 16e', 'iphone 16 e',
    ],
    '17e': [
        '17e', '17 e', 'iphone 17e', 'iphone17e', 'i phone 17e',
        'apple 17e', 'apple iphone 17e', 'iphone 17 e',
        'e17', 'e 17',
    ],
    'iphone air': [
        'iphone air', 'iphoneair', 'apple air', 'apple iphone air',
        'i phone air', 'iphone 17 air', 'iphone17air',
    ],
}

# ============== iPhone 机型映射表 ==============
IPHONE_MODEL_MAP = {
    'iphone xr': 'ipxr',
    'iphone x': 'ipx',
    'iphone xs': 'ipxs',
    'iphone xs max': 'ipxsmax',
    'iphone se': 'ipse',
    'iphone se 2022': 'ipse2022',
    'iphone se 3': 'ipse3',
    'iphone 11 pro max': 'ip11promax',
    'iphone 11 pro': 'ip11pro',
    'iphone 11': 'ip11',
    'iphone 12 mini': 'ip12mini',
    'iphone 12': 'ip12',
    'iphone 12 pro max': 'ip12promax',
    'iphone 12 pro': 'ip12pro',
    'iphone 13 mini': 'ip13mini',
    'iphone 13': 'ip13',
    'iphone 13 pro max': 'ip13promax',
    'iphone 13 pro': 'ip13pro',
    'iphone 14': 'ip14',
    'iphone 14 plus': 'ip14plus',
    'iphone 14 pro max': 'ip14promax',
    'iphone 14 pro': 'ip14pro',
    'iphone 15': 'ip15',
    'iphone 15 plus': 'ip15plus',
    'iphone 15 pro max': 'ip15promax',
    'iphone 15 pro': 'ip15pro',
    'iphone 16': 'ip16',
    'iphone 16 plus': 'ip16plus',
    'iphone 16 pro max': 'ip16promax',
    'iphone 16 pro': 'ip16pro',
    'iphone 16e': 'ip16e',
    'iphone 17': 'ip17',
    'iphone 17 plus': 'ip17plus',
    'iphone 17 pro max': 'ip17promax',
    'iphone 17 pro': 'ip17pro',
    'iphone 17e': 'ip17e',
}

# ============== Google Pixel 机型映射表 ==============
PIXEL_MODEL_MAP = {
    'pixel 6 pro': 'pixel6pro',
    'pixel 6': 'pixel6',
    'pixel 6a': 'pixel6a',
    'pixel 7 pro': 'pixel7pro',
    'pixel 7': 'pixel7',
    'pixel 7a': 'pixel7a',
    'pixel 8 pro': 'pixel8pro',
    'pixel 8': 'pixel8',
    'pixel 8a': 'pixel8a',
    'pixel 9 pro xl': 'pixel9proxl',
    'pixel 9 pro': 'pixel9pro',
    'pixel 9': 'pixel9',
    'pixel 9a': 'pixel9a',
    'pixel 10 pro': 'pixel10pro',
    'pixel 10': 'pixel10',
}


def get_model_synonyms(model_name):
    """获取一个机型的所有同义词"""
    return MODEL_SYNONYMS.get(model_name, [])


def get_all_model_synonyms():
    """获取所有机型的同义词（扁平化）"""
    result = {}
    for key, synonyms in MODEL_SYNONYMS.items():
        for syn in synonyms:
            result[syn] = key
    return result


def lookup_model_variant(model_name):
    """在IPHONE_MODEL_MAP和PIXEL_MODEL_MAP中查找机型变体"""
    name = model_name.lower().strip()
    if name in IPHONE_MODEL_MAP:
        return IPHONE_MODEL_MAP[name]
    if name in PIXEL_MODEL_MAP:
        return PIXEL_MODEL_MAP[name]
    return None