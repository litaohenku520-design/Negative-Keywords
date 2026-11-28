/**
 * ROAS 合并工具 v2 — 增强版
 *
 * 功能：上传多个ROAS报告（7天/15天/30天/65天等任意天数），按关键词列匹配合并，
 * 将非主报告的ROAS值追加到主报告对应列之后。天数从文件名自动识别（"65天"/"65d"/日期区间），
 * 也可在报告列表中手动编辑（支持 1~365 天任意值）。
 *
 * v2 新增：
 *   - 预设模板支持自定义新增/删除/持久化(localStorage)
 *   - 匹配列支持可选（非必须匹配），匹配模式：全部必须 / 任一匹配 / 自定义最少列数
 *   - 支持多列匹配（不限于3列，可任意数量）
 */
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useStore } from '../shims/erpShims';
import {
  Card, Upload, Button, Table, Tabs, Select, InputNumber, Input, Space, Alert,
  Typography, Tag, Divider, Row, Col, message, Spin, Modal, Checkbox, Switch,
  Tooltip, Popconfirm, Popover,
} from 'antd';
import {
  UploadOutlined, DeleteOutlined, PlayCircleOutlined,
  DownloadOutlined, FileExcelOutlined, SettingOutlined,
  PlusOutlined, SaveOutlined, EditOutlined, UndoOutlined,
  CheckOutlined, CloseOutlined, CloudUploadOutlined, CloudDownloadOutlined, ExperimentOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type { UploadProps } from 'antd/es/upload/interface';
import type { ColumnsType } from 'antd/es/table';
import * as XLSX from 'xlsx-js-style';
import { exportWorkbook } from '../shims/exportUtils';

import { colIndexToLetter, mergeReports, computeSelfCheck, validateReportData, type AppendColConfig, type MatchMode } from './mergeCore';
import {
  CAMPAIGN_LABELS, CAMPAIGN_TYPE_OPTIONS, detectCampaignTypeFromName,
  buildAutoAppendCols, buildJudgedSheet, LEVEL_COLOR, LEVEL_DISPLAY, RULES, templateToRules, parseDayLabel,
  type CampaignType, type JudgeLevel, type JudgedSheet,
  type JudgeTemplate, type JudgeRuleDef, type JudgeCondition, type JudgeMetric, type JudgeOp,
  JUDGE_OP_OPTIONS, JUDGE_LEVEL_OPTIONS, METRIC_LABELS,
} from './judge';
import type { SelfCheckResult } from './mergeCore';

const { Title, Text, Paragraph } = Typography;
const { Option } = Select;

// 判定等级 → antd Tag 预设色
function levelToAntdColor(lv: JudgeLevel): string {
  switch (lv) {
    case '极差': return 'red';
    case '差': return 'orange';
    case '较差': return 'gold';
    case '正常': return 'green';
    default: return 'default';
  }
}

// 从「命中规则」单元格文本解析同时命中的规则条数（多规则详情以 （1）（2）… 编号）
function hitRuleCount(ruleText: any): number {
  const t = String(ruleText ?? '');
  const m = t.match(/（\d+）/g);
  return m ? m.length : 1;
}

// 追加列数值筛选：运算符 + 条件
export type ColOp = '>' | '>=' | '<' | '<=' | '=' | 'between';
export interface ColFilter {
  id: string;
  colIdx: number;       // 列索引（当前 Sheet 行内）
  colHeader: string;    // 列头名（展示用）
  op: ColOp;
  v1: number;
  v2?: number;          // 仅 between 用
}

// 把单元格值解析为数字（容忍 "1.5%" / 空 / 非数值）
function numOf(v: any): number | null {
  if (v == null) return null;
  const s = String(v).trim().replace('%', '');
  if (s === '') return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
}

// ========== 类型定义 ==========
interface ReportFile {
  uid: string;
  name: string;
  data: any[][];       // raw sheet data (header row = row[0])
  fileName: string;
  dayLabel: string;      // e.g. "7", "15", "30"
  campaignType?: CampaignType; // 推广类型：自动推广 / 精确推广 / 品牌推广（合并时按此分组生成 Sheet）
  isMain: boolean;
  color?: string;        // 自定义报告颜色（十六进制 #RRGGBB）；该报告追加列着色优先于天数默认色，留空按天数默认
}

/** 预设模板：内置 + 用户自定义，保存匹配列与追加列配置 */
interface PresetTemplate {
  key: string;
  label: string;
  cols: number[];          // 匹配列索引数组（0-based）
  colLabels?: string[];    // 匹配列名称（如 ['E','G','K']），用于显示
  requiredCols?: boolean[]; // 每列是否必须匹配（true=必须，false=可选），默认全部true
  minMatchCols?: number;   // 最少需要匹配的列数（0=全部必须），默认0
  appendCols?: AppendColConfig[]; // 额外追加列（除ROAS外，从非主报告追加到主报告）
}

// ========== 内置预设 + localStorage 自定义预设 ==========
const BUILTIN_PRESETS: PresetTemplate[] = [
  { key: 'target', label: '投放报告 (E/G/K)', cols: [4, 6, 10], colLabels: ['E', 'G', 'K'] },
  { key: 'sp',     label: '商品推广 (E/F/K)', cols: [4, 5, 10], colLabels: ['E', 'F', 'K'] },
  { key: 'sb',     label: '品牌推广 (E/F/G)', cols: [4, 5, 6],  colLabels: ['E', 'F', 'G'] },

];

// ========== 店铺隔离的存储 key ==========
const BASE_STORAGE_KEY = 'roas_merge_custom_presets';
const BASE_LAST_CONFIG_KEY = 'roas_merge_last_config';
const BASE_BUILTIN_OVERRIDE_KEY = 'roas_merge_builtin_overrides';

let _shopKey = '';
function scopedKeyFor(base: string, shopKey = _shopKey): string {
  return shopKey ? `${base}__${shopKey}` : base;
}
function scopedKey(base: string): string {
  return scopedKeyFor(base, _shopKey);
}

// 兼容旧版直接引用
const STORAGE_KEY = BASE_STORAGE_KEY;
const LAST_CONFIG_KEY = BASE_LAST_CONFIG_KEY;
const BUILTIN_OVERRIDE_KEY = BASE_BUILTIN_OVERRIDE_KEY;

function loadCustomPresets(shopKey = _shopKey): PresetTemplate[] {
  try {
    const raw = localStorage.getItem(scopedKeyFor(BASE_STORAGE_KEY, shopKey));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

/** 写入自定义预设并回读校验，确保确实落盘；localStorage 不可用/被禁用时抛出明确错误 */
function saveCustomPresets(presets: PresetTemplate[], shopKey = _shopKey) {
  try {
    const key = scopedKeyFor(BASE_STORAGE_KEY, shopKey);
    localStorage.setItem(key, JSON.stringify(presets));
    if (!localStorage.getItem(key)) {
      throw new Error('写入后无法回读');
    }
    scheduleRoasBackendSave(shopKey);
  } catch (e: any) {
    throw new Error('保存预设失败（浏览器 localStorage 不可用/被禁用/空间不足）：' + (e?.message ?? e));
  }
}

/** 加载内置预设的覆盖配置（用户在内置预设上修改的 appendCols / requiredCols 等） */
function loadBuiltinOverrides(shopKey = _shopKey): Record<string, Partial<PresetTemplate>> {
  try {
    const raw = localStorage.getItem(scopedKeyFor(BASE_BUILTIN_OVERRIDE_KEY, shopKey));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

/** 保存单个内置预设的覆盖配置 */
function saveBuiltinOverride(key: string, override: Partial<PresetTemplate>, shopKey = _shopKey) {
  try {
    const all = loadBuiltinOverrides(shopKey);
    all[key] = override;
    localStorage.setItem(scopedKeyFor(BASE_BUILTIN_OVERRIDE_KEY, shopKey), JSON.stringify(all));
    scheduleRoasBackendSave(shopKey);
  } catch { /* 静默 */ }
}

/** 删除单个内置预设的覆盖配置 */
function deleteBuiltinOverride(key: string, shopKey = _shopKey) {
  try {
    const all = loadBuiltinOverrides(shopKey);
    delete all[key];
    localStorage.setItem(scopedKeyFor(BASE_BUILTIN_OVERRIDE_KEY, shopKey), JSON.stringify(all));
    scheduleRoasBackendSave(shopKey);
  } catch { /* 静默 */ }
}

interface LastConfig {
  cols: number[];
  colLabels?: string[];
  requiredCols: boolean[];
  activePresetKey?: string;
  appendCols?: AppendColConfig[];
}

/** 保存"上次配置"（非关键，失败静默） */
function saveLastConfig(cfg: LastConfig, shopKey = _shopKey) {
  try {
    localStorage.setItem(scopedKeyFor(BASE_LAST_CONFIG_KEY, shopKey), JSON.stringify(cfg));
    scheduleRoasBackendSave(shopKey);
  } catch { /* 上次配置非关键，静默忽略 */ }
}

function loadLastConfig(shopKey = _shopKey): LastConfig | null {
  try {
    const raw = localStorage.getItem(scopedKeyFor(BASE_LAST_CONFIG_KEY, shopKey));
    return raw ? (JSON.parse(raw) as LastConfig) : null;
  } catch { return null; }
}

function getAllPresets(shopKey = _shopKey): PresetTemplate[] {
  return [...BUILTIN_PRESETS, ...loadCustomPresets(shopKey)];
}

// ========== 判定规则模板（店铺隔离持久化）==========
const BASE_JUDGE_TPL_KEY = 'roas_merge_judge_templates';

function loadJudgeTemplates(shopKey = _shopKey): JudgeTemplate[] {
  try {
    const raw = localStorage.getItem(scopedKeyFor(BASE_JUDGE_TPL_KEY, shopKey));
    return raw ? (JSON.parse(raw) as JudgeTemplate[]) : [];
  } catch { return []; }
}

function saveJudgeTemplates(list: JudgeTemplate[], shopKey = _shopKey) {
  try {
    const key = scopedKeyFor(BASE_JUDGE_TPL_KEY, shopKey);
    localStorage.setItem(key, JSON.stringify(list));
    if (!localStorage.getItem(key)) throw new Error('写入后无法回读');
    scheduleRoasBackendSave(shopKey);
  } catch (e: any) {
    throw new Error('保存判定模板失败（浏览器 localStorage 不可用/被禁用/空间不足）：' + (e?.message ?? e));
  }
}

// ========== 后端整体备份 ==========
const BACKUP_API = '/api/roas-merge-config';
const ROAS_BACKUP_TIMEOUT_MS = 15000;

/**
 * 经 Discover amzn 的 app_api_request MCP bridge 访问仓库内置后端；
 * 普通浏览器开发模式回退到同源 API。ROAS 配置不再写入旧 ERP 启动器。
 */
async function roasBackupFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const apiFetch = (window as any).__MCP_API_FETCH__;
  if (typeof apiFetch === 'function') {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const data = await Promise.race([
        apiFetch(path, init),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('ROAS 配置接口请求超时')), ROAS_BACKUP_TIMEOUT_MS);
        }),
      ]);
      return new Response(JSON.stringify(data ?? {}), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ROAS_BACKUP_TIMEOUT_MS);
  try {
    return await fetch(path, {
      ...init,
      credentials: init.credentials ?? 'include',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

interface RoasMergeBackup {
  customPresets: PresetTemplate[];
  builtinOverrides: Record<string, Partial<PresetTemplate>>;
  lastConfig: LastConfig | null;
  judgeTemplates: JudgeTemplate[];
  savedAt: string;
}

async function fetchBackendBackup(shopKey = _shopKey, latestBackup = false): Promise<RoasMergeBackup | null> {
  try {
    const query = new URLSearchParams();
    if (shopKey) query.set('shop', shopKey);
    if (latestBackup) query.set('backup', 'latest');
    const queryString = query.toString();
    const url = queryString ? `${BACKUP_API}?${queryString}` : BACKUP_API;
    const resp = await roasBackupFetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.success === false) return null;
    return data as RoasMergeBackup;
  } catch { return null; }
}

async function saveBackendBackup(backup: Omit<RoasMergeBackup, 'savedAt'>, shopKey = _shopKey, createSnapshot = false): Promise<boolean> {
  try {
    const query = new URLSearchParams();
    if (shopKey) query.set('shop', shopKey);
    if (createSnapshot) query.set('backup', '1');
    const queryString = query.toString();
    const url = queryString ? `${BACKUP_API}?${queryString}` : BACKUP_API;
    const resp = await roasBackupFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(backup),
    });
    return resp.ok;
  } catch { return false; }
}

// ========== 防抖自动镜像到后端磁盘 ==========
// 任意 localStorage 落盘后，500ms 内把全部配置镜像到 Discover amzn 仓库后端。
let _roasBackendSaveTimer: ReturnType<typeof setTimeout> | null = null;
let _roasBackendSaveShopKey = '';
function scheduleRoasBackendSave(shopKey = _shopKey): void {
  if (_roasBackendSaveTimer) clearTimeout(_roasBackendSaveTimer);
  _roasBackendSaveShopKey = shopKey;
  _roasBackendSaveTimer = setTimeout(() => {
    _roasBackendSaveTimer = null;
    const targetShopKey = _roasBackendSaveShopKey;
    const payload = {
      customPresets: loadCustomPresets(targetShopKey),
      builtinOverrides: loadBuiltinOverrides(targetShopKey),
      lastConfig: loadLastConfig(targetShopKey),
      judgeTemplates: loadJudgeTemplates(targetShopKey),
    };
    saveBackendBackup(payload, targetShopKey).then(ok => {
      if (!ok) console.warn('[ROAS] Discover amzn 后端自动保存失败，仅本地保留');
    });
  }, 500);
}

// ========== 匹配模式 ==========
// 仅保留「精确匹配(全部必须)」一种模式。
// 历史版本提供过「任一匹配 / 最少N列」模糊模式，但会导致 E/F 相同、仅投放(G)差一个词的行互相错配
// （如 "samsung galaxy s26 ultra case" 误匹配到 "samsung galaxy s26 ultra cases"），故移除模糊匹配，
// 合并一律按配置列逐字符精确相等（一字不差）。
const MATCH_MODE_LABELS: Record<MatchMode, string> = {
  all: '精确匹配(全部必须)',
};

// ========== 工具函数 ==========

/** 列字母 → 0-based index (A=0) */
function colLetterToIndex(letter: string): number {
  let result = 0;
  for (const ch of letter.toUpperCase()) {
    result = result * 26 + (ch.charCodeAt(0) - 64);
  }
  return result - 1;
}

/** 解析列输入：支持 "E" / "4" / "E,G,I" */
function parseColInput(input: string): number[] {
  return input.split(/[,\s;/]+/).map(part => {
    part = part.trim();
    if (/^[A-Za-z]+$/.test(part)) return colLetterToIndex(part);
    const n = parseInt(part, 10);
    if (!isNaN(n)) return n;
    throw new Error(`无法解析列名: ${part}`);
  });
}

/** 解析列标签输入：如 "E,G,K" → ['E','G','K'] */
function parseColLabels(input: string): string[] {
  return input.split(/[,\s;/]+/).map(s => s.trim()).filter(Boolean);
}

/** 从 UploadFile 读取 Excel 为 raw 二维数组（后台 Worker 解析，主线程不阻塞） */
const MAX_EXCEL_PARSE_COLS = 16_384;
const MAX_EXCEL_PARSE_ROWS = 1_048_576;

function _isBlankCell(value: unknown): boolean {
  return value === undefined || value === null || String(value) === '';
}

function _compactParsedRows(raw: any[][]): any[][] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  let last = raw.length;
  while (last > 1) {
    const row = raw[last - 1];
    if (!Array.isArray(row) || row.slice(0, MAX_EXCEL_PARSE_COLS).every(_isBlankCell)) last--;
    else break;
  }
  return raw.slice(0, last).map((row) => {
    if (!Array.isArray(row)) return [];
    const safe = row.length > MAX_EXCEL_PARSE_COLS ? row.slice(0, MAX_EXCEL_PARSE_COLS) : row.slice();
    while (safe.length > 0 && _isBlankCell(safe[safe.length - 1])) safe.pop();
    return safe;
  });
}

async function parseExcelViaWorker(file: File): Promise<any[][]> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const workbook = XLSX.read(bytes, { type: 'array', cellStyles: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('工作簿没有可读取的工作表');
  const json = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false }) as any[][];
  const compactData = _compactParsedRows(json);
  if (compactData.length > MAX_EXCEL_PARSE_ROWS) {
    throw new Error(`报告行数超过 Excel 上限 ${MAX_EXCEL_PARSE_ROWS.toLocaleString()}`);
  }
  const header = compactData[0];
  if (!Array.isArray(header) || header.length === 0 || header.every(_isBlankCell)) {
    throw new Error('报告没有有效表头，请确认导入的是广告报告而不是空模板');
  }
  if (compactData.length < 2) {
    throw new Error('报告只有表头没有数据行，请检查报告日期范围或重新导出');
  }
  return compactData;
}

// Excel 工作表的物理上限。部分报告会把 !ref 扩展到很远的空白列/行，
// 直接交给 xlsx-js-style 写出时可能触发 RangeError: Invalid array length。
const EXCEL_MAX_ROWS = 1_048_576;
const EXCEL_MAX_COLS = 16_384;

function isBlankExportRow(row: any, width: number): boolean {
  if (!Array.isArray(row)) return true;
  const limit = Math.min(row.length, width);
  for (let i = 0; i < limit; i++) {
    const value = row[i];
    if (value !== undefined && value !== null && String(value) !== '') return false;
  }
  return true;
}

/**
 * 为 xlsx 写入准备稳定的二维数组：
 * - 以表头宽度为准，裁掉导入文件意外带出的超长稀疏尾列；
 * - 删除末尾纯空白行；
 * - 把不规则短行补齐到表头宽度，避免 xlsx-js-style 在样式扫描时遇到稀疏行；
 *   仅对确实不规则的行分配补齐数组，正常大报告不额外复制宽表。
 */
function normalizeRowsForExport(rows: any[][]): any[][] {
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(rows[0])) {
    throw new Error('导出数据为空或表头格式无效');
  }
  if (rows.length > EXCEL_MAX_ROWS) {
    throw new Error(`导出行数 ${rows.length.toLocaleString()} 超过 Excel 上限 ${EXCEL_MAX_ROWS.toLocaleString()}`);
  }

  const header = rows[0];
  const width = header.length;
  if (!Number.isSafeInteger(width) || width <= 0) throw new Error('导出表头为空或列数无效');
  if (width > EXCEL_MAX_COLS) {
    throw new Error(`导出列数 ${width.toLocaleString()} 超过 Excel 上限 ${EXCEL_MAX_COLS.toLocaleString()}`);
  }

  let last = rows.length;
  while (last > 1 && isBlankExportRow(rows[last - 1], width)) last--;
  const kept = rows.slice(0, last);
  return kept.map((row) => {
    if (!Array.isArray(row)) return new Array(width).fill('');
    if (row.length === width) return row.slice();
    const safe = row.length > width ? row.slice(0, width) : row.slice();
    while (safe.length < width) safe.push('');
    return safe;
  });
}

/** 构建每行 key（多列拼接），支持匹配模式和可选列 */
// ========== 预设颜色色板 ==========
// 提供一组预设颜色供快速选择（与天数默认着色 DAY_COLORS 风格一致），并保留原生取色器做完全自定义。
const PRESET_COLORS: string[] = [
  '#B4C7E7', // 浅蓝
  '#C6E0B4', // 浅绿
  '#F8CBAD', // 浅橙
  '#D9C2E9', // 浅紫
  '#FFE699', // 浅黄
  '#BDD7EE', // 天蓝
  '#E2EFDA', // 薄荷
  '#FCE4D6', // 蜜桃
  '#FFD9D9', // 浅红
  '#D6EAF8', // 冰蓝
  '#F4B183', // 橙
  '#A9D08E', // 绿
  '#9DC3E6', // 蓝
  '#C39BD3', // 紫
  '#FF9999', // 红
  '#FFCC99', // 杏
];

const PresetColorPicker: React.FC<{
  value?: string;
  onChange: (color: string) => void;
  onClear?: () => void;
}> = ({ value, onChange, onClear }) => {
  const norm = (value || '').toUpperCase();
  return (
    <Space direction="vertical" size={10} style={{ width: 232 }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(8, 1fr)',
          gap: 6,
        }}
      >
        {PRESET_COLORS.map((c) => {
          const selected = norm === c.toUpperCase();
          return (
            <Tooltip title={c} key={c}>
              <div
                role="button"
                tabIndex={0}
                aria-label={`选择颜色 ${c}`}
                aria-pressed={selected}
                onClick={() => onChange(c)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onChange(c);
                  }
                }}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 4,
                  cursor: 'pointer',
                  backgroundColor: c,
                  border: selected ? '2px solid #1677ff' : '1px solid #d9d9d9',
                  boxShadow: selected ? '0 0 0 2px rgba(22,119,255,0.25)' : 'none',
                  outline: 'none',
                }}
              />
            </Tooltip>
          );
        })}
      </div>
      <Space size={8} wrap>
        <input
          type="color"
          value={value || '#ffffff'}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: 40, height: 28, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
          aria-label="自定义颜色"
        />
        <Text type="secondary" style={{ fontSize: 12 }}>自定义</Text>
        {onClear ? (
          <Button size="small" onClick={onClear}>清除</Button>
        ) : null}
      </Space>
    </Space>
  );
};

// ========== 主组件 ==========

const RoasMerge: React.FC = () => {
  const navigate = useNavigate();
  const { stores, activeStore, activeShopKey, switchStore } = useStore();
  const [reports, setReports] = useState<ReportFile[]>([]);
  const [mainIdx, setMainIdx] = useState<number>(0);
  const [keyColInputs, setKeyColInputs] = useState<string>('4,6,10');
  const [keyCols, setKeyCols] = useState<number[]>([4, 6, 10]);
  const [merging, setMerging] = useState(false);
  const [mergeLog, setMergeLog] = useState<string[]>([]);
  const [previewData, setPreviewData] = useState<any[][] | null>(null);
  // 判定结果：按推广类型分组的多 Sheet 数据
  const [sheets, setSheets] = useState<JudgedSheet[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [filterLevel, setFilterLevel] = useState<'全部' | JudgeLevel>('全部');
  // 导出范围：全部 = 每个 Sheet 全量导出；筛选 = 仅导出当前 Sheet 的等级+追加列筛后结果
  const [exportScope, setExportScope] = useState<'全部' | '筛选'>('全部');
  // 追加列数值筛选：可叠加多个条件（AND）
  const [colFilters, setColFilters] = useState<ColFilter[]>([]);
  const [draftCol, setDraftCol] = useState<number | null>(null);
  const [draftOp, setDraftOp] = useState<ColOp>('>');
  const [draftV1, setDraftV1] = useState<number | null>(null);
  const [draftV2, setDraftV2] = useState<number | null>(null);
  const [activeBaseDay, setActiveBaseDay] = useState<string>('7');
  const [activeAppendCols, setActiveAppendCols] = useState<AppendColConfig[]>([]);
  // 解析中（Worker 解析大文件时主线程不再阻塞，但仍用此状态给出加载反馈）
  const [parsing, setParsing] = useState(false);
  // 每个追加列的匹配率反馈
  const [matchReport, setMatchReport] = useState<{ col: string; matched: number; unmatched: number; total: number }[]>([]);
  // 全域自检：追加列数据真实性
  const [selfCheck, setSelfCheck] = useState<SelfCheckResult | null>(null);
  const [activePresetKey, setActivePresetKey] = useState<string>('target');
  const [allPresets, setAllPresets] = useState<PresetTemplate[]>(getAllPresets());

  // 匹配模式相关 state
  const [matchMode, setMatchMode] = useState<MatchMode>('all');
  const [minMatchN, setMinMatchN] = useState<number>(2);
  const [requiredCols, setRequiredCols] = useState<boolean[]>([true, true, true]); // 默认全部必须

  // 追加列配置（从非主报告额外追加到主报告的列，除ROAS外）
  const [appendCols, setAppendCols] = useState<AppendColConfig[]>([]);

  // ── ABA 搜索词排名功能 ──
  // abaRankMap: keyword → 排名数字（来自导入的 ABA 排名 Excel）
  const [abaRankMap, setAbaRankMap] = useState<Map<string, number>>(new Map());
  const [abaFileName, setAbaFileName] = useState<string>('');
  const [abaKeywordCol, setAbaKeywordCol] = useState<number>(2); // 主报告中关键词所在列（0-based，默认第3列）
  const [abaShowInReport, setAbaShowInReport] = useState<boolean>(true); // 合并报告中是否包含 ABA 排名列
  const [abaImporting, setAbaImporting] = useState(false);

  // ABA 排名阶段颜色（1-1万 / 1-3万 / 3-5万 / 5-7万 / 7-10万 / 10-20万 / 20万+）
  const ABA_LEVELS: { label: string; min: number; max: number; color: string; zh: string }[] = [
    { label: '1-10000', min: 1, max: 10000, color: '#f5222d', zh: '顶级词' },
    { label: '10001-30000', min: 10001, max: 30000, color: '#fa8c16', zh: '优势词' },
    { label: '30001-50000', min: 30001, max: 50000, color: '#faad14', zh: '潜力词' },
    { label: '50001-70000', min: 50001, max: 70000, color: '#52c41a', zh: '观察词' },
    { label: '70001-100000', min: 70001, max: 100000, color: '#13c2c2', zh: '长尾词' },
    { label: '100001-200000', min: 100001, max: 200000, color: '#722ed1', zh: '长尾词+' },
  ];
  const ABA_NO_RANK_COLOR = '#d9d9d9'; // 未在 ABA 排名中的颜色（灰色）
  const ABA_RANGE_LIMIT = 200000; // 只标到 20 万，更高的视为未上榜

  /** 根据 ABA 排名返回颜色与阶段标签 */
  const abaLevelOf = (rank: number): { color: string; label: string; zh: string } | null => {
    if (!rank || rank <= 0 || rank > ABA_RANGE_LIMIT) return null;
    for (const lv of ABA_LEVELS) {
      if (rank >= lv.min && rank <= lv.max) return { color: lv.color, label: lv.label, zh: lv.zh };
    }
    return null;
  };

  // 判定规则模板（用户可在「匹配设置」内预设 / 保存 / 勾选生效；null=内置默认规则）
  const [judgeTemplates, setJudgeTemplates] = useState<JudgeTemplate[]>([]);
  const [activeJudgeTemplateId, setActiveJudgeTemplateId] = useState<string | null>(null);
  const [judgeTplModalOpen, setJudgeTplModalOpen] = useState(false);
  const [editingTpl, setEditingTpl] = useState<JudgeTemplate | null>(null); // null = 新建

  // 启动水合标记：首次挂载时加载效果会用 localStorage 还原状态，必须等还原提交后再允许自动保存，
  // 否则挂载时自动保存会用初始空状态（appendCols=[] 等）覆盖已持久化的配置，导致刷新后配置丢失。
  const [hydrated, setHydrated] = useState(false);
  const hydratedShopKeyRef = useRef('');

  // 切换预设时跳过自动保存，防止旧预设的 appendCols/requiredCols 被写入新预设
  const skipAutoSaveRef = useRef(false);

  // 新增预设弹窗
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [newPresetCols, setNewPresetCols] = useState('');
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editColor, setEditColor] = useState('');

  // 同步解析列输入
  const applyPreset = useCallback((p: PresetTemplate) => {
    // 跳过自动保存，防止切换瞬间的交叉污染
    skipAutoSaveRef.current = true;
    // 内置预设：合并用户保存的覆盖配置（appendCols / requiredCols 等）
    let merged = p;
    if (BUILTIN_PRESETS.some(b => b.key === p.key)) {
      const overrides = loadBuiltinOverrides();
      const ov = overrides[p.key];
      if (ov) {
        merged = { ...p, ...ov };
      }
    }
    setActivePresetKey(p.key);
    setKeyCols(merged.cols);
    setKeyColInputs(merged.colLabels ? merged.colLabels.join(',') : merged.cols.join(','));
    setRequiredCols(merged.requiredCols || merged.cols.map(() => true));
    setAppendCols(merged.appendCols || []);
    // 合并现在一律精确匹配，模糊模式已移除；保留 minMatchN 状态仅向后兼容旧预设，不再影响匹配
    if (merged.minMatchCols && merged.minMatchCols > 0) {
      setMinMatchN(merged.minMatchCols);
    }
    // 下一个 tick 恢复自动保存
    setTimeout(() => { skipAutoSaveRef.current = false; }, 0);
  }, []);

  const handleColInputChange = (val: string) => {
    setKeyColInputs(val);
    setActivePresetKey('');
    try {
      const cols = parseColInput(val);
      setKeyCols(cols);
      setRequiredCols(cols.map(() => true));
    } catch {
      // ignore parse error, wait for blur
    }
  };

  const handleColInputBlur = () => {
    try {
      const cols = parseColInput(keyColInputs);
      setKeyCols(cols);
      setRequiredCols(prev => {
        const next = cols.map(() => true);
        // 保留已有的 required 设置
        cols.forEach((_, i) => { if (prev[i] !== undefined) next[i] = prev[i]; });
        return next;
      });
      message.success(`匹配列: ${cols.map(c => `col${c}(${colIndexToLetter(c)})`).join('/')}`);
    } catch (e: any) {
      message.error(e.message);
    }
  };

  // —— 判定规则模板 CRUD ——
  const jtUid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const blankJudgeRule = (): JudgeRuleDef => ({
    id: jtUid(),
    level: '较差',
    desc: '',
    action: '',
    conditions: [],
    enabled: true,
  });
  const openNewJudgeTpl = () => {
    setEditingTpl({ id: jtUid(), name: '', campaignType: 'auto', rules: [blankJudgeRule()], createdAt: Date.now() });
    setJudgeTplModalOpen(true);
  };
  const openEditJudgeTpl = (t: JudgeTemplate) => {
    setEditingTpl(JSON.parse(JSON.stringify(t)));
    setJudgeTplModalOpen(true);
  };
  const handleDeleteJudgeTpl = (id: string) => {
    const next = judgeTemplates.filter((t) => t.id !== id);
    setJudgeTemplates(next);
    saveJudgeTemplates(next);
    if (activeJudgeTemplateId === id) setActiveJudgeTemplateId(null);
    message.success('已删除判定模板');
  };
  const handleSaveJudgeTpl = () => {
    if (!editingTpl) return;
    if (!editingTpl.name.trim()) { message.warning('请输入模板名称'); return; }
    if (editingTpl.rules.length === 0) { message.warning('请至少添加一条规则'); return; }
    const next = [...judgeTemplates];
    const idx = next.findIndex((t) => t.id === editingTpl.id);
    if (idx >= 0) next[idx] = editingTpl; else next.push(editingTpl);
    setJudgeTemplates(next);
    saveJudgeTemplates(next);
    setJudgeTplModalOpen(false);
    setEditingTpl(null);
    message.success('判定模板已保存');
  };
  const updateEditingTpl = (patch: Partial<JudgeTemplate>) => {
    setEditingTpl((prev) => (prev ? { ...prev, ...patch } : prev));
  };
  const addJudgeRule = () => {
    setEditingTpl((prev) => (prev ? { ...prev, rules: [...prev.rules, blankJudgeRule()] } : prev));
  };
  const removeJudgeRule = (rid: string) => {
    setEditingTpl((prev) => (prev ? { ...prev, rules: prev.rules.filter((r) => r.id !== rid) } : prev));
  };
  const updateJudgeRule = (rid: string, patch: Partial<JudgeRuleDef>) => {
    setEditingTpl((prev) => (prev ? { ...prev, rules: prev.rules.map((r) => (r.id === rid ? { ...r, ...patch } : r)) } : prev));
  };
  const addJudgeCondition = (rid: string) => {
    setEditingTpl((prev) => (prev ? {
      ...prev,
      rules: prev.rules.map((r) => (r.id === rid
        ? { ...r, conditions: [...r.conditions, { id: jtUid(), target: 'metric', metric: 'roas30', op: '>=', value: 1.8 }] }
        : r)),
    } : prev));
  };
  const removeJudgeCondition = (rid: string, cid: string) => {
    setEditingTpl((prev) => (prev ? {
      ...prev,
      rules: prev.rules.map((r) => (r.id === rid
        ? { ...r, conditions: r.conditions.filter((c) => c.id !== cid) }
        : r)),
    } : prev));
  };
  const updateJudgeCondition = (rid: string, cid: string, patch: Partial<JudgeCondition>) => {
    setEditingTpl((prev) => (prev ? {
      ...prev,
      rules: prev.rules.map((r) => (r.id === rid
        ? { ...r, conditions: r.conditions.map((c) => (c.id === cid ? { ...c, ...patch } : c)) }
        : r)),
    } : prev));
  };

  // 判定规则条件里「追加列」可选项：
  //   优先用「已合并预览表头」中真实的追加列（带天前缀，如 "(7天)ROAS" / "(15天)花费"）—— 可精确区分不同天的同名列；
  //   回退再补 用户已配置追加列标签 + 标准 4 指标（无前缀时仍可模糊匹配）。
  const appendColOptions = useMemo<{ value: string; label: string }[]>(() => {
    const out: { value: string; label: string }[] = [];
    const seen = new Set<string>();
    const header: any[] = previewData && previewData.length > 0 ? previewData[0] : [];
    const push = (v: string) => { if (v && !seen.has(v)) { seen.add(v); out.push({ value: v, label: v }); } };
    // 1) 已合并表头里的追加列（"(N天)指标" 格式，精确可区分）
    header.forEach((h) => { const s = String(h ?? ''); if (/^\(\d+天\)/.test(s)) push(s); });
    // 2) 用户已配置追加列标签
    (appendCols || []).forEach((a) => { if (a.label) push(a.label); });
    // 3) 标准 4 指标兜底
    ['花费', '订单', 'ROAS', 'CTR'].forEach(push);
    return out;
  }, [previewData, appendCols]);

  // 匹配模式改变时同步 requiredCols 长度
   
  useEffect(() => {
    if (requiredCols.length !== keyCols.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRequiredCols(keyCols.map((_, i) => i < requiredCols.length ? requiredCols[i] : true));
    }
  }, [keyCols.length]);

  // —— 店铺切换：重新加载该店铺的预设/覆盖/上次配置 ——
   
  useEffect(() => {
    // StoreProvider 首次加载前 activeShopKey 为空；此时不能用默认状态触发自动保存。
    if (!stores.length || !activeShopKey) return;
    _shopKey = activeShopKey || '';
    hydratedShopKeyRef.current = '';
    // 等待下面的后端恢复完成，避免用初始状态覆盖该店铺已经保存的配置。
    setHydrated(false);
    // 重新加载预设列表
    const refreshed = getAllPresets();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAllPresets(refreshed);
    // 重新加载判定规则模板
    setJudgeTemplates(loadJudgeTemplates());
    setActiveJudgeTemplateId(null); // 切换店铺回到内置默认规则
    // 重新加载上次配置
    const last = loadLastConfig();
    if (last && Array.isArray(last.cols) && last.cols.length > 0) {
      setKeyCols(last.cols);
      setKeyColInputs(last.colLabels && last.colLabels.length === last.cols.length ? last.colLabels.join(',') : last.cols.join(','));
      setRequiredCols(last.requiredCols && last.requiredCols.length === last.cols.length ? last.requiredCols : last.cols.map(() => true));
      setAppendCols(last.appendCols || []);
      if (last.activePresetKey && refreshed.some(p => p.key === last.activePresetKey)) {
        setActivePresetKey(last.activePresetKey);
      } else {
        setActivePresetKey('');
      }
    } else {
      // 无上次配置，回到默认
      setActivePresetKey('target');
      const def = BUILTIN_PRESETS.find(p => p.key === 'target');
      if (def) {
        setKeyCols(def.cols);
        setKeyColInputs(def.colLabels ? def.colLabels.join(',') : def.cols.join(','));
        setRequiredCols(def.requiredCols || def.cols.map(() => true));
        setAppendCols([]);
      }
    }
    // 清空报告和预览（不同店铺数据不同）
    setReports([]);
    setPreviewData(null);
    setMergeLog([]);
    message.info(`已切换到店铺: ${activeStore?.storeName || activeShopKey}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeShopKey, stores.length]);

  // —— 自动持久化当前配置 ——（列/可选/当前预设变化即写入，启动可恢复）
  useEffect(() => {
    if (!hydrated || hydratedShopKeyRef.current !== activeShopKey) return; // 当前店铺后端恢复完成后才允许写回
    saveLastConfig({ cols: keyCols, colLabels: parseColLabels(keyColInputs), requiredCols, activePresetKey, appendCols });
  }, [hydrated, activeShopKey, keyCols, keyColInputs, requiredCols, activePresetKey, appendCols]);

  // —— 内置预设覆盖自动保存 ——（在内置预设上改了 appendCols/requiredCols 时自动覆盖存储）
  useEffect(() => {
    if (!hydrated || hydratedShopKeyRef.current !== activeShopKey) return;
    if (skipAutoSaveRef.current) return;
    if (!activePresetKey) return;
    if (!BUILTIN_PRESETS.some(b => b.key === activePresetKey)) return;
    // 当前激活的是内置预设，保存覆盖
    saveBuiltinOverride(activePresetKey, {
      appendCols: appendCols.map(c => ({ ...c })),
      requiredCols: [...requiredCols],
    });
  }, [hydrated, activeShopKey, activePresetKey, appendCols, requiredCols]);

  // —— 自定义预设自动保存 ——（在自定义预设上改了 appendCols/requiredCols/keyCols 时自动保存）
  useEffect(() => {
    if (!hydrated || hydratedShopKeyRef.current !== activeShopKey) return;
    if (skipAutoSaveRef.current) return;
    if (!activePresetKey) return;
    if (BUILTIN_PRESETS.some(b => b.key === activePresetKey)) return; // 内置预设走上面
    const customs = loadCustomPresets();
    const idx = customs.findIndex(p => p.key === activePresetKey);
    if (idx === -1) return;
    const colLabels = parseColLabels(keyColInputs);
    customs[idx] = {
      ...customs[idx],
      cols: [...keyCols],
      colLabels,
      requiredCols: [...requiredCols],
      minMatchCols: 0,
      appendCols: appendCols.map(c => ({ ...c })),
      label: `${customs[idx].label.split('(')[0].trim()} (${colLabels.join('/')})`,
    };
    saveCustomPresets(customs);
  }, [hydrated, activeShopKey, activePresetKey, appendCols, requiredCols, keyCols, keyColInputs]);

  // 手动保存内置预设覆盖（带提示）
  const handleSaveBuiltinOverride = useCallback((key: string) => {
    saveBuiltinOverride(key, {
      appendCols: appendCols.map(c => ({ ...c })),
      requiredCols: [...requiredCols],
    });
    message.success('配置已保存到该预设（本地覆盖）');
  }, [appendCols, requiredCols]);

  // 重置内置预设覆盖（清除本地修改，恢复原始）
  const handleResetBuiltinOverride = useCallback((key: string) => {
    deleteBuiltinOverride(key);
    const builtin = BUILTIN_PRESETS.find(b => b.key === key);
    if (builtin) {
      setActivePresetKey(builtin.key);
      setKeyCols(builtin.cols);
      setKeyColInputs(builtin.colLabels ? builtin.colLabels.join(',') : builtin.cols.join(','));
      setRequiredCols(builtin.cols.map(() => true));
      setAppendCols([]);
    }
    message.success('已重置为原始配置');
  }, []);

  // 当前内置预设是否有覆盖（用于显示 * 标记和操作按钮）
  const builtinOverrides = useMemo(() => loadBuiltinOverrides(), [activePresetKey, appendCols, requiredCols]);

  // 新增自定义预设
  const handleAddPreset = useCallback(() => {
    if (!newPresetName.trim()) {
      message.error('请输入模板名称');
      return;
    }
    try {
      const cols = parseColInput(newPresetCols);
      if (cols.length === 0) throw new Error('至少需要1列');
      const colLabels = parseColLabels(newPresetCols);
      const preset: PresetTemplate = {
        key: `custom_${Date.now()}`,
        label: `${newPresetName.trim()} (${colLabels.join('/')})`,
        cols,
        colLabels,
        requiredCols: [...requiredCols],
        minMatchCols: 0,
        appendCols: appendCols.map(c => ({ ...c })),
      };
      const customs = loadCustomPresets();
      customs.push(preset);
      saveCustomPresets(customs);
      setAllPresets([...BUILTIN_PRESETS, ...customs]);
      setActivePresetKey(preset.key);
      setAddModalOpen(false);
      setNewPresetName('');
      setNewPresetCols('');
      message.success(`预设「${preset.label}」已保存`);
    } catch (e: any) {
      message.error(e.message);
    }
  }, [newPresetName, newPresetCols, requiredCols, matchMode, minMatchN, appendCols]);

  // 一键保存"当前配置"为预设（按当前列自动命名，重复点击自动更新，无需弹窗）
  const handleSaveCurrentConfig = useCallback(() => {
    try {
      const cols = keyCols;
      if (cols.length === 0) throw new Error('请先配置匹配列');
      const colLabels = parseColLabels(keyColInputs);
      const preset: PresetTemplate = {
        key: `custom_cfg_${cols.join('_')}`,
        label: `我的配置(${colLabels.join('/')})`,
        cols,
        colLabels,
        requiredCols: [...requiredCols],
        minMatchCols: 0,
        appendCols: appendCols.map(c => ({ ...c })),
      };
      const customs = loadCustomPresets().filter(p => p.key !== preset.key);
      customs.push(preset);
      saveCustomPresets(customs);
      setAllPresets([...BUILTIN_PRESETS, ...customs]);
      setActivePresetKey(preset.key);
      message.success(`已保存当前配置为预设「${preset.label}」`);
    } catch (e: any) {
      message.error(e.message);
    }
  }, [keyCols, keyColInputs, requiredCols, appendCols]);

  // 删除自定义预设
  const handleDeletePreset = useCallback((key: string) => {
    if (BUILTIN_PRESETS.some(p => p.key === key)) {
      message.warning('内置预设不可删除');
      return;
    }
    const customs = loadCustomPresets().filter(p => p.key !== key);
    saveCustomPresets(customs);
    setAllPresets([...BUILTIN_PRESETS, ...customs]);
    if (activePresetKey === key) setActivePresetKey('');
    message.success('预设已删除');
  }, [activePresetKey]);

  // 从当前配置更新预设
  const handleUpdatePreset = useCallback((key: string) => {
    const customs = loadCustomPresets();
    const idx = customs.findIndex(p => p.key === key);
    if (idx === -1) {
      message.warning('只能更新自定义预设');
      return;
    }
    const colLabels = parseColLabels(keyColInputs);
    customs[idx] = {
      ...customs[idx],
      cols: [...keyCols],
      colLabels,
      requiredCols: [...requiredCols],
      minMatchCols: 0,
      appendCols: appendCols.map(c => ({ ...c })),
      label: `${customs[idx].label.split('(')[0].trim()} (${colLabels.join('/')})`,
    };
    saveCustomPresets(customs);
    setAllPresets([...BUILTIN_PRESETS, ...customs]);
    message.success('预设已更新');
  }, [keyCols, keyColInputs, requiredCols, matchMode, minMatchN, appendCols]);

  // 重命名预设模板
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const handleRenamePreset = useCallback((key: string) => {
    const preset = allPresets.find(p => p.key === key);
    if (!preset) return;
    setRenamingKey(key);
    // 取 '(' 之前的名称作为初始值
    setRenameValue(preset.label.split('(')[0].trim());
  }, [allPresets]);

  const handleRenameConfirm = useCallback(() => {
    if (!renamingKey || !renameValue.trim()) {
      setRenamingKey(null);
      return;
    }
    const isBuiltin = BUILTIN_PRESETS.some(b => b.key === renamingKey);
    if (isBuiltin) {
      // 内置预设：用 override 保存自定义 label
      saveBuiltinOverride(renamingKey, { label: renameValue.trim() });
    } else {
      // 自定义预设：直接改 label
      const customs = loadCustomPresets();
      const idx = customs.findIndex(p => p.key === renamingKey);
      if (idx >= 0) {
        const colLabels = customs[idx].colLabels || [];
        customs[idx] = { ...customs[idx], label: `${renameValue.trim()} (${colLabels.join('/')})` };
        saveCustomPresets(customs);
      }
    }
    setAllPresets([...BUILTIN_PRESETS, ...loadCustomPresets()]);
    setRenamingKey(null);
    setRenameValue('');
    message.success('已重命名');
  }, [renamingKey, renameValue]);

  // —— 后端整体备份/恢复 ——
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupTime, setBackupTime] = useState<string | null>(null);

  const handleBackupToBackend = useCallback(async () => {
    setBackupLoading(true);
    try {
      const shopKey = activeShopKey || _shopKey;
      const backup: Omit<RoasMergeBackup, 'savedAt'> = {
        customPresets: loadCustomPresets(shopKey),
        builtinOverrides: loadBuiltinOverrides(shopKey),
        lastConfig: loadLastConfig(shopKey),
        judgeTemplates: loadJudgeTemplates(shopKey),
      };
      const ok = await saveBackendBackup(backup, shopKey, true);
      if (ok) {
        setBackupTime(new Date().toLocaleString('zh-CN'));
        message.success('已备份到 Discover amzn 后端，并加入 GitHub 同步队列');
      } else {
        message.error('备份失败（后端服务未启动或登录会话已失效）');
      }
    } finally {
      setBackupLoading(false);
    }
  }, [activeShopKey]);

  // —— 保存全部配置到 Discover amzn 后端，并加入仓库同步队列 ——
  const handleSaveAllToBackend = useCallback(async () => {
    setBackupLoading(true);
    try {
      const shopKey = activeShopKey || _shopKey;
      const currentLastConfig: LastConfig = {
        cols: [...keyCols],
        colLabels: parseColLabels(keyColInputs),
        requiredCols: [...requiredCols],
        activePresetKey,
        appendCols: appendCols.map((col) => ({ ...col })),
      };

      // 按钮点击时直接把当前 React 状态写入目标店铺，避免用户刚编辑完就点击保存时，
      // React effect 尚未执行，loadLastConfig() 仍读到上一版配置。
      try {
        localStorage.setItem(scopedKeyFor(BASE_LAST_CONFIG_KEY, shopKey), JSON.stringify(currentLastConfig));
        localStorage.setItem(scopedKeyFor(BASE_JUDGE_TPL_KEY, shopKey), JSON.stringify(judgeTemplates));
        if (BUILTIN_PRESETS.some((preset) => preset.key === activePresetKey)) {
          const overrides = loadBuiltinOverrides(shopKey);
          overrides[activePresetKey] = {
            ...(overrides[activePresetKey] || {}),
            appendCols: currentLastConfig.appendCols,
            requiredCols: currentLastConfig.requiredCols,
          };
          localStorage.setItem(scopedKeyFor(BASE_BUILTIN_OVERRIDE_KEY, shopKey), JSON.stringify(overrides));
        } else if (activePresetKey) {
          const customPresets = loadCustomPresets(shopKey);
          const customIndex = customPresets.findIndex((preset) => preset.key === activePresetKey);
          if (customIndex >= 0) {
            customPresets[customIndex] = {
              ...customPresets[customIndex],
              cols: [...currentLastConfig.cols],
              colLabels: [...(currentLastConfig.colLabels || [])],
              requiredCols: [...currentLastConfig.requiredCols],
              appendCols: currentLastConfig.appendCols,
            };
            localStorage.setItem(scopedKeyFor(BASE_STORAGE_KEY, shopKey), JSON.stringify(customPresets));
          }
        }
      } catch {
        // 后端结构化备份仍会使用当前内存状态继续尝试保存。
      }

      const customPresets = loadCustomPresets(shopKey);
      const builtinOverrides = loadBuiltinOverrides(shopKey);
      const backup: Omit<RoasMergeBackup, 'savedAt'> = {
        customPresets,
        builtinOverrides,
        lastConfig: currentLastConfig,
        judgeTemplates: [...judgeTemplates],
      };
      const saved = await saveBackendBackup(backup, shopKey);

      if (saved) {
        setBackupTime(new Date().toLocaleString('zh-CN'));
        message.success('全部 ROAS 配置已保存到 Discover amzn 后端，并加入 GitHub 同步队列');
      } else {
        message.error('保存失败（Discover amzn 后端未响应）');
      }
    } finally {
      setBackupLoading(false);
    }
  }, [activeShopKey, keyCols, keyColInputs, requiredCols, activePresetKey, appendCols, judgeTemplates]);

  const applyBackendBackup = useCallback(async (silent: boolean, shopKey = _shopKey, latestBackup = false): Promise<boolean> => {
    const backup = await fetchBackendBackup(shopKey, latestBackup);
    if (!backup) {
      if (!silent) message.warning('后端无备份或服务未启动');
      return false;
    }
    // 店铺切换期间，旧店铺的慢响应不能覆盖新店铺的状态。
    if (shopKey !== _shopKey) return false;

    const customPresets = Array.isArray(backup.customPresets) ? backup.customPresets : [];
    const builtinOverrides = backup.builtinOverrides && typeof backup.builtinOverrides === 'object'
      ? backup.builtinOverrides
      : {};
    const hasLastConfig = !!backup.lastConfig
      && Array.isArray(backup.lastConfig.cols)
      && backup.lastConfig.cols.length > 0;
    const judgeTemplates = Array.isArray(backup.judgeTemplates) ? backup.judgeTemplates : null;

    // 恢复时直接写入目标店铺的 localStorage，不调用带自动保存副作用的 helper，
    // 避免恢复过程中的防抖保存把旧状态再次写回后端。
    try {
      localStorage.setItem(scopedKeyFor(BASE_STORAGE_KEY, shopKey), JSON.stringify(customPresets));
      localStorage.setItem(scopedKeyFor(BASE_BUILTIN_OVERRIDE_KEY, shopKey), JSON.stringify(builtinOverrides));
      if (hasLastConfig) {
        localStorage.setItem(scopedKeyFor(BASE_LAST_CONFIG_KEY, shopKey), JSON.stringify(backup.lastConfig));
      }
      if (judgeTemplates) {
        localStorage.setItem(scopedKeyFor(BASE_JUDGE_TPL_KEY, shopKey), JSON.stringify(judgeTemplates));
      }
    } catch {
      // localStorage 不可用时仍继续把后端配置恢复到当前 React 状态。
    }

    setAllPresets([...BUILTIN_PRESETS, ...customPresets]);
    if (judgeTemplates) {
      setJudgeTemplates(judgeTemplates);
      setActiveJudgeTemplateId(null);
    }
    // 恢复上次配置
    if (hasLastConfig && backup.lastConfig) {
      setKeyCols(backup.lastConfig.cols);
      setKeyColInputs(backup.lastConfig.colLabels ? backup.lastConfig.colLabels.join(',') : backup.lastConfig.cols.join(','));
      setRequiredCols(
        Array.isArray(backup.lastConfig.requiredCols) && backup.lastConfig.requiredCols.length === backup.lastConfig.cols.length
          ? backup.lastConfig.requiredCols
          : backup.lastConfig.cols.map(() => true),
      );
      setAppendCols(backup.lastConfig.appendCols || []);
      setActivePresetKey(backup.lastConfig.activePresetKey || '');
    }
    setBackupTime(backup.savedAt ? new Date(backup.savedAt).toLocaleString('zh-CN') : null);
    if (!silent) message.success('已从后端恢复配置');
    return true;
  }, []);

  const handleRestoreFromBackend = useCallback(() => {
    setBackupLoading(true);
    applyBackendBackup(false, activeShopKey || _shopKey, true).finally(() => setBackupLoading(false));
  }, [activeShopKey, applyBackendBackup]);

  // 启动/切换店铺时从该店铺的后端配置恢复。
  // 必须等 StoreProvider 完成真实店铺加载后再执行，避免先用默认店铺状态覆盖配置。
  useEffect(() => {
    if (!stores.length || !activeShopKey) return;
    const shopKey = activeShopKey;
    _shopKey = shopKey;
    let cancelled = false;
    applyBackendBackup(true, shopKey).finally(() => {
      if (!cancelled && shopKey === _shopKey) {
        hydratedShopKeyRef.current = shopKey;
        setHydrated(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeShopKey, stores.length, applyBackendBackup]);

  // —— 文件上传 ——
  const uploadProps: UploadProps = {
    accept: '.xlsx,.xls',
    multiple: true,
    showUploadList: false,
    beforeUpload: async (file) => {
      try {
        setParsing(true);
        const data = await parseExcelViaWorker(file as unknown as File);
        const dayLabel = detectDayFromName(file.name);

        const newReport: ReportFile = {
          uid: `${Date.now()}_${Math.random()}`,
          name: file.name as string,
          data,
          fileName: file.name as string,
          dayLabel,
          campaignType: detectCampaignTypeFromName(file.name as string), // ERP 外选类型：文件名自动识别，可手动改
          isMain: reports.length === 0,  // 第一个上传的默认主报告
        };

        setReports(prev => {
          const next = [...prev, newReport];
          if (next.length === 1) setMainIdx(0);
          return next;
        });
        message.success(`已添加: ${file.name} (${dayLabel}天)`);
      } catch (e: any) {
        message.error(`读取失败: ${e.message}`);
      } finally {
        setParsing(false);
      }
      return false; // 阻止自动上传
    },
  };

  /**
   * 从文件名自动识别报告天数（不再用 window.prompt 阻断上传）。
   * 支持：中文 "65天" / 英文 "65d" / 日期区间 "2026-04-01 to 2026-06-05" → 天数，兜底默认 7。
   */
  // 文件名天数识别统一委托 parseDayLabel（已支持 中文数字 / "7天" / "7d" / 日期区间，兜底 7）
  function detectDayFromName(fileName: string): string {
    return parseDayLabel(fileName);
  }

  const handleDeleteReport = (uid: string) => {
    setReports(prev => {
      const next = prev.filter(r => r.uid !== uid);
      if (next.length > 0 && mainIdx >= next.length) setMainIdx(0);
      return next;
    });
  };

  const handleSetMain = (uid: string) => {
    const idx = reports.findIndex(r => r.uid === uid);
    if (idx >= 0) {
      setMainIdx(idx);
      message.info(`主报告: ${reports[idx].name}`);
    }
  };

  // 直接编辑某条报告的天数（支持 数字 / 中文数字 / "7天" / "7d"，覆盖自动识别结果；统一归一为纯数字）
  const updateReportDay = useCallback((uid: string, raw: any) => {
    const n = parseDayLabel(raw == null ? '' : String(raw));
    setReports(prev => prev.map(r => (r.uid === uid ? { ...r, dayLabel: n } : r)));
  }, []);

  // 设置/清除某条报告的自定义颜色（用于该报告追加列着色，优先于天数默认色）
  const updateReportColor = useCallback((uid: string, color: string) => {
    setReports(prev => prev.map(r => (r.uid === uid ? { ...r, color: color ? color : undefined } : r)));
  }, []);

  // 设置某条报告的推广类型（自动/精确/品牌），决定合并时归属哪个 Sheet
  const updateReportCampaignType = useCallback((uid: string, type: CampaignType) => {
    setReports(prev => prev.map(r => (r.uid === uid ? { ...r, campaignType: type } : r)));
  }, []);

  const handleClearAll = () => {
    setReports([]);
    setMainIdx(0);
    setPreviewData(null);
    setSheets([]);
    setMergeLog([]);
  };

  // —— ABA 搜索词排名导入 ——
  const handleAbaImport = async (file: File) => {
    setAbaImporting(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      // 搜索词.xlsx 格式：第1行是元数据，第2行开始是 [排名, 搜索词]
      const rows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1 });
      const rankMap = new Map<string, number>();
      let startRow = 0;
      // 跳过元数据行，找到第一行是数字（排名）的数据
      for (let i = 0; i < rows.length; i++) {
        const val = rows[i]?.[0];
        if (val !== undefined && val !== null && !isNaN(Number(val)) && Number(val) > 0 && String(rows[i]?.[1] || '').trim()) {
          startRow = i;
          break;
        }
      }
      let count = 0;
      for (let i = startRow; i < rows.length; i++) {
        const rank = parseInt(rows[i]?.[0], 10);
        const keyword = String(rows[i]?.[1] || '').trim().toLowerCase();
        if (!isNaN(rank) && rank > 0 && keyword) {
          rankMap.set(keyword, rank);
          count++;
        }
      }
      setAbaRankMap(rankMap);
      setAbaFileName(file.name);
      message.success(`ABA 搜索词排名导入成功：${count} 个关键词（${file.name}）`);
    } catch (e: any) {
      message.error('ABA 排名导入失败：' + e.message);
    } finally {
      setAbaImporting(false);
    }
    return false;
  };

  // 清空 ABA 排名数据
  const handleClearAba = () => {
    setAbaRankMap(new Map());
    setAbaFileName('');
    message.info('ABA 排名数据已清空');
  };

  // —— 执行合并 ——
  const handleMerge = useCallback(async () => {
    if (reports.length < 2) {
      message.error('至少需要2个报告文件！');
      return;
    }
    if (mainIdx === null || mainIdx >= reports.length) {
      message.error('请设置主报告！');
      return;
    }
    if (keyCols.length === 0) {
      message.error('请配置匹配列！');
      return;
    }

    // 上传文件来自 Worker，但仍需在进入分组/判定前再次校验，避免空表头、
    // 只有表头的品牌报告在 buildJudgedSheet 内触发未捕获异常。
    try {
      reports.forEach((report) => validateReportData(report.data, report.name));
    } catch (e: any) {
      message.error(`无法合并：${e?.message || e}`);
      return;
    }

    setMerging(true);
    setMergeLog([]);
    const logLines: string[] = [];

    const log = (msg: string) => {
      logLines.push(msg);
      setMergeLog([...logLines]);
    };

    try {
      const main = reports[mainIdx];
      const extras = reports.filter((_, i) => i !== mainIdx);

      log(`🔃 主报告: ${main.name} (${main.dayLabel}天)`);
      log(`📊 主报告: ${main.data.length} 行 x ${main.data[0]?.length || 0} 列`);

      // 调用纯函数核心完成匹配与合并（逻辑在 mergeCore.ts，已单测覆盖）
      const res = mergeReports({
        main: { data: main.data, dayLabel: main.dayLabel, name: main.name },
        extras: extras.map((e) => ({ data: e.data, dayLabel: e.dayLabel, name: e.name })),
        keyCols,
        matchMode,
        minMatchN,
        requiredCols,
        appendCols,
      });

      // 回放核心日志，保持与之前一致的可见执行过程
      res.logs.forEach((line) => log(line));

      setPreviewData(res.resultRows);
      // ── ABA 搜索词排名标注（若已导入）──
      if (abaRankMap.size > 0 && abaShowInReport) {
        const resultRows = res.resultRows;
        const header = resultRows[0];
        // 添加 ABA 排名列和阶段列
        const abaRankColIdx = header.length;
        const abaLevelColIdx = header.length + 1;
        header.push('ABA排名', 'ABA阶段');
        for (let i = 1; i < resultRows.length; i++) {
          const keyword = String(resultRows[i][abaKeywordCol] || '').trim().toLowerCase();
          const rank = abaRankMap.get(keyword) || 0;
          if (rank > 0 && rank <= ABA_RANGE_LIMIT) {
            resultRows[i].push(rank, abaLevelOf(rank)?.label || '');
          } else {
            resultRows[i].push(rank > 0 ? rank : 0, rank > 0 ? '20万+' : '未上榜');
          }
        }
        setPreviewData([...resultRows]); // 强制更新引用
        log(`📊 ABA 排名标注：已匹配 ${resultRows.slice(1).filter(r => r[abaRankColIdx] > 0).length} 个关键词`);
      }
      // 全域自检：追加列数据真实性（未匹配/非数值/负值/异常大值）
      setSelfCheck(computeSelfCheck(res.resultRows, extras.length, appendCols));
      // 每个追加列的匹配率反馈
      const total = main.data.length - 1;
      setMatchReport(
        res.extraHeaders.map((col, i) => {
          const ei = Math.floor(i / Math.max(1, appendCols.length));
          const matched = res.matchedCounts[ei];
          return { col, matched, unmatched: total - matched, total };
        }),
      );

      // —— 按推广类型分组，构建「判定 Sheet」（每类型一 Sheet，末尾带判定等级列）——
      const groups: Record<CampaignType, ReportFile[]> = { auto: [], exact: [], brand: [] };
      reports.forEach((r) => { groups[r.campaignType || 'auto'].push(r); });

      // 判定规则模板：选中模板则按模板规则（需 campaignType 匹配），否则回退内置 RULES
      const activeTpl = activeJudgeTemplateId
        ? judgeTemplates.find((t) => t.id === activeJudgeTemplateId) ?? null
        : null;
      const rulesFor = (tp: CampaignType) => {
        if (activeTpl && (activeTpl.campaignType === 'all' || activeTpl.campaignType === tp)) {
          return templateToRules(activeTpl);
        }
        return RULES[tp];
      };
      if (activeTpl) log(`📐 判定规则模板生效：${activeTpl.name}（适用范围：${activeTpl.campaignType === 'all' ? '全部推广类型' : CAMPAIGN_LABELS[activeTpl.campaignType]}）`);
      else log('📐 判定规则：使用内置默认规则（未选择判定模板）');

      const builtSheets: JudgedSheet[] = [];
      (Object.keys(groups) as CampaignType[]).forEach((type) => {
        const grp = groups[type];
        if (grp.length < 2) {
          log(`⚠️ ${CAMPAIGN_LABELS[type]}：仅 ${grp.length} 个报告，不足以判定，跳过（需≥2）`);
          return;
        }
        // 组内主报告：优先用全局主报告（若在本组），否则取组内第一个
        let localMain = grp.findIndex((r) => r.uid === reports[mainIdx]?.uid);
        if (localMain === -1) localMain = 0;
        const grpExtras = grp.filter((_, i) => i !== localMain);
        // 自动追加 花费/订单/ROAS/CTR（从首个非主报告表头识别列位置，同类型报告列布局一致）
        const autoAppendCols = grpExtras.length ? buildAutoAppendCols(grpExtras[0].data[0]) : [];
        log(`🔃 ${CAMPAIGN_LABELS[type]} 分组：主 ${grp[localMain].name} + ${grpExtras.length} 个非主报告`);
        const sheet = buildJudgedSheet(
          grp.map((r) => ({ data: r.data, dayLabel: r.dayLabel, name: r.name, uid: r.uid, color: r.color })),
          type, keyCols, requiredCols, matchMode, localMain,
          appendCols,     // 用户自定义追加列（补充）
          autoAppendCols, // 自动 花费/订单/ROAS/CTR
          rulesFor(type), // 判定规则（模板或内置）
        );
        sheet.logs.forEach((l) => log(l));
        const c = sheet.counts;
        log(`  📊 ${CAMPAIGN_LABELS[type]} 判定：极差 ${c['极差']} / 差 ${c['差']} / 较差 ${c['较差']} / 正常 ${c['正常']} / 数据不足 ${c['数据不足']}`);
        builtSheets.push(sheet);
      });
      setSheets(builtSheets);
      setActiveSheet(0);
      setFilterLevel('全部');
      setColFilters([]);
      setDraftCol(null);
      setDraftV1(null);
      setDraftV2(null);

      if (builtSheets.length > 0) {
        const totalRows = builtSheets.reduce((s, sh) => s + (sh.rows.length - 1), 0);
        message.success(`合并完成！生成 ${builtSheets.length} 个判定 Sheet（共 ${totalRows} 行），可在下方预览/筛选并导出`);
      } else {
        message.success('合并完成！（未形成可判定的推广类型分组，每个类型需≥2个报告）');
      }

    } catch (e: any) {
      log(`❌ 错误: ${e.message}`);
      message.error(`合并失败: ${e.message}`);
    } finally {
      setMerging(false);
    }
  }, [reports, mainIdx, keyCols, matchMode, minMatchN, requiredCols, appendCols]);

  // 手动重新执行全域自检（合并后会自动跑一次）
  const runSelfCheck = useCallback(() => {
    if (!previewData || previewData.length < 2) {
      message.warning('请先合并生成预览');
      return;
    }
    const nExtra = Math.max(0, reports.length - 1);
    setSelfCheck(computeSelfCheck(previewData, nExtra, appendCols));
  }, [previewData, reports, appendCols]);

  // ========== 判定预览前置定义（在 handleExport 之前，避免 TDZ）==========
  const activeSheetData = sheets[activeSheet];
  const metricCols = useMemo(() => {
    if (!activeSheetData || activeSheetData.rows.length === 0) return [];
    const header = activeSheetData.rows[0];
    return header
      .map((h: any, ci: number) => ({ ci, h: String(h ?? '') }))
      .filter(({ h, ci }) => ci < header.length - 3 && /^(?:\((\d+)天\))?(花费|订单|ROAS|CTR|点击率)/i.test(h));
  }, [activeSheetData]);
  const filteredRows = useMemo(() => {
    if (!activeSheetData || activeSheetData.rows.length === 0) return [];
    const header = activeSheetData.rows[0];
    let rows = activeSheetData.rows.slice(1);
    if (filterLevel !== '全部') rows = rows.filter((r) => r[r.length - 3] === filterLevel);
    if (colFilters.length > 0) {
      rows = rows.filter((r) => colFilters.every((f) => {
        const n = numOf(r[f.colIdx]);
        if (n == null) return false;
        switch (f.op) {
          case '>': return n > f.v1;
          case '>=': return n >= f.v1;
          case '<': return n < f.v1;
          case '<=': return n <= f.v1;
          case '=': return n === f.v1;
          case 'between': {
            const lo = Math.min(f.v1, f.v2 ?? f.v1);
            const hi = Math.max(f.v1, f.v2 ?? f.v1);
            return n >= lo && n <= hi;
          }
          default: return true;
        }
      }));
    }
    // 始终保留表头：表格展示会 slice(1)，导出则直接使用完整二维数组。
    return [header, ...rows];
  }, [activeSheetData, filterLevel, colFilters]);

  // —— 导出（按推广类型分多 Sheet，判定等级列着色）——
  const handleExport = useCallback(async () => {
    if (!sheets || sheets.length === 0) {
      message.error('没有可导出的判定数据，请先执行合并');
      return;
    }
    try {
      const wb = XLSX.utils.book_new();
      // 对单张 Sheet 写入着色（判定等级列 + 用户设置的报告/追加列自定义色）
      const writeJudgedSheet = (ws: XLSX.WorkSheet, rowsToWrite: any[][], columnColors?: (string | undefined)[]) => {
        if (!Array.isArray(rowsToWrite) || rowsToWrite.length === 0 || !Array.isArray(rowsToWrite[0])) {
          throw new Error('导出数据为空或表头格式无效');
        }
        const header = rowsToWrite[0];
        if (header.length === 0) throw new Error('导出表头为空');
        const levelColIdx = header.length - 3;
        const actionColIdx = header.length - 1;
        // 表头加粗
        for (let c = 0; c < header.length; c++) {
          const cellRef = XLSX.utils.encode_cell({ r: 0, c });
          const cell = ws[cellRef];
          if (cell) cell.s = { ...(cell.s || {}), font: { ...(cell.s?.font || {}), bold: true } };
        }
        for (let r = 1; r < rowsToWrite.length; r++) {
          // 用户自定义列色（主报告色 / 追加列色 / 报告色），与预览保持一致
          for (let c = 0; c < header.length; c++) {
            const bg = columnColors?.[c];
            if (bg) {
              const ref = XLSX.utils.encode_cell({ r, c });
              const cell = ws[ref];
              if (cell) {
                cell.s = { ...(cell.s || {}), fill: { fgColor: { rgb: bg.replace('#', '').toUpperCase() } } };
              }
            }
          }
          // 判定等级列按颜色填充（较深色配白字，黄色配黑字保证可读）
          const lv = rowsToWrite[r][levelColIdx] as JudgeLevel;
          const rgb = (LEVEL_COLOR[lv] || '#BFBFBF').replace('#', '').toUpperCase();
          const lRef = XLSX.utils.encode_cell({ r, c: levelColIdx });
          const lCell = ws[lRef];
          if (lCell) {
            lCell.s = {
              fill: { fgColor: { rgb } },
              font: { bold: true, color: { rgb: lv === '较差' ? '000000' : 'FFFFFF' } },
              alignment: { horizontal: 'center' },
            };
          }
          const aRef = XLSX.utils.encode_cell({ r, c: actionColIdx });
          const aCell = ws[aRef];
          if (aCell) aCell.s = { ...(aCell.s || {}), alignment: { horizontal: 'center' } };
        }
        ws['!cols'] = header.map((_: any, ci: number) => ({ wch: ci >= levelColIdx ? 18 : 16 }));
      };

      if (exportScope === '筛选') {
        // 仅导出当前 Sheet 的筛选结果（等级 + 追加列筛后）
        if (!activeSheetData) { message.error('当前没有可导出的 Sheet'); return; }
        const rowsToWrite = normalizeRowsForExport(filteredRows); // 已含表头 + 数据行
        if (rowsToWrite.length <= 1) { message.warning('当前筛选结果为空，无可导出数据'); return; }
        const ws = XLSX.utils.aoa_to_sheet(rowsToWrite);
        writeJudgedSheet(ws, rowsToWrite, activeSheetData.columnColors);
        const lvTag = filterLevel !== '全部' ? `·${filterLevel}` : '';
        const cfTag = colFilters.length > 0 ? `·${colFilters.length}条筛选` : '';
        const safeName = `${CAMPAIGN_LABELS[activeSheetData.type]}${lvTag}${cfTag}`.replace(/[:\\/?*[\]]/g, '').slice(0, 31);
        XLSX.utils.book_append_sheet(wb, ws, safeName);
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const shopSuffix = activeShopKey ? `_${activeShopKey}` : '';
        await exportWorkbook({ wb, fileName: `ROAS判定合并_筛选${shopSuffix}_${dateStr}`, cellStyles: true, throwOnError: true });
        message.success(`已导出当前筛选结果：${rowsToWrite.length - 1} 行（${CAMPAIGN_LABELS[activeSheetData.type]}${lvTag}${cfTag}）`);
      } else {
        // 导出全部 Sheet（每文案一张）
        const usedSheetNames = new Set<string>();
        let exportedSheetCount = 0;
        sheets.forEach((sh) => {
          if (!Array.isArray(sh.rows) || sh.rows.length < 2) return;
          const rowsToWrite = normalizeRowsForExport(sh.rows);
          if (rowsToWrite.length < 2) return;
          const ws = XLSX.utils.aoa_to_sheet(rowsToWrite);
          writeJudgedSheet(ws, rowsToWrite, sh.columnColors);
          const baseName = (CAMPAIGN_LABELS[sh.type] || sh.type || 'Sheet').replace(/[:\\/?*[\]]/g, '').slice(0, 31) || 'Sheet';
          let safeName = baseName;
          let suffix = 2;
          while (usedSheetNames.has(safeName)) {
            const suffixText = `_${suffix++}`;
            safeName = `${baseName.slice(0, 31 - suffixText.length)}${suffixText}`;
          }
          usedSheetNames.add(safeName);
          XLSX.utils.book_append_sheet(wb, ws, safeName);
          exportedSheetCount += 1;
        });
        if (exportedSheetCount === 0) throw new Error('没有可导出的有效 Sheet');
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const shopSuffix = activeShopKey ? `_${activeShopKey}` : '';
        await exportWorkbook({ wb, fileName: `ROAS判定合并${shopSuffix}_${dateStr}`, cellStyles: true, throwOnError: true });
        message.success(`已导出 ${exportedSheetCount} 个 Sheet（按推广类型分表，判定等级列已着色）`);
      }
    } catch (e: any) {
      message.error(`导出失败: ${e.message}`);
    }
  }, [sheets, activeShopKey, exportScope, activeSheetData, filteredRows, filterLevel, colFilters]);

  // —— 预览表格 columns（带追加列彩色表头）——
  const PREVIEW_DAY_COLORS: Record<string, string> = {
    '7':  '#b4c7e7',
    '15': '#c6e0b4',
    '30': '#f8cbad',
    '65': '#d9c2e9',
  };
  const PREVIEW_FALLBACK = ['#ffe699', '#bdd7ee', '#e2efda', '#fce4d6', '#ffd9d9', '#d6eaf8'];

  const previewColumns = useMemo(() => {
    if (!previewData || previewData.length === 0) return [];
    const header = previewData[0];
    const mainDayLabel = reports[mainIdx]?.dayLabel;
    const extras = reports.filter((_, i) => i !== mainIdx);
    const mainColorRaw = reports[mainIdx]?.color;
    const mainColor = (mainColorRaw && /^#?[0-9A-Fa-f]{6}$/.test(mainColorRaw)) ? mainColorRaw : undefined;
    const usedDays: string[] = [];
    let fbIdx = 0;
    let appendedIdx = 0;
    return header.map((h: any, ci: number) => {
      const hStr = String(h ?? `列${ci}`);
      const m = hStr.match(/^\((\d+)天\)/);
      let bgColor: string | undefined;
      let isMainRoas = false;
      if (m) {
        const d = m[1];
        const isMainCol = d === mainDayLabel && hStr.includes('ROAS');
        if (isMainCol) {
          isMainRoas = true;
          bgColor = mainColor || '#f2f2f2'; // 主报告自定义色优先于灰
        } else {
          if (!usedDays.includes(d)) usedDays.push(d);
          const acConfig = appendCols.length ? appendCols[appendedIdx % appendCols.length] : undefined;
          const reportColor = appendCols.length ? extras[Math.floor(appendedIdx / appendCols.length)]?.color : undefined;
          appendedIdx++;
          bgColor = (acConfig?.color && /^#[0-9A-Fa-f]{6}$/.test(acConfig.color))
            ? acConfig.color
            : (reportColor && /^#[0-9A-Fa-f]{6}$/.test(reportColor))
              ? reportColor
              : (PREVIEW_DAY_COLORS[d] || PREVIEW_FALLBACK[fbIdx++ % PREVIEW_FALLBACK.length]);
        }
      } else if (hStr.includes('ROAS')) {
        isMainRoas = true;
        bgColor = mainColor || '#f2f2f2';
      } else {
        // 主报告其余列（如关键词列）：有主报告自定义色则整列上色
        bgColor = mainColor || undefined;
      }
      return {
        title: <span style={bgColor ? { backgroundColor: bgColor, padding: '2px 8px', borderRadius: 3, fontWeight: m ? 700 : 700 } : { fontWeight: 700 }}>{hStr}</span>,
        dataIndex: `c${ci}`,
        width: m ? 130 : 120,
        render: (v: any) => v ?? '',
        onCell: () => (bgColor ? { style: { backgroundColor: bgColor } } : {}),
      };
    });
  }, [previewData, reports, mainIdx, appendCols]);

  const previewDataSource = useMemo(() => {
    if (!previewData || previewData.length <= 1) return [];
    return previewData.slice(1).map((row, ri) => {
      const record: any = { key: ri };
      row.forEach((cell: any, ci: number) => { record[`c${ci}`] = cell; });
      return record;
    });
  }, [previewData]);

  const sheetColumns = useMemo<ColumnsType<any>>(() => {
    if (!activeSheetData || activeSheetData.rows.length === 0) return [];
    const header = activeSheetData.rows[0];
    const levelColIdx = header.length - 3;
    const ruleColIdx = header.length - 2;
    const actionColIdx = header.length - 1;
    return header.map((h: any, ci: number) => {
      const isLevel = ci === levelColIdx;
      const isRule = ci === ruleColIdx;
      const isAction = ci === actionColIdx;
      const hStr = String(h ?? `列${ci}`);
      const isPercent = /ctr|点击率/i.test(hStr);
      const isMoney = /花费|spend|cost/i.test(hStr);
      const isNumericCol = !isLevel && !isRule && !isAction && /^(?:\((\d+)天\))?(花费|订单|ROAS|CTR|点击率)/i.test(hStr);
      return {
        title: <span style={{ fontWeight: 700 }}>{hStr}</span>,
        dataIndex: `c${ci}`,
        width: (isLevel || isAction) ? 150 : 120,
        ellipsis: !isLevel && !isAction,
        ...(isNumericCol ? { align: 'right' as const } : {}),
        ...(isNumericCol ? {
          sorter: (a: any, b: any) => {
            const na = numOf(a[`c${ci}`]);
            const nb = numOf(b[`c${ci}`]);
            if (na == null && nb == null) return 0;
            if (na == null) return -1;
            if (nb == null) return 1;
            return na - nb;
          },
        } : {}),
        render: (v: any, rec: any) => {
          if (isLevel) {
            const lv = v as JudgeLevel;
            const n = hitRuleCount(rec?.[`c${ruleColIdx}`]);
            return (
              <Tag color={levelToAntdColor(lv)}>
                {LEVEL_DISPLAY[lv] || lv}{n > 1 ? ` ·命中${n}条` : ''}
              </Tag>
            );
          }
          if (isRule) return <Text type="secondary" style={{ fontSize: 12 }}>{v}</Text>;
          if (isAction) return <Text type="secondary">{v}</Text>;
          // 数值列智能格式化
          if (isNumericCol && v != null && v !== '') {
            const n = numOf(v);
            if (n != null) {
              const dec = isMoney ? 2 : (Math.abs(n) < 100 ? 2 : 0);
              return isPercent ? `${n.toFixed(2)}%` : Number(n.toFixed(dec));
            }
          }
          return v ?? '';
        },
        onCell: (rec: any) => {
          if (isLevel) {
            const lv = rec[`c${ci}`] as JudgeLevel;
            return { style: { backgroundColor: `${LEVEL_COLOR[lv] || '#BFBFBF'}22` } };
          }
          if (isNumericCol) return { style: { textAlign: 'right' } };
          return {};
        },
      };
    });
  }, [activeSheetData]);

  const sheetDataSource = useMemo(() => {
    return filteredRows.slice(1).map((row, ri) => {
      const rec: any = { key: ri };
      row.forEach((cell: any, ci: number) => { rec[`c${ci}`] = cell; });
      return rec;
    });
  }, [filteredRows]);

  // —— 追加列编辑弹窗 ——
  const openEdit = (i: number, ac: AppendColConfig) => {
    setEditIndex(i);
    setEditLabel(ac.label || '');
    setEditColor(ac.color || '');
    setEditModalOpen(true);
  };
  const handleEditAppendCol = () => {
    if (editIndex === null) return;
    const next = [...appendCols];
    next[editIndex] = { ...next[editIndex], label: editLabel, color: editColor || undefined };
    setAppendCols(next);
    setEditModalOpen(false);
    setEditIndex(null);
    setEditLabel('');
    setEditColor('');
  };

  // ========== 渲染 ==========

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <Title level={3} style={{ margin: 0 }}>
          <FileExcelOutlined /> ROAS 合并工具
        </Title>
        <Space>
          <Text type="secondary" style={{ fontSize: 12 }}>当前店铺:</Text>
          <Select
            size="small"
            style={{ width: 180 }}
            value={activeShopKey}
            onChange={(v) => switchStore(v)}
          >
            {stores.filter(s => s.isActive).map(s => (
              <Option key={s.id} value={s.id}>
                <Tag color={s.color} style={{ marginRight: 4 }}>{s.marketplace}</Tag>
                {s.storeName}
              </Option>
            ))}
          </Select>
        </Space>
      </div>
      <Paragraph type="secondary" style={{ marginTop: 8 }}>
        上传多个ROAS报告（支持 7天 / 15天 / 30天 / 65天 等任意天数），按关键词列匹配合并，将非主报告的ROAS值追加到主报告。天数从文件名自动识别，也可在报告列表中手动编辑（支持中文：如 7 / 7天 / 七天）。支持预设模板、可选匹配列、多列匹配。
      </Paragraph>

      {/* 区块下钻 */}
      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>下钻分析：</Text>
        <Button type="link" size="small" style={{ padding: '0 4px' }} onClick={() => navigate('/dashboard')}>数据看板</Button>
        <Button type="link" size="small" style={{ padding: '0 4px' }} onClick={() => navigate('/ad-optimization')}>广告优化中心</Button>
        <Button type="link" size="small" style={{ padding: '0 4px' }} onClick={() => navigate('/campaign-explorer')}>活动明细</Button>
        <Button type="link" size="small" style={{ padding: '0 4px' }} onClick={() => navigate('/model-analysis')}>机型维度</Button>
      </div>

      {/* —— 预设模板 + 匹配列配置 —— */}
      <Card size="small" style={{ marginBottom: 16 }} title={<Space><SettingOutlined />匹配配置</Space>}>
        <Row gutter={[8, 8]} align="middle">
          <Col flex="none"><Text strong>预设模板:</Text></Col>
          <Col flex="auto">
            <Space wrap size={4}>
              {allPresets.map(p => {
                const isBuiltin = BUILTIN_PRESETS.some(b => b.key === p.key);
                const hasOverride = isBuiltin && !!builtinOverrides[p.key];
                // 覆盖后的 label
                const displayLabel = (isBuiltin && builtinOverrides[p.key]?.label) ? `${builtinOverrides[p.key].label} (${p.colLabels?.join('/') || ''})` : p.label;
                const isRenaming = renamingKey === p.key;
                return (
                <span key={p.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                  {isRenaming ? (
                    <>
                      <Input
                        size="small"
                        style={{ width: 140 }}
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onPressEnter={handleRenameConfirm}
                        placeholder="模板名称"
                      />
                      <Tooltip title="确认">
                        <Button size="small" type="primary" icon={<CheckOutlined />} onClick={handleRenameConfirm} />
                      </Tooltip>
                      <Tooltip title="取消">
                        <Button size="small" icon={<CloseOutlined />} type="text" onClick={() => { setRenamingKey(null); setRenameValue(''); }} />
                      </Tooltip>
                    </>
                  ) : (
                    <>
                      <Button
                        size="small"
                        type={activePresetKey === p.key ? 'primary' : 'default'}
                        onClick={() => applyPreset(p)}
                      >
                        {displayLabel}{hasOverride && <span style={{ fontSize: 10, marginLeft: 2 }}>*</span>}
                      </Button>
                      <Tooltip title="重命名">
                        <Button size="small" icon={<EditOutlined />} type="text" onClick={() => handleRenamePreset(p.key)} />
                      </Tooltip>
                      {isBuiltin ? (
                        <>
                          {hasOverride && (
                            <>
                              <Tooltip title="保存配置到此预设（本地覆盖）">
                                <Button size="small" icon={<SaveOutlined />} type="text" onClick={() => handleSaveBuiltinOverride(p.key)} />
                              </Tooltip>
                              <Popconfirm title="重置为原始配置?" onConfirm={() => handleResetBuiltinOverride(p.key)} okText="重置" cancelText="取消">
                                <Tooltip title="重置为原始配置">
                                  <Button size="small" icon={<UndoOutlined />} type="text" />
                                </Tooltip>
                              </Popconfirm>
                            </>
                          )}
                        </>
                      ) : (
                        <>
                          <Tooltip title="更新预设配置">
                            <Button size="small" icon={<SaveOutlined />} type="text" onClick={() => handleUpdatePreset(p.key)} />
                          </Tooltip>
                          <Popconfirm title="删除该预设?" onConfirm={() => handleDeletePreset(p.key)} okText="删除" cancelText="取消">
                            <Button size="small" icon={<DeleteOutlined />} type="text" danger />
                          </Popconfirm>
                        </>
                      )}
                    </>
                  )}
                </span>
                );
              })}
              <Button size="small" icon={<PlusOutlined />} onClick={() => setAddModalOpen(true)}>
                新增预设
              </Button>
              <Divider type="vertical" style={{ margin: '0 4px' }} />
              <Tooltip title={backupTime ? `上次备份: ${backupTime}` : '将所有预设/配置备份到后端本地'}>
                <Button
                  size="small"
                  icon={<CloudUploadOutlined />}
                  loading={backupLoading}
                  onClick={handleBackupToBackend}
                >
                  备份
                </Button>
              </Tooltip>
              <Tooltip title="保存全部配置（预设+覆盖+判定模板）到 Vite 后端和启动器，双重保险">
                <Button
                  size="small"
                  icon={<SaveOutlined />}
                  loading={backupLoading}
                  onClick={handleSaveAllToBackend}
                >
                  保存全部配置到后台
                </Button>
              </Tooltip>
              <Popconfirm title="从后端恢复配置？当前配置将被覆盖" onConfirm={handleRestoreFromBackend} okText="恢复" cancelText="取消">
                <Tooltip title={backupTime ? `从后端恢复（备份时间: ${backupTime}）` : '从后端恢复配置'}>
                  <Button
                    size="small"
                    icon={<CloudDownloadOutlined />}
                    loading={backupLoading}
                  >
                    恢复
                  </Button>
                </Tooltip>
              </Popconfirm>
            </Space>
          </Col>
        </Row>

        <Divider style={{ margin: '12px 0' }} />

        <Row gutter={[8, 8]} align="middle">
          <Col flex="none"><Text strong>匹配列:</Text></Col>
          <Col flex="none">
            <Input
              style={{ width: 240 }}
              value={keyColInputs}
              onChange={e => handleColInputChange(e.target.value)}
              onBlur={handleColInputBlur}
              placeholder="如: E,G,K 或 4,6,10"
            />
          </Col>
          <Col flex="none">
            <Tooltip title="把当前匹配列配置存为预设并持久化，下次启动自动恢复">
              <Button size="small" icon={<SaveOutlined />} onClick={handleSaveCurrentConfig}>
                保存当前配置
              </Button>
            </Tooltip>
          </Col>
          <Col flex="none">
            <Text type="secondary" style={{ fontSize: 12 }}>
              {keyCols.length > 0 ? `→ ${keyCols.map((c, i) => {
                const req = requiredCols[i] !== false;
                return `${colIndexToLetter(c)}${req ? '' : '(可选)'}`;
              }).join(' / ')}` : '格式错误'}
              （{keyCols.length}列）
            </Text>
          </Col>
        </Row>

        <Divider style={{ margin: '12px 0' }} />

        <Row gutter={[8, 8]} align="middle">
          <Col flex="none"><Text strong>匹配模式:</Text></Col>
          <Col flex="none">
            <Select value={matchMode} onChange={setMatchMode} style={{ width: 120 }} size="small">
              {Object.entries(MATCH_MODE_LABELS).map(([k, v]) => (
                <Option key={k} value={k}>{v}</Option>
              ))}
            </Select>
          </Col>
          <Col flex="none">
            <Divider type="vertical" />
          </Col>
          <Col flex="none"><Text strong>列可选:</Text></Col>
          <Col flex="auto">
            <Space size={8} wrap>
              {keyCols.map((c, i) => (
                <Checkbox
                  key={i}
                  checked={requiredCols[i] !== false}
                  onChange={e => {
                    const next = [...requiredCols];
                    next[i] = e.target.checked;
                    setRequiredCols(next);
                  }}
                >
                  {colIndexToLetter(c)} 必须
                </Checkbox>
              ))}
            </Space>
          </Col>
        </Row>

        <Divider style={{ margin: '12px 0' }} />

        {/* —— 追加列配置 —— */}
        <Row gutter={[8, 8]} align="middle">
          <Col flex="none"><Text strong>追加列:</Text></Col>
          <Col flex="auto">
            <Text type="secondary" style={{ fontSize: 12 }}>
              选择非主报告中需要追加到主报告的额外列（除自动匹配的ROAS外）。每个预设模板独立配置，随预设持久化。最终表头名 = (天数) + 自定义名称（右侧实时预览）。点击行尾色块或「编辑」按钮可设置自定义颜色。
            </Text>
          </Col>
        </Row>
        <div style={{ marginTop: 8 }}>
          {appendCols.length === 0 ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              暂无追加列（仅追加ROAS）。点击下方按钮添加需要追加的列。
            </Text>
          ) : (
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              {appendCols.map((ac, i) => {
                // 显示当前列对应的表头名称（从首个非主报告取）
                const ext = reports.find((_, ri) => ri !== mainIdx);
                const headerName = ext?.data?.[0]?.[ac.colIdx];
                return (
                <Row key={i} gutter={8} align="middle">
                  <Col flex="none">
                    <Text style={{ fontSize: 12 }}>列</Text>
                  </Col>
                  <Col flex="none">
                    <Input
                      size="small"
                      style={{ width: 70 }}
                      value={colIndexToLetter(ac.colIdx)}
                      onChange={e => {
                        const v = e.target.value.trim();
                        try {
                          const idx = /^[A-Za-z]+$/.test(v) ? colLetterToIndex(v) : parseInt(v, 10);
                          if (!isNaN(idx) && idx >= 0) {
                            const next = [...appendCols];
                            next[i] = { ...next[i], colIdx: idx };
                            setAppendCols(next);
                          }
                        } catch { /* ignore */ }
                      }}
                      placeholder="如 E 或 4"
                    />
                  </Col>
                  <Col flex="none">
                    {headerName ? (
                      <Tag color="blue" style={{ fontSize: 11 }}>{String(headerName)}</Tag>
                    ) : (
                      <Text type="secondary" style={{ fontSize: 11 }}>未匹配</Text>
                    )}
                  </Col>
                  <Col flex="none"><Text style={{ fontSize: 12 }}>→</Text></Col>
                  <Col flex="auto">
                    <Input
                      size="small"
                      style={{ width: 120 }}
                      value={ac.label || ''}
                      onChange={e => {
                        const next = [...appendCols];
                        next[i] = { ...next[i], label: e.target.value };
                        setAppendCols(next);
                      }}
                      placeholder="列头标签（如 花费）"
                    />
                  </Col>
                  <Col flex="none">
                    <Select
                      size="small"
                      style={{ width: 90 }}
                      value={ac.displayFormat || 'value'}
                      onChange={(v: 'value' | 'percent') => {
                        const next = [...appendCols];
                        next[i] = { ...next[i], displayFormat: v };
                        setAppendCols(next);
                      }}
                    >
                      <Option value="value">数值</Option>
                      <Option value="percent">百分比</Option>
                    </Select>
                  </Col>
                  <Col flex="none">
                    <Tooltip title="最终导出表头名 = (天数) + 自定义名称">
                      <Tag color="geekblue" style={{ fontSize: 11 }}>
                        {`(${ext?.dayLabel ?? '?'}天)${ac.label || headerName || `col${ac.colIdx}(${colIndexToLetter(ac.colIdx)})`}`}
                      </Tag>
                    </Tooltip>
                  </Col>
                  <Col flex="none">
                    <Tooltip title={ac.color ? `自定义颜色 ${ac.color}（点击编辑）` : '点击设置自定义颜色'}>
                      <div
                        onClick={() => openEdit(i, ac)}
                        style={{
                          width: 22, height: 22, borderRadius: 4, cursor: 'pointer',
                          backgroundColor: ac.color || '#ffffff',
                          border: '1px solid #d9d9d9',
                        }}
                      />
                    </Tooltip>
                  </Col>
                  <Col flex="none">
                    <Button
                      size="small"
                      type="link"
                      icon={<EditOutlined />}
                      onClick={() => openEdit(i, ac)}
                    >
                      编辑
                    </Button>
                  </Col>
                  <Col flex="none">
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => setAppendCols(appendCols.filter((_, j) => j !== i))}
                    />
                  </Col>
                </Row>
                );
              })}
            </Space>
          )}
          <Button
            size="small"
            icon={<PlusOutlined />}
            style={{ marginTop: 4 }}
            onClick={() => setAppendCols([...appendCols, { colIdx: 0, label: '' }])}
          >
            添加追加列
          </Button>
          {/* 可用列提示：显示首个非主报告的表头 */}
          {reports.length >= 2 && (() => {
            const ext = reports.find((_, i) => i !== mainIdx);
            if (!ext || !ext.data[0]) return null;
            const headers = ext.data[0] as any[];
            return (
              <Tooltip title={
                <div style={{ maxHeight: 300, overflow: 'auto' }}>
                  {headers.map((h, ci) => (
                    <div key={ci} style={{ whiteSpace: 'nowrap' }}>
                      {colIndexToLetter(ci)} (col{ci}): {String(h || '(空)')}
                    </div>
                  ))}
                </div>
              } placement="right">
                <Button type="link" size="small" style={{ padding: '0 4px' }}>
                  📋 查看「{ext.dayLabel}天」报告列头
                </Button>
              </Tooltip>
            );
          })()}
        </div>

      </Card>

      {/* —— 判定规则模板（用户可预设 / 保存 / 勾选生效）—— */}
      <Card
        size="small"
        style={{ marginBottom: 16 }}
        title={<Space><ExperimentOutlined />判定规则模板</Space>}
        extra={
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openNewJudgeTpl}>
            新增模板
          </Button>
        }
      >
        <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
          判定等级 / 命中规则 / 建议操作 默认使用内置规则。可在此预设并保存多套判定模板，合并时勾选其中一套生效；
          模板可限定适用范围（自动 / 精确 / 品牌 / 全部）。未勾选时回退内置规则，保证历史行为一致。
        </Paragraph>
        <Space wrap size={6}>
          <Button
            size="small"
            type={activeJudgeTemplateId === null ? 'primary' : 'default'}
            onClick={() => setActiveJudgeTemplateId(null)}
          >
            内置默认规则
          </Button>
          {judgeTemplates.map((t) => (
            <span key={t.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <Button
                size="small"
                type={activeJudgeTemplateId === t.id ? 'primary' : 'default'}
                onClick={() => setActiveJudgeTemplateId(t.id)}
              >
                {t.name}
                <Tag style={{ marginLeft: 4, fontSize: 10 }}>
                  {t.campaignType === 'all' ? '全部' : CAMPAIGN_LABELS[t.campaignType]}
                </Tag>
              </Button>
              <Tooltip title="编辑模板">
                <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEditJudgeTpl(t)} />
              </Tooltip>
              <Popconfirm title="删除该判定模板？" onConfirm={() => handleDeleteJudgeTpl(t.id)} okText="删除" cancelText="取消">
                <Button size="small" type="text" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </span>
          ))}
        </Space>
      </Card>

      <Card
        title="报告列表（双击设为主报告）"
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          <Space>
            <Button size="small" icon={<DeleteOutlined />} onClick={handleClearAll}>
              清空
            </Button>
          </Space>
        }
      >
        <Upload {...uploadProps}>
          <Button icon={<UploadOutlined />} loading={parsing}>添加报告文件</Button>
        </Upload>
        {parsing && (
          <Text type="secondary">
            <Spin size="small" /> 正在后台解析文件（不卡界面）…
          </Text>
        )}

        <Paragraph type="secondary" style={{ marginTop: 8, fontSize: 12, marginBottom: 4 }}>
          着色优先级（高→低）：
          <Tag color="#9DC3E6" style={{ marginLeft: 4 }}>追加列自定义色</Tag>
          {'>'}
          <Tag color="#F8CBAD" style={{ marginLeft: 4 }}>报告自定义色</Tag>
          {'>'}
          <Tag color="#E2EFDA" style={{ marginLeft: 4 }}>按天数默认色</Tag>
          ；某级留空则自动回落到下一级。
        </Paragraph>

        {reports.length > 0 && (
          <Table virtual scroll={{ y: 520 }}
            size="small"
            style={{ marginTop: 12 }}
            pagination={false}
            dataSource={reports}
            columns={[
              {
                title: '主',
                key: 'main',
                width: 50,
                render: (_, r, idx) =>
                  mainIdx === idx ? <Tag color="blue">★ 主</Tag> : null,
              },
              {
                title: '天数',
                dataIndex: 'dayLabel',
                width: 96,
                sorter: (a: any, b: any) => Number(a.dayLabel ?? 0) - Number(b.dayLabel ?? 0),
                render: (_: any, r: ReportFile) => (
                  <Input
                    size="small"
                    value={r.dayLabel}
                    placeholder="7 / 7天 / 七天"
                    style={{ width: 92 }}
                    onChange={(e) => updateReportDay(r.uid, e.target.value)}
                  />
                ),
              },
              {
                title: '推广类型',
                key: 'campaignType',
                width: 120,
                render: (_: any, r: ReportFile) => (
                  <Select
                    size="small"
                    value={r.campaignType || 'auto'}
                    style={{ width: 104 }}
                    onChange={(v: CampaignType) => updateReportCampaignType(r.uid, v)}
                    options={CAMPAIGN_TYPE_OPTIONS}
                  />
                ),
              },
              {
                title: '文件名',
                dataIndex: 'name', sorter: (a: any, b: any) => String(a.name ?? '').localeCompare(String(b.name ?? '')),
                ellipsis: true,
                render: (name: string) => <Text>{name}</Text>,
              },
              {
                title: '尺寸',
                key: 'size',
                width: 120,
                render: (_, r) => `${Array.isArray(r.data) ? r.data.length : 0}行 x ${Array.isArray(r.data?.[0]) ? r.data[0].length : 0}列`,
              },
              {
                title: '颜色',
                key: 'color',
                width: 72,
                render: (_: any, r: ReportFile, idx: number) => {
                  const isMainRow = mainIdx === idx;
                  return (
                    <Popover
                      trigger="click"
                      content={
                        <Space direction="vertical" size={8} style={{ alignItems: 'stretch' }}>
                          <PresetColorPicker
                            value={r.color}
                            onChange={(c) => updateReportColor(r.uid, c)}
                            onClear={() => updateReportColor(r.uid, '')}
                          />
                          {isMainRow && (
                            <Text type="secondary" style={{ fontSize: 11, maxWidth: 170, lineHeight: 1.4 }}>
                              主报告自定义色将应用到主报告所有列
                            </Text>
                          )}
                        </Space>
                      }
                    >
                      <div
                        title={r.color ? `自定义颜色 ${r.color}` : (isMainRow ? '点击设置主报告自定义色（应用到主报告所有列）' : '点击设置自定义颜色（默认按天数着色）')}
                        style={{
                          width: 28, height: 20, borderRadius: 4, cursor: 'pointer',
                          backgroundColor: r.color || '#f0f0f0',
                          border: '1px solid #d9d9d9', display: 'flex', alignItems: 'center',
                          justifyContent: 'center', fontSize: 10, color: '#888',
                        }}
                      >
                        {r.color ? '' : (isMainRow ? '主' : '默认')}
                      </div>
                    </Popover>
                  );
                },
              },
              {
                title: '操作',
                key: 'ops',
                width: 160,
                render: (_, r, idx) => (
                  <Space size="small">
                    <Button size="small" onClick={() => handleSetMain(r.uid)}>
                      设为主报告
                    </Button>
                    <Button size="small" danger onClick={() => handleDeleteReport(r.uid)}>
                      删除
                    </Button>
                  </Space>
                ),
              },
            ]}
            rowKey="uid"
            onRow={(r, idx) => ({
              onDoubleClick: () => handleSetMain(r.uid),
            })}
          />
        )}
      </Card>

      {/* —— 执行合并 —— */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            disabled={reports.length < 2}
            loading={merging}
            onClick={handleMerge}
            size="large"
          >
            执行合并
          </Button>
          <Button
            icon={<DownloadOutlined />}
            disabled={sheets.length === 0}
            onClick={handleExport}
          >
            导出结果
          </Button>
          <Select
            size="small"
            value={exportScope}
            onChange={(v) => setExportScope(v)}
            style={{ width: 130 }}
            options={[
              { value: '全部', label: '导出全部 Sheet' },
              { value: '筛选', label: '仅导出当前筛选' },
            ]}
          />
          {reports.length > 0 && (
            <Text type="secondary">
              主报告: {reports[mainIdx]?.name || '-'} | 共 {reports.length} 个报告
            </Text>
          )}
        </Space>
      </Card>

      {/* —— ABA 搜索词排名设置 —— */}
      <Card size="small" title={<Space><SearchOutlined />ABA 搜索词排名</Space>} style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          <Space wrap>
            <Upload accept=".xlsx,.xls" showUploadList={false} beforeUpload={handleAbaImport} disabled={abaImporting}>
              <Button icon={<UploadOutlined />} loading={abaImporting}>
                {abaFileName ? '重新导入' : '导入ABA排名'}
              </Button>
            </Upload>
            {abaFileName && (
              <>
                <Tag color="blue">{abaFileName}</Tag>
                <Tag>{abaRankMap.size} 个关键词</Tag>
                <Button size="small" onClick={handleClearAba}>清空</Button>
              </>
            )}
            {!abaFileName && (
              <Text type="secondary">导入亚马逊ABA搜索词排名Excel（格式：排名 | 搜索词）</Text>
            )}
          </Space>
          {abaRankMap.size > 0 && (
            <Space wrap>
              <span style={{ fontSize: 12, color: '#666' }}>关键词列:</span>
              <Select
                size="small"
                value={abaKeywordCol}
                onChange={setAbaKeywordCol}
                style={{ width: 120 }}
                options={Array.from({ length: 20 }, (_, i) => ({ value: i, label: `第${i + 1}列` }))}
              />
              <span style={{ fontSize: 12, color: '#666' }}>报告中包含ABA排名:</span>
              <Select
                size="small"
                value={abaShowInReport ? 'yes' : 'no'}
                onChange={(v) => setAbaShowInReport(v === 'yes')}
                style={{ width: 80 }}
                options={[{ value: 'yes', label: '是' }, { value: 'no', label: '否' }]}
              />
            </Space>
          )}
          {abaRankMap.size > 0 && (
            <Space wrap size={4}>
              <Text type="secondary" style={{ fontSize: 11 }}>排名阶段颜色:</Text>
              {ABA_LEVELS.map(lv => (
                <Tag key={lv.label} color={lv.color} style={{ color: '#fff' }}>{lv.label} {lv.zh}</Tag>
              ))}
              <Tag color={ABA_NO_RANK_COLOR}>未上榜</Tag>
            </Space>
          )}
        </Space>
      </Card>
      {mergeLog.length > 0 && (
        <Card size="small" title="执行日志" style={{ marginBottom: 16 }}>
          <div
            style={{
              maxHeight: 200,
              overflow: 'auto',
              background: '#f6f8fa',
              padding: 12,
              borderRadius: 6,
              fontSize: 13,
              fontFamily: 'monospace',
            }}
          >
            {mergeLog.map((line, i) => (
              <div key={i} style={{ whiteSpace: 'pre-wrap' }}>{line}</div>
            ))}
            {merging && <Spin size="small" />}
          </div>
        </Card>
      )}

      {/* —— 匹配率反馈 —— */}
      {matchReport.length > 0 && (
        <Card size="small" title="追加列匹配率" style={{ marginBottom: 16 }}>
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {matchReport.map((m, i) => {
              const rate = m.total ? m.matched / m.total : 1;
              const color = rate >= 0.9 ? 'green' : rate >= 0.7 ? 'orange' : 'red';
              const label = rate >= 0.9 ? '良好' : rate >= 0.7 ? '偏低' : '异常';
              return (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text ellipsis style={{ maxWidth: 280 }}>{m.col}</Text>
                  <Space size={8}>
                    <Text type="secondary">{m.matched}/{m.total}</Text>
                    <Tag color={color}>{Math.round(rate * 100)}% · {label}</Tag>
                  </Space>
                </div>
              );
            })}
          </Space>
          {matchReport.some((m) => (m.total ? m.matched / m.total : 1) < 0.7) && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 8 }}
              message="存在匹配率偏低的追加列，可能是匹配列或天数配置有误，请检查后重新合并。"
            />
          )}
        </Card>
      )}

      {/* —— 全域自检：追加列数据真实性 —— */}
      {selfCheck && (
        <Card
          size="small"
          title="全域自检 · 追加列数据真实性"
          style={{ marginBottom: 16 }}
          extra={
            <Button size="small" onClick={runSelfCheck}>重新自检</Button>
          }
        >
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Alert
              type={selfCheck.status === 'error' ? 'error' : selfCheck.status === 'warn' ? 'warning' : 'success'}
              showIcon
              message={
                selfCheck.status === 'error'
                  ? '检出数据完整性异常，请核查标红列'
                  : selfCheck.status === 'warn'
                    ? '追加列存在较多未匹配（覆盖缺口），请确认匹配列配置'
                    : '追加列数据真实性校验通过'
              }
              description={
                <span>
                  真实性评分 <b>{(selfCheck.score * 100).toFixed(1)}%</b>（损坏格 {selfCheck.corruptedCells}/{selfCheck.totalCells}，未匹配格 {selfCheck.emptyCells}）
                </span>
              }
            />
            <Table
              size="small"
              pagination={false}
              dataSource={selfCheck.columns}
              columns={[
                { title: '追加列', dataIndex: 'col', key: 'col', ellipsis: true },
                { title: '空值(未匹配)', dataIndex: 'empty', key: 'empty', width: 110 },
                { title: '非数值', dataIndex: 'nonNumeric', key: 'nonNumeric', width: 90 },
                { title: '负值', dataIndex: 'negative', key: 'negative', width: 80 },
                { title: '异常大值', dataIndex: 'extreme', key: 'extreme', width: 90 },
                {
                  title: '判定',
                  key: 'status',
                  width: 90,
                  render: (_: any, r: any) => (
                    <Tag color={r.status === 'error' ? 'red' : r.status === 'warn' ? 'orange' : 'green'}>
                      {r.status === 'error' ? '异常' : r.status === 'warn' ? '警告' : '正常'}
                    </Tag>
                  ),
                },
              ]}
            />
          </Space>
        </Card>
      )}

      {/* —— 预览 —— */}
      {previewData && previewData.length > 0 && (
        <Card size="small" title={`预览 (${previewData.length - 1} 行 x ${previewData[0].length} 列)`}>
          <Table
            size="small"
            virtual
            rowKey="key"
            scroll={{ x: Math.min(previewData[0].length * 120, 3000), y: 560 }}
            pagination={false}
            columns={previewColumns}
            dataSource={previewDataSource}
          />
        </Card>
      )}

      {/* —— 判定预览（按推广类型分 Sheet + 等级筛选）—— */}
      {sheets.length > 0 && activeSheetData && (
        <Card size="small" title="判定预览 · 按推广类型分 Sheet（判定等级 / 命中规则 / 建议操作 / 追加列筛选）" style={{ marginBottom: 16 }}>
          <Space wrap style={{ marginBottom: 12, alignItems: 'center' }}>
            <Text>等级筛选：</Text>
            <Select
              value={filterLevel}
              onChange={(v) => setFilterLevel(v as '全部' | JudgeLevel)}
              style={{ width: 170 }}
              options={[
                { value: '全部', label: '全部' },
                { value: '极差', label: '极差·立即否定' },
                { value: '差', label: '差·降竞价' },
                { value: '较差', label: '较差·待观察' },
                { value: '正常', label: '正常' },
                { value: '数据不足', label: '数据不足' },
              ]}
            />
            <Text type="secondary">
              当前 Sheet：{CAMPAIGN_LABELS[activeSheetData.type]}（{activeSheetData.rows.length - 1} 行，筛选后 {sheetDataSource.length} 行）
            </Text>
          </Space>

          {/* —— 追加列数值筛选（可叠加多个条件，AND 生效）—— */}
          <div style={{ marginBottom: 12, padding: 12, background: '#fafafa', borderRadius: 6 }}>
            <Space wrap align="center">
              <Text strong>追加列筛选：</Text>
              <Select
                placeholder="选择列"
                value={draftCol ?? undefined}
                onChange={(v) => setDraftCol(v)}
                style={{ width: 190 }}
                showSearch
                optionFilterProp="label"
                options={metricCols.map((m) => ({ value: m.ci, label: m.h }))}
              />
              <Select
                value={draftOp}
                onChange={(v) => setDraftOp(v)}
                style={{ width: 90 }}
                options={[
                  { value: '>', label: '>' }, { value: '>=', label: '≥' },
                  { value: '<', label: '<' }, { value: '<=', label: '≤' },
                  { value: '=', label: '=' }, { value: 'between', label: '区间' },
                ]}
              />
              <InputNumber value={draftV1} onChange={(v) => setDraftV1(v)} placeholder="数值" style={{ width: 96 }} />
              {draftOp === 'between' && (
                <InputNumber value={draftV2} onChange={(v) => setDraftV2(v)} placeholder="至" style={{ width: 96 }} />
              )}
              <Button
                type="primary"
                size="small"
                disabled={draftCol == null || draftV1 == null || (draftOp === 'between' && draftV2 == null)}
                onClick={() => {
                  if (draftCol == null || draftV1 == null || !activeSheetData) return;
                  const headerRow = activeSheetData.rows[0];
                  setColFilters((prev) => [
                    ...prev,
                    {
                      id: `${Date.now()}_${Math.random()}`,
                      colIdx: draftCol,
                      colHeader: String(headerRow[draftCol] ?? ''),
                      op: draftOp,
                      v1: draftV1,
                      v2: draftOp === 'between' ? draftV2 ?? undefined : undefined,
                    },
                  ]);
                  setDraftV1(null);
                  setDraftV2(null);
                }}
              >添加条件</Button>
              {colFilters.length === 0 && <Text type="secondary">未添加条件（显示全部）</Text>}
            </Space>
            {colFilters.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <Space wrap>
                  <Text type="secondary">已生效（AND）：</Text>
                  {colFilters.map((f) => (
                    <Tag
                      key={f.id}
                      closable
                      color="blue"
                      onClose={() => setColFilters((prev) => prev.filter((x) => x.id !== f.id))}
                    >
                      {f.colHeader} {f.op === 'between' ? `∈ [${f.v1}, ${f.v2}]` : `${f.op} ${f.v1}`}
                    </Tag>
                  ))}
                  <Button type="link" size="small" danger onClick={() => setColFilters([])}>清空</Button>
                </Space>
              </div>
            )}
          </div>

          <Tabs
            activeKey={String(activeSheet)}
            onChange={(k) => { setActiveSheet(Number(k)); setFilterLevel('全部'); setColFilters([]); setDraftCol(null); setDraftV1(null); setDraftV2(null); }}
            destroyInactiveTabPane
            items={sheets.map((sh, i) => ({
              key: String(i),
              label: `${CAMPAIGN_LABELS[sh.type]} (${sh.rows.length - 1})`,
            }))}
          />

          <Space wrap style={{ marginBottom: 10 }}>
            {(['极差', '差', '较差', '正常', '数据不足'] as JudgeLevel[]).map((lv) => {
              const active = filterLevel === lv;
              return (
                <Tag.CheckableTag
                  key={lv}
                  checked={active}
                  onChange={(checked) => setFilterLevel(checked ? lv : '全部')}
                  style={{
                    padding: '2px 10px',
                    borderRadius: 4,
                    fontSize: 12,
                    fontWeight: active ? 700 : 400,
                    background: active ? (LEVEL_COLOR[lv] || '#BFBFBF') : 'transparent',
                    border: `1px solid ${LEVEL_COLOR[lv] || '#BFBFBF'}55`,
                    color: active ? '#fff' : (LEVEL_COLOR[lv] || '#BFBFBF'),
                  }}
                >
                  {LEVEL_DISPLAY[lv]}: {activeSheetData.counts[lv] ?? 0}
                </Tag.CheckableTag>
              );
            })}
            {filterLevel !== '全部' && (
              <Button type="link" size="small" onClick={() => setFilterLevel('全部')}>清除等级筛选</Button>
            )}
          </Space>

          <Table
            size="small"
            virtual
            rowKey="key"
            scroll={{ x: Math.min((activeSheetData.rows[0]?.length || 10) * 120, 3400), y: 560 }}
            pagination={false}
            columns={sheetColumns}
            dataSource={sheetDataSource}
          />
        </Card>
      )}
      {/* —— 新增预设弹窗 —— */}
      <Modal
        title="新增预设模板"
        open={addModalOpen}
        onOk={handleAddPreset}
        onCancel={() => setAddModalOpen(false)}
        okText="保存"
        cancelText="取消"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Text strong>模板名称:</Text>
            <Input
              value={newPresetName}
            onChange={e => setNewPresetName(e.target.value)}
            placeholder="如：搜索词报告"
            style={{ marginTop: 4 }}
          />
        </div>
        <div>
          <Text strong>匹配列（字母或数字，逗号分隔）:</Text>
          <Input
            value={newPresetCols}
            onChange={e => setNewPresetCols(e.target.value)}
            placeholder="如: E,G,K 或 4,6,10"
            style={{ marginTop: 4 }}
          />
        </div>
        <Alert
          type="info"
          message="预设会保存当前的匹配模式和列可选设置。可在预设列表中编辑/删除自定义预设。"
          style={{ marginTop: 4 }}
        />
      </div>
    </Modal>

    {/* —— 追加列编辑弹窗 —— */}
    <Modal
      title="编辑追加列"
      open={editModalOpen}
      onOk={handleEditAppendCol}
      onCancel={() => { setEditModalOpen(false); setEditIndex(null); setEditLabel(''); setEditColor(''); }}
      okText="保存"
      cancelText="取消"
    >
      {editIndex !== null && (() => {
        const ac = appendCols[editIndex];
        if (!ac) return null;
        const ext = reports.find((_, ri) => ri !== mainIdx);
        const headerName = ext?.data?.[0]?.[ac.colIdx];
        const finalName = `(${ext?.dayLabel ?? '?'}天)${editLabel || headerName || `col${ac.colIdx}(${colIndexToLetter(ac.colIdx)})`}`;
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <Text strong>列头标签（自定义名称）:</Text>
              <Input
                value={editLabel}
                onChange={e => setEditLabel(e.target.value)}
                placeholder="如 花费 / 点击（留空则用源列头名）"
                style={{ marginTop: 4 }}
              />
            </div>
            <div>
              <Text strong>显示格式:</Text>
              <Select
                style={{ width: 120, marginTop: 4 }}
                value={ac.displayFormat || 'value'}
                onChange={(v: 'value' | 'percent') => {
                  const next = [...appendCols];
                  next[editIndex] = { ...next[editIndex], displayFormat: v };
                  setAppendCols(next);
                }}
              >
                <Option value="value">数值</Option>
                <Option value="percent">百分比</Option>
              </Select>
            </div>
            <div>
              <Text strong>自定义颜色:</Text>
              <div style={{ marginTop: 4 }}>
                <PresetColorPicker value={editColor} onChange={setEditColor} onClear={() => setEditColor('')} />
                <Text type="secondary" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>留空则按天数自动着色</Text>
              </div>
            </div>
            <Alert type="info" message={`最终导出表头名 = ${finalName}`} />
          </div>
        );
      })()}
    </Modal>

    {/* —— 判定规则模板编辑弹窗 —— */}
    <Modal
      title={editingTpl ? (judgeTemplates.some((t) => t.id === editingTpl.id) ? '编辑判定模板' : '新增判定模板') : '新增判定模板'}
      open={judgeTplModalOpen}
      onCancel={() => { setJudgeTplModalOpen(false); setEditingTpl(null); }}
      onOk={handleSaveJudgeTpl}
      width={780}
      destroyOnClose
      okText="保存模板"
      cancelText="取消"
    >
      {editingTpl && (
        <div>
          <Row gutter={12} style={{ marginBottom: 12 }} align="middle">
            <Col flex="none"><Text strong>模板名称:</Text></Col>
            <Col flex="auto">
              <Input value={editingTpl.name} onChange={(e) => updateEditingTpl({ name: e.target.value })} placeholder="如：激进否定策略" />
            </Col>
            <Col flex="none"><Text strong>适用范围:</Text></Col>
            <Col flex="none">
              <Select
                value={editingTpl.campaignType}
                onChange={(v: any) => updateEditingTpl({ campaignType: v as CampaignType | 'all' })}
                style={{ width: 140 }}
                size="small"
                options={[
                  { value: 'all', label: '全部推广类型' },
                  { value: 'auto', label: '自动推广' },
                  { value: 'exact', label: '精确推广' },
                  { value: 'brand', label: '品牌推广' },
                ]}
              />
            </Col>
          </Row>
          <Alert type="info" showIcon style={{ marginBottom: 12 }}
            message="规则从上到下依次匹配，命中即停（越靠前越严重）。每条规则需满足全部条件(AND)。"
          />
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            {editingTpl.rules.map((rule, ri) => (
              <Card
                key={rule.id}
                size="small"
                title={
                  <Space>
                    <Text strong>规则 {ri + 1}</Text>
                    <Switch size="small" checked={rule.enabled} onChange={(v) => updateJudgeRule(rule.id, { enabled: v })} />
                    <Text type="secondary" style={{ fontSize: 12 }}>启用</Text>
                  </Space>
                }
                extra={<Button size="small" danger type="text" icon={<DeleteOutlined />} onClick={() => removeJudgeRule(rule.id)} />}
              >
                <Row gutter={8} style={{ marginBottom: 8 }} align="middle">
                  <Col flex="none"><Text>判定等级:</Text></Col>
                  <Col flex="none">
                    <Select value={rule.level} onChange={(v: any) => updateJudgeRule(rule.id, { level: v as JudgeLevel })} style={{ width: 160 }} size="small" options={JUDGE_LEVEL_OPTIONS} />
                  </Col>
                  <Col flex="none"><Text>建议操作:</Text></Col>
                  <Col flex="auto">
                    <Input size="small" value={rule.action} onChange={(e) => updateJudgeRule(rule.id, { action: e.target.value })} placeholder="如：立即否定" />
                  </Col>
                </Row>
                <Row gutter={8} style={{ marginBottom: 8 }} align="middle">
                  <Col flex="none"><Text>命中规则:</Text></Col>
                  <Col flex="auto">
                    <Input size="small" value={rule.desc} onChange={(e) => updateJudgeRule(rule.id, { desc: e.target.value })} placeholder="展示在判定列的说明文本" />
                  </Col>
                </Row>
                <Divider style={{ margin: '4px 0' }} titlePlacement="left" plain>条件（全部满足）</Divider>
                {rule.conditions.length === 0 && (
                  <Text type="secondary" style={{ fontSize: 12 }}>暂无条件（保存后该规则不会命中，请添加条件）</Text>
                )}
                {rule.conditions.map((cond) => (
                  <Row key={cond.id} gutter={6} style={{ marginBottom: 4 }} align="middle">
                    <Col>
                      <Select
                        value={cond.target ?? 'metric'}
                        onChange={(v: any) => updateJudgeCondition(rule.id, cond.id, { target: v })}
                        style={{ width: 100 }}
                        size="small"
                        options={[
                          { value: 'metric', label: '固定指标' },
                          { value: 'appendCol', label: '追加列' },
                        ]}
                      />
                    </Col>
                    <Col>
                      {cond.target === 'appendCol' ? (
                        <Select
                          value={cond.appendColKey ?? undefined}
                          onChange={(v: any) => updateJudgeCondition(rule.id, cond.id, { appendColKey: v, metric: undefined })}
                          style={{ width: 150 }}
                          size="small"
                          placeholder="选择追加列"
                          showSearch
                          optionFilterProp="label"
                          options={appendColOptions}
                        />
                      ) : (
                        <Select
                          value={cond.metric}
                          onChange={(v: any) => updateJudgeCondition(rule.id, cond.id, { metric: v as JudgeMetric, appendColKey: undefined })}
                          style={{ width: 150 }}
                          size="small"
                          options={Object.keys(METRIC_LABELS).map((k) => ({ value: k, label: METRIC_LABELS[k as JudgeMetric] }))}
                        />
                      )}
                    </Col>
                    <Col>
                      <Select
                        value={cond.op}
                        onChange={(v: any) => updateJudgeCondition(rule.id, cond.id, { op: v as JudgeOp })}
                        style={{ width: 132 }}
                        size="small"
                        options={JUDGE_OP_OPTIONS}
                      />
                    </Col>
                    <Col>
                      <InputNumber size="small" value={cond.value} onChange={(v: any) => updateJudgeCondition(rule.id, cond.id, { value: Number(v) || 0 })} style={{ width: 96 }} />
                    </Col>
                    <Col>
                      <Button size="small" type="text" danger icon={<CloseOutlined />} onClick={() => removeJudgeCondition(rule.id, cond.id)} />
                    </Col>
                  </Row>
                ))}
                <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>
                  提示：「追加列」优先精确匹配合并后表头的带天前缀列（如选 "(15天)ROAS" 即只比对 15 天 ROAS，可区分不同天的同名列）；下拉也提供去前缀的 "ROAS"/"花费" 等模糊项（命中首个匹配列）。缺失值视为不命中，不会误判。
                </div>
                <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => addJudgeCondition(rule.id)}>添加条件</Button>
              </Card>
            ))}
          </Space>
          <Button type="dashed" block icon={<PlusOutlined />} style={{ marginTop: 12 }} onClick={addJudgeRule}>添加规则</Button>
        </div>
      )}
    </Modal>

    </div>
  );};

export default RoasMerge;
