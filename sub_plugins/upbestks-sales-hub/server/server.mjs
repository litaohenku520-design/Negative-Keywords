import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { computeSalesAnalytics, REPORT_OUT_PATH } from './sales-engine.mjs';
import { generateSalesExcel } from './excel-report.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_URI = 'ui://upbestks-sales-hub/app.html';
const APP_HTML_PATH = path.join(__dirname, 'dist', 'app.html');

function buildUiPayload(data, initialTab = 'overview', extra = {}) {
  // Strip per-SKU full 104-day maps to keep structuredContent compact (< 250 KB, well under 1 MiB limit)
  const compactSkus = data.skus.map(({ unitsByDate, salesByDate, ordersByDate, ...rest }) => rest);
  return {
    refreshedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    initialTab,
    reportPath: REPORT_OUT_PATH,
    ...extra,
    data: {
      ...data,
      skus: compactSkus,
    },
  };
}

const server = new Server(
  { name: 'upbestks_sales_hub', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'open_sales_dashboard',
      title: 'UPBestKS 销售数据可视化',
      description: '在反重力侧边栏或全屏打开 UPBestKS 销售与库存可视化看板（含 104 天每日/周度/月度趋势、14 款机型与新老品梯队对比、8 大颜色热力矩阵、ABC 爆款排行、FBA 断货/积压预警及赛狐 ERP 136 款补货与在途滞留决策）。',
      inputSchema: {
        type: 'object',
        properties: {
          tab: {
            type: 'string',
            enum: ['overview', 'models', 'colors', 'inventory', 'saihu', 'skus'],
            description: '可选初始页签：overview（销售总览）、models（分机型对比）、colors（颜色与热力矩阵）、inventory（库存健康预警）、saihu（赛狐补货决策）、skus（全量SKU明细）。',
          },
        },
      },
      _meta: {
        ui: { resourceUri: APP_URI },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'UPBestKS 销售看板' },
            { type: 'global', title: 'UPBestKS 销售看板' },
          ],
        },
      },
    },
    {
      name: 'get_sales_state',
      title: 'Refresh UPBestKS Sales Data',
      description: 'Re-read the latest UPBestKS sales Excel from workspace and return full computed analytics.',
      inputSchema: {
        type: 'object',
        properties: {
          tab: { type: 'string' },
        },
      },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
    {
      name: 'export_sales_excel',
      title: 'Regenerate UPBestKS Sales Excel Report',
      description: 'Regenerate the 7-sheet UPBestKS executive Excel analysis report with native editable charts and Saihu replenishment tracking.',
      inputSchema: { type: 'object', properties: {} },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
  ],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: APP_URI,
      name: 'UPBestKS 销售数据可视化 UI',
      description: 'Interactive sales & FBA inventory analytics dashboard for UPBestKS',
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
  if (name === 'open_sales_dashboard' || name === 'get_sales_state') {
    const data = await computeSalesAnalytics();
    const payload = buildUiPayload(data, args.tab || 'overview');
    const s = data.summary;
    const d15 = data.periods.d15;
    const text = `UPBestKS 销售看板已加载 (${data.meta.earliestDate}~${data.meta.latestDate}，共${data.meta.totalDays}天)：总销量 ${s.totalUnits} 件，总销售额 $${s.totalSales.toFixed(2)}（ASP $${s.asp.toFixed(2)}）；近15天 $${d15.sales.toFixed(2)} (${d15.units}件)；FBA 总库存 ${data.inventorySummary.fbaTotal} 件，断货高危(<15天) ${data.inventorySummary.criticalDosCount} 个 SKU。`;
    return { content: [{ type: 'text', text }], structuredContent: payload };
  }
  if (name === 'export_sales_excel') {
    const data = await computeSalesAnalytics();
    const xlRes = await generateSalesExcel(data);
    const payload = buildUiPayload(data, args.tab || 'overview', {
      excelExported: xlRes,
    });
    return {
      content: [{ type: 'text', text: `已生成最新 UPBestKS 销售分析 Excel 报表：${xlRes.outPath}（共 ${xlRes.sheets.length} 个工作表，${xlRes.chartsCount} 张原生图表）。` }],
      structuredContent: payload,
    };
  }
  throw new Error(`Unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
