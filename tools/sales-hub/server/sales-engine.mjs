import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { loadSaihuReplenishment } from './saihu-parser.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const STORE_ID = process.env.DISCOVER_STORE_ID || 'default';
export const STORE_DATA_DIR = process.env.DISCOVER_STORE_DATA_DIR || path.join(__dirname, 'data');
export const WORKSPACE_DIR = STORE_ID === 'UPBestKS' ? 'D:\\反重力\\UPBestKS\\销售与库存' : STORE_DATA_DIR;
export const FALLBACK_XLSX = path.join(STORE_DATA_DIR, 'UPBestKS_原始销售数据_2026-08-14_至_2026-11-25.xlsx');
export const REPORT_OUT_PATH = path.join(WORKSPACE_DIR, `${STORE_ID}_销售与库存深度分析报表.xlsx`);

export function resolveSaihuCsv() {
  try {
    if (fs.existsSync(STORE_DATA_DIR)) {
      const csvs = fs.readdirSync(STORE_DATA_DIR).filter(f => f.toLowerCase().endsWith('.csv') && !f.startsWith('~$'));
      if (csvs.length) return path.join(STORE_DATA_DIR, csvs[0]);
    }
  } catch { /* ignore */ }
  if (STORE_ID === 'UPBestKS') {
    const p1 = path.join(WORKSPACE_DIR, 'UPBestKS_赛狐补货建议_2026-11-26.csv');
    if (fs.existsSync(p1)) return p1;
  }
  return null;
}

const MODEL_DISPLAY = {
  'S26': 'Samsung S26',
  'IP17ProMax': 'iPhone 17/18 Pro Max',
  'Moto/G/5G/2026/2025': 'Moto G 5G 2025/2026',
  'A17': 'Samsung A17/A26',
  'IP17Pro': 'iPhone 17/18 Pro',
  'S26Ultra': 'Samsung S26 Ultra',
  'S24Ultra': 'Samsung S24 Ultra',
  'Moto/Stylus/2025/2026': 'Moto G Stylus 2025/2026',
  'IP16': 'iPhone 16',
  'S25': 'Samsung S25',
  'IP17': 'iPhone 17',
  'A16': 'Samsung A16',
  'IP17e': 'iPhone 17e/16e',
  'Pixel11': 'Google Pixel 11',
};

const COLOR_CN_MAP = {
  'Black': '黑色',
  'Blue': '蓝色',
  'Wine Red': '酒红',
  'Deep Purple': '深紫',
  'Light Brown': '橙色',
  'Blue Green': '蓝绿色',
  'Red': '红色',
  'Rose Gold': '玫瑰金',
};

export const COLOR_ORDER = ['Black', 'Blue', 'Wine Red', 'Deep Purple', 'Light Brown', 'Blue Green', 'Red', 'Rose Gold'];
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
export const round1 = (x) => Math.round((Number(x) || 0) * 10) / 10;

function cellVal(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.result !== undefined) return v.result;
  return v;
}

function num(v) {
  const x = cellVal(v);
  if (x === '' || x === '-' || x === '--' || x === null || x === undefined) return 0;
  const n = Number(String(x).replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function resolveSourceXlsx() {
  try {
    if (fs.existsSync(WORKSPACE_DIR)) {
      const files = fs.readdirSync(WORKSPACE_DIR)
        .filter(f => /^UPBestKS_原始销售数据.*\.xlsx$/i.test(f))
        .map(f => ({ full: path.join(WORKSPACE_DIR, f), mtime: fs.statSync(path.join(WORKSPACE_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length) return files[0].full;
    }
  } catch { /* ignore */ }
  try {
    if (fs.existsSync(STORE_DATA_DIR)) {
      const sfiles = fs.readdirSync(STORE_DATA_DIR)
        .filter(f => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'))
        .map(f => ({ full: path.join(STORE_DATA_DIR, f), mtime: fs.statSync(path.join(STORE_DATA_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (sfiles.length) return sfiles[0].full;
    }
  } catch { /* ignore */ }
  return fs.existsSync(FALLBACK_XLSX) ? FALLBACK_XLSX : null;
}

export async function computeSalesAnalytics(sourcePath = resolveSourceXlsx()) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return {
      empty: true,
      meta: { storeId: STORE_ID, totalDays: 0, totalSkus: 0, earliestDate: '', latestDate: '', sourceFile: '' },
      summary: { totalUnits: 0, totalSales: 0, totalOrders: 0, asp: 0, fbaSellable: 0, fbaTransit: 0, avgDailyUnits: 0, avgDailySales: 0 },
      periods: { d7: { units: 0, sales: 0 }, d15: { units: 0, sales: 0 }, d30: { units: 0, sales: 0 } },
      inventorySummary: { fbaTotal: 0, criticalDosCount: 0 },
      skus: [],
      daily: [],
      weekly: [],
      monthly: [],
      models: [],
      colors: [],
      replenishment: [],
      alerts: [],
    };
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(sourcePath);

  const sUnits = wb.getWorksheet('销量') || wb.worksheets[0];
  const sSales = wb.getWorksheet('销售额') || wb.worksheets[1];
  const sOrders = wb.getWorksheet('订单量') || wb.worksheets[2];

  if (!sUnits || !sSales) {
    throw new Error(`源工作簿缺少 "销量" 或 "销售额" 工作表: ${sourcePath}`);
  }

  const headers = [];
  for (let c = 1; c <= sUnits.columnCount; c++) {
    headers.push(String(cellVal(sUnits.getCell(1, c).value) || '').trim());
  }

  // Date columns start at col index 31 (1-based col 32), originally descending (2026-11-25 .. 2026-08-14)
  const rawDateCols = headers.slice(31).map((d, idx) => ({ dt: d, col: 32 + idx })).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.dt));
  const dateColsChron = [...rawDateCols].sort((a, b) => a.dt.localeCompare(b.dt));
  const dateList = dateColsChron.map(x => x.dt);
  const totalDays = dateList.length;
  const latestDate = dateList[totalDays - 1];
  const earliestDate = dateList[0];

  const sliceDates = (n, offset = 0) => {
    const end = totalDays - offset;
    const start = Math.max(0, end - n);
    return dateList.slice(start, end);
  };
  const d7Dates = sliceDates(7, 0);
  const prev7Dates = sliceDates(7, 7);
  const d15Dates = sliceDates(15, 0);
  const prev15Dates = sliceDates(15, 15);
  const d30Dates = sliceDates(30, 0);
  const prev30Dates = sliceDates(30, 30);

  const skus = [];
  for (let r = 2; r <= sUnits.rowCount; r++) {
    const msku = String(cellVal(sUnits.getCell(r, 1).value) || '').trim();
    if (!msku) continue;
    const parentAsin = String(cellVal(sUnits.getCell(r, 2).value) || '').trim();
    const asin = String(cellVal(sUnits.getCell(r, 3).value) || '').trim();
    const sku = String(cellVal(sUnits.getCell(r, 4).value) || '').trim();
    const style = String(cellVal(sUnits.getCell(r, 5).value) || '').trim();
    const cnName = String(cellVal(sUnits.getCell(r, 7).value) || '').trim();
    const site = String(cellVal(sUnits.getCell(r, 8).value) || '').trim();
    const store = String(cellVal(sUnits.getCell(r, 9).value) || '').trim();

    const dos = num(sUnits.getCell(r, 17).value);
    const fbaSellable = Math.round(num(sUnits.getCell(r, 18).value));
    const fbaUnsellable = Math.round(num(sUnits.getCell(r, 19).value));
    const fbaReserved = Math.round(num(sUnits.getCell(r, 20).value));
    const fbaTransit = Math.round(num(sUnits.getCell(r, 27).value));
    const fbaInvestigating = Math.round(num(sUnits.getCell(r, 28).value));
    const fbaTotal = Math.round(num(sUnits.getCell(r, 29).value));
    const erpAvgUnits = num(sUnits.getCell(r, 30).value);

    const parts = msku.split('-R64-CX-');
    const model = parts[0] || style;
    const color = parts[1] || msku.split('-').pop();
    const colorCn = COLOR_CN_MAP[color] || cnName.split('-').pop() || color;

    const unitsByDate = {};
    const salesByDate = {};
    const ordersByDate = {};
    let totalUnits = 0, totalSales = 0, totalOrders = 0;
    let firstSaleDate = null;

    for (const { dt, col } of dateColsChron) {
      const u = Math.round(num(sUnits.getCell(r, col).value));
      const s = round2(num(sSales.getCell(r, col).value));
      const o = sOrders ? Math.round(num(sOrders.getCell(r, col).value)) : u;
      unitsByDate[dt] = u;
      salesByDate[dt] = s;
      ordersByDate[dt] = o;
      totalUnits += u;
      totalSales += s;
      totalOrders += o;
      if (!firstSaleDate && u > 0) firstSaleDate = dt;
    }
    totalSales = round2(totalSales);

    const sumDates = (dates, map) => dates.reduce((acc, d) => acc + (map[d] || 0), 0);
    const d7Units = sumDates(d7Dates, unitsByDate);
    const prev7Units = sumDates(prev7Dates, unitsByDate);
    const d7Sales = round2(sumDates(d7Dates, salesByDate));
    const prev7Sales = round2(sumDates(prev7Dates, salesByDate));

    const d15Units = sumDates(d15Dates, unitsByDate);
    const prev15Units = sumDates(prev15Dates, unitsByDate);
    const d15Sales = round2(sumDates(d15Dates, salesByDate));
    const prev15Sales = round2(sumDates(prev15Dates, salesByDate));

    const d30Units = sumDates(d30Dates, unitsByDate);
    const prev30Units = sumDates(prev30Dates, unitsByDate);
    const d30Sales = round2(sumDates(d30Dates, salesByDate));
    const prev30Sales = round2(sumDates(prev30Dates, salesByDate));

    const cohort = (firstSaleDate && firstSaleDate >= '2026-10-15') ? '11月新品' : '老品主力';
    const asp = totalUnits > 0 ? round2(totalSales / totalUnits) : 0;
    const d7Avg = round2(d7Units / 7);
    const d15Avg = round2(d15Units / 15);
    const activeDays = firstSaleDate ? Math.max(1, dateList.length - dateList.indexOf(firstSaleDate)) : totalDays;
    const activeDailyAvg = round2(totalUnits / activeDays);
    const estTotalDos = d15Avg > 0 ? round1(fbaTotal / d15Avg) : (activeDailyAvg > 0 ? round1(fbaTotal / activeDailyAvg) : 999);

    let invStatus = '健康周转 (30-90天)';
    let invTone = 'green';
    if (dos < 15) { invStatus = '断货高危 (<15天)'; invTone = 'red'; }
    else if (dos < 30) { invStatus = '偏紧预警 (15-30天)'; invTone = 'amber'; }
    else if (dos <= 90) { invStatus = '健康周转 (30-90天)'; invTone = 'green'; }
    else if (dos <= 180) { invStatus = '偏高观察 (90-180天)'; invTone = 'blue'; }
    else { invStatus = '严重积压 (>180天)'; invTone = 'purple'; }

    let advice = '维持常规补货节奏';
    if (dos < 15 && fbaTransit > 0) advice = `可售仅${fbaSellable}件(${dos}天)，紧盯${fbaTransit}件在途入库，准备下一批空运/海运`;
    else if (dos < 15) advice = `可售仅${fbaSellable}件且无在途，立刻安排补货防断货`;
    else if (dos < 30) advice = `可售偏紧(${dos}天)，建议核查在途(${fbaTransit}件)并排期补货`;
    else if (dos > 365) advice = `严重滞销(DOS ${dos}天)，暂停补货，配合广告降出价/Coupon/降价去库存`;
    else if (dos > 180) advice = `库存偏高(DOS ${dos}天)，暂缓补货，关注周转`;

    skus.push({
      msku, parentAsin, asin, sku, style, cnName, site, store,
      model, modelDisplay: MODEL_DISPLAY[model] || model,
      color, colorCn, cohort, firstSaleDate, activeDays,
      dos, fbaSellable, fbaUnsellable, fbaReserved, fbaTransit, fbaInvestigating, fbaTotal,
      erpAvgUnits, totalUnits, totalOrders, totalSales, asp,
      d7Units, prev7Units, d7Sales, prev7Sales,
      d15Units, prev15Units, d15Sales, prev15Sales,
      d30Units, prev30Units, d30Sales, prev30Sales,
      d7Avg, d15Avg, activeDailyAvg, estTotalDos,
      invStatus, invTone, advice,
      recent30DailyUnits: d30Dates.map(d => unitsByDate[d] || 0),
      unitsByDate, salesByDate, ordersByDate,
    });
  }

  // ABC Classification by cumulative sales
  const totalSalesAll = round2(skus.reduce((a, s) => a + s.totalSales, 0));
  const totalUnitsAll = skus.reduce((a, s) => a + s.totalUnits, 0);
  const totalOrdersAll = skus.reduce((a, s) => a + s.totalOrders, 0);
  const skusSorted = [...skus].sort((a, b) => b.totalSales - a.totalSales);
  let cumSales = 0;
  skusSorted.forEach((s, idx) => {
    cumSales += s.totalSales;
    const cumShare = totalSalesAll > 0 ? cumSales / totalSalesAll : 1;
    s.rank = idx + 1;
    s.salesShare = totalSalesAll > 0 ? s.totalSales / totalSalesAll : 0;
    s.cumSalesShare = cumShare;
    if (cumShare <= 0.80 || idx === 0) s.abcClass = 'A类核心';
    else if (cumShare <= 0.95) s.abcClass = 'B类中坚';
    else s.abcClass = 'C类长尾';
  });

  // Daily series (104 days)
  const daily = dateList.map((dt, idx) => {
    let units = 0, orders = 0, sales = 0, activeSkus = 0;
    let legacyUnits = 0, legacySales = 0, newUnits = 0, newSales = 0;
    for (const s of skus) {
      const u = s.unitsByDate[dt] || 0;
      const o = s.ordersByDate[dt] || 0;
      const rev = s.salesByDate[dt] || 0;
      units += u; orders += o; sales += rev;
      if (u > 0) activeSkus++;
      if (s.cohort === '老品主力') { legacyUnits += u; legacySales += rev; }
      else { newUnits += u; newSales += rev; }
    }
    const wd = WEEKDAYS[new Date(dt + 'T12:00:00Z').getUTCDay()];
    return {
      date: dt, weekday: wd, units, orders, sales: round2(sales),
      asp: units > 0 ? round2(sales / units) : 0,
      activeSkus, legacyUnits, legacySales: round2(legacySales),
      newUnits, newSales: round2(newSales),
    };
  });
  daily.forEach((d, i) => {
    const win = daily.slice(Math.max(0, i - 6), i + 1);
    d.ma7Units = round2(win.reduce((a, x) => a + x.units, 0) / win.length);
    d.ma7Sales = round2(win.reduce((a, x) => a + x.sales, 0) / win.length);
  });

  // Weekly series (chunks of 7 days ending on latestDate, or Mon-Sun? 7-day rolling blocks ending 11-25 ensures every full week is 7d except oldest!)
  // Actually chronological 7-day blocks anchored from latestDate backwards gives exact W-1, W-2... or Mon-Sun. Anchoring from latestDate backwards (exact 7 days each for recent 14 weeks + partial W1) avoids partial-latest-week distortion!
  const weekly = [];
  for (let end = daily.length; end > 0; end -= 7) {
    const start = Math.max(0, end - 7);
    const slice = daily.slice(start, end);
    const units = slice.reduce((a, x) => a + x.units, 0);
    const orders = slice.reduce((a, x) => a + x.orders, 0);
    const sales = round2(slice.reduce((a, x) => a + x.sales, 0));
    const legacySales = round2(slice.reduce((a, x) => a + x.legacySales, 0));
    const newSales = round2(slice.reduce((a, x) => a + x.newSales, 0));
    weekly.unshift({
      startDate: slice[0].date,
      endDate: slice[slice.length - 1].date,
      days: slice.length,
      units, orders, sales, legacySales, newSales,
      dailyAvgUnits: round2(units / slice.length),
      dailyAvgSales: round2(sales / slice.length),
      asp: units > 0 ? round2(sales / units) : 0,
    });
  }
  weekly.forEach((w, idx) => {
    w.weekLabel = `W${String(idx + 1).padStart(2, '0')} (${w.startDate.slice(5)}~${w.endDate.slice(5)})`;
    const prev = idx > 0 ? weekly[idx - 1] : null;
    w.qoqSalesPct = prev && prev.dailyAvgSales > 0 ? (w.dailyAvgSales - prev.dailyAvgSales) / prev.dailyAvgSales : null;
  });

  // Monthly series
  const monthMap = {};
  for (const d of daily) {
    const ym = d.date.slice(0, 7);
    (monthMap[ym] ||= []).push(d);
  }
  const monthly = Object.entries(monthMap).sort((a, b) => a[0].localeCompare(b[0])).map(([ym, arr], idx, allArr) => {
    const units = arr.reduce((a, x) => a + x.units, 0);
    const orders = arr.reduce((a, x) => a + x.orders, 0);
    const sales = round2(arr.reduce((a, x) => a + x.sales, 0));
    const activeSet = new Set();
    arr.forEach(day => {
      skus.forEach(s => { if ((s.unitsByDate[day.date] || 0) > 0) activeSet.add(s.msku); });
    });
    const dailyAvgUnits = round2(units / arr.length);
    const dailyAvgSales = round2(sales / arr.length);
    return {
      month: ym, days: arr.length, activeSkus: activeSet.size,
      units, orders, sales, dailyAvgUnits, dailyAvgSales,
      asp: units > 0 ? round2(sales / units) : 0,
      salesShare: totalSalesAll > 0 ? sales / totalSalesAll : 0,
    };
  });
  monthly.forEach((m, idx) => {
    const prev = idx > 0 ? monthly[idx - 1] : null;
    m.qoqDailySalesPct = prev && prev.dailyAvgSales > 0 ? (m.dailyAvgSales - prev.dailyAvgSales) / prev.dailyAvgSales : null;
  });

  // Period comparisons helper
  function sumWindow(dates) {
    let units = 0, orders = 0, sales = 0, legacySales = 0, newSales = 0, legacyUnits = 0, newUnits = 0;
    const active = new Set();
    for (const dt of dates) {
      for (const s of skus) {
        const u = s.unitsByDate[dt] || 0;
        const o = s.ordersByDate[dt] || 0;
        const rev = s.salesByDate[dt] || 0;
        units += u; orders += o; sales += rev;
        if (u > 0) active.add(s.msku);
        if (s.cohort === '老品主力') { legacyUnits += u; legacySales += rev; }
        else { newUnits += u; newSales += rev; }
      }
    }
    return {
      days: dates.length,
      startDate: dates[0], endDate: dates[dates.length - 1],
      units, orders, sales: round2(sales),
      dailyAvgUnits: round2(units / dates.length),
      dailyAvgSales: round2(sales / dates.length),
      asp: units > 0 ? round2(sales / units) : 0,
      activeSkus: active.size,
      legacyUnits, legacySales: round2(legacySales),
      newUnits, newSales: round2(newSales),
    };
  }

  const periods = {
    all: sumWindow(dateList),
    d30: sumWindow(d30Dates),
    prev30: sumWindow(prev30Dates),
    d15: sumWindow(d15Dates),
    prev15: sumWindow(prev15Dates),
    d7: sumWindow(d7Dates),
    prev7: sumWindow(prev7Dates),
  };

  // Models summary (14 models)
  const modelMap = {};
  skus.forEach(s => { (modelMap[s.model] ||= []).push(s); });
  const models = Object.entries(modelMap).map(([model, arr]) => {
    const units = arr.reduce((a, x) => a + x.totalUnits, 0);
    const orders = arr.reduce((a, x) => a + x.totalOrders, 0);
    const sales = round2(arr.reduce((a, x) => a + x.totalSales, 0));
    const d15Units = arr.reduce((a, x) => a + x.d15Units, 0);
    const prev15Units = arr.reduce((a, x) => a + x.prev15Units, 0);
    const d15Sales = round2(arr.reduce((a, x) => a + x.d15Sales, 0));
    const prev15Sales = round2(arr.reduce((a, x) => a + x.prev15Sales, 0));
    const d7Units = arr.reduce((a, x) => a + x.d7Units, 0);
    const prev7Units = arr.reduce((a, x) => a + x.prev7Units, 0);
    const d7Sales = round2(arr.reduce((a, x) => a + x.d7Sales, 0));
    const prev7Sales = round2(arr.reduce((a, x) => a + x.prev7Sales, 0));
    const d30Units = arr.reduce((a, x) => a + x.d30Units, 0);
    const prev30Units = arr.reduce((a, x) => a + x.prev30Units, 0);
    const d30Sales = round2(arr.reduce((a, x) => a + x.d30Sales, 0));
    const prev30Sales = round2(arr.reduce((a, x) => a + x.prev30Sales, 0));

    const fbaSellable = arr.reduce((a, x) => a + x.fbaSellable, 0);
    const fbaReserved = arr.reduce((a, x) => a + x.fbaReserved, 0);
    const fbaTransit = arr.reduce((a, x) => a + x.fbaTransit, 0);
    const fbaTotal = arr.reduce((a, x) => a + x.fbaTotal, 0);
    const firstSaleDates = arr.map(x => x.firstSaleDate).filter(Boolean).sort();
    const firstSaleDate = firstSaleDates[0] || '';
    const cohort = arr[0].cohort;
    const d15Daily = d15Units / 15;
    const estSellableDos = d15Daily > 0 ? round1(fbaSellable / d15Daily) : 999;
    const estTotalDos = d15Daily > 0 ? round1(fbaTotal / d15Daily) : 999;
    const lowDosSkus = arr.filter(x => x.dos < 21).length;
    const overStockSkus = arr.filter(x => x.dos > 180).length;

    let grade = '稳健增长';
    if (cohort === '11月新品') {
      grade = d15Units >= 40 ? '新品黑马放量' : (d15Units >= 15 ? '新品起量爬坡' : '新品冷启培育');
    } else if (d15Sales > prev15Sales * 1.15) {
      grade = '老品加速放量';
    } else if (d15Sales < prev15Sales * 0.85) {
      grade = '老品环比回落';
    }

    return {
      model,
      modelDisplay: MODEL_DISPLAY[model] || model,
      cohort,
      skusCount: arr.length,
      firstSaleDate,
      units, orders, sales,
      unitsShare: totalUnitsAll > 0 ? units / totalUnitsAll : 0,
      salesShare: totalSalesAll > 0 ? sales / totalSalesAll : 0,
      asp: units > 0 ? round2(sales / units) : 0,
      d15Units, prev15Units, d15Sales, prev15Sales,
      d15SalesPct: prev15Sales > 0 ? (d15Sales - prev15Sales) / prev15Sales : null,
      d7Units, prev7Units, d7Sales, prev7Sales,
      d7SalesPct: prev7Sales > 0 ? (d7Sales - prev7Sales) / prev7Sales : null,
      d30Units, prev30Units, d30Sales, prev30Sales,
      d30SalesPct: prev30Sales > 0 ? (d30Sales - prev30Sales) / prev30Sales : null,
      fbaSellable, fbaReserved, fbaTransit, fbaTotal,
      estSellableDos, estTotalDos, lowDosSkus, overStockSkus, grade,
    };
  }).sort((a, b) => b.sales - a.sales);

  // Colors summary (8 colors)
  const colorMap = {};
  skus.forEach(s => { (colorMap[s.color] ||= []).push(s); });
  const colors = Object.entries(colorMap).map(([color, arr]) => {
    const units = arr.reduce((a, x) => a + x.totalUnits, 0);
    const sales = round2(arr.reduce((a, x) => a + x.totalSales, 0));
    const d15Units = arr.reduce((a, x) => a + x.d15Units, 0);
    const d15Sales = round2(arr.reduce((a, x) => a + x.d15Sales, 0));
    const d7Units = arr.reduce((a, x) => a + x.d7Units, 0);
    const d7Sales = round2(arr.reduce((a, x) => a + x.d7Sales, 0));
    const fbaSellable = arr.reduce((a, x) => a + x.fbaSellable, 0);
    const fbaTransit = arr.reduce((a, x) => a + x.fbaTransit, 0);
    const fbaTotal = arr.reduce((a, x) => a + x.fbaTotal, 0);
    const stockToD15 = d15Units > 0 ? round1((fbaTotal / (d15Units / 15))) : 999;
    let advice = '正常动销';
    if (units >= 270) advice = '核心主力色：保障不断货，重点配比补货';
    else if (units >= 180) advice = '中坚畅销色：随主力色按比例补货';
    else if (units < 110 && fbaTotal > 500) advice = '滞销积压色：严控补货，建议捆绑/促销清仓';
    else advice = '长尾辅助色：小批量维持在库即可';

    return {
      color, colorCn: COLOR_CN_MAP[color] || color,
      skusCount: arr.length, units, sales,
      unitsShare: totalUnitsAll > 0 ? units / totalUnitsAll : 0,
      salesShare: totalSalesAll > 0 ? sales / totalSalesAll : 0,
      asp: units > 0 ? round2(sales / units) : 0,
      d15Units, d15Sales, d7Units, d7Sales,
      fbaSellable, fbaTransit, fbaTotal, stockToD15, advice,
    };
  }).sort((a, b) => b.sales - a.sales);

  // 14x8 Model x Color Matrix
  const matrix = models.map(m => {
    const row = { model: m.model, modelDisplay: m.modelDisplay, cohort: m.cohort, cells: {} };
    for (const c of COLOR_ORDER) {
      const s = skus.find(x => x.model === m.model && x.color === c);
      row.cells[c] = s ? {
        msku: s.msku, units: s.totalUnits, sales: s.totalSales,
        d15Units: s.d15Units, d7Units: s.d7Units, fbaTotal: s.fbaTotal,
        fbaSellable: s.fbaSellable, dos: s.dos,
      } : null;
    }
    return row;
  });

  // Inventory Buckets
  const BUCKET_DEFS = [
    { key: '断货高危 (<15天)', tone: 'red', test: s => s.dos < 15 },
    { key: '偏紧预警 (15-30天)', tone: 'amber', test: s => s.dos >= 15 && s.dos < 30 },
    { key: '健康周转 (30-90天)', tone: 'green', test: s => s.dos >= 30 && s.dos <= 90 },
    { key: '偏高观察 (90-180天)', tone: 'blue', test: s => s.dos > 90 && s.dos <= 180 },
    { key: '严重积压 (>180天)', tone: 'purple', test: s => s.dos > 180 },
  ];
  const totalFbaAll = skus.reduce((a, x) => a + x.fbaTotal, 0);
  const invBuckets = BUCKET_DEFS.map(b => {
    const arr = skus.filter(b.test);
    const fbaSellable = arr.reduce((a, x) => a + x.fbaSellable, 0);
    const fbaTransit = arr.reduce((a, x) => a + x.fbaTransit, 0);
    const fbaTotal = arr.reduce((a, x) => a + x.fbaTotal, 0);
    const sales = round2(arr.reduce((a, x) => a + x.totalSales, 0));
    const units = arr.reduce((a, x) => a + x.totalUnits, 0);
    return {
      key: b.key, tone: b.tone, skusCount: arr.length,
      fbaSellable, fbaTransit, fbaTotal,
      fbaShare: totalFbaAll > 0 ? fbaTotal / totalFbaAll : 0,
      units, sales,
      salesShare: totalSalesAll > 0 ? sales / totalSalesAll : 0,
    };
  });

  // Cohort summary
  const cohorts = ['老品主力', '11月新品'].map(c => {
    const arr = skus.filter(s => s.cohort === c);
    const units = arr.reduce((a, x) => a + x.totalUnits, 0);
    const sales = round2(arr.reduce((a, x) => a + x.totalSales, 0));
    const d15Units = arr.reduce((a, x) => a + x.d15Units, 0);
    const d15Sales = round2(arr.reduce((a, x) => a + x.d15Sales, 0));
    const prev15Sales = round2(arr.reduce((a, x) => a + x.prev15Sales, 0));
    const d7Units = arr.reduce((a, x) => a + x.d7Units, 0);
    const d7Sales = round2(arr.reduce((a, x) => a + x.d7Sales, 0));
    const fbaSellable = arr.reduce((a, x) => a + x.fbaSellable, 0);
    const fbaTotal = arr.reduce((a, x) => a + x.fbaTotal, 0);
    return {
      cohort: c,
      modelsCount: new Set(arr.map(x => x.model)).size,
      skusCount: arr.length,
      units, unitsShare: totalUnitsAll > 0 ? units / totalUnitsAll : 0,
      sales, salesShare: totalSalesAll > 0 ? sales / totalSalesAll : 0,
      d15Units, d15Sales,
      d15Share: periods.d15.sales > 0 ? d15Sales / periods.d15.sales : 0,
      prev15Sales,
      d7Units, d7Sales,
      d7Share: periods.d7.sales > 0 ? d7Sales / periods.d7.sales : 0,
      fbaSellable, fbaTotal,
      fbaShare: totalFbaAll > 0 ? fbaTotal / totalFbaAll : 0,
    };
  });

  const inventorySummary = {
    fbaSellable: skus.reduce((a, x) => a + x.fbaSellable, 0),
    fbaReserved: skus.reduce((a, x) => a + x.fbaReserved, 0),
    fbaTransit: skus.reduce((a, x) => a + x.fbaTransit, 0),
    fbaUnsellable: skus.reduce((a, x) => a + x.fbaUnsellable, 0),
    fbaInvestigating: skus.reduce((a, x) => a + x.fbaInvestigating, 0),
    fbaTotal: totalFbaAll,
    lowDosCount: skus.filter(x => x.dos < 21).length,
    criticalDosCount: skus.filter(x => x.dos < 15).length,
    overstockCount: skus.filter(x => x.dos > 180).length,
    d15EstSellableDays: periods.d15.dailyAvgUnits > 0 ? round1(skus.reduce((a, x) => a + x.fbaSellable, 0) / periods.d15.dailyAvgUnits) : 0,
    d15EstTotalDays: periods.d15.dailyAvgUnits > 0 ? round1(totalFbaAll / periods.d15.dailyAvgUnits) : 0,
  };

  return {
    meta: {
      brand: 'UPBestKS',
      store: skus[0]?.store || '宿州图派-US',
      site: skus[0]?.site || '美国',
      sourcePath,
      sourceUpdatedAt: new Date(fs.statSync(sourcePath).mtimeMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
      earliestDate, latestDate, totalDays,
      skusCount: skus.length,
      modelsCount: models.length,
      colorsCount: colors.length,
    },
    summary: {
      totalUnits: totalUnitsAll,
      totalOrders: totalOrdersAll,
      totalSales: totalSalesAll,
      asp: totalUnitsAll > 0 ? round2(totalSalesAll / totalUnitsAll) : 0,
      dailyAvgUnits: round2(totalUnitsAll / totalDays),
      dailyAvgSales: round2(totalSalesAll / totalDays),
      abcACount: skusSorted.filter(x => x.abcClass === 'A类核心').length,
      abcBCount: skusSorted.filter(x => x.abcClass === 'B类中坚').length,
      abcCCount: skusSorted.filter(x => x.abcClass === 'C类长尾').length,
    },
    periods,
    cohorts,
    monthly,
    weekly,
    daily,
    models,
    colors,
    matrix,
    invBuckets,
    inventorySummary,
    skus: skusSorted,
    saihu: loadSaihuReplenishment(resolveSaihuCsv()),
  };
}
