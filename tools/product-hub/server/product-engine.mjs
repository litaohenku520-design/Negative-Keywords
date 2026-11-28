import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

export const DATA_DIR = 'C:\\Users\\admin\\DeskBox\\UPBestKS-Clyfen\\UPBestKS\\产品分析';
export const REPORT_OUT_PATH = path.join(DATA_DIR, 'UPBestKS_产品广告与销售深度分析报告.xlsx');

export const COLOR_ORDER = [
  { en: 'Black', cn: '黑色', hex: '#1E293B' },
  { en: 'Wine Red', cn: '酒红', hex: '#881337' },
  { en: 'Blue', cn: '蓝色', hex: '#2563EB' },
  { en: 'Deep Purple', cn: '深紫', hex: '#6D28D9' },
  { en: 'Light Brown', cn: '橙色', hex: '#D97706' },
  { en: 'Blue Green', cn: '蓝绿色', hex: '#0D9488' },
  { en: 'Red', cn: '红色', hex: '#DC2626' },
  { en: 'Rose Gold', cn: '玫瑰金', hex: '#EC4899' },
];

export const COLOR_META = Object.fromEntries(COLOR_ORDER.map((c) => [c.en, c]));

export const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
export const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
export const round4 = (v) => Math.round((Number(v) || 0) * 10000) / 10000;

function num(v) {
  if (v === null || v === undefined || v === '' || v === '***' || v === '-') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'object' && v.result !== undefined) return num(v.result);
  const s = String(v).replace(/[$,%\s,]/g, '');
  const parsed = Number(s);
  return Number.isFinite(parsed) ? parsed : 0;
}

function str(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.text) return String(v.text).trim();
  return String(v).trim();
}

function detectBrand(model) {
  const m = model.toLowerCase();
  if (m.startsWith('ip')) return 'Apple iPhone';
  if (m.startsWith('s2') || m.startsWith('a1')) return 'Samsung Galaxy';
  if (m.startsWith('moto')) return 'Motorola';
  if (m.startsWith('pixel')) return 'Google Pixel';
  return 'Other';
}

function findLatestSourceExcel() {
  if (!fs.existsSync(DATA_DIR)) {
    throw new Error(`产品分析数据目录不存在: ${DATA_DIR}`);
  }
  const files = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith('产品分析-MSKU-列表-汇总') && f.endsWith('.xlsx') && !f.startsWith('~$'))
    .sort()
    .reverse();
  if (!files.length) {
    throw new Error(`在 ${DATA_DIR} 未找到 产品分析-MSKU-列表-汇总-*.xlsx 文件`);
  }
  return path.join(DATA_DIR, files[0]);
}

function parseSkuMeta(sku, pinming, msku) {
  // Expected SKU: R64/CX-<Model>-<ColorEn>
  // Expected 品名: R64/CX-<Model>-<ColorCn>
  const sBody = (sku || msku || '').replace(/^R64\/CX-/, '');
  const pBody = (pinming || '').replace(/^R64\/CX-/, '');
  const sIdx = sBody.lastIndexOf('-');
  const pIdx = pBody.lastIndexOf('-');
  const model = sIdx > 0 ? sBody.slice(0, sIdx) : sBody;
  const colorEn = sIdx > 0 ? sBody.slice(sIdx + 1) : 'Unknown';
  const colorCn = pIdx > 0 ? pBody.slice(pIdx + 1) : COLOR_META[colorEn]?.cn || colorEn;
  const brand = detectBrand(model);
  return { model, colorEn, colorCn, brand };
}

function aggregateGroup(items, keyFn) {
  const map = new Map();
  for (const x of items) {
    const k = keyFn(x);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  const result = [];
  for (const [key, list] of map.entries()) {
    const units = list.reduce((a, b) => a + b.units, 0);
    const orders = list.reduce((a, b) => a + b.orders, 0);
    const d3 = list.reduce((a, b) => a + b.d3, 0);
    const d7 = list.reduce((a, b) => a + b.d7, 0);
    const d14 = list.reduce((a, b) => a + b.d14, 0);
    const d30 = list.reduce((a, b) => a + b.d30, 0);
    const d60 = list.reduce((a, b) => a + b.d60, 0);
    const d90 = list.reduce((a, b) => a + b.d90, 0);
    const sales = round2(list.reduce((a, b) => a + b.sales, 0));
    const netSales = round2(list.reduce((a, b) => a + b.netSales, 0));
    const proceeds = round2(list.reduce((a, b) => a + b.proceeds, 0));
    const promoSales = round2(list.reduce((a, b) => a + b.promoSales, 0));
    const refundAmt = round2(list.reduce((a, b) => a + b.refundAmt, 0));
    const refundQty = list.reduce((a, b) => a + b.refundQty, 0);
    const returnQty = list.reduce((a, b) => a + b.returnQty, 0);
    const sessions = list.reduce((a, b) => a + b.sessions, 0);
    const pv = list.reduce((a, b) => a + b.pv, 0);
    const natOrders = list.reduce((a, b) => a + b.natOrders, 0);
    const adImpr = list.reduce((a, b) => a + b.adImpr, 0);
    const adClicks = list.reduce((a, b) => a + b.adClicks, 0);
    const adSpend = round2(list.reduce((a, b) => a + b.adSpend, 0));
    const spSpend = round2(list.reduce((a, b) => a + b.spSpend, 0));
    const sbSpend = round2(list.reduce((a, b) => a + b.sbSpend, 0));
    const sdSpend = round2(list.reduce((a, b) => a + b.sdSpend, 0));
    const adSales = round2(list.reduce((a, b) => a + b.adSales, 0));
    const selfAdSales = round2(list.reduce((a, b) => a + b.selfAdSales, 0));
    const adOrders = list.reduce((a, b) => a + b.adOrders, 0);
    const selfAdOrders = list.reduce((a, b) => a + b.selfAdOrders, 0);
    const adUnits = list.reduce((a, b) => a + b.adUnits, 0);
    const fbaSellable = list.reduce((a, b) => a + b.fbaSellable, 0);
    const fbaAvail = list.reduce((a, b) => a + b.fbaAvail, 0);
    const fbaInbound = list.reduce((a, b) => a + b.fbaInbound, 0);
    const totalInv = list.reduce((a, b) => a + b.totalInv, 0);
    const suggestReplenish = list.reduce((a, b) => a + b.suggestReplenish, 0);
    const age91_180 = list.reduce((a, b) => a + b.age91_180, 0);
    const age181Plus = list.reduce((a, b) => a + b.age181Plus, 0);
    const reviews = list.reduce((a, b) => a + b.reviews, 0);
    const badReviews = list.reduce((a, b) => a + b.badReviews, 0);

    const rated = list.filter((x) => x.rating > 0 && x.reviews > 0);
    const ratingSum = rated.reduce((a, b) => a + b.rating * b.reviews, 0);
    const ratingCnt = rated.reduce((a, b) => a + b.reviews, 0);
    const avgRating = ratingCnt > 0 ? round2(ratingSum / ratingCnt) : (list.find((x) => x.rating > 0)?.rating || 0);

    const asp = units > 0 ? round2(sales / units) : 0;
    const cvr = sessions > 0 ? round4(orders / sessions) : 0;
    const ctr = adImpr > 0 ? round4(adClicks / adImpr) : 0;
    const cpc = adClicks > 0 ? round2(adSpend / adClicks) : 0;
    const adCvr = adClicks > 0 ? round4(adOrders / adClicks) : 0;
    const acos = adSales > 0 ? round4(adSpend / adSales) : 0;
    const tacos = sales > 0 ? round4(adSpend / sales) : 0;
    const refundRate = units > 0 ? round4(refundQty / units) : 0;
    const returnRate = units > 0 ? round4(returnQty / units) : 0;
    const adOrderShare = orders > 0 ? round4(adOrders / orders) : 0;
    const natOrderShare = orders > 0 ? round4(natOrders / orders) : 0;
    const dailyVelocity30 = round2(d30 / 30);
    const estDos = dailyVelocity30 > 0 ? round1(fbaAvail / dailyVelocity30) : (fbaAvail > 0 ? 999 : 0);

    result.push({
      key,
      skuCount: list.length,
      units,
      orders,
      d3,
      d7,
      d14,
      d30,
      d60,
      d90,
      sales,
      netSales,
      proceeds,
      promoSales,
      asp,
      refundAmt,
      refundQty,
      returnQty,
      refundRate,
      returnRate,
      sessions,
      pv,
      cvr,
      natOrders,
      natOrderShare,
      adImpr,
      adClicks,
      ctr,
      adSpend,
      spSpend,
      sbSpend,
      sdSpend,
      cpc,
      adCvr,
      adSales,
      selfAdSales,
      crossAdSales: round2(Math.max(0, adSales - selfAdSales)),
      adOrders,
      selfAdOrders,
      adUnits,
      adOrderShare,
      acos,
      tacos,
      fbaSellable,
      fbaAvail,
      fbaInbound,
      totalInv,
      suggestReplenish,
      age91_180,
      age181Plus,
      reviews,
      badReviews,
      avgRating,
      estDos,
      items: list,
    });
  }
  return result;
}

export async function computeProductAnalytics() {
  const sourcePath = findLatestSourceExcel();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(sourcePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('Excel 文件中未找到工作表');

  const headerRow = ws.getRow(1);
  const colMap = new Map();
  headerRow.eachCell((cell, colNumber) => {
    const h = str(cell.value);
    if (h) colMap.set(h, colNumber);
  });

  const get = (row, name) => {
    const c = colMap.get(name);
    return c ? row.getCell(c).value : null;
  };

  const skus = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const msku = str(get(row, 'MSKU'));
    if (!msku) continue;

    const sku = str(get(row, 'SKU'));
    const pinming = str(get(row, '品名'));
    const { model, colorEn, colorCn, brand } = parseSkuMeta(sku, pinming, msku);
    const launchDate = str(get(row, '上架时间')).slice(0, 10);
    const batch = launchDate <= '2026-07-15' ? '首批老品 (07-05)' : '二批新品 (09-16)';

    const units = num(get(row, '销量'));
    const orders = num(get(row, '订单量'));
    const sales = round2(num(get(row, '销售额')));
    const netSales = round2(num(get(row, '净销售额')));
    const proceeds = round2(num(get(row, '销售收益')));
    const promoSales = round2(num(get(row, '促销销售额')));
    const refundAmt = round2(num(get(row, '退款')));
    const refundQty = num(get(row, '退款量'));
    const returnQty = num(get(row, '退货量'));
    const sessions = num(get(row, 'Sessions'));
    const pv = num(get(row, 'PV'));
    const natOrders = num(get(row, '自然订单量'));
    const adImpr = num(get(row, '广告曝光量'));
    const adClicks = num(get(row, '广告点击量'));
    const adSpend = round2(num(get(row, '广告花费')));
    const spSpend = round2(num(get(row, 'SP广告花费')));
    const sbSpend = round2(
      num(get(row, 'SB商品集广告花费')) +
      num(get(row, 'SB旗舰店广告花费')) +
      num(get(row, 'SB视频广告花费'))
    );
    const sdSpend = round2(num(get(row, 'SD广告花费')));
    const adSales = round2(num(get(row, '广告销售额')));
    const selfAdSales = round2(num(get(row, '本产品广告销售额')));
    const adOrders = num(get(row, '广告订单量'));
    const selfAdOrders = num(get(row, '本产品广告订单量'));
    const adUnits = num(get(get(row, '广告销量')));

    const asp = units > 0 ? round2(sales / units) : round2(num(get(row, '平均售价')));
    const cvr = sessions > 0 ? round4(orders / sessions) : num(get(row, '转化率'));
    const ctr = adImpr > 0 ? round4(adClicks / adImpr) : num(get(row, '广告点击率'));
    const cpc = adClicks > 0 ? round2(adSpend / adClicks) : num(get(row, 'CPC'));
    const adCvr = adClicks > 0 ? round4(adOrders / adClicks) : num(get(row, '广告转化率'));
    const acos = adSales > 0 ? round4(adSpend / adSales) : num(get(row, 'ACoS'));
    const tacos = sales > 0 ? round4(adSpend / sales) : num(get(row, 'ACoAS'));
    const refundRate = units > 0 ? round4(refundQty / units) : num(get(row, '退款率'));
    const returnRate = units > 0 ? round4(returnQty / units) : num(get(row, '退货率'));

    const age91_180 = num(get(row, '91-180天库龄'));
    const age181Plus = num(get(row, '181-270天库龄')) + num(get(row, '271-365天库龄')) + num(get(row, '365+天库龄'));

    skus.push({
      asin: str(get(row, 'ASIN')),
      parentAsin: str(get(row, '父ASIN')),
      msku,
      sku,
      pinming,
      fnsku: str(get(row, 'FNSKU')),
      title: str(get(row, '标题')),
      imageUrl: str(get(row, '图片链接')),
      store: str(get(row, '店铺')),
      site: str(get(row, '站点')),
      model,
      colorEn,
      colorCn,
      colorHex: COLOR_META[colorEn]?.hex || '#64748B',
      brand,
      launchDate,
      batch,
      priceRange: str(get(row, '价格')),
      promoPrice: str(get(row, '优惠价')),
      d3: num(get(row, '3天销量')),
      d7: num(get(row, '7天销量')),
      d14: num(get(row, '14天销量')),
      d30: num(get(row, '30天销量')),
      d60: num(get(row, '60天销量')),
      d90: num(get(row, '90天销量')),
      units,
      fbaUnits: num(get(row, 'FBA销量')),
      fbmUnits: num(get(row, 'FBM销量')),
      vineUnits: num(get(row, 'VINE销量')),
      promoUnits: num(get(row, '促销销量')),
      orders,
      cancelOrders: num(get(row, '取消订单量')),
      sales,
      netSales,
      proceeds,
      promoSales,
      discount: round2(num(get(row, '商品折扣'))),
      asp,
      refundAmt,
      refundQty,
      returnQty,
      refundRate,
      returnRate,
      fbaSellable: num(get(row, 'FBA可售')),
      fbaAvail: num(get(row, 'FBA可用')),
      fbaInbound: num(get(row, 'FBA在途')),
      totalInv: num(get(row, '总库存')),
      fbaDos: round1(num(get(row, 'FBA可售天数'))),
      suggestReplenish: num(get(row, '建议补货量')),
      age0_30: num(get(row, '0-30天库龄')),
      age31_60: num(get(row, '31-60天库龄')),
      age61_90: num(get(row, '61-90天库龄')),
      age91_180,
      age181Plus,
      sessions,
      sessionsMob: num(get(row, 'Sessions-移动端')),
      sessionsPc: num(get(row, 'Sessions-浏览器')),
      pv,
      cvr,
      bsrSub: num(get(row, '小类目排名')),
      bsrMain: num(get(row, '大类目排名')),
      rating: round2(num(get(row, '星级评分'))),
      reviews: num(get(row, '评分数')),
      badReviews: num(get(row, 'Review中差评数')),
      natOrders,
      natOrderShare: orders > 0 ? round4(natOrders / orders) : 0,
      adImpr,
      adClicks,
      ctr,
      adCvr,
      adSpend,
      spSpend,
      sbSpend,
      sdSpend,
      cpc,
      acos,
      tacos,
      adSales,
      selfAdSales,
      crossAdSales: round2(Math.max(0, adSales - selfAdSales)),
      adOrders,
      selfAdOrders,
      adUnits,
      adOrderShare: orders > 0 ? round4(adOrders / orders) : 0,
    });
  }

  // Assign quadrant diagnosis per SKU
  const avgSales = skus.length ? skus.reduce((a, b) => a + b.sales, 0) / skus.length : 0;
  const avgImpr = skus.length ? skus.reduce((a, b) => a + b.adImpr, 0) / skus.length : 0;
  for (const s of skus) {
    if (s.sales >= avgSales && s.tacos <= 0.38) {
      s.quadrant = '明星爆款';
    } else if (s.tacos > 0.55 || (s.adSpend >= 150 && s.acos > 0.85)) {
      s.quadrant = '高耗预警';
    } else if (s.cvr >= 0.08 && s.adImpr < avgImpr && s.units >= 5) {
      s.quadrant = '高潜待放量';
    } else if (s.sales >= avgSales * 0.6) {
      s.quadrant = '稳健主力';
    } else {
      s.quadrant = '长尾观察';
    }
  }

  const totalSummary = aggregateGroup(skus, () => 'ALL')[0];
  delete totalSummary.items;

  const rawModels = aggregateGroup(skus, (x) => x.model).sort((a, b) => b.sales - a.sales);
  const byModel = rawModels.map((m) => {
    const first = m.items[0];
    const topColor = [...m.items].sort((a, b) => b.sales - a.sales)[0];
    const { items, ...rest } = m;
    return {
      ...rest,
      model: m.key,
      brand: first.brand,
      batch: first.batch,
      launchDate: first.launchDate,
      parentAsin: first.parentAsin,
      salesShare: totalSummary.sales > 0 ? round4(m.sales / totalSummary.sales) : 0,
      adSpendShare: totalSummary.adSpend > 0 ? round4(m.adSpend / totalSummary.adSpend) : 0,
      topColorEn: topColor?.colorEn || '',
      topColorCn: topColor?.colorCn || '',
      topColorSales: topColor?.sales || 0,
    };
  });

  const rawColors = aggregateGroup(skus, (x) => x.colorEn).sort((a, b) => b.sales - a.sales);
  const byColor = rawColors.map((c) => {
    const first = c.items[0];
    const topModel = [...c.items].sort((a, b) => b.sales - a.sales)[0];
    const { items, ...rest } = c;
    return {
      ...rest,
      colorEn: c.key,
      colorCn: first.colorCn,
      colorHex: first.colorHex,
      salesShare: totalSummary.sales > 0 ? round4(c.sales / totalSummary.sales) : 0,
      adSpendShare: totalSummary.adSpend > 0 ? round4(c.adSpend / totalSummary.adSpend) : 0,
      topModel: topModel?.model || '',
      topModelSales: topModel?.sales || 0,
    };
  });

  const byBrand = aggregateGroup(skus, (x) => x.brand)
    .sort((a, b) => b.sales - a.sales)
    .map(({ items, ...rest }) => ({
      ...rest,
      brand: rest.key,
      modelCount: new Set(items.map((x) => x.model)).size,
      salesShare: totalSummary.sales > 0 ? round4(rest.sales / totalSummary.sales) : 0,
    }));

  const byBatch = aggregateGroup(skus, (x) => x.batch)
    .sort((a, b) => b.sales - a.sales)
    .map(({ items, ...rest }) => ({
      ...rest,
      batch: rest.key,
      modelCount: new Set(items.map((x) => x.model)).size,
      salesShare: totalSummary.sales > 0 ? round4(rest.sales / totalSummary.sales) : 0,
    }));

  // Matrix lookup: model -> colorEn -> metrics
  const matrix = {};
  for (const s of skus) {
    if (!matrix[s.model]) matrix[s.model] = {};
    matrix[s.model][s.colorEn] = {
      msku: s.msku,
      asin: s.asin,
      units: s.units,
      d30: s.d30,
      sales: s.sales,
      adSpend: s.adSpend,
      adSales: s.adSales,
      acos: s.acos,
      tacos: s.tacos,
      cvr: s.cvr,
      refundRate: s.refundRate,
      fbaSellable: s.fbaSellable,
      fbaAvail: s.fbaAvail,
      fbaDos: s.fbaDos,
      rating: s.rating,
      quadrant: s.quadrant,
    };
  }

  // Alerts
  const highTacosSkus = skus
    .filter((x) => x.adSpend >= 80 && x.tacos >= 0.55)
    .sort((a, b) => b.adSpend - a.adSpend);
  const highRefundSkus = skus
    .filter((x) => x.units >= 10 && x.refundRate >= 0.12)
    .sort((a, b) => b.refundRate - a.refundRate);
  const lowDosSkus = skus
    .filter((x) => x.d30 >= 5 && x.fbaDos > 0 && x.fbaDos < 21)
    .sort((a, b) => a.fbaDos - b.fbaDos);
  const starSkus = skus
    .filter((x) => x.quadrant === '明星爆款')
    .sort((a, b) => b.sales - a.sales);
  const potentialSkus = skus
    .filter((x) => x.quadrant === '高潜待放量')
    .sort((a, b) => b.cvr - a.cvr);

  const quadrantCounts = {};
  for (const s of skus) {
    quadrantCounts[s.quadrant] = (quadrantCounts[s.quadrant] || 0) + 1;
  }

  return {
    meta: {
      sourceFile: path.basename(sourcePath),
      sourcePath,
      store: skus[0]?.store || '宿州图派-US',
      site: skus[0]?.site || '美国',
      totalSkus: skus.length,
      modelCount: byModel.length,
      colorCount: byColor.length,
      avgSkuSales: round2(avgSales),
      note: '源表中「毛利润/毛利率」字段为脱敏星号(***)，本分析基于销售额、净销售额、销售收益、广告花费及退款等实测字段计算。',
    },
    summary: totalSummary,
    byModel,
    byColor,
    byBrand,
    byBatch,
    matrix,
    quadrantCounts,
    alerts: {
      highTacosCount: highTacosSkus.length,
      highRefundCount: highRefundSkus.length,
      lowDosCount: lowDosSkus.length,
      starCount: starSkus.length,
      potentialCount: potentialSkus.length,
      highTacosSkus: highTacosSkus.slice(0, 15),
      highRefundSkus: highRefundSkus.slice(0, 15),
      lowDosSkus: lowDosSkus.slice(0, 15),
      starSkus: starSkus.slice(0, 15),
      potentialSkus: potentialSkus.slice(0, 15),
    },
    skus: skus.sort((a, b) => b.sales - a.sales),
  };
}
