import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ExcelJS from 'exceljs';
import { ensureExportDir, loadConfig, readSpreadsheetRows } from './file-io.mjs';

const execFileAsync = promisify(execFile);

let cachedRules = null;
let cachedRulesPath = null;

export function loadRulesConfig() {
  const cfg = loadConfig();
  const p = cfg.rulesConfigPath;
  if (cachedRules && cachedRulesPath === p) return cachedRules;
  if (!p || !fs.existsSync(p)) {
    return { deny_brands: [], model_groups: [], alias_rules: [], custom_rules: [], loaded: false, path: p };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    cachedRules = {
      ...raw,
      deny_brands: raw.deny_brands || [],
      model_groups: raw.model_groups || raw.modelGroups || [],
      alias_rules: raw.alias_rules || raw.aliasRules || [],
      custom_rules: raw.custom_rules || raw.customRules || [],
      loaded: true,
      path: p,
    };
    cachedRulesPath = p;
    return cachedRules;
  } catch (err) {
    return { deny_brands: [], model_groups: [], alias_rules: [], custom_rules: [], loaded: false, path: p, error: err.message };
  }
}

export function getRulesSummary(query = '', limit = 50) {
  const r = loadRulesConfig();
  const q = String(query || '').trim().toLowerCase();
  const groups = Array.isArray(r.model_groups) ? r.model_groups : [];
  const filtered = q
    ? groups.filter((g) => JSON.stringify(g).toLowerCase().includes(q))
    : groups;

  return {
    loaded: r.loaded,
    path: r.path,
    denyBrandCount: Array.isArray(r.deny_brands) ? r.deny_brands.length : 0,
    denyBrands: (r.deny_brands || []).slice(0, 80),
    modelGroupCount: groups.length,
    aliasRuleCount: Array.isArray(r.alias_rules) ? r.alias_rules.length : 0,
    customRuleCount: Array.isArray(r.custom_rules) ? r.custom_rules.length : 0,
    groups: filtered.slice(0, limit).map((g) => ({
      id: g.id || g.name || '',
      name: g.name || g.group_name || g.id || '',
      enabled: g.enabled !== false,
      patterns: g.patterns || g.keywords || [],
      marketplace: g.marketplace || 'ALL',
    })),
  };
}

function findCol(headers, patterns) {
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] ?? '').trim();
    if (patterns.some((p) => p.test(h))) return i;
  }
  return -1;
}

function toNum(v) {
  if (v == null || v === '') return 0;
  const s = String(v).replace(/[$,%¥€£,\s]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

const NOISE_RE = /\b(cat|dog|litter|vacuum|tablet|ipad|watch|notebook|kindle|charger|cable|headphone|earbud|keyboard|mouse|pen|power bank|plug|adapter|pillow|toy)\b/i;
const SCREEN_ONLY_RE = /^(?!.*\b(case|cover|wallet|pouch|sleeve|holder|flip|book)\b).*\b(screen protector|screen film|screen glass|tempered glass|panzerglass|displayschutz|schutzglas|schutzfolie)\b/i;
const BATTERY_CASE_RE = /\b(battery\s*(case|pack|charger)|charging\s*case|powerbank|power\s*bank)\b/i;
const ASIN_RE = /^b0[a-z0-9]{8}$/i;

function classifyTerm(rowObj, opts, denyBrandSet) {
  const term = String(rowObj.term || '').trim();
  const termLower = term.toLowerCase();
  const isAsin = ASIN_RE.test(term);
  const spend = rowObj.spend;
  const clicks = rowObj.clicks;
  const orders = rowObj.orders;
  const acos = rowObj.acos;

  const reasons = [];
  let decision = '保留';

  const words = termLower.split(/\s+/);
  const hitBrand = words.find((w) => denyBrandSet.has(w));
  if (hitBrand) {
    decision = '否掉';
    reasons.push(`竞品品牌词(${hitBrand})`);
  } else if (SCREEN_ONLY_RE.test(term)) {
    decision = '否掉';
    reasons.push('纯贴膜词(无壳类意图)');
  } else if (BATTERY_CASE_RE.test(term)) {
    decision = '否掉';
    reasons.push('充电壳/电池壳');
  } else if (NOISE_RE.test(term) && !/\b(case|cover|wallet|flip)\b/i.test(term)) {
    decision = '否掉';
    reasons.push('无关品类信号词');
  } else if (orders === 0 && spend >= opts.minSpendNoOrder) {
    decision = '否掉';
    reasons.push(`0单且花费≥$${opts.minSpendNoOrder}`);
  } else if (orders === 0 && clicks >= opts.minClicksNoOrder) {
    decision = '否掉';
    reasons.push(`0单且点击≥${opts.minClicksNoOrder}`);
  } else if (orders > 0 && acos > 60) {
    decision = '待观察';
    reasons.push(`高ACoS(${acos.toFixed(1)}%)`);
  }

  return {
    ...rowObj,
    isAsin,
    matchType: isAsin ? 'Negative Product Targeting' : opts.matchType,
    decision,
    reason: reasons.join('；') || '正常转化/达标',
  };
}

async function runPythonAuditBridge(items, erpRoot) {
  const backendDir = path.join(erpRoot, 'neg-keyword-backend');
  const engineFile = path.join(backendDir, 'neg_audit_engine.py');
  if (!fs.existsSync(engineFile)) return null;

  const pyScript = `
import sys, json
sys.path.insert(0, ${JSON.stringify(backendDir)})
try:
    import neg_audit_engine as nae
    payload = json.load(sys.stdin)
    items = payload.get("items", [])
    report = nae.run_audit(items)
    print(json.dumps({"ok": True, "summary": report.get("summary", {}), "issues": report.get("issues", [])[:100]}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
`;
  try {
    const { stdout } = await execFileAsync('python', ['-c', pyScript], {
      input: JSON.stringify({ items }),
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15000,
    });
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

export async function analyzeNegKeywords({
  filePath,
  minSpendNoOrder,
  minClicksNoOrder,
  matchType,
  runPythonAudit = true,
  exportTemplate = true,
}) {
  const cfg = loadConfig();
  const rules = loadRulesConfig();
  const denyBrandSet = new Set((rules.deny_brands || []).map((b) => String(b).trim().toLowerCase()).filter(Boolean));
  const opts = {
    minSpendNoOrder: minSpendNoOrder ?? cfg.negKeyword?.minSpendNoOrder ?? 15,
    minClicksNoOrder: minClicksNoOrder ?? cfg.negKeyword?.minClicksNoOrder ?? 12,
    matchType: matchType || cfg.negKeyword?.defaultMatchType || 'Negative Exact',
  };

  const parsed = await readSpreadsheetRows(filePath, 0);
  if (!parsed.rows || parsed.rows.length < 2) {
    throw new Error('搜索词报告为空或仅有表头');
  }
  const headers = parsed.rows[0].map((h) => String(h ?? '').trim());
  const cTerm = findCol(headers, [/customer search term/i, /客户搜索词/, /搜索词/, /^targeting$/i, /投放/]);
  const cCamp = findCol(headers, [/campaign name/i, /广告活动名称/, /广告活动/]);
  const cAdGrp = findCol(headers, [/ad group name/i, /广告组名称/, /广告组/]);
  const cSpend = findCol(headers, [/^spend$/i, /^花费$/, /总花费/]);
  const cClicks = findCol(headers, [/^clicks$/i, /^点击量$/, /点击次数/]);
  const cOrders = findCol(headers, [/orders/i, /订单数/, /总订单/]);
  const cSales = findCol(headers, [/sales/i, /销售额/]);
  const cAcos = findCol(headers, [/^acos$/i, /广告投入产出比/]);

  if (cTerm === -1) {
    throw new Error(`未识别到「客户搜索词 / Customer Search Term」列，当前表头: ${headers.slice(0, 10).join(', ')}`);
  }

  const classified = [];
  const counts = { 否掉: 0, 待观察: 0, 保留: 0, asins: 0 };
  let totalDenySpend = 0;

  for (let i = 1; i < parsed.rows.length; i++) {
    const r = parsed.rows[i];
    const term = String(r[cTerm] ?? '').trim();
    if (!term) continue;
    const spend = cSpend >= 0 ? toNum(r[cSpend]) : 0;
    const clicks = cClicks >= 0 ? toNum(r[cClicks]) : 0;
    const orders = cOrders >= 0 ? toNum(r[cOrders]) : 0;
    const sales = cSales >= 0 ? toNum(r[cSales]) : 0;
    let acos = cAcos >= 0 ? toNum(r[cAcos]) : (sales > 0 ? (spend / sales) * 100 : 0);
    if (acos > 0 && acos < 1 && sales > 0 && spend / sales < 1) acos = acos * 100;

    const item = classifyTerm({
      id: i,
      term,
      campaign: cCamp >= 0 ? String(r[cCamp] ?? '').trim() : '',
      adGroup: cAdGrp >= 0 ? String(r[cAdGrp] ?? '').trim() : '',
      spend: Math.round(spend * 100) / 100,
      clicks,
      orders,
      sales: Math.round(sales * 100) / 100,
      acos: Math.round(acos * 10) / 10,
    }, opts, denyBrandSet);

    classified.push(item);
    counts[item.decision] = (counts[item.decision] || 0) + 1;
    if (item.isAsin) counts.asins++;
    if (item.decision === '否掉') totalDenySpend += item.spend;
  }

  let pythonAudit = null;
  if (runPythonAudit && cfg.erpRoot) {
    const auditInput = classified.slice(0, 2000).map((it) => ({
      keyword: it.term,
      campaign: it.campaign,
      ad_group: it.adGroup,
      decision: it.decision === '否掉' ? 'deny' : 'keep',
      spend: it.spend,
      orders: it.orders,
    }));
    pythonAudit = await runPythonAuditBridge(auditInput, cfg.erpRoot);
  }

  let exportPath = null;
  if (exportTemplate) {
    const denyItems = classified.filter((it) => it.decision === '否掉');
    const outDir = ensureExportDir(cfg);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    exportPath = path.join(outDir, `否词批量模板_${ts}.xlsx`);
    const wb = new ExcelJS.Workbook();

    const wsNeg = wb.addWorksheet('否定词上传模板');
    wsNeg.addRow(['Product', 'Entity', 'Operation', 'Campaign Name', 'Ad Group Name', 'Keyword Text', 'Match Type', '判定原因', '花费', '点击', '订单']);
    for (const it of denyItems.filter((d) => !d.isAsin)) {
      wsNeg.addRow([
        'Sponsored Products',
        'Negative Keyword',
        'Create',
        it.campaign,
        it.adGroup,
        it.term,
        it.matchType,
        it.reason,
        it.spend,
        it.clicks,
        it.orders,
      ]);
    }
    wsNeg.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    wsNeg.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF991B1B' } };

    const wsAsin = wb.addWorksheet('否定ASIN模板');
    wsAsin.addRow(['Product', 'Entity', 'Operation', 'Campaign Name', 'Ad Group Name', 'Product Targeting Expression', '判定原因', '花费', '点击', '订单']);
    for (const it of denyItems.filter((d) => d.isAsin)) {
      wsAsin.addRow([
        'Sponsored Products',
        'Negative Product Targeting',
        'Create',
        it.campaign,
        it.adGroup,
        `asin="${it.term.toUpperCase()}"`,
        it.reason,
        it.spend,
        it.clicks,
        it.orders,
      ]);
    }
    wsAsin.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    wsAsin.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7C2D12' } };

    await wb.xlsx.writeFile(exportPath);
  }

  classified.sort((a, b) => {
    const order = { 否掉: 0, 待观察: 1, 保留: 2 };
    if (order[a.decision] !== order[b.decision]) return order[a.decision] - order[b.decision];
    return b.spend - a.spend;
  });

  return {
    fileName: path.basename(filePath),
    totalTerms: classified.length,
    counts,
    totalDenySpend: Math.round(totalDenySpend * 100) / 100,
    rulesInfo: getRulesSummary(),
    pythonAudit,
    exportPath,
    previewRows: classified.slice(0, 200),
  };
}
