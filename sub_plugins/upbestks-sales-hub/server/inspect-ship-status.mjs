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

console.log('=== Checking READY_TO_SHIP and DELIVERED ===');
records.filter(r => Number(r['READY_TO_SHIP（准备装运）']||0) > 0 || Number(r['DELIVERED（投递成功）']||0) > 0).forEach(r => {
  console.log(`MSKU: ${r.MSKU} | READY_TO_SHIP: ${r['READY_TO_SHIP（准备装运）']} | DELIVERED: ${r['DELIVERED（投递成功）']} | FBA在途: ${r['FBA在途']} | 可售: ${r['可售']}`);
});

console.log('\n=== Checking Items with 本地仓可用 > 0 and their suggested FBA ship dates ===');
records.filter(r => Number(r['本地仓可用']||0) > 0).forEach(r => {
  console.log(`MSKU: ${r.MSKU}`);
  console.log(`  本地仓可用: ${r['本地仓可用']} | 采购在途: ${r['采购在途']} | FBA可售: ${r['可售']} | FBA在途: ${r['FBA在途']}`);
  console.log(`  在库DOS: ${r['在库库存可售天数(FBA)']}天 | 预估断货DOS: ${r['预估断货前可售天数(FBA)']}天`);
  console.log(`  建议采购日: ${r['建议采购日'] || '—'}`);
  console.log(`  海运发货日: ${r['本地仓至FBA发货日 (FBA海运（默认）-35)'] || '—'}`);
  console.log(`  空运发货日: ${r['本地仓至FBA发货日 (FBA空运（默认）-15)'] || '—'}`);
  console.log(`  慢船发货日: ${r['本地仓至FBA发货日 (美国慢船-智善)'] || '—'}`);
  console.log('---');
});
