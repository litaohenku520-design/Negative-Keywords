# -*- coding: utf-8 -*-
"""
否词工具 - 机型匹配模块
"""
import re
from typing import Optional, List, Dict, Tuple


# ═══ 站点路由表（v3.1-rc fix）═══════════════════════════════════════════════
# Bug1 修复：marketplace 路由下沉到 matching 层，避免 serve.py 端误把 EU 站按 USA 处理
USA_MARKETPLACES = frozenset({"usa", "us", "us.com"})
EU_MARKETPLACES = frozenset({"uk", "de", "fr", "it", "es", "nl", "pl", "se", "gb",
                              "deutschland", "france", "italia", "espana", "nederland"})


def is_de_base_model_deny_exception(marketplace: Optional[str], target_group: str, deny_keyword: str) -> bool:
    """Germany-only compatibility exceptions for selected base-model campaigns.

    The normal matcher already recognizes these exact model spellings against
    their base-model campaigns. The shared deny library also contains the same
    spellings as cross-model negatives, so exempt only those precise deny
    tokens for the corresponding DE target. Never strip a trailing e
    globally or allow one model's suffix against another model.
    """
    site = re.sub("[^a-z0-9]+", "", str(marketplace or "").lower())
    if site not in {"de", "deutschland", "germany", "amazonde"}:
        return False

    compact = lambda value: re.sub("[^a-z0-9]+", "", str(value or "").lower())
    target = compact(target_group)
    keyword = compact(deny_keyword)
    exceptions = {
        "samsunggalaxys10": {"s10e"},
        "s10": {"s10e"},
        "iphone16": {"iphone16e", "ip16e", "16e"},
        "ip16": {"iphone16e", "ip16e", "16e"},
        "iphone17": {"iphone17e", "ip17e", "17e"},
        "ip17": {"iphone17e", "ip17e", "17e"},
    }
    return keyword in exceptions.get(target, set())


# SKU 类型后缀 token 集合（用于 Bug1/Bug2 的 SKU 后缀守卫）
# 命中机身组的关键词如果缺这些后缀，可能命中带 case SKU 类型的组，应被截停
# v3.1-rc3: 扩展多语言 (de/fr/es/it/pt) 解决 86.5% 误判 (hülle/klapphülle/handyhülle 等)
SKU_TYPE_TOKENS = frozenset({
    # 英文
    "case", "cover", "folio", "bumper", "sleeve", "pouch", "wallet",
    "skin", "wrap", "shield", "armor", "shell", "holder",
    # 中文
    "壳", "保护套", "外壳", "手机壳", "硅胶套",
    # 德语 (de) - 亚马逊欧洲主力市场
    "hülle", "huelle", "klapphülle", "klapphuelle", "klappe",
    "handyhülle", "handyhuelle", "smartphonehülle", "smartphonehuelle",
    "etui", "tasche", "booklet", "bookstyle", "lederhülle", "lederhuelle",
    # 法语 (fr)
    "coque", "housse", "étui", "etui", "portefeuille",
    # 西语 (es)
    "funda", "carcasa", "estuche", "funda", "cartera",
    # 意语 (it)
    "custodia", "fodero", "astuccio", " portafoglio",
    # 葡语 (pt)
    "capa", "estojo", "carteira",
})

# v3.1-rc2 fix: typo/变体也属于 SKU 类型 token（Excel 修复点）
# v3.1-rc3: 扩展多语言 typo（德语 klappehülle 拼写错误, 法语 coq/coc 等）
SKU_TYPE_TYPOS = frozenset({
    # 英文 typo
    "cesa", "csse", "csae", "cage", "wtcase", "funda",
    # 德语 typo (常见)
    "hule", "hül", "klapphul", "klapphulle", "hüllle",
    "handyhule", "smartphonehul", "etuy",
    # 法语 typo
    "coq", "coc", "hous", "etuy",
})


def _normalize_umlaut(s: str) -> str:
    """规范化德语变音符号为稳定的 ASCII 写法（hülle → huelle）。

    直接使用 NFKD + ASCII ignore 会把 ``ü`` 丢掉，得到 ``hulle``；
    虽然旧词库碰巧兼容了该结果，但它不是德语标准转写，也会让不同
    匹配路径产生不一致。这里先显式转写，再做 NFKD，保留 huelle 作为
    主别名，同时继续由词库兼容历史的 hulle 写法。
    """
    import unicodedata
    translated = s.translate(str.maketrans({
        'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue',
        'ß': 'ss',
    }))
    return unicodedata.normalize('NFKD', translated).encode('ascii', 'ignore').decode('ascii').lower()


def _kw_has_sku_type_token(keyword: str) -> bool:
    """检查搜索词是否包含 SKU 类型后缀 token（case/cover/壳/hülle 等）

    v3.1-rc2 扩展:
      - typo/变体识别 (cesa/csse/csae/cage/wtcase) 按单词边界匹配
      - "fu nda"/"fund a" 等带空格的 typo 用 fuzzy 模式识别

    v3.1-rc3 扩展 (2026-09-04):
      - 多语言 SKU tokens (de/fr/es/it/pt) 解决 86.5% 误判
      - umlaut 规范化 (hülle → huelle) 用 NFKD
    """
    if not keyword:
        return False
    norm = " " + re.sub(r"\s+", " ", keyword.lower().strip()) + " "
    norm_ascii = " " + re.sub(r"\s+", " ", _normalize_umlaut(keyword)) + " "
    # 多字 token 优先（"保护套"/"外壳"/"硅胶套"/"手机壳"等）
    for tok in ("保护套", "外壳", "硅胶套", "手机壳"):
        if tok in norm:
            return True
    # 中文单字"壳"按字符包含
    if "壳" in keyword:
        return True
    # 标准 SKU token（单词边界匹配，避免 suitcase/casebook 误判）
    for tok in ("case", "cover", "folio", "bumper", "sleeve", "pouch",
                "wallet", "skin", "wrap", "shield", "armor", "shell", "holder"):
        if re.search(r"\b" + re.escape(tok) + r"\b", norm):
            return True
    # v3.1-rc3: 多语言 token (de/fr/es/it/pt) - 同时匹配原 umlaut 与 ASCII 规范
    multilang_tokens = (
        # 德语
        "hülle", "huelle", "hulle", "klapphülle", "handyhülle", "smartphonehülle", "etui", "tasche",
        "booklet", "bookstyle", "lederhülle", "klappe",
        # 法语
        "coque", "housse", "étui",
        # 西语
        "funda", "carcasa", "estuche",
        # 意语
        "custodia", "fodero", "astuccio",
        # 葡语
        "capa", "estojo",
    )
    for tok in multilang_tokens:
        # 原 umlaut 匹配 (hülle 也能匹配 hülle)
        if re.search(r"\b" + re.escape(tok) + r"\b", norm, re.IGNORECASE):
            return True
        # ASCII 规范化匹配 (hülle → huelle 也能匹配)
        tok_ascii = _normalize_umlaut(tok)
        if re.search(r"\b" + re.escape(tok_ascii) + r"\b", norm_ascii, re.IGNORECASE):
            return True
    # v3.1-rc2: typo/变体（单词边界）
    for typo in SKU_TYPE_TYPOS:
        if re.search(r"\b" + re.escape(typo) + r"\b", norm):
            return True
    # v3.1-rc2: 带空格的 typo（"fu nda"/"fund a"/"fun da"）fuzzy 识别
    # 字母 c.a.s.e 任意位置夹空格或点的模糊匹配（如 "c ase", "ca se", "c.ase"）
    # 限定：去除空白和点后字符 ≤ 6（防止 suitcase/showcase/briefcase 等长词误伤）
    kw_strip = re.sub(r"[\s\.]+", "", keyword.lower())
    # c+a+s+e 紧凑模式（要求相邻字符不超过 1 个分隔符）
    if (re.search(r"\bc[\W_]?a[\W_]?s[\W_]?e\b", keyword.lower())
            and len(kw_strip) <= 6):
        return True
    # fu nda / fund a / funda 模糊匹配（限定 ≤ 6 字符）
    if re.search(r"\bf[\W_]?u[\W_]?n[\W_]?d[\W_]?a\b", keyword.lower()) and len(kw_strip) <= 6:
        return True
    # cage 紧凑 typo（c+a+g+e ≤ 5 字符）
    if re.search(r"\bc[\W_]?a[\W_]?g[\W_]?e\b", keyword.lower()) and len(kw_strip) <= 5:
        return True
    # v3.1-rc3: hülle 紧凑 fuzzy (h+u+l+l+e 含 umlaut 规范化)
    if re.search(r"\bh[\W_]?u[\W_]?l[\W_]?l[\W_]?e\b", norm_ascii) and len(kw_strip) <= 6:
        return True
    return False


def _group_has_sku_type_token(group: Dict) -> bool:
    """判断一个 SKU 组的名称/关键词是否暗示了 SKU 类型（case/cover/壳）"""
    if not group:
        return False
    name = (group.get("name", "") or "").lower()
    if _kw_has_sku_type_token(name):
        return True
    for gk in group.get("keywords", []) or []:
        if _kw_has_sku_type_token(gk):
            return True
    return False


# ═══ 匹配索引 ═══════════════════════════════════════════════════════════════
# 否词分类是高频操作，机型组/拓词/别名配置却是低频变化数据。旧实现会在
# 每条搜索词上重复扫描全部拓词、重新排序机型组并编译正则，数据量变大后
# 近似按「搜索词数 × 全部拓词数」增长。这里把静态计算预编译成索引。
_MATCH_TOKEN_RE = re.compile(r'[a-z0-9üäöß]+')
_MATCH_SKU_WORDS = frozenset({
    'hulle', 'huelle', 'case', 'cover', 'ke', 'baohutao', 'waitao',
    'foli', 'folio', 'bumper', 'sleeve', 'pouch', 'wallet', 'skin',
    'wrap', 'shield', 'armor', 'funda', 'coque', 'klappe',
})
_MATCH_MODEL_VARIANTS = frozenset({'lite', 'pro', 'plus', 'ultra', 'xl', 'max', 'fe', 'mini', 'e', 'edge'})
_MATCH_VARIANT_SUFFIX_RE = re.compile(r'\s*(pro\s*max|promax|pro|max|plus|ultra|mini|fe|edge|xl|air|5g|4g|\be)\s*$')


def _match_group_name_key(name: str) -> str:
    # Campaign 映射常用 `REVVL/V+`，机型组名称可能写成 `REVVL V+`。
    # 两者是同一个业务机型，匹配键应忽略空格和斜杠，否则映射已命中但
    # find_matching_group_in_target 仍拿不到目标组，随后会把词误判为否定。
    return re.sub(r'[\s/]+', '', (name or '').lower()).replace('_deny', '').replace('-deny', '')


def _match_group_variant_key(name: str) -> str:
    stripped = _MATCH_VARIANT_SUFFIX_RE.sub('', (name or '').lower().strip())
    return _match_group_name_key(stripped)


class _PreparedKeyword:
    """一个已经预处理的机型拓词。"""

    __slots__ = ('raw', 'lower', 'word_re', 'prefix_re', 'nospace', 'valid_tokens', 'has_plus')

    def __init__(self, raw: str):
        self.raw = raw
        self.lower = raw.lower().strip()
        self.word_re = re.compile(r'\b' + re.escape(self.lower) + r'\b')
        self.prefix_re = re.compile(r'\b' + re.escape(self.lower))
        self.nospace = re.sub(r'\s+', '', self.lower)
        tokens = self.lower.split()
        self.valid_tokens = tuple(t for t in tokens if t and (len(t) >= 2 or t.isdigit()))
        self.has_plus = '+' in self.lower


class _PreparedGroup:
    """一个机型组的静态匹配信息。"""

    __slots__ = ('group', 'name', 'enabled', 'score_tokens', 'verify_tokens', 'has_sku_type', 'keywords')

    def __init__(self, group: Dict):
        self.group = group
        self.name = group.get('name', '') or ''
        self.enabled = group.get('enabled', True)
        score_tokens = set()
        verify_tokens = set()
        for source in [self.name, *(group.get('keywords', []) or [])]:
            tokens = _MATCH_TOKEN_RE.findall(str(source or '').lower())
            verify_tokens.update(tokens)
            score_tokens.update(t for t in tokens if t not in _MATCH_SKU_WORDS)
        self.score_tokens = frozenset(score_tokens)
        self.verify_tokens = frozenset(verify_tokens)
        self.has_sku_type = _group_has_sku_type_token(group)
        self.keywords = tuple(
            _PreparedKeyword(str(raw))
            for raw in (group.get('keywords', []) or [])
            if str(raw or '').strip()
        )


class MatcherIndex:
    """按机型组/别名配置构建的只读匹配索引。"""

    def __init__(self, model_groups: List[Dict], alias_rules: Optional[List[Dict]] = None):
        self.model_groups = model_groups or []
        self.groups = tuple(_PreparedGroup(g) for g in self.model_groups)
        self.enabled_groups = tuple(g for g in self.groups if g.enabled)
        self.groups_by_name: Dict[str, List[_PreparedGroup]] = {}
        self.groups_by_exact_key: Dict[str, List[_PreparedGroup]] = {}
        self.groups_by_variant_key: Dict[str, List[_PreparedGroup]] = {}
        for group in self.groups:
            self.groups_by_name.setdefault(group.name, []).append(group)
            self.groups_by_exact_key.setdefault(_match_group_name_key(group.name), []).append(group)
            variant_key = _match_group_variant_key(group.name)
            if variant_key:
                self.groups_by_variant_key.setdefault(variant_key, []).append(group)

        alias_pairs = []
        for rule in alias_rules or []:
            alias = (rule.get('alias') or rule.get('trigger_word') or '').lower().strip()
            target = rule.get('target') or rule.get('target_model') or ''
            if alias and target:
                pattern = re.compile(r'(?:\b|^)' + re.escape(alias) + r'(?:\b|$)')
                alias_pairs.append((alias, target, pattern))
        alias_pairs.sort(key=lambda p: -len(p[0]))
        self.alias_pairs = tuple(alias_pairs)

    def resolve_target_groups(self, target_group_names) -> List[_PreparedGroup]:
        if isinstance(target_group_names, str):
            targets = [target_group_names]
        else:
            targets = list(target_group_names or [])
        target_keys = [_match_group_name_key(t) for t in targets if t]
        exact = []
        seen = set()
        # 保持旧实现的 model_groups 顺序，避免 target_group_names 为列表时
        # 改变多个候选组的优先级。
        for group in self.groups:
            if _match_group_name_key(group.name) in target_keys and id(group) not in seen:
                exact.append(group)
                seen.add(id(group))
        if exact:
            return exact

        matched = []
        target_variant_keys = {_match_group_variant_key(target) for target in targets if target}
        for group in self.groups:
            if _match_group_variant_key(group.name) in target_variant_keys and id(group) not in seen:
                matched.append(group)
                seen.add(id(group))
        return matched


_MATCHER_CACHE_KEY = None
_MATCHER_CACHE: Optional[MatcherIndex] = None


def prepare_matcher(model_groups: List[Dict], alias_rules: Optional[List[Dict]] = None) -> MatcherIndex:
    """获取当前配置对应的索引；配置列表替换后自动构建新索引。"""
    global _MATCHER_CACHE_KEY, _MATCHER_CACHE
    key = (id(model_groups), id(alias_rules), len(model_groups or []), len(alias_rules or []))
    if _MATCHER_CACHE is None or _MATCHER_CACHE_KEY != key:
        _MATCHER_CACHE = MatcherIndex(model_groups or [], alias_rules or [])
        _MATCHER_CACHE_KEY = key
    return _MATCHER_CACHE


def find_matching_group(keyword: str, model_groups: List[Dict], alias_rules: Optional[List[Dict]] = None, marketplace: Optional[str] = None, matcher: Optional[MatcherIndex] = None) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """
    v3.1-rc5 (2026-09-04) 老板新逻辑: 型号映射 + 验证
    1. 拆搜索词: 区分 SKU 词 (hülle/cover/case/壳) vs 品牌/型号词
    2. 识别"型号" token (含数字的, 如 p30 / pixel 11 / a05s)
    3. 品牌+型号 token 找候选 model_group
    4. 验证: 候选 group 的 keywords/name 覆盖搜索词所有非 SKU 词
    5. 第一个验证通过的 → return
    返回 (group_name, match_type, matched_keyword)
    match_type: 'model_match', 'model_partial', 'alias', 'unmatched'

    v3.1-rc 旧逻辑 (误判) 已弃用:
      - 原 contains/contains_prefix 模糊匹配
      - 错配: smartphonehülle samsung → S8+ (因 samsung 单字符命中 samsung s8+ keyword)

    v3.1-rc 新增 marketplace 参数（默认 None 保持向后兼容）：
      - 当 marketplace ∈ EU_MARKETPLACES 且命中机身组的关键词不带 SKU 类型后缀（如 "iphone 16e"），
        而该机身组名/关键词暗示了 SKU 类型（如 "iPhone 16e Case"），则**不上抛匹配**，
        让上层 caller 进入"无壳类词" deny 路径 —— 这是 Bug1 的修复点。

    v3.1-rc2 fix: alias_rules 优先级提升到 model_group 循环之前
      - 原 alias_rules 数据用 trigger_word/target_model 字段，匹配代码用 alias/target，
        导致 304 条 alias_rules 全部失效（schema 不匹配 bug）
      - 即便字段修正，alias 检查在循环末尾，导致 contains_all_tokens fallback 命中错误 group 后直接 return
      - 本函数将 alias 检查前置到 model_group 循环之前，确保 trigger phrase 优先命中正确 group
    """
    if not model_groups:
        return None, None, None

    matcher = matcher or prepare_matcher(model_groups, alias_rules)

    # ═══ Bug1 fix: marketplace-aware SKU 后缀守卫 ═══
    # EU 站点当搜索词缺 SKU 后缀、但机身组带 SKU 后缀时，跳过匹配，
    # 触发 caller 的"无壳类词" deny（USA 站严格模式不受影响）。
    _eu_strict_sku_guard = (
        marketplace is not None
        and str(marketplace).lower() in EU_MARKETPLACES
    )

    kw = keyword.lower().strip()

    # ═══ v3.1-rc2 fix: alias_rules 优先匹配（最高优先级） ═══
    # 同时支持两套字段名:
    #   新 schema: {'alias': ..., 'target': ...}
    #   老 schema: {'trigger_word': ..., 'target_model': ...}
    # 历史数据 (304 条) 全部用老 schema 一直没有生效，v3.1-rc2 起兼容两种 schema
    # 排序：长 trigger 优先（精准 > 通用），避免 "plus"/"8" 这种短 trigger 抢匹配
    for alias, target, alias_re in matcher.alias_pairs:
        if alias_re.search(kw):
            return target, 'alias', alias

    def _maybe_sku_guard_hit(gname_):
        """Bug1 fix: EU 站严格 SKU 守卫 — 命中机身组但搜索词/关键词不含 SKU 类型后缀 → 截停匹配
        返回 True 表示"被 SKU 守卫截停、需要 caller 进入无壳类词 deny 路径"，
        此时本函数对外返回 (None, None, None) 让上层 caller 处理 deny。"""
        if not _eu_strict_sku_guard:
            return False
        if _kw_has_sku_type_token(kw):
            return False  # 搜索词有 SKU 后缀，正常匹配
        for _g in matcher.groups_by_name.get(gname_, []):
            if _g.enabled:
                return _g.has_sku_type
        return False

    # ═══ v3.1-rc5 (2026-09-04) 老板新逻辑: 型号映射 + 验证 ═══
    # 1. 拆搜索词 token, 区分 SKU 词 (hülle/case/cover/壳) vs 非 SKU 词 (品牌/型号)
    # 2. 用非 SKU 词里的"型号" token (含数字) 找候选 group
    # 3. 验证: 候选 group 的 keywords/name 覆盖搜索词的所有非 SKU 词
    # 4. 第一个验证通过的 → return

    # 拆搜索词: 规范化 umlaut (hülle → huelle) + 单词化
    kw_norm = _normalize_umlaut(kw)
    kw_tokens = re.findall(r'[a-z0-9]+', kw_norm)
    # SKU 词列表 (已 ASCII 化)
    sku_words = _MATCH_SKU_WORDS
    # 型号变体词 (与具体型号绑定的词, 也算 model_token)
    model_variants = _MATCH_MODEL_VARIANTS
    # 非 SKU 词 (品牌 + 型号)
    non_sku_tokens = [t for t in kw_tokens if t not in sku_words]
    # 找"型号" token: 含数字 OR 是型号变体词 (lite/pro/plus 等)
    model_tokens = [t for t in non_sku_tokens if any(c.isdigit() for c in t) or t in model_variants]
    # 品牌 token: 不含数字、不是型号变体、>= 3 字符
    brand_tokens = [t for t in non_sku_tokens if not any(c.isdigit() for c in t) and t not in model_variants and len(t) >= 3]

    # 没型号/品牌 token → 不匹配 (caller 进 deny 路径)
    if not model_tokens and not brand_tokens:
        return None, None, None

    # 候选 group 评分: 按 (型号+品牌 token 命中数) 降序
    def _group_score(g):
        g_tokens = g.score_tokens
        # 评分 = 搜索词的型号 token 命中数 (主) + 品牌 token 命中数 (次)
        #        - 额外变体词惩罚 (次) + token 总数 (末位 tiebreak)
        # v3.1-rc5b: 变体惩罚 —— group 含 pro/plus/xl/5g 等变体词但搜索词没有时扣分,
        #            避免基础搜索词 (如 "xiaomi redmi note 14") 错配到 Pro/5G 变体组
        model_hit = sum(1 for t in model_tokens if t in g_tokens)
        brand_hit = sum(1 for t in brand_tokens if t in g_tokens)
        _penalty_variants = model_variants | {'5g', '4g', '3g'}
        extra_variant = sum(1 for t in g_tokens if t in _penalty_variants and t not in non_sku_tokens)
        return (model_hit, brand_hit, -extra_variant, len(g_tokens))

    candidates = list(matcher.enabled_groups)
    candidates.sort(key=_group_score, reverse=True)

    # 验证候选: 搜索词的所有非 SKU 词 必须在 group 的 tokens 里
    for g in candidates:
        # SKU 守卫
        if _maybe_sku_guard_hit(g.name):
            continue
        # 验证: 搜索词的所有非 SKU token 必须在 group tokens 里
        missing = [t for t in non_sku_tokens if t not in g.verify_tokens]
        if not missing:
            # 完全匹配
            mtype = 'model_match'
            mkw = g.name
            return g.name, mtype, mkw
        # 部分匹配: 至少有 1 个型号 token 命中 → model_partial (caller 决定)
        model_hit = sum(1 for t in model_tokens if t in g.score_tokens)
        if model_hit > 0:
            # 部分匹配, 返回但 match_type 标记
            mkw = g.name
            return g.name, 'model_partial', mkw

    return None, None, None


def find_matching_group_in_target(keyword: str, model_groups: List[Dict], target_group_names, alias_rules: Optional[List[Dict]] = None, marketplace: Optional[str] = None, matcher: Optional[MatcherIndex] = None, alias_target_resolver=None) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """
    只在指定的目标机型组中查找匹配关键词
    用于 Campaign 映射场景，确保否词不会跨组匹配到其他机型。

    v3.1-rc 新增 marketplace 参数（与 find_matching_group 行为一致）：EU 站严格 SKU 守卫。
    """
    if not model_groups:
        return None, None, None

    matcher = matcher or prepare_matcher(model_groups, alias_rules)

    # ═══ Bug1 fix: marketplace-aware SKU 后缀守卫 ═══
    _eu_strict_sku_guard = (
        marketplace is not None
        and str(marketplace).lower() in EU_MARKETPLACES
    )

    kw = keyword.lower().strip()

    def _maybe_sku_guard_hit(gname_):
        if not _eu_strict_sku_guard:
            return False
        if _kw_has_sku_type_token(kw):
            return False
        for _g in matcher.groups_by_name.get(gname_, []):
            if _g.enabled:
                return _g.has_sku_type
        return False

    if isinstance(target_group_names, str):
        targets = [target_group_names]
    else:
        targets = list(target_group_names or [])
    _target_groups = matcher.resolve_target_groups(targets)
    if not _target_groups:
        return None, None, None
    kw_nospace = re.sub(r'\s+', '', kw)
    for group in _target_groups:
        for prepared_kw in group.keywords:
            gk = prepared_kw.raw
            gk_lower = prepared_kw.lower

            if gk_lower[-1].isdigit() and re.search(r'\b' + re.escape(gk_lower) + r'\s*\+', kw):
                continue
            if kw == gk_lower:
                if _maybe_sku_guard_hit(group.name):
                    return None, None, None
                return group.name, 'exact', gk
            if prepared_kw.word_re.search(kw):
                if _maybe_sku_guard_hit(group.name):
                    return None, None, None
                return group.name, 'contains', gk
            if prepared_kw.prefix_re.search(kw):
                if gk_lower.endswith('+') and 'plus' not in group.name.lower():
                    if '+' in kw:
                        if _maybe_sku_guard_hit(group.name):
                            return None, None, None
                        return group.name, 'contains_prefix', gk
                else:
                    if _maybe_sku_guard_hit(group.name):
                        return None, None, None
                    return group.name, 'contains_prefix', gk

            if prepared_kw.nospace in kw_nospace:
                if _maybe_sku_guard_hit(group.name):
                    return None, None, None
                return group.name, 'contains_fuzzy', gk

            # 多token无序匹配（与 find_matching_group 相同逻辑）
            _valid_tokens = prepared_kw.valid_tokens
            if len(_valid_tokens) >= 2:
                _all_present = True
                _gk_has_plus = prepared_kw.has_plus
                kw_nosymbol = re.sub(r'[^a-z0-9\s]', '', kw)
                for _token in _valid_tokens:
                    if re.search(r'\b' + re.escape(_token) + r'\b', kw):
                        if _token.isdigit() and not _gk_has_plus:
                            _match = re.search(r'\b' + re.escape(_token) + r'\s*\+', kw)
                            if _match:
                                _all_present = False
                                break
                    else:
                        if _token.isdigit():
                            if _token not in kw:
                                _all_present = False
                                break
                        else:
                            _token_nosymbol = re.sub(r'[^a-z0-9]', '', _token)
                            if _token_nosymbol and len(_token_nosymbol) >= 2:
                                if _token_nosymbol not in kw_nosymbol:
                                    _all_present = False
                                    break
                if _all_present:
                    if _maybe_sku_guard_hit(group.name):
                        return None, None, None
                    return group.name, 'contains_all_tokens', gk

    # 别名也必须受当前 Campaign 目标机型限制。旧逻辑在目标组未命中时
    # 无条件回退到全局别名，导致搜索词中的独立数字（如 Android 版本 12、XCover 7）
    # 跨组命中 iPhone 12/7 并被保留。
    target_group_keys = {_match_group_name_key(group.name) for group in _target_groups}
    for alias, alias_target, alias_re in matcher.alias_pairs:
        if not alias_re.search(kw):
            continue
        resolved_alias_target = alias_target
        if alias_target_resolver:
            try:
                resolved_alias_target = alias_target_resolver(alias_target) or alias_target
            except Exception:
                resolved_alias_target = alias_target
        alias_target_groups = matcher.resolve_target_groups([resolved_alias_target])
        scoped_group = next(
            (group for group in alias_target_groups if _match_group_name_key(group.name) in target_group_keys),
            None,
        )
        if scoped_group:
            return scoped_group.name, 'alias', alias

    return None, None, None
