import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { ensureExportDir, loadConfig, readSpreadsheetRows } from './file-io.mjs';

const MAX_MERGE_ROWS = 1_048_576;
const MAX_MERGE_COLS = 16_384;

export const CAMPAIGN_LABELS = {
  auto: '自动推广',
  exact: '精确推广',
  brand: '品牌推广',
};

export const LEVEL_DISPLAY = {
  极差: '极差·立即否定',
  差: '差·降竞价',
  较差: '较差·待观察',
  正常: '正常',
  数据不足: '数据不足',
};

export const LEVEL_ACTION = {
  极差: '立即否定/暂停',
  差: '降低竞价',
  较差: '观察',
  正常: '—',
  数据不足: '检查列头',
};

export const LEVEL_COLOR = {
  极差: '#FF4D4F',
  差: '#FA8C16',
  较差: '#FADB14',
  正常: '#52C41A',
  数据不足: '#BFBFBF',
};

const LEVEL_SEVERITY = { 极差: 4, 差: 3, 较差: 2, 正常: 1, 数据不足: 0 };

function isValidColumnIndex(value) {
  return Number.isInteger(value) && value >= 0 && value < MAX_MERGE_COLS;
}

export function colIndexToLetter(idx) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_MERGE_COLS) return '?';
  let result = '';
  let n = idx;
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

export function validateReportData(data, reportName = '报告') {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`报告「${reportName}」没有可读取的数据`);
  }
  const header = data[0];
  if (!Array.isArray(header) || header.length === 0 || header.every((v) => v == null || String(v).trim() === '')) {
    throw new Error(`报告「${reportName}」没有有效表头`);
  }
  if (header.length > MAX_MERGE_COLS || data.length > MAX_MERGE_ROWS) {
    throw new Error(`报告「${reportName}」超出 Excel 行列上限`);
  }
  if (data.length < 2) {
    throw new Error(`报告「${reportName}」只有表头没有数据行`);
  }
}

export function detectCampaignTypeFromName(name) {
  const n = String(name || '').toLowerCase();
  if (/(自动|auto|automatic|广泛|broad)/.test(n)) return 'auto';
  if (/(品牌|brand|sb|video|视频|sponsored\s*brand)/.test(n)) return 'brand';
  if (/(精确|手动|exact|manual|phrase|词组|精准)/.test(n)) return 'exact';
  return 'auto';
}

export function parseDayLabel(raw) {
  if (!raw) return '7';
  const s = String(raw).trim().toLowerCase().replace(/(?:天|d|day|days)\s*$/i, '').trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/(\d+)\s*(?:天|d|day|days)/i);
  if (m) return m[1];
  return '7';
}

function buildKeys(data, keyCols) {
  return data.map((row, idx) => {
    if (idx === 0) return keyCols.map(() => '__HEADER__');
    const safeRow = Array.isArray(row) ? row : [];
    return keyCols.map((c) => String(safeRow[c] ?? '').trim());
  });
}

function buildFullKey(rowKeys, requiredCols) {
  const safeKeys = Array.isArray(rowKeys) ? rowKeys : [];
  if (requiredCols && requiredCols.length === safeKeys.length) {
    return safeKeys.filter((_, i) => requiredCols[i] !== false).join('||');
  }
  return safeKeys.join('||');
}

export function mergeReports(input) {
  const { main, extras = [], keyCols = [], requiredCols = [], appendCols: rawAppend = [] } = input;
  const appendCols = rawAppend.filter((ac) => ac && isValidColumnIndex(ac.colIdx));
  const logs = [];
  validateReportData(main?.data, main?.name || '主报告');
  if (keyCols.length === 0) throw new Error('请至少配置一列匹配列');
  const mainData = main.data;
  const headerRow = mainData[0];
  if (keyCols.some((c) => c >= headerRow.length)) {
    throw new Error(`主报告「${main.name}」的匹配列超出表头范围（当前 ${headerRow.length} 列）`);
  }

  let roasColIdx = headerRow.findIndex((h) => typeof h === 'string' && h.includes('ROAS'));
  if (roasColIdx === -1) roasColIdx = headerRow.findIndex((h) => typeof h === 'string' && /roas/i.test(h));
  if (roasColIdx === -1) {
    roasColIdx = Math.min(17, headerRow.length - 1);
    logs.push(`⚠️ 未找到ROAS列，使用默认列 ${roasColIdx}`);
  } else {
    logs.push(`📍 ROAS列位置: col${roasColIdx}(${colIndexToLetter(roasColIdx)}) = "${headerRow[roasColIdx]}"`);
  }

  const mainKeys = buildKeys(mainData, keyCols);
  const extraMaps = [];
  for (const ext of extras) {
    validateReportData(ext?.data, ext?.name || '非主报告');
    if (keyCols.some((c) => c >= ext.data[0].length)) {
      throw new Error(`报告「${ext.name}」的匹配列超出表头范围（当前 ${ext.data[0].length} 列）`);
    }
    const extKeys = buildKeys(ext.data, keyCols);
    const fullKeyMap = {};
    for (let i = 1; i < ext.data.length; i++) {
      if (extKeys[i].includes('__HEADER__')) continue;
      const fullKey = buildFullKey(extKeys[i], requiredCols);
      if (fullKey in fullKeyMap) continue;
      const appendVals = appendCols.map((ac) => {
        const raw = ext.data[i]?.[ac.colIdx] ?? null;
        if (raw === null || raw === undefined || raw === '') return null;
        const num = Number(raw);
        if (ac.displayFormat === 'percent') {
          if (!Number.isNaN(num)) return `${(num * 100).toFixed(2)}%`;
        } else if (!Number.isNaN(num)) {
          return Math.round(num * 100) / 100;
        }
        return raw;
      });
      if (appendCols.length > 0 && appendVals.some((v) => v !== null && v !== undefined && v !== '')) {
        fullKeyMap[fullKey] = { append: appendVals };
      }
    }
    extraMaps.push({ label: ext.dayLabel, fullKeyMap, headers: ext.data[0] });
    logs.push(`📥 ${ext.dayLabel}天(${ext.name}): 提取 ${Object.keys(fullKeyMap).length} 个匹配Key`);
  }

  const usedLabels = new Map();
  const dedupeLabel = (base) => {
    const count = usedLabels.get(base) ?? 0;
    usedLabels.set(base, count + 1);
    return count === 0 ? base : `${base}(${count + 1})`;
  };

  const extraHeaders = [];
  for (const e of extraMaps) {
    for (const ac of appendCols) {
      const srcHeader = e.headers?.[ac.colIdx];
      const colHeader = ac.label || (srcHeader != null && srcHeader !== '' ? String(srcHeader) : `col${ac.colIdx}`);
      extraHeaders.push(dedupeLabel(`(${e.label}天)${colHeader}`));
    }
  }

  const rawRoasHeader = headerRow[roasColIdx];
  const roasAlreadyPrefixed = typeof rawRoasHeader === 'string' && /^\(\d+天\)/.test(rawRoasHeader);
  const mainRoasLabel = roasAlreadyPrefixed ? String(rawRoasHeader) : `(${main.dayLabel}天)${rawRoasHeader || 'ROAS'}`;
  const newHeader = [
    ...headerRow.slice(0, roasColIdx),
    mainRoasLabel,
    ...extraHeaders,
    ...headerRow.slice(roasColIdx + 1),
  ];

  const resultRows = [newHeader];
  const matchedCounts = extraMaps.map(() => 0);

  for (let i = 1; i < mainData.length; i++) {
    const mainRowKeys = mainKeys[i];
    if (mainRowKeys.includes('__HEADER__')) continue;
    const fullKey = buildFullKey(mainRowKeys, requiredCols);
    const extraValues = [];
    for (let ei = 0; ei < extraMaps.length; ei++) {
      const entry = extraMaps[ei].fullKeyMap[fullKey];
      if (entry) {
        matchedCounts[ei]++;
        extraValues.push(...entry.append);
      } else {
        extraValues.push(...appendCols.map(() => ''));
      }
    }
    const mainRow = Array.isArray(mainData[i]) ? mainData[i] : [];
    resultRows.push([...mainRow.slice(0, roasColIdx + 1), ...extraValues, ...mainRow.slice(roasColIdx + 1)]);
  }

  for (let ei = 0; ei < extraMaps.length; ei++) {
    logs.push(`✅ ${extraMaps[ei].label}天匹配: ${matchedCounts[ei]}/${mainData.length - 1}`);
  }

  return { resultRows, matchedCounts, extraHeaders, logs };
}

function spendP(s) {
  const l = s.toLowerCase();
  if (l.includes('click') || l.includes('cpc')) return false;
  return /花费|总花费|spend|cost/i.test(s);
}
function ordersP(s) { return /订单|order/i.test(s); }
function roasP(s) { return /roas/i.test(s); }
function ctrP(s) { return /点击率|click.?thru|click.?through|\bctr\b/i.test(s); }

export function buildAutoAppendCols(header) {
  const res = {};
  header.forEach((h, ci) => {
    const s = String(h ?? '');
    if (spendP(s) && res.spend === undefined) res.spend = ci;
    else if (ordersP(s) && res.orders === undefined) res.orders = ci;
    else if (roasP(s) && res.roas === undefined) res.roas = ci;
    else if (ctrP(s) && res.ctr === undefined) res.ctr = ci;
  });
  const out = [];
  if (res.spend !== undefined) out.push({ colIdx: res.spend, label: '花费' });
  if (res.orders !== undefined) out.push({ colIdx: res.orders, label: '订单' });
  if (res.roas !== undefined) out.push({ colIdx: res.roas, label: 'ROAS' });
  if (res.ctr !== undefined) out.push({ colIdx: res.ctr, label: 'CTR' });
  return out;
}

function resolveMetricColumns(header, baseDayLabel) {
  const map = {};
  header.forEach((h, ci) => {
    const s = String(h ?? '');
    const dm = s.match(/^\((\d+)天\)(.+)$/);
    if (dm) {
      const day = dm[1];
      const inner = dm[2];
      if (spendP(inner)) map[`spend${day}`] = ci;
      else if (ordersP(inner)) map[`orders${day}`] = ci;
      else if (roasP(inner)) map[`roas${day}`] = ci;
      else if (ctrP(inner)) map[`ctr${day}`] = ci;
    } else {
      if (spendP(s)) map[`spend${baseDayLabel}`] = ci;
      else if (ordersP(s)) map[`orders${baseDayLabel}`] = ci;
      else if (ctrP(s)) map[`ctr${baseDayLabel}`] = ci;
    }
  });
  return map;
}

function getNum(row, idx) {
  if (idx == null || idx < 0) return null;
  const v = row[idx];
  if (v == null) return null;
  const s = String(v).trim().replace('%', '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

const nn = (v) => (v == null ? -Infinity : v);
const lt = (v, t) => v != null && v < t;
const gt = (v, t) => v != null && v > t;
const range = (v, lo, hi) => v != null && v >= lo && v < hi;

export const RULES = {
  auto: [
    { level: '极差', desc: '30天花费≥30 且 30天订单=0', test: (c) => nn(c.spend30) >= 30 && (c.orders30 ?? -1) === 0 },
    { level: '极差', desc: '30天花费≥30 且 7/30/65天ROAS<1.8 且 7天订单<5', test: (c) => nn(c.spend30) >= 30 && lt(c.roas7, 1.8) && lt(c.roas30, 1.8) && lt(c.roas65, 1.8) && nn(c.orders7) < 5 },
    { level: '极差', desc: '7天订单=0 且 7天花费>20 且 30/65天ROAS<1.8', test: (c) => (c.orders7 ?? -1) === 0 && nn(c.spend7) > 20 && lt(c.roas30, 1.8) && lt(c.roas65, 1.8) },
    { level: '较差', desc: '30天花费≥30 且 7/30/65天ROAS<1.8 且 30天CTR>2%', test: (c) => nn(c.spend30) >= 30 && lt(c.roas7, 1.8) && lt(c.roas30, 1.8) && lt(c.roas65, 1.8) && nn(c.ctr30) > 2 },
    { level: '较差', desc: '30天花费≥30 且 30/65天ROAS<1.8 但 7天ROAS>2 且 7天订单>3（近期回暖·待观察）', test: (c) => nn(c.spend30) >= 30 && lt(c.roas30, 1.8) && lt(c.roas65, 1.8) && gt(c.roas7, 2) && nn(c.orders7) > 3 },
  ],
  exact: [
    { level: '极差', desc: '15天花费≥20 且 15天订单=0', test: (c) => nn(c.spend15) >= 20 && (c.orders15 ?? -1) === 0 },
    { level: '极差', desc: '15天花费≥15 且 7/30/65天ROAS<1.5 且 7天订单<5 且 7天CTR<2%', test: (c) => nn(c.spend15) >= 15 && lt(c.roas7, 1.5) && lt(c.roas30, 1.5) && lt(c.roas65, 1.5) && nn(c.orders7) < 5 && lt(c.ctr7, 2) },
    { level: '差', desc: '30天花费≥30 且 7/30/65天ROAS<1.8 且 7天订单<5', test: (c) => nn(c.spend30) >= 30 && lt(c.roas7, 1.8) && lt(c.roas30, 1.8) && lt(c.roas65, 1.8) && nn(c.orders7) < 5 },
    { level: '较差', desc: '30天花费≥30 且 15/30/65天ROAS<2 但 7天ROAS>2 且 7天订单>3', test: (c) => nn(c.spend30) >= 30 && lt(c.roas15, 2) && lt(c.roas30, 2) && lt(c.roas65, 2) && gt(c.roas7, 2) && nn(c.orders7) > 3 },
  ],
  brand: [
    { level: '极差', desc: '30天花费≥30 且 7/30/65天ROAS<1.5 且 7天订单<5', test: (c) => nn(c.spend30) >= 30 && lt(c.roas7, 1.5) && lt(c.roas30, 1.5) && lt(c.roas65, 1.5) && nn(c.orders7) < 5 },
    { level: '极差', desc: '7天订单=0 且 7天花费>15 且 30/65天ROAS<1.5', test: (c) => (c.orders7 ?? -1) === 0 && nn(c.spend7) > 15 && lt(c.roas30, 1.5) && lt(c.roas65, 1.5) },
    { level: '差', desc: '30天花费≥30 且 7/30/65天1.5≤ROAS<1.8 且 7天订单<5', test: (c) => nn(c.spend30) >= 30 && range(c.roas7, 1.5, 1.8) && range(c.roas30, 1.5, 1.8) && range(c.roas65, 1.5, 1.8) && nn(c.orders7) < 5 },
    { level: '较差', desc: '30天花费≥30 且 15/30/65天ROAS<2 但 7天ROAS>2 且 7天订单>3', test: (c) => nn(c.spend30) >= 30 && lt(c.roas15, 2) && lt(c.roas30, 2) && lt(c.roas65, 2) && gt(c.roas7, 2) && nn(c.orders7) > 3 },
  ],
};

function evaluateRow(resolver, row, rules) {
  const c = {
    spend7: getNum(row, resolver.spend7),
    orders7: getNum(row, resolver.orders7),
    roas7: getNum(row, resolver.roas7),
    ctr7: getNum(row, resolver.ctr7),
    spend15: getNum(row, resolver.spend15),
    orders15: getNum(row, resolver.orders15),
    roas15: getNum(row, resolver.roas15),
    spend30: getNum(row, resolver.spend30),
    orders30: getNum(row, resolver.orders30),
    roas30: getNum(row, resolver.roas30),
    ctr30: getNum(row, resolver.ctr30),
    roas65: getNum(row, resolver.roas65),
  };
  const matched = [];
  for (const rule of rules) {
    if (rule.test(c)) matched.push({ level: rule.level, desc: rule.desc });
  }
  const anyMetric = [c.spend7, c.orders7, c.roas7, c.spend15, c.roas15, c.spend30, c.orders30, c.roas30, c.roas65].some((v) => v != null);
  if (matched.length === 0) {
    return anyMetric
      ? { level: '正常', ruleDesc: '未命中任何否定/观察规则' }
      : { level: '数据不足', ruleDesc: '未识别到花费/ROAS等列，请检查报表列头' };
  }
  const level = matched.reduce((acc, m) => (LEVEL_SEVERITY[m.level] > LEVEL_SEVERITY[acc] ? m.level : acc), matched[0].level);
  const ruleDesc = matched.length > 1 ? matched.map((m, i) => `（${i + 1}）[${m.level}]${m.desc}`).join('；') : matched[0].desc;
  return { level, ruleDesc };
}

export function loadRoasPresets() {
  const cfg = loadConfig();
  try {
    if (cfg.roasConfigPath && fs.existsSync(cfg.roasConfigPath)) {
      const raw = JSON.parse(fs.readFileSync(cfg.roasConfigPath, 'utf8'));
      return raw.customPresets || [];
    }
  } catch {
    // Fallback
  }
  return [
    { key: 'custom_cfg_4_5_10', label: '默认配置 (E/F/K)', cols: [4, 5, 10], requiredCols: [true, true, true] },
    { key: 'custom_cfg_4_6_10', label: '配置 (4/6/10)', cols: [4, 6, 10], requiredCols: [true, true, true] },
  ];
}

export async function runRoasMerge({ reports, keyCols, requiredCols, appendCols, autoJudge = true, exportExcel = true }) {
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new Error('请至少提供 1 份广告报告路径');
  }
  const cfg = loadConfig();
  const useKeyCols = Array.isArray(keyCols) && keyCols.length > 0 ? keyCols : (cfg.roasMerge?.keyCols || [4, 5, 10]);
  const useRequiredCols = Array.isArray(requiredCols) && requiredCols.length === useKeyCols.length
    ? requiredCols
    : useKeyCols.map(() => true);

  // Load each report
  const loaded = [];
  for (const r of reports) {
    const parsed = await readSpreadsheetRows(r.path, 0);
    const name = path.basename(r.path);
    loaded.push({
      name,
      path: r.path,
      data: parsed.rows,
      dayLabel: parseDayLabel(r.dayLabel || name),
      campaignType: r.campaignType || detectCampaignTypeFromName(name),
      isMain: Boolean(r.isMain),
    });
  }

  // Group by campaignType
  const groups = new Map();
  for (const item of loaded) {
    if (!groups.has(item.campaignType)) groups.set(item.campaignType, []);
    groups.get(item.campaignType).push(item);
  }

  const sheets = [];
  const allLogs = [];
  const summaryCounts = { 极差: 0, 差: 0, 较差: 0, 正常: 0, 数据不足: 0 };

  for (const [type, grp] of groups.entries()) {
    grp.sort((a, b) => Number(a.dayLabel) - Number(b.dayLabel));
    let mainIdx = grp.findIndex((g) => g.isMain);
    if (mainIdx === -1) mainIdx = 0;
    const main = grp[mainIdx];
    const extras = grp.filter((_, i) => i !== mainIdx);

    const autoAppend = buildAutoAppendCols(main.data[0]);
    const finalAppend = Array.isArray(appendCols) && appendCols.length > 0 ? appendCols : autoAppend;

    const merged = mergeReports({
      main: { data: main.data, dayLabel: main.dayLabel, name: main.name },
      extras: extras.map((e) => ({ data: e.data, dayLabel: e.dayLabel, name: e.name })),
      keyCols: useKeyCols,
      requiredCols: useRequiredCols,
      appendCols: finalAppend,
    });

    allLogs.push(...merged.logs);

    let outRows = merged.resultRows;
    const counts = { 极差: 0, 差: 0, 较差: 0, 正常: 0, 数据不足: 0 };

    if (autoJudge) {
      const resolver = resolveMetricColumns(outRows[0], main.dayLabel);
      const rules = RULES[type] || RULES.auto;
      const judged = [[...outRows[0], '判定等级', '命中规则', '建议操作']];
      for (let i = 1; i < outRows.length; i++) {
        const jr = evaluateRow(resolver, outRows[i], rules);
        counts[jr.level] = (counts[jr.level] || 0) + 1;
        summaryCounts[jr.level] = (summaryCounts[jr.level] || 0) + 1;
        judged.push([...outRows[i], jr.level, jr.ruleDesc, LEVEL_ACTION[jr.level]]);
      }
      outRows = judged;
    }

    sheets.push({
      type,
      label: CAMPAIGN_LABELS[type] || type,
      totalRows: outRows.length - 1,
      counts,
      headers: outRows[0],
      previewRows: outRows.slice(1, 101),
      allRows: outRows,
    });
  }

  let exportPath = null;
  if (exportExcel) {
    const outDir = ensureExportDir(cfg);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    exportPath = path.join(outDir, `ROAS合并判定_${ts}.xlsx`);
    const wb = new ExcelJS.Workbook();
    for (const sh of sheets) {
      const ws = wb.addWorksheet(sh.label.slice(0, 31));
      ws.addRows(sh.allRows);
      const hdr = ws.getRow(1);
      hdr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      if (autoJudge) {
        const levelCol = sh.headers.length - 2;
        for (let r = 2; r <= sh.allRows.length; r++) {
          const lvl = sh.allRows[r - 1][levelCol - 1];
          const hex = LEVEL_COLOR[lvl];
          if (hex) {
            const cell = ws.getRow(r).getCell(levelCol);
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${hex.replace('#', '')}` } };
            cell.font = { bold: true, color: { argb: lvl === '较差' ? 'FF111827' : 'FFFFFFFF' } };
          }
        }
      }
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    }
    await wb.xlsx.writeFile(exportPath);
  }

  return {
    exportPath,
    summaryCounts,
    logs: allLogs,
    sheets: sheets.map(({ allRows, ...rest }) => rest),
  };
}
