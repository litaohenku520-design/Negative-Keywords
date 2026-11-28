import ExcelJS from 'exceljs';

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile('D:/反重力/UPBestKS/广告数据/asin补货建议(0)-20261126164307529.xlsx');
const ws = wb.worksheets[0];

const headers = ws.getRow(1).values.map(v => String(v || '').trim());
const records = [];

for (let r = 2; r <= ws.rowCount; r++) {
  const row = ws.getRow(r);
  const obj = {};
  headers.forEach((h, colIdx) => {
    if (!h) return;
    const cellVal = row.getCell(colIdx).value;
    obj[h] = cellVal !== null && cellVal !== undefined ? String(cellVal).trim() : '';
  });
  if (obj['MSKU']) records.push(obj);
}

console.log(`Total parsed records: ${records.length}`);

// Analysis 1: 哪些需要提前补货还没进行采购的
console.log('\n======================================================');
console.log('【判断1：需要提前补货还没进行采购的 SKU】');
console.log('======================================================');

const needPurchNoPo = records.filter(r => {
  const purchSug = Number(r['建议采购量（汇总）'] || 0);
  const purchB1 = Number(r['建议采购量（第1批）'] || 0);
  const replSug = Number(r['建议补货量（汇总）'] || 0);
  const hasPurchDate = Boolean(r['建议采购日']);
  const purchTransit = Number(r['采购在途'] || 0);
  const purchPlan = Number(r['采购计划'] || 0);
  const localStock = Number(r['本地仓可用'] || 0);

  // Suggested to purchase/replenish > 0, but no purchase in transit
  const hasDemand = purchSug > 0 || replSug > 0 || hasPurchDate;
  const noPurch = purchTransit === 0 && purchPlan === 0;
  return hasDemand && noPurch;
});

console.log(`符合条件（有建议采购/补货需求，但采购在途=0且采购计划=0）共: ${needPurchNoPo.length} 款`);

needPurchNoPo.sort((a, b) => {
  const dosA = Number(a['在库库存可售天数(FBA)'] || 999);
  const dosB = Number(b['在库库存可售天数(FBA)'] || 999);
  return dosA - dosB;
});

needPurchNoPo.forEach((r, idx) => {
  console.log(`${idx + 1}. MSKU: ${r['MSKU']}`);
  console.log(`   品名: ${r['品名']} | 日均销: ${r['日均销量（动态）']} 件/天`);
  console.log(`   FBA可售: ${r['可售']} 件 | 在库DOS: ${r['在库库存可售天数(FBA)']} 天 | 预估断货DOS: ${r['预估断货前可售天数(FBA)']} 天 | 断货日: ${r['断货日期（FBA）'] || '未预警'}`);
  console.log(`   建议采购日: ${r['建议采购日'] || '—'}`);
  console.log(`   建议采购汇总: ${r['建议采购量（汇总）']} (第1批: ${r['建议采购量（第1批）']}) | 建议补货汇总: ${r['建议补货量（汇总）']}`);
  console.log(`   本地仓可用: ${r['本地仓可用']} 件 | FBA在途: ${r['FBA在途']} 件`);
  const shipDates = [
    r['本地仓至FBA发货日 (FBA海运（默认）-35)'],
    r['本地仓至FBA发货日 (FBA空运（默认）-15)'],
    r['本地仓至FBA发货日 (美国慢船-智善)']
  ].filter(Boolean).join(' ; ');
  if (shipDates) console.log(`   本地建议发FBA日: ${shipDates}`);
  console.log('');
});

// Analysis 2: 已经采购的（采购在途 > 0 或 本地仓可用 > 0）
console.log('\n======================================================');
console.log('【判断2：已经采购 / 采购在途 / 本地仓待发货状态诊断】');
console.log('======================================================');

const purchasedItems = records.filter(r => {
  const purchTransit = Number(r['采购在途'] || 0);
  const localStock = Number(r['本地仓可用'] || 0);
  return purchTransit > 0 || localStock > 0;
});

console.log(`已采购相关（采购在途>0 或 本地仓可用>0）共: ${purchasedItems.length} 款`);

purchasedItems.forEach((r, idx) => {
  const pt = Number(r['采购在途'] || 0);
  const ls = Number(r['本地仓可用'] || 0);
  const ft = Number(r['FBA在途'] || 0);
  const fs = Number(r['可售'] || 0);
  const dos = Number(r['在库库存可售天数(FBA)'] || 0);
  const estDos = Number(r['预估断货前可售天数(FBA)'] || 0);
  const shipDates = [
    r['本地仓至FBA发货日 (FBA海运（默认）-35)'],
    r['本地仓至FBA发货日 (FBA空运（默认）-15)'],
    r['本地仓至FBA发货日 (美国慢船-智善)']
  ].filter(Boolean).join(' ; ');

  console.log(`${idx + 1}. MSKU: ${r['MSKU']}`);
  console.log(`   品名: ${r['品名']} | 采购在途: ${pt} 件 | 本地仓可用: ${ls} 件`);
  console.log(`   FBA可售: ${fs} 件 | FBA在途: ${ft} 件 | 在库DOS: ${dos} 天 | 预估断货DOS: ${estDos} 天`);
  console.log(`   本地仓发FBA日建议: ${shipDates || '无建议发货日'}`);
  console.log(`   建议采购日: ${r['建议采购日'] || '无'}`);
  console.log('');
});
