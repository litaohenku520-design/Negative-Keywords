import fs from 'node:fs';
import { computeSalesAnalytics } from './sales-engine.mjs';

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
const saihuMskus = new Set(rows.slice(1).map(r => (r[2] || '').trim()).filter(Boolean));
console.log('Saihu unique MSKUs:', saihuMskus.size);

const salesData = await computeSalesAnalytics();
const salesMskus = new Set(salesData.skus.map(s => s.msku));
console.log('Sales data unique MSKUs:', salesMskus.size);

let matched = 0;
salesMskus.forEach(m => {
  if (saihuMskus.has(m)) matched++;
});
console.log(`Matched ${matched} of ${salesMskus.size} sales MSKUs!`);
