import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { DATA_DIR, ensureExportDir, loadConfig, readAllSheets, readSpreadsheetRows } from './file-io.mjs';

const SNAPSHOT_PATH = path.join(DATA_DIR, 'inventory-sales-result.json');
const SALES_DAYS_DEFAULT = 22;
const ALERT_DANGER_DAYS = 15;
const ALERT_WARNING_DAYS = 30;
const TRANSIT_DAYS = { usSea: 40, usAir: 15, usExpress: 30, euTruck: 30, euAir: 15 };

const SUANDUCK_FIELDS = {
  asin: [/^asin$/], parentAsin: [/^父asin$/, /^parentasin$/], msku: [/^msku$/], sku: [/^sku$/],
  productName: [/^品名$/, /^product.?name$/, /^title$/], site: [/^站点$/, /^site$/], shop: [/^店铺$/, /^shop$/],
  fbaDaysSource: [/^fba可售天数$/], fbaAvailable: [/^fba可售$/, /afn.fulfillable.quantity$/],
  fbaUnsellable: [/^不可售$/, /^fba不可售$/, /afn.unsellable.quantity$/],
  fbaReserved: [/^fba预留数$/, /^fba预留$/, /afn.reserved.quantity$/],
  reservedTransit: [/^预留转运$/], reservedProcessing: [/^预留处理中$/], inboundReceiving: [/^入库正在接收$/],
  reservedOrder: [/^预留订单$/], inboundProcessing: [/^入库处理中$/], inboundShipped: [/^入库已发货$/],
  fbaInTransit: [/^fba在途$/], investigating: [/^调查中$/], fbaTotal: [/^fba总库存$/, /afn.total.quantity$/],
  avgDailySales: [/^均值$/, /^日均销量$/, /daily.sales/], subtotal: [/^小计$/, /^销量小计$/], monthSales: [/^month.sales$/],
};

const AD_FIELDS = {
  portfolioName: [/^广告组合名称$/, /^portfolio name$/], currency: [/^货币$/, /^currency$/],
  campaignName: [/^广告活动名称$/, /^campaign name$/], adGroupName: [/^广告组名称$/, /^ad group name$/],
  retailer: [/^零售商$/, /^retailer$/], country: [/^国家\/地区$/, /^country$/],
  advertisedSku: [/^广告sku$/, /^advertised sku$/], advertisedAsin: [/^广告asin$/, /^advertised asin$/],
  impressions: [/^展示量$/, /^impressions$/], clicks: [/^点击量$/, /^clicks$/],
  ctr: [/^点击率.*ctr.*$/, /^click.through rate.*ctr.*$/], cpc: [/^单次点击成本.*cpc.*$/, /^cost per click.*cpc.*$/],
  spend: [/^花费$/, /^spend$/], sales7d: [/^7天总销售额$/, /^7 day total sales$/],
  acos: [/^广告投入产出比.*acos.*$/, /^total advertising cost of sales.*acos.*$/],
  roas: [/^总广告投资回报率.*roas.*$/, /^total return on advertising spend.*roas.*$/],
  orders7d: [/^7天总订单数.*$/, /^7 day total orders.*$/], units7d: [/^7天总销售量.*$/, /^7 day total units.*$/],
  conversionRate: [/^7天的转化率$/, /^7 day conversion rate$/], adSkuUnits7d: [/^7天内广告sku销售量.*$/, /^7 day advertised sku units.*$/],
  otherSkuUnits7d: [/^7天内其他sku销售量.*$/, /^7 day other sku units.*$/], adSkuSales7d: [/^7天内广告sku销售额$/, /^7 day advertised sku sales$/],
  otherSkuSales7d: [/^7天内其他sku销售额$/, /^7 day other sku sales$/],
};

function normalizeHeader(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s\-_()（）:#]/g, '');
}

function findColumn(headers, patterns, fallback = -1) {
  const raw = headers.map((header) => String(header ?? '').trim().toLowerCase());
  const normalized = headers.map(normalizeHeader);
  for (const pattern of patterns) {
    const idx = normalized.findIndex((header, index) => pattern.test(header) || pattern.test(raw[index]));
    if (idx >= 0) return idx;
  }
  return fallback;
}

function numberValue(value) {
  if (value == null || value === '') return 0;
  const cleaned = String(value).replace(/[$,%¥€£,\s]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function ratioValue(value) {
  if (value == null || value === '') return 0;
  const text = String(value).trim();
  const n = numberValue(text);
  if (!Number.isFinite(n)) return 0;
  if (text.endsWith('%') || n > 1) return n / 100;
  return n;
}

function stringValue(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeMatch(value) {
  return stringValue(value).toUpperCase();
}

function getValue(row, headers, field, config = {}) {
  const key = config[field];
  const idx = Number.isInteger(key) ? key : findColumn(headers, SUANDUCK_FIELDS[field] || []);
  return idx >= 0 ? row[idx] : '';
}

async function loadSheets(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm') return await readAllSheets(filePath);
  if (ext === '.csv') {
    const parsed = await readSpreadsheetRows(filePath, 0);
    return { [parsed.sheetName || 'CSV']: parsed.rows };
  }
  throw new Error('仅支持 XLSX、XLSM、CSV 文件：' + path.basename(filePath));
}

function findSheet(sheets, names) {
  const wanted = names.map((name) => normalizeHeader(name));
  const key = Object.keys(sheets).find((name) => wanted.includes(normalizeHeader(name)));
  return key ? sheets[key] : null;
}

function parseSuanduckSheet(rows, columnMapping = {}) {
  if (!Array.isArray(rows) || rows.length < 2) return new Map();
  const headers = rows[0].map(stringValue);
  const columns = {};
  for (const [field, patterns] of Object.entries(SUANDUCK_FIELDS)) {
    columns[field] = Number.isInteger(columnMapping[field]) ? columnMapping[field] : findColumn(headers, patterns);
  }
  const monthIdx = findColumn(headers, [/^\d{4}年\d{1,2}月$/, /^\d{4}-\d{2}$/]);
  columns.monthSales = Number.isInteger(columnMapping.monthSales) ? columnMapping.monthSales : monthIdx;
  if (columns.msku < 0) columns.msku = 2;

  const result = new Map();
  for (const row of rows.slice(1)) {
    const msku = stringValue(row[columns.msku]);
    if (!msku) continue;
    const record = {};
    for (const [field, idx] of Object.entries(columns)) {
      record[field] = idx >= 0 ? row[idx] : '';
    }
    for (const field of ['asin', 'parentAsin', 'msku', 'sku', 'productName', 'site', 'shop']) record[field] = stringValue(record[field]);
    for (const field of Object.keys(SUANDUCK_FIELDS)) {
      if (!['asin', 'parentAsin', 'msku', 'sku', 'productName', 'site', 'shop'].includes(field)) record[field] = numberValue(record[field]);
    }
    result.set(msku, record);
  }
  return result;
}

async function parseSalesSource(filePath, columnMapping = {}) {
  const sheets = await loadSheets(filePath);
  const qtyRows = findSheet(sheets, ['销量', 'Sales', 'Quantity']);
  const amountRows = findSheet(sheets, ['销售额', 'Sales Amount', 'Revenue']);
  const orderRows = findSheet(sheets, ['订单量', 'Orders', 'Order Quantity']);
  if (qtyRows) {
    return {
      type: 'saihu',
      fileName: path.basename(filePath),
      salesQty: parseSuanduckSheet(qtyRows, columnMapping),
      salesAmt: amountRows ? parseSuanduckSheet(amountRows, columnMapping) : new Map(),
      orders: orderRows ? parseSuanduckSheet(orderRows, columnMapping) : new Map(),
      headers: (qtyRows[0] || []).map(stringValue),
    };
  }

  const sheetName = Object.keys(sheets)[0];
  const rows = sheets[sheetName] || [];
  if (rows.length < 2) throw new Error('报表「' + path.basename(filePath) + '」为空或仅有表头');
  const headers = rows[0].map(stringValue);
  const generic = new Map();
  for (const row of rows.slice(1)) {
    const skuIdx = findColumn(headers, [/^msku$/, /^sku$/, /seller.?sku/, /advertised.?sku/]);
    const asinIdx = findColumn(headers, [/^asin$/, /advertised.?asin/]);
    const sku = stringValue(row[skuIdx]);
    const asin = stringValue(row[asinIdx]);
    const key = sku || asin;
    if (!key) continue;
    const get = (field) => getValue(row, headers, field, columnMapping);
    generic.set(key, {
      asin, msku: sku, sku,
      parentAsin: '', productName: stringValue(row[findColumn(headers, [/品名/, /product.?name/, /title/])]),
      site: '', shop: '', fbaAvailable: numberValue(get('fbaAvailable')),
      fbaUnsellable: numberValue(get('fbaUnsellable')), fbaReserved: numberValue(get('fbaReserved')),
      reservedTransit: numberValue(get('reservedTransit')), reservedProcessing: numberValue(get('reservedProcessing')),
      reservedOrder: numberValue(get('reservedOrder')), investigating: numberValue(get('investigating')),
      fbaTotal: numberValue(get('fbaTotal')), fbaInTransit: numberValue(get('fbaInTransit')),
      inboundShipped: numberValue(get('inboundShipped')), inboundReceiving: numberValue(get('inboundReceiving')),
      inboundProcessing: numberValue(get('inboundProcessing')), avgDailySales: numberValue(get('avgDailySales')),
      subtotal: numberValue(get('subtotal')), monthSales: numberValue(get('monthSales')),
    });
  }
  return { type: 'generic', fileName: path.basename(filePath), salesQty: generic, salesAmt: new Map(), orders: new Map(), headers };
}

function parseAdRows(rows, columnMapping = {}) {
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('广告商品报告为空或仅有表头');
  const headers = rows[0].map(stringValue);
  const columns = {};
  for (const [field, patterns] of Object.entries(AD_FIELDS)) {
    columns[field] = Number.isInteger(columnMapping[field]) ? columnMapping[field] : findColumn(headers, patterns);
  }
  // 亚马逊推广商品报告旧版无表头或列名变化时，C-J 与 K-Y 固定列布局兜底。
  if (columns.portfolioName < 0) columns.portfolioName = 2;
  if (columns.currency < 0) columns.currency = 3;
  if (columns.campaignName < 0) columns.campaignName = 4;
  if (columns.adGroupName < 0) columns.adGroupName = 5;
  if (columns.retailer < 0) columns.retailer = 6;
  if (columns.country < 0) columns.country = 7;
  if (columns.advertisedSku < 0) columns.advertisedSku = 8;
  if (columns.advertisedAsin < 0) columns.advertisedAsin = 9;
  const fallbackMetrics = { impressions: 10, clicks: 11, ctr: 12, cpc: 13, spend: 14, sales7d: 15, acos: 16, roas: 17, orders7d: 18, units7d: 19, conversionRate: 20, adSkuUnits7d: 21, otherSkuUnits7d: 22, adSkuSales7d: 23, otherSkuSales7d: 24 };
  for (const [field, idx] of Object.entries(fallbackMetrics)) if (columns[field] < 0) columns[field] = idx;

  return rows.slice(1).filter((row) => row && (row[columns.advertisedSku] != null || row[columns.advertisedAsin] != null)).map((row) => {
    const out = {};
    for (const [field, idx] of Object.entries(columns)) {
      const raw = idx >= 0 ? row[idx] : '';
      if (['portfolioName', 'currency', 'campaignName', 'adGroupName', 'retailer', 'country', 'advertisedSku', 'advertisedAsin'].includes(field)) out[field] = stringValue(raw);
      else if (['ctr', 'acos', 'conversionRate'].includes(field)) out[field] = ratioValue(raw);
      else out[field] = numberValue(raw);
    }
    return out;
  });
}

async function parseAdFile(filePath, columnMapping = {}) {
  const sheets = await loadSheets(filePath);
  const name = Object.keys(sheets)[0];
  return parseAdRows(sheets[name] || [], columnMapping);
}

function mergeAdPeriods(yesterdayRows, thirtyDayRows) {
  if (!yesterdayRows?.length) return { rows: thirtyDayRows || [], matchedRows: 0, unmatchedRows: 0, unusedRows: 0 };
  if (!thirtyDayRows?.length) return { rows: yesterdayRows, matchedRows: 0, unmatchedRows: 0, unusedRows: 0 };
  const matchFields = ['portfolioName', 'currency', 'campaignName', 'adGroupName', 'retailer', 'country', 'advertisedSku', 'advertisedAsin'];
  const metricFields = ['impressions', 'clicks', 'ctr', 'cpc', 'spend', 'sales7d', 'acos', 'roas', 'orders7d', 'units7d', 'conversionRate', 'adSkuUnits7d', 'otherSkuUnits7d', 'adSkuSales7d', 'otherSkuSales7d'];
  const keyOf = (row) => JSON.stringify(matchFields.map((field) => stringValue(row[field]).toLowerCase()));
  const index = new Map();
  for (const row of thirtyDayRows) {
    const key = keyOf(row);
    if (index.has(key)) throw new Error('30天广告报告存在重复的 C-J 匹配组合，请检查报告后重新导入。');
    index.set(key, row);
  }
  const seen = new Set();
  let unmatchedRows = 0;
  const rows = yesterdayRows.map((yesterday) => {
    const key = keyOf(yesterday);
    if (seen.has(key)) throw new Error('昨日广告报告存在重复的 C-J 匹配组合，请检查报告后重新导入。');
    seen.add(key);
    const thirty = index.get(key);
    if (!thirty) unmatchedRows++;
    const merged = { ...yesterday };
    for (const field of metricFields) merged[field] = thirty ? thirty[field] : 0;
    return merged;
  });
  return { rows, matchedRows: rows.length - unmatchedRows, unmatchedRows, unusedRows: Math.max(0, thirtyDayRows.length - (rows.length - unmatchedRows)) };
}

async function parseFbaFile(filePath, keyName = 'asin', columnMapping = {}) {
  if (!filePath) return new Map();
  const sheets = await loadSheets(filePath);
  const sheetName = Object.keys(sheets)[0];
  const rows = sheets[sheetName] || [];
  if (rows.length < 2) return new Map();
  const headers = rows[0].map(stringValue);
  const patterns = {
    sku: [/^sku$/], asin: [/^asin$/], fnsku: [/^fnsku$/], productName: [/^product.name$/, /^product_name$/, /^品名$/],
    afnWarehouse: [/^afn.warehouse.quantity$/], afnFulfillable: [/^afn.fulfillable.quantity$/],
    afnUnsellable: [/^afn.unsellable.quantity$/], afnReserved: [/^afn.reserved.quantity$/], afnTotal: [/^afn.total.quantity$/],
    afnInboundShipped: [/^afn.inbound.shipped.quantity$/], afnInboundReceiving: [/^afn.inbound.receiving.quantity$/],
    afnFulfillableLocal: [/^afn.fulfillable.quantity.local$/, /^afn.fc.transfer.quantity$/],
    afnFulfillableRemote: [/^afn.fulfillable.quantity.remote$/, /^afn.onhand.buyable.quantity$/],
  };
  const cols = {};
  for (const [field, list] of Object.entries(patterns)) cols[field] = Number.isInteger(columnMapping[field]) ? columnMapping[field] : findColumn(headers, list);
  const map = new Map();
  for (const row of rows.slice(1)) {
    const record = {};
    for (const [field, idx] of Object.entries(cols)) record[field] = idx >= 0 ? row[idx] : '';
    record.sku = stringValue(record.sku);
    record.asin = stringValue(record.asin);
    record.fnsku = stringValue(record.fnsku);
    record.productName = stringValue(record.productName);
    if (!record.sku && !record.asin) continue;
    for (const field of Object.keys(cols)) if (!['sku', 'asin', 'fnsku', 'productName'].includes(field)) record[field] = numberValue(record[field]);
    const key = normalizeMatch(record[keyName] || record.asin || record.sku);
    if (key) map.set(key, record);
  }
  return map;
}

function parseShippingMethod(name, country = '') {
  const text = (stringValue(name) + ' ' + stringValue(country)).toLowerCase();
  if (text.includes('快船') || text.includes('express')) return 'usExpress';
  if (text.includes('空运') || text.includes('air') || text.includes('航空')) return /欧洲|eu|uk|gb|de|fr/.test(text) ? 'euAir' : 'usAir';
  if (text.includes('卡航') || text.includes('truck') || text.includes('陆运') || text.includes('卡车')) return 'euTruck';
  return 'usSea';
}

function parseDate(value) {
  const text = stringValue(value);
  if (!text) return '';
  const match = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) return match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0');
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

async function parseShipmentFile(filePath, keyName = 'asin', columnMapping = {}) {
  if (!filePath) return new Map();
  const sheets = await loadSheets(filePath);
  const rows = sheets[Object.keys(sheets)[0]] || [];
  if (rows.length < 2) return new Map();
  const headers = rows[0].map(stringValue);
  const autoCols = {
    asin: findColumn(headers, [/^asin$/]), msku: findColumn(headers, [/^msku$/]), sku: findColumn(headers, [/^sku$/]),
    name: findColumn(headers, [/^货件名称$/, /^shipment name$/]), id: findColumn(headers, [/^货件编号$/, /^shipment id$/]),
    status: findColumn(headers, [/^货件状态$/, /^shipment status$/]), create: findColumn(headers, [/^创建时间$/, /^create time$/]),
    country: findColumn(headers, [/^国家$/, /^country$/]), shipCount: findColumn(headers, [/^发货量.*$/]),
  };
  const cols = Object.fromEntries(Object.entries(autoCols).map(([field, idx]) => [field, Number.isInteger(columnMapping[field]) ? columnMapping[field] : idx]));
  const groups = new Map();
  for (const row of rows.slice(1)) {
    const asin = stringValue(row[cols.asin]);
    const msku = stringValue(row[cols.msku]);
    const sku = stringValue(row[cols.sku]);
    const key = normalizeMatch(keyName === 'msku' ? msku : keyName === 'sku' ? sku : asin || msku || sku);
    const status = stringValue(row[cols.status]);
    if (!key || /cancel|取消|作废/i.test(status)) continue;
    const shipmentName = stringValue(row[cols.name]);
    const method = parseShippingMethod(shipmentName, row[cols.country]);
    const transitDays = TRANSIT_DAYS[method] || 0;
    const shipDate = parseDate(row[cols.create]);
    const eta = shipDate ? new Date(new Date(shipDate + 'T00:00:00').getTime() + transitDays * 86400000).toISOString().slice(0, 10) : '';
    const shipment = { shipmentId: stringValue(row[cols.id]), shipmentName, status, asin, msku, sku, shipCount: numberValue(row[cols.shipCount]), method, transitDays, shipDate, eta };
    const list = groups.get(key) || [];
    list.push(shipment);
    groups.set(key, list);
  }
  for (const list of groups.values()) list.sort((a, b) => (a.eta || '9999').localeCompare(b.eta || '9999'));
  return groups;
}

function chooseSalesRows(source, dataDays, keyName) {
  const rows = [];
  for (const [msku, qty] of source.salesQty.entries()) {
    const amount = source.salesAmt.get(msku) || {};
    const order = source.orders.get(msku) || {};
    const totalSales = numberValue(order.subtotal || order.monthSales || qty.subtotal || qty.monthSales);
    const totalRevenue = numberValue(amount.subtotal || amount.monthSales || 0);
    const avgDailySales = totalSales > 0 ? totalSales / dataDays : numberValue(qty.avgDailySales);
    rows.push({
      ...qty,
      msku: qty.msku || msku,
      totalSales,
      totalRevenue,
      avgDailySales,
      fbaAvailable: numberValue(order.fbaAvailable || qty.fbaAvailable),
      fbaTotal: numberValue(order.fbaTotal || qty.fbaTotal),
      fbaInTransit: numberValue(order.fbaInTransit || qty.fbaInTransit),
      matchValue: normalizeMatch(qty[keyName] || qty.asin || qty.msku || qty.sku),
    });
  }
  return rows;
}

function campaignTotals(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = [row.portfolioName, row.campaignName, row.adGroupName].join('|');
    const item = map.get(key) || { portfolioName: row.portfolioName, campaignName: row.campaignName, adGroupName: row.adGroupName, spend: 0, sales7d: 0, orders7d: 0, units7d: 0, impressions: 0, clicks: 0 };
    item.spend += row.spend || 0;
    item.sales7d += row.sales7d || 0;
    item.orders7d += row.orders7d || 0;
    item.units7d += row.units7d || 0;
    item.impressions += row.impressions || 0;
    item.clicks += row.clicks || 0;
    map.set(key, item);
  }
  return [...map.values()].map((item) => ({
    ...item,
    ctr: item.impressions > 0 ? item.clicks / item.impressions : 0,
    cpc: item.clicks > 0 ? item.spend / item.clicks : 0,
    acos: item.sales7d > 0 ? item.spend / item.sales7d : 0,
    roas: item.spend > 0 ? item.sales7d / item.spend : 0,
    conversionRate: item.clicks > 0 ? item.orders7d / item.clicks : 0,
  }));
}

function buildRecord(sales, fba, adRows, shipmentRows, dataDays) {
  const adSpend = adRows.reduce((sum, row) => sum + numberValue(row.spend), 0);
  const adRevenue = adRows.reduce((sum, row) => sum + numberValue(row.sales7d), 0);
  const adSales = adRows.reduce((sum, row) => sum + numberValue(row.units7d), 0);
  const adOrders = adRows.reduce((sum, row) => sum + numberValue(row.orders7d), 0);
  const adImpressions = adRows.reduce((sum, row) => sum + numberValue(row.impressions), 0);
  const adClicks = adRows.reduce((sum, row) => sum + numberValue(row.clicks), 0);
  const totalSales = numberValue(sales?.totalSales);
  const totalRevenue = numberValue(sales?.totalRevenue);
  const fbaAvailable = sales ? numberValue(sales.fbaAvailable) : numberValue(fba?.afnFulfillable);
  const fbaTotal = sales ? numberValue(sales.fbaTotal) : numberValue(fba?.afnTotal);
  const avgDailySales = totalSales > 0 ? totalSales / dataDays : numberValue(sales?.avgDailySales);
  const fbaDays = avgDailySales > 0 ? Math.round(fbaAvailable / avgDailySales) : 0;
  const fbaVerified = Boolean(sales && fba && numberValue(fba.afnTotal) === fbaTotal && numberValue(fba.afnFulfillable) === fbaAvailable);
  const firstShipment = shipmentRows?.[0] || null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysUntilArrival = firstShipment?.eta ? Math.ceil((new Date(firstShipment.eta + 'T00:00:00').getTime() - today.getTime()) / 86400000) : null;
  const stockoutBeforeArrivalDays = daysUntilArrival == null ? fbaDays : daysUntilArrival - fbaDays;
  const naturalSales = Math.max(0, totalSales - adSales);
  const naturalRevenue = Math.max(0, totalRevenue - adRevenue);
  const alertLevel = totalSales <= 0 ? 'noSales' : fbaDays <= ALERT_DANGER_DAYS ? 'danger' : fbaDays <= ALERT_WARNING_DAYS ? 'warning' : 'safe';
  const key = sales?.matchValue || normalizeMatch(adRows[0]?.advertisedAsin || adRows[0]?.advertisedSku || fba?.asin || fba?.sku);
  return {
    key: key || String(Math.random()),
    asin: sales?.asin || fba?.asin || adRows.find((r) => r.advertisedAsin)?.advertisedAsin || '',
    sku: sales?.sku || fba?.sku || adRows.find((r) => r.advertisedSku)?.advertisedSku || '',
    msku: sales?.msku || '',
    parentAsin: sales?.parentAsin || '',
    productName: sales?.productName || fba?.productName || '',
    site: sales?.site || '', shop: sales?.shop || '',
    fbaAvailable, fbaTotal, fbaDays,
    fbaUnsellable: numberValue(sales?.fbaUnsellable ?? fba?.afnUnsellable),
    fbaReserved: numberValue(sales?.fbaReserved ?? fba?.afnReserved),
    reservedTransit: numberValue(sales?.reservedTransit), reservedProcessing: numberValue(sales?.reservedProcessing),
    reservedOrder: numberValue(sales?.reservedOrder), investigating: numberValue(sales?.investigating),
    avgDailySales: Math.round(avgDailySales * 100) / 100,
    fbaInTransit: numberValue(sales?.fbaInTransit || fba?.afnInboundShipped),
    inboundShipped: numberValue(sales?.inboundShipped || fba?.afnInboundShipped),
    inboundReceiving: numberValue(sales?.inboundReceiving || fba?.afnInboundReceiving),
    inboundProcessing: numberValue(sales?.inboundProcessing),
    fbaVerified, fbaDiscrepancy: sales && fba ? numberValue(fba.afnTotal) - fbaTotal : 0,
    fbaActualAvailable: fba ? numberValue(fba.afnFulfillable) : -1,
    fbaActualTotal: sales && fba ? numberValue(fba.afnTotal) : -1,
    fbaWarehouse: fba ? numberValue(fba.afnWarehouse) : -1,
    fbaCsvUnsellable: fba ? numberValue(fba.afnUnsellable) : -1,
    fbaCsvReserved: fba ? numberValue(fba.afnReserved) : -1,
    fbaFulfillableLocal: numberValue(fba?.afnFulfillableLocal),
    fbaFulfillableRemote: numberValue(fba?.afnFulfillableRemote),
    totalSales, naturalSales, adSales, adSalesRatio: totalSales > 0 ? adSales / totalSales : 0,
    totalOrders: totalSales, adOrders, naturalOrders: Math.max(0, totalSales - adOrders), adOrderRatio: totalSales > 0 ? adOrders / totalSales : 0,
    totalRevenue, naturalRevenue, adRevenue, adRevenueRatio: totalRevenue > 0 ? adRevenue / totalRevenue : 0,
    adSpend, adImpressions, adClicks,
    adCTR: adImpressions > 0 ? adClicks / adImpressions : 0,
    adCPC: adClicks > 0 ? adSpend / adClicks : 0,
    adACOS: adRevenue > 0 ? adSpend / adRevenue : 0,
    adROAS: adSpend > 0 ? adRevenue / adSpend : 0,
    adCVR: adClicks > 0 ? adOrders / adClicks : 0,
    portfolioDetails: campaignTotals(adRows),
    campaignName: adRows[0]?.campaignName || '-',
    adGroupName: adRows[0]?.adGroupName || '',
    campaignNames: [...new Set(adRows.map((row) => row.campaignName).filter(Boolean))],
    portfolioNames: [...new Set(adRows.map((row) => row.portfolioName).filter(Boolean))],
    alertLevel, daysOfInventory: fbaDays, stockoutDays: fbaDays,
    shippingMethod: firstShipment?.method || '未存在发货计划',
    transitDays: firstShipment?.transitDays || 0,
    shipDate: firstShipment?.shipDate || null,
    estimatedArrivalDate: firstShipment?.eta || '',
    daysUntilArrival,
    daysUntilStockout: fbaDays,
    stockoutBeforeArrivalDays,
    shipmentId: firstShipment?.shipmentId || '',
    shipmentStatus: firstShipment?.status || '',
    inventoryTurnoverRate: fbaTotal > 0 ? Math.round((avgDailySales * 31 * 6 / fbaTotal) * 100) / 100 : 0,
    dataDays,
  };
}

function summarize(items, sources, adMerge) {
  const summary = items.reduce((acc, row) => {
    acc.totalSales += row.totalSales;
    acc.totalAdSales += row.adSales;
    acc.totalNaturalSales += row.naturalSales;
    acc.totalAdSpend += row.adSpend;
    acc.totalRevenue += row.totalRevenue;
    acc.totalAdRevenue += row.adRevenue;
    acc.totalFbaAvailable += row.fbaAvailable;
    acc.totalFbaInTransit += row.fbaInTransit;
    acc.dangerCount += row.alertLevel === 'danger' ? 1 : 0;
    acc.warningCount += row.alertLevel === 'warning' ? 1 : 0;
    acc.noSalesCount += row.alertLevel === 'noSales' ? 1 : 0;
    acc.fbaDiscrepancyCount += row.fbaActualTotal >= 0 && !row.fbaVerified ? 1 : 0;
    return acc;
  }, { total: items.length, totalSales: 0, totalAdSales: 0, totalNaturalSales: 0, totalAdSpend: 0, totalRevenue: 0, totalAdRevenue: 0, totalFbaAvailable: 0, totalFbaInTransit: 0, dangerCount: 0, warningCount: 0, noSalesCount: 0, fbaDiscrepancyCount: 0 });
  summary.adSalesPercent = summary.totalSales > 0 ? summary.totalAdSales / summary.totalSales : 0;
  summary.naturalSalesPercent = summary.totalSales > 0 ? summary.totalNaturalSales / summary.totalSales : 0;
  summary.adAcos = summary.totalAdRevenue > 0 ? summary.totalAdSpend / summary.totalAdRevenue : 0;
  summary.adRoas = summary.totalAdSpend > 0 ? summary.totalAdRevenue / summary.totalAdSpend : 0;
  return { ...summary, sources, adMerge };
}

export function loadInventorySalesResult() {
  try { return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')); } catch { return null; }
}

export function clearInventorySalesResult() {
  try { if (fs.existsSync(SNAPSHOT_PATH)) fs.unlinkSync(SNAPSHOT_PATH); } catch { /* best effort */ }
}

function writeInventoryWorkbook(result) {
  const cfg = loadConfig();
  const outDir = ensureExportDir(cfg);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const exportPath = path.join(outDir, '库存销售分析_' + ts + '.xlsx');
  const wb = new ExcelJS.Workbook();
  const summarySheet = wb.addWorksheet('分析汇总');
  summarySheet.addRows([
    ['指标', '值'],
    ['商品数', result.summary.total], ['总销量', result.summary.totalSales], ['广告销量', result.summary.totalAdSales],
    ['自然销量', result.summary.totalNaturalSales], ['广告花费', result.summary.totalAdSpend], ['总销售额', result.summary.totalRevenue],
    ['断货预警', result.summary.dangerCount], ['补货预警', result.summary.warningCount], ['无销量', result.summary.noSalesCount],
    ['FBA库存差异', result.summary.fbaDiscrepancyCount], ['销售周期(天)', result.dataDays],
  ]);
  summarySheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  summarySheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  summarySheet.columns = [{ width: 24 }, { width: 20 }];

  const sheet = wb.addWorksheet('库存销售明细');
  const headers = ['ASIN', 'MSKU', 'SKU', '品名', '广告活动', '广告组', 'FBA可售', 'FBA总库存', 'FBA在途', '日均销量', '总销量', '广告销量', '自然销量', '总销售额', '广告销售额', '广告花费', '广告ACOS%', 'ROAS', '展示量', '点击量', 'CTR%', '可售天数', '货件名称', '预计到货', '到货前断货天数', 'FBA核对', '库存差异', '预警状态'];
  sheet.addRow(headers);
  for (const row of result.rows) {
    sheet.addRow([row.asin, row.msku, row.sku, row.productName, row.campaignNames.join(' | '), row.adGroupName,
      row.fbaAvailable, row.fbaTotal, row.fbaInTransit, row.avgDailySales, row.totalSales, row.adSales, row.naturalSales,
      row.totalRevenue, row.adRevenue, row.adSpend, row.adACOS * 100, row.adROAS, row.adImpressions, row.adClicks,
      row.adCTR * 100, row.fbaDays, row.shipmentId ? row.shipmentId + ' ' + row.shippingMethod : '', row.estimatedArrivalDate,
      row.stockoutBeforeArrivalDays, row.fbaActualTotal < 0 ? '未提供 FBA 快照' : row.fbaVerified ? '一致' : '有差异', row.fbaDiscrepancy, row.alertLevel]);
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'AB1' };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  sheet.columns = headers.map((header, idx) => ({ header, width: [0, 1, 2, 3, 4, 5].includes(idx) ? 22 : 15 }));
  for (let i = 2; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i);
    const risk = row.getCell(28).value;
    if (risk === 'danger') row.getCell(28).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCCC7' } };
    else if (risk === 'warning') row.getCell(28).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE7BA' } };
  }
  const adSheet = wb.addWorksheet('广告活动明细');
  adSheet.addRow(['ASIN', 'MSKU', 'Portfolio', 'Campaign', 'Ad Group', 'Spend', 'Sales', 'Orders', 'Units', 'Impressions', 'Clicks', 'ACOS%', 'ROAS', 'CTR%']);
  for (const row of result.rows) for (const ad of row.portfolioDetails) {
    adSheet.addRow([row.asin, row.msku, ad.portfolioName, ad.campaignName, ad.adGroupName, ad.spend, ad.sales7d, ad.orders7d, ad.units7d, ad.impressions, ad.clicks, ad.acos * 100, ad.roas, ad.ctr * 100]);
  }
  adSheet.views = [{ state: 'frozen', ySplit: 1 }];
  adSheet.autoFilter = { from: 'A1', to: 'N1' };
  adSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  adSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  adSheet.columns = Array.from({ length: 14 }, (_, idx) => ({ width: idx < 5 ? 22 : 15 }));
  return wb.xlsx.writeFile(exportPath).then(() => exportPath);
}

export async function analyzeInventorySales({
  filePath,
  fbaFilePath,
  adFilePath,
  adYesterdayFilePath,
  ad30dFilePath,
  shipmentFilePath,
  columnMapping = {},
  matchKeyConfig = {},
  dataDays = SALES_DAYS_DEFAULT,
  stockoutWarnDays,
  overstockWarnDays,
  exportExcel = true,
}) {
  const cfg = loadConfig();
  const salesDays = Math.max(1, Number(dataDays) || SALES_DAYS_DEFAULT);
  const sourcePath = filePath || fbaFilePath || adYesterdayFilePath || ad30dFilePath || adFilePath;
  if (!sourcePath) throw new Error('请至少选择赛狐库存销售报告');

  const sales = await parseSalesSource(sourcePath, columnMapping.suanduck || {});
  const adYPath = adYesterdayFilePath || adFilePath || '';
  const ad30Path = ad30dFilePath || '';
  const yesterdayRows = adYPath ? await parseAdFile(adYPath, columnMapping.ad || {}) : [];
  const thirtyRows = ad30Path && ad30Path !== adYPath ? await parseAdFile(ad30Path, columnMapping.ad30d || columnMapping.ad || {}) : [];
  const adMerge = adYPath && ad30Path && adYPath !== ad30Path
    ? mergeAdPeriods(yesterdayRows, thirtyRows)
    : { rows: yesterdayRows.length ? yesterdayRows : thirtyRows, matchedRows: 0, unmatchedRows: 0, unusedRows: 0 };
  const adRows = adMerge.rows;
  const fbaMap = await parseFbaFile(fbaFilePath, matchKeyConfig.fbaKey || 'asin', columnMapping.fba || {});
  const shipmentMap = await parseShipmentFile(shipmentFilePath, matchKeyConfig.shipmentKey || 'asin', columnMapping.shipment || {});
  const salesKey = matchKeyConfig.suanduckKey || 'asin';
  const adKey = matchKeyConfig.adProductKey || 'advertisedAsin';
  const fbaKey = matchKeyConfig.fbaKey || 'asin';
  const shipmentKey = matchKeyConfig.shipmentKey || 'asin';

  const salesRows = chooseSalesRows(sales, salesDays, salesKey);
  const salesByKey = new Map();
  for (const row of salesRows) if (row.matchValue) salesByKey.set(row.matchValue, row);
  const usedSalesKeys = new Set();
  const records = [];
  const fbaLookupKey = fbaKey;
  for (const ad of adRows) {
    const matchValue = normalizeMatch(ad[adKey] || ad.advertisedAsin || ad.advertisedSku);
    const salesRow = salesByKey.get(matchValue) || null;
    const fba = fbaMap.get(normalizeMatch((salesRow && salesRow[fbaLookupKey]) || ad[adKey] || ad.advertisedAsin || ad.advertisedSku)) || null;
    const shipmentMatch = normalizeMatch((salesRow && salesRow[shipmentKey]) || ad[adKey] || ad.advertisedAsin || ad.advertisedSku);
    const shipments = shipmentMap.get(shipmentMatch) || [];
    if (salesRow) {
      usedSalesKeys.add(salesRow.matchValue);
    }
    records.push(buildRecord(salesRow, fba, [ad], shipments, salesDays));
  }

  // 保留无广告投放的 ERP 商品行，与 ERP 原页面一致。
  for (const salesRow of salesRows) {
    if (usedSalesKeys.has(salesRow.matchValue)) continue;
    const fbaMatch = normalizeMatch(salesRow[fbaKey] || salesRow.asin || salesRow.sku);
    const shipmentMatch = normalizeMatch(salesRow[shipmentKey] || salesRow.asin || salesRow.sku);
    records.push(buildRecord(salesRow, fbaMap.get(fbaMatch) || null, [], shipmentMap.get(shipmentMatch) || [], salesDays));
  }

  // 若只上传 FBA 快照，保留该快照中的 SKU，避免用户无法分析库存差异。
  if (!salesRows.length && !adRows.length) {
    for (const [, fba] of fbaMap) records.push(buildRecord(null, fba, [], [], salesDays));
  }

  records.sort((a, b) => (b.totalSales - a.totalSales) || (b.adSpend - a.adSpend) || a.sku.localeCompare(b.sku));
  records.forEach((row, index) => { row.key = String(row.key || row.asin || row.msku || row.sku || 'row') + ':' + (index + 1); });
  const cumulativeMetric = records.reduce((sum, row) => sum + (row.totalSales || 0), 0);
  let cumulative = 0;
  for (const row of records) {
    cumulative += row.totalSales || 0;
    const share = cumulativeMetric > 0 ? cumulative / cumulativeMetric : 1;
    row.abc = share <= 0.7 ? 'A' : share <= 0.9 ? 'B' : 'C';
  }

  const sourceNames = {
    sales: path.basename(sourcePath),
    fba: fbaFilePath ? path.basename(fbaFilePath) : '',
    adYesterday: adYPath ? path.basename(adYPath) : '',
    ad30d: ad30Path ? path.basename(ad30Path) : '',
    shipments: shipmentFilePath ? path.basename(shipmentFilePath) : '',
  };
  const summary = summarize(records, sourceNames, adMerge);
  const result = {
    fileName: sourceNames.sales,
    sourceType: sales.type,
    sheetName: sales.type === 'saihu' ? '销量 / 销售额 / 订单量' : '通用报表',
    extraSources: [sourceNames.fba && 'FBA:' + sourceNames.fba, sourceNames.adYesterday && '广告昨天:' + sourceNames.adYesterday, sourceNames.ad30d && '广告30天:' + sourceNames.ad30d, sourceNames.shipments && '货件:' + sourceNames.shipments].filter(Boolean),
    totalSkus: records.length,
    totalAvail: summary.totalFbaAvailable,
    totalTransit: summary.totalFbaInTransit,
    totalSales: summary.totalSales,
    totalAdSpend: Math.round(summary.totalAdSpend * 100) / 100,
    riskCounts: { 断货高危: summary.dangerCount, 补货预警: summary.warningCount, 健康: records.filter((row) => row.alertLevel === 'safe').length, 库龄积压: 0, 无动销积压: summary.noSalesCount },
    summary,
    dataDays: salesDays,
    alertThresholds: { dangerDays: ALERT_DANGER_DAYS, warningDays: ALERT_WARNING_DAYS },
    exportPath: null,
    rows: records,
    previewRows: records.slice(0, 200),
    generatedAt: new Date().toISOString(),
  };

  if (exportExcel) result.exportPath = await writeInventoryWorkbook(result);
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(result), 'utf8');
  return result;
}
