# -*- coding: utf-8 -*-
"""
ASIN 智能否定审计与导出服务 (asin_audit_service.py)
=================================================
集成功能：
1. 自动调用西柚 MCP (get_asin_info) 批量拉取商品标题、五点描述、内部类目等信息
2. 规则引擎智能判定：手机本体/保护膜非壳类过滤、机型兼容性比对、通用规则匹配、五点回退机制
3. Campaign ID / Ad Group ID 映射关联
4. 导出完整 32 列判定 Excel 表格（带表头样式与结果高亮）
5. 导出 Amazon 官方后台可直接上传的否商品定向模板 (Campaign / Ad Group 级别)
6. 自动创建判定结果文件夹并在 Windows 资源管理器中打开
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

XYDC_ENDPOINT = "https://mcp.xydc.com/mcp"
XYDC_TOKEN = "mcp_dd0041b77220885ec1468051603b24e4"

MARKETPLACE_DOMAINS = {
    "US": "com",
    "DE": "de",
    "UK": "co.uk",
    "FR": "fr",
    "IT": "it",
    "ES": "es",
    "CA": "ca",
    "JP": "co.jp",
    "NL": "nl",
    "SE": "se",
    "PL": "pl",
    "AU": "com.au",
    "MX": "com.mx",
}


def normalize_asin(value: Any) -> str:
    if not value:
        return ""
    text = str(value).strip().upper()
    m = re.search(r"\b(B0[0-9A-Z]{8})\b", text)
    if m:
        return m.group(1)
    if re.match(r"^B0[0-9A-Z]{8}$", text):
        return text
    return ""


def detect_marketplace(country_or_text: Any, fallback: str = "US") -> str:
    text = str(country_or_text or "").strip().upper()
    if not text:
        return fallback.upper()
    if "德国" in text or "DE" in text:
        return "DE"
    if "美国" in text or "US" in text:
        return "US"
    if "英国" in text or "UK" in text:
        return "UK"
    if "法国" in text or "FR" in text:
        return "FR"
    if "意大利" in text or "IT" in text:
        return "IT"
    if "西班牙" in text or "ES" in text:
        return "ES"
    if "加拿大" in text or "CA" in text:
        return "CA"
    if "日本" in text or "JP" in text:
        return "JP"
    for code in MARKETPLACE_DOMAINS:
        if code in text:
            return code
    return fallback.upper()


def fetch_xiyou_asin_info(
    asins: List[str],
    country: str = "US",
    batch_size: int = 50,
    timeout: int = 40,
) -> Dict[str, Dict[str, Any]]:
    """批量调用西柚 MCP get_asin_info 获取商品标题、五点和链接。"""
    valid_asins = []
    seen = set()
    for a in asins:
        norm = normalize_asin(a)
        if norm and norm not in seen:
            seen.add(norm)
            valid_asins.append(norm)

    result_map: Dict[str, Dict[str, Any]] = {}
    country_code = country.upper()
    domain = MARKETPLACE_DOMAINS.get(country_code, "com")

    for i in range(0, len(valid_asins), batch_size):
        chunk = valid_asins[i : i + batch_size]
        payload = {
            "jsonrpc": "2.0",
            "id": int(time.time() * 1000) + i,
            "method": "tools/call",
            "params": {
                "name": "get_asin_info",
                "arguments": {
                    "asins": chunk,
                    "country": country_code,
                    "user_task": f"批量获取ASIN商品信息及五点描述 (站点: {country_code})",
                    "intent_summary": "查询商品标题与五点用于广告搜索词机型判定",
                },
            },
        }

        try:
            req = urllib.request.Request(
                XYDC_ENDPOINT,
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {XYDC_TOKEN}",
                },
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                resp_data = json.loads(resp.read().decode("utf-8"))
                raw_text = resp_data.get("result", {}).get("content", [{}])[0].get("text", "")
                if raw_text:
                    parsed = json.loads(raw_text)
                    entities = parsed.get("data", {}).get("entities", [])
                    for ent in entities:
                        asin_curr = (ent.get("asin") or "").strip().upper()
                        if not asin_curr:
                            continue
                        result_map[asin_curr] = {
                            "asin": asin_curr,
                            "title": ent.get("title") or "",
                            "bulletPoints": ent.get("bulletPoints") or [],
                            "brand": ent.get("brand") or "",
                            "amazonUrl": ent.get("amazonUrl") or f"https://www.amazon.{domain}/dp/{asin_curr}",
                            "internalCategoryTree": ent.get("internalCategoryTree") or "",
                            "price": ent.get("price") or "",
                            "imgUrl": ent.get("bigPicUrl") or ent.get("mainImageUrl") or "",
                        }
        except Exception as e:
            # 单批请求异常时不中断其它批次
            print(f"[asin_audit_service] Fetch chunk {i} failed: {e}")

    # 对于没取到的 ASIN，生成兜底占位结构
    for asin in valid_asins:
        if asin not in result_map:
            result_map[asin] = {
                "asin": asin,
                "title": "",
                "bulletPoints": [],
                "brand": "",
                "amazonUrl": f"https://www.amazon.{domain}/dp/{asin}",
                "internalCategoryTree": "",
                "price": "",
                "imgUrl": "",
            }

    return result_map


# 手机壳指示词（多语言）
CASE_KEYWORDS_RE = re.compile(
    r"\b(cases?|covers?|wallets?|folios?|sleeves?|bumpers?|holsters?|hüllen?|handyhülle|klapphülle|lederhülle|tasche|schutzhülle|brieftasche|coques?|fundas?|custodie?|etuis?|flip\s*case)\b",
    re.IGNORECASE,
)

# 手机本体关键词
PHONE_BODY_KEYWORDS_RE = re.compile(
    r"\b(smartphone|smartphones|handy\s+ohne\s+vertrag|ohne\s+vertrag|dual\s+sim|sim-free|unlocked\s+cell\s+phone|factory\s+unlocked|ai-smartphone|ai\s+smartphone|android\s+1\d)\b",
    re.IGNORECASE,
)

PHONE_BODY_SPECS_RE = re.compile(
    r"(\b\d+\s*gb\s*(speicher|storage|ram)?\b|\b\d+\s*mp\s*(kamera|camera)?\b|\b\d{4,5}\s*mah\b|\b\d[\.,]\d\s*(zoll|inch)\b)",
    re.IGNORECASE,
)

# 纯屏幕保护膜关键词
SCREEN_PROTECTOR_ONLY_RE = re.compile(
    r"\b(panzerglas|panzer-glas|schutzfolie|displayschutz|screen\s+protector|tempered\s+glass|verre\s+tremp[eé]|cristal\s+templado|pellicola\s+protettiva)\b",
    re.IGNORECASE,
)

SCREEN_PROTECTOR_COMBO_RE = re.compile(
    r"\b(mit\s+(handy)?hülle|with\s+case|\+\s*case|\+\s*hülle|und\s+hülle|\+\s*cover)\b",
    re.IGNORECASE,
)


def _clean_model_token(token: str) -> str:
    """标准化机型标识符，例如 Moto/G/2026 -> MOTO G 2026, S23Plus -> S23 PLUS"""
    t = str(token or "").strip()
    t = t.replace("/", " ").replace("-", " ").replace("_", " ")
    t = re.sub(r"\s+", " ", t).strip()
    return t


def judge_single_asin(
    asin: str,
    target_model_raw: str,
    asin_info: Optional[Dict[str, Any]],
    country: str = "US",
) -> Dict[str, Any]:
    """对单个 ASIN 进行类型与机型兼容性判定。"""
    domain = MARKETPLACE_DOMAINS.get(country.upper(), "com")
    amazon_url = asin_info.get("amazonUrl") if asin_info else f"https://www.amazon.{domain}/dp/{asin}"
    raw_title = (asin_info.get("title") or "").strip() if asin_info else ""
    bullet_points = (asin_info.get("bulletPoints") or []) if asin_info else []

    target = str(target_model_raw or "").strip()
    target_norm = target.upper().replace("/", "").replace("-", "").replace(" ", "").replace("_", "")

    # 判断标题有效性
    has_valid_title = len(raw_title) >= 5
    eval_text = raw_title if has_valid_title else " ".join(bullet_points[:2])
    is_fallback_bullet = not has_valid_title and bool(eval_text)

    display_title = raw_title if has_valid_title else "未返回有效标题（参照兼容性五点）"
    source_prefix = "西柚标题识别为" if has_valid_title else "西柚兼容性五点识别为"
    verify_date = datetime.now().strftime("%Y-%m-%d")

    # 1. 判定是否为手机本体 (Smartphone)
    is_phone_body = False
    if PHONE_BODY_KEYWORDS_RE.search(eval_text) and not CASE_KEYWORDS_RE.search(eval_text):
        is_phone_body = True
    elif PHONE_BODY_SPECS_RE.search(eval_text) and re.search(r"\b(samsung|apple|iphone|xiaomi|redmi|google)\b", eval_text, re.I) and not CASE_KEYWORDS_RE.search(eval_text):
        is_phone_body = True

    if is_phone_body:
        model_found = _extract_model_from_text(eval_text) or target
        return {
            "asin": asin,
            "decision": "否定",
            "title": display_title,
            "reason": f"西柚标题识别为 {model_found} 手机本体；目标 {target}。实际类型为手机本体，否定。",
            "verifySource": amazon_url,
            "verifyDate": verify_date,
            "targetModel": target,
            "identifiedModel": model_found,
            "identifiedType": "手机本体",
        }

    # 2. 判定是否为纯屏幕保护膜 (Screen Protector)
    if SCREEN_PROTECTOR_ONLY_RE.search(eval_text) and not SCREEN_PROTECTOR_COMBO_RE.search(eval_text) and not CASE_KEYWORDS_RE.search(eval_text):
        model_found = _extract_model_from_text(eval_text) or target
        return {
            "asin": asin,
            "decision": "否定",
            "title": display_title,
            "reason": f"西柚标题识别为 {model_found} 屏幕保护膜；目标 {target}。实际类型为屏幕保护膜，否定。",
            "verifySource": amazon_url,
            "verifyDate": verify_date,
            "targetModel": target,
            "identifiedModel": model_found,
            "identifiedType": "屏幕保护膜",
        }

    # 3. 如果标题和五点均为空
    if not eval_text:
        return {
            "asin": asin,
            "decision": "待复核",
            "title": "未获取到商品信息",
            "reason": f"西柚未返回有效商品详情；目标 {target}。机型或类型信息不足，需复核，暂不否定。",
            "verifySource": amazon_url,
            "verifyDate": verify_date,
            "targetModel": target,
            "identifiedModel": "信息不足",
            "identifiedType": "未知",
        }

    # 4. 机型兼容性比对
    identified_model, is_match, is_ambiguous = _check_model_match(eval_text, target, target_norm)

    if is_ambiguous:
        return {
            "asin": asin,
            "decision": "待复核",
            "title": display_title,
            "reason": f"{source_prefix} {identified_model} 手机壳；目标 {target}。机型或类型信息不足，需复核，暂不否定。",
            "verifySource": amazon_url,
            "verifyDate": verify_date,
            "targetModel": target,
            "identifiedModel": identified_model,
            "identifiedType": "手机壳",
        }

    if is_match:
        return {
            "asin": asin,
            "decision": "保留",
            "title": display_title,
            "reason": f"{source_prefix} {identified_model} 手机壳；目标 {target}。匹配目标或符合用户已确认的通用规则，保留。",
            "verifySource": amazon_url,
            "verifyDate": verify_date,
            "targetModel": target,
            "identifiedModel": identified_model,
            "identifiedType": "手机壳",
        }
    else:
        return {
            "asin": asin,
            "decision": "否定",
            "title": display_title,
            "reason": f"{source_prefix} {identified_model} 手机壳；目标 {target}。实际机型不匹配，否定。",
            "verifySource": amazon_url,
            "verifyDate": verify_date,
            "targetModel": target,
            "identifiedModel": identified_model,
            "identifiedType": "手机壳",
        }


def _extract_model_from_text(text: str) -> str:
    """从标题或文本提取手机型号描述"""
    if not text:
        return ""

    # 1. Redmi Note 系列
    m = re.search(
        r"\b(?:Xiaomi\s+)?Redmi\s*Note\s*(\d{1,2}[A-Z]?)\s*(Pro\s*Plus|Pro\s*\+|Pro|Plus|\+|Turbo|S)?\s*(5G|4G)?\b",
        text,
        re.IGNORECASE,
    )
    if m:
        num = m.group(1)
        var = (m.group(2) or "").strip()
        net = (m.group(3) or "").strip()
        parts = ["Redmi Note", num]
        if var:
            parts.append(var)
        if net:
            parts.append(net)
        return " ".join(parts)

    # 2. Redmi 非 Note 系列 (例如 Redmi 17 4G / 5G, Redmi 14C, Redmi A3, Redmi 13C)
    m = re.search(
        r"\b(?:Xiaomi\s+)?Redmi\s*([0-9]{1,2}[A-Z]?|[A-C][0-9]{1,2}[A-Z]?)\s*(4G\s*/\s*5G|5G|4G)?\b",
        text,
        re.IGNORECASE,
    )
    if m:
        code = m.group(1)
        net = (m.group(2) or "").strip()
        parts = ["Redmi", code]
        if net:
            parts.append(net)
        return " ".join(parts)

    # 3. Xiaomi / Mi 系列 (例如 Xiaomi 17T, Xiaomi 15 Ultra, Xiaomi 14T Pro)
    m = re.search(
        r"\b(?:Xiaomi|Mi)\s*(\d{1,2})\s*(T\s*Pro|T|Ultra|Pro|Lite)?\b",
        text,
        re.IGNORECASE,
    )
    if m:
        num = m.group(1)
        var = (m.group(2) or "").strip()
        if var.upper().startswith("T"):
            return f"Xiaomi {num}{var}"
        elif var:
            return f"Xiaomi {num} {var}"
        return f"Xiaomi {num}"

    # 4. Huawei 系列 (例如 Huawei P30 Pro, P30 Lite, Mate 60 Pro, Nova 11)
    m = re.search(
        r"\b(?:Huawei\s+)?(P\d{1,2}|Mate\s*\d{1,2}|Nova\s*\d{1,2}[A-Z]?|Pura\s*\d{1,2})\s*(Pro\s*Plus|Pro\s*\+|Pro|Lite|Plus|Ultra)?\b",
        text,
        re.IGNORECASE,
    )
    if m:
        base = m.group(1).upper()
        if not base.startswith("HUAWEI") and not base.startswith("NOVA") and not base.startswith("MATE"):
            base = f"Huawei {base}"
        var = (m.group(2) or "").strip()
        return f"{base} {var}".strip()

    # 5. iPhone 系列 (包含 IP15, iPhone 15, iPhone 16e, iPhone 17 Pro Max 等)
    m = re.search(
        r"\b(?:Apple\s+)?(?:iPhone|IP)\s*(1[1-9]|[7-9]|X[SR]?|SE)\s*(Pro\s*Max|Pro|Plus|Mini|Air|e)?\b",
        text,
        re.IGNORECASE,
    )
    if m:
        gen = m.group(1).upper()
        var = (m.group(2) or "").strip()
        return f"iPhone {gen} {var}".strip()

    # 6. Samsung S 系列
    m = re.search(r"\b(?:Galaxy\s+)?(S\d{1,2})\s*(Ultra|Plus|\+|FE)?\b", text, re.IGNORECASE)
    if m:
        s_num = m.group(1).upper()
        suffix = (m.group(2) or "").strip()
        if suffix in ("+", "Plus", "plus"):
            return f"{s_num} plus"
        if suffix.lower() == "ultra":
            return f"{s_num} ultra"
        if suffix.lower() == "fe":
            return f"{s_num} fe"
        return s_num

    # 7. Samsung A 系列
    m = re.search(r"\b(?:Galaxy\s+)?(A\d{2}[A-Z]?)\s*(Core|Ultra|Plus|\+|FE|5G|4G)?\b", text, re.IGNORECASE)
    if m:
        a_code = m.group(1).upper()
        suffix = (m.group(2) or "").strip()
        if suffix.lower() == "core":
            return f"{a_code} Core"
        return a_code

    # 8. Google Pixel 系列
    m = re.search(r"\b(?:Google\s+)?Pixel\s*(\d{1,2}[A-Z]?)\s*(Pro\s*XL|Pro|XL|A)?\b", text, re.IGNORECASE)
    if m:
        p_num = m.group(1).upper()
        var = (m.group(2) or "").strip()
        return f"Pixel {p_num} {var}".strip()

    # 9. Motorola Moto G 系列
    m = re.search(
        r"\b(?:Moto(?:rola)?\s+)?(G\s*(?:Play|Power|Stylus|Pure|5G)?\s*\d{4}|G\d{2}[A-Z]?|Edge\s*\d{2}[A-Z]?)\b",
        text,
        re.IGNORECASE,
    )
    if m:
        return f"Moto {m.group(1)}".strip()

    # 10. Honor / OnePlus / Poco 系列
    m = re.search(r"\b(Honor\s*\d{2,3}[A-Z]?|OnePlus\s*\d{1,2}[A-Z]?|Poco\s*[A-Z]\d{1,2}[A-Z]?)\b", text, re.IGNORECASE)
    if m:
        return m.group(1).strip()

    # 11. 标题语法智能回退：提取 pour/for/für/per/para 后的机型关键词
    m = re.search(
        r"\b(?:pour|for|f[üu]r|per|para|compatible\s+with|kompatibel\s+mit)\s+([A-Za-z0-9\s\+\-/]{3,28}?)(?:,|\.|;|\bcase\b|\bcoque\b|\bh[üu]lle\b|\betui\b|\bcover\b|\bmit\b|\bavec\b|\bwith\b|\bcon\b|\band\b|\bund\b|$)",
        text,
        re.IGNORECASE,
    )
    if m:
        candidate = m.group(1).strip()
        if candidate and len(candidate) >= 3 and not re.search(r"\b(homme|femme|cuir|leather|protection|housse|rabat)\b", candidate, re.I):
            return candidate

    return "未知机型"


def _check_model_match(text: str, target: str, target_norm: str) -> Tuple[str, bool, bool]:
    """比对识别机型与目标机型，返回 (identified_model_str, is_match, is_ambiguous)"""
    extracted = _extract_model_from_text(text)

    # 1. iPhone (IP / IPHONE) 系列通用与细分匹配
    # 支持 IP15, IP15Pro, IP15PM, IP15ProMax, IP15Plus, IP16e, IP12/12Pro, IP13, IP17ProMax 等
    # A. 特殊规则：iPhone 12 / 12 Pro 双模组
    if target_norm in ("IP1212PRO", "IPHONE1212PRO"):
        if re.search(r"\b(?:iPhone|IP)\s*12\s*(?:Pro\s*Max|Mini)\b", text, re.I):
            return (extracted, False, False)
        if re.search(r"\b(?:iPhone|IP)\s*12\b", text, re.I):
            return ("iPhone 12 / 12 Pro", True, False)
        return (extracted, False, False)

    # B. 特殊用户确认规则：iPhone 17 Pro Max 与 iPhone 18 Pro Max 通用保留
    if target_norm in ("IP17PROMAX", "IPHONE17PROMAX", "IP18PROMAX", "IPHONE18PROMAX"):
        if re.search(r"\b(?:iPhone|IP)\s*(17|18)\s*Pro\s*Max\b", text, re.I):
            m = re.search(r"\b(?:iPhone|IP)\s*(17|18)\s*Pro\s*Max\b", text, re.I)
            return (m.group(0), True, False)
        return (extracted, False, False)

    # C. 通用 iPhone 解析：IP + 数字 + 变体 (例如 IP15, IP15PRO, IP15PM, IP16E, IP13)
    ip_m = re.match(r"^(?:IP|IPHONE)(1[1-9]|[7-9]|X[SR]?|SE)(PROMAX|PM|PRO|PLUS|MINI|AIR|E)?$", target_norm)
    if ip_m:
        gen = ip_m.group(1)
        var = (ip_m.group(2) or "").upper()
        # 查找文本中的 iPhone / IP 描述
        m_list = re.findall(rf"\b(?:iPhone|IP)\s*{gen}\s*(Pro\s*Max|PM|Pro|Plus|Mini|Air|e)?\b", text, re.I)
        if not m_list:
            # 文本中没有该代 iPhone
            return (extracted, False, False)

        # 比对变体
        # 如果目标是纯 Base (例如 IP15, IP13, IP16, IP11)：严禁匹配 Pro, Plus, Mini, Max, Air, e
        if not var:
            for item in m_list:
                item_var = (item or "").strip().upper()
                if item_var in ("PRO MAX", "PM", "PRO", "PLUS", "MINI", "AIR", "E"):
                    return (f"iPhone {gen} {item.strip()}", False, False)
            return (f"iPhone {gen}", True, False)
        elif var in ("PROMAX", "PM"):
            for item in m_list:
                item_var = (item or "").strip().upper()
                if item_var in ("PRO MAX", "PM"):
                    return (f"iPhone {gen} Pro Max", True, False)
            return (extracted, False, False)
        elif var == "PRO":
            for item in m_list:
                item_var = (item or "").strip().upper()
                if item_var == "PRO":
                    return (f"iPhone {gen} Pro", True, False)
            return (extracted, False, False)
        elif var == "PLUS":
            for item in m_list:
                item_var = (item or "").strip().upper()
                if item_var == "PLUS":
                    return (f"iPhone {gen} Plus", True, False)
            return (extracted, False, False)
        elif var == "E":
            for item in m_list:
                item_var = (item or "").strip().upper()
                if item_var == "E":
                    return (f"iPhone {gen}e", True, False)
            return (extracted, False, False)
        elif var == "MINI":
            for item in m_list:
                item_var = (item or "").strip().upper()
                if item_var == "MINI":
                    return (f"iPhone {gen} Mini", True, False)
            return (extracted, False, False)

    # 2. Xiaomi (XM / XIAOMI / MI) 系列
    # 例如 XM17T -> Xiaomi 17T, XM15 -> Xiaomi 15, XM15Ultra -> Xiaomi 15 Ultra, XM14TPro
    xm_m = re.match(r"^(?:XM|XIAOMI|MI)(\d{1,2})(TPRO|T|ULTRA|PRO|LITE)?$", target_norm)
    if xm_m:
        gen = xm_m.group(1)
        var = (xm_m.group(2) or "").upper()
        m_list = re.findall(rf"\b(?:Xiaomi|Mi|XM)\s*{gen}\s*(T\s*Pro|T|Ultra|Pro|Lite)?\b", text, re.I)
        if not m_list:
            return (extracted, False, False)
        if not var:
            for item in m_list:
                item_var = (item or "").strip().upper()
                if item_var in ("T PRO", "T", "ULTRA", "PRO", "LITE"):
                    return (f"Xiaomi {gen} {item.strip()}", False, False)
            return (f"Xiaomi {gen}", True, False)
        elif var == "T":
            for item in m_list:
                item_var = (item or "").strip().upper().replace(" ", "")
                if item_var == "T":
                    return (f"Xiaomi {gen}T", True, False)
            return (extracted, False, False)
        elif var == "TPRO":
            for item in m_list:
                item_var = (item or "").strip().upper().replace(" ", "")
                if item_var in ("TPRO", "T+PRO"):
                    return (f"Xiaomi {gen}T Pro", True, False)
            return (extracted, False, False)
        elif var in ("ULTRA", "PRO", "LITE"):
            for item in m_list:
                item_var = (item or "").strip().upper()
                if item_var == var:
                    return (f"Xiaomi {gen} {item.strip()}", True, False)
            return (extracted, False, False)

    # 3. Huawei (P / MATE / NOVA / PURA) 系列
    # 例如 P30Lite, P30Pro, P30, Mate40Pro, Nova11
    hw_m = re.match(r"^(P\d{1,2}|MATE\d{1,2}|NOVA\d{1,2}[A-Z]?|PURA\d{1,2})(PROPLUS|PRO\+|PRO|LITE|PLUS|ULTRA)?$", target_norm)
    if hw_m:
        series = hw_m.group(1)
        var = (hw_m.group(2) or "").upper()
        m_list = re.findall(rf"\b(?:Huawei\s+)?{series}\s*(Pro\s*Plus|Pro\s*\+|Pro|Lite|Plus|Ultra)?\b", text, re.I)
        if not m_list:
            return (extracted, False, False)
        if not var:
            for item in m_list:
                item_var = (item or "").strip().upper()
                if item_var in ("PRO PLUS", "PRO+", "PRO", "LITE", "PLUS", "ULTRA"):
                    return (f"Huawei {series} {item.strip()}", False, False)
            return (f"Huawei {series}", True, False)
        else:
            for item in m_list:
                item_var = (item or "").strip().upper().replace("+", "PLUS").replace(" ", "")
                norm_var = var.replace("+", "PLUS")
                if item_var == norm_var:
                    return (f"Huawei {series} {item.strip()}", True, False)
            return (extracted, False, False)

    # 4. Redmi Note 系列
    # 例如 RM/Note/15Pro/5G, RM/Note/17Pro/5G, RM/Note/14/5G, RM/Note/13Pro/5G
    if ("RM" in target_norm or "REDMI" in target_norm) and "NOTE" in target_norm:
        rm_num_m = re.search(r"NOTE(\d{1,2})", target_norm)
        if rm_num_m:
            target_num = rm_num_m.group(1)
            # 在文本中查找对应代 Note
            note_in_text = re.search(
                rf"\b(?:Xiaomi\s+)?Redmi\s*Note\s*{target_num}\s*(Pro\s*Plus|Pro\s*\+|Pro|Plus|\+|Turbo|S)?\s*(5G|4G)?\b",
                text,
                re.I,
            )
            if note_in_text:
                text_var = (note_in_text.group(1) or "").strip().upper().replace("+", "PLUS").replace(" ", "")
                # Note 15 Pro 与 Note 15 Pro Plus 5G (Pro+) 手机壳通用开孔兼容保留
                if target_num == "15" and "PRO" in target_norm:
                    if "PRO" in text_var:
                        return (extracted, True, False)
                if "PRO" in target_norm:
                    if "PRO" in text_var:
                        return (extracted, True, False)
                    return (extracted, False, False)
                elif not text_var:  # Base Note
                    return (extracted, True, False)
            return (extracted, False, False)

    # 5. Motorola G 系列通用匹配规则 (用户确认：Moto G 2026 兼容 Play/Power/Stylus 2026 等)
    if "MOTO" in target_norm and "2026" in target_norm:
        if re.search(r"\bMoto\s+G\b.*2026", text, re.I) or re.search(r"\bMoto\s+G\s*(Play|Power|Stylus|5G)?\s*2026\b", text, re.I):
            m = re.search(r"\bMoto\s+G\s*(Play|Power|Stylus|5G)?\s*2026\b", text, re.I)
            name = m.group(0) if m else "Moto G 2026"
            return (name, True, False)
        elif re.search(r"\bMoto\s+G\b", text, re.I):
            return ("Moto G 不明年代", False, True)
        return (extracted, False, False)

    # 6. Samsung S 系列严格区分 Base, Plus, Ultra, FE
    s_match = re.match(r"^S(\d{1,2})(PLUS|\+|ULTRA|FE)?$", target_norm)
    if s_match:
        gen = s_match.group(1)
        target_variant = (s_match.group(2) or "").upper()
        if target_variant in ("+", "PLUS"):
            target_variant = "PLUS"

        s_in_text = re.findall(rf"\b(?:Galaxy\s+)?S{gen}\s*(Ultra|Plus|\+|FE)?\b", text, re.IGNORECASE)
        s_other_gen = re.findall(r"\b(?:Galaxy\s+)?S(\d{1,2})\s*(Ultra|Plus|\+|FE)?\b", text, re.IGNORECASE)

        if not s_in_text:
            if s_other_gen:
                other_str = f"S{s_other_gen[0][1]} {(s_other_gen[0][2] or '').lower()}".strip()
                return (other_str, False, False)
            return (extracted, False, False)

        if not target_variant:
            for item in s_in_text:
                var = (item[1] or "").upper()
                if var in ("PLUS", "+", "ULTRA", "FE"):
                    return (f"S{gen} {var.lower()}", False, False)
            return (f"S{gen}", True, False)
        elif target_variant == "ULTRA":
            for item in s_in_text:
                var = (item[1] or "").upper()
                if var == "ULTRA":
                    return (f"S{gen} ultra", True, False)
            return (f"S{gen}", False, False)
        elif target_variant == "PLUS":
            for item in s_in_text:
                var = (item[1] or "").upper()
                if var in ("PLUS", "+"):
                    return (f"S{gen} plus", True, False)
            return (f"S{gen}", False, False)
        elif target_variant == "FE":
            for item in s_in_text:
                var = (item[1] or "").upper()
                if var == "FE":
                    return (f"S{gen} fe", True, False)
            return (f"S{gen}", False, False)

    # 7. Samsung A 系列 (A03S, A33, A37, A50, A51/4G, A52, A53, A54, A56, A57)
    if target_norm.startswith("A") and re.match(r"^A\d{2}[A-Z]?(4G|5G)?$", target_norm):
        if target_norm == "A03S":
            if re.search(r"\bA03\s*Core\b", text, re.I):
                return ("A03 Core", False, False)
            if re.search(r"\bA03S\b", text, re.I):
                return ("A03S", True, False)
            return (extracted, False, False)

        if target_norm in ("A52", "A52S"):
            if re.search(r"\bA50\b|\bA05S\b|\bA57\b", text, re.I):
                return (extracted, False, False)
            if re.search(r"\bA52\b|\bA52S\b", text, re.I):
                return ("A52 / A52s", True, False)
            return (extracted, False, False)

        if target_norm == "A56":
            if re.search(r"\bA56\b", text, re.I):
                if re.search(r"\bA36\b", text, re.I):
                    return ("A56 / A36", True, False)
                return ("A56", True, False)
            return (extracted, False, False)

        if target_norm == "A514G":
            if re.search(r"\bA51\s*5G\b", text, re.I):
                return ("A51 5G", False, False)
            if re.search(r"\bA51\s*4G\b|\bA51\b", text, re.I):
                return ("A51 4G", True, False)
            return (extracted, False, False)

        a_target_num = re.search(r"\d{2}", target_norm).group(0)
        found_a = re.findall(r"\bA(\d{2})[A-Z]?\b", text, re.IGNORECASE)
        if a_target_num in found_a:
            return (f"A{a_target_num}", True, False)
        elif found_a:
            return (f"A{found_a[0]}", False, False)
        return (extracted, False, False)

    # 8. Google Pixel 系列
    if "PIXEL" in target_norm:
        if "10" in target_norm:
            if re.search(r"\bPixel\s+10A\b", text, re.I):
                return ("Pixel 10A", False, True)
            if re.search(r"\bPixel\s+10\s*Pro\b|\bPixel\s+10\b", text, re.I):
                return ("Pixel 10 / 10 Pro", True, False)
            return (extracted, False, False)

    # 9. 通用宽松包含 (当 target 是简单词时)
    token = _clean_model_token(target).upper()
    if token and token in text.upper():
        return (token, True, False)

    return (extracted, False, False)


def audit_records_full(
    records: List[Dict[str, Any]],
    country: str = "US",
    campaign_id_mappings: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """
    对完整广告报表行列表进行端到端智能判定：
    1. 提取所有 ASIN
    2. 调取西柚 MCP 获取标题与五点
    3. 执行机型判定与 Campaign ID 匹配
    """
    asins = [r.get("客户搜索词") or r.get("ASIN") or r.get("searchTerm") or "" for r in records]
    asin_info_map = fetch_xiyou_asin_info(asins, country=country)

    # 准备 Campaign ID 映射查找表
    cid_map: Dict[str, str] = {}
    gid_map: Dict[Tuple[str, str], str] = {}
    if campaign_id_mappings:
        for m in campaign_id_mappings:
            c_name = str(m.get("campaignName") or "").strip().lower()
            cid = str(m.get("campaignId") or "").strip()
            g_name = str(m.get("adGroupName") or "").strip().lower()
            gid = str(m.get("adGroupId") or "").strip()
            if c_name and cid:
                cid_map[c_name] = cid
            if c_name and g_name and gid:
                gid_map[(c_name, g_name)] = gid

    judged_list: List[Dict[str, Any]] = []

    for idx, row in enumerate(records, start=1):
        raw_asin = row.get("客户搜索词") or row.get("ASIN") or row.get("searchTerm") or ""
        norm_asin = normalize_asin(raw_asin)
        target_model = row.get("机型") or row.get("model") or ""

        # 如果没有单独的机型列，尝试从广告活动名称解析机型
        camp_name = str(row.get("广告活动名称") or row.get("campaign") or "").strip()
        ad_group_name = str(row.get("广告组名称") or row.get("adGroup") or "").strip()
        if not target_model and camp_name:
            m_suan = re.search(r"SUAN-([^-]+(?:/[^-]+)*)", camp_name, re.I)
            if m_suan:
                target_model = m_suan.group(1)
            else:
                m = re.search(r"\b([A-Za-z0-9]+(?:/[A-Za-z0-9]+)*)\b", camp_name)
                if m:
                    target_model = m.group(1)

        info = asin_info_map.get(norm_asin)
        res = judge_single_asin(norm_asin or raw_asin, target_model, info, country=country)

        # 匹配 Campaign ID 与 Ad Group ID
        camp_lower = camp_name.lower()
        group_lower = ad_group_name.lower()
        matched_cid = row.get("Campaign ID") or cid_map.get(camp_lower, "")
        matched_gid = row.get("Ad Group ID") or gid_map.get((camp_lower, group_lower), "")

        judged_row = {
            "key": f"asin-{idx}-{norm_asin or idx}",
            "index": idx,
            "asin": norm_asin or str(raw_asin),
            "decision": res["decision"],
            "decisionLabel": res["decision"],
            "title": res["title"],
            "reason": res["reason"],
            "verifySource": res["verifySource"],
            "verifyDate": res["verifyDate"],
            "targetModel": target_model,
            "campaignName": camp_name,
            "campaignId": matched_cid,
            "adGroupName": ad_group_name,
            "adGroupId": matched_gid,
            "country": country,
            "rawRow": row,
        }
        judged_list.append(judged_row)

    return judged_list


def create_asin_evaluation_excel(
    judged_records: List[Dict[str, Any]],
    output_path: Path,
    country: str = "US",
) -> Path:
    """生成原生带格式的完整 32 列 ASIN 判定明细 Excel 表格。"""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = f"ASIN判定表_{country}"

    if not judged_records:
        wb.save(output_path)
        return output_path

    # 获取原始列
    first_raw = judged_records[0].get("rawRow") or {}
    raw_keys = [k for k in first_raw.keys() if k not in ("判定", "商品详情标题", "判定依据", "核验来源", "核验日期")]
    headers = list(raw_keys) + ["判定", "商品详情标题", "判定依据", "核验来源", "核验日期"]

    # 样式定义
    header_fill = PatternFill(start_color="1F4E79", end_color="1F4E79", fill_type="solid")
    header_font = Font(name="Microsoft YaHei", size=11, bold=True, color="FFFFFF")
    data_font = Font(name="Microsoft YaHei", size=10)
    center_align = Alignment(horizontal="center", vertical="center", wrap_text=False)
    left_align = Alignment(horizontal="left", vertical="center", wrap_text=False)

    thin_border = Border(
        left=Side(style="thin", color="D9D9D9"),
        right=Side(style="thin", color="D9D9D9"),
        top=Side(style="thin", color="D9D9D9"),
        bottom=Side(style="thin", color="D9D9D9"),
    )

    deny_fill = PatternFill(start_color="FCE8E6", end_color="FCE8E6", fill_type="solid")
    deny_font = Font(name="Microsoft YaHei", size=10, bold=True, color="C5221F")

    keep_fill = PatternFill(start_color="E6F4EA", end_color="E6F4EA", fill_type="solid")
    keep_font = Font(name="Microsoft YaHei", size=10, bold=True, color="137333")

    review_fill = PatternFill(start_color="FEF7E0", end_color="FEF7E0", fill_type="solid")
    review_font = Font(name="Microsoft YaHei", size=10, bold=True, color="B06000")

    link_font = Font(name="Microsoft YaHei", size=10, color="1A73E8", underline="single")

    # 写表头
    ws.row_dimensions[1].height = 26
    for col_idx, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col_idx, value=h)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = center_align
        cell.border = thin_border

    # 写数据行
    for row_idx, item in enumerate(judged_records, 2):
        ws.row_dimensions[row_idx].height = 22
        raw = item.get("rawRow") or {}
        # 写入原列
        for col_idx, k in enumerate(raw_keys, 1):
            val = raw.get(k)
            c = ws.cell(row=row_idx, column=col_idx, value=val)
            c.font = data_font
            c.border = thin_border
            c.alignment = center_align if k in ("客户搜索词", "机型", "国家/地区", "开始日期", "结束日期") else left_align

        # 写入 5 个追加列
        base_col = len(raw_keys)
        # 判定
        decision = item.get("decision", "")
        c_dec = ws.cell(row=row_idx, column=base_col + 1, value=decision)
        c_dec.border = thin_border
        c_dec.alignment = center_align
        if decision == "否定":
            c_dec.fill = deny_fill
            c_dec.font = deny_font
        elif decision == "保留":
            c_dec.fill = keep_fill
            c_dec.font = keep_font
        else:
            c_dec.fill = review_fill
            c_dec.font = review_font

        # 商品详情标题
        c_title = ws.cell(row=row_idx, column=base_col + 2, value=item.get("title", ""))
        c_title.font = data_font
        c_title.alignment = left_align
        c_title.border = thin_border

        # 判定依据
        c_reason = ws.cell(row=row_idx, column=base_col + 3, value=item.get("reason", ""))
        c_reason.font = data_font
        c_reason.alignment = left_align
        c_reason.border = thin_border

        # 核验来源
        src_url = item.get("verifySource", "")
        c_src = ws.cell(row=row_idx, column=base_col + 4, value=src_url)
        c_src.font = link_font if src_url else data_font
        if src_url and src_url.startswith("http"):
            c_src.hyperlink = src_url
        c_src.alignment = left_align
        c_src.border = thin_border

        # 核验日期
        c_date = ws.cell(row=row_idx, column=base_col + 5, value=item.get("verifyDate", ""))
        c_date.font = data_font
        c_date.alignment = center_align
        c_date.border = thin_border

    # 自动列宽调整
    for col in ws.columns:
        col_letter = get_column_letter(col[0].column)
        max_len = 0
        for cell in col:
            v_str = str(cell.value or "")
            max_len = max(max_len, len(v_str.encode("gbk", errors="ignore")))
        ws.column_dimensions[col_letter].width = min(max(max_len + 3, 12), 60)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(output_path)
    return output_path


def create_amazon_upload_template(
    judged_records: List[Dict[str, Any]],
    output_path: Path,
    scope: str = "campaign",
) -> Tuple[Path, int]:
    """生成 Amazon 官方否商品定向批量上传模板 (只包含 decision == '否定' 且有 ID 的记录)。"""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Campaign Negative Targets" if scope == "campaign" else "Negative Targets"

    headers = [
        "Product",
        "Entity",
        "Operation",
        "Campaign ID",
        "Ad Group ID",
        "Portfolio ID",
        "Campaign Name",
        "Ad Group Name",
        "Targeting Expression",
        "Targeting Text",
    ]

    ws.row_dimensions[1].height = 24
    header_fill = PatternFill(start_color="333333", end_color="333333", fill_type="solid")
    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    for col_idx, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col_idx, value=h)
        cell.fill = header_fill
        cell.font = header_font

    count = 0
    row_num = 2
    for item in judged_records:
        if item.get("decision") != "否定":
            continue
        asin = normalize_asin(item.get("asin"))
        if not asin:
            continue
        cid = str(item.get("campaignId") or "").strip()
        gid = str(item.get("adGroupId") or "").strip()
        cname = str(item.get("campaignName") or "").strip()
        gname = str(item.get("adGroupName") or "").strip()

        if scope == "campaign":
            entity = "Campaign Negative Product Targeting"
            row_data = [
                "Sponsored Products",
                entity,
                "Create",
                cid,
                "",  # Campaign 级别 Ad Group ID 留空
                "",
                cname,
                "",
                f'asin="{asin}"',
                f'asin="{asin}"',
            ]
        else:
            entity = "Negative Product Targeting"
            row_data = [
                "Sponsored Products",
                entity,
                "Create",
                cid,
                gid,
                "",
                cname,
                gname,
                f'asin="{asin}"',
                f'asin="{asin}"',
            ]

        ws.row_dimensions[row_num].height = 20
        for col_idx, val in enumerate(row_data, 1):
            ws.cell(row=row_num, column=col_idx, value=val)
        row_num += 1
        count += 1

    output_path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(output_path)
    return output_path, count


def export_asin_audit_folder(
    judged_records: List[Dict[str, Any]],
    country: str = "US",
    scope: str = "campaign",
    output_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """
    一键生成判定文件夹：
    - ASIN判定表_{country}_{时间戳}.xlsx
    - Amazon否ASIN上传模板_{country}_{scope}_{时间戳}.xlsx
    - 并在 Windows Explorer 打开
    """
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    if not output_dir:
        base_dir = Path("C:/Users/admin/AMZ")
        if not base_dir.exists():
            base_dir = Path(os.path.expanduser("~")) / "AMZ"
        folder = base_dir / f"ASIN判定结果_{country}_{ts}"
    else:
        folder = Path(output_dir) / f"ASIN判定结果_{country}_{ts}"

    folder.mkdir(parents=True, exist_ok=True)

    excel_file = folder / f"ASIN判定表_{country}_{ts}.xlsx"
    create_asin_evaluation_excel(judged_records, excel_file, country=country)

    tpl_file = folder / f"Amazon否ASIN上传模板_{country}_{scope}_{ts}.xlsx"
    _, deny_count = create_amazon_upload_template(judged_records, tpl_file, scope=scope)

    return {
        "ok": True,
        "folderPath": str(folder),
        "folderName": folder.name,
        "excelFile": str(excel_file),
        "excelFileName": excel_file.name,
        "templateFile": str(tpl_file),
        "templateFileName": tpl_file.name,
        "totalRecords": len(judged_records),
        "denyCount": deny_count,
    }


def open_folder_in_explorer(folder_path: str) -> bool:
    """在 Windows 资源管理器中打开指定文件夹。"""
    p = Path(folder_path)
    if not p.exists():
        return False
    try:
        if os.name == "nt":
            os.startfile(str(p))
            return True
        else:
            subprocess.Popen(["xdg-open", str(p)])
            return True
    except Exception as e:
        print(f"Failed to open folder: {e}")
        return False
