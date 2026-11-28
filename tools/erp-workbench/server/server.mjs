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
import { loadConfig, previewFileHeaders, saveConfig, saveUploadedFile, scanReportFiles } from './engines/file-io.mjs';
import { analyzeNegKeywords, getRulesSummary } from './engines/neg-keyword-engine.mjs';
import { loadRoasPresets, runRoasMerge } from './engines/roas-merge-engine.mjs';
import { analyzeInventorySales, clearInventorySalesResult, loadInventorySalesResult } from './engines/inventory-sales-engine.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_URI = 'ui://upbestks-erp-workbench/app.html';
const APP_HTML_PATH = path.join(__dirname, 'dist', 'app.html');

function buildStatePayload(initialTab = 'neg') {
  const config = loadConfig();
  const scanned = scanReportFiles();
  const rulesSummary = getRulesSummary('', 40);
  const roasPresets = loadRoasPresets();
  return {
    initialTab,
    refreshedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    config,
    scannedDirs: scanned.dirs,
    files: scanned.files.slice(0, 150),
    rulesSummary,
    roasPresets,
  };
}

const server = new Server(
  { name: 'upbestks_erp_workbench', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'open_workbench',
      title: 'AMZ 快捷工作台',
      description: '在侧边栏或全屏打开 AMZ 快捷工作台（完整移植否词工具、ROAS 合并、库存销售分析三大模块，直接读取后端规则库与本地报表）。',
      inputSchema: {
        type: 'object',
        properties: {
          tab: { type: 'string', enum: ['neg', 'roas', 'inventory', 'config'] },
        },
      },
      _meta: {
        ui: { resourceUri: APP_URI },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'AMZ 快捷工作台' },
            { type: 'global', title: 'AMZ 快捷工作台' },
          ],
        },
      },
    },
    {
      name: 'workbench_get_state',
      title: '读取工作台状态与本地报表列表',
      description: '扫描本地配置目录中的广告/库存报表文件，并返回否词规则库摘要与 ROAS 预设配置。',
      inputSchema: {
        type: 'object',
        properties: { extraDirs: { type: 'array', items: { type: 'string' } } },
      },
      _meta: { ui: { visibility: ['model', 'app'] } },
    },
    {
      name: 'workbench_upload_file',
      title: '上传本地报表文件到工作台后端',
      description: '将前端拖拽/选择的 Excel 或 CSV 文件保存到工作台上传目录并返回路径与表头预览。',
      inputSchema: {
        type: 'object',
        required: ['fileName', 'base64Content'],
        properties: {
          fileName: { type: 'string' },
          base64Content: { type: 'string' },
        },
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    {
      name: 'workbench_preview_headers',
      title: '预览报表表头与工作表',
      description: '读取指定 Excel/CSV 文件的工作表列表、列索引(A/B/C)与表头名称。',
      inputSchema: {
        type: 'object',
        required: ['filePath'],
        properties: { filePath: { type: 'string' }, sheet: { type: ['number', 'string'] } },
      },
      _meta: { ui: { visibility: ['model', 'app'] } },
    },
    {
      name: 'workbench_get_neg_rules',
      title: '查询后端否词规则库',
      description: '读取并搜索 rules_config.json 中的机型分组、竞品品牌与别名规则。',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
      },
      _meta: { ui: { visibility: ['model', 'app'] } },
    },
    {
      name: 'workbench_save_config',
      title: '保存工作台本地配置',
      description: '更新并持久化扫描目录、导出目录及三大模块的默认阈值参数。',
      inputSchema: {
        type: 'object',
        properties: {
          scanDirs: { type: 'array', items: { type: 'string' } },
          exportDir: { type: 'string' },
          negKeyword: { type: 'object' },
          roasMerge: { type: 'object' },
          inventorySales: { type: 'object' },
        },
      },
      _meta: { ui: { visibility: ['model', 'app'] } },
    },
    {
      name: 'workbench_run_neg_keyword',
      title: '运行否词工具分析与模板导出',
      description: '读取搜索词报告，结合 rules_config.json 规则库与 Python AI 审计引擎执行分类，并导出亚马逊否定词/否定ASIN上传模板 Excel。',
      inputSchema: {
        type: 'object',
        required: ['filePath'],
        properties: {
          filePath: { type: 'string' },
          minSpendNoOrder: { type: 'number' },
          minClicksNoOrder: { type: 'number' },
          matchType: { type: 'string' },
          runPythonAudit: { type: 'boolean' },
          exportTemplate: { type: 'boolean' },
        },
      },
      _meta: { ui: { visibility: ['model', 'app'] } },
    },
    {
      name: 'workbench_run_roas_merge',
      title: '运行 ROAS 多周期合并与判定',
      description: '合并 7/15/30/65 天等广告报告，按推广类型自动执行规则判定并导出带颜色标记的 Excel。',
      inputSchema: {
        type: 'object',
        required: ['reports'],
        properties: {
          reports: {
            type: 'array',
            items: {
              type: 'object',
              required: ['path'],
              properties: {
                path: { type: 'string' },
                dayLabel: { type: 'string' },
                campaignType: { type: 'string', enum: ['auto', 'exact', 'brand'] },
                isMain: { type: 'boolean' },
              },
            },
          },
          keyCols: { type: 'array', items: { type: 'number' } },
          requiredCols: { type: 'array', items: { type: 'boolean' } },
          appendCols: { type: 'array', items: { type: 'object' } },
          autoJudge: { type: 'boolean' },
          exportExcel: { type: 'boolean' },
        },
      },
      _meta: { ui: { visibility: ['model', 'app'] } },
    },
    {
      name: 'workbench_run_inventory_sales',
      title: '运行库存与销售健康分析',
      description: '按 ERP 库存销售分析口径导入赛狐三 Sheet 库存销售表、FBA 快照、昨日/30天推广商品报告与 FBA 货件；按可配置的 ASIN/MSKU/SKU 键关联，计算自然/广告销售、FBA 差异、可售天数与补货风险，并导出 Excel。',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          fbaFilePath: { type: 'string' },
          adFilePath: { type: 'string' },
          adYesterdayFilePath: { type: 'string' },
          ad30dFilePath: { type: 'string' },
          shipmentFilePath: { type: 'string' },
          columnMapping: { type: 'object' },
          matchKeyConfig: { type: 'object' },
          dataDays: { type: 'number' },
          stockoutWarnDays: { type: 'number' },
          overstockWarnDays: { type: 'number' },
          exportExcel: { type: 'boolean' },
        },
      },
      _meta: { ui: { visibility: ['model', 'app'] } },
    },
    {
      name: 'workbench_clear_inventory_sales',
      title: '清除库存销售分析结果',
      description: '清除当前店铺已保存的库存销售分析快照。',
      inputSchema: { type: 'object', properties: {} },
      _meta: { ui: { visibility: ['app'] } },
    },
    {
      name: 'workbench_get_inventory_sales_result',
      title: '读取库存销售分析结果',
      description: '读取当前店铺最近一次库存销售分析快照。',
      inputSchema: { type: 'object', properties: {} },
      _meta: { ui: { visibility: ['app'] } },
    },
  ],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: APP_URI,
      name: 'AMZ 快捷工作台 UI',
      mimeType: 'text/html;profile=mcp-app',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri !== APP_URI) {
    throw new Error(`Unknown resource: ${req.params.uri}`);
  }
  const html = fs.existsSync(APP_HTML_PATH)
    ? fs.readFileSync(APP_HTML_PATH, 'utf8')
    : '<!doctype html><html><body><h3>UI 尚未构建，请运行 npm run build</h3></body></html>';
  return {
    contents: [
      {
        uri: APP_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: html,
        _meta: { ui: { prefersBorder: false } },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === 'open_workbench') {
      const payload = buildStatePayload(args.tab || 'neg');
      return {
        content: [
          {
            type: 'text',
            text: `已打开 AMZ 快捷工作台（扫描目录 ${payload.scannedDirs.length} 个，发现 ${payload.files.length} 份报表文件，否词规则库机型组 ${payload.rulesSummary.modelGroupCount} 个）。`,
          },
        ],
        structuredContent: payload,
      };
    }

    if (name === 'workbench_get_state') {
      const config = loadConfig();
      const scanned = scanReportFiles(args.extraDirs || []);
      const payload = {
        config,
        scannedDirs: scanned.dirs,
        files: scanned.files.slice(0, 150),
        rulesSummary: getRulesSummary('', 40),
        roasPresets: loadRoasPresets(),
      };
      return {
        content: [{ type: 'text', text: `扫描到 ${payload.files.length} 份报表文件。` }],
        structuredContent: payload,
      };
    }

    if (name === 'workbench_upload_file') {
      const savedPath = saveUploadedFile(args.fileName, args.base64Content);
      const preview = await previewFileHeaders(savedPath, 0);
      return {
        content: [{ type: 'text', text: `已上传 ${preview.fileName} (${preview.rowCount} 行)` }],
        structuredContent: { path: savedPath, ...preview },
      };
    }

    if (name === 'workbench_preview_headers') {
      const preview = await previewFileHeaders(args.filePath, args.sheet ?? 0);
      return {
        content: [{ type: 'text', text: `已读取 ${preview.fileName} 表头（${preview.headers.length} 列，${preview.rowCount} 行）` }],
        structuredContent: preview,
      };
    }

    if (name === 'workbench_get_neg_rules') {
      const rules = getRulesSummary(args.query || '', args.limit || 60);
      return {
        content: [{ type: 'text', text: `已加载 ${rules.modelGroupCount} 个机型组，${rules.denyBrandCount} 个竞品品牌。` }],
        structuredContent: rules,
      };
    }

    if (name === 'workbench_save_config') {
      const next = saveConfig(args);
      return {
        content: [{ type: 'text', text: '本地工作台配置已保存。' }],
        structuredContent: { config: next },
      };
    }

    if (name === 'workbench_run_neg_keyword') {
      const result = await analyzeNegKeywords(args);
      return {
        content: [
          {
            type: 'text',
            text: `否词分析完成（${result.fileName}）：共 ${result.totalTerms} 词，建议否掉 ${result.counts.否掉} 词（可省花费 $${result.totalDenySpend}），待观察 ${result.counts.待观察} 词。${result.exportPath ? `模板已导出：${result.exportPath}` : ''}`,
          },
        ],
        structuredContent: result,
      };
    }

    if (name === 'workbench_run_roas_merge') {
      const result = await runRoasMerge(args);
      return {
        content: [
          {
            type: 'text',
            text: `ROAS 合并判定完成：极差 ${result.summaryCounts.极差}、差 ${result.summaryCounts.差}、较差 ${result.summaryCounts.较差}、正常 ${result.summaryCounts.正常}。${result.exportPath ? `Excel 已导出：${result.exportPath}` : ''}`,
          },
        ],
        structuredContent: result,
      };
    }

    if (name === 'workbench_run_inventory_sales') {
      const result = await analyzeInventorySales(args);
      return {
        content: [
          {
            type: 'text',
            text: `库存销售分析完成（${result.fileName}）：共 ${result.totalSkus} 个 SKU，断货高危 ${result.riskCounts.断货高危}、补货预警 ${result.riskCounts.补货预警}、库龄/无动销积压 ${result.riskCounts.库龄积压 + result.riskCounts.无动销积压}。${result.exportPath ? `Excel 已导出：${result.exportPath}` : ''}`,
          },
        ],
        structuredContent: result,
      };
    }

    if (name === 'workbench_clear_inventory_sales') {
      clearInventorySalesResult();
      return {
        content: [{ type: 'text', text: '已清除当前店铺的库存销售分析结果。' }],
        structuredContent: { cleared: true },
      };
    }

    if (name === 'workbench_get_inventory_sales_result') {
      const result = loadInventorySalesResult();
      return {
        content: [{ type: 'text', text: result ? '已读取最近一次库存销售分析结果。' : '当前店铺还没有保存的库存销售分析结果。' }],
        structuredContent: { result },
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `执行失败: ${err.message}` }],
      structuredContent: { error: err.message },
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
