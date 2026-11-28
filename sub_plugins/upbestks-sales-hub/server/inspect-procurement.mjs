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
const records = rows.slice(1).map(r => {
  const obj = {};
  headers.forEach((h, idx) => obj[h] = (r[idx] || '').trim());
  return obj;
});

const inTransitItems = records.filter(r => Number(r['采购在途'] || 0) > 0 || Number(r['本地仓可用'] || 0) > 0);
console.log(`Items with 采购在途 > 0 or 本地仓可用 > 0: ${inTransitItems.length}`);

inTransitItems.forEach(r => {
  console.log(`\nMSKU: ${r.MSKU}`);
  console.log(`  品名: ${r['品名']}`);
  console.log(`  采购在途: ${r['采购在途']} | 本地仓可用: ${r['本地仓可用']} | 待加工: ${r['待加工']} | 待质检: ${r['待质检']}`);
  console.log(`  FBA可售: ${r['可售']} | FBA在途: ${r['FBA在途']} | SHIPPED: ${r['SHIPPED（已寄送）']}`);
  console.log(`  本地仓发FBA日: 海运=${r['本地仓至FBA发货日 (FBA海运（默认）-35)']} | 空运=${r['本地仓至FBA发货日 (FBA空运（默认）-15)']} | 慢船=${r['本地仓至FBA发货日 (美国慢船-智善)']}`);
  console.log(`  建议采购日: ${r['建议采购日']}`);
  console.log(`  上架时间: ${r['上架时间']} | 更新时间: ${r['更新时间']}`);
  console.log(`  在库DOS: ${r['在库库存可售天数(FBA)']} | 预估断货DOS: ${r['预估断货前可售天数(FBA)']}`);
});
