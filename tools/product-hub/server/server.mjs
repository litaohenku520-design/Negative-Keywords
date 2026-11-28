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
import { computeProductAnalytics, REPORT_OUT_PATH } from './product-engine.mjs';
import { generateProductExcel } from './excel-report.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_URI = 'ui://upbestks-product-hub/app.html';
const APP_HTML_PATH = path.join(__dirname, 'dist', 'app.html');

function buildUiPayload(data, initialTab = 'overview', extra = {}) {
  return {
    refreshedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    initialTab,
    reportPath: REPORT_OUT_PATH,
    ...extra,
    data,
  };
}

const server = new Server(
  { name: 'upbestks_product_hub', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'open_product_dashboard',
      title: 'UPBestKS 产品分析可视化',
      description: '在反重力侧边栏或全屏打开 UPBestKS 产品分析可视化看板（按 14 款机型、8 大颜色、品牌与批次分类统计广告 ACoS/TACoS、转化率、销售、退款与库存，含机型×颜色热力矩阵）。',
      inputSchema: {
        type: 'object',
        properties: {
          tab: {
            type: 'string',
            enum: ['overview', 'models', 'colors', 'matrix', 'ads', 'skus'],
            description: '可选初始页签：overview（总览洞察）、models（分机型统计）、colors（分颜色统计）、matrix（机型×颜色矩阵）、ads（广告与流量诊断）、skus（全量SKU明细）。',
          },
        },
      },
      _meta: {
        ui: { resourceUri: APP_URI },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'UPBestKS 产品分析' },
            { type: 'global', title: 'UPBestKS 产品分析' },
          ],
        },
      },
    },
    {
      name: 'get_product_state',
      title: 'Refresh UPBestKS Product Data',
      description: 'Re-read the latest UPBestKS product analysis Excel and return computed analytics by model, color, brand, and SKU.',
      inputSchema: {
        type: 'object',
        properties: {
          tab: { type: 'string' },
        },
      },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
    {
      name: 'export_product_excel',
      title: 'Export UPBestKS Product Excel Report',
      description: 'Generate the 6-sheet UPBestKS Product, Ad & Sales Analysis Excel report with native editable charts.',
      inputSchema: { type: 'object', properties: {} },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
  ],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: APP_URI,
      name: 'UPBestKS 产品分析可视化 UI',
      description: 'Interactive product, model, color, and ad analytics dashboard for UPBestKS',
      mimeType: 'text/html;profile=mcp-app',
      _meta: { ui: { prefersBorder: false } },
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri !== APP_URI) throw new Error(`Unknown resource URI: ${req.params.uri}`);
  if (!fs.existsSync(APP_HTML_PATH)) throw new Error(`Built UI file missing: ${APP_HTML_PATH}`);
  return {
    contents: [
      {
        uri: APP_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: fs.readFileSync(APP_HTML_PATH, 'utf8'),
        _meta: { ui: { prefersBorder: false } },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (name === 'open_product_dashboard' || name === 'get_product_state') {
    const data = await computeProductAnalytics();
    const payload = buildUiPayload(data, args.tab || 'overview');
    const s = data.summary;
    const text = `UPBestKS 产品分析看板已加载（${data.meta.totalSkus} SKU，${data.meta.modelCount} 机型 × ${data.meta.colorCount} 颜色）：总销量 ${s.units} 件，总销售额 $${s.sales.toFixed(2)}，广告花费 $${s.adSpend.toFixed(2)}（ACoS ${(s.acos * 100).toFixed(1)}%，TACoS ${(s.tacos * 100).toFixed(1)}%），整体转化率 ${(s.cvr * 100).toFixed(1)}%。`;
    return { content: [{ type: 'text', text }], structuredContent: payload };
  }
  if (name === 'export_product_excel') {
    const data = await computeProductAnalytics();
    const xlRes = await generateProductExcel(data);
    const payload = buildUiPayload(data, args.tab || 'overview', { excelExported: xlRes });
    return {
      content: [
        {
          type: 'text',
          text: `已生成 UPBestKS 产品分析 Excel 报表：${xlRes.outPath}（共 ${xlRes.sheets.length} 个工作表，${xlRes.chartsCount} 张原生图表，${xlRes.sizeKb} KB）。`,
        },
      ],
      structuredContent: payload,
    };
  }
  throw new Error(`Unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
