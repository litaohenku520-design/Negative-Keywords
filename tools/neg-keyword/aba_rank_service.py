# -*- coding: utf-8 -*-
"""
ABA 搜索词排名统计与一键周更服务
================================
- 支持读取 ABA搜索词.xlsx（或前端上传的 xlsx）
- 按 aba_model_rules.json 匹配公司机型并过滤非手机品类词
- 自动将当前 SearchTermRank 旧数据归档至「上周数据」
- 自动生成「搜索词详细排名分布」并按 RankVolCurve 逐词插值计算预估搜索量
- 自动更新「SearchTermRank」并按新热度指数（全词预估总搜索量/1000）自动降序排列
"""
from __future__ import annotations

import base64
import io
import json
import math
import os
import re
import shutil
import subprocess
import time
from collections import defaultdict
from copy import copy
from datetime import datetime
from pathlib import Path
from typing import Any

import openpyxl

HERE = Path(__file__).resolve().parent
RULES_FILE = HERE / "aba_model_rules.json"
BACKUPS_DIR = HERE / "backups"

DEFAULT_RANK_DIR = Path(r"C:\Users\admin\DeskBox\Suanpot-Suanduck\suanpot\搜索词排行")
DEFAULT_SOURCE_PATH = DEFAULT_RANK_DIR / "ABA搜索词.xlsx"
DEFAULT_TARGET_PATH = DEFAULT_RANK_DIR / "suanpot美国搜索词排名11.26.xlsx"

BUCKETS = [
    ("1-10000", 1, 10000),
    ("10001-30000", 10001, 30000),
    ("30001-50000", 30001, 50000),
    ("50001-70000", 50001, 70000),
    ("70001-100000", 70001, 100000),
    ("100001-200000", 100001, 200000),
]


def _load_rules() -> dict[str, Any]:
    with open(RULES_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def _normalize_kw(kw: str) -> str:
    s = kw.lower().strip()
    s = re.sub(r"\bi\s+phone\b", "iphone", s)
    s = re.sub(r"\bmac\s+book\b", "macbook", s)
    s = re.sub(r"\bair\s+pod(s?)\b", r"airpod\1", s)
    s = re.sub(r"\bzfold\b", "z fold", s)
    s = re.sub(r"\bzflip\b", "z flip", s)
    s = re.sub(r"\biphone(\d+)", r"iphone \1", s)
    s = re.sub(r"\bpromax\b", "pro max", s)
    s = re.sub(r"\s+", " ", s)
    return s


def _compile_matcher(rules: dict[str, Any]):
    phrase_to_model: dict[str, str] = rules.get("phrase_to_model") or {}
    excl_words = tuple(rules.get("exclude_keywords") or [])
    iphone_short = set(rules.get("iphone_only_short") or [])
    samsung_short = set(rules.get("samsung_only_short") or [])

    # Sort longest-first; prefer specific "pro max"/"pro" over bare "iphone 18"
    sorted_phrases = sorted(
        phrase_to_model.keys(),
        key=lambda p: (len(p), "pro max" in p or "ultra" in p),
        reverse=True,
    )
    compiled = [
        (ph, phrase_to_model[ph], re.compile(r"(?<![a-z0-9])" + re.escape(ph) + r"(?![a-z0-9])"))
        for ph in sorted_phrases
    ]

    def match_kw(raw_kw: str) -> tuple[str | None, str | None]:
        kl = _normalize_kw(raw_kw)
        if any(ex in kl for ex in excl_words):
            return None, None
        for ph, model, pat in compiled:
            if pat.search(kl):
                if ph in iphone_short and any(
                    b in kl
                    for b in ("samsung", "galaxy", "pixel", "moto", "motorola", "oneplus", "google", "redmi", "xiaomi", "surface", "zenfone")
                ):
                    continue
                if ph in samsung_short and any(
                    b in kl for b in ("iphone", "apple", "pixel", "moto", "motorola", "oneplus", "google")
                ):
                    continue
                return model, ph
        return None, None

    return match_kw


def _bucket_name(rank: int) -> str:
    for name, lo, hi in BUCKETS:
        if lo <= rank <= hi:
            return name
    return "100001-200000"


def _interp_vol(rank: int, rv: list[tuple[int, float]]) -> float:
    if not rv or rank <= 0:
        return 0.0
    if rank <= rv[0][0]:
        r0, v0 = rv[0]
        r1, v1 = rv[1]
        return math.exp(math.log(v0) + (math.log(rank) - math.log(r0)) / (math.log(r1) - math.log(r0)) * (math.log(v1) - math.log(v0)))
    if rank >= rv[-1][0]:
        return float(rv[-1][1])
    for i in range(len(rv) - 1):
        r0, v0 = rv[i]
        r1, v1 = rv[i + 1]
        if r0 <= rank <= r1:
            return math.exp(math.log(v0) + (math.log(rank) - math.log(r0)) / (math.log(r1) - math.log(r0)) * (math.log(v1) - math.log(v0)))
    return float(rv[-1][1])


def _copy_style(src_cell, dst_cell) -> None:
    if src_cell.has_style:
        dst_cell.font = copy(src_cell.font)
        dst_cell.fill = copy(src_cell.fill)
        dst_cell.border = copy(src_cell.border)
        dst_cell.alignment = copy(src_cell.alignment)
        dst_cell.number_format = src_cell.number_format


def _excel_recalc(path: Path) -> bool:
    ps = (
        f'$p="{str(path)}"; '
        '$e=New-Object -ComObject Excel.Application; '
        '$e.Visible=$false; $e.DisplayAlerts=$false; '
        '$w=$e.Workbooks.Open($p); '
        '$e.CalculateFullRebuild(); $w.Save(); $w.Close($false); $e.Quit()'
    )
    try:
        res = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True,
            text=True,
            timeout=60,
        )
        return res.returncode == 0
    except Exception:
        return False


def get_aba_rank_state(
    target_path: str | None = None,
    source_path: str | None = None,
) -> dict[str, Any]:
    t_path = Path(target_path) if target_path else DEFAULT_TARGET_PATH
    s_path = Path(source_path) if source_path else DEFAULT_SOURCE_PATH

    if not t_path.exists():
        raise FileNotFoundError(f"目标排名文件不存在: {t_path}")

    wb = openpyxl.load_workbook(t_path, data_only=True)
    ws = wb["SearchTermRank"]

    ranks = []
    for r in range(2, 133):
        tp = ws.cell(r, 1).value
        if not tp:
            continue
        ranks.append({
            "row": r,
            "type": tp,
            "b1": ws.cell(r, 2).value or 0,
            "b2": ws.cell(r, 3).value or 0,
            "b3": ws.cell(r, 4).value or 0,
            "b4": ws.cell(r, 5).value or 0,
            "b5": ws.cell(r, 6).value or 0,
            "b6": ws.cell(r, 7).value or 0,
            "bestKw": ws.cell(r, 8).value or "",
            "bestRank": ws.cell(r, 9).value or 0,
            "heatScore": round(float(ws.cell(r, 10).value or 0), 1),
            "totalTerms": int(ws.cell(r, 11).value or 0),
            "heatRank": ws.cell(r, 12).value or "",
            "lastHeat": round(float(ws.cell(r, 13).value or 0), 1),
            "lastTotalTerms": int(ws.cell(r, 14).value or 0),
            "lastRank": ws.cell(r, 15).value or 0,
            "rankChange": ws.cell(r, 16).value or "—",
            "estTotalVol": int(round(float(ws.cell(r, 24).value or 0))),
            "trafficRank": ws.cell(r, 25).value or "",
        })

    ws_det = wb["搜索词详细排名分布"]
    matched_terms = 0
    unmatched_terms = 0
    detail_preview = []
    for r in range(2, ws_det.max_row + 1):
        st = ws_det.cell(r, 6).value
        if st == "唯一匹配":
            matched_terms += 1
        elif st:
            unmatched_terms += 1
        if len(detail_preview) < 300:
            detail_preview.append({
                "row": r - 1,
                "abaRank": ws_det.cell(r, 2).value,
                "keyword": ws_det.cell(r, 3).value,
                "model": ws_det.cell(r, 4).value or "—",
                "bucket": ws_det.cell(r, 5).value,
                "status": st,
                "hit": ws_det.cell(r, 7).value or "—",
                "estVol": int(round(float(ws_det.cell(r, 8).value or 0))) if ws_det.max_column >= 8 else 0,
            })

    active_models = sum(1 for x in ranks if x["totalTerms"] > 0)
    return {
        "sourcePath": str(s_path),
        "sourceExists": s_path.exists(),
        "sourceMtime": datetime.fromtimestamp(s_path.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S") if s_path.exists() else "",
        "targetPath": str(t_path),
        "targetExists": t_path.exists(),
        "targetMtime": datetime.fromtimestamp(t_path.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        "summary": {
            "totalModels": len(ranks),
            "activeModels": active_models,
            "matchedTerms": matched_terms,
            "unmatchedTerms": unmatched_terms,
            "totalTerms": matched_terms + unmatched_terms,
        },
        "ranks": ranks,
        "detailPreview": detail_preview,
    }


def import_aba_and_update(
    source_path: str | None = None,
    target_path: str | None = None,
    file_base64: str | None = None,
    file_name: str | None = None,
    run_excel_recalc: bool = True,
) -> dict[str, Any]:
    t0 = time.time()
    t_path = Path(target_path) if target_path else DEFAULT_TARGET_PATH
    s_path = Path(source_path) if source_path else DEFAULT_SOURCE_PATH

    if not t_path.exists():
        raise FileNotFoundError(f"目标排名文件不存在: {t_path}")

    # 1. Read source ABA workbook
    if file_base64:
        raw = base64.b64decode(file_base64.split(",")[-1])
        wb_aba = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    else:
        if not s_path.exists():
            raise FileNotFoundError(f"ABA 搜索词文件不存在: {s_path}")
        wb_aba = openpyxl.load_workbook(s_path, read_only=True, data_only=True)

    ws_aba = wb_aba.active
    aba_iter = ws_aba.iter_rows(values_only=True)
    header = next(aba_iter, None)
    if not header:
        raise ValueError("ABA 搜索词文件为空")

    # Find rank & keyword column indices
    rank_idx = 0
    kw_idx = 1
    for idx, col in enumerate(header):
        cstr = str(col or "").strip()
        if "排名" in cstr or "rank" in cstr.lower():
            rank_idx = idx
        elif "搜索词" in cstr or "search term" in cstr.lower() or "keyword" in cstr.lower():
            kw_idx = idx

    aba_items: list[tuple[int, int, str]] = []
    for row_num, row in enumerate(aba_iter, start=2):
        if not row or len(row) <= max(rank_idx, kw_idx):
            continue
        rk = row[rank_idx]
        kw = row[kw_idx]
        if rk is None or not kw:
            continue
        try:
            rk_int = int(rk)
        except (TypeError, ValueError):
            continue
        aba_items.append((row_num, rk_int, str(kw).strip()))

    if not aba_items:
        raise ValueError("未在 ABA 搜索词文件中解析到有效搜索词数据")

    # 2. Backup target file before modifying
    BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    bak_path = BACKUPS_DIR / f"aba_rank_{ts}.xlsx"
    shutil.copy2(t_path, bak_path)

    # 3. Read current cached values for 上周数据 archive + RankVolCurve
    wb_val = openpyxl.load_workbook(t_path, data_only=True)
    ws_val = wb_val["SearchTermRank"]
    ws_rv = wb_val["RankVolCurve"]
    rv = sorted(
        [(int(ws_rv.cell(r, 1).value), float(ws_rv.cell(r, 2).value)) for r in range(2, ws_rv.max_row + 1) if ws_rv.cell(r, 1).value]
    )

    last_week_rows = []
    for r in range(2, 133):
        tp = ws_val.cell(r, 1).value
        if not tp:
            continue
        vals_ak = [ws_val.cell(r, c).value for c in range(1, 12)]  # A..K
        l_rank = ws_val.cell(r, 12).value  # 新热度排名 -> 上周排名
        w_vol = ws_val.cell(r, 23).value  # Best预估搜索量(插值)
        r_bonus = ws_val.cell(r, 18).value  # Best_Rank加分
        last_week_rows.append(vals_ak + [l_rank, w_vol, r_bonus])

    # 4. Match ABA items using rules
    rules = _load_rules()
    all_models: list[str] = rules.get("models") or []
    match_kw = _compile_matcher(rules)

    det_rows = []
    model_buckets: dict[str, list[int]] = {m: [0, 0, 0, 0, 0, 0] for m in all_models}
    model_best: dict[str, tuple[int, str]] = {}
    model_est_vol: dict[str, float] = defaultdict(float)
    matched_cnt = 0
    unmatched_cnt = 0

    for src_row, rk, kw in aba_items:
        model, hit = match_kw(kw)
        b_name = _bucket_name(rk)
        if model and model in model_buckets:
            matched_cnt += 1
            status = "唯一匹配"
            b_idx = next((i for i, (bn, _, _) in enumerate(BUCKETS) if bn == b_name), 5)
            model_buckets[model][b_idx] += 1
            if model not in model_best or rk < model_best[model][0]:
                model_best[model] = (rk, kw)
            model_est_vol[model] += _interp_vol(rk, rv)
        else:
            unmatched_cnt += 1
            model = None
            hit = None
            status = "未匹配模板型号"
        det_rows.append((src_row, rk, kw, model, b_name, status, hit))

    # 5. Open target workbook in write mode & update
    wb = openpyxl.load_workbook(t_path)

    # 5a. Replace 上周数据 with old SearchTermRank snapshot
    ws_lw = wb["上周数据"]
    ws_lw["L1"].value = "上周排名"
    for r in range(2, ws_lw.max_row + 1):
        for c in range(1, 15):
            ws_lw.cell(r, c).value = None
    for idx, row_vals in enumerate(last_week_rows):
        rr = 2 + idx
        for c, val in enumerate(row_vals, 1):
            ws_lw.cell(rr, c).value = val

    # 5b. Write new 搜索词详细排名分布
    ws_det = wb["搜索词详细排名分布"]
    ws_det["H1"].value = "预估搜索量"
    _copy_style(ws_det["G1"], ws_det["H1"])
    old_det_max = ws_det.max_row
    for idx, (src_row, rk, kw, model, b_name, status, hit) in enumerate(det_rows):
        rr = 2 + idx
        ws_det.cell(rr, 1).value = src_row
        ws_det.cell(rr, 2).value = rk
        ws_det.cell(rr, 3).value = kw
        ws_det.cell(rr, 4).value = model
        ws_det.cell(rr, 5).value = b_name
        ws_det.cell(rr, 6).value = status
        ws_det.cell(rr, 7).value = hit
        ws_det.cell(rr, 8).value = (
            f'=IF(F{rr}<>"唯一匹配",0,'
            f'IFERROR(IF(B{rr}<INDEX(RankVolCurve!$A$2:$A$89,1),'
            f'EXP(LN(INDEX(RankVolCurve!$B$2:$B$89,1))+(LN(B{rr})-LN(INDEX(RankVolCurve!$A$2:$A$89,1)))/(LN(INDEX(RankVolCurve!$A$2:$A$89,2))-LN(INDEX(RankVolCurve!$A$2:$A$89,1)))*(LN(INDEX(RankVolCurve!$B$2:$B$89,2))-LN(INDEX(RankVolCurve!$B$2:$B$89,1)))),'
            f'IF(B{rr}>=INDEX(RankVolCurve!$A$2:$A$89,COUNT(RankVolCurve!$A$2:$A$89)),'
            f'INDEX(RankVolCurve!$B$2:$B$89,COUNT(RankVolCurve!$A$2:$A$89)),'
            f'EXP(LN(INDEX(RankVolCurve!$B$2:$B$89,MATCH(B{rr},RankVolCurve!$A$2:$A$89,1)))+'
            f'(LN(B{rr})-LN(INDEX(RankVolCurve!$A$2:$A$89,MATCH(B{rr},RankVolCurve!$A$2:$A$89,1))))/'
            f'(LN(INDEX(RankVolCurve!$A$2:$A$89,MATCH(B{rr},RankVolCurve!$A$2:$A$89,1)+1))-LN(INDEX(RankVolCurve!$A$2:$A$89,MATCH(B{rr},RankVolCurve!$A$2:$A$89,1))))*'
            f'(LN(INDEX(RankVolCurve!$B$2:$B$89,MATCH(B{rr},RankVolCurve!$A$2:$A$89,1)+1))-LN(INDEX(RankVolCurve!$B$2:$B$89,MATCH(B{rr},RankVolCurve!$A$2:$A$89,1))))))),'
            f'ROUND(26932000*B{rr}^-0.7534,0)))'
        )
        ws_det.cell(rr, 8).number_format = "#,##0"

    if old_det_max > 1 + len(det_rows):
        for rr in range(2 + len(det_rows), old_det_max + 1):
            for c in range(1, 9):
                ws_det.cell(rr, c).value = None

    # 5c. Sort models by EstTotalVol descending, then Best_Rank ascending, zero-term models at bottom
    sorted_models = sorted(
        all_models,
        key=lambda m: (
            1 if sum(model_buckets[m]) > 0 else 0,
            model_est_vol.get(m, 0.0),
            -(model_best[m][0] if m in model_best else 9999999),
        ),
        reverse=True,
    )

    ws = wb["SearchTermRank"]
    ws["G1"].value = "100001-200000"
    for idx, m in enumerate(sorted_models):
        r = 2 + idx
        b = model_buckets[m]
        best_rk, best_kw = model_best.get(m, (None, None))
        ws.cell(r, 1).value = m
        for bi in range(6):
            ws.cell(r, 2 + bi).value = b[bi]
        ws.cell(r, 8).value = best_kw
        ws.cell(r, 9).value = best_rk
        ws[f"J{r}"].value = f"=X{r}/1000"
        ws[f"J{r}"].number_format = "0.0"

    wb.save(t_path)

    recalc_ok = _excel_recalc(t_path) if run_excel_recalc else False
    state = get_aba_rank_state(str(t_path), str(s_path))
    state["importResult"] = {
        "source": file_name or str(s_path),
        "matchedTerms": matched_cnt,
        "unmatchedTerms": unmatched_cnt,
        "activeModels": sum(1 for m in all_models if sum(model_buckets[m]) > 0),
        "backupPath": str(bak_path),
        "excelRecalc": recalc_ok,
        "elapsedMs": int((time.time() - t0) * 1000),
    }
    return state
