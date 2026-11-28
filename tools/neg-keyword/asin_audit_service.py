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
    # Samsung S 系列
    m = re.search(r"\b(Galaxy\s+)?(S\d{1,2})\s*(Ultra|Plus|\+|FE)?\b", text, re.IGNORECASE)
    if m:
        s_num = m.group(2).upper()
        suffix = (m.group(3) or "").strip()
        if suffix in ("+", "Plus", "plus"):
            return f"{s_num} plus"
        if suffix.lower() == "ultra":
            return f"{s_num} ultra"
        if suffix.lower() == "fe":
            return f"{s_num} fe"
        return s_num

    # Samsung A 系列
    m = re.search(r"\b(Galaxy\s+)?(A\d{2}[A-Z]?)\s*(Core|Ultra|Plus|\+|FE|5G|4G)?\b", text, re.IGNORECASE)
    if m:
        a_code = m.group(2).upper()
        suffix = (m.group(3) or "").strip()
        if suffix.lower() == "core":
            return f"{a_code} Core"
        return a_code

    # iPhone 系列
    m = re.search(r"\b(iPhone|IP)\s*(\d{1,2})\s*(Pro\s*Max|Pro|Plus|Mini)?\b", text, re.IGNORECASE)
    if m:
        num = m.group(2)
        suf = (m.group(3) or "").strip()
        return f"iPhone {num} {suf}".strip()

    # Redmi Note 系列
    m = re.search(r"\b(Redmi\s+Note\s+\d{1,2}[A-Z]?(\s*Pro\s*\+?|\s*Pro)?)(\s*(5G|4G))?\b", text, re.IGNORECASE)
    if m:
        return m.group(0).strip()

    # Google Pixel 系列
    m = re.search(r"\b(Pixel\s+\d{1,2}[A-Z]?)(\s*(Pro|XL|A))?\b", text, re.IGNORECASE)
    if m:
        return m.group(0).strip()

    # Motorola Moto G 系列
    m = re.search(r"\b(Moto\s+G\s*(Play|Power|Stylus|5G)?\s*\d{4})\b", text, re.IGNORECASE)
    if m:
        return m.group(0).strip()

    return "识别型号"


def _check_model_match(text: str, target: str, target_norm: str) -> Tuple[str, bool, bool]:
    """比对识别机型与目标机型，返回 (identified_model_str, is_match, is_ambiguous)"""
    # 1. Motorola G 系列通用匹配规则 (用户确认：Moto G 2026 兼容 Play/Power/Stylus 2026 等)
    if "MOTO" in target_norm and "2026" in target_norm:
        if re.search(r"\bMoto\s+G\b.*2026", text, re.I) or re.search(r"\bMoto\s+G\s*(Play|Power|Stylus|5G)?\s*2026\b", text, re.I):
            m = re.search(r"\bMoto\s+G\s*(Play|Power|Stylus|5G)?\s*2026\b", text, re.I)
            name = m.group(0) if m else "Moto G 2026"
            return (name, True, False)
        elif re.search(r"\bMoto\s+G\b", text, re.I):
            # Moto G 但年份或代际不明
            return ("Moto G 不明年代", False, True)
        else:
            other = _extract_model_from_text(text)
            return (other, False, False)

    # 2. iPhone 17 Pro Max 用户确认规则：iPhone 17 Pro Max 与 iPhone 18 Pro Max 通用保留
    if target_norm in ("IP17PROMAX", "IPHONE17PROMAX"):
        if re.search(r"\b(iPhone|IP)\s*(17|18)\s*Pro\s*Max\b", text, re.I):
            m = re.search(r"\b(iPhone|IP)\s*(17|18)\s*Pro\s*Max\b", text, re.I)
            return (m.group(0), True, False)
        other = _extract_model_from_text(text)
        return (other, False, False)

    # 3. iPhone 系列细分 (IP12/12Pro, IP13, IP15Pro 等)
    if target_norm in ("IP1212PRO", "IPHONE1212PRO"):
        if re.search(r"\b(iPhone|IP)\s*12\s*Pro\s*Max\b", text, re.I) or re.search(r"\b(iPhone|IP)\s*12\s*Mini\b", text, re.I):
            other = _extract_model_from_text(text)
            return (other, False, False)
        if re.search(r"\b(iPhone|IP)\s*12(\s*/\s*12\s*Pro|\s*Pro)?\b", text, re.I):
            return ("iPhone 12 / 12 Pro", True, False)
        return (_extract_model_from_text(text), False, False)

    if target_norm in ("IP13", "IPHONE13"):
        if re.search(r"\b(iPhone|IP)\s*13\s*(Pro\s*Max|Pro|Mini)\b", text, re.I):
            return (_extract_model_from_text(text), False, False)
        if re.search(r"\b(iPhone|IP)\s*13\b", text, re.I):
            return ("iPhone 13", True, False)
        return (_extract_model_from_text(text), False, False)

    if target_norm in ("IP15PRO", "IPHONE15PRO"):
        if re.search(r"\b(iPhone|IP)\s*15\s*Pro\s*Max\b", text, re.I):
            return ("iPhone 15 Pro Max", False, False)
        if re.search(r"\b(iPhone|IP)\s*15\s*Pro\b", text, re.I):
            return ("iPhone 15 Pro", True, False)
        return (_extract_model_from_text(text), False, False)

    # 4. Samsung S 系列严格区分 Base, Plus, Ultra, FE
    # 示例目标：S10, S21, S23, S23Plus, S23Ultra, S24FE, S24Ultra, S25, S25Plus, S25FE, S26, S26Ultra
    s_match = re.match(r"^S(\d{1,2})(PLUS|\+|ULTRA|FE)?$", target_norm)
    if s_match:
        gen = s_match.group(1)
        target_variant = (s_match.group(2) or "").upper()
        if target_variant in ("+", "PLUS"):
            target_variant = "PLUS"

        # 检查标题中的 S 系列提及
        s_in_text = re.findall(rf"\b(Galaxy\s+)?S{gen}\s*(Ultra|Plus|\+|FE)?\b", text, re.IGNORECASE)
        s_other_gen = re.findall(r"\b(Galaxy\s+)?S(\d{1,2})\s*(Ultra|Plus|\+|FE)?\b", text, re.IGNORECASE)

        if not s_in_text:
            # 提及了其它 S 代号
            if s_other_gen:
                other_str = f"S{s_other_gen[0][1]} {(s_other_gen[0][2] or '').lower()}".strip()
                return (other_str, False, False)
            return (_extract_model_from_text(text), False, False)

        # 存在该代号，比对变体
        # 如果目标是纯 Base (如 S21, S23, S25, S26)
        if not target_variant:
            for item in s_in_text:
                var = (item[1] or "").upper()
                if var in ("PLUS", "+", "ULTRA", "FE"):
                    return (f"S{gen} {var.lower()}", False, False)
            # 无变体后缀，匹配 Base
            return (f"S{gen}", True, False)
        elif target_variant == "ULTRA":
            for item in s_in_text:
                var = (item[1] or "").upper()
                if var == "ULTRA":
                    return (f"S{gen} ultra", True, False)
            # 没有 Ultra
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

    # 5. Samsung A 系列 (A03S, A33, A37, A50, A51/4G, A52, A53, A54, A56, A57)
    if target_norm.startswith("A") and re.match(r"^A\d{2}[A-Z]?(4G|5G)?$", target_norm):
        if target_norm == "A03S":
            if re.search(r"\bA03\s*Core\b", text, re.I):
                return ("A03 Core", False, False)
            if re.search(r"\bA03S\b", text, re.I):
                return ("A03S", True, False)
            return (_extract_model_from_text(text), False, False)

        if target_norm in ("A52", "A52S"):
            if re.search(r"\bA50\b", text, re.I) or re.search(r"\bA05S\b", text, re.I) or re.search(r"\bA57\b", text, re.I):
                return (_extract_model_from_text(text), False, False)
            if re.search(r"\bA52\b|\bA52S\b", text, re.I):
                return ("A52 / A52s", True, False)
            return (_extract_model_from_text(text), False, False)

        if target_norm == "A56":
            if re.search(r"\bA56\b", text, re.I):
                # 兼容 A56 / A36
                if re.search(r"\bA36\b", text, re.I):
                    return ("A56 / A36", True, False)
                return ("A56", True, False)
            return (_extract_model_from_text(text), False, False)

        if target_norm == "A514G":
            if re.search(r"\bA51\s*5G\b", text, re.I):
                return ("A51 5G", False, False)
            if re.search(r"\bA51\s*4G\b|\bA51\b", text, re.I):
                return ("A51 4G", True, False)
            return (_extract_model_from_text(text), False, False)

        # 其它 A 系列如 A33, A37, A53, A54, A57
        a_target_num = re.search(r"\d{2}", target_norm).group(0)
        found_a = re.findall(r"\bA(\d{2})[A-Z]?\b", text, re.IGNORECASE)
        if a_target_num in found_a:
            return (f"A{a_target_num}", True, False)
        elif found_a:
            return (f"A{found_a[0]}", False, False)
        return (_extract_model_from_text(text), False, False)

    # 6. Redmi Note 系列
    if "RM" in target_norm or "REDMI" in target_norm or "NOTE" in target_norm:
        if "14" in target_norm and "5G" in target_norm:
            if re.search(r"\bRedmi\s+Note\s+14\s*4G\b", text, re.I):
                return ("Redmi Note 14 4G", False, False)
            if re.search(r"\bRedmi\s+Note\s+14\s*5G\b", text, re.I):
                return ("Redmi Note 14 5G", True, False)
            return (_extract_model_from_text(text), False, False)

        if "13PRO" in target_norm and "5G" in target_norm:
            if re.search(r"\bRedmi\s+Note\s+13\s*Pro\s*5G\b", text, re.I):
                return ("Redmi Note 13 Pro 5G", True, False)
            return (_extract_model_from_text(text), False, False)

    # 7. Google Pixel 系列
    if "PIXEL" in target_norm:
        if "10" in target_norm:
            if re.search(r"\bPixel\s+10A\b", text, re.I):
                return ("Pixel 10A", False, True)
            if re.search(r"\bPixel\s+10\s*Pro\b|\bPixel\s+10\b", text, re.I):
                return ("Pixel 10 / 10 Pro", True, False)
            return (_extract_model_from_text(text), False, False)

    # 通用宽松包含
    token = _clean_model_token(target).upper()
    if token and token in text.upper():
        return (token, True, False)

    extracted = _extract_model_from_text(text)
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
