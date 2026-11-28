# -*- coding: utf-8 -*-
"""
关键词标准化预处理模块
从 neg_keyword_tool.py 拆分
"""
import re


def normalize_keyword(keyword):
    """
    标准化关键词预处理
    - 统一去除非字母数字/空格之外的字符（保留 Unicode 字母，不能破坏德语/法语等站点词）
    - 去除多余空格
    - 转小写（保留特殊词不转）
    - 去掉字母数字之间的点号（如 s.23 -> s23）

    v3.1-rc2 fix: 拆开 `<base><sku_typo>` 无空格拼接
    - Excel 报告 a15case/s23case/a17case/ph.case s25+/samsung s25case/
      pixel 10case/wtcase for google pixel xl 等 20+ 个 bug 都属于此类
    - 原匹配逻辑用 `(?:\s)<base>(?:\s|$)` 单词边界，要求 base 后必须是空格或结束
    - 修复：在归一化阶段把 `<数字><typo>` 拼接形式插空格，让后续 match 正常
    - 限定为数字+typo 拼接（避免 suitcase/educase 等日常英文词误伤）
    """
    if not keyword:
        return ""
    # 转小写
    kw = keyword.lower().strip()
    # 统一 Unicode 空白为空格
    kw = re.sub(r'[\u00a0\u200b\u200c\u200d\ufeff\xa0]', ' ', kw)
    # 去除特殊字符，保留所有 Unicode 字母/数字、空白和报告中常见的分隔符。
    # 旧实现只允许 [a-z0-9]，会把德语 "hülle" 的 "ü" 替换为空格，
    # 使后端看不到壳类词，随后又被 "schutzfolie" 误判为仅屏幕保护膜词。
    # 不使用 ASCII 化；需要 ASCII 变体时由 matching.py 的 umlaut 逻辑统一处理。
    kw = ''.join(
        ch if (ch.isalnum() or ch.isspace() or ch in '-+./') else ' '
        for ch in kw
    )

    # === v3.1-rc2 fix: 点号删除只针对字母↔数字边界，避免 ph.case 被误删 ===
    # 原规则：删除字母/数字↔字母/数字间点号（如 s.23 -> s23）
    # 新规则：只删字母↔数字 或 数字↔字母，保留字母↔字母 点号（ph.case -> ph.case）
    kw = re.sub(r'([a-z])\s*\.\s*([0-9])', r'\1\2', kw)
    kw = re.sub(r'([0-9])\s*\.\s*([a-z])', r'\1\2', kw)

    # === v3.1-rc2 fix: 拆开 `<base><case_typo>` 无空格拼接 ===
    # 数字 + case 类 typo/变体 (a15case -> a15 case, s23case -> s23 case, pixel10case -> pixel10 case)
    # 限定为数字结尾的前缀 + 标准 case 词族，0 风险（不会误伤 suitcase/educase）
    kw = re.sub(r'([a-z]?\d+)(case|cage|csae|cesa|csse|wtcase|phonecase|ultracase)\b', r'\1 \2', kw)

    # 已知 SKU 前缀(phone/ultra/wallet/cell 等) + case (phonecase -> phone case, ultracase -> ultra case)
    # 白名单前缀避免 briefcase/suitcase 等日常英文词误伤
    # 注意使用 (?:...) 非捕获组，避免 \1/\2 编号错位
    _sku_case_prefixes = r'(?:phone|ultra|wallet|cell|uv|smart|leather|mirror|magnetic|folio)'
    kw = re.sub(r'\b(' + _sku_case_prefixes + r')(case)\b', r'\1 \2', kw)

    # 字母短前缀(1-2字符) + case 类 typo (wtcase -> wt case, phcase -> ph case)
    # 限定 1-2 字母前缀避免 educase/briefcase/casebook 等日常英文词误伤
    kw = re.sub(r'\b([a-z]{1,2})(case|cage|csse|csae)\b', r'\1 \2', kw)

    # 型号变体词 + case 粘连拆分 (maxcase -> max case, procase -> pro case)
    # 修复: "iphone 14 pro maxcase and screen protector" 中 maxcase 的 case
    # 因词边界(\bcase\b)匹配不到而漏识别壳类词, 导致被误判"仅屏幕保护膜词"误否。
    # 长词优先(promax 先于 max), 仅拆明确的型号变体词, 避免误伤 suitcase/briefcase。
    kw = re.sub(r'\b(promax|max|pro|plus|ultra|mini)(case|cover|cage|csae|cesa|csse|wtcase|phonecase)\b', r'\1 \2', kw)

    # 字母 + 点 + case 类 typo (ph.case -> ph case)
    kw = re.sub(r'\b([a-z]+)\s*\.\s*(case|cage|csae|cesa|csse|wtcase)\b', r'\1 \2', kw)

    # 合并连续空格
    kw = re.sub(r'\s+', ' ', kw).strip()
    return kw


def _keep_case_word_match(word, normalized_keyword):
    """检查原始大小写词是否匹配（大小写敏感）"""
    return word.lower() in normalized_keyword


def normalize_model_for_comparison(model):
    """
    标准化机型名称用于比较
    - 去空格、去分隔符、去品牌前缀
    """
    m = model.lower().strip()
    # 去除常见分隔符
    m = re.sub(r'[\s\-_\.]', '', m)
    # 去除品牌前缀
    for prefix in ['samsung', 'galaxy', 'google', 'pixel']:
        if m.startswith(prefix):
            m = m[len(prefix):]
            break
    return m


def models_match(model1, model2):
    """判断两个机型名称是否匹配（考虑各种变体）"""
    m1 = normalize_model_for_comparison(model1)
    m2 = normalize_model_for_comparison(model2)
    if m1 == m2:
        return True
    # 检查是否一个包含另一个（如 s24+ vs s24plus）
    if m1 in m2 or m2 in m1:
        return True
    return False


def extract_base_model(model):
    """提取基础机型名称（去掉后缀 Pro/Max/Ultra/+ 等）"""
    m = model.lower().strip()
    # 去掉后缀
    m = re.sub(r'\s*(pro|max|ultra|plus|mini|fe|se)\s*$', '', m).strip()
    # 去掉尾部的 +
    m = re.sub(r'\s*\+$', '', m).strip()
    return m


def extract_base_models_list(model):
    """
    提取机型的所有可能基础变体列表
    例如 "iphone 15 pro max" → ["iphone 15 pro max", "iphone 15 pro", "iphone 15"]
    注意：不会返回纯数字的裸 base 名（如 "15"），避免错配
    """
    m = model.lower().strip()
    variants = [m]
    # 逐步去掉后缀
    current = m
    for suffix in ['pro max', 'ultra', 'pro', 'max', 'plus', 'mini', 'fe', 'se']:
        new = re.sub(r'\s*' + re.escape(suffix) + r'\s*$', '', current).strip()
        if new != current:
            variants.append(new)
            current = new
    # 去掉尾部的 +
    if current.endswith('+'):
        current = current[:-1].strip()
        variants.append(current)

    # ═══ 后缀保护：过滤掉纯数字或过短的裸 base 名 ═══
    # 避免 "iphone 15" → "15" 这种错配
    protected = []
    for v in variants:
        # 去掉品牌前缀后检查是否是纯数字或太短
        stripped = re.sub(r'^(iphone|samsung|galaxy|google|pixel|huawei|xiaomi|oppo|vivo|oneplus|motorola|nokia|sony|lg|htc|asus|honor|realme|nothing)\s+', '', v)
        if re.match(r'^\d+$', stripped):
            continue  # 跳过纯数字裸 base 名
        if len(stripped) < 2:
            continue  # 跳过过短的 base 名
        protected.append(v)

    return protected if protected else variants


def _is_pure_digit_keyword(keyword):
    """检查关键词是否纯数字（如 '14', '15', '16'）"""
    return bool(re.match(r'^\d+$', keyword.strip()))


def keyword_contains_model(keyword, model):
    """
    检查关键词中是否包含某个机型
    不包含纯数字匹配（避免误匹配）
    """
    if _is_pure_digit_keyword(model):
        return False
    return model in keyword


def _normalize_kw_for_samsung(norm_kw):
    """Samsung 机型特殊处理：s25 → s25, s24 → s24"""
    # Samsung 机型通常是 s + 数字
    m = re.search(r'(?:^|\s)(s\d+[a-z]*)(?:\s|$)', norm_kw)
    if m:
        return m.group(1)
    return norm_kw


def _normalize_kw_for_note(norm_kw):
    """Note 机型特殊处理"""
    # note 数字 → note数字
    kw = re.sub(r'note\s+(\d+)', r'note\1', norm_kw)
    return kw


# ═══ Bug2 fix: SKU 类型后缀守卫（v3.1-rc）═══════════════════════════════════════
# 第二级匹配（机型名包含关键词反向 / 关键词包含机型名正向）时，必须保证两侧
# 的 SKU 类型后缀（case/cover/壳/保护套/folio/bumper 等）对齐，否则视为不匹配，
# 防止裸 base 名 "iPhone 16e" 误命中带 SKU 后缀的 base_model（如 "iPhone 16e Case"）。
SKU_TYPE_SUFFIXES = (
    " case", " cases", " cover", " covers", "壳", "保护套", "外壳",
    " folio", " bumper", " sleeve", " pouch", " wallet",
    " skin", " wrap", " shield", " armor",
)


def _has_sku_type_token(s):
    """简单判断 s 是否含有 SKU 类型后缀"""
    if not s:
        return False
    t = " " + s.lower().strip() + " "
    for suf in SKU_TYPE_SUFFIXES:
        if suf in t:
            return True
    # 单词边界匹配（避免 'case' 在 'suitcase'/'casebook' 中误判）
    for w in ("case", "cover", "folio", "bumper", "sleeve", "pouch",
              "wallet", "skin", "wrap", "shield", "armor"):
        if re.search(r"\b" + re.escape(w) + r"s?\b", t):
            return True
    return False


def _keyword_matches_single_model(keyword, base_model):
    """
    检查单个标准化关键词是否匹配某个机型基础名
    返回匹配类型：'exact', 'prefix', 'contains', None
    """
    kw = keyword.lower().strip()
    bm = base_model.lower().strip()

    # 精确匹配
    if kw == bm:
        return 'exact'

    # ═══ Bug2 fix: 关键词包含机型名（正向 contains）需对齐 SKU 后缀 ═══
    # 如 "iphone 15 case" 包含 "iphone 15" — 双向有 case → 通过；
    # 若只 kw 有 case 而 bm 不带 → 也通过（kw 暗示了"我想要带 case 的产品"）；
    # 若只 bm 有 case 而 kw 不带 → 不通过（裸 base 命中了带 SKU 类型的型号）。
    pattern = re.compile(r'(?:^|\s)' + re.escape(bm) + r'(?:\s|$)')
    if pattern.search(kw):
        kw_has_sku = _has_sku_type_token(kw)
        bm_has_sku = _has_sku_type_token(bm)
        if not (bm_has_sku and not kw_has_sku):
            return 'contains'

    # ═══ Bug2 fix: 机型名包含关键词（反向 prefix）需对齐 SKU 后缀 ═══
    # 防止裸 base "iphone 16e" 反向 prefix 命中带 SKU 后缀的 base_model "iphone 16e case"。
    pattern2 = re.compile(r'(?:^|\s)' + re.escape(kw) + r'(?:\s|$)')
    if pattern2.search(bm):
        kw_has_sku = _has_sku_type_token(kw)
        bm_has_sku = _has_sku_type_token(bm)
        if not (bm_has_sku and not kw_has_sku):
            return 'prefix'

    return None
