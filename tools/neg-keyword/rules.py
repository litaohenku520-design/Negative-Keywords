# -*- coding: utf-8 -*-
"""
默认规则配置模块
从 neg_keyword_tool.py 拆分
"""
import copy

# ============== 默认品牌否词列表 ==============
DEFAULT_DENY_BRANDS = [
    "apple", "samsung", "google", "huawei", "xiaomi", "oppo", "vivo", "oneplus",
    "motorola", "nokia", "sony", "lg", "htc", "lenovo", "asus", "blackberry",
    "pixel", "nothing phone", "fairphone", "honor", "realme",
    "anker", "otterbox", "spigen", "casetify", "mous", "rhinoshield",
    "supcase", "poetic", "ringke", "uag", "tech21", "incipio",
    "speck", "torras", "esr", "jeet", "jbl", "bose", "beats",
    "dudao", "baseus", "ugreen", "remax", "romoss", "choetech",
    "samsung", "apple", "xiaomi", "anker", "belkin", "logitech",
    "razor", "durable", "sokano", "caka", "amov", "maijue",
    "carlin", "samgree", "soucase", "jaocoo", "supcase",
    "ametan", "fintie", "moKo", "i-Blason", "Foluu", "vrs design",
    "ibay", "crazyon", "digital", "power", "battery", "charger",
    "cable", "earphone", "headphone", "smartwatch", "band",
    "ipad", "macbook", "imac", "airpods", "airtag",
    "galaxy watch", "galaxy tab", "fitbit", "garmin",
    "nintendo switch", "ps5", "xbox",
]

# ============== 默认型号否词（通用/配件） ==============
DEFAULT_DENY_MODELS = [
    "iphone 17", "iphone 17 pro", "iphone 17 pro max", "iphone 17 plus",
    "iphone 16e", "iphone 16", "iphone 16 pro", "iphone 16 pro max", "iphone 16 plus",
    "iphone 15", "iphone 15 pro", "iphone 15 pro max", "iphone 15 plus",
    "iphone 14", "iphone 14 pro", "iphone 14 pro max", "iphone 14 plus",
    "iphone 13", "iphone 13 pro", "iphone 13 pro max", "iphone 13 mini",
    "iphone 12", "iphone 12 pro", "iphone 12 pro max", "iphone 12 mini",
    "iphone 11", "iphone 11 pro", "iphone 11 pro max",
    "iphone se", "iphone xr", "iphone xs", "iphone xs max", "iphone x",
    "iphone 8", "iphone 8 plus", "iphone 7", "iphone 7 plus",
    "iphone 6", "iphone 6s", "iphone 6 plus", "iphone 6s plus",
    "samsung galaxy s25", "samsung galaxy s25+", "samsung galaxy s25 ultra",
    "samsung galaxy s24", "samsung galaxy s24+", "samsung galaxy s24 ultra",
    "samsung galaxy s23", "samsung galaxy s23+", "samsung galaxy s23 ultra",
    "samsung galaxy s22", "samsung galaxy s22+", "samsung galaxy s22 ultra",
    "samsung galaxy s21", "samsung galaxy s21+", "samsung galaxy s21 ultra",
    "samsung galaxy s20", "samsung galaxy s20+", "samsung galaxy s20 ultra",
    "samsung galaxy note 20", "samsung galaxy note 20 ultra",
    "samsung galaxy note 10", "samsung galaxy note 10+",
    "samsung galaxy a", "samsung galaxy a54", "samsung galaxy a55",
    "samsung galaxy a34", "samsung galaxy a35", "samsung galaxy a14", "samsung galaxy a15",
    "samsung galaxy z fold", "samsung galaxy z flip",
    "google pixel 9", "google pixel 9 pro", "google pixel 9 pro xl",
    "google pixel 8", "google pixel 8 pro", "google pixel 8a",
    "google pixel 7", "google pixel 7 pro", "google pixel 7a",
    "google pixel 6", "google pixel 6 pro", "google pixel 6a",
    "google pixel 5", "google pixel 4", "google pixel 4a",
    "huawei p", "huawei mate", "huawei nova",
    "xiaomi 14", "xiaomi 13", "xiaomi 12", "xiaomi 11",
    "xiaomi redmi note", "xiaomi redmi", "xiaomi poco",
    "oppo find", "oppo reno", "vivo x", "vivo v",
    "oneplus 13", "oneplus 12", "oneplus 11", "oneplus 10",
    "motorola edge", "motorola g", "motorola razr",
    "nokia g", "nokia x", "sony xperia",
    "lg velvet", "lg wing", "lg g8", "lg v60",
    "asus rog phone", "asus zenfone",
    "honor magic", "honor 200", "honor 90",
    "realme gt", "realme 12", "realme 11",
    "nothing phone 2", "nothing phone 1",
    "ipad pro", "ipad air", "ipad mini", "ipad 10th",
    "ipad 9th", "ipad 8th",
    "galaxy tab s9", "galaxy tab s8", "galaxy tab s7",
    "galaxy tab a", "galaxy tab a9", "galaxy tab a8",
    "macbook pro", "macbook air", "imac",
    "airpods pro", "airpods max", "airpods 4", "airpods 3", "airpods 2",
    "apple watch", "apple watch ultra", "apple watch series",
    "galaxy watch", "galaxy watch 6", "galaxy watch 5",
    "fitbit versa", "fitbit sense", "fitbit charge",
    "nintendo switch", "ps5", "ps5 pro", "xbox series",
    "anker 737", "anker 747", "anker powercore",
    "samsung 45w", "samsung 25w",
]

# ============== 需要保留大小写的词（不自动转小写匹配） ==============
DEFAULT_KEEP_CASE_WORDS = [
    "iPhone", "iPad", "MacBook", "iMac", "AirPods", "AirTag", "HomePod",
    "Apple Watch", "Samsung", "Galaxy", "Google", "Pixel",
    "OnePlus", "Nothing", "Fairphone", "Realme",
    "PlayStation", "Xbox", "Nintendo Switch",
    "ROG", "Zenfone", "Redmi", "Poco",
    "Beats", "Bose", "JBL", "Sonos",
    "Magsafe", "Face ID", "Touch ID",
    "USB-C", "USB C", "Type-C", "Type C", "Lightning",
    "OLED", "AMOLED", "LCD", "LED",
    "IP68", "IP67", "IPX8", "IPX7",
    "5G", "4G", "LTE", "WiFi 6", "WiFi 7", "Bluetooth 5",
    "Qi", "MagSafe",
    "A17", "A16", "A15", "A14", "A13",
    "M4", "M3", "M2", "M1",
    "Snapdragon 8", "Snapdragon 7", "Dimensity",
    "Google Fi", "Google Pay", "Apple Pay",
    "Samsung Pay", "Google Wallet",
    "AR", "VR", "MR", "AI",
    "S Pen", "Dex", "One UI",
    "iOS", "iPadOS", "macOS", "watchOS", "tvOS",
    "Android", "HarmonyOS",
    "Pro", "Pro Max", "Ultra", "Plus", "Mini", "Max",
    "SE", "XR", "XS", "XL",
    # 德语手机壳词：保留原词及常见 ASCII 写法，兼容德国站搜索词。
    "hülle", "huelle", "hulle",
    "handyhülle", "handyhuelle", "handyhulle",
    "smartphonehülle", "smartphonehuelle", "smartphonehulle",
    "schutzhülle", "schutzhulle", "schutzhülle handy",
    "klapphülle", "klapphuelle", "klapphulle",
    "lederhülle", "lederhuelle", "lederhulle",
    "etui", "tasche",
]

# ============== 默认机型组 ==============
DEFAULT_USA_MODEL_GROUPS = [
    {"name": "Samsung S26", "enabled": True, "keywords": [
        "samsung galaxy s26", "samsung s26", "galaxy s26", "s26",
        "samsung galaxy s26+", "samsung s26+", "galaxy s26+", "s26+",
        "samsung galaxy s26 ultra", "samsung s26 ultra", "galaxy s26 ultra", "s26 ultra",
    ]},
    {"name": "Samsung S25", "enabled": True, "keywords": [
        "samsung galaxy s25", "samsung s25", "galaxy s25", "s25",
        "samsung galaxy s25+", "samsung s25+", "galaxy s25+", "s25+",
        "samsung galaxy s25 ultra", "samsung s25 ultra", "galaxy s25 ultra", "s25 ultra",
    ]},
    {"name": "Samsung S24", "enabled": True, "keywords": [
        "samsung galaxy s24", "samsung s24", "galaxy s24", "s24",
        "samsung galaxy s24+", "samsung s24+", "galaxy s24+", "s24+",
        "samsung galaxy s24 ultra", "samsung s24 ultra", "galaxy s24 ultra", "s24 ultra",
    ]},
    {"name": "iPhone 17", "enabled": True, "keywords": [
        "iphone 17", "iphone 17 pro", "iphone 17 pro max",
        "iphone 17 plus", "iphone 17e",
    ]},
    {"name": "iPhone 16", "enabled": True, "keywords": [
        "iphone 16", "iphone 16 pro", "iphone 16 pro max",
        "iphone 16 plus", "iphone 16e",
    ]},
    {"name": "iPhone 15", "enabled": True, "keywords": [
        "iphone 15", "iphone 15 pro", "iphone 15 pro max",
        "iphone 15 plus",
    ]},
    {"name": "Google Pixel 10", "enabled": True, "keywords": [
        "google pixel 10", "pixel 10", "google pixel 10 pro", "pixel 10 pro",
        "google pixel 10 pro xl", "pixel 10 pro xl",
    ]},
    {"name": "Google Pixel 9", "enabled": True, "keywords": [
        "google pixel 9", "pixel 9", "google pixel 9 pro", "pixel 9 pro",
        "google pixel 9 pro xl", "pixel 9 pro xl", "google pixel 9a", "pixel 9a",
    ]},
]

# ============== 默认别名规则 ==============
DEFAULT_ALIAS_RULES = []

# ============== 屏幕保护膜相关词 ==============
DEFAULT_SCREEN_PROTECTOR_WORDS = [
    'screen protector', 'screen film', 'screen glass', 'tempered glass',
    'panzerglass', 'displayschutz', 'displayschutzfolie', 'schutzglas',
    'schutzfolie', 'film protector', 'glass protector', 'screen guard',
    'screen shield', 'screen cover', 'glas',
]


def get_default_rules():
    """获取默认规则的完整副本"""
    return {
        'deny_brands': copy.deepcopy(DEFAULT_DENY_BRANDS),
        'deny_models': copy.deepcopy(DEFAULT_DENY_MODELS),
        'keep_case_words': copy.deepcopy(DEFAULT_KEEP_CASE_WORDS),
        'model_groups': copy.deepcopy(DEFAULT_USA_MODEL_GROUPS),
        'alias_rules': copy.deepcopy(DEFAULT_ALIAS_RULES),
        'screen_protector_words': copy.deepcopy(DEFAULT_SCREEN_PROTECTOR_WORDS),
    }
