import path from 'node:path';
import ExcelJS from 'exceljs';
import { ensureExportDir, loadConfig, readAllSheets, readSpreadsheetRows } from './file-io.mjs';

const SUANDUCK_HEADER_MAP = {
  ASIN: 'asin',
  父ASIN: 'parentAsin',
  MSKU: 'msku',
  SKU: 'sku',
  品名: 'productName',
  站点: 'site',
  店铺: 'shop',
  FBA可售天数: 'fbaDays',
  FBA可售: 'fbaAvailable',
  不可售: 'fbaUnsellable',
  FBA预留数: 'fbaReserved',
  FBA在途: 'fbaInTransit',
  FBA总库存: 'fbaTotal',
  均值: 'avgDailySales',
  小计: 'subtotal',
};

function toNum(v) {
  if (v == null || v === '') return 0;
  const s = String(v).replace(/[$,%¥€£,\s]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function detectColIdx(headers, candidates) {
  const lower = headers.map((h) => String(h ?? '').trim().toLowerCase());
  for (const pat of candidates) {
    const idx = lower.findIndex((h) => (pat instanceof RegExp ? pat.test(h) : h === pat.toLowerCase()));
    if (idx >= 0) return idx;
  }
  return -1;
}

async function parseSingleInventoryFile(filePath, customMapping = {}) {
  const ext = path.extname(filePath).toLowerCase();
  let rows = [];
  let sourceType = 'generic';
  let sheetName = 'Sheet1';

  if (ext === '.xlsx' || ext === '.xlsm') {
    const sheets = await readAllSheets(filePath);
    if (sheets['销量']) {
      rows = sheets['销量'];
      sourceType = 'saihu';
      sheetName = '销量';
    } else {
      const firstKey = Object.keys(sheets)[0];
      rows = sheets[firstKey] || [];
      sheetName = firstKey || 'Sheet1';
    }
  } else {
    const parsed = await readSpreadsheetRows(filePath, 0);
    rows = parsed.rows;
    sheetName = parsed.sheetName;
  }

  if (!rows || rows.length < 2) {
    throw new Error(`报表「${path.basename(filePath)}」为空或仅有表头`);
  }

  const headers = rows[0].map((h) => String(h ?? '').trim());
  const mapped = {};
  headers.forEach((h, i) => {
    if (SUANDUCK_HEADER_MAP[h]) mapped[SUANDUCK_HEADER_MAP[h]] = i;
  });

  const cSku = customMapping.sku ?? mapped.sku ?? mapped.msku ?? detectColIdx(headers, [/^msku$/i, /^sku$/i, /seller.?sku/i, /advertised sku/i, /广告sku/i]);
  const cAsin = customMapping.asin ?? mapped.asin ?? detectColIdx(headers, [/^asin$/i, /advertised asin/i, /广告asin/i]);
  const cName = customMapping.productName ?? mapped.productName ?? detectColIdx(headers, [/品名/, /product.?name/i, /title/i, /商品名称/]);
  const cAvail = customMapping.fbaAvailable ?? mapped.fbaAvailable ?? detectColIdx(headers, [/fba可售$/, /afn-fulfillable-quantity$/i, /可售库存/]);
  const cTransit = customMapping.fbaInTransit ?? mapped.fbaInTransit ?? detectColIdx(headers, [/fba在途/, /inbound-shipped/i, /在途/]);
  const cReserved = customMapping.fbaReserved ?? mapped.fbaReserved ?? detectColIdx(headers, [/fba预留/, /afn-reserved/i]);
  const cAvgDaily = customMapping.avgDailySales ?? mapped.avgDailySales ?? detectColIdx(headers, [/均值/, /日均销量/, /daily.?sales/i]);
  const cSubtotal = customMapping.subtotal ?? mapped.subtotal ?? detectColIdx(headers, [/小计/, /30天销量/, /total.?units/i, /7天总销售量/, /销量/]);
  const cDays = customMapping.fbaDays ?? mapped.fbaDays ?? detectColIdx(headers, [/fba可售天数/, /可售天数/, /days.?of.?supply/i]);
  const cSpend = customMapping.spend ?? detectColIdx(headers, [/^spend$/i, /^花费$/, /总花费/]);
  const cAdSales = customMapping.adSales ?? detectColIdx(headers, [/7天总销售额/, /7 day total sales/i, /广告销售额/]);

  if (cSku === -1 && cAsin === -1) {
    throw new Error(`「${path.basename(filePath)}」未识别到 SKU 或 ASIN 列`);
  }

  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const sku = cSku >= 0 ? String(r[cSku] ?? '').trim() : '';
    const asin = cAsin >= 0 ? String(r[cAsin] ?? '').trim() : '';
    const key = sku || asin;
    if (!key) continue;

    const prev = map.get(key) || {
      sku: sku || asin,
      asin,
      productName: '',
      available: 0,
      inTransit: 0,
      reserved: 0,
      avgDaily: 0,
      subtotalSales: 0,
      daysOfSupply: null,
      adSpend: 0,
      adSales: 0,
    };

    if (!prev.productName && cName >= 0) prev.productName = String(r[cName] ?? '').trim();
    if (!prev.asin && asin) prev.asin = asin;
    if (cAvail >= 0) prev.available += toNum(r[cAvail]);
    if (cTransit >= 0) prev.inTransit += toNum(r[cTransit]);
    if (cReserved >= 0) prev.reserved += toNum(r[cReserved]);
    if (cSubtotal >= 0) prev.subtotalSales += toNum(r[cSubtotal]);
    if (cAvgDaily >= 0) prev.avgDaily = Math.max(prev.avgDaily, toNum(r[cAvgDaily]));
    if (cDays >= 0 && r[cDays] !== '' && r[cDays] != null) prev.daysOfSupply = toNum(r[cDays]);
    if (cSpend >= 0) prev.adSpend += toNum(r[cSpend]);
    if (cAdSales >= 0) prev.adSales += toNum(r[cAdSales]);

    map.set(key, prev);
  }

  return { fileName: path.basename(filePath), sourceType, sheetName, headers, map };
}

export async function analyzeInventorySales({
  filePath,
  fbaFilePath,
  adFilePath,
  columnMapping = {},
  stockoutWarnDays,
  overstockWarnDays,
  exportExcel = true,
}) {
  const cfg = loadConfig();
  const warnDays = stockoutWarnDays ?? cfg.inventorySales?.stockoutWarnDays ?? 21;
  const overDays = overstockWarnDays ?? cfg.inventorySales?.overstockWarnDays ?? 120;

  const primaryPath = filePath || fbaFilePath || adFilePath;
  if (!primaryPath) throw new Error('请至少提供一份库存或销售报表');

  const mainRes = await parseSingleInventoryFile(primaryPath, columnMapping);
  const merged = new Map(mainRes.map);

  const extraSources = [];
  if (fbaFilePath && fbaFilePath !== primaryPath) {
    const fbaRes = await parseSingleInventoryFile(fbaFilePath);
    extraSources.push(`FBA:${fbaRes.fileName}`);
    for (const [k, v] of fbaRes.map.entries()) {
      const cur = merged.get(k) || { ...v };
      if (v.available > 0) cur.available = v.available;
      if (v.inTransit > 0) cur.inTransit = v.inTransit;
      if (v.reserved > 0) cur.reserved = v.reserved;
      if (!cur.asin && v.asin) cur.asin = v.asin;
      merged.set(k, cur);
    }
  }
  if (adFilePath && adFilePath !== primaryPath) {
    const adRes = await parseSingleInventoryFile(adFilePath);
    extraSources.push(`广告:${adRes.fileName}`);
    for (const [k, v] of adRes.map.entries()) {
      const cur = merged.get(k) || { ...v };
      cur.adSpend += v.adSpend;
      cur.adSales += v.adSales;
      if (!cur.asin && v.asin) cur.asin = v.asin;
      merged.set(k, cur);
    }
  }

  const items = [];
  let totalAvail = 0;
  let totalTransit = 0;
  let totalSales = 0;
  let totalAdSpend = 0;

  for (const it of merged.values()) {
    const avgDaily = it.avgDaily > 0 ? it.avgDaily : (it.subtotalSales > 0 ? it.subtotalSales / 30 : 0);
    const dos = it.daysOfSupply !== null
      ? it.daysOfSupply
      : (avgDaily > 0 ? Math.round((it.available / avgDaily) * 10) / 10 : (it.available > 0 ? 999 : 0));

    let risk = '健康';
    if (avgDaily > 0 && dos < warnDays) risk = '断货高危';
    else if (avgDaily > 0 && dos < warnDays + 14) risk = '补货预警';
    else if (it.available > 0 && avgDaily === 0) risk = '无动销积压';
    else if (dos > overDays) risk = '库龄积压';

    totalAvail += it.available;
    totalTransit += it.inTransit;
    totalSales += it.subtotalSales;
    totalAdSpend += it.adSpend;

    const adAcos = it.adSales > 0 ? Math.round((it.adSpend / it.adSales) * 1000) / 10 : 0;

    items.push({
      sku: it.sku,
      asin: it.asin,
      productName: (it.productName || '').slice(0, 60),
      available: it.available,
      inTransit: it.inTransit,
      reserved: it.reserved,
      avgDaily: Math.round(avgDaily * 100) / 100,
      subtotalSales: it.subtotalSales,
      daysOfSupply: dos,
      adSpend: Math.round(it.adSpend * 100) / 100,
      adSales: Math.round(it.adSales * 100) / 100,
      adAcos,
      risk,
      abc: 'C',
    });
  }

  items.sort((a, b) => (b.subtotalSales || b.avgDaily) - (a.subtotalSales || a.avgDaily));
  const totalMetric = items.reduce((s, it) => s + (it.subtotalSales || it.avgDaily), 0);
  let cum = 0;
  for (const it of items) {
    cum += it.subtotalSales || it.avgDaily;
    const ratio = totalMetric > 0 ? cum / totalMetric : 1;
    it.abc = ratio <= 0.7 ? 'A' : ratio <= 0.9 ? 'B' : 'C';
  }

  const riskCounts = { 断货高危: 0, 补货预警: 0, 健康: 0, 库龄积压: 0, 无动销积压: 0 };
  for (const it of items) riskCounts[it.risk] = (riskCounts[it.risk] || 0) + 1;

  let exportPath = null;
  if (exportExcel) {
    const outDir = ensureExportDir(cfg);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    exportPath = path.join(outDir, `库存销售分析_${ts}.xlsx`);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('库存与销售健康度');
    ws.addRow(['SKU', 'ASIN', '品名', 'ABC分级', 'FBA可售', 'FBA在途', 'FBA预留', '日均销量', '周期销量', '可售天数', '广告花费', '广告销售额', '广告ACoS%', '风险状态']);
    for (const it of items) {
      ws.addRow([it.sku, it.asin, it.productName, it.abc, it.available, it.inTransit, it.reserved, it.avgDaily, it.subtotalSales, it.daysOfSupply, it.adSpend, it.adSales, it.adAcos, it.risk]);
    }
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    await wb.xlsx.writeFile(exportPath);
  }

  return {
    fileName: mainRes.fileName,
    extraSources,
    sourceType: mainRes.sourceType,
    sheetName: mainRes.sheetName,
    totalSkus: items.length,
    totalAvail,
    totalTransit,
    totalSales: Math.round(totalSales),
    totalAdSpend: Math.round(totalAdSpend * 100) / 100,
    riskCounts,
    exportPath,
    previewRows: items.slice(0, 200),
  };
}
