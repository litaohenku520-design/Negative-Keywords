import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const STORE_ID = process.env.DISCOVER_STORE_ID || 'default';
export const DATA_DIR = process.env.DISCOVER_STORE_DATA_DIR || path.resolve(__dirname, '..', 'data');
export const CONFIG_PATH = path.join(DATA_DIR, 'workbench-config.json');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const ROAS_CONFIG_DIR = path.join(DATA_DIR, 'roas', 'stores');

export function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const config = JSON.parse(raw);
    return { ...config, roasConfigPath: ROAS_CONFIG_DIR };
  } catch {
    const isUp = STORE_ID === 'UPBestKS';
    return {
      erpRoot: isUp ? 'C:\\Users\\admin\\DeskBox\\aGENT\\AMZ 探险者1' : '',
      scanDirs: isUp ? [
        'd:\\反重力\\UPBestKS\\广告数据',
        'd:\\反重力\\UPBestKS\\销售与库存',
        'C:\\Users\\admin\\DeskBox\\aGENT\\AMZ 探险者1\\data',
      ] : [DATA_DIR],
      exportDir: path.join(DATA_DIR, 'exports'),
      rulesConfigPath: 'C:\\Users\\admin\\DeskBox\\aGENT\\AMZ 探险者1\\neg-keyword-backend\\rules_config.json',
      roasConfigPath: ROAS_CONFIG_DIR,
      negKeyword: { defaultMarketplace: 'US', defaultMatchType: 'Negative Exact', minSpendNoOrder: 15, minClicksNoOrder: 12 },
      roasMerge: { defaultPreset: 'custom_cfg_4_6_7', keyCols: [4, 6, 7], requiredCols: [true, true, true], autoJudge: true },
      inventorySales: { stockoutWarnDays: 21, overstockWarnDays: 120, abcThresholds: [0.7, 0.9] },
    };
  }
}

export function saveConfig(patch) {
  const current = loadConfig();
  const next = {
    ...current,
    ...patch,
    negKeyword: { ...current.negKeyword, ...(patch.negKeyword || {}) },
    roasMerge: { ...current.roasMerge, ...(patch.roasMerge || {}) },
    inventorySales: { ...current.inventorySales, ...(patch.inventorySales || {}) },
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function ensureExportDir(cfg = loadConfig()) {
  const dir = cfg.exportDir || path.join(DATA_DIR, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveUploadedFile(fileName, base64Content) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const safeName = path.basename(fileName).replace(/[<>:"/\\|?*]/g, '_');
  const outPath = path.join(UPLOADS_DIR, `${Date.now()}_${safeName}`);
  const cleanB64 = String(base64Content || '').replace(/^data:[^;]+;base64,/, '');
  fs.writeFileSync(outPath, Buffer.from(cleanB64, 'base64'));
  return outPath;
}

export function detectReportCategory(fileName) {
  const n = fileName.toLowerCase();
  if (/搜索词|search.?term/i.test(n)) return 'search_term';
  if (/roas|合并|投放|targeting|campaign|自动|精确|品牌|sponsored/i.test(n)) return 'roas_report';
  if (/赛狐|补货|销量|库存|inventory|fba|sales|销售/i.test(n)) return 'inventory_sales';
  return 'other';
}

export function scanReportFiles(extraDirs = []) {
  const cfg = loadConfig();
  const dirs = [...new Set([...(cfg.scanDirs || []), UPLOADS_DIR, ...extraDirs].filter(Boolean))];
  const files = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        const ext = path.extname(ent.name).toLowerCase();
        if (!['.xlsx', '.csv', '.xlsm'].includes(ext)) continue;
        if (ent.name.startsWith('~$')) continue;
        const fullPath = path.join(dir, ent.name);
        const stat = fs.statSync(fullPath);
        files.push({
          name: ent.name,
          path: fullPath,
          dir,
          ext,
          sizeKB: Math.round((stat.size / 1024) * 10) / 10,
          modifiedAt: stat.mtime.toISOString(),
          category: detectReportCategory(ent.name),
        });
      }
    } catch {
      // Ignore unreadable directory
    }
  }
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return { dirs, files };
}

function parseCsvText(text) {
  const clean = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field.trim());
      field = '';
    } else if (ch === '\r') {
      if (clean[i + 1] === '\n') i++;
      row.push(field.trim());
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\n') {
      row.push(field.trim());
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field.trim());
    if (row.some((v) => v !== '')) rows.push(row);
  }
  return rows;
}

function normalizeCellValue(val) {
  if (val == null) return '';
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  if (typeof val === 'object') {
    if (val.result !== undefined) return normalizeCellValue(val.result);
    if (Array.isArray(val.richText)) return val.richText.map((r) => r.text).join('');
    if (val.text !== undefined) return String(val.text);
  }
  return val;
}

export async function readSpreadsheetRows(filePath, sheetSelector = 0) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv') {
    const raw = fs.readFileSync(filePath, 'utf8');
    const rows = parseCsvText(raw);
    return { sheetNames: ['CSV'], sheetName: 'CSV', rows };
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheetNames = wb.worksheets.map((ws) => ws.name);
  let ws = null;
  if (typeof sheetSelector === 'number') {
    ws = wb.worksheets[sheetSelector] || wb.worksheets[0];
  } else {
    ws = wb.getWorksheet(sheetSelector) || wb.worksheets[0];
  }
  if (!ws) throw new Error(`工作表为空: ${filePath}`);
  const rows = [];
  const colCount = ws.columnCount || 0;
  ws.eachRow({ includeEmpty: false }, (row) => {
    const arr = [];
    for (let c = 1; c <= colCount; c++) {
      arr.push(normalizeCellValue(row.getCell(c).value));
    }
    if (arr.some((v) => v !== '' && v != null)) {
      rows.push(arr);
    }
  });
  return { sheetNames, sheetName: ws.name, rows };
}

export async function readAllSheets(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv') {
    const parsed = await readSpreadsheetRows(filePath, 0);
    return { CSV: parsed.rows };
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const out = {};
  for (const ws of wb.worksheets) {
    const rows = [];
    const colCount = ws.columnCount || 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      const arr = [];
      for (let c = 1; c <= colCount; c++) {
        arr.push(normalizeCellValue(row.getCell(c).value));
      }
      if (arr.some((v) => v !== '' && v != null)) rows.push(arr);
    });
    out[ws.name] = rows;
  }
  return out;
}

export async function previewFileHeaders(filePath, sheetSelector = 0) {
  const parsed = await readSpreadsheetRows(filePath, sheetSelector);
  const headers = (parsed.rows[0] || []).map((h, i) => ({
    index: i,
    name: String(h ?? '').trim() || `Col_${i + 1}`,
  }));
  return {
    fileName: path.basename(filePath),
    sheetNames: parsed.sheetNames,
    sheetName: parsed.sheetName,
    rowCount: Math.max(0, parsed.rows.length - 1),
    headers,
    sampleRows: parsed.rows.slice(1, 4),
  };
}
