import fs from 'node:fs';

function parseCSV(text) {
  const rows = [];
  let row = [];
  let inQuotes = false;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i+1];
    if (c === '"') {
      if (inQuotes && next === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (c === ',' && !inQuotes) {
      row.push(cur); cur = '';
    } else if ((c === '\r' || c === '\n') && !inQuotes) {
      if (c === '\r' && next === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else {
      cur += c;
    }
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const content = fs.readFileSync('D:/反重力/UPBestKS/UPBestKS_赛狐补货建议_2026-11-26.csv', 'utf8');
const rows = parseCSV(content);
const headers = rows[0].map(h => h.trim());
console.log('Total data rows:', rows.length - 1);

const records = rows.slice(1).map(r => {
  const obj = {};
  headers.forEach((h, idx) => obj[h] = (r[idx] || '').trim());
  return obj;
});

// Check non-zero fields
const keyCols = [
  'MSKU', 'SKU', '品名', '补货诊断',
  '本地仓可用', '待加工', '待质检', '待上架', '采购在途', '采购计划',
  '可售', '预留转运', '预留处理中', 'FBA在途', 'FBA库存',
  '日均销量（动态）', '在库库存可售天数(FBA)', '预估断货前可售天数(FBA)', '断货日期（FBA）',
  '建议采购量（汇总）', '建议采购量（第1批）', '建议采购日',
  '建议补货量（汇总）', '建议补货量（备货周期）',
  '本地仓至FBA发货日 (FBA海运（默认）-35)', '本地仓至FBA发货日 (FBA空运（默认）-15)', '本地仓至FBA发货日 (美国慢船-智善)',
  '更新时间', '上架时间'
];

console.log('=== 1. Summary of Items with 建议采购量 > 0 or 建议采购日 ===');
const needPurch = records.filter(r => {
  const q = Number(r['建议采购量（汇总）'] || 0);
  const q1 = Number(r['建议采购量（第1批）'] || 0);
  const d = r['建议采购日'];
  return q > 0 || q1 > 0 || Boolean(d);
});
console.log(`Found ${needPurch.length} items with purchase recommendations:`);
needPurch.forEach(r => {
  console.log(`- MSKU: ${r['MSKU']} | SKU: ${r['SKU']}`);
  console.log(`  建议采购日: ${r['建议采购日']} | 建议采购汇总: ${r['建议采购量（汇总）']} (第1批: ${r['建议采购量（第1批）']})`);
  console.log(`  建议补货汇总: ${r['建议补货量（汇总）']} | 日均销: ${r['日均销量（动态）']}`);
  console.log(`  采购在途: ${r['采购在途']} | 本地仓可用: ${r['本地仓可用']} | 待质检: ${r['待质检']}`);
  console.log(`  FBA可售: ${r['可售']} | FBA在途: ${r['FBA在途']} | 在库DOS: ${r['在库库存可售天数(FBA)']}天 | 预估断货DOS: ${r['预估断货前可售天数(FBA)']}天 | 断货日: ${r['断货日期（FBA）']}`);
  console.log(`  本地发FBA发货日(海运35): ${r['本地仓至FBA发货日 (FBA海运（默认）-35)']} | 空运15: ${r['本地仓至FBA发货日 (FBA空运（默认）-15)']}`);
  console.log('---');
});

console.log('\n=== 2. Check 采购在途 > 0 or 本地仓可用 > 0 or 采购计划 > 0 ===');
const inProc = records.filter(r => {
  const purchTransit = Number(r['采购在途'] || 0);
  const purchPlan = Number(r['采购计划'] || 0);
  const localStock = Number(r['本地仓可用'] || 0);
  const inspectStock = Number(r['待质检'] || 0) + Number(r['待加工'] || 0) + Number(r['待上架'] || 0);
  return purchTransit > 0 || purchPlan > 0 || localStock > 0 || inspectStock > 0;
});
console.log(`Found ${inProc.length} items with existing procurement / local stock:`);
inProc.forEach(r => {
  console.log(`- MSKU: ${r['MSKU']}`);
  console.log(`  采购在途: ${r['采购在途']} | 采购计划: ${r['采购计划']} | 本地仓可用: ${r['本地仓可用']} | 待质检加工: ${Number(r['待质检']||0) + Number(r['待加工']||0)}`);
  console.log(`  FBA可售: ${r['可售']} | FBA在途: ${r['FBA在途']} | 在库DOS: ${r['在库库存可售天数(FBA)']}天`);
  console.log(`  建议采购日: ${r['建议采购日']} | 建议采购量: ${r['建议采购量（汇总）']} | 建议补货量: ${r['建议补货量（汇总）']}`);
  console.log(`  本地仓发FBA发货日: 海运=${r['本地仓至FBA发货日 (FBA海运（默认）-35)']} 空运=${r['本地仓至FBA发货日 (FBA空运（默认）-15)']}`);
  console.log('---');
});

console.log('\n=== 3. Inspect All Unique Values for 采购在途, 建议采购量, etc. ===');
const purchTransitMap = records.map(r => ({ msku: r['MSKU'], v: r['采购在途'] })).filter(x => Number(x.v || 0) > 0);
console.log('Non-zero 采购在途:', purchTransitMap);

const localAvailMap = records.map(r => ({ msku: r['MSKU'], v: r['本地仓可用'] })).filter(x => Number(x.v || 0) > 0);
console.log('Non-zero 本地仓可用:', localAvailMap);

const fbaTransitMap = records.map(r => ({ msku: r['MSKU'], v: r['FBA在途'] })).filter(x => Number(x.v || 0) > 0);
console.log('Count of items with FBA在途 > 0:', fbaTransitMap.length);

const workingMap = records.map(r => ({ msku: r['MSKU'], v: r['WORKING（正在处理）'] })).filter(x => Number(x.v || 0) > 0);
console.log('Count of items with WORKING > 0:', workingMap.length);

const shippedMap = records.map(r => ({ msku: r['MSKU'], v: r['SHIPPED（已寄送）'] })).filter(x => Number(x.v || 0) > 0);
console.log('Count of items with SHIPPED > 0:', shippedMap.length);

const inTransitMap = records.map(r => ({ msku: r['MSKU'], v: r['IN_TRANSIT（运送途中）'] })).filter(x => Number(x.v || 0) > 0);
console.log('Count of items with IN_TRANSIT > 0:', inTransitMap.length);

const receivingMap = records.map(r => ({ msku: r['MSKU'], v: r['RECEIVING（收到货件）'] })).filter(x => Number(x.v || 0) > 0);
console.log('Count of items with RECEIVING > 0:', receivingMap.length);
