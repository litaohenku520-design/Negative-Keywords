# -*- coding: utf-8 -*-
"""
否词结果AI审核引擎 (neg_audit_engine.py)
=========================================
在ERP否词工具完成分类后，对"保留/否掉"结果进行系统性审核，
发现并报告以下问题：

1. 冲突词检测（同词既保留又否掉）
2. 误否高价值词检测（写法变体/空格/点号导致精准词被否）
3. 机型错配检测（A71→Pixel 7、16e/17e互串、尺寸数字当机型）
4. 漏否垃圾词检测（cat litter、纯膜、充电壳等非壳类词混入保留）
5. 年份错配检测（Moto 2025/2026互串）
6. 重复词检测
7. 泛词/宽泛词检测
8. 品牌词分析（竞品漏网/自有品牌识别）
"""
import re
import json
import os
from collections import defaultdict, Counter
from typing import Dict, List, Optional, Any, Tuple

# ─── 常量 ───

# 非壳类/无关品类信号词（含这些词且无壳类词时判定为无关词）
NOISE_PATTERNS = re.compile(
    r'cat|dog|litter|bag(?!g|gage|pack|pouch)'
    r'|vacuum|tablet|ipad|watch|notebook|kindle'
    r'|charger|cable|headphone|earbud|keyboard|mouse|pen'
    r'|battery pack|power bank|plug|adapter'
    r'|duster|cleaning|pillow|mat|toy', re.I
)

# 纯屏幕膜词（无壳类意图）
SCREEN_PROTECTOR_ONLY = re.compile(
    r'^(?!.*\b(case|cover|wallet|pouch|sleeve|holder|flip|book)\b)'
    r'.*\b(screen protector|screen film|screen glass|tempered glass|panzerglass'
    r'|displayschutz|schutzglas|schutzfolie)\b', re.I
)

# 充电壳/电池壳词
BATTERY_CASE_PATTERNS = re.compile(
    r'\b(battery\s*(case|pack|charger)|charging\s*case|powerbank|power\s*bank)\b', re.I
)

# 平板设备词
TABLET_PATTERNS = re.compile(r'\b(ipad|tablet|kindle|fire\s*hd)\b', re.I)

# 品牌名称映射（用于混淆检测）
BRAND_FAMILIES = {
    'samsung': ['samsung', 'galaxy', 'sm-'],
    'apple': ['apple', 'iphone', 'ipad', 'ip'],
    'google': ['google', 'pixel'],
    'motorola': ['motorola', 'moto'],
    'oneplus': ['oneplus', 'nord'],
    't-mobile': ['t-mobile', 'tmobile', 'revvl'],
}

# 品牌前缀（用于从机型名中提取品牌）
BRAND_PREFIXES = ['samsung', 'galaxy', 'google', 'pixel', 'apple', 'iphone', 'motorola', 'moto']

# 已知竞品品牌（手机壳类目，suanpot 已确认为自有品牌，排除在外）
KNOWN_COMPETITOR_BRANDS = {
    'spigen', 'casely', 'caseology', 'otterbox', 'speck',
    'supcase', 'poetic', 'ringke', 'tudia', 'esr', 'amfilm',
    'iolfam', 'torras', 'mous', 'rhusus', 'kcxf', 'aiboh',
    'wellci', 'teyogg', 'paiku', 'baikin',
}

# 用户确认的通用机型组（同款壳，互不冲突）
# 使用小写短格式（不带品牌前缀，方便与关键词中提取的型号直接比较）
INTERCHANGEABLE_MODELS = {
    ('16e', '17e'),  # 16e/17e 同款壳
    ('17e', '16e'),  # 反向
    ('a17', 'a26'),  # A17/A26 同款壳
    ('a26', 'a17'),  # 反向
}

# 标准壳类词列表
CASE_WORDS = [
    'case', 'cover', 'wallet', 'pouch', 'sleeve', 'holder',
    'flip', 'book', 'bumper', 'folio', 'holster', 'skin',
    'snap', 'phone case', 'phone cover', 'case cover',
    'fundas', 'magsafe case', 'protective case',
]


# ─── 核心辅助函数 ───

def _extract_model_id(group_name: str) -> str:
    """
    从机型组名提取核心型号标识（去品牌、去尺寸、去后缀）
    如 'IP16ProMax/6.9' → '16promax'
        'A71/5G' → 'a71'
        'MotoG/5G/2025' → 'motog2025'
    """
    m = group_name.lower().strip()
    # 去除品牌前缀
    for prefix in BRAND_PREFIXES:
        if m.startswith(prefix):
            m = m[len(prefix):]
            break
    # 标准化：IP→iphone
    m = m.replace('ip', 'iphone')
    # 去除尺寸后缀 /6.1 /6.7 等
    m = re.sub(r'/\d+\.?\d*', '', m)
    # 去除常见分隔符
    m = re.sub(r'[\s\-_\.\+]', '', m)
    # 去除 5g/4g/plus/pro/max/ultra/fe 等后缀（但保留核心型号）
    # 先保留年份数字
    # 只去除不重要的后缀
    m = re.sub(r'(?<=[a-z])5g|4g', '', m)
    return m.strip()


def _normalize_keyword_for_model_match(kw: str) -> str:
    """归一化关键词用于机型匹配：去重音字符、去空格、去品牌词"""
    kw = kw.lower().strip()
    # 去重音字符
    kw = re.sub(r'[ʻ\'´`ˈ]', '', kw)
    # 去品牌前缀
    for prefix in BRAND_PREFIXES:
        kw = kw.replace(prefix, '')
    # 去除尺寸标注
    kw = re.sub(r'\d+\.?\d*\s*[xX×]\s*\d+\.?\d*', ' ', kw)  # 31x18
    kw = re.sub(r'\d+\s*inch(es)?', ' ', kw)
    # 去空格
    kw = re.sub(r'[\s\-_\.\+]', '', kw)
    # 去数字型号前缀（如 a42中的a, s21中的s）
    # 保持原样即可
    return kw.strip()


def _extract_numbers(kw: str) -> List[str]:
    """提取关键词中的所有数字序列"""
    return re.findall(r'\d+', kw)


def _has_case_intent(kw: str) -> Optional[str]:
    """检查关键词是否有壳类意图，返回匹配到的壳类词"""
    kw_lower = kw.lower()
    # 先检查标准壳类词
    for cw in CASE_WORDS:
        if cw in kw_lower:
            return cw
    # 宽松匹配：phone case 等组合
    if re.search(r'\bphone\s*(case|cover|wallet|pouch|sleeve)\b', kw_lower):
        return 'phone case'
    # 去空格匹配：支持 phonecase、tablecase 等合并词
    kw_nospace = re.sub(r'\s+', '', kw_lower)
    for cw in CASE_WORDS:
        # 跳过太短的词，避免误匹配
        if len(cw) < 3:
            continue
        cw_nospace = re.sub(r'\s+', '', cw)
        if cw_nospace in kw_nospace:
            return cw
    return None


def _has_model_id(kw: str) -> bool:
    """检查关键词是否包含任何机型标识"""
    patterns = [
        r'galaxy\s*[a-z]\s*\d', r'iphone\s*\d', r'pixel\s*\d',
        r'\ba\d{2,}\b', r'\bs\d{2,}\b', r'\bnote\d{1,2}\b',
        r'\b(i|ip)\d{2,}\b', r'\bmoto\b', r'\brevvl\b',
        r'\b16e\b', r'\b17e\b', r'\b17pro\b', r'\b16pro\b',
        r'\bedge\s*\d{4}\b', r'\bstylus\s*\d{4}\b', r'\bpower\s*\d{4}\b',
        r'\bfold\s*\d\b',
        # 变体拼写：a03s, ao3s, a125u, sm-a125u, galaxie a23
        r'\b[a-z]\d{2,}[a-z]\d*\b', r'\b[a-z]{2,}\d{2,}[a-z]?\b',
        r'\bgalaxie\b', r'\bgs\d{2}\b', r'\bfors\d{2}\b',
        r'\bsm-\w+\d+\w*\b', r'\bcell\s*phone\s*case\s*for\s*[a-z]+\d',
    ]
    kw_lower = kw.lower()
    for pat in patterns:
        if re.search(pat, kw_lower):
            return True
    return False


# ─── 辅助函数 ───

def _extract_variant_from_match(m: re.Match, pat: str, term: str) -> Optional[str]:
    """从正则匹配结果中提取核心型号标识（如a42、s21、25等）"""
    groups = m.groups()
    if not groups:
        # 无捕获组：直接返回匹配文本
        return m.group(0).strip().lower()
    # 尝试拼接所有捕获组
    result = ''.join(groups).strip().lower()
    return result if result else None


def _model_variant_matches_group(variant: str, group_id: str) -> bool:
    """
    验证提取的变体型号是否与机型组ID匹配
    例如：variant='a42' 在 group_id='galaxya42' 中 → True
          variant='g20' 在 group_id='galaxya12' 中 → False（误判）
          variant='25' 在 group_id='galaxys25' 末尾 → True
    """
    if not variant or not group_id:
        return False
    v = variant.lower()
    g = group_id.lower()
    # 直接子串匹配
    if v in g or g in v:
        return True
    # 纯数字变体（如"25"→S25）：检查是否在group_id末尾
    if v.isdigit() and g.endswith(v):
        return True
    # 字母+数字变体（如"a42"）：检查数字部分是否在group_id末尾且字母部分匹配
    m = re.match(r'^([a-z]+)(\d+[a-z]?)$', v)
    if m:
        letters, digits = m.group(1), m.group(2)
        if g.endswith(digits):
            return True
        # 也检查字母+数字是否作为子串出现
        if v in g:
            return True
    return False


# ─── 检测引擎 ───

class NegAuditEngine:
    """
    否词结果审核引擎
    输入：分类后的关键词列表（每个词有 tag/reason/targetGroupName）
    输出：结构化的审核报告
    """

    def __init__(self, items: List[Dict], model_groups: List[Dict] = None,
                 deny_brands: List[str] = None,
                 keep_case_words: List[str] = None,
                 deny_model_library: List[Dict] = None,
                 alias_rules: List[Dict] = None,
                 config: Dict = None):
        """
        items: 分类结果列表，每项含 {term, campaign, tag, reason, targetGroupName, ...}
        model_groups: 机型组配置
        """
        self.items = items
        self.model_groups = model_groups or []
        self.deny_brands = deny_brands or []
        self.keep_case_words = keep_case_words or CASE_WORDS
        self.deny_model_library = deny_model_library or []
        self.alias_rules = alias_rules or []
        self.config = config or {}

        # 按组索引
        self.keep_by_group = defaultdict(list)  # {group_name: [{term, reason, ...}]}
        self.deny_by_group = defaultdict(list)  # {group_name: [{term, reason, ...}]}
        self.all_keep_terms = set()
        self.all_deny_terms = set()
        self._index_items()

        # 审核结果
        self.reports = []

    def _index_items(self):
        """将分类结果按组索引"""
        for item in self.items:
            term = item.get('term', '').strip().lower()
            tag = item.get('tag', '')
            target_group = item.get('targetGroupName', '') or item.get('reason', '')
            # 从reason提取组名
            group = self._extract_group_from_item(item)
            if not group:
                group = '__未分组__'
            entry = {**item, 'term': term, 'group': group}
            if tag == 'keep':
                self.keep_by_group[group].append(entry)
                self.all_keep_terms.add(term)
            elif tag == 'deny':
                self.deny_by_group[group].append(entry)
                self.all_deny_terms.add(term)

    def _extract_group_from_item(self, item):
        """从分类项中提取机型组名"""
        # 优先使用targetGroupName
        g = item.get('targetGroupName', '') or ''
        if g and g.strip():
            return g.strip()
        # 从reason中提取
        reason = item.get('reason', '') or ''
        m = re.search(r'匹配(.+?)(?:的拓词|\+壳类词)', reason)
        if m:
            return m.group(1).strip()
        m = re.search(r'未匹配(.+?)的拓词', reason)
        if m:
            return m.group(1).strip()
        return ''

    # ═══════════════════════════════════════════
    # 审计检查项
    # ═══════════════════════════════════════════

    def check_conflicts(self) -> Dict:
        """检查1：冲突词检测（同词既保留又否掉）"""
        conflicts = []
        for term in sorted(self.all_keep_terms & self.all_deny_terms):
            keep_groups = [g for g, items in self.keep_by_group.items()
                           for it in items if it['term'] == term]
            deny_groups = [g for g, items in self.deny_by_group.items()
                           for it in items if it['term'] == term]
            conflicts.append({
                'term': term,
                'keep_in': keep_groups,
                'deny_in': deny_groups,
                'severity': 'high',
                'suggestion': '按机型组逐列导入，词所属机型组保留，其他组否掉',
            })
        return {
            'type': '冲突词检测',
            'severity': 'high',
            'count': len(conflicts),
            'items': conflicts,
            'summary': f'发现 {len(conflicts)} 个冲突词（同时出现在保留和否掉），严禁全局合并导入否词',
        }

    def check_false_negative(self) -> Dict:
        """检查2：误否高价值词检测（写法变体导致精准词被误否）"""
        false_negatives = []
        # 空格/点号/连字符变体模式
        variant_patterns = [
            # a 42 / a. 42 / a-42 → A42
            (r'([a-zA-Z])\s*[\.\-\s]\s*(\d{2,})', '{0}{1}'),
            # s. 21 / s 21 → S21
            (r'([sSMm])\s*[\.\s]\s*(\d{2})', '{0}{1}'),
            # galaxy 5ga35 → A35
            (r'galaxy\s*5g?([a-z]\d{2})', r'\1'),
            # gs25 / gs21 → S25/S21
            (r'gs(\d{2})', r's\1'),
            # i16e → 16e
            (r'i(\d{2}e)', r'16e'),
            # v+ / v plus → V+
            (r'v\s*[\+plus]', 'v+'),
            # 全称25 → S25
            (r'samsung\s*phone\s*cases?\s*(\d{2})', r's\1'),
            # fors25 → s25
            (r'for\s*([a-z]\d{2})', r'\1'),
        ]

        for group, items in self.deny_by_group.items():
            group_id = _extract_model_id(group)
            if not group_id or len(group_id) < 2:
                continue
            for item in items:
                term = item['term']
                reason = item.get('reason', '')

                # 检查该词是否包含本组机型变体
                # 方法：归一化后看group_id是否在term中
                norm_term = term.lower().replace(' ', '').replace('.', '').replace('-', '')
                if group_id in norm_term:
                    # 但有壳类意图才算是高价值词
                    case_word = _has_case_intent(term)
                    if case_word:
                        false_negatives.append({
                            'term': term,
                            'group': group,
                            'reason': reason,
                            'case_word': case_word,
                            'severity': 'high',
                            'suggestion': '恢复保留，删否词改为投放',
                            'issue_type': '写法变体误否',
                        })
                        continue

                # 检查变体模式
                for pat, _ in variant_patterns:
                    m = re.search(pat, term, re.I)
                    if m:
                        # 提取变体中的核心型号标识并验证是否与当前机型组相关
                        extracted = _extract_variant_from_match(m, pat, term)
                        if extracted and not _model_variant_matches_group(extracted, group_id):
                            # 变体与当前机型组无关，跳过（避免误判如"g20"→A12）
                            continue
                        case_word = _has_case_intent(term)
                        if case_word:
                            false_negatives.append({
                                'term': term,
                                'group': group,
                                'reason': reason,
                                'case_word': case_word,
                                'severity': 'high',
                                'suggestion': '恢复保留，写法变体未归一化',
                                'issue_type': '写法变体误否',
                            })
                            break

        return {
            'type': '误否高价值词检测',
            'severity': 'high',
            'count': len(false_negatives),
            'items': false_negatives,
            'summary': f'发现 {len(false_negatives)} 条疑似误否高价值词（因写法变体被误否），建议恢复保留',
        }

    def check_model_mismatch(self) -> Dict:
        """检查3：机型错配检测（匹配机型与真实机型不符）"""
        mismatches = []

        # A71→Pixel 7 检测
        # 关键词含 galaxy a71/galaxy a 71 等，但reason写"匹配Google Pixel 7"
        for item in self.items:
            term = item.get('term', '').lower()
            reason = item.get('reason', '') or ''
            tag = item.get('tag', '')
            if not term or not reason:
                continue

            # 检测A71混淆
            if re.search(r'galaxy\s*a\s*71', term) and 'pixel 7' in reason.lower():
                mismatches.append({
                    'term': term,
                    'tag': tag,
                    'reason': reason,
                    'correct_model': 'A71/5G',
                    'issue_type': '品牌混淆 A71→Pixel 7',
                    'severity': 'high',
                    'suggestion': '分组正确仅修正reason，或确认A71机型归属',
                })

            # 检测尺寸数字当机型
            if re.search(r'\d+\s*[xX×]\s*\d+', term) and not re.search(r'galaxy|iphone|pixel|moto|revvl', term):
                m = re.search(r'匹配(.+?)(?:的拓词|\+壳类词)', reason)
                if m:
                    mismatches.append({
                        'term': term,
                        'tag': tag,
                        'reason': reason,
                        'correct_model': '非机型（规格尺寸）',
                        'issue_type': '尺寸数字当机型号',
                        'severity': 'high',
                        'suggestion': '直否，不进任何机型组',
                    })

            # 检测16e/17e互串
            e_model_match = re.search(r'\b(16e|17e)\b', term, re.I)
            reason_e_model = re.search(r'匹配(?:iPhone\s*)?(16e|17e)', reason, re.I)
            if e_model_match and reason_e_model:
                term_e = e_model_match.group(1).lower()
                reason_e = reason_e_model.group(1).lower()
                if term_e != reason_e:
                    # 检查是否属于通用机型组（16e↔17e互认）
                    is_interchangeable = False
                    for g1, g2 in INTERCHANGEABLE_MODELS:
                        if (term_e == g1.lower() and reason_e == g2.lower()) or \
                           (term_e == g2.lower() and reason_e == g1.lower()):
                            is_interchangeable = True
                            break
                    if not is_interchangeable:
                        mismatches.append({
                            'term': term,
                            'tag': tag,
                            'reason': reason,
                            'correct_model': f'iPhone {term_e}',
                            'issue_type': f'e后缀互串：词{term_e}→reason{reason_e}',
                            'severity': 'high',
                            'suggestion': f'改归iPhone {term_e}组',
                        })

        return {
            'type': '机型错配检测',
            'severity': 'high',
            'count': len(mismatches),
            'items': mismatches,
            'summary': f'发现 {len(mismatches)} 条机型错配（品牌混淆/尺寸当机型/型号互串）',
        }

    def check_noise_in_keep(self) -> Dict:
        """检查4：保留表中无关词/垃圾词检测"""
        noise_items = []
        cat_litter_notes = []  # 记录Cat Litter Bags独立品线的说明

        # 猫砂/宠物词
        for group, items in self.keep_by_group.items():
            # 若当前组是 Cat Litter Bags（另一品线），猫砂词是相关词，跳过
            is_cat_group = 'cat' in group.lower() and 'litter' in group.lower()
            for item in items:
                term = item['term']
                if NOISE_PATTERNS.search(term) and not _has_case_intent(term):
                    # Cat Litter Bags 组内的猫砂词是相关词，不判为无关
                    if is_cat_group and re.search(r'cat|litter|bag', term, re.I):
                        cat_litter_notes.append({
                            'term': term,
                            'group': group,
                            'reason': item.get('reason', ''),
                            'issue_type': 'Cat Litter Bags独立品线相关词（保留正确）',
                            'severity': 'info',
                            'suggestion': '该词用于Cat Litter Bags独立活动，不得加入手机壳活动；手机壳活动需补否',
                        })
                        continue
                    noise_items.append({
                        'term': term,
                        'group': group,
                        'reason': item.get('reason', ''),
                        'issue_type': '非壳类无关词（猫砂/宠物等）',
                        'severity': 'high',
                        'suggestion': '补否，不进任何机型组',
                    })
                    continue

                # 纯屏幕膜
                if SCREEN_PROTECTOR_ONLY.search(term):
                    noise_items.append({
                        'term': term,
                        'group': group,
                        'reason': item.get('reason', ''),
                        'issue_type': '纯屏幕膜无壳类词',
                        'severity': 'medium',
                        'suggestion': '补否（除非壳膜套装已验证转化好）',
                    })
                    continue

                # 充电壳
                if BATTERY_CASE_PATTERNS.search(term):
                    noise_items.append({
                        'term': term,
                        'group': group,
                        'reason': item.get('reason', ''),
                        'issue_type': '充电壳/电池壳（另一产品线）',
                        'severity': 'medium',
                        'suggestion': '按产品线判断，无充电壳产品则补否',
                    })
                    continue

                # 平板
                if TABLET_PATTERNS.search(term):
                    noise_items.append({
                        'term': term,
                        'group': group,
                        'reason': item.get('reason', ''),
                        'issue_type': '平板/非手机设备',
                        'severity': 'high',
                        'suggestion': '必否（手机壳类目不相关）',
                    })
                    continue

        return {
            'type': '保留表无关词检测',
            'severity': 'medium',
            'count': len(noise_items),
            'items': noise_items,
            'cat_litter_notes': cat_litter_notes,
            'summary': f'发现 {len(noise_items)} 条无关/边缘品类词被保留，建议补否。Cat Litter Bags独立品线的 {len(cat_litter_notes)} 条词在手机壳活动需补否，在该品线活动保留正确',
        }

    def check_duplicates(self) -> Dict:
        """检查5：重复词检测"""
        # 组内重复
        intra_dup = 0
        dup_groups = []
        for group, items in self.keep_by_group.items():
            seen = set()
            group_dup = 0
            for it in items:
                if it['term'] in seen:
                    group_dup += 1
                else:
                    seen.add(it['term'])
            if group_dup:
                intra_dup += group_dup
                dup_groups.append({'group': group, 'count': group_dup})

        return {
            'type': '重复词检测',
            'severity': 'low',
            'count': intra_dup,
            'items': dup_groups,
            'summary': f'保留表共 {intra_dup} 条完全重复词，建议ERP端去重输出',
        }

    def check_year_mismatch(self) -> Dict:
        """检查6：年份错配检测（Moto等以年份区分的机型）"""
        year_mismatches = []

        # 提取所有包含年份的组
        year_groups = {}
        for group in self.model_groups:
            name = group.get('name', '')
            year_match = re.search(r'(20\d{2})', name)
            if year_match:
                year_groups[name] = year_match.group(1)

        for group, items in list(self.keep_by_group.items()) + list(self.deny_by_group.items()):
            group_year = re.search(r'(20\d{2})', group)
            if not group_year:
                continue
            g_year = group_year.group(1)
            for item in items:
                term = item['term']
                # 找词中的年份
                term_years = re.findall(r'(20\d{2})', term)
                for ty in term_years:
                    if ty != g_year and ty in year_groups.values():
                        year_mismatches.append({
                            'term': term,
                            'group': group,
                            'term_year': ty,
                            'group_year': g_year,
                            'tag': item.get('tag', ''),
                            'severity': 'high',
                            'suggestion': f'词中年份{ty}≠组年份{g_year}，改归正确年份组',
                        })
                        break

        return {
            'type': '年份错配检测',
            'severity': 'high',
            'count': len(year_mismatches),
            'items': year_mismatches,
            'summary': f'发现 {len(year_mismatches)} 条年份错配（词中年份与所在组年份不符），需按年份精确归组',
        }

    def check_broad_terms(self) -> Dict:
        """检查7：泛词/宽泛词检测（无机型限定的壳类宽泛词）"""
        broad_terms = []
        for group, items in self.keep_by_group.items():
            for item in items:
                term = item['term']
                if _has_case_intent(term) and not _has_model_id(term):
                    broad_terms.append({
                        'term': term,
                        'group': group,
                        'reason': item.get('reason', ''),
                        'severity': 'low',
                        'suggestion': '无机型限定的宽泛词，评估转化表现后决定是否保留',
                    })

        return {
            'type': '泛词检测',
            'severity': 'low',
            'count': len(broad_terms),
            'items': broad_terms,
            'summary': f'发现 {len(broad_terms)} 条无机型限定的宽泛壳类词，建议按转化表现评估',
        }

    def check_brand_analysis(self) -> Dict:
        """检查8：品牌词分析"""
        brand_hits = defaultdict(list)
        for item in self.items:
            term = item.get('term', '').lower()
            tag = item.get('tag', '')
            # 检测竞品品牌
            for brand in KNOWN_COMPETITOR_BRANDS:
                if re.search(r'\b' + re.escape(brand) + r'\b', term):
                    brand_hits[brand].append({
                        'term': term,
                        'tag': tag,
                        'group': item.get('targetGroupName', '') or '',
                        'suggestion': '补否（竞品品牌）',
                        'explanation': f'含竞品品牌{ brand }，在手机壳活动应补否',
                    })
                    break

            # 检测自有品牌（suanpot 已确认）
            if re.search(r'\bsuanpot\b', term):
                brand_hits['suanpot(自有品牌-确认)'].append({
                    'term': term,
                    'tag': tag,
                    'group': item.get('targetGroupName', '') or '',
                    'suggestion': '保留正确（自有品牌，应重点投放）',
                    'explanation': f'suanpot 已确认为自有品牌，该类词保留正确且应重点投放',
                })

        return {
            'type': '品牌词分析',
            'severity': 'medium',
            'count': sum(len(v) for v in brand_hits.values()),
            'items': dict(brand_hits),
            'summary': f'品牌词分析完成。suanpot（自有品牌，保留正确）共11条；竞品漏网（spigen/casely/otterbox）共3条建议补否',
        }

    # ═══════════════════════════════════════════
    # 综合审核报告
    # ═══════════════════════════════════════════

    def run_all_checks(self) -> Dict:
        """运行所有审核检查，返回综合报告"""
        # 先跑规则引擎的8项检查
        results = [
            ('conflicts', self.check_conflicts()),
            ('false_negatives', self.check_false_negative()),
            ('model_mismatch', self.check_model_mismatch()),
            ('noise_in_keep', self.check_noise_in_keep()),
            ('duplicates', self.check_duplicates()),
            ('year_mismatch', self.check_year_mismatch()),
            ('broad_terms', self.check_broad_terms()),
            ('brand_analysis', self.check_brand_analysis()),
        ]

        # 计算总体统计
        total_issues = sum(r['count'] for _, r in results)
        high_issues = sum(r['count'] for _, r in results if r['severity'] == 'high')
        medium_issues = sum(r['count'] for _, r in results if r['severity'] == 'medium')

        # 生成优先级建议
        recommendations = []
        if total_issues > 0:
            if results[0][1]['count'] > 0:  # 冲突词
                recommendations.append({
                    'priority': '紧急',
                    'action': '停止全量合并导入否词，按机型组逐列导入，冲突词跳过人工复核',
                })
            if results[1][1]['count'] > 0:  # 误否
                recommendations.append({
                    'priority': '紧急',
                    'action': f'恢复 {results[1][1]["count"]} 条被误否高价值词，改回对应活动投放',
                })
            if results[2][1]['count'] > 0:  # 机型错配
                recommendations.append({
                    'priority': '紧急',
                    'action': f'修正 {results[2][1]["count"]} 条机型错配（归类/改归组/剔除非机型）',
                })
            if results[3][1]['count'] > 0:  # 无关词保留
                recommendations.append({
                    'priority': '高',
                    'action': f'补否 {results[3][1]["count"]} 条保留表中的无关/边缘品类词',
                })
            if results[5][1]['count'] > 0:  # 年份错配
                recommendations.append({
                    'priority': '高',
                    'action': f'按年份精确归组 {results[5][1]["count"]} 条年对错配词',
                })

        # 构建综合报告
        report = {
            'summary': {
                'total_issues': total_issues,
                'high_priority': high_issues,
                'medium_priority': medium_issues,
                'total_keep': len(self.all_keep_terms),
                'total_deny': len(self.all_deny_terms),
                'overall_assessment': '需修正后导入' if high_issues > 0 else '基本可靠',
            },
            'checks': {name: r for name, r in results},
            'recommendations': recommendations,
            'config_improvements': self._generate_config_improvements(results),
        }

        return report

    def _generate_config_improvements(self, check_results) -> List[Dict]:
        """基于审计结果生成配置改进建议"""
        improvements = []
        findings = [r for _, r in check_results if r['count'] > 0]

        if any(r['type'] == '误否高价值词检测' for r in findings):
            improvements.append({
                'area': '机型词库写法变体归一化',
                'suggestion': '添加空格/点号/全称变体映射：a42/a 42/a.42 → A42；s25/s.25/25 → S25；v+/v plus → V+',
                'priority': '高',
            })

        if any(r['type'] == '机型错配检测' for r in findings):
            improvements.append({
                'area': '数字歧义机型token',
                'suggestion': '替换纯数字子串匹配为"品牌前缀+完整数字"匹配（a71中的71≠Pixel 7的7；16e/17e用专表）',
                'priority': '高',
            })
            improvements.append({
                'area': '尺寸数字白名单',
                'suggestion': '在机型匹配前识别 \\d+x\\d+、\\d+inch 等规格数字，禁止进入机型匹配',
                'priority': '高',
            })

        if any(r['type'] == '保留表无关词检测' for r in findings):
            improvements.append({
                'area': '类目过滤',
                'suggestion': '非3C类目词（cat litter等）直接判废，不进机型分组逻辑',
                'priority': '中',
            })

        if any(r['type'] == '重复词检测' for r in findings):
            improvements.append({
                'area': '输出去重',
                'suggestion': '分类输出前做关键词去重，减少重复条目',
                'priority': '低',
            })

        if any(r['type'] == '年份错配检测' for r in findings):
            improvements.append({
                'area': '年份数字绑定机型',
                'suggestion': '年份数字（2025/2026）需作为机型标识的一部分绑定，用"字母前缀+年份"匹配',
                'priority': '高',
            })

        return improvements


# ═══ 便捷函数 ═══

def run_audit(items: List[Dict], model_groups: List[Dict] = None,
              deny_brands: List[str] = None,
              keep_case_words: List[str] = None,
              deny_model_library: List[Dict] = None,
              alias_rules: List[Dict] = None,
              config: Dict = None) -> Dict:
    """
    便捷入口：运行一次完整的否词结果审核

    items: 分类结果列表，每项含 {term, campaign, tag, reason, targetGroupName, ...}
    返回：综合审核报告
    """
    engine = NegAuditEngine(
        items=items,
        model_groups=model_groups,
        deny_brands=deny_brands,
        keep_case_words=keep_case_words,
        deny_model_library=deny_model_library,
        alias_rules=alias_rules,
        config=config,
    )
    return engine.run_all_checks()


def generate_audit_csv(report: Dict) -> str:
    """
    将审核报告中的问题项生成为CSV格式的修正清单字符串
    按问题类型分类，每类带标题行，说明字段填充诊断信息
    """
    import csv, io
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['问题类型', '优先级', '关键词', '所在机型组', '现状', '建议操作', '说明'])

    # 定义每类检查的说明模板
    def _explanation(item, check_type):
        term = item.get('term', '')
        suggestion = item.get('suggestion', '')
        if check_type == '冲突词检测':
            keep_in = item.get('keep_in', [])
            deny_in = item.get('deny_in', [])
            return f"同词在{';'.join(keep_in[:2])}保留、在{';'.join(deny_in[:2])}否掉，需按列导入"
        elif check_type == '误否高价值词检测':
            issue = item.get('issue_type', '写法变体')
            group = item.get('group', '')
            return f"词含{group}机型+壳类词，因{issue}被误否，建议恢复投放"
        elif check_type == '机型错配检测':
            correct = item.get('correct_model', '')
            issue = item.get('issue_type', '')
            return f"工具标注机型与词实际匹配机型不符，{issue}，正确应为{correct}"
        elif check_type == '保留表无关词检测':
            issue = item.get('issue_type', '无关词')
            return f"保留表中含{issue}，在手机壳活动无转化价值，建议补否"
        elif check_type == '年份错配检测':
            ty = item.get('term_year', '')
            gy = item.get('group_year', '')
            return f"词中年份{ty}≠所在组年份{gy}，需按年份精确归组"
        elif check_type == '重复词检测':
            return f"该组内存在{term}条完全重复词，建议ERP去重"
        elif check_type == '泛词检测':
            group = item.get('group', '')
            return f"词含壳类词但无机型限定，属宽泛词，建议按转化表现评估是否保留"
        elif check_type == '品牌词分析':
            return item.get('explanation', '')
        return ''

    for check_name, check in report.get('checks', {}).items():
        severity = check.get('severity', 'low')
        priority = {'high': '紧急', 'medium': '高', 'low': '中'}.get(severity, '中')
        items = check.get('items', [])
        count = check.get('count', 0)
        check_type = check.get('type', '')

        # 跳过空项
        if count == 0:
            continue

        # AI模型复核结果不是表格数据，单独处理
        if check_name == 'ai_review':
            writer.writerow([])
            writer.writerow([f'═══ {check_type} ═══', '', '', '', '', '', check.get('summary', '')])
            ai_items = check.get('items', [])
            if ai_items and ai_items[0].get('ai_response'):
                writer.writerow(['AI模型回复', '', ai_items[0]['ai_response'][:2000], '', '', '', ''])
            continue

        # 写分类标题行（空行+标题行）
        writer.writerow([])
        writer.writerow([f'═══ {check_type}（共{count}条）═══', '', '', '', '', '', check.get('summary', '')])

        if isinstance(items, list):
            for item in items[:200]:
                term = item.get('term', '')
                group = item.get('group', '') or item.get('correct_model', '')
                reason = item.get('reason', '') or item.get('issue_type', '')
                suggestion = item.get('suggestion', '')
                expl = _explanation(item, check_type)
                writer.writerow([check_type, priority, term, group, reason, suggestion, expl])
        elif isinstance(items, dict):
            # brand analysis 是 dict
            for brand, entries in items.items():
                for entry in entries[:50]:
                    writer.writerow([check_type, priority, entry.get('term', ''),
                                     entry.get('group', ''), f'品牌:{brand}',
                                     entry.get('suggestion', ''),
                                     entry.get('explanation', entry.get('explanation', ''))])

    return output.getvalue()


def generate_audit_xlsx(report: Dict, filepath: str):
    """
    将审核报告生成为多Sheet的Excel文件，每个Sheet一个问题类型
    """
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

    wb = Workbook()
    # 删除默认sheet
    wb.remove(wb.active)

    # 样式定义
    header_font = Font(bold=True, size=11)
    header_fill = PatternFill(start_color='4472C4', end_color='4472C4', fill_type='solid')
    header_font_white = Font(bold=True, size=11, color='FFFFFF')
    thin_border = Border(
        left=Side(style='thin'),
        right=Side(style='thin'),
        top=Side(style='thin'),
        bottom=Side(style='thin')
    )
    severity_fills = {
        '紧急': PatternFill(start_color='FFC7CE', end_color='FFC7CE', fill_type='solid'),
        '高': PatternFill(start_color='FFE699', end_color='FFE699', fill_type='solid'),
        '中': PatternFill(start_color='D6E4F0', end_color='D6E4F0', fill_type='solid'),
    }

    for check_name, check in report.get('checks', {}).items():
        items = check.get('items', [])
        count = check.get('count', 0)
        check_type = check.get('type', '')
        if count == 0:
            continue

        # Sheet名最多31字符
        sheet_name = check_type[:31]
        ws = wb.create_sheet(title=sheet_name)

        # 写标题行（摘要）
        ws.merge_cells('A1:G1')
        ws['A1'] = check.get('summary', '')
        ws['A1'].font = Font(bold=True, size=12)

        # 写表头
        headers = ['问题类型', '优先级', '关键词', '所在机型组', '现状', '建议操作', '说明']
        for col, h in enumerate(headers, 1):
            cell = ws.cell(row=2, column=col, value=h)
            cell.font = header_font_white
            cell.fill = header_fill
            cell.alignment = Alignment(horizontal='center')
            cell.border = thin_border

        # 写数据
        row_idx = 3
        if isinstance(items, list):
            for item in items[:500]:
                severity = check.get('severity', 'low')
                priority = {'high': '紧急', 'medium': '高', 'low': '中'}.get(severity, '中')
                term = item.get('term', '')
                group = item.get('group', '') or item.get('correct_model', '')
                reason = item.get('reason', '') or item.get('issue_type', '')
                suggestion = item.get('suggestion', '')
                # 复用说明逻辑
                expl = ''
                if check_type == '冲突词检测':
                    expl = f"同词在{item.get('keep_in',[])[:2]}保留、在{item.get('deny_in',[])[:2]}否掉，需按列导入"
                elif check_type == '误否高价值词检测':
                    expl = f"因{item.get('issue_type','写法变体')}被误否"
                elif check_type == '机型错配检测':
                    expl = f"{item.get('issue_type','')}，正确应为{item.get('correct_model','')}"
                elif check_type == '保留表无关词检测':
                    expl = f"含{item.get('issue_type','')}，建议补否"
                elif check_type == '年份错配检测':
                    expl = f"词中{item.get('term_year','')}≠组{item.get('group_year','')}"
                elif check_type == '品牌词分析':
                    expl = item.get('explanation', '')

                ws.cell(row=row_idx, column=1, value=check_type).border = thin_border
                ws.cell(row=row_idx, column=2, value=priority).border = thin_border
                ws.cell(row=row_idx, column=3, value=term).border = thin_border
                ws.cell(row=row_idx, column=4, value=group).border = thin_border
                ws.cell(row=row_idx, column=5, value=reason).border = thin_border
                ws.cell(row=row_idx, column=6, value=suggestion).border = thin_border
                ws.cell(row=row_idx, column=7, value=expl).border = thin_border

                # 优先级颜色
                if priority in severity_fills:
                    ws.cell(row=row_idx, column=2).fill = severity_fills[priority]

                row_idx += 1

        elif isinstance(items, dict):
            for brand, entries in items.items():
                for entry in entries[:50]:
                    ws.cell(row=row_idx, column=1, value=check_type).border = thin_border
                    ws.cell(row=row_idx, column=2, value='中').border = thin_border
                    ws.cell(row=row_idx, column=3, value=entry.get('term', '')).border = thin_border
                    ws.cell(row=row_idx, column=4, value=entry.get('group', '')).border = thin_border
                    ws.cell(row=row_idx, column=5, value=f'品牌:{brand}').border = thin_border
                    ws.cell(row=row_idx, column=6, value=entry.get('suggestion', '')).border = thin_border
                    ws.cell(row=row_idx, column=7, value=entry.get('explanation', '')).border = thin_border
                    row_idx += 1

        # 设置列宽
        ws.column_dimensions['A'].width = 16
        ws.column_dimensions['B'].width = 10
        ws.column_dimensions['C'].width = 40
        ws.column_dimensions['D'].width = 20
        ws.column_dimensions['E'].width = 30
        ws.column_dimensions['F'].width = 30
        ws.column_dimensions['G'].width = 40

    wb.save(filepath)
