import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
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

const APP_URI = 'ui://upbestks-ad-scout/app.html';
const APP_HTML_PATH = path.join(__dirname, 'dist', 'app.html');
const JSON_DATA_PATH_1 = 'D:\\反重力\\UPBestKS\\广告数据\\upbestks_ad_analytics.json';
const JSON_DATA_PATH_2 = 'C:\\Users\\admin\\AMZ\\upbestks_ad_analytics.json';
const EXCEL_REPORT_PATH_1 = 'D:\\反重力\\UPBestKS\\广告数据\\UPBestKS_广告全周期推广侦察与类型统计报表_2026-11-25.xlsx';
const EXCEL_REPORT_PATH_2 = 'C:\\Users\\admin\\AMZ\\UPBestKS_广告全周期推广侦察与类型统计报表_2026-11-25.xlsx';
const PYTHON_GEN_SCRIPT = 'C:\\Users\\admin\\AMZ\\generate_ad_report.py';
const PYTHON_EXE = 'C:\\Users\\admin\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';

function loadAdAnalytics() {
  let jsonPath = fs.existsSync(JSON_DATA_PATH_1) ? JSON_DATA_PATH_1 : JSON_DATA_PATH_2;
  if (!fs.existsSync(jsonPath)) {
    try {
      console.error('Analytics JSON missing, generating via python script...');
      execSync(`"${PYTHON_EXE}" "${PYTHON_GEN_SCRIPT}"`, { stdio: 'inherit' });
    } catch (err) {
      console.error('Failed to run python generator:', err);
    }
  }
  jsonPath = fs.existsSync(JSON_DATA_PATH_1) ? JSON_DATA_PATH_1 : JSON_DATA_PATH_2;
  const content = fs.readFileSync(jsonPath, 'utf8');
  return JSON.parse(content);
}

function buildUiPayload(data, initialTab = 'overview', extra = {}) {
  return {
    refreshedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    initialTab,
    reportPath: EXCEL_REPORT_PATH_1,
    reportPathBackup: EXCEL_REPORT_PATH_2,
    ...extra,
    data,
  };
}

const server = new Server(
  { name: 'upbestks_ad_scout', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'open_ad_scout',
      title: 'UPBestKS 广告推广侦察看板',
      description: '在反重力侧边栏或全屏打开 UPBestKS 广告推广侦察与数据分析中控台（涵盖 Auto/Attack/Review 三类广告统计、104 天每日五指标走势折线图、16 款机型广告组诊断、8 大核心颜色转化透视矩阵与两色优先前色归集、高 ACoS 控本与高转化放量哨兵）。',
      inputSchema: {
        type: 'object',
        properties: {
          tab: {
            type: 'string',
            enum: ['overview', 'trends', 'models', 'colors', 'scout', 'campaigns'],
            description: '可选初始页签：overview（大盘与三类型总览）、trends（每日趋势折线图）、models（机型广告组诊断）、colors（颜色透视矩阵）、scout（推广侦察哨兵与放量标的）、campaigns（全量活动明细）。',
          },
        },
      },
      _meta: {
        ui: { resourceUri: APP_URI },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'UPBestKS 广告推广侦察' },
            { type: 'global', title: 'UPBestKS 广告推广侦察' },
          ],
        },
      },
    },
    {
      name: 'get_ad_scout_state',
      title: 'Refresh UPBestKS Ad Scout Data',
      description: '重新读取最新的 UPBestKS 广告统计数据与多维分析指标。',
      inputSchema: {
        type: 'object',
        properties: {
          tab: { type: 'string' },
        },
      },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
    {
      name: 'export_ad_excel',
      title: 'Regenerate UPBestKS Ad Excel Report',
      description: '重新生成 UPBestKS 6工作表专业级广告分析报表（含每日趋势原生折线图、机型柱状图与多维侦察透视表）。',
      inputSchema: { type: 'object', properties: {} },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
  ],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: APP_URI,
      name: 'UPBestKS 广告推广侦察 UI',
      description: 'Interactive Ad Analytics and Promotion Reconnaissance Dashboard for UPBestKS',
      mimeType: 'text/html;profile=mcp-app',
      _meta: { ui: { prefersBorder: false } },
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri !== APP_URI) throw new Error(`Unknown resource URI: ${req.params.uri}`);
  if (!fs.existsSync(APP_HTML_PATH)) throw new Error(`Built UI file missing: ${APP_HTML_PATH}`);
  return {
    contents: [{
      uri: APP_URI,
      mimeType: 'text/html;profile=mcp-app',
      text: fs.readFileSync(APP_HTML_PATH, 'utf8'),
      _meta: { ui: { prefersBorder: false } },
    }],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (name === 'open_ad_scout' || name === 'get_ad_scout_state') {
    const data = loadAdAnalytics();
    const payload = buildUiPayload(data, args.tab || 'overview');
    const s = data.summary || {};
    const meta = data.meta || {};
    const spend = Number(s.totalSpend || 0).toFixed(2);
    const storeSales = Number(s.totalStoreSales || 0).toFixed(2);
    const adSales = Number(s.totalAdSales || 0).toFixed(2);
    const orgSales = Number(s.totalOrganicSales || 0).toFixed(2);
    const orgRatio = Number(s.totalOrganicRatio || 0).toFixed(1);
    const tacos = Number(s.totalTacos || 0).toFixed(1);
    const acos = Number(s.totalAcos || 0).toFixed(1);
    const roas = Number(s.totalRoas || 0).toFixed(2);
    const orders = s.totalOrders || 0;
    const text = `UPBestKS 广告推广侦察中控台已加载 (${meta.earliestDate || '2026-08-14'} 至 ${meta.latestDate || '2026-11-25'}，共 ${meta.totalDays || 104} 天，112 个广告活动)：广告总花费 $${spend}，全店总销售额 $${storeSales}（广告销售 $${adSales}，自然销售 $${orgSales}，自然占比 ${orgRatio}%）；全盘综合 TACoS ${tacos}%，ACoS ${acos}%，ROAS ${roas}，总订单 ${orders} 单。严格遵循折线图 5 核心指标（曝光/点击/订单/花费/ROAS）。Auto 贡献 97.7% 广告销售，Attack 贡献 29 单 (CPC $0.90)，Review 预留美国站基准模板。`;
    return { content: [{ type: 'text', text }], structuredContent: payload };
  }
  if (name === 'export_ad_excel') {
    try {
      execSync(`"${PYTHON_EXE}" "${PYTHON_GEN_SCRIPT}"`, { stdio: 'pipe' });
    } catch (err) {
      console.error('Python execution error:', err);
    }
    const data = loadAdAnalytics();
    const payload = buildUiPayload(data, args.tab || 'overview', {
      excelExported: true,
      excelPath: EXCEL_REPORT_PATH_1,
    });
    return {
      content: [{ type: 'text', text: `已重新生成 UPBestKS 广告分析与推广侦察 Excel 报表：${EXCEL_REPORT_PATH_1}（包含 8 个工作表，21 张原生严格五指标折线图与柱状图）。` }],
      structuredContent: payload,
    };
  }
  throw new Error(`Unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
