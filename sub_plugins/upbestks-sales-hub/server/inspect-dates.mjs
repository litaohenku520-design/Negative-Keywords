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

console.log('--- Inspecting all rows with shipping days or purchase dates or procurement in transit ---');
records.forEach(r => {
  const hasShipDay = r['本地仓至FBA发货日 (FBA海运（默认）-35)'] || r['本地仓至FBA发货日 (FBA空运（默认）-15)'] || r['本地仓至FBA发货日 (美国慢船-智善)'];
  const hasPurchDate = r['建议采购日'];
  const purchTransit = Number(r['采购在途'] || 0);
  const localStock = Number(r['本地仓可用'] || 0);
  const fbaTransit = Number(r['FBA在途'] || 0);
  const fbaSellable = Number(r['可售'] || 0);
  const purchSuggested = Number(r['建议采购量（汇总）'] || 0);
  const replSuggested = Number(r['建议补货量（汇总）'] || 0);

  if (hasShipDay || hasPurchDate || purchTransit > 0 || localStock > 0 || purchSuggested > 0 || replSuggested > 0) {
    console.log(`[${r.MSKU}]`);
    console.log(`  品名: ${r['品名']} | 日均销: ${r['日均销量（动态）']}`);
    console.log(`  FBA可售: ${fbaSellable} | FBA在途: ${fbaTransit} | 在库DOS: ${r['在库库存可售天数(FBA)']}天 | 预估断货DOS: ${r['预估断货前可售天数(FBA)']}天 | 断货日: ${r['断货日期（FBA）']}`);
    console.log(`  采购在途: ${purchTransit} | 采购计划: ${r['采购计划']} | 本地仓可用: ${localStock} | 待加工/质检/上架: ${Number(r['待加工']||0)+Number(r['待质检']||0)+Number(r['待上架']||0)}`);
    console.log(`  建议采购汇总: ${purchSuggested} | 建议补货汇总: ${replSuggested}`);
    console.log(`  建议采购日: ${hasPurchDate || '—'}`);
    console.log(`  海运发货日: ${r['本地仓至FBA发货日 (FBA海运（默认）-35)'] || '—'}`);
    console.log(`  空运发货日: ${r['本地仓至FBA发货日 (FBA空运（默认）-15)'] || '—'}`);
    console.log(`  慢船发货日: ${r['本地仓至FBA发货日 (美国慢船-智善)'] || '—'}`);
    console.log('---');
  }
});
