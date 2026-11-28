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

// Check non-empty column statistics
console.log('--- Non-empty count for all 115 columns ---');
headers.forEach((h, i) => {
  const nonEmpties = records.filter(r => r[h] !== '' && r[h] !== '0' && r[h] !== '0.0' && r[h] !== '0%');
  if (nonEmpties.length > 0) {
    console.log(`${i}. [${h}]: ${nonEmpties.length} rows (sample: "${nonEmpties[0][h].slice(0, 40)}")`);
  }
});
