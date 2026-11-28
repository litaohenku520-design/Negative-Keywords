import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_URI = 'ui://upbestks-weekly-planner/app.html';
const APP_HTML_PATH = path.join(__dirname, 'dist', 'app.html');
const DATA_PATH = path.join(__dirname, 'data', 'upbestks_data.json');
const PLACEMENT_PATH = path.join(__dirname, 'data', 'placement_data.json');
const CHECKLIST_PATH = path.join(__dirname, 'data', 'checklist_state.json');
const OPT_LOG_PATH = path.join(__dirname, 'data', 'optimization_log.json');
const EXCEL_SCRIPT_PATH = 'C:/Users/admin/.gemini/antigravity/brain/3b996f25-d369-404f-8d61-f5b6ab81d5d5/scratch/build_upbestks_weekly_excel.js';

const fnum = (v) => {
  if (v === null || v === undefined || v === '' || v === '-' || v === '--') return 0;
  const n = Number(String(v).replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const round2 = (x) => Math.round(x * 100) / 100;

const V4_ADJUSTED = new Set([
  'UP-Auto-S26-Deep Purple', 'UP-Auto-S26-Light Brown', 'UP-Auto-Moto/G/2026-Deep Purple',
  'UP-Auto-IP17Pro-Wine Red', 'UP-Auto-Moto/G/2026-Blue/Blue Green', 'UP-Auto-S26-Blue',
  'UP-Auto-IP17Pro-Light Brown', 'UP-Auto-S26Ultra-Light Brwon', 'UP-Auto-IP16-Deep Purple',
  'UP-Auto-S25-Blue', 'UP-Auto-IP17ProMax-Deep Purple1', 'UP-Auto-S25-Deep Purple',
  'UP-Auto-IP17ProMax-Deep Purple-bid0.62-Tos10',
]);

const PRESCRIPTIONS = {
  'UP-Auto-S24Ultra-Blue': { prio: 'P0-温和卡点', act: 'closeMatch $0.77→$0.71(-7.8%) + TOS 0%→+8%(保首页$1.53，ROS温和压至$1.07)；sub/comp→$0.33', newBid: '$0.71', newMod: '8%/0%/0%' },
  'UP-Auto-A17-Blue': { prio: 'P0-温和卡点', act: '先撤ROS 5%→0%(暂留TOS 5%) + closeMatch $0.77→$0.72(-6.5%)；ERP切75折；sub/comp→$0.33', newBid: '$0.72', newMod: '5%/0%/0%' },
  'UP-Auto-Moto/Stylus/2026-Deep Purple': { prio: 'P0-温和卡点', act: 'closeMatch $0.75→$0.70(-6.7%) + ROS 0%→+7%(保ROS 45.1%主力位$1.12，TOS压至$1.40)；sub/comp→$0.33', newBid: '$0.70', newMod: '0%/7%/0%' },
  'UP-Auto-Moto/G/2026-Light Brown': { prio: 'P0-温和卡点', act: 'closeMatch $0.77→$0.71(-7.8%) + 撤PP 5%→0% + TOS 5%→+12%(+7pp保首页$1.59，压PP/ROS至$1.07)；sub/comp→$0.33', newBid: '$0.71', newMod: '12%/0%/0%' },
  'UP-Attack-IP18ProMax': { prio: 'P0-风控纠偏', act: '取消v5.1加首页；TOS 40%先温和回调至32%(-8pp)或降手动Bid -6%~-8%+否定PP词', newBid: '手动-6%~-8%', newMod: '32%/0%/0%' },
  'UP-Auto-A17-Wine Red': { prio: 'P0-风控纠偏', act: '暂缓v5.1加ROS 5%→10%(7d ROS 14c 0单)；保持$0.77/ROS 5%观望Coupon，满20c无单再撤5%→0%', newBid: '维持$0.77', newMod: '0%/5%/0%' },
  'UP-Auto-S26Ultra-Blue1': { prio: 'P1-温和卡点', act: 'closeMatch $0.75→$0.70(-6.7%) + ROS 0%→+7%(保ROS 49.8%核心位$1.12，TOS至$1.40/PP至$1.05)', newBid: '$0.70', newMod: '0%/7%/0%' },
  'UP-Auto-A17-Deep Purple3': { prio: 'P1-温和控PP', act: 'closeMatch $0.77→$0.73(-5.2%) + TOS 0%→+5% + ROS 5%→+10%(保搜索位，温和压18c 0单PP至$1.10)', newBid: '$0.73', newMod: '5%/10%/0%' },
  'UP-Auto-IP17-Light Brown': { prio: 'P1-温和卡点', act: 'closeMatch $0.75→$0.71(-5.3%) + TOS 0%→+6%(保首页$1.51，温和压ROS/PP至$1.07)', newBid: '$0.71', newMod: '6%/0%/0%' },
  'UP-Auto-Moto/Stylus/2026-Light Brown': { prio: '明星位置扩量', act: '保持Bid $0.75，TOS 0%→+5%(7d TOS 20.9%/3单)，小步试探放量；sub/comp→$0.33', newBid: '$0.75', newMod: '5%/0%/0%' },
  'UP-Auto-S24Ultra-Light Brown1': { prio: '明星位置扩量', act: '保持Bid $0.75，TOS 0%→+5% & PP 0%→+5%(TOS 26.1%/PP 16.1%，紧盯ROS 18c 0单)', newBid: '$0.75', newMod: '5%/0%/5%' },
  'UP-Auto-Pixel11-Deep Purple': { prio: '明星位置扩量', act: '保持Bid $0.75，TOS 0%→+5%(7d TOS 14.5%/ROS 25.0%)', newBid: '$0.75', newMod: '5%/0%/0%' },
  'UP-Auto-IP17e-Wine Red': { prio: 'P1-轻控观察', act: '7d 72.1%(表3 56.7%)全集中ROS，11/26 Coupon后观察，sub/comp→$0.33', newBid: '$0.75', newMod: '0%/0%/0%' },
};

const DEFAULT_CHECKLIST = [
  { id: 'w1', day: '11/25 今晚', prio: 'P0', title: '4 大出血组执行「小步 -5%~-8% 降Bid + 反向保位溢价」', detail: 'S24U-Blue($0.71+TOS8%), A17-Blue(撤ROS5%+$0.72), Stylus-DP($0.70+ROS7%), Moto/G-LB($0.71+撤PP5%+TOS12%)', done: false },
  { id: 'w2', day: '11/25 今晚', prio: 'P0', title: 'S26U-Blue1 / A17-DP3 / IP17-LB 小步位置卡点(-5%~-6.7%)', detail: 'S26U-Blue1($0.70+ROS7%), A17-DP3($0.73+TOS5%/ROS10%), IP17-LB($0.71+TOS6%)', done: false },
  { id: 'w3', day: '11/25 今晚', prio: 'P0', title: 'sub/comp 两步温和压至 $0.33 & 排查 $0.00 异常组', detail: '不一步腰斩防断权重，先由$0.40-$0.45温和压至$0.33；排查IP17PM-DP-bid0.62与IP17e-Blue1', done: false },
  { id: 'w4', day: '11/26 周四', prio: 'P0', title: '$2 Coupon 上线后切 ERP 分时模板 + 明星位+5%试探', detail: '第1-3档 80折→90折，第4-6档 75折→85折；Stylus-LB / S24U-LB1 / Pixel11-DP 加TOS+5%', done: false },
  { id: 'w5', day: '11/26 周四', prio: 'P0', title: '【风控】IP18ProMax 温和减压 & A17-Wine Red 观望', detail: 'IP18ProMax 先降手动Bid-6%~-8%(或TOS40→32%)并洗PP词；A17-Wine Red 暂缓加ROS并等Coupon', done: false },
  { id: 'w6', day: '11/27-28', prio: 'P1', title: '黑五爆发期：1-3 档切回 100% 常规日', detail: '盯紧 IP17Pro / Moto-G / S24Ultra-Light Brown1 / Pixle11 预算', done: false },
  { id: 'w7', day: '11/29 周日', prio: 'P0', title: 'v4 12活动 & 今晚第一轮小步组 4-5天位置复盘', detail: '导出最新位置报告，达标保持、仍偏高者再走第二轮 -5%~-7% 微调', done: false },
  { id: 'w8', day: '11/30-12/01', prio: 'P1', title: '网一余温收敛：切 85/80折 + 洗否定搜索词', detail: '导出黑五周搜索词报告，否定 18 pro max 跨代词与高耗 0 单词', done: false },
];

const readJson = (p, fallback) => {
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback; } catch { return fallback; }
};
const writeJson = (p, data) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
};

function syncExcelAsync() {
  return new Promise((resolve) => {
    if (!fs.existsSync(EXCEL_SCRIPT_PATH)) return resolve({ ok: false, msg: 'Excel script missing' });
    execFile('node', [EXCEL_SCRIPT_PATH], { timeout: 15000 }, (err, stdout) => {
      resolve({ ok: !err, msg: err ? err.message : stdout.trim() });
    });
  });
}

function agg(rows) {
  let imp = 0, clk = 0, spend = 0, ord = 0, sales = 0, selfOrd = 0, othOrd = 0;
  for (const r of rows) {
    imp += fnum(r['广告曝光量']);
    clk += fnum(r['广告点击量']);
    spend += fnum(r['广告花费']);
    ord += fnum(r['广告订单量']);
    sales += fnum(r['广告销售额']);
    selfOrd += fnum(r['本广告产品订单量']);
    othOrd += fnum(r['其他产品广告订单量']);
  }
  return {
    imp, clk, spend: round2(spend), ord, sales: round2(sales), selfOrd, othOrd,
    ctr: imp ? clk / imp : 0,
    cpc: clk ? spend / clk : 0,
    cvr: clk ? ord / clk : 0,
    acos: sales ? spend / sales : (spend > 0 ? 9.99 : 0),
    roas: spend ? sales / spend : 0,
    aov: ord ? sales / ord : 0,
    othPct: ord ? othOrd / ord : 0,
  };
}

function buildState(initialTab = 'overview') {
  const raw = readJson(DATA_PATH, { d7: [], d14: [], auto_up: [] });
  const plRaw = readJson(PLACEMENT_PATH, { p14: [], p7: [] });
  const d7 = raw.d7 || [];
  const d14 = raw.d14 || [];
  const p7 = plRaw.p7 || [];
  const p14 = plRaw.p14 || [];
  const autoUp = (raw.auto_up || []).filter(r => r['开关'] === 'enabled' && r['投放状态'] === 'Delivering');

  // Placement summaries (14d / W1 / W2 / 7d Summary)
  const pW1 = p14.filter(r => r['日期'] <= '2026-11-17');
  const pW2 = p14.filter(r => r['日期'] >= '2026-11-18');
  const plNames = ['搜索结果顶部（首页）', '搜索结果其余位置', '商品详情页', 'Off Amazon'];
  const aggByPl = (rows) => {
    const tot = agg(rows);
    const items = plNames.map(pl => {
      const sub = rows.filter(r => r['广告位'] === pl);
      const a = agg(sub);
      return { pl, short: pl === '搜索结果顶部（首页）' ? 'TOS首页' : pl === '搜索结果其余位置' ? 'ROS其余' : pl === '商品详情页' ? 'PP详情' : 'OffAmz', ...a, spendShare: tot.spend ? a.spend / tot.spend : 0 };
    }).filter(x => x.spend > 0 || x.imp > 0);
    return { tot, items };
  };
  const placementSummary = {
    d14: aggByPl(p14),
    w1: aggByPl(pW1),
    w2: aggByPl(pW2),
    d7: aggByPl(p7),
  };

  const p7ByCamp = {}, p14ByCamp = {};
  for (const r of p7) {
    const c = r['所属广告活动'];
    (p7ByCamp[c] = p7ByCamp[c] || {})[r['广告位']] = [...((p7ByCamp[c] || {})[r['广告位']] || []), r];
  }
  for (const r of p14) {
    const c = r['所属广告活动'];
    (p14ByCamp[c] = p14ByCamp[c] || {})[r['广告位']] = [...((p14ByCamp[c] || {})[r['广告位']] || []), r];
  }

  const pre7 = d14.filter(r => r['日期'] <= '2026-11-17');
  const day24 = d14.filter(r => r['日期'] === '2026-11-24');

  const byDate = {};
  for (const r of d14) (byDate[r['日期']] = byDate[r['日期']] || []).push(r);
  const daily = Object.keys(byDate).sort().map(dt => ({ date: dt, ...agg(byDate[dt]) }));

  const pf7 = {}, pf14 = {};
  for (const r of d7) { const k = r['广告组合'] || '-'; (pf7[k] = pf7[k] || []).push(r); }
  for (const r of d14) { const k = r['广告组合'] || '-'; (pf14[k] = pf14[k] || []).push(r); }
  const portfolios = [...new Set([...Object.keys(pf7), ...Object.keys(pf14)])]
    .map(name => {
      const a14 = agg(pf14[name] || []);
      const a7 = agg(pf7[name] || []);
      const diffPp = (a7.acos - a14.acos) * 100;
      const status = a7.spend === 0 ? '零花费' : (a7.acos <= 0.452 ? '明星盈利' : (diffPp > 10 ? '严重恶化' : (diffPp < -5 ? '明显改善' : '偏高观察')));
      return { name, a14, a7, diffPp: round2(diffPp), status };
    })
    .sort((a, b) => b.a7.spend - a.a7.spend);

  // All 38 campaigns
  const c7 = {}, c14 = {}, latestMeta = {}, cmByCamp = {};
  for (const r of d7) (c7[r['广告活动']] = c7[r['广告活动']] || []).push(r);
  for (const r of d14) {
    (c14[r['广告活动']] = c14[r['广告活动']] || []).push(r);
    if (!latestMeta[r['广告活动']] || r['日期'] >= latestMeta[r['广告活动']]['日期']) latestMeta[r['广告活动']] = r;
  }
  for (const r of autoUp) {
    if (r['自动定向'] === 'closeMatch') cmByCamp[r['广告活动名称']] = r;
  }

  const campaigns = [...new Set([...Object.keys(c7), ...Object.keys(c14)])].map(name => {
    const a14 = agg(c14[name] || []);
    const a7 = agg(c7[name] || []);
    const m = latestMeta[name] || {};
    const tos = Math.round(fnum(m['搜索结果顶部（首页）广告位']) * 100);
    const ros = Math.round(fnum(m['搜索结果其余位置广告位']) * 100);
    const pp = Math.round(fnum(m['商品详情页广告位']) * 100);
    const cm = cmByCamp[name];
    const bid = cm ? fnum(cm['出价']) : 0;
    const live = cm ? fnum(cm['当前出价']) : 0;
    const isV4 = V4_ADJUSTED.has(name);
    let prio = isV4 ? 'v4观察' : (a7.acos <= 0.452 && a7.ord >= 3 ? '明星盈利' : '常规维持');
    let act = isV4 ? '锁定观察至11/29，不降closeMatch；sub/comp压$0.22' : '保持closeMatch观察；sub/comp压$0.22';
    let newBid = isV4 ? '观察锁定' : '维持';
    let newMod = `${tos}%/${ros}%/${pp}%`;
    if (PRESCRIPTIONS[name]) {
      prio = PRESCRIPTIONS[name].prio;
      act = PRESCRIPTIONS[name].act;
      newBid = PRESCRIPTIONS[name].newBid || '维持';
      newMod = PRESCRIPTIONS[name].newMod || newMod;
    }
    const campP7 = p7ByCamp[name] || {};
    const campP14 = p14ByCamp[name] || {};
    const plMetrics = {
      tos7: agg(campP7['搜索结果顶部（首页）'] || []),
      ros7: agg(campP7['搜索结果其余位置'] || []),
      pp7: agg(campP7['商品详情页'] || []),
      tos14: agg(campP14['搜索结果顶部（首页）'] || []),
      ros14: agg(campP14['搜索结果其余位置'] || []),
      pp14: agg(campP14['商品详情页'] || []),
    };
    return {
      name, portfolio: m['广告组合'] || '-', tos, ros, pp,
      a14, a7, bid, live, ratio: bid > 0 ? live / bid : 0,
      isV4, prio, act, newBid, newMod, pl: plMetrics,
    };
  }).sort((a, b) => b.a7.spend - a.a7.spend);

  const typesOrder = ['closeMatch', 'looseMatch', 'substitutes', 'complements'];
  const autoTypes = typesOrder.map(t => {
    const rows = autoUp.filter(r => r['自动定向'] === t);
    const bids = rows.map(r => fnum(r['出价'])).filter(x => x > 0);
    const liveBids = rows.map(r => fnum(r['当前出价'])).filter(x => x > 0);
    const ratios = rows.map(r => fnum(r['出价']) > 0 && fnum(r['当前出价']) > 0 ? fnum(r['当前出价']) / fnum(r['出价']) : 0).filter(x => x > 0);
    const spend = round2(rows.reduce((s, r) => s + fnum(r['花费']), 0));
    const clk = rows.reduce((s, r) => s + fnum(r['点击量']), 0);
    const ord = rows.reduce((s, r) => s + fnum(r['订单数']), 0);
    const sales = round2(rows.reduce((s, r) => s + fnum(r['销售额']), 0));
    return {
      type: t, count: rows.length,
      avgBid: bids.length ? round2(bids.reduce((a, b) => a + b, 0) / bids.length) : 0,
      avgLive: liveBids.length ? round2(liveBids.reduce((a, b) => a + b, 0) / liveBids.length) : 0,
      avgRatio: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0,
      clk, spend, ord, sales,
      cpc: clk ? spend / clk : 0,
      cvr: clk ? ord / clk : 0,
      acos: sales ? spend / sales : (spend > 0 ? 9.99 : 0),
    };
  });

  // All 148 Delivering auto-targeting rows
  const autoRows = autoUp.map(r => {
    const bid = fnum(r['出价']);
    const live = fnum(r['当前出价']);
    const spend = fnum(r['花费']);
    const clk = fnum(r['点击量']);
    const ord = fnum(r['订单数']);
    const sales = fnum(r['销售额']);
    const acos = sales ? spend / sales : (spend > 0 ? 9.99 : 0);
    return {
      type: r['自动定向'], campaign: r['广告活动名称'], portfolio: r['广告组合'] || '-',
      bid, live, ratio: bid > 0 ? live / bid : 0,
      clk, spend, ord, sales, acos, v4Locked: V4_ADJUSTED.has(r['广告活动名称']),
    };
  }).sort((a, b) => b.spend - a.spend || typesOrder.indexOf(a.type) - typesOrder.indexOf(b.type));

  return {
    refreshedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    initialTab,
    summary: { d14: agg(d14), pre7: agg(pre7), d7: agg(d7), day24: agg(day24) },
    placementSummary,
    daily,
    portfolios,
    campaigns,
    autoTypes,
    autoRows,
    checklist: readJson(CHECKLIST_PATH, DEFAULT_CHECKLIST),
    optLog: readJson(OPT_LOG_PATH, []),
  };
}

const server = new Server(
  { name: 'upbestks-weekly-planner', version: '1.1.0' },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'open_plan',
      title: '打开 UPBestKS 广告优化',
      description: '在侧边栏打开 UPBestKS 广告优化全功能面板（含全量 7d/14d 数据、38 个活动明细、4 种自动定向与 ERP 出价、具体优化策略及调价复盘台账）。',
      inputSchema: {
        type: 'object',
        properties: {
          tab: { type: 'string', enum: ['overview', 'placements', 'portfolios', 'campaigns', 'auto', 'strategy', 'review'] },
        },
      },
      _meta: {
        ui: { resourceUri: APP_URI },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'UPBestKS 广告优化' },
            { type: 'global', title: 'UPBestKS 广告优化' },
          ],
        },
      },
    },
    {
      name: 'get_state',
      title: 'Refresh UPBestKS Weekly State',
      description: 'Refresh all 7d/14d metrics, 38 campaigns, 148 auto-targets, strategy checklist, and review ledger.',
      inputSchema: { type: 'object', properties: {} },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
    {
      name: 'toggle_item',
      title: 'Toggle Weekly Checklist Item',
      description: 'Toggle completion state of a weekly optimization task in the sidebar plugin.',
      inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
    {
      name: 'save_opt',
      title: 'Save Optimization & Review Record',
      description: 'Add or update an optimization action or review outcome in the ledger and automatically regenerate the Excel report.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          opDate: { type: 'string' },
          status: { type: 'string' },
          category: { type: 'string' },
          campaign: { type: 'string' },
          target: { type: 'string' },
          action: { type: 'string' },
          reason: { type: 'string' },
          reviewDate: { type: 'string' },
          postNote: { type: 'string' },
          syncExcel: { type: 'boolean' },
        },
      },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
  ],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: APP_URI,
      name: 'UPBestKS 广告优化 UI',
      description: 'Comprehensive sidebar UI plugin for UPBestKS Weekly Optimization & Review',
      mimeType: 'text/html;profile=mcp-app',
      _meta: { ui: { prefersBorder: false } },
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri !== APP_URI) throw new Error(`Unknown resource URI: ${req.params.uri}`);
  return {
    contents: [{ uri: APP_URI, mimeType: 'text/html;profile=mcp-app', text: fs.readFileSync(APP_HTML_PATH, 'utf8'), _meta: { ui: { prefersBorder: false } } }],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (name === 'open_plan' || name === 'get_state') {
    const state = buildState(args.tab || 'overview');
    const s7 = state.summary.d7, s14 = state.summary.d14;
    const text = `UPBestKS 广告优化已加载 (${state.refreshedAt})：14天 ACoS ${(s14.acos * 100).toFixed(1)}% ($${s14.spend}) | 7天 ACoS ${(s7.acos * 100).toFixed(1)}% ($${s7.spend}) | 38个活动 & 148条定向 & ${state.optLog.length}条调价复盘台账已就绪。`;
    return { content: [{ type: 'text', text }], structuredContent: state };
  }
  if (name === 'toggle_item') {
    const items = readJson(CHECKLIST_PATH, DEFAULT_CHECKLIST);
    const target = items.find(x => x.id === args.id);
    if (target) target.done = !target.done;
    writeJson(CHECKLIST_PATH, items);
    const state = buildState('strategy');
    return { content: [{ type: 'text', text: `已更新周清单状态：${target ? target.title : args.id}` }], structuredContent: state };
  }
  if (name === 'save_opt') {
    const log = readJson(OPT_LOG_PATH, []);
    const raw = readJson(DATA_PATH, { d7: [], d14: [] });
    if (args.id && log.some(x => x.id === args.id)) {
      const idx = log.findIndex(x => x.id === args.id);
      log[idx] = { ...log[idx], ...args };
    } else if (args.campaign && args.action) {
      const campRows7 = (raw.d7 || []).filter(r => r['广告活动'] === args.campaign);
      const a7 = agg(campRows7);
      log.unshift({
        id: args.id || `opt_${Date.now().toString().slice(-6)}`,
        opDate: args.opDate || new Date().toISOString().slice(0, 10),
        status: args.status || '已执行待复盘',
        category: args.category || 'P0-手动记录',
        campaign: args.campaign,
        target: args.target || 'closeMatch',
        action: args.action,
        reason: args.reason || '人工/周计划调价',
        reviewDate: args.reviewDate || '2026-11-30',
        base7d: { spend: a7.spend, orders: a7.ord, acos: round2(a7.acos * 100) },
        postNote: args.postNote || '',
      });
    }
    writeJson(OPT_LOG_PATH, log);
    let xlRes = { ok: true, msg: '' };
    if (args.syncExcel !== false) xlRes = await syncExcelAsync();
    const state = buildState('review');
    state.excelSyncMsg = xlRes.ok ? '已同步写入 Excel 台账' : `Excel 同步提示: ${xlRes.msg}`;
    return { content: [{ type: 'text', text: `已保存优化记录并更新复盘台账 (${state.excelSyncMsg})` }], structuredContent: state };
  }
  throw new Error(`Unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
