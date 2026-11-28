/**
 * 否词工具 — 亚马逊广告搜索词否词分类（完整版）
 * 后端：Python EXE (neg_keyword_tool.exe --serve) 提供本地 HTTP API
 * 功能：搜索词分类 + 规则编辑 + Campaign映射 + 机型否词库 + 别名规则 + 操作日志
 */
import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { downloadBlob, exportWorkbook, exportToExcel } from './shims/exportUtils';
import * as XLSX from 'xlsx-js-style';
import {
  message, Table, Button, Select, Input, Tag, Space, Progress,
  Tooltip, Typography, Divider, Card, Statistic, Row, Col,
  Dropdown, Popconfirm, Empty, Flex,
  Tabs, Modal, Switch, Checkbox, Drawer, Badge, Alert,
} from 'antd';
import {
  UploadOutlined, ReloadOutlined, EditOutlined,
  SearchOutlined, DownloadOutlined, FileExcelOutlined, ThunderboltOutlined,
  CheckCircleOutlined, CloseCircleOutlined,
  PlusOutlined, DeleteOutlined, SaveOutlined, ImportOutlined, ExportOutlined, SyncOutlined,
  TableOutlined, FolderOpenOutlined, LinkOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { resolveModelCode } from './shims/modelUtils';
import { useNavigate, useStore, type StoreInfo, db } from './shims/erpShims';
import {
  AMAZON_NEGATIVE_UPLOAD_HEADERS,
  buildAmazonNegativeTemplateRows,
  resolveNegativeKeyword,
  type AmazonNegativeMatchMode,
  type AmazonNegativeScope,
  type AmazonNegativeUploadRow,
  type NegativeModelGroup,
} from './amazonNegativeTemplate';
import {
  AMAZON_NEGATIVE_ASIN_UPLOAD_HEADERS,
  buildAmazonNegativeAsinTemplateRows,
  normalizeAsin,
  normalizeAsinDecision,
  type AsinDecision,
  type AmazonNegativeAsinUploadRow,
  type NegativeAsinSourceRow,
} from './amazonNegativeAsinTemplate';
import {
  buildCampaignIdMappings,
  mergeCampaignIdMappings,
  normalizeCampaignName,
  resolveCampaignId,
  type CampaignIdMappingRecord,
} from './campaignIdMapping';
import {
  detectMarketplaceFromText,
  inferAsinColumn,
  inferAsinImportScope,
} from './asinImport';

import PageHeader from './shims/PageHeader';

import { StopOutlined } from '@ant-design/icons';
const { Text } = Typography;
const { TextArea } = Input;
const { Option } = Select;

// ============ 后端配置 ============
// 一体化模式：所有API由Vite中间件直接处理
const SERVER_URL = 'http://127.0.0.1:19876';

// ============ 后端 API ============

interface ClassifyResult {
  tag: 'deny' | 'keep' | 'review';
  reason: string;
  rowModel: string | null;
  targetGroupName: string | null;
}

interface ModelGroup {
  name: string;
  keywords: string[];
  enabled: boolean;
}

interface AliasRule {
  name: string;
  trigger_word: string;
  target_model: string;
  enabled?: boolean;
}

interface DenyLibEntry {
  name: string;
  keywords: string[];
  linked_models?: string[];
}

interface OperationLog {
  timestamp: string;
  action: string;
  detail?: string;
}

async function apiFetch(path: string, options?: RequestInit & { timeoutMs?: number }) {
  if (typeof window !== 'undefined' && typeof (window as any).__MCP_API_FETCH__ === 'function') {
    return (window as any).__MCP_API_FETCH__(path, options);
  }
  const timeoutMs = options?.timeoutMs ?? 120000;
  const { timeoutMs: _, ...restOptions } = options ?? {} as any;
  const resp = await fetch(`${SERVER_URL}${path}`, {
    ...restOptions,
    headers: { 'Content-Type': 'application/json', ...restOptions?.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`API ${resp.status}: ${err}`);
  }
  return resp.json();
}

// ============ 数据类型 ============

interface KeywordRow {
  key: string;
  index: number;
  searchTerm: string;
  campaign: string;
  /** 页面展示/分类使用的列；与 Campaign ID 的匹配列分离。 */
  campaignIdMatchName?: string;
  campaignId?: string;
  /** 导入时使用的店铺作用域；导出其它店铺时不能复用此 ID。 */
  campaignIdScope?: string;
  campaignIdAmbiguous?: boolean;
  adGroup?: string;
  model: string;
  searchVolume: string;
  tag: 'deny' | 'keep' | 'review';
  tagLabel: string;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  mappedGroup?: string;
  manualOverride?: boolean;
  rawRow?: Record<string, unknown>;
}

interface FilterState {
  tag: '' | 'deny' | 'keep' | 'review';
  searchTerm: string;
  campaign: string;
}

interface ImportColumnMapping {
  termCol: string;
  /** 页面表格展示的广告活动/机型列。 */
  campaignCol: string;
  /** 用于通过活动名称匹配持久化 Campaign ID 的列。 */
  campaignIdMatchCol: string;
  campaignIdCol?: string;
  adGroupCol?: string;
  scope: AmazonNegativeScope;
}

interface AsinImportColumnMapping {
  asinCol: string;
  resultCol: string;
  /** 活动名称列，用于展示和 Campaign ID 匹配。 */
  campaignCol: string;
  campaignIdMatchCol: string;
  campaignIdCol?: string;
  /** 广告组名称/标识列；允许用户从这一列选一个固定广告组。 */
  adGroupCol: string;
  /** 如果源文件有真实 Ad Group ID，可直接选择这一列。 */
  adGroupIdCol?: string;
  /** 空值表示每行使用 adGroupCol；否则把选定广告组应用到全部行。 */
  selectedAdGroupValue?: string;
  reasonCol?: string;
  scope: AmazonNegativeScope;
  storeId: string;
  marketplace: string;
}

interface PendingKeywordImport {
  fileName: string;
  rows: Record<string, unknown>[];
  headers: string[];
  mapping: ImportColumnMapping;
}

interface PendingAsinImport {
  fileName: string;
  rows: Record<string, unknown>[];
  headers: string[];
  mapping: AsinImportColumnMapping;
}

interface AsinRow {
  key: string;
  index: number;
  asin: string;
  decision: AsinDecision;
  decisionLabel: string;
  campaignName: string;
  campaignId: string;
  adGroupName: string;
  adGroupId: string;
  reason: string;
  scope: string;
  title?: string;
  verifySource?: string;
  verifyDate?: string;
  targetModel?: string;
  rawRow?: Record<string, unknown>;
}

// ============ 竞品品牌/非目标机型/壳类词编辑组件 ============

const TextListEditor: React.FC<{
  title: string;
  items: string[];
  onChange: (items: string[]) => Promise<void> | void;
  hint?: string;
}> = ({ title, items, onChange, hint }) => {
  const [text, setText] = useState(items.join('\n'));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

   
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText(items.join('\n'));
    setDirty(false);
  }, [items]);

  const handleSave = useCallback(async () => {
    if (saving) return;
    const list = text.split('\n').map(l => l.trim().toLowerCase()).filter(Boolean);
    setSaving(true);
    try {
      await onChange(list);
      setDirty(false);
    } catch {
      // onChange 内部已处理错误提示
    } finally {
      setSaving(false);
    }
  }, [text, saving, onChange]);

  return (
    <div>
      {hint && <Text type="secondary" style={{ fontSize: 12, marginBottom: 8, display: 'block' }}>{hint}</Text>}
      <TextArea
        value={text}
        onChange={e => { setText(e.target.value); setDirty(true); }}
        rows={16}
        style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}
        placeholder={`每行一个${title}关键词（小写）`}
      />
      <Flex justify="space-between" align="center" style={{ marginTop: 8 }}>
        <Text type="secondary" style={{ fontSize: 11 }}>
          共 {text.split('\n').filter(l => l.trim()).length} 条
          {dirty && <Text type="warning"> (未保存)</Text>}
        </Text>
        <Button
          size="small"
          type="primary"
          icon={<SaveOutlined />}
          disabled={!dirty}
          loading={saving}
          onClick={handleSave}
        >
          保存
        </Button>
      </Flex>
    </div>
  );
};

// ============ Campaign映射管理组件 ============

const CampaignMapEditor: React.FC = () => {
  const [mapData, setMapData] = useState<Record<string, string>>({});
  const [modelGroupNames, setModelGroupNames] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [addVisible, setAddVisible] = useState(false);
  const [newCampaign, setNewCampaign] = useState('');
  const [newGroup, setNewGroup] = useState('');
  const [searchText, setSearchText] = useState('');

  // Load model group names for validation
  const loadModelGroups = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/model-groups`);
      const groups = data.groups ?? [];
      const names = new Set<string>((Array.isArray(groups) ? groups : []).map((g: any) => (g.name ?? '').trim().toLowerCase()));
      setModelGroupNames(names);
    } catch { /* silently fail */ }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadModelGroups(); }, [loadModelGroups]);

  const loadMap = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch('/api/campaign-map');
      setMapData(data.map || data);
    } catch (err) {
      message.error(`加载映射失败: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadMap(); }, [loadMap]);

  const saveMap = useCallback(async (newMap: Record<string, string>) => {
    try {
      await apiFetch('/api/campaign-map', {
        method: 'POST',
        body: JSON.stringify({ map: newMap }),
      });
      setMapData(newMap);
      message.success(`映射已保存 (${Object.keys(newMap).length} 条)`);
    } catch (err) {
      message.error(`保存失败: ${(err as Error).message}`);
    }
  }, []);

  const handleAdd = () => {
    if (!newCampaign.trim() || !newGroup.trim()) return;
    const updated = { ...mapData, [newCampaign.trim()]: newGroup.trim() };
    saveMap(updated);
    setNewCampaign('');
    setNewGroup('');
    setAddVisible(false);
  };

  const handleDelete = (campaign: string) => {
    const updated = { ...mapData };
    delete updated[campaign];
    saveMap(updated);
  };

  // 导出Campaign映射到Excel
  const handleExportMap = useCallback(() => {
    if (Object.keys(mapData).length === 0) {
      message.warning('没有映射数据可导出');
      return;
    }
    try {
      const rows = Object.entries(mapData).map(([campaign, group]) => ({
        'Campaign Name': campaign,
        '机型组': group,
        '映射有效': modelGroupNames.has(group.trim().toLowerCase()) ? '是' : '否',
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Campaign映射');
      void exportWorkbook({ wb, fileName: `Campaign映射_${new Date().toISOString().slice(0, 10)}`, cellStyles: true });
      message.success(`导出 ${rows.length} 条映射`);
    } catch (err) {
      message.error(`导出失败: ${(err as Error).message}`);
    }
  }, [mapData]);

  // 从Excel导入Campaign映射
  const handleImportMap = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls,.csv';
    input.onchange = async (e: any) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const data = await file.arrayBuffer();
        const wb = XLSX.read(data);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws);
        if (rows.length === 0) {
          message.warning('文件为空');
          return;
        }
        // 支持多种列名: Campaign Name/Campaign/活动名 + 机型组/Model Group/组名
        const getKey = (row: Record<string, string>) =>
          row['Campaign Name'] || row['Campaign'] || row['活动名'] || row['campaign'] || '';
        const getValue = (row: Record<string, string>) =>
          row['机型组'] || row['Model Group'] || row['组名'] || row['group'] || row['model_group'] || '';

        const imported: Record<string, string> = {};
        let skipped = 0;
        for (const row of rows) {
          const k = getKey(row).trim();
          const v = getValue(row).trim();
          if (k && v) imported[k] = v;
          else skipped++;
        }
        // 合并：新导入覆盖同名旧映射
        const merged = { ...mapData, ...imported };
        await saveMap(merged);
        message.success(`导入 ${Object.keys(imported).length} 条映射${skipped ? `，跳过 ${skipped} 行` : ''}`);
      } catch (err) {
        message.error(`导入失败: ${(err as Error).message}`);
      }
    };
    input.click();
  }, [mapData, saveMap]);

  const filteredEntries = useMemo(() => {
    return Object.entries(mapData)
      .filter(([k, v]) => !searchText || k.toLowerCase().includes(searchText.toLowerCase()) || v.toLowerCase().includes(searchText.toLowerCase()))
      .sort((a, b) => a[0].localeCompare(b[0]));
  }, [mapData, searchText]);

  const columns: ColumnsType<{ key: string; campaign: string; group: string; valid: boolean }> = [
    { title: '#', width: 50, render: (_, __, i) => i + 1 },
    { title: 'Campaign Name', dataIndex: 'campaign', sorter: (a: any, b: any) => String(a.campaign ?? '').localeCompare(String(b.campaign ?? '')), width: 280, ellipsis: true },
    { title: '机型组', dataIndex: 'group', sorter: (a: any, b: any) => String(a.group ?? '').localeCompare(String(b.group ?? '')), width: 220, ellipsis: true, render: (t: string) => <Tag color="purple">{t}</Tag> },
    {
      title: '映射状态', dataIndex: 'valid', width: 100, align: 'center',
      sorter: (a: any, b: any) => (a.valid ? 1 : 0) - (b.valid ? 1 : 0),
      render: (valid: boolean, record: { group: string }) => valid
        ? <Tag color="success" icon={<CheckCircleOutlined />}>有效</Tag>
        : <Tooltip title={`机型组 "${record.group}" 在当前站点配置中不存在`}>
            <Tag color="error" icon={<CloseCircleOutlined />} style={{ cursor: 'help' }}>无效</Tag>
          </Tooltip>,
    },
    {
      title: '操作', width: 80, render: (_, record) => (
        <Popconfirm title={`删除 "${record.campaign}" 的映射？`} onConfirm={() => handleDelete(record.campaign)}>
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      <Flex gap={8} wrap="wrap" style={{ marginBottom: 12 }} align="center">
        <Input
          placeholder="搜索Campaign或机型组..."
          prefix={<SearchOutlined />}
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          style={{ width: 280 }}
          size="small"
          allowClear
        />
        <Button size="small" icon={<PlusOutlined />} type="primary" onClick={() => setAddVisible(true)}>
          添加映射
        </Button>
        <Button size="small" icon={<ImportOutlined />} onClick={handleImportMap}>从Excel导入</Button>
        <Button size="small" icon={<ExportOutlined />} onClick={handleExportMap}>导出Excel</Button>
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => { loadMap(); loadModelGroups(); }}>
          刷新
        </Button>
        <Text type="secondary" style={{ fontSize: 11 }}>共 {Object.keys(mapData).length} 条映射，有效 {filteredEntries.filter(([, v]) => modelGroupNames.has(v.trim().toLowerCase())).length}</Text>
      </Flex>

      <Table
        columns={columns}
        dataSource={filteredEntries.map(([k, v]) => ({ key: k, campaign: k, group: v, valid: modelGroupNames.has(v.trim().toLowerCase()) }))}
        size="small"
        pagination={{ pageSize: 100, showTotal: t => `${t} 条` }}
        scroll={{ y: 500 }}
        loading={loading}
      />

      <Modal
        title="添加Campaign映射"
        open={addVisible}
        onOk={handleAdd}
        onCancel={() => setAddVisible(false)}
        okText="添加"
        width={500}
      >
        <Flex vertical gap={12}>
          <div>
            <Text strong>Campaign Name</Text>
            <Input value={newCampaign} onChange={e => setNewCampaign(e.target.value)} placeholder="如: SP-iPhone 15 Pro Max-..." style={{ marginTop: 4 }} />
          </div>
          <div>
            <Text strong>机型组名称</Text>
            <Input value={newGroup} onChange={e => setNewGroup(e.target.value)} placeholder="如: iPhone 15 Pro Max" style={{ marginTop: 4 }} />
          </div>
        </Flex>
      </Modal>
    </div>
  );
};

// ============ Campaign ID 映射管理组件 ============

const CAMPAIGN_ID_MARKETPLACES = [
  'US', 'CA', 'MX', 'UK', 'DE', 'FR', 'IT', 'ES', 'NL', 'SE', 'PL', 'BE', 'IE', 'AT',
  'JP', 'AU', 'SG', 'AE', 'SA', 'IN', 'TR',
];

interface CampaignIdScopeOption {
  scope: string;
  storeId: string;
  storeName: string;
  marketplace: string;
}

function normalizeCampaignScope(value: unknown): string {
  return String(value ?? '').replace(/\u00a0/g, ' ').trim().toUpperCase();
}

function campaignIdScopeKey(storeId: unknown, marketplace: unknown): string {
  const store = normalizeCampaignScope(storeId);
  const site = normalizeCampaignScope(marketplace);
  return store && site ? `${store}::${site}` : store || site || 'US';
}

function parseCampaignIdScope(scope: unknown): { storeId: string; marketplace?: string } {
  const value = normalizeCampaignScope(scope);
  const separator = value.indexOf('::');
  if (separator < 0) return { storeId: value };
  return {
    storeId: value.slice(0, separator),
    marketplace: value.slice(separator + 2) || undefined,
  };
}

function detectMarketplaceFromFileName(fileName: string, fallback: string): string {
  return detectMarketplaceFromText(fileName, normalizeCampaignScope(fallback) || 'US');
}

function buildCampaignIdScopeOptions(
  stores: StoreInfo[],
  mappings: CampaignIdMappingRecord[],
  activeStoreId?: string,
): CampaignIdScopeOption[] {
  const validStores = stores.filter(store => store && String(store.id || '').trim());
  const byId = new Map(validStores.map(store => [normalizeCampaignScope(store.id), store]));
  const options = new Map<string, CampaignIdScopeOption>();
  const add = (storeId: string, storeName: string, marketplace: string) => {
    const normalizedStoreId = normalizeCampaignScope(storeId);
    const normalizedMarketplace = normalizeCampaignScope(marketplace);
    if (!normalizedStoreId || !normalizedMarketplace) return;
    const scope = campaignIdScopeKey(normalizedStoreId, normalizedMarketplace);
    options.set(scope, { scope, storeId: normalizedStoreId, storeName, marketplace: normalizedMarketplace });
  };

  for (const record of mappings) {
    const parsed = parseCampaignIdScope(record.storeMarketplace);
    const store = byId.get(parsed.storeId);
    if (store && parsed.marketplace) add(store.id, store.storeName || store.id, parsed.marketplace);
    else if (store) add(store.id, store.storeName || store.id, store.marketplace || 'US');
    else if (parsed.storeId && parsed.marketplace) add(parsed.storeId, parsed.storeId, parsed.marketplace);
  }

  if (options.size === 0) {
    for (const store of validStores) {
      add(store.id, store.storeName || store.id, store.marketplace || 'US');
    }
  }

  return Array.from(options.values()).sort((a, b) => (
    a.storeName.localeCompare(b.storeName) || a.marketplace.localeCompare(b.marketplace)
  ));
}

function campaignIdScopeLabel(option?: CampaignIdScopeOption): string {
  return option ? `${option.storeName}（${option.marketplace}）` : '未选择店铺/站点';
}

function campaignIdScopeAliases(
  option: CampaignIdScopeOption | undefined,
  scopeOptions: CampaignIdScopeOption[],
): string[] {
  if (!option) return [];
  const aliases = [option.scope, option.storeId];
  // 仅当该站点代码没有对应多个店铺时，才兼容旧版只保存 DE/UK 的记录，
  // 防止 US 多店铺之间因为历史数据缺少店铺 ID 而串用映射。
  const sameMarketplaceCount = scopeOptions.filter(item => item.marketplace === option.marketplace).length;
  if (sameMarketplaceCount <= 1) aliases.push(option.marketplace);
  return aliases;
}

function normalizeLegacyCampaignIdMappings(
  mappings: CampaignIdMappingRecord[],
  stores: StoreInfo[],
): CampaignIdMappingRecord[] {
  const validStores = stores.filter(store => store && String(store.id || '').trim());
  if (validStores.length === 0) return mappings;
  return mappings.map(record => {
    const parsed = parseCampaignIdScope(record.storeMarketplace);
    if (parsed.marketplace) return record;
    const store = validStores.find(item => normalizeCampaignScope(item.id) === parsed.storeId);
    if (!store) return record;

    // 旧版本的 sourceFile 通常保留了“SUANDUCK DE/FR/UK”文件名，
    // 可安全把旧的单店铺作用域迁移为真正的店铺+站点作用域。
    const sourceText = `${record.sourceFile || ''} ${store.storeName || ''}`.toUpperCase();
    const inferredMarketplace = CAMPAIGN_ID_MARKETPLACES.find(site => (
      new RegExp(`(?:^|[\\s_\\-])${site}(?:$|[\\s_\\-\\.])`, 'i').test(sourceText)
    ));
    const marketplace = inferredMarketplace || normalizeCampaignScope(store.marketplace || 'US');
    return { ...record, storeMarketplace: campaignIdScopeKey(store.id, marketplace) };
  });
}

const CAMPAIGN_ID_MAPPINGS_STORAGE_KEY = 'erp_campaign_id_mappings_v2';

function readLocalCampaignIdMappings(): CampaignIdMappingRecord[] {
  try {
    const raw = localStorage.getItem(CAMPAIGN_ID_MAPPINGS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

function writeLocalCampaignIdMappings(mappings: CampaignIdMappingRecord[]): void {
  try {
    localStorage.setItem(CAMPAIGN_ID_MAPPINGS_STORAGE_KEY, JSON.stringify(mappings));
  } catch {
    // localStorage 空间不足时仍由后端规则文件保存，不阻断导入。
  }
}

interface PendingCampaignIdImport {
  fileName: string;
  rows: Record<string, unknown>[];
  headers: string[];
  campaignNameColumn: string;
  campaignIdColumn: string;
  storeId: string;
  marketplace: string;
}

const CampaignIdMapEditor: React.FC<{
  mappings: CampaignIdMappingRecord[];
  stores: StoreInfo[];
  activeStoreKey: string;
  activeStoreLabel: string;
  onSave: (mappings: CampaignIdMappingRecord[]) => Promise<void>;
}> = ({ mappings, stores, activeStoreKey, activeStoreLabel, onSave }) => {
  const [searchText, setSearchText] = useState('');
  const [pendingImport, setPendingImport] = useState<PendingCampaignIdImport | null>(null);
  const [importConfirming, setImportConfirming] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentStore = normalizeCampaignScope(activeStoreKey || 'US');
  const storeOptions = useMemo(() => {
    const validStores = stores.filter(store => store && String(store.id || '').trim());
    if (validStores.length > 0) return validStores;
    return [{
      id: currentStore,
      storeName: activeStoreLabel || currentStore,
      marketplace: activeStoreKey || currentStore,
    } as StoreInfo];
  }, [activeStoreKey, activeStoreLabel, currentStore, stores]);
  const currentStoreInfo = storeOptions.find(store => normalizeCampaignScope(store.id) === currentStore);
  const defaultScope = campaignIdScopeKey(currentStore, currentStoreInfo?.marketplace || 'US');
  const scopeOptions = useMemo(
    () => buildCampaignIdScopeOptions(storeOptions, mappings, currentStore),
    [currentStore, mappings, storeOptions],
  );
  const [selectedStoreScope, setSelectedStoreScope] = useState(defaultScope);

  // 切换 ERP 顶部店铺时，默认切换到对应的“店铺 + 站点”作用域。
  useEffect(() => {
    setSelectedStoreScope(defaultScope);
  }, [defaultScope]);

  const selectedScopeOption = scopeOptions.find(option => option.scope === selectedStoreScope)
    || scopeOptions.find(option => option.scope === defaultScope)
    || scopeOptions[0];
  const selectedScopeAliases = campaignIdScopeAliases(selectedScopeOption, scopeOptions);
  const currentMappings = useMemo(() => mappings
    .filter(record => selectedScopeAliases.includes(normalizeCampaignScope(record.storeMarketplace)))
    .filter(record => {
      const query = searchText.trim().toLocaleLowerCase();
      return !query
        || record.campaignName.toLocaleLowerCase().includes(query)
        || record.campaignId.toLocaleLowerCase().includes(query);
    }), [mappings, searchText, selectedScopeAliases]);

  const handleImport = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = async event => {
      try {
        const raw = event.target?.result;
        if (!raw) return;
        // raw:false 让长 ID 按 Excel 显示文本读取，避免 JS 数值精度损失；CSV 需先按 UTF-8 / GB18030 解码防止中文表头乱码。
        let workbook: XLSX.WorkBook;
        if (file.name.toLowerCase().endsWith('.csv') && raw instanceof ArrayBuffer) {
          const utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(raw);
          const csvText = utf8Text.includes('\ufffd') ? new TextDecoder('gb18030').decode(raw) : utf8Text;
          workbook = XLSX.read(csvText, { type: 'string', cellText: true, cellDates: false });
        } else {
          workbook = XLSX.read(raw, { type: 'array', cellText: true, cellDates: false });
        }
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
        if (rows.length === 0) {
          message.warning('Campaign ID 文件为空');
          return;
        }
        const headers = Object.keys(rows[0]);
        const findColumn = (patterns: RegExp[], fallback?: (header: string) => boolean) =>
          headers.find(header => patterns.some(pattern => pattern.test(header)))
          || (fallback ? headers.find(fallback) : undefined);
        const campaignNameColumn = findColumn([
          /^广告活动名称$/i,
          /^广告组合名称$/i,
          /^广告活动$/i,
          /^广告组合$/i,
          /^campaign\s*name$/i,
          /^campaign$/i,
          /^portfolio\s*name$/i,
        ], header => /campaign|portfolio|广告活动|广告组合/i.test(header) && !/id|编号/i.test(header));
        const campaignIdColumn = findColumn([
          /^campaign\s*id$/i,
          /^campaignid$/i,
          /^广告活动编号$/i,
          /^广告组合编号$/i,
          /广告活动\s*(?:ID|Id|id)/i,
          /广告组合\s*(?:ID|Id|id)/i,
          /活动编号|组合编号/i,
        ], header => /id|编号/i.test(header));
        if (!campaignNameColumn || !campaignIdColumn) {
          message.error('未识别到“广告活动名称/广告组合名称”和“Campaign ID”两列，请检查表头');
          return;
        }
        const importStoreId = selectedScopeOption?.storeId || currentStore;
        const importMarketplace = detectMarketplaceFromFileName(
          file.name,
          selectedScopeOption?.marketplace || currentStoreInfo?.marketplace || 'US',
        );
        setPendingImport({
          fileName: file.name,
          rows,
          headers,
          campaignNameColumn,
          campaignIdColumn,
          storeId: importStoreId,
          marketplace: importMarketplace,
        });
        message.info(`已读取 ${rows.length} 行，文件名已识别站点 ${importMarketplace}，请确认店铺/站点与映射列`);
      } catch (error) {
        message.error(`读取 Campaign ID 文件失败: ${(error as Error).message}`);
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
    reader.readAsArrayBuffer(file);
  }, [currentStore, currentStoreInfo?.marketplace, selectedScopeOption]);

  const handleConfirmImport = useCallback(async () => {
    if (!pendingImport) return;
    if (pendingImport.campaignNameColumn === pendingImport.campaignIdColumn) {
      message.warning('广告活动名称列和 Campaign ID 列不能相同');
      return;
    }
    const marketplace = normalizeCampaignScope(pendingImport.marketplace).replace(/::+/g, '-');
    if (!marketplace) {
      message.warning('请填写站点名称，例如 DE、UK，或自定义站点名称');
      return;
    }
    setImportConfirming(true);
    try {
      const importScope = campaignIdScopeKey(pendingImport.storeId, marketplace);
      const summary = buildCampaignIdMappings(
        pendingImport.rows,
        pendingImport.campaignNameColumn,
        pendingImport.campaignIdColumn,
        importScope,
        pendingImport.fileName,
      );
      if (summary.records.length === 0) {
        message.warning('没有读到有效的活动名称与 Campaign ID，请检查列选择');
        return;
      }
      await onSave(mergeCampaignIdMappings(mappings, summary.records));
      setSelectedStoreScope(importScope);
      setPendingImport(null);
      const notes = [
        `已导入 ${summary.importedRows} 条活动映射`,
        `所属店铺/站点：${campaignIdScopeLabel(scopeOptions.find(option => option.scope === importScope) || {
          scope: importScope,
          storeId: pendingImport.storeId,
          storeName: storeOptions.find(store => normalizeCampaignScope(store.id) === normalizeCampaignScope(pendingImport.storeId))?.storeName || pendingImport.storeId,
          marketplace,
        })}`,
        summary.skippedRows ? `跳过空值 ${summary.skippedRows} 行` : '',
        summary.duplicateRows ? `去重 ${summary.duplicateRows} 行` : '',
        summary.conflictRows ? `冲突 ${summary.conflictRows} 条（不会自动回填）` : '',
      ].filter(Boolean);
      message.success(notes.join('；'));
    } catch (error) {
      message.error(`保存 Campaign ID 映射失败: ${(error as Error).message}`);
    } finally {
      setImportConfirming(false);
    }
  }, [mappings, onSave, pendingImport, scopeOptions, storeOptions]);

  const handleDeleteScopeMappings = useCallback(async () => {
    const scopeAliases = new Set(campaignIdScopeAliases(selectedScopeOption, scopeOptions));
    const remaining = mappings.filter(
      record => !scopeAliases.has(normalizeCampaignScope(record.storeMarketplace))
    );
    const removedCount = mappings.length - remaining.length;
    if (removedCount === 0) {
      message.info('当前站点映射已为空');
      return;
    }
    try {
      await onSave(remaining);
      message.success(`已删除「${campaignIdScopeLabel(selectedScopeOption)}」的 ${removedCount} 条映射记录`);
    } catch (error) {
      message.error(`删除映射失败: ${(error as Error).message}`);
    }
  }, [mappings, onSave, scopeOptions, selectedScopeOption]);

  const handleDeleteSingleMapping = useCallback(async (target: CampaignIdMappingRecord) => {
    const targetScope = normalizeCampaignScope(target.storeMarketplace);
    const targetName = normalizeCampaignName(target.campaignName);
    const remaining = mappings.filter(
      record => !(
        normalizeCampaignScope(record.storeMarketplace) === targetScope
        && normalizeCampaignName(record.campaignName) === targetName
      )
    );
    try {
      await onSave(remaining);
      message.success(`已删除「${target.campaignName}」`);
    } catch (error) {
      message.error(`删除失败: ${(error as Error).message}`);
    }
  }, [mappings, onSave]);

  const columns: ColumnsType<CampaignIdMappingRecord> = [
    { title: '#', width: 55, render: (_, __, index) => index + 1 },
    {
      title: '广告活动名称', dataIndex: 'campaignName', width: 340, ellipsis: true,
      render: (value: string) => <Tooltip title={value}><Text>{value}</Text></Tooltip>,
    },
    {
      title: 'Campaign ID', dataIndex: 'campaignId', width: 220,
      render: (value: string, record) => record.ambiguous
        ? <Tooltip title={`发现多个 ID：${(record.conflictIds || []).join('、')}`}><Tag color="error">冲突，未回填</Tag></Tooltip>
        : value ? <Text code copyable={{ text: value }}>{value}</Text> : <Tag color="warning">缺少 ID</Tag>,
    },
    { title: '来源文件', dataIndex: 'sourceFile', width: 240, ellipsis: true, render: value => <Text type="secondary">{value || '—'}</Text> },
    { title: '更新时间', dataIndex: 'updatedAt', width: 160, render: value => <Text type="secondary">{value ? new Date(value).toLocaleString() : '—'}</Text> },
    {
      title: '操作',
      key: 'action',
      width: 80,
      fixed: 'right',
      render: (_, record) => (
        <Popconfirm
          title={`确定删除「${record.campaignName}」的映射？`}
          onConfirm={() => { void handleDeleteSingleMapping(record); }}
          okText="删除"
          cancelText="取消"
        >
          <Button type="link" size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      <Alert
        type="info"
        showIcon
        message="导入 Campaign ID 映射后，导出 Amazon 否词后台模板会按当前店铺和广告活动名称自动填写 Campaign ID。"
        description="匹配采用“店铺站点 + 活动名称（忽略大小写与多余空格）”；导入时站点名称可直接输入自定义值；同名活动出现多个 ID 时会标记冲突并留空，避免把否词写入错误活动。"
        style={{ marginBottom: 12 }}
      />
      <Flex gap={8} wrap="wrap" style={{ marginBottom: 12 }} align="center">
        <Input
          placeholder="搜索活动名称或 Campaign ID"
          prefix={<SearchOutlined />}
          value={searchText}
          onChange={event => setSearchText(event.target.value)}
          style={{ width: 300 }}
          size="small"
          allowClear
        />
        <Text strong>查看映射：</Text>
        <Select
          size="small"
          value={selectedStoreScope}
          onChange={value => setSelectedStoreScope(String(value).trim().toUpperCase())}
          style={{ width: 220 }}
          showSearch
          optionFilterProp="children"
          aria-label="查看 Campaign ID 映射所属店铺和站点"
        >
          {scopeOptions.map(option => (
            <Option key={option.scope} value={option.scope}>
              {campaignIdScopeLabel(option)}
            </Option>
          ))}
        </Select>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          style={{ display: 'none' }}
          onChange={event => {
            const file = event.target.files?.[0];
            if (file) handleImport(file);
          }}
        />
        <Button size="small" icon={<ImportOutlined />} type="primary" onClick={() => fileInputRef.current?.click()}>
          导入 Campaign ID 文件
        </Button>
        <Popconfirm
          title={`确定清空「${campaignIdScopeLabel(selectedScopeOption)}」的全部映射？`}
          description="仅删除当前选中站点/作用域的映射模板，不影响其他站点。"
          onConfirm={() => { void handleDeleteScopeMappings(); }}
          okText="确认删除"
          cancelText="取消"
          disabled={currentMappings.length === 0}
        >
          <Button size="small" danger icon={<DeleteOutlined />} disabled={currentMappings.length === 0}>
            删除当前映射模板
          </Button>
        </Popconfirm>
        <Tag color="blue">当前映射：{campaignIdScopeLabel(selectedScopeOption)}</Tag>
        <Text type="secondary" style={{ fontSize: 12 }}>
          当前站点 {currentMappings.length} 条 / 全部作用域 {mappings.length} 条
        </Text>
      </Flex>
      <Table<CampaignIdMappingRecord>
        rowKey={record => `${record.storeMarketplace}:${normalizeCampaignName(record.campaignName)}`}
        columns={columns}
        dataSource={currentMappings}
        size="small"
        pagination={{ pageSize: 100, showTotal: total => `${total} 条` }}
        scroll={{ x: 1000, y: 460 }}
        locale={{ emptyText: '当前店铺暂无 Campaign ID 映射，请点击上方入口导入' }}
      />
      <Modal
        title="确认导入 Campaign ID 映射"
        open={Boolean(pendingImport)}
        onOk={handleConfirmImport}
        onCancel={() => setPendingImport(null)}
        okText="导入并保存"
        cancelText="取消"
        confirmLoading={importConfirming}
        width={620}
      >
        {pendingImport && (
          <Flex vertical gap={12}>
            <Text type="secondary">文件：{pendingImport.fileName}；共 {pendingImport.rows.length} 行</Text>
            <div>
              <Text strong>导入归属店铺与站点</Text>
              <Flex gap={8} style={{ marginTop: 6 }}>
                <Select
                  value={pendingImport.storeId}
                  onChange={value => setPendingImport(prev => prev ? { ...prev, storeId: normalizeCampaignScope(value) } : prev)}
                  style={{ flex: 1 }}
                  showSearch
                  optionFilterProp="children"
                  aria-label="Campaign ID 映射导入归属店铺"
                >
                  {storeOptions.map(store => (
                    <Option key={`import-store-${store.id}`} value={normalizeCampaignScope(store.id)}>
                      {store.storeName || store.id}
                    </Option>
                  ))}
                </Select>
                <Input
                  list="campaign-id-marketplace-suggestions"
                  value={pendingImport.marketplace}
                  onChange={event => setPendingImport(prev => prev ? { ...prev, marketplace: event.target.value } : prev)}
                  placeholder="站点名称，可自定义"
                  allowClear
                  style={{ flex: 1 }}
                  aria-label="Campaign ID 映射导入站点"
                />
                <datalist id="campaign-id-marketplace-suggestions">
                  {CAMPAIGN_ID_MARKETPLACES.map(site => <option key={`import-site-${site}`} value={site} />)}
                </datalist>
              </Flex>
              <Text type="secondary" style={{ display: 'block', marginTop: 4 }}>
                当前作用域：{campaignIdScopeKey(pendingImport.storeId, pendingImport.marketplace)}；可直接输入自定义站点名称。同名广告组合会按这里的站点独立保存，不会覆盖其它站点。
              </Text>
            </div>
            <div>
              <Text strong>广告活动/广告组合名称所在列</Text>
              <Select
                value={pendingImport.campaignNameColumn}
                onChange={value => setPendingImport(prev => prev ? { ...prev, campaignNameColumn: value } : prev)}
                style={{ width: '100%', marginTop: 6 }}
              >
                {pendingImport.headers.map((header, index) => <Option key={`campaign-name-${index}-${header}`} value={header}>第{index + 1}列：{header}</Option>)}
              </Select>
            </div>
            <div>
              <Text strong>Campaign ID 所在列</Text>
              <Select
                value={pendingImport.campaignIdColumn}
                onChange={value => setPendingImport(prev => prev ? { ...prev, campaignIdColumn: value } : prev)}
                style={{ width: '100%', marginTop: 6 }}
              >
                {pendingImport.headers.map((header, index) => <Option key={`campaign-id-${index}-${header}`} value={header}>第{index + 1}列：{header}</Option>)}
              </Select>
            </div>
            <Text type="secondary">ID 会按文本保存，不会参与计算或被转换为科学计数法。</Text>
          </Flex>
        )}
      </Modal>
    </div>
  );
};

// ============ 机型组拓词编辑组件 ============

const ModelGroupEditor: React.FC = () => {
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [keywordText, setKeywordText] = useState('');
  const [searchText, setSearchText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [addVisible, setAddVisible] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [saving, setSaving] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<number>>(new Set());
  const [kwSearchText, setKwSearchText] = useState('');
  const importFileRef = useRef<HTMLInputElement>(null);

  const loadGroups = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch(`/api/model-groups`);
      setGroups(data.groups || []);
    } catch (err) {
      message.error(`加载机型组失败: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadGroups(); }, [loadGroups]);

   
  useEffect(() => {
    if (selectedIndex !== null && groups[selectedIndex]) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setKeywordText(groups[selectedIndex].keywords.join('\n'));
      setDirty(false);
    } else {
      setKeywordText('');
    }
  }, [selectedIndex, groups]);

  // 未保存时浏览器关闭/刷新提示
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // P0: Ctrl+S 快捷键保存
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (dirty && !saving) handleSaveKeywords();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dirty, saving]);

  // P1: 站点切换时 dirty 保护（通过 ref 追踪 dirty 状态）
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const keywordTextRef = useRef(keywordText);
  keywordTextRef.current = keywordText;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;

  const handleSaveKeywords = useCallback(async () => {
    if (selectedIndex === null || saving) return;
    setSaving(true);
    const saveStarted = performance.now();
    const updated = [...groups];
    updated[selectedIndex] = {
      ...updated[selectedIndex],
      keywords: keywordText.split('\n').map(l => l.trim()).filter(Boolean),
    };
    try {
      await apiFetch('/api/model-groups', {
        method: 'POST',
        body: JSON.stringify({
          action: 'update_group',
          index: selectedIndex,
          patch: { keywords: updated[selectedIndex].keywords },
        }),
      });
      setGroups(updated);
      setDirty(false);
      message.success(`"${updated[selectedIndex].name}" 拓词已保存（${Math.round(performance.now() - saveStarted)} ms）`);
    } catch (err) {
      message.error(`保存失败: ${(err as Error).message}，请重试`);
    } finally {
      setSaving(false);
    }
  }, [groups, selectedIndex, keywordText, saving]);

  const handleToggleEnabled = useCallback(async (idx: number) => {
    if (saving) return;
    setSaving(true);
    const updated = [...groups];
    updated[idx] = { ...updated[idx], enabled: !updated[idx].enabled };
    try {
      await apiFetch('/api/model-groups', {
        method: 'POST',
        body: JSON.stringify({
          action: 'update_group',
          index: idx,
          patch: { enabled: updated[idx].enabled },
        }),
      });
      setGroups(updated);
      message.success(`${updated[idx].name} 已${updated[idx].enabled ? '启用' : '禁用'}`);
    } catch (err) {
      message.error(`保存失败: ${(err as Error).message}，状态未变更`);
    } finally {
      setSaving(false);
    }
  }, [groups, saving]);

  const handleAddGroup = useCallback(async () => {
    if (!newGroupName.trim() || saving) return;
    setSaving(true);
    const updated = [...groups, { name: newGroupName.trim(), keywords: [], enabled: true }];
    const addedName = newGroupName.trim();
    try {
      await apiFetch('/api/model-groups', {
        method: 'POST',
        body: JSON.stringify({ action: 'save', groups: updated }),
      });
      setGroups(updated);
      setNewGroupName('');
      setAddVisible(false);
      message.success(`已添加 "${addedName}"`);
    } catch (err) {
      message.error(`添加失败: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [groups, newGroupName, saving]);

  const handleDeleteGroup = useCallback(async (idx: number) => {
    if (saving) return;
    setSaving(true);
    const name = groups[idx].name;
    const updated = groups.filter((_, i) => i !== idx);
    try {
      await apiFetch('/api/model-groups', {
        method: 'POST',
        body: JSON.stringify({ action: 'save', groups: updated }),
      });
      setGroups(updated);
      if (selectedIndex === idx) setSelectedIndex(null);
      else if (selectedIndex !== null && selectedIndex > idx) setSelectedIndex(selectedIndex - 1);
      setSelectedKeys(prev => {
        const next = new Set(prev);
        next.delete(idx);
        return next;
      });
      message.success(`已删除 "${name}"`);
    } catch (err) {
      message.error(`删除失败: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [groups, selectedIndex, saving]);

  // P2: 批量操作
  const handleBatchToggle = useCallback(async (enable: boolean) => {
    if (saving || selectedKeys.size === 0) return;
    setSaving(true);
    const updated = groups.map((g, i) => selectedKeys.has(i) ? { ...g, enabled: enable } : g);
    try {
      await apiFetch('/api/model-groups', {
        method: 'POST',
        body: JSON.stringify({ action: 'save', groups: updated }),
      });
      setGroups(updated);
      message.success(`已${enable ? '启用' : '禁用'} ${selectedKeys.size} 个机组`);
      setSelectedKeys(new Set());
    } catch (err) {
      message.error(`批量操作失败: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [groups, selectedKeys, saving]);

  const handleBatchDelete = useCallback(async () => {
    if (saving || selectedKeys.size === 0) return;
    setSaving(true);
    const keySet = selectedKeys;
    const updated = groups.filter((_, i) => !keySet.has(i));
    const count = keySet.size;
    try {
      await apiFetch('/api/model-groups', {
        method: 'POST',
        body: JSON.stringify({ action: 'save', groups: updated }),
      });
      setGroups(updated);
      setSelectedIndex(null);
      setSelectedKeys(new Set());
      message.success(`已删除 ${count} 个机组`);
    } catch (err) {
      message.error(`批量删除失败: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [groups, selectedKeys, saving]);

  // P2: 导出机组为 JSON
  const handleExportGroups = useCallback(() => {
    if (groups.length === 0) {
      message.warning('没有数据可导出');
      return;
    }
    try {
      const blob = new Blob([JSON.stringify({ groups, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
      void downloadBlob({ blob, fileName: `机型拓词_${new Date().toISOString().slice(0, 10)}.json` });message.success(`已导出 ${groups.length} 个机组`);
    } catch (err) {
      message.error(`导出失败: ${(err as Error).message}`);
    }
  }, [groups]);

  // P2: 从 JSON 导入机组
  const handleImportGroups = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e: any) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const importedGroups: ModelGroup[] = data.groups;
        if (!Array.isArray(importedGroups)) {
          message.error('无效的文件格式');
          return;
        }
        // 合并策略：同名机组合并拓词（去重），新机组追加
        const merged = [...groups];
        let added = 0;
        let mergedCount = 0;
        for (const ig of importedGroups) {
          const existIdx = merged.findIndex(g => g.name === ig.name);
          if (existIdx >= 0) {
            const existing = new Set(merged[existIdx].keywords);
            const newKws = ig.keywords.filter(k => !existing.has(k));
            if (newKws.length > 0) {
              merged[existIdx] = { ...merged[existIdx], keywords: [...merged[existIdx].keywords, ...newKws] };
              mergedCount++;
            }
          } else {
            merged.push(ig);
            added++;
          }
        }
        // 保存到后端
        await apiFetch('/api/model-groups', {
          method: 'POST',
          body: JSON.stringify({ action: 'save', groups: merged }),
        });
        setGroups(merged);
        message.success(`导入完成：新增 ${added} 个，合并 ${mergedCount} 个`);
      } catch (err) {
        message.error(`导入失败: ${(err as Error).message}`);
      }
    };
    input.click();
  }, [groups]);

  const filteredGroups = useMemo(() => {
    return groups
      .map((g, i) => ({ ...g, originalIndex: i }))
      .filter(g => !searchText || g.name.toLowerCase().includes(searchText.toLowerCase())
        || g.keywords.some(k => k.toLowerCase().includes(searchText.toLowerCase())));
  }, [groups, searchText]);

  // P1: 拓词搜索高亮
  const highlightedLines = useMemo(() => {
    if (!kwSearchText.trim() || !keywordText) return null;
    const searchLower = kwSearchText.toLowerCase();
    return keywordText.split('\n').map(line => {
      const lineLower = line.toLowerCase();
      const idx = lineLower.indexOf(searchLower);
      if (idx < 0) return { text: line, match: false };
      return { text: line, match: true, matchCount: (lineLower.match(new RegExp(searchLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length };
    });
  }, [keywordText, kwSearchText]);

  const kwMatchCount = useMemo(() => {
    return highlightedLines ? highlightedLines.filter(l => l.match).length : 0;
  }, [highlightedLines]);

  const selectedGroup = selectedIndex !== null ? groups[selectedIndex] : null;

  return (
    <div style={{ display: 'flex', gap: 12, height: '100%', minHeight: 0 }}>
      {/* 左侧：机型列表 */}
      <div style={{ width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <Flex gap={4} style={{ marginBottom: 8 }} wrap="wrap">
          <Input
            placeholder="搜索机型或拓词..."
            prefix={<SearchOutlined />}
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            size="small"
            allowClear
          />
          <Button size="small" icon={<PlusOutlined />} onClick={() => setAddVisible(true)} disabled={saving} />
        </Flex>
        {/* P2: 批量操作栏 */}
        {selectedKeys.size > 0 && (
          <Flex gap={4} style={{ marginBottom: 8 }} wrap="wrap">
            <Text type="secondary" style={{ fontSize: 11, lineHeight: '24px' }}>已选 {selectedKeys.size} 项</Text>
            <Button size="small" onClick={() => handleBatchToggle(true)} disabled={saving}>批量启用</Button>
            <Button size="small" onClick={() => handleBatchToggle(false)} disabled={saving}>批量禁用</Button>
            <Popconfirm title={`确定删除 ${selectedKeys.size} 个机组？`} onConfirm={handleBatchDelete}>
              <Button size="small" danger disabled={saving}>批量删除</Button>
            </Popconfirm>
            <Button size="small" onClick={() => setSelectedKeys(new Set())}>取消选择</Button>
          </Flex>
        )}
        <div style={{ flex: 1, overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 6 }}>
          {filteredGroups.map(g => {
            const isSelected = selectedIndex === g.originalIndex;
            const isChecked = selectedKeys.has(g.originalIndex);
            return (
              <div
                key={g.originalIndex}
                style={{
                  padding: '4px 8px',
                  cursor: 'pointer',
                  background: isSelected ? '#e6f4ff' : isChecked ? '#f0f5ff' : 'transparent',
                  borderLeft: g.enabled ? '3px solid #52c41a' : '3px solid #d9d9d9',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
                onClick={() => setSelectedIndex(g.originalIndex)}
              >
                <Flex gap={4} align="center">
                  <Checkbox
                    checked={isChecked}
                    onClick={e => { e.stopPropagation(); }}
                    onChange={e => {
                      setSelectedKeys(prev => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(g.originalIndex);
                        else next.delete(g.originalIndex);
                        return next;
                      });
                    }}
                    style={{ marginRight: 0 }}
                  />
                  <Text style={{ fontSize: 12, opacity: g.enabled ? 1 : 0.5 }}>{g.name}</Text>
                </Flex>
                <Flex gap={2}>
                  <Switch size="small" checked={g.enabled} onChange={() => handleToggleEnabled(g.originalIndex)} disabled={saving} />
                  <Popconfirm title={`删除 "${g.name}"？`} onConfirm={() => handleDeleteGroup(g.originalIndex)}>
                    <DeleteOutlined style={{ color: '#999', fontSize: 11, cursor: saving ? 'not-allowed' : 'pointer' }} />
                  </Popconfirm>
                </Flex>
              </div>
            );
          })}
        </div>
        <Flex justify="space-between" align="center" style={{ marginTop: 4 }}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            共 {groups.length} 组 / 启用 {groups.filter(g => g.enabled).length}
          </Text>
          <Flex gap={4}>
            <Tooltip title="导出 JSON">
              <Button size="small" icon={<ExportOutlined />} onClick={handleExportGroups} disabled={groups.length === 0} />
            </Tooltip>
            <Tooltip title="导入 JSON">
              <Button size="small" icon={<ImportOutlined />} onClick={handleImportGroups} />
            </Tooltip>
          </Flex>
        </Flex>
      </div>

      {/* 右侧：拓词编辑 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {selectedGroup ? (
          <>
            <Flex justify="space-between" align="center" style={{ marginBottom: 8 }}>
              <Text strong style={{ fontSize: 14 }}>{selectedGroup.name}</Text>
              <Flex gap={8} align="center">
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {selectedGroup.keywords.length} 个拓词
                  {dirty && <Text type="warning"> (未保存)</Text>}
                </Text>
                <Button size="small" type="primary" icon={<SaveOutlined />} disabled={!dirty || saving} onClick={handleSaveKeywords} loading={saving}>
                  保存拓词
                </Button>
              </Flex>
            </Flex>
            {/* P1: 拓词搜索 */}
            <Flex gap={4} style={{ marginBottom: 4 }} align="center">
              <Input
                placeholder="搜索拓词..."
                prefix={<SearchOutlined />}
                value={kwSearchText}
                onChange={e => setKwSearchText(e.target.value)}
                size="small"
                allowClear
                style={{ width: 200 }}
              />
              {kwSearchText && highlightedLines && (
                <Text type="secondary" style={{ fontSize: 11 }}>
                  匹配 {kwMatchCount} / {highlightedLines.length} 行
                </Text>
              )}
            </Flex>
            {/* P1: 搜索高亮预览 */}
            {kwSearchText && highlightedLines ? (
              <div style={{ flex: 1, overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 6, padding: 8, fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap', lineHeight: 1.6, background: '#fafafa' }}>
                {highlightedLines.map((line, i) => (
                  <div key={i} style={{ background: line.match ? '#fffbe6' : 'transparent', padding: '0 4px', borderRadius: 2 }}>
                    {line.text}
                  </div>
                ))}
              </div>
            ) : (
              <TextArea
                value={keywordText}
                onChange={e => { setKeywordText(e.target.value); setDirty(true); }}
                style={{ flex: 1, fontFamily: 'Consolas, monospace', fontSize: 12 }}
                placeholder="每行一个拓词关键词（Ctrl+S 保存）"
              />
            )}
          </>
        ) : (
          <Empty description="请从左侧选择机型" style={{ marginTop: 60 }} />
        )}
      </div>

      <Modal
        title="添加机型组"
        open={addVisible}
        onOk={handleAddGroup}
        onCancel={() => { setAddVisible(false); setNewGroupName(''); }}
        okText="添加"
        confirmLoading={saving}
      >
        <Input
          value={newGroupName}
          onChange={e => setNewGroupName(e.target.value)}
          placeholder="如: iPhone 16e"
          autoFocus
        />
      </Modal>
    </div>
  );
};

// ============ 机型否词库管理组件 ============

const DenyLibraryEditor: React.FC = () => {
  const [library, setLibrary] = useState<DenyLibEntry[]>([]);
  const [allModels, setAllModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [keywordText, setKeywordText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [addVisible, setAddVisible] = useState(false);
  const [newModel, setNewModel] = useState('');
  const [saving, setSaving] = useState(false);

  const loadLibrary = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch(`/api/deny-library`);
      setLibrary(data.library || []);
    } catch (err) {
      message.error(`加载否词库失败: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // 加载所有机型组名称
  const loadAllModels = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/model-groups`);
      const groups: ModelGroup[] = data.groups || [];
      setAllModels(groups.map(g => g.name).sort());
    } catch {
      // 静默失败，不影响主功能
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadLibrary(); loadAllModels(); }, [loadLibrary, loadAllModels]);

  // 否词库中已有的机型名集合
  const libraryModelSet = useMemo(() => new Set(library.map(e => e.name)), [library]);

  // 合并所有机型：先显示否词库中已有的(红色边框)，再显示未添加的(灰色虚线)
  const mergedModels = useMemo(() => {
    const inLib = library.filter(e => !searchText || e.name.toLowerCase().includes(searchText.toLowerCase()));
    const notInLib = allModels
      .filter(name => !libraryModelSet.has(name))
      .filter(name => !searchText || name.toLowerCase().includes(searchText.toLowerCase()));
    return { inLib, notInLib };
  }, [library, allModels, libraryModelSet, searchText]);

  const currentEntry = useMemo(() => {
    return library.find(e => e.name === selectedModel);
  }, [library, selectedModel]);

   
  useEffect(() => {
    if (currentEntry) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setKeywordText(currentEntry.keywords.join('\n'));
      setDirty(false);
    } else {
      setKeywordText('');
    }
  }, [currentEntry]);

  const saveLibrary = useCallback(async (updated: DenyLibEntry[]) => {
    await apiFetch('/api/deny-library', {
      method: 'POST',
      body: JSON.stringify({ action: 'save', library: updated }),
    });
    setLibrary(updated);
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedModel) return;
    setSaving(true);
    const kws = keywordText.split('\n').map(l => l.trim()).filter(Boolean);
    const updated = library.map(e => e.name === selectedModel ? { ...e, keywords: kws } : e);
    try {
      await saveLibrary(updated);
      setDirty(false);
      message.success(`"${selectedModel}" 否词已保存 (${kws.length} 条)`);
    } catch (err) {
      message.error(`保存失败: ${(err as Error).message}，请重试`);
    } finally {
      setSaving(false);
    }
  }, [library, selectedModel, keywordText, saveLibrary]);

  // 点击未添加的机型，直接添加到否词库并选中
  const handleAddFromModel = useCallback(async (name: string) => {
    if (libraryModelSet.has(name)) {
      setSelectedModel(name);
      return;
    }
    setSaving(true);
    const updated = [...library, { name, keywords: [], linked_models: [] }];
    try {
      await saveLibrary(updated);
      setSelectedModel(name);
      message.success(`已添加 "${name}" 到否词库`);
    } catch (err) {
      message.error(`添加失败: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [library, libraryModelSet, saveLibrary]);

  const handleAddModel = useCallback(async () => {
    if (!newModel.trim()) return;
    if (library.some(e => e.name === newModel.trim())) {
      message.warning('该机型已存在');
      return;
    }
    setSaving(true);
    const updated = [...library, { name: newModel.trim(), keywords: [], linked_models: [] }];
    const addedName = newModel.trim();
    try {
      await saveLibrary(updated);
      setNewModel('');
      setAddVisible(false);
      setSelectedModel(addedName);
      message.success(`已添加 "${addedName}"`);
    } catch (err) {
      message.error(`添加失败: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [library, newModel, saveLibrary]);

  const handleDeleteModel = useCallback(async (model: string) => {
    const updated = library.filter(e => e.name !== model);
    try {
      await saveLibrary(updated);
      if (selectedModel === model) setSelectedModel(null);
      message.success(`已删除 "${model}"`);
    } catch (err) {
      message.error(`删除失败: ${(err as Error).message}，状态未变更`);
    }
  }, [library, selectedModel, saveLibrary]);



  return (
    <div style={{ display: 'flex', gap: 12, height: '100%', minHeight: 0 }}>
      {/* 左侧：机型列表（所有机型） */}
      <div style={{ width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <Flex gap={4} style={{ marginBottom: 8 }} wrap="wrap">
          <Input
            placeholder="搜索机型..."
            prefix={<SearchOutlined />}
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            size="small"
            allowClear
          />
          <Button size="small" icon={<PlusOutlined />} onClick={() => setAddVisible(true)} disabled={saving} />
        </Flex>
        <div style={{ flex: 1, overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 6 }}>
          {/* 已有否词的机型（红色实线边框） */}
          {mergedModels.inLib.map(entry => (
            <div
              key={entry.name}
              style={{
                padding: '4px 8px',
                cursor: 'pointer',
                background: selectedModel === entry.name ? '#fff1f0' : 'transparent',
                borderLeft: '3px solid #ff4d4f',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
              onClick={() => setSelectedModel(entry.name)}
            >
              <Text style={{ fontSize: 12 }}>{entry.name}</Text>
              <Flex gap={4} align="center">
                <Tag color="red" style={{ fontSize: 10, margin: 0 }}>{entry.keywords.length}</Tag>
                <Popconfirm title={`删除 "${entry.name}" 的所有否词？`} onConfirm={() => handleDeleteModel(entry.name)}>
                  <DeleteOutlined style={{ color: '#999', fontSize: 11 }} />
                </Popconfirm>
              </Flex>
            </div>
          ))}
          {/* 未添加否词的机型（灰色虚线，点击添加） */}
          {mergedModels.notInLib.map(name => (
            <div
              key={`_add_${name}`}
              style={{
                padding: '4px 8px',
                cursor: 'pointer',
                background: selectedModel === name ? '#f6ffed' : 'transparent',
                borderLeft: '3px dashed #d9d9d9',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                opacity: 0.7,
              }}
              onClick={() => handleAddFromModel(name)}
            >
              <Text style={{ fontSize: 12, color: '#999' }}>{name}</Text>
              <Tooltip title="点击添加到否词库">
                <PlusOutlined style={{ color: '#52c41a', fontSize: 11 }} />
              </Tooltip>
            </div>
          ))}
        </div>
        <Flex justify="space-between" align="center" style={{ marginTop: 4 }}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            已添加 {library.length} / {library.length + mergedModels.notInLib.length} 个机型
          </Text>
        </Flex>
      </div>

      {/* 右侧：否词编辑 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {currentEntry ? (
          <>
            <Flex justify="space-between" align="center" style={{ marginBottom: 8 }}>
              <Text strong style={{ fontSize: 14 }}>{currentEntry.name}</Text>
              <Flex gap={8} align="center">
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {currentEntry.keywords.length} 条否词
                  {dirty && <Text type="warning"> (未保存)</Text>}
                </Text>
                <Button size="small" type="primary" icon={<SaveOutlined />} disabled={!dirty || saving} onClick={handleSave} loading={saving}>
                  保存
                </Button>
              </Flex>
            </Flex>
            <Text type="secondary" style={{ fontSize: 11, marginBottom: 4 }}>
              每行一个否词关键词，或用逗号/分号分隔
            </Text>
            <TextArea
              value={keywordText}
              onChange={e => { setKeywordText(e.target.value); setDirty(true); }}
              style={{ flex: 1, fontFamily: 'Consolas, monospace', fontSize: 12 }}
              placeholder="如: screen protector, tempered glass, charger..."
            />
          </>
        ) : (
          <Empty description="请从左侧选择机型，或点击未添加的机型直接加入" style={{ marginTop: 60 }} />
        )}
      </div>

      <Modal
        title="添加机型到否词库"
        open={addVisible}
        onOk={handleAddModel}
        onCancel={() => { setAddVisible(false); setNewModel(''); }}
        okText="添加"
        confirmLoading={saving}
      >
        <Input
          value={newModel}
          onChange={e => setNewModel(e.target.value)}
          placeholder="如: iPhone 16e"
          autoFocus
        />
      </Modal>
    </div>
  );
};

// ============ 别名规则编辑组件 ============

const AliasRuleEditor: React.FC = () => {
  const [rules, setRules] = useState<AliasRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [editVisible, setEditVisible] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [editTrigger, setEditTrigger] = useState('');
  const [editTarget, setEditTarget] = useState('');
  const [searchText, setSearchText] = useState('');

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch(`/api/alias-rules`);
      setRules(data.rules || []);
    } catch (err) {
      message.error(`加载别名规则失败: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadRules(); }, [loadRules]);

  const handleSaveRules = useCallback(async (newRules: AliasRule[]) => {
    // 先保存到后端，成功后再更新本地状态
    try {
      await apiFetch('/api/alias-rules', {
        method: 'POST',
        body: JSON.stringify({ action: 'save', rules: newRules }),
      });
      setRules(newRules);
      message.success(`别名规则已保存 (${newRules.length} 条)`);
    } catch (err) {
      message.error(`保存失败: ${(err as Error).message}`);
      throw err;
    }
  }, []);

  const handleSave = () => {
    if (!editTrigger.trim() || !editTarget.trim()) {
      message.warning('触发词和目标机型组不能为空');
      return;
    }
    let newRules: AliasRule[];
    if (editIndex !== null) {
      newRules = rules.map((r, i) => i === editIndex ? { ...r, trigger_word: editTrigger.trim(), target_model: editTarget.trim() } : r);
    } else {
      newRules = [...rules, { name: editTarget.trim(), trigger_word: editTrigger.trim(), target_model: editTarget.trim(), enabled: true }];
    }
    handleSaveRules(newRules);
    setEditVisible(false);
    setEditTrigger('');
    setEditTarget('');
    setEditIndex(null);
  };

  const handleDelete = (idx: number) => {
    const newRules = rules.filter((_, i) => i !== idx);
    handleSaveRules(newRules);
  };

  const filteredRules = useMemo(() => {
    return rules
      .map((r, i) => ({ ...r, originalIndex: i }))
      .filter(r => !searchText || (r.trigger_word ?? '').toLowerCase().includes(searchText.toLowerCase()) || (r.target_model ?? '').toLowerCase().includes(searchText.toLowerCase()));
  }, [rules, searchText]);

  const columns: ColumnsType<AliasRule & { originalIndex: number }> = [
    { title: '#', width: 50, render: (_, __, i) => i + 1 },
    { title: '触发词', dataIndex: 'trigger_word', sorter: (a: any, b: any) => String(a.trigger_word ?? '').localeCompare(String(b.trigger_word ?? '')), width: 200, ellipsis: true, render: (t: string) => <Tag color="blue">{t}</Tag> },
    { title: '目标机型组', dataIndex: 'target_model', sorter: (a: any, b: any) => String(a.target_model ?? '').localeCompare(String(b.target_model ?? '')), width: 250, ellipsis: true, render: (t: string) => <Tag color="purple">{t}</Tag> },
    {
      title: '操作', width: 120, render: (_, record) => (
        <Flex gap={4}>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditIndex(record.originalIndex);
              setEditTrigger(record.trigger_word);
              setEditTarget(record.target_model);
              setEditVisible(true);
            }}
          />
          <Popconfirm title="删除此规则？" onConfirm={() => handleDelete(record.originalIndex)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Flex>
      ),
    },
  ];

  return (
    <div>
      <Flex gap={8} wrap="wrap" style={{ marginBottom: 12 }} align="center">
        <Input
          placeholder="搜索触发词或目标组..."
          prefix={<SearchOutlined />}
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          style={{ width: 280 }}
          size="small"
          allowClear
        />
        <Button size="small" icon={<PlusOutlined />} type="primary" onClick={() => {
          setEditIndex(null);
          setEditTrigger('');
          setEditTarget('');
          setEditVisible(true);
        }}>
          添加规则
        </Button>
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={loadRules}>
          刷新
        </Button>
        <Text type="secondary" style={{ fontSize: 11 }}>
          当搜索词包含触发词时，强制识别为目标机型组
        </Text>
      </Flex>

      <Table
        columns={columns}
        dataSource={filteredRules}
        rowKey="originalIndex"
        size="small"
        pagination={{ pageSize: 100, showTotal: t => `${t} 条` }}
        scroll={{ y: 500 }}
        loading={loading}
      />

      <Modal
        title={editIndex !== null ? '编辑别名规则' : '添加别名规则'}
        open={editVisible}
        onOk={handleSave}
        onCancel={() => { setEditVisible(false); setEditIndex(null); }}
        okText="保存"
        width={500}
      >
        <Flex vertical gap={12}>
          <div>
            <Text strong>触发词</Text>
            <Input value={editTrigger} onChange={e => setEditTrigger(e.target.value)} placeholder="如: iphone16e" style={{ marginTop: 4 }} />
          </div>
          <div>
            <Text strong>目标机型组</Text>
            <Input value={editTarget} onChange={e => setEditTarget(e.target.value)} placeholder="如: iPhone 16e" style={{ marginTop: 4 }} />
          </div>
        </Flex>
      </Modal>
    </div>
  );
};

// ============ 操作日志组件 ============

const OperationLogViewer: React.FC = () => {
  const [logs, setLogs] = useState<OperationLog[]>([]);
  const [loading, setLoading] = useState(false);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch('/api/logs');
      setLogs(data.logs || []);
    } catch (err) {
      message.error(`加载日志失败: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadLogs(); }, [loadLogs]);

  return (
    <div>
      <Flex gap={8} style={{ marginBottom: 12 }}>
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={loadLogs}>刷新</Button>
        <Text type="secondary" style={{ fontSize: 11 }}>最近 {logs.length} 条记录</Text>
      </Flex>
      <div style={{ background: '#1e1e1e', borderRadius: 6, padding: 12, maxHeight: 'calc(100vh - 360px)', overflow: 'auto' }}>
        {logs.length === 0 ? (
          <Text style={{ color: '#888' }}>暂无操作记录</Text>
        ) : (
          logs.map((log, i) => (
            <div key={i} style={{ fontFamily: 'Consolas, monospace', fontSize: 12, marginBottom: 2 }}>
              <Text style={{ color: '#6a9955' }}>{log.timestamp}</Text>{' '}
              <Text style={{ color: '#dcdcaa' }}>{log.action}</Text>
              {log.detail && <Text style={{ color: '#888' }}> — {log.detail}</Text>}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

// ============ 主组件 ============

/** v5.1: 开关类配置项的中文名，用于保存提示 */
const SWITCH_LABELS: Record<string, string> = {
  require_case: '壳类词',
  intercept_brand: '竞品品牌',
};

interface PluginStoreItem {
  id: string;
  name: string;
  marketplace: string;
}

const NegKeywordTool: React.FC = () => {
  const { activeMarketplace: shimMarketplace, activeShopKey: shimShopKey, activeStore: shimStore, stores: shimStores } = useStore();
  const [pluginStores, setPluginStores] = useState<PluginStoreItem[]>([]);
  const [activeStoreId, setActiveStoreId] = useState<string>('default');
  const [storeSwitching, setStoreSwitching] = useState(false);
  const [storeVersion, setStoreVersion] = useState(0);
  const [newStoreOpen, setNewStoreOpen] = useState(false);
  const [newStoreId, setNewStoreId] = useState('');
  const [newStoreName, setNewStoreName] = useState('');
  const [newStoreMkt, setNewStoreMkt] = useState('US');
  const [newStoreCopyFrom, setNewStoreCopyFrom] = useState('default');

  const activePluginStore = useMemo(
    () => pluginStores.find(s => s.id === activeStoreId) || null,
    [pluginStores, activeStoreId]
  );
  const activeMarketplace = activePluginStore?.marketplace || shimMarketplace;
  const activeShopKey = activePluginStore?.id || shimShopKey;
  const activeStore = activePluginStore
    ? { shopKey: activePluginStore.id, marketplace: activePluginStore.marketplace, name: activePluginStore.name }
    : shimStore;
  const stores = pluginStores.length
    ? pluginStores.map(s => ({ shopKey: s.id, marketplace: s.marketplace, name: s.name }))
    : shimStores;

  // handleFileImport 在组件初始化时就创建；用 ref 保证切换店铺后，
  // 导入触发的分类请求仍然使用当前站点，而不是初始的 US。
  const activeMarketplaceRef = useRef(activeMarketplace);
  activeMarketplaceRef.current = activeMarketplace;
  const activeStoreScopeRef = useRef(activeShopKey || activeMarketplace);
  activeStoreScopeRef.current = activeShopKey || activeMarketplace;
  const [data, setData] = useState<KeywordRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [requireCase, setRequireCase] = useState(true);
  const [interceptBrand, setInterceptBrand] = useState(true);
  const [filter, setFilter] = useState<FilterState>({ tag: '', searchTerm: '', campaign: '' });
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [activeTab, setActiveTab] = useState('classify');
  const [amazonNegativeMatchMode, setAmazonNegativeMatchMode] = useState<AmazonNegativeMatchMode>('auto');
  const [amazonNegativeScope, setAmazonNegativeScope] = useState<AmazonNegativeScope>('campaign');
  const [amazonTemplateExporting, setAmazonTemplateExporting] = useState(false);
  const [campaignIdExportStore, setCampaignIdExportStore] = useState('');
  const [pendingImport, setPendingImport] = useState<PendingKeywordImport | null>(null);
  const [importMapping, setImportMapping] = useState<ImportColumnMapping | null>(null);
  const [importConfirming, setImportConfirming] = useState(false);
  const [asinRows, setAsinRows] = useState<AsinRow[]>([]);
  const [asinLoading, setAsinLoading] = useState(false);
  const [asinTemplateExporting, setAsinTemplateExporting] = useState(false);
  // 广告活动级是安全默认值：官方模板虽然有 Ad Group ID 表头，活动级行应为空。
  const [asinNegativeScope, setAsinNegativeScope] = useState<AmazonNegativeScope>('campaign');
  const [asinExportScope, setAsinExportScope] = useState('');
  const [pendingAsinImport, setPendingAsinImport] = useState<PendingAsinImport | null>(null);
  const [asinImportMapping, setAsinImportMapping] = useState<AsinImportColumnMapping | null>(null);
  const [asinImportConfirming, setAsinImportConfirming] = useState(false);
  const [campaignIdMappings, setCampaignIdMappings] = useState<CampaignIdMappingRecord[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const asinFileInputRef = useRef<HTMLInputElement>(null);
  const autoAsinFileInputRef = useRef<HTMLInputElement>(null);
  const [autoAsinModalVisible, setAutoAsinModalVisible] = useState(false);
  const [autoAsinLoading, setAutoAsinLoading] = useState(false);
  const [autoAsinProgress, setAutoAsinProgress] = useState({ done: 0, total: 0, text: '' });
  const [autoAsinPendingFile, setAutoAsinPendingFile] = useState<{ fileName: string; rows: any[]; headers: string[] } | null>(null);
  const [autoAsinMapping, setAutoAsinMapping] = useState({
    asinCol: '',
    modelCol: '',
    campaignCol: '',
    adGroupCol: '',
    country: 'US',
  });
  const [asinFolderExporting, setAsinFolderExporting] = useState(false);
  const [geminiAuditing, setGeminiAuditing] = useState(false);
  const [geminiAuditModalOpen, setGeminiAuditModalOpen] = useState(false);
  const [geminiAuditMeta, setGeminiAuditMeta] = useState<{ model?: string; auditedCount?: number; falseDenyCount?: number }>({});
  const [geminiAuditRows, setGeminiAuditRows] = useState<Array<{
    key: React.Key;
    campaign: string;
    searchTerm: string;
    targetGroup: string;
    reason: string;
    verdict: 'false_deny' | 'correct_deny' | 'uncertain';
    note: string;
  }>>([]);
  const navigate = useNavigate();

  const campaignIdStoreOptions = useMemo(() => {
    const validStores = stores.filter(store => store && String(store.id || '').trim());
    if (validStores.length > 0) return validStores;
    return [{
      id: activeShopKey || activeMarketplace || 'US',
      storeName: activeStore?.storeName || activeShopKey || activeMarketplace || '当前店铺',
      marketplace: activeMarketplace || 'US',
    } as StoreInfo];
  }, [activeMarketplace, activeShopKey, activeStore?.storeName, stores]);

  const campaignIdScopeOptions = useMemo(
    () => buildCampaignIdScopeOptions(campaignIdStoreOptions, campaignIdMappings, activeShopKey || activeMarketplace),
    [activeMarketplace, activeShopKey, campaignIdMappings, campaignIdStoreOptions],
  );
  const defaultCampaignIdExportScope = campaignIdScopeKey(activeShopKey || activeMarketplace || 'US', activeMarketplace || 'US');

  // 默认跟随顶部当前店铺；真正导出前用户可以单独选择其它店铺/站点的 ID 映射。
  useEffect(() => {
    setCampaignIdExportStore(defaultCampaignIdExportScope);
    setAsinExportScope(defaultCampaignIdExportScope);
  }, [defaultCampaignIdExportScope]);

  const loadCampaignIdMappings = useCallback(async () => {
    const localMappings = normalizeLegacyCampaignIdMappings(readLocalCampaignIdMappings(), campaignIdStoreOptions);
    try {
      const response = await apiFetch('/api/campaign-id-mappings');
      const records = Array.isArray(response) ? response : response?.mappings;
      const remoteMappings = normalizeLegacyCampaignIdMappings(
        Array.isArray(records) ? records : [],
        campaignIdStoreOptions,
      );
      // 以插件后端磁盘为准，避免已删除的作用域从 localStorage 复活
      const nextMappings = Array.isArray(records) ? remoteMappings : localMappings;
      setCampaignIdMappings(nextMappings);
      writeLocalCampaignIdMappings(nextMappings);
    } catch (error) {
      setCampaignIdMappings(localMappings);
      // 后端不可达时仍使用本地镜像，不让映射丢失。
      console.warn('[否词工具] Campaign ID 映射加载失败:', error);
    }
  }, [campaignIdStoreOptions]);

  const saveCampaignIdMappings = useCallback(async (mappings: CampaignIdMappingRecord[]) => {
    const normalized = normalizeLegacyCampaignIdMappings(mappings, campaignIdStoreOptions);
    // 先落本地镜像，确保启动器后端短暂离线时导入结果仍能立即用于导出。
    writeLocalCampaignIdMappings(normalized);
    setCampaignIdMappings(normalized);
    try {
      await apiFetch('/api/campaign-id-mappings', {
        method: 'POST',
        body: JSON.stringify({ mappings: normalized }),
      });
    } catch (error) {
      console.warn('[否词工具] Campaign ID 映射后端保存失败:', error);
      throw error;
    }
  }, [campaignIdStoreOptions]);

  // 映射独立于当前搜索词报告持久化，切换店铺/重启后仍可用于下一次导出。
  useEffect(() => { void loadCampaignIdMappings(); }, [loadCampaignIdMappings]);

  // Auto-reclassify when requireCase or interceptBrand changes (if data exists)
  const prevRequireCaseRef = useRef(requireCase);
  const prevInterceptBrandRef = useRef(interceptBrand);
  // v5.1(2026-08-31): 标记「配置已从后端回显完毕」。
  //   在此之前开关的变动属于初始化回显（loadConfig 里 setState），不是用户操作，
  //   不能触发保存，否则一进页面就用读到的值反向写一次配置。
  const configHydratedRef = useRef(false);
  useEffect(() => {
    const caseChanged = prevRequireCaseRef.current !== requireCase;
    const brandChanged = prevInterceptBrandRef.current !== interceptBrand;
    if (!caseChanged && !brandChanged) return;

    // ── 持久化开关（原实现缺失，导致刷新即回弹）──
    if (configHydratedRef.current) {
      const updates: Record<string, unknown> = {};
      if (caseChanged) updates.require_case = requireCase;
      if (brandChanged) updates.intercept_brand = interceptBrand;
      savePartialConfig(updates).catch(() => {
        message.warning('开关已生效（本次分类），但持久化失败，刷新后将回默认开启');
      });
    }

    if (data.length > 0) {
      const resetData = data.map(r => ({ ...r, tag: undefined as any, tagLabel: undefined as any, reason: undefined as any, manualOverride: false }));
      processClassification(resetData);
      const msgs = [];
      if (caseChanged) msgs.push(requireCase ? '需壳类词' : '不需壳类词');
      if (brandChanged) msgs.push(interceptBrand ? '拦截竞品品牌' : '不拦截竞品品牌');
      message.info(`已切换到${msgs.join(' + ')}模式，正在重新分类...`);
    }
    prevRequireCaseRef.current = requireCase;
    prevInterceptBrandRef.current = interceptBrand;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requireCase, interceptBrand]);

  // Config state for rules editing
  const [denyBrands, setDenyBrands] = useState<string[]>([]);
  const [denyModels, setDenyModels] = useState<string[]>([]);
  const [keepCaseWords, setKeepCaseWords] = useState<string[]>([]);
  const [screenProtectorWords, setScreenProtectorWords] = useState<string[]>([]);

  // Load config
  const loadConfig = useCallback(async () => {
    try {
      const config = await apiFetch('/api/config');
      setDenyBrands(config.deny_brands || []);
      setDenyModels(config.deny_models || []);
      setKeepCaseWords(config.keep_case_words || []);
      setScreenProtectorWords(config.screen_protector_words || []);
      // v5.1(2026-08-31): 回显两个开关。原实现从不读取后端值，
      // 无论配置里存的是什么，页面一打开都显示默认的 true。
      // 注意：必须做 undefined 判断而非 || ，否则后端返回 false 会被吞成 true。
      if (typeof config.require_case === 'boolean') setRequireCase(config.require_case);
      if (typeof config.intercept_brand === 'boolean') setInterceptBrand(config.intercept_brand);
      // 回显完成后才允许开关变化触发持久化
      configHydratedRef.current = true;
    } catch {
      // Silently fail - config tabs will show empty
      configHydratedRef.current = true;
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadConfig(); }, [loadConfig]);



  // Save partial config — 返回 Promise 以便 TextListEditor 感知成功/失败
  const savePartialConfig = useCallback(async (updates: Record<string, unknown>) => {
    try {
      await apiFetch('/api/config/partial', {
        method: 'POST',
        body: JSON.stringify(updates),
      });
      const key = Object.keys(updates)[0];
      const val = updates[key];
      // v5.1(2026-08-31): 开关类（布尔）不是"条数"，原来会显示成"配置已保存 (0 条)"
      if (Array.isArray(val)) {
        message.success(`配置已保存 (${val.length} 条)`);
      } else if (typeof val === 'boolean') {
        message.success(`开关已保存：${SWITCH_LABELS[key] || key} = ${val ? '开' : '关'}`);
      } else {
        message.success('配置已保存');
      }
    } catch (err) {
      message.error(`保存失败: ${(err as Error).message}`);
      throw err; // 让调用方知道失败了
    }
  }, []);

  // TextListEditor 的 onChange 回调：先保存后端，成功后再更新本地状态
  const handleDenyBrandsChange = useCallback(async (v: string[]) => {
    await savePartialConfig({ deny_brands: v });
    setDenyBrands(v);
  }, [savePartialConfig]);

  const handleDenyModelsChange = useCallback(async (v: string[]) => {
    await savePartialConfig({ deny_models: v });
    setDenyModels(v);
  }, [savePartialConfig]);

  const handleKeepCaseWordsChange = useCallback(async (v: string[]) => {
    await savePartialConfig({ keep_case_words: v });
    setKeepCaseWords(v);
  }, [savePartialConfig]);

  const handleScreenProtectorWordsChange = useCallback(async (v: string[]) => {
    await savePartialConfig({ screen_protector_words: v });
    setScreenProtectorWords(v);
  }, [savePartialConfig]);

  // Sync config to all locations
  const [syncing, setSyncing] = useState(false);
  const [syncInfo, setSyncInfo] = useState<{
    synced: string[];
    errors: string[];
    warnings: string[];
    fileSize: number;
    updated: string[];
    unchanged: string[];
    durationMs: number;
  } | null>(null);

  const loadStoresState = useCallback(async () => {
    try {
      const st = await apiFetch('/api/stores');
      if (Array.isArray(st?.stores)) setPluginStores(st.stores);
      if (st?.active_store_id) setActiveStoreId(st.active_store_id);
    } catch {
      // ignore if backend not ready
    }
  }, []);

  useEffect(() => { void loadStoresState(); }, [loadStoresState]);

  const handleSwitchStore = useCallback(async (targetId: string) => {
    if (!targetId || targetId === activeStoreId) return;
    setStoreSwitching(true);
    try {
      const res = await apiFetch('/api/stores/switch', {
        method: 'POST',
        body: JSON.stringify({ store_id: targetId }),
      });
      if (Array.isArray(res?.stores)) setPluginStores(res.stores);
      if (res?.active_store_id) setActiveStoreId(res.active_store_id);
      await Promise.all([loadConfig(), loadCampaignIdMappings()]);
      setStoreVersion(v => v + 1);
      const targetName = res?.active_store?.name || targetId;
      message.success(`已切换到店铺「${targetName}」，已加载该店铺独立规则`);
    } catch (err) {
      message.error(`切换店铺失败: ${(err as Error).message}`);
    } finally {
      setStoreSwitching(false);
    }
  }, [activeStoreId, loadConfig, loadCampaignIdMappings]);

  const handleCreateStore = useCallback(async () => {
    const sid = newStoreId.trim() || newStoreName.trim();
    if (!sid) {
      message.warning('请输入店铺 ID 或名称');
      return;
    }
    setStoreSwitching(true);
    try {
      const res = await apiFetch('/api/stores/create', {
        method: 'POST',
        body: JSON.stringify({
          store_id: sid,
          name: newStoreName.trim() || sid,
          marketplace: newStoreMkt,
          copy_from: newStoreCopyFrom || 'default',
        }),
      });
      if (Array.isArray(res?.stores)) setPluginStores(res.stores);
      if (res?.active_store_id) setActiveStoreId(res.active_store_id);
      await Promise.all([loadConfig(), loadCampaignIdMappings()]);
      setStoreVersion(v => v + 1);
      setNewStoreOpen(false);
      setNewStoreId('');
      setNewStoreName('');
      message.success(`已创建并切换到店铺「${res?.active_store?.name || sid}」`);
    } catch (err) {
      message.error(`新增店铺失败: ${(err as Error).message}`);
    } finally {
      setStoreSwitching(false);
    }
  }, [newStoreId, newStoreName, newStoreMkt, newStoreCopyFrom, loadConfig, loadCampaignIdMappings]);

  const handleSyncConfig = useCallback(async () => {
    setSyncing(true);
    try {
      const result = await apiFetch('/api/sync-config', { method: 'POST' });
      setSyncInfo({
        synced: result.synced || [],
        errors: result.errors || [],
        warnings: result.warnings || [],
        fileSize: result.file_size || 0,
        updated: result.updated || [],
        unchanged: result.unchanged || [],
        durationMs: result.duration_ms || 0,
      });
      if (result.status === 'ok') {
        message.success(`✅ 配置同步完成（${result.duration_ms || 0} ms），更新 ${result.updated?.length || 0} 个位置`);
      } else {
        message.warning(`⚠️ 同步完成（部分失败）: 成功 ${result.synced.join(', ')} | 失败 ${result.errors.join('; ')}`);
      }
    } catch (err) {
      message.error(`同步失败: ${(err as Error).message}`);
    } finally {
      setSyncing(false);
    }
  }, []);

  // Statistics
  const stats = useMemo(() => {
    const deny = data.filter(d => d.tag === 'deny').length;
    const keep = data.filter(d => d.tag === 'keep').length;
    const review = data.filter(d => d.tag === 'review').length;
    const manual = data.filter(d => d.manualOverride).length;
    return { total: data.length, deny, keep, review, manual };
  }, [data]);

  // Audit state
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditResult, setAuditResult] = useState<any>(null);
  const [auditDrawerOpen, setAuditDrawerOpen] = useState(false);
  const [auditActiveTab, setAuditActiveTab] = useState('summary');
  const [auditProgress, setAuditProgress] = useState({ done: 0, total: 0 });
  const [applyingFixes, setApplyingFixes] = useState(false);
  const [selectedAuditFixKeys, setSelectedAuditFixKeys] = useState<React.Key[]>([]);

  // ============ 否词结果规则审核（本地引擎） ============
  const handleAudit = useCallback(async () => {
    if (data.length === 0) {
      message.warning('请先导入并分类数据');
      return;
    }
    setAuditLoading(true);
    setAuditProgress({ done: 0, total: data.length });
    try {
      // 构建审核输入：所有分类结果
      const auditItems = data.map(d => ({
        term: d.searchTerm,
        campaign: d.campaign || '',
        tag: d.tag,
        reason: d.reason || '',
        targetGroupName: d.mappedGroup || '',
        rowModel: d.model || '',
      }));
      const resp = await apiFetch('/api/neg-audit', {
        method: 'POST',
        body: JSON.stringify({ items: auditItems, format_csv: true }),
        timeoutMs: 300000,
      });
      setAuditProgress({ done: data.length, total: data.length });
      setAuditResult(resp.report);
      setAuditDrawerOpen(true);
      const sum = resp.report?.summary;
      if (sum) {
        if (sum.high_priority > 0) {
          message.warning(`规则审核完成：发现 ${sum.high_priority} 个紧急问题 + ${sum.medium_priority} 个高优先级问题，建议修正后导入`);
        } else {
          message.success(`规则审核完成：基本可靠，共 ${sum.total_issues} 个低优先级问题`);
        }
      }
    } catch (err) {
      message.error(`规则审核失败: ${(err as Error).message}`);
    } finally {
      setAuditLoading(false);
      setAuditProgress({ done: 0, total: 0 });
    }
  }, [data]);

  // ============ 下载审核CSV ============
  const downloadAuditCsv = useCallback(async () => {
    if (!auditResult) return;
    // 重新调用API获取CSV
    const auditItems = data.map(d => ({
      term: d.searchTerm,
      campaign: d.campaign || '',
      tag: d.tag,
      reason: d.reason || '',
      targetGroupName: d.mappedGroup || '',
      rowModel: d.model || '',
    }));
    try {
      const resp = await apiFetch('/api/neg-audit', {
        method: 'POST',
        body: JSON.stringify({ items: auditItems, format_csv: true }),
        timeoutMs: 120000,
      });
      if (resp.csv) {
        const blob = new Blob(['\ufeff' + resp.csv], { type: 'text/csv;charset=utf-8' });
        await downloadBlob({
          blob,
          fileName: `否词审核修正清单_${new Date().toISOString().slice(0, 10)}.csv`,
        });
        message.success('修正清单已下载');
      }
    } catch (err: any) {
      message.error(`下载失败: ${err?.message || err}`);
    }
  }, [auditResult, data]);

  // ============ 下载审核XLSX（多Sheet分类分页） ============
  const downloadAuditXlsx = useCallback(() => {
    if (!auditResult || !data.length) return;
    const auditItems = data.map(d => ({
      term: d.searchTerm, campaign: d.campaign || '',
      tag: d.tag, reason: d.reason || '',
      targetGroupName: d.mappedGroup || '', rowModel: d.model || '',
    }));
    // 调用后端生成XLSX并下载（通过Blob）
    apiFetch('/api/neg-audit', {
      method: 'POST',
      body: JSON.stringify({ items: auditItems, format_csv: false, format_xlsx: true }),
      timeoutMs: 120000,
    }).then(resp => {
      // 后端已保存到磁盘，告知用户路径
      message.success(`多Sheet Excel已保存到桌面 探险者ERP导出文件目录/audit_reports/ 目录`);
    }).catch(err => message.error(`导出失败: ${err.message}`));
  }, [auditResult, data]);

  // ============ 一键应用修正（将审核建议应用到数据表） ============
  const handleApplyFixes = useCallback(async (selectedIssues: any[]) => {
    if (!selectedIssues.length) {
      message.warning('请先选择要修正的问题项');
      return;
    }
    setApplyingFixes(true);
    try {
      let applied = 0;
      const newData = [...data];

      for (const issue of selectedIssues) {
        const term = issue.term?.toLowerCase().trim();
        if (!term) continue;

        // 找到数据表中对应的行
        const targetIdx = newData.findIndex(r => r.searchTerm.toLowerCase() === term);
        if (targetIdx === -1) continue;

        // 根据建议操作确定新标签
        const suggestion = (issue.suggestion || '').toLowerCase();
        let newTag: 'keep' | 'deny' | 'review' | undefined;
        const newReason = '规则校验修正';

        if (suggestion.includes('恢复保留') || suggestion.includes('改归') || suggestion.includes('保持现状')) {
          newTag = 'keep';
        } else if (suggestion.includes('补否') || suggestion.includes('直否')) {
          newTag = 'deny';
        } else if (suggestion.includes('跳过')) {
          newTag = 'review';
        }

        if (newTag && newTag !== newData[targetIdx].tag) {
          newData[targetIdx] = {
            ...newData[targetIdx],
            tag: newTag,
            tagLabel: newTag === 'keep' ? '保留' : newTag === 'deny' ? '否掉' : '待审',
            reason: newReason,
            manualOverride: true,
          };
          applied++;
        }
      }

      // 更新数据
      setData(newData);
      message.success(`已应用 ${applied} 条修正（${selectedIssues.length - applied} 条已匹配或无需修改）`);
    } catch (err) {
      message.error(`应用修正失败: ${(err as Error).message}`);
    } finally {
      setApplyingFixes(false);
    }
  }, [data]);

  // ============ 审核进度回调 ============
  const updateAuditProgress = useCallback((done: number, total: number) => {
    setAuditProgress({ done, total });
  }, []);

  // Filtered data
  const filteredData = useMemo(() => {
    return data.filter(row => {
      if (filter.tag && row.tag !== filter.tag) return false;
      if (filter.searchTerm && !row.searchTerm.toLowerCase().includes(filter.searchTerm.toLowerCase())) return false;
      if (filter.campaign && !row.campaign.toLowerCase().includes(filter.campaign.toLowerCase())) return false;
      return true;
    });
  }, [data, filter]);

  // Campaign list
  const campaignList = useMemo(() => {
    const set = new Set(data.map(d => d.campaign).filter(Boolean));
    return Array.from(set).sort();
  }, [data]);

  // ============ File Import ============

  const handleFileImport = useCallback((file: File) => {
    setLoading(true);
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const ab = e.target?.result;
        if (!ab) return;
        const wb = XLSX.read(ab, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });

        if (rows.length === 0) {
          message.warning('文件无数据');
          return;
        }

        const headers = Object.keys(rows[0]);
        const findColumn = (patterns: RegExp[], fallback?: (header: string) => boolean) => (
          headers.find(header => patterns.some(pattern => pattern.test(header)))
          || (fallback ? headers.find(fallback) : undefined)
        );
        const termCol = findColumn([
          /客户\s*搜索词/i,
          /顾客\s*搜索词/i,
          /search.?term/i,
          /customer.?search.?term/i,
        ]) || headers[0];
        // “Campaign ID” 不能误识别成活动名称；默认值只用于打开映射确认框，用户仍可手动改列。
        const detectedCampaignCol = findColumn([
          /^广告活动名称$/i,
          /^广告活动$/i,
          /^campaign\s*name$/i,
          /^campaign$/i,
        ], header => /campaign/i.test(header) && !/campaign[_\s-]*id|campaignid/i.test(header));
        // 当前赛狐否词报告：第 11 列是机型，页面原先把它误当成 Campaign 名称；
        // 按用户的工作流，页面展示列默认第 11 列，Campaign ID 匹配列另选实际活动名称列。
        const campaignCol = headers[10] || detectedCampaignCol || headers.find(header => header !== termCol) || headers[0] || '';
        // Campaign ID 对应的广告组合/活动名称默认优先使用表头识别到的列（本文件为 E 列），
        // 识别不到时按用户约定回退到 E 列。
        const campaignIdMatchCol = detectedCampaignCol || headers[4] || campaignCol;
        const campaignIdCol = findColumn([
          /广告活动\s*(?:ID|Id|id)/i,
          /^campaign[_\s-]*id$/i,
          /^campaignid$/i,
          /活动\s*编号/i,
        ]);
        const adGroupCol = findColumn([
          /广告组\s*(?:ID|Id|id)/i,
          /^ad.?group[_\s-]*id$/i,
          /广告组名称/i,
          /^广告组$/i,
          /ad.?group.?name/i,
          /^ad.?group$/i,
        ]);

        const mapping: ImportColumnMapping = {
          termCol,
          campaignCol,
          campaignIdMatchCol,
          campaignIdCol,
          adGroupCol,
          scope: 'campaign',
        };
        setPendingImport({ fileName: file.name, rows, headers, mapping });
        setImportMapping(mapping);
        setAmazonNegativeScope('campaign');
        message.info(`已读取 ${rows.length} 行，默认页面展示列=第${headers.indexOf(campaignCol) + 1}列；Campaign ID匹配列=第${headers.indexOf(campaignIdMatchCol) + 1}列，请确认后导入`);
      } catch (err) {
        message.error(`导入失败: ${(err as Error).message}`);
      } finally {
        setLoading(false);
      }
    };
    reader.readAsArrayBuffer(file);
    return false;
  }, []);

  /** 导入 ASIN 判定结果；这里只读取结果，不把 ASIN 混进搜索词分类表。 */
  const handleAsinFileImport = useCallback((file: File) => {
    setAsinLoading(true);
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const ab = e.target?.result;
        if (!ab) return;
        const wb = XLSX.read(ab, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
        if (rows.length === 0) {
          message.warning('ASIN判定文件无数据');
          return;
        }

        const headers = Object.keys(rows[0]);
        const findColumn = (patterns: RegExp[], fallback?: (header: string) => boolean) => (
          headers.find(header => patterns.some(pattern => pattern.test(header)))
          || (fallback ? headers.find(fallback) : undefined)
        );
        const asinCol = inferAsinColumn(headers, rows) || headers[0] || '';
        const resultCol = findColumn([
          /判定结果|判断结果|否定结果|筛选结果|否词结果/i,
          /decision|result|判定|是否否定|保留|否定/i,
          /tag|status/i,
        ]) || headers.find(header => header !== asinCol) || '';
        const campaignCol = findColumn([
          /^广告活动名称$/i,
          /^广告活动$/i,
          /广告活动名称.*参考/i,
          /^campaign\s*name$/i,
          /^campaign$/i,
        ], header => /campaign|广告活动/i.test(header) && !/id|编号/i.test(header)) || '';
        const campaignIdCol = findColumn([
          /^Campaign\s*ID$/i,
          /^Campaign\s*Id$/i,
          /广告活动\s*(?:ID|编号)/i,
          /活动编号/i,
        ]);
        const adGroupIdCol = findColumn([
          /^Ad\s*Group\s*ID$/i,
          /广告组\s*(?:ID|编号)/i,
          /ad.?group.?id/i,
        ]);
        const adGroupCol = findColumn([
          /^广告组名称$/i,
          /^广告组$/i,
          /广告组名称.*参考/i,
          /^Ad\s*Group\s*Name$/i,
          /^Ad\s*Group$/i,
        ], header => /ad.?group|广告组/i.test(header) && !/id|编号/i.test(header))
          || adGroupIdCol
          || '';
        const reasonCol = findColumn([
          /否词原因|判定依据|判定理由|原因|依据/i,
          /reason|evidence/i,
        ]);
        const countryCol = findColumn([
          /^国家\/地区$/i,
          /^国家$/i,
          /country|marketplace|站点/i,
        ]);
        const countryValue = countryCol
          ? rows.map(row => String(row[countryCol] ?? '').trim()).find(Boolean) || ''
          : '';
        const defaultScopeInfo = parseCampaignIdScope(defaultCampaignIdExportScope);
        const marketplace = detectMarketplaceFromText(
          `${file.name} ${countryValue}`,
          defaultScopeInfo.marketplace || activeMarketplace || 'US',
        );
        // Amazon 活动级官方模板也固定带有 Ad Group ID 表头，但该列为空；
        // 只有列内确实存在 ID 值时才默认广告组级。
        const defaultScope = inferAsinImportScope(adGroupIdCol, rows);
        const importScope = campaignIdScopeKey(
          defaultScopeInfo.storeId || activeShopKey || activeMarketplace || 'US',
          marketplace,
        );
        const mapping: AsinImportColumnMapping = {
          asinCol,
          resultCol,
          campaignCol,
          campaignIdMatchCol: campaignCol,
          campaignIdCol,
          adGroupCol,
          adGroupIdCol,
          reasonCol,
          selectedAdGroupValue: '',
          scope: defaultScope,
          storeId: defaultScopeInfo.storeId || activeShopKey || activeMarketplace || 'US',
          marketplace,
        };
        setPendingAsinImport({ fileName: file.name, rows, headers, mapping });
        setAsinImportMapping(mapping);
        setAsinNegativeScope(defaultScope);
        setAsinExportScope(importScope);
        message.info(
          `已读取 ${rows.length} 行 ASIN 判定结果；ASIN=${asinCol || '未识别'}；站点=${marketplace}；${defaultScope === 'campaign' ? '未检测到真实 Ad Group ID，默认广告活动级导出' : '检测到 Ad Group ID，默认广告组级导出'}，请确认后导入`,
        );
      } catch (err) {
        message.error(`ASIN判定结果导入失败: ${(err as Error).message}`);
      } finally {
        setAsinLoading(false);
      }
    };
    reader.readAsArrayBuffer(file);
    return false;
  }, [activeMarketplace, activeShopKey, defaultCampaignIdExportScope]);

  const handleConfirmAsinImport = useCallback(async () => {
    if (!pendingAsinImport || !asinImportMapping) return;
    const mapping = asinImportMapping;
    if (!mapping.asinCol || !mapping.resultCol) {
      message.warning('请先选择 ASIN 列和判定结果列');
      return;
    }
    if (!mapping.campaignCol && !mapping.campaignIdCol) {
      message.warning('请先选择广告活动名称列，或选择源文件中的 Campaign ID 列');
      return;
    }
    if (mapping.scope === 'adGroup' && !mapping.adGroupCol && !mapping.adGroupIdCol) {
      message.warning('广告组级否 ASIN 必须选择广告组名称/标识列或 Ad Group ID 列');
      return;
    }

    setAsinImportConfirming(true);
    try {
      const { rows, headers } = pendingAsinImport;
      const textValue = (value: unknown) => value == null ? '' : String(value).trim();
      const scopeKey = campaignIdScopeKey(mapping.storeId, mapping.marketplace);
      const selectedScopeOption = campaignIdScopeOptions.find(option => option.scope === scopeKey);
      const scopeAliases = campaignIdScopeAliases(selectedScopeOption || {
        scope: scopeKey,
        storeId: mapping.storeId,
        storeName: mapping.storeId,
        marketplace: mapping.marketplace,
      }, campaignIdScopeOptions);
      const normalizeName = (value: unknown) => normalizeCampaignName(textValue(value));
      // 兼容旧版误把日期列保存为 ASIN 的导入结果：如果确认框中选到的列
      // 当前行不是有效 ASIN，则回退到按样本自动识别出的 ASIN 列。
      const fallbackAsinCol = inferAsinColumn(headers, rows);

      // 先读取本地活动/广告组数据，源文件没有 ID 时只接受唯一映射。
      const campaignIdsByName = new Map<string, Set<string>>();
      const adGroupIdsByKey = new Map<string, Set<string>>();
      const addSetValue = (map: Map<string, Set<string>>, key: string, value: string) => {
        if (!key || !value) return;
        const values = map.get(key) || new Set<string>();
        values.add(value);
        map.set(key, values);
      };
      const adGroupKey = (campaignName: unknown, adGroupName: unknown) => (
        `${normalizeName(campaignName)}\u0000${normalizeName(adGroupName)}`
      );
      try {
        const campaignRecords = await db.campaigns.toArray();
        for (const candidate of campaignRecords as any[]) {
          const recordScope = textValue(candidate.storeMarketplace).toUpperCase();
          if (recordScope && !scopeAliases.includes(recordScope)) continue;
          addSetValue(campaignIdsByName, normalizeName(candidate.campaignName || candidate.name), textValue(candidate.campaignId || candidate.id));
        }
      } catch {
        // IndexedDB 不可用时，仍可依赖导入的 Campaign ID 映射文件。
      }
      try {
        const [adGroupRecords, keywordRecords] = await Promise.all([
          db.amzAdGroups.toArray().catch(() => [] as any[]),
          db.keywords.toArray().catch(() => [] as any[]),
        ]);
        for (const candidate of [...adGroupRecords, ...keywordRecords]) {
          const recordScope = textValue(candidate.store_marketplace || candidate.storeMarketplace).toUpperCase();
          if (recordScope && !scopeAliases.includes(recordScope)) continue;
          const campaignName = candidate.campaignName || candidate.campaign_name || '';
          const campaignId = textValue(candidate.campaign_id || candidate.campaignId);
          const adGroupName = candidate.adGroupName || candidate.ad_group_name || candidate.name || '';
          const adGroupId = textValue(candidate.ad_group_id || candidate.adGroupId);
          if (!adGroupId) continue;
          addSetValue(adGroupIdsByKey, adGroupKey(campaignName, adGroupName), adGroupId);
          addSetValue(adGroupIdsByKey, adGroupKey('', adGroupName), adGroupId);
          if (campaignId) addSetValue(adGroupIdsByKey, adGroupKey(campaignId, adGroupName), adGroupId);
        }
      } catch {
        // 没有实时广告组缓存时，要求源文件直接提供 Ad Group ID。
      }

      const resolveUnique = (values?: Set<string>) => values && values.size === 1 ? Array.from(values)[0] : '';
      const resolveCampaignIdFromSources = (campaignName: string, inlineId: string) => {
        if (inlineId) return inlineId;
        const resolved = resolveCampaignId(campaignIdMappings, campaignName, scopeKey, scopeAliases);
        if (resolved.campaignId) return resolved.campaignId;
        return resolveUnique(campaignIdsByName.get(normalizeName(campaignName)));
      };
      const resolveAdGroupIdFromSources = (
        campaignName: string,
        campaignId: string,
        adGroupValue: string,
        inlineId: string,
      ) => {
        if (inlineId) return inlineId;
        if (/^\d{8,}$/.test(adGroupValue.replace(/\.0$/, ''))) return adGroupValue.replace(/\.0$/, '');
        return resolveUnique(
          adGroupIdsByKey.get(adGroupKey(campaignName, adGroupValue))
          || adGroupIdsByKey.get(adGroupKey(campaignId, adGroupValue))
          || adGroupIdsByKey.get(adGroupKey('', adGroupValue)),
        );
      };

      const parsed: AsinRow[] = rows.map((row, index) => {
        const asin = normalizeAsin(row[mapping.asinCol]) || normalizeAsin(row[fallbackAsinCol]);
        const decision = normalizeAsinDecision(row[mapping.resultCol]);
        const campaignName = textValue(mapping.campaignCol ? row[mapping.campaignCol] : '');
        const campaignMatchName = textValue(mapping.campaignIdMatchCol ? row[mapping.campaignIdMatchCol] : campaignName);
        const inlineCampaignId = mapping.campaignIdCol ? textValue(row[mapping.campaignIdCol]) : '';
        const campaignId = resolveCampaignIdFromSources(campaignMatchName || campaignName, inlineCampaignId);
        const rawAdGroupValue = mapping.selectedAdGroupValue || textValue(mapping.adGroupCol ? row[mapping.adGroupCol] : '');
        const inlineAdGroupId = mapping.adGroupIdCol ? textValue(row[mapping.adGroupIdCol]).replace(/\.0$/, '') : '';
        const adGroupId = mapping.scope === 'adGroup'
          ? resolveAdGroupIdFromSources(campaignMatchName || campaignName, campaignId, rawAdGroupValue, inlineAdGroupId)
          : '';
        const reason = mapping.reasonCol ? textValue(row[mapping.reasonCol]) : '';
        return {
          key: `asin-${index}`,
          index: index + 1,
          asin,
          decision,
          decisionLabel: decision === 'deny' ? '🔴 否定' : decision === 'keep' ? '🟢 保留' : '🟡 待审',
          campaignName: campaignName || campaignMatchName,
          campaignId,
          adGroupName: rawAdGroupValue,
          adGroupId,
          reason,
          scope: scopeKey,
          rawRow: row,
        };
      });

      setAsinRows(parsed);
      setAsinNegativeScope(mapping.scope);
      setAsinExportScope(scopeKey);
      setPendingAsinImport(null);
      setAsinImportMapping(null);
      setActiveTab('asin-negative');
      const denied = parsed.filter(row => row.decision === 'deny').length;
      const mappedCampaigns = parsed.filter(row => row.decision === 'deny' && row.campaignId).length;
      const mappedAdGroups = parsed.filter(row => row.decision === 'deny' && row.adGroupId).length;
      const validAsins = parsed.filter(row => row.asin).length;
      const columnPosition = (column?: string) => column ? `第${headers.indexOf(column) + 1}列「${column}」` : '未选择';
      message.success(`已导入 ${parsed.length} 条 ASIN 判定结果；有效 ASIN ${validAsins} 条；否定 ${denied} 条；Campaign ID 已匹配 ${mappedCampaigns} 条；Ad Group ID 已匹配 ${mappedAdGroups} 条；站点=${mapping.marketplace}；ASIN=${columnPosition(mapping.asinCol)}${mapping.asinCol !== fallbackAsinCol ? `（自动兜底列=${columnPosition(fallbackAsinCol)}）` : ''}；广告组=${columnPosition(mapping.adGroupCol || mapping.adGroupIdCol)}`);
    } catch (err) {
      message.error(`确认导入 ASIN 判定结果失败: ${(err as Error).message}`);
    } finally {
      setAsinImportConfirming(false);
    }
  }, [asinImportMapping, campaignIdMappings, campaignIdScopeOptions, pendingAsinImport]);

  // ============ ASIN 智能自动判定 (调取西柚MCP) ============

  const handleAutoAsinFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const buffer = evt.target?.result;
        const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
        const firstSheet = wb.SheetNames[0];
        const ws = wb.Sheets[firstSheet];
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
        if (rows.length === 0) {
          message.warning('导入的文件没有有效数据行');
          return;
        }
        const headers = Object.keys(rows[0] || {});
        const asinCol = inferAsinColumn(headers, rows);
        const modelCol = headers.find(h => /机型|型号|model/i.test(h)) || headers.find(h => /广告活动/i.test(h)) || '';
        const campaignCol = headers.find(h => /广告活动名称|活动名称|campaign/i.test(h)) || '';
        const adGroupCol = headers.find(h => /广告组名称|广告组|adgroup/i.test(h)) || '';
        const countryCol = headers.find(h => /国家|地区|country|marketplace|站点/i.test(h)) || '';
        const countrySample = countryCol ? String(rows[0]?.[countryCol] || '').trim() : '';
        const detectedCountry = detectMarketplaceFromText(`${file.name} ${countrySample}`, activeMarketplace || 'US');

        setAutoAsinPendingFile({ fileName: file.name, rows, headers });
        setAutoAsinMapping({
          asinCol: asinCol || headers[0] || '',
          modelCol: modelCol || '',
          campaignCol: campaignCol || '',
          adGroupCol: adGroupCol || '',
          country: detectedCountry || 'US',
        });
        setAutoAsinModalVisible(true);
      } catch (err: any) {
        message.error(`文件解析失败: ${err.message || err}`);
      }
    };
    reader.readAsArrayBuffer(file);
  }, [activeMarketplace]);

  const handleRunAutoAsinAudit = useCallback(async () => {
    if (!autoAsinPendingFile || !autoAsinMapping.asinCol) {
      message.warning('请选择有效 ASIN 列');
      return;
    }
    setAutoAsinLoading(true);
    setAutoAsinProgress({ done: 0, total: autoAsinPendingFile.rows.length, text: '正在调用西柚 MCP 批量获取标题五点与机型匹配...' });

    try {
      const { rows } = autoAsinPendingFile;
      const { asinCol, modelCol, campaignCol, adGroupCol, country } = autoAsinMapping;

      const preparedRows = rows.map((r) => {
        const item: Record<string, unknown> = { ...r };
        item['客户搜索词'] = r[asinCol] || r['客户搜索词'] || r['ASIN'] || '';
        if (modelCol && r[modelCol]) item['机型'] = r[modelCol];
        if (campaignCol && r[campaignCol]) item['广告活动名称'] = r[campaignCol];
        if (adGroupCol && r[adGroupCol]) item['广告组名称'] = r[adGroupCol];
        item['国家/地区'] = country;
        return item;
      });

      const res = await apiFetch('/api/asin/audit-batch', {
        method: 'POST',
        body: JSON.stringify({
          items: preparedRows,
          country: country.toUpperCase(),
          campaign_id_mappings: campaignIdMappings,
        }),
      });

      if (!res || !Array.isArray(res.records)) {
        throw new Error(res?.error || '后端未返回有效判定结果');
      }

      const judgedRecords = res.records;
      const scopeKey = campaignIdScopeKey(activeShopKey || activeMarketplace || 'US', country);

      const nextAsinRows: AsinRow[] = judgedRecords.map((item: any, idx: number) => {
        const dec = item.decision;
        const decTag: AsinDecision = dec === '否定' ? 'deny' : dec === '保留' ? 'keep' : 'review';
        return {
          key: item.key || `asin-row-${idx + 1}-${item.asin}`,
          index: idx + 1,
          asin: item.asin,
          decision: decTag,
          decisionLabel: dec || (decTag === 'deny' ? '否定' : decTag === 'keep' ? '保留' : '待复核'),
          campaignName: item.campaignName || '',
          campaignId: item.campaignId || '',
          adGroupName: item.adGroupName || '',
          adGroupId: item.adGroupId || '',
          reason: item.reason || '',
          scope: scopeKey,
          title: item.title || '',
          verifySource: item.verifySource || '',
          verifyDate: item.verifyDate || '',
          targetModel: item.targetModel || '',
          rawRow: item.rawRow,
        };
      });

      setAsinRows(nextAsinRows);
      setAsinExportScope(scopeKey);
      setAutoAsinModalVisible(false);

      const denyCount = nextAsinRows.filter(r => r.decision === 'deny').length;
      const keepCount = nextAsinRows.filter(r => r.decision === 'keep').length;
      const reviewCount = nextAsinRows.filter(r => r.decision === 'review').length;

      message.success(`🎉 自动判定完成！共 ${nextAsinRows.length} 条数据（明确否定: ${denyCount}，明确保留: ${keepCount}，待复核: ${reviewCount}）`);
    } catch (err: any) {
      message.error(`自动判定失败: ${err.message || err}`);
    } finally {
      setAutoAsinLoading(false);
    }
  }, [autoAsinPendingFile, autoAsinMapping, campaignIdMappings, activeShopKey, activeMarketplace]);

  const handleExportAsinFolder = useCallback(async () => {
    if (asinRows.length === 0) {
      message.warning('当前没有可导出的判定记录');
      return;
    }
    setAsinFolderExporting(true);
    try {
      const rawItems = asinRows.map(r => ({
        ...(r.rawRow || {}),
        '判定': r.decisionLabel || (r.decision === 'deny' ? '否定' : r.decision === 'keep' ? '保留' : '待复核'),
        '商品详情标题': r.title || '',
        '判定依据': r.reason || '',
        '核验来源': r.verifySource || '',
        '核验日期': r.verifyDate || '',
        'Campaign ID': r.campaignId || '',
        'Ad Group ID': r.adGroupId || '',
        '广告活动名称': r.campaignName || '',
        '广告组名称': r.adGroupName || '',
        '客户搜索词': r.asin || '',
        '机型': r.targetModel || (r.rawRow as any)?.['机型'] || '',
      }));
      const scope = asinNegativeScope || 'campaign';
      const country = (asinExportScope || activeMarketplace || 'US').split('-').pop() || 'US';
      const res = await apiFetch('/api/asin/export-folder', {
        method: 'POST',
        body: JSON.stringify({
          records: rawItems,
          country,
          scope,
        }),
      });

      if (res && res.folderPath) {
        Modal.success({
          title: '🎉 ASIN 判定结果文件夹导出成功！',
          width: 520,
          content: (
            <div style={{ marginTop: 12 }}>
              <p>已在本地自动生成完整判定结果文件夹：</p>
              <div style={{ background: '#f8fafc', padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: 6, marginBottom: 12 }}>
                <Text code copyable style={{ fontSize: 13, wordBreak: 'break-all' }}>{res.folderPath}</Text>
              </div>
              <div style={{ background: '#f0fdf4', padding: '10px 14px', border: '1px solid #bbf7d0', borderRadius: 6, fontSize: 13 }}>
                <div style={{ marginBottom: 4 }}>📊 <b>完整判定明细 Excel</b>: {res.excelFileName} (共 {res.totalRecords} 条)</div>
                <div>⚡ <b>Amazon否ASIN上传模板</b>: {res.templateFileName} (已提取 {res.denyCount} 条否定定向)</div>
              </div>
            </div>
          ),
          okText: '📂 在资源管理器中打开文件夹',
          cancelText: '关闭',
          okCancel: true,
          onOk: async () => {
            try {
              await apiFetch('/api/asin/open-folder', {
                method: 'POST',
                body: JSON.stringify({ folder_path: res.folderPath }),
              });
            } catch (e: any) {
              message.error(`打开文件夹失败: ${e.message}`);
            }
          },
        });
      } else {
        message.error(res?.error || '导出文件夹失败');
      }
    } catch (err: any) {
      message.error(`导出文件夹失败: ${err.message || err}`);
    } finally {
      setAsinFolderExporting(false);
    }
  }, [asinRows, asinNegativeScope, asinExportScope, activeMarketplace]);

  const handleExportAsinFullExcel = useCallback(() => {
    if (asinRows.length === 0) {
      message.warning('当前没有判定记录');
      return;
    }
    try {
      const country = (asinExportScope || activeMarketplace || 'US').split('-').pop() || 'US';
      const firstRaw = asinRows[0].rawRow || {};
      const rawKeys = Object.keys(firstRaw).filter(k => !['判定', '商品详情标题', '判定依据', '核验来源', '核验日期'].includes(k));
      const headers = [...rawKeys, '判定', '商品详情标题', '判定依据', '核验来源', '核验日期'];

      const aoa: any[][] = [headers];
      for (const item of asinRows) {
        const raw = item.rawRow || {};
        const rowVals = rawKeys.map(k => raw[k] ?? '');
        rowVals.push(
          item.decisionLabel || (item.decision === 'deny' ? '否定' : item.decision === 'keep' ? '保留' : '待复核'),
          item.title || '',
          item.reason || '',
          item.verifySource || '',
          item.verifyDate || '',
        );
        aoa.push(rowVals);
      }
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, `ASIN判定表_${country}`);
      const fileName = `ASIN判定表_${country}_${new Date().toISOString().slice(0, 10)}.xlsx`;
      void exportWorkbook({ wb, fileName: fileName.replace(/\.xlsx$/, ''), cellStyles: true });
      message.success(`已导出完整判定表: ${fileName}`);
    } catch (err: any) {
      message.error(`导出Excel失败: ${err.message || err}`);
    }
  }, [asinRows, asinExportScope, activeMarketplace]);

  // ============ Classification ============

  const processClassification = useCallback(async (rows: KeywordRow[]) => {
    if (rows.length === 0) return;

    setProcessing(true);
    setProgress({ done: 0, total: rows.length });

    try {
      const BATCH_SIZE = 100;
      const allResults: ClassifyResult[] = [];
      let done = 0;

      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const items = batch.map(r => {
          const modelCode = resolveModelCode(r.campaign);
          return {
            term: r.searchTerm,
            campaign: r.campaign,
            rowModel: r.model || modelCode || undefined,
            // 不传 targetGroupName：让后端通过 campaign_group_map 自行查找正确的组名
            // 前端 extractModelName 可能返回代码格式(如 A32/5G)而非组名(如 Samsung Galaxy A32)，
            // 导致后端 model_groups 匹配失败→误判为"未匹配拓词"
          };
        });
        const results = await apiFetch('/classify', {
          method: 'POST',
          body: JSON.stringify({
            items,
            require_case: requireCase,
            intercept_brand: interceptBrand,
            site: String(activeMarketplaceRef.current || 'US').toLowerCase(),
          }),
          // v5.2-hotfix(2026-08-31): 60000→600000 (10分钟)
          //   15000 条数据实测 ~45s，但 Python _lock 全局锁 + IO 抖动会让单批卡 60s+ → signal timed out
          //   10min timeout 覆盖 30 万条数据场景
          timeoutMs: 600000,
        });
        allResults.push(...(results.results || []));
        done += batch.length;
        setProgress({ done, total: rows.length });
      }

      const updated = rows.map((row, i) => {
        const result = allResults[i];
        if (!result) return row;
        const tag = result.tag as 'deny' | 'keep' | 'review';
        return {
          ...row,
          tag,
          tagLabel: tag === 'deny' ? '🔴 否掉' : tag === 'keep' ? '🟢 保留' : '🟡 待审',
          reason: result.reason || '未知',
          confidence: 'high' as const,
          mappedGroup: result.targetGroupName || undefined,
          manualOverride: false,
        };
      });

      setData(updated);
      const denyCount = updated.filter(r => r.tag === 'deny').length;
      const keepCount = updated.filter(r => r.tag === 'keep').length;
      const reviewCount = updated.filter(r => r.tag === 'review').length;
      message.success(`分类完成：否掉 ${denyCount} | 保留 ${keepCount} | 待审 ${reviewCount}`);
    } catch (err) {
      message.error(`分类失败: ${(err as Error).message}`);
    } finally {
      setProcessing(false);
    }
  }, [requireCase, interceptBrand]);

  const handleConfirmImportMapping = useCallback(async () => {
    if (!pendingImport || !importMapping) return;

    const mapping = importMapping;
    if (!mapping.termCol || !mapping.campaignCol || !mapping.campaignIdMatchCol) {
      message.warning('请先选择搜索词列、页面展示列和 Campaign ID 匹配列');
      return;
    }
    if (mapping.termCol === mapping.campaignCol || mapping.termCol === mapping.campaignIdMatchCol) {
      message.warning('搜索词列不能与页面展示列或 Campaign ID 匹配列相同');
      return;
    }
    if (mapping.scope === 'adGroup' && !mapping.adGroupCol) {
      message.warning('选择广告组否词时，必须选择 Ad Group ID 所在列');
      return;
    }

    setImportConfirming(true);
    try {
      const { rows, headers } = pendingImport;
      const textValue = (value: unknown) => value == null ? '' : String(value).trim();
      const normalizeCampaign = (value: string) => textValue(value).toLocaleLowerCase().replace(/\s+/g, ' ');
      const findColumn = (patterns: RegExp[]) => headers.find(header => patterns.some(pattern => pattern.test(header)));
      const volumeCol = findColumn([/搜索量|search.?volume|volume/i]);
      const modelCol = findColumn([/机型|model|product/i]);

      // 优先使用独立导入的“活动名称—Campaign ID”映射；
      // 同名活动对应多个 ID 时保持空值，避免把其他店铺或历史活动写入上传模板。
      const campaignIdsByName = new Map<string, string>();
      const ambiguousCampaignNames = new Set<string>();
      const currentMarketplace = String(activeMarketplaceRef.current || 'US').trim().toUpperCase();
      const currentStoreId = normalizeCampaignScope(activeStoreScopeRef.current || currentMarketplace);
      const currentStoreScope = campaignIdScopeKey(currentStoreId, currentMarketplace);
      const currentScopeOption = campaignIdScopeOptions.find(option => option.scope === currentStoreScope);
      const currentScopeAliases = campaignIdScopeAliases(currentScopeOption, campaignIdScopeOptions);
      const scopedMappings = campaignIdMappings.filter(record => (
        currentScopeAliases.includes(normalizeCampaignScope(record.storeMarketplace))
      ));
      const exactScopedMappings = scopedMappings.filter(record => (
        normalizeCampaignScope(record.storeMarketplace) === currentStoreScope
      ));
      for (const record of (exactScopedMappings.length > 0 ? exactScopedMappings : scopedMappings)) {
        const normalizedName = normalizeCampaign(record.campaignName);
        if (!normalizedName) continue;
        const id = textValue(record.campaignId);
        if (record.ambiguous || (record.conflictIds || []).length > 1 || !id) {
          if (record.ambiguous || (record.conflictIds || []).length > 1) ambiguousCampaignNames.add(normalizedName);
          campaignIdsByName.delete(normalizedName);
          continue;
        }
        const previous = campaignIdsByName.get(normalizedName);
        if (previous && previous !== id) {
          campaignIdsByName.delete(normalizedName);
          ambiguousCampaignNames.add(normalizedName);
        } else if (!ambiguousCampaignNames.has(normalizedName)) {
          campaignIdsByName.set(normalizedName, id);
        }
      }

      // 映射文件没有覆盖的活动，再尝试从当前店铺 IndexedDB 活动数据补齐；
      // 仅使用唯一 ID，绝不在多个候选中猜测。
      try {
        const campaignCandidates = new Map<string, Set<string>>();
        const campaignRecords = await db.campaigns.toArray();
        for (const record of campaignRecords) {
          const candidate = record as any;
          const name = textValue(candidate.campaignName || candidate.name);
          const campaignId = textValue(candidate.campaignId);
          const recordMarketplace = textValue(candidate.storeMarketplace).toUpperCase();
          if (!name || !campaignId || (recordMarketplace && !currentScopeAliases.includes(recordMarketplace))) continue;
          const normalizedName = normalizeCampaign(name);
          if (ambiguousCampaignNames.has(normalizedName) || campaignIdsByName.has(normalizedName)) continue;
          const ids = campaignCandidates.get(normalizedName) || new Set<string>();
          ids.add(campaignId);
          campaignCandidates.set(normalizedName, ids);
        }
        for (const [name, ids] of campaignCandidates) {
          if (ids.size === 1 && !ambiguousCampaignNames.has(name)) campaignIdsByName.set(name, Array.from(ids)[0]);
        }
      } catch {
        // IndexedDB 不可用时仍可正常导入与分类，导出检查页会提示补齐 ID。
      }

      const parsed: KeywordRow[] = rows.map((row, i) => {
        const campaign = textValue(row[mapping.campaignCol]);
        const campaignIdMatchName = textValue(row[mapping.campaignIdMatchCol]);
        const normalizedCampaign = normalizeCampaign(campaignIdMatchName);
        const inlineCampaignId = mapping.campaignIdCol ? textValue(row[mapping.campaignIdCol]) : '';
        // 先读取持久化映射。resolveCampaignId 会优先使用当前店铺作用域，
        // 作用域键发生过历史变更时，仅在全局同名且唯一 ID 的情况下回填。
        const persistedResolution = resolveCampaignId(
          campaignIdMappings,
          campaignIdMatchName,
          currentStoreScope,
          currentScopeAliases,
        );
        const persistedCampaignId = persistedResolution.campaignId
          || (ambiguousCampaignNames.has(normalizedCampaign) ? '' : campaignIdsByName.get(normalizedCampaign) || '');
        return {
          key: `row-${i}`,
          index: i + 1,
          searchTerm: textValue(row[mapping.termCol]),
          campaign,
          campaignIdMatchName,
          campaignId: inlineCampaignId || persistedCampaignId,
          campaignIdScope: currentStoreScope,
          campaignIdAmbiguous: !inlineCampaignId && (persistedResolution.ambiguous || (!persistedResolution.campaignId && ambiguousCampaignNames.has(normalizedCampaign))),
          // 活动级否词明确不带 Ad Group；广告组级才从用户选定的列读取。
          adGroup: mapping.scope === 'adGroup' && mapping.adGroupCol
            ? textValue(row[mapping.adGroupCol])
            : '',
          model: modelCol ? textValue(row[modelCol]) : '',
          searchVolume: volumeCol ? textValue(row[volumeCol]) : '',
          tag: 'review' as const,
          tagLabel: '🟡 待审',
          reason: '未分类',
          confidence: 'high' as const,
          rawRow: row,
        };
      }).filter(row => row.searchTerm || row.campaign);

      if (parsed.length === 0) {
        message.warning('按当前列映射没有读到有效数据，请检查搜索词列和广告活动名称列');
        return;
      }

      const skippedBlankRows = rows.length - parsed.length;
      const missingCampaignRows = parsed.filter(row => !row.campaign).length;
      const autoCampaignIdMatches = mapping.campaignIdCol ? 0 : parsed.filter(row => Boolean(row.campaignId)).length;
      const campaignIdConflictRows = parsed.filter(row => row.campaignIdAmbiguous).length;
      const missingAdGroupRows = mapping.scope === 'adGroup' ? parsed.filter(row => !row.adGroup).length : 0;
      const columnPosition = (column?: string) => column ? `第${headers.indexOf(column) + 1}列「${column}」` : '未选择';

      setAmazonNegativeScope(mapping.scope);
      setData(parsed);
      setPendingImport(null);
      setImportMapping(null);
      const notices = [
        `已导入 ${parsed.length} 条搜索词`,
        `搜索词=${columnPosition(mapping.termCol)}`,
        `页面展示列=${columnPosition(mapping.campaignCol)}`,
        `Campaign ID匹配列=${columnPosition(mapping.campaignIdMatchCol)}`,
        mapping.scope === 'adGroup'
          ? `广告组否词，Ad Group ID=${columnPosition(mapping.adGroupCol)}`
          : '广告活动否词（不填写 Ad Group ID）',
          mapping.campaignIdCol
            ? `已读取Campaign ID=${columnPosition(mapping.campaignIdCol)}`
            : autoCampaignIdMatches > 0
            ? `已从映射文件/ERP活动数据自动匹配Campaign ID ${autoCampaignIdMatches} 条`
            : '未提供Campaign ID（可先到“Campaign ID”页导入映射）',
      ];
      if (skippedBlankRows > 0) notices.push(`跳过空行 ${skippedBlankRows} 条`);
      if (missingCampaignRows > 0) notices.push(`缺少活动名称 ${missingCampaignRows} 条`);
      if (missingAdGroupRows > 0) notices.push(`缺少Ad Group ID ${missingAdGroupRows} 条，导出时会跳过`);
      if (campaignIdConflictRows > 0) notices.push(`Campaign ID 冲突 ${campaignIdConflictRows} 条，导出时留空`);
      message.success(notices.join('；'));
      await processClassification(parsed);
    } catch (err) {
      message.error(`确认导入失败: ${(err as Error).message}`);
    } finally {
      setImportConfirming(false);
    }
  }, [campaignIdMappings, campaignIdScopeOptions, pendingImport, importMapping, processClassification]);

  const handleReprocess = useCallback(async () => {
    if (data.length === 0) {
      message.warning('请先导入数据');
      return;
    }
    const resetData = data.map(r => ({ ...r, manualOverride: false }));
    await processClassification(resetData);
  }, [data, processClassification]);

  // ============ Manual Tag Changes ============

  const handleTagChange = useCallback((key: string, newTag: 'deny' | 'keep' | 'review') => {
    setData(prev => prev.map(row => {
      if (row.key !== key) return row;
      return {
        ...row,
        tag: newTag,
        tagLabel: newTag === 'deny' ? '🔴 否掉' : newTag === 'keep' ? '🟢 保留' : '🟡 待审',
        reason: '手动修改',
        manualOverride: true,
      };
    }));
  }, []);

  const handleBatchTag = useCallback((newTag: 'deny' | 'keep' | 'review') => {
    if (selectedRowKeys.length === 0) return;
    setData(prev => prev.map(row => {
      if (!selectedRowKeys.includes(row.key)) return row;
      return {
        ...row,
        tag: newTag,
        tagLabel: newTag === 'deny' ? '🔴 否掉' : newTag === 'keep' ? '🟢 保留' : '🟡 待审',
        reason: '批量修改',
        manualOverride: true,
      };
    }));
    setSelectedRowKeys([]);
    message.success(`已修改 ${selectedRowKeys.length} 条`);
  }, [selectedRowKeys]);

  // ============ Export ============

  const handleExport = useCallback(() => {
    if (data.length === 0) return;
    const hasRaw = data.some(r => r.rawRow && Object.keys(r.rawRow).length > 0);
    if (hasRaw) {
      // Format like batch_classify: insert 否词结果+匹配词 after search term column
      const headers = Object.keys(data[0].rawRow!);
      const termColIdx = headers.findIndex(h => /客户搜索词|顾客搜索词|search.?term|customer.?search.?term/i.test(h));
      const insertAfter = termColIdx >= 0 ? termColIdx + 1 : 2; // after B column (search term)

      const newHeaders = [...headers.slice(0, insertAfter), '否词结果', '匹配词', ...headers.slice(insertAfter)];
      const outRows: unknown[][] = [newHeaders];

      for (const row of data) {
        const origVals = headers.map(h => row.rawRow![h] ?? '');
        const reasonText = row.tag === 'deny' ? `否掉: ${row.reason}` : row.tag === 'keep' ? `保留: ${row.reason}` : `待审: ${row.reason}`;
        const matchText = row.mappedGroup || row.reason || '';
        origVals.splice(insertAfter, 0, reasonText, matchText);
        outRows.push(origVals);
      }

      const ws = XLSX.utils.aoa_to_sheet(outRows);
      const colWidths = headers.map(() => ({ wch: 14 }));
      colWidths.splice(insertAfter, 0, { wch: 40 }, { wch: 25 });
      ws['!cols'] = colWidths;

      // Apply red font to deny rows
      const totalCols = newHeaders.length;
      const redStyle = { font: { color: { rgb: 'FF0000' } } };
      for (let ri = 1; ri < outRows.length; ri++) {
        const row = data[ri - 1];
        if (row.tag === 'deny') {
          for (let ci = 0; ci < totalCols; ci++) {
            const cellRef = XLSX.utils.encode_cell({ r: ri, c: ci });
            const cell = ws[cellRef];
            if (cell) {
              cell.s = redStyle;
            }
          }
        }
      }

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '否词结果');
      const fileName = `否词标注结果_${new Date().toISOString().slice(0, 10)}.xlsx`;
      void exportWorkbook({ wb, fileName: fileName.replace(/\.xlsx$/, ''), cellStyles: true });
      message.success(`已导出: ${fileName}`);
    } else {
      // Fallback: no raw data, export summary
      const exportData = data.map(row => ({
        '序号': row.index,
        '顾客搜索词': row.searchTerm,
        '广告活动': row.campaign,
        '机型': row.model,
        '搜索量': row.searchVolume,
        '标注': row.tagLabel,
        '命中原因': row.reason,
      }));
      const ws = XLSX.utils.json_to_sheet(exportData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '否词标注');
      ws['!cols'] = [{ wch: 6 }, { wch: 40 }, { wch: 30 }, { wch: 20 }, { wch: 10 }, { wch: 10 }, { wch: 35 }];
      const fileName = `否词标注结果_${new Date().toISOString().slice(0, 10)}.xlsx`;
      void exportWorkbook({ wb, fileName: fileName.replace(/\.xlsx$/, ''), cellStyles: true });
      message.success(`已导出: ${fileName}`);
    }
  }, [data]);

  // 导出按机型组分列格式（保留+否掉两个Sheet）
  const handleExportByGroup = useCallback(() => {
    if (data.length === 0) return;

    // 收集所有出现的 campaign（广告活动名称，去重，过滤空值），按自然字母顺序排列
    // v5.2-hotfix(2026-08-31): 加 .sort() 让导出更易读；
    //   用 localeCompare + numeric: true 让 S10 < S20 < S23（自然排序），避免 ASCII 排序的 S10 > S2 反直觉。
    //   用 Campaign 名称作为列头归类，而非 mappedGroup（后端返回的机型组名可能为空或不准）
    const groupHeaders: string[] = [];
    const seen = new Set<string>();
    for (const row of data) {
      const g = (row.campaign || '').trim();
      if (g && !seen.has(g)) {
        seen.add(g);
        groupHeaders.push(g);
      }
    }
    groupHeaders.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const allHeaders = [...groupHeaders, '未匹配'];

    // 分离保留 / 否掉数据
    const keepRows = data.filter(r => r.tag === 'keep');
    const denyRows = data.filter(r => r.tag === 'deny');

    // 构建表头：每个机型组占2列（搜索词 + 原因）
    const headerRow: unknown[] = [];
    for (const h of allHeaders) {
      headerRow.push(h, '原因');
    }

    // 构建单页数据：每个机型组占2列，搜索词在奇数列，原因在偶数列
    function buildSheetAOA(rows: KeywordRow[]): unknown[][] {
      const aoa: unknown[][] = [headerRow];
      // 按列索引收集数据：每个机型组的[搜索词, 原因]对
      const colPairs: [string, string][][] = allHeaders.map(() => []);
      for (const row of rows) {
        const g = (row.campaign || '').trim();
        const colIdx = g && allHeaders.indexOf(g) >= 0 ? allHeaders.indexOf(g) : allHeaders.length - 1;
        const term = row.searchTerm || '';
        if (term) {
          colPairs[colIdx].push([term, row.reason || '']);
        }
      }
      // v5.2-hotfix(2026-08-31): 每个机型组下的搜索词按自然字母排序
      for (const pair of colPairs) {
        pair.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' }));
      }
      const maxLen = Math.max(...colPairs.map(c => c.length), 0);
      for (let ri = 0; ri < maxLen; ri++) {
        const rowData: unknown[] = [];
        for (let ci = 0; ci < allHeaders.length; ci++) {
          if (colPairs[ci][ri]) {
            rowData.push(colPairs[ci][ri][0], colPairs[ci][ri][1]);
          } else {
            rowData.push('', '');
          }
        }
        aoa.push(rowData);
      }
      return aoa;
    }

    const wb = XLSX.utils.book_new();

    // 列宽：搜索词列宽30，原因列宽25
    const colWidths: { wch: number }[] = [];
    for (let i = 0; i < allHeaders.length; i++) {
      colWidths.push({ wch: 30 }, { wch: 25 });
    }

    // 给原因列加灰色斜体样式
    function styleReasonCols(ws: XLSX.WorkSheet) {
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
      const grayItalic = { font: { color: { rgb: '888888' }, italic: true, sz: 10 } };
      // 原因列：1,3,5,...（0-indexed）
      for (let r = 1; r <= range.e.r; r++) {
        for (let c = 1; c <= range.e.c; c += 2) {
          const cellRef = XLSX.utils.encode_cell({ r, c });
          const cell = ws[cellRef];
          if (cell && cell.v) { cell.s = grayItalic; }
        }
      }
    }

    // Sheet1: 保留
    if (keepRows.length > 0) {
      const wsKeep = XLSX.utils.aoa_to_sheet(buildSheetAOA(keepRows));
      wsKeep['!cols'] = colWidths;
      styleReasonCols(wsKeep);
      XLSX.utils.book_append_sheet(wb, wsKeep, '保留');
    }

    // Sheet2: 否掉
    if (denyRows.length > 0) {
      const wsDeny = XLSX.utils.aoa_to_sheet(buildSheetAOA(denyRows));
      wsDeny['!cols'] = colWidths;
      // 否掉页：搜索词列红色字体，原因列灰色斜体
      const range = XLSX.utils.decode_range(wsDeny['!ref'] || 'A1');
      const redStyle = { font: { color: { rgb: 'FF0000' } } };
      const grayItalic = { font: { color: { rgb: '888888' }, italic: true, sz: 10 } };
      for (let r = 1; r <= range.e.r; r++) {
        for (let c = 0; c <= range.e.c; c++) {
          const cellRef = XLSX.utils.encode_cell({ r, c });
          const cell = wsDeny[cellRef];
          if (cell && cell.v) {
            cell.s = (c % 2 === 1) ? grayItalic : redStyle;
          }
        }
      }
      XLSX.utils.book_append_sheet(wb, wsDeny, '否掉');
    }

    // 如果两个Sheet都没有，提示
    if (wb.SheetNames.length === 0) {
      message.warning('没有可导出的数据');
      return;
    }

    const fileName = `否词结果_按机型组_${new Date().toISOString().slice(0, 10)}.xlsx`;
    void exportWorkbook({ wb, fileName: fileName.replace(/\.xlsx$/, ''), cellStyles: true });
    message.success(`已导出: 保留 ${keepRows.length} 条 / 否掉 ${denyRows.length} 条`);
  }, [data]);

  const handleExportDenyList = useCallback(() => {
    const denyTerms = data.filter(r => r.tag === 'deny');
    if (denyTerms.length === 0) return;
    const hasRaw = denyTerms.some(r => r.rawRow && Object.keys(r.rawRow).length > 0);
    if (hasRaw) {
      // Format like batch_classify output for deny-only
      const headers = Object.keys(denyTerms[0].rawRow!);
      const termColIdx = headers.findIndex(h => /客户搜索词|顾客搜索词|search.?term|customer.?search.?term/i.test(h));
      const insertAfter = termColIdx >= 0 ? termColIdx + 1 : 2;

      const newHeaders = [...headers.slice(0, insertAfter), '否词结果', '匹配词', ...headers.slice(insertAfter)];
      const outRows: unknown[][] = [newHeaders];

      for (const row of denyTerms) {
        const origVals = headers.map(h => row.rawRow![h] ?? '');
        const reasonText = `否掉: ${row.reason}`;
        const matchText = row.mappedGroup || row.reason || '';
        origVals.splice(insertAfter, 0, reasonText, matchText);
        outRows.push(origVals);
      }

      const ws = XLSX.utils.aoa_to_sheet(outRows);
      const colWidths = headers.map(() => ({ wch: 14 }));
      colWidths.splice(insertAfter, 0, { wch: 40 }, { wch: 25 });
      ws['!cols'] = colWidths;

      // All rows are deny, apply red font
      const totalCols = newHeaders.length;
      const redStyle = { font: { color: { rgb: 'FF0000' } } };
      for (let ri = 1; ri < outRows.length; ri++) {
        for (let ci = 0; ci < totalCols; ci++) {
          const cellRef = XLSX.utils.encode_cell({ r: ri, c: ci });
          const cell = ws[cellRef];
          if (cell) { cell.s = redStyle; }
        }
      }

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '否词列表');
      const fileName = `否词列表_${new Date().toISOString().slice(0, 10)}.xlsx`;
      void exportWorkbook({ wb, fileName: fileName.replace(/\.xlsx$/, ''), cellStyles: true });
      message.success(`已导出 ${denyTerms.length} 条否词`);
    } else {
      // Fallback
      const ws = XLSX.utils.aoa_to_sheet([
        ['搜索词', '标注', '原因'],
        ...denyTerms.map(r => [r.searchTerm, r.tagLabel, r.reason]),
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '否词列表');
      const fileName = `否词列表_${new Date().toISOString().slice(0, 10)}.xlsx`;
      void exportWorkbook({ wb, fileName: fileName.replace(/\.xlsx$/, ''), cellStyles: true });
      message.success(`已导出 ${denyTerms.length} 条否词`);
    }
  }, [data]);

  /**
   * 导出 Amazon Sponsored Products 官方 bulksheet。
   * 先按用户选择的店铺/站点映射匹配 Campaign ID；只有当前报告是在同一作用域
   * 导入时，才允许使用报告自身携带的 ID。绝不使用其它站点的同名活动 ID。
   * 活动级否词永远清空 Ad Group ID。
   */
  const handleExportAmazonTemplate = useCallback(async () => {
    let mappedCampaignIdCount = 0;
    let ambiguousCampaignIdCount = 0;
    // 导出前重新读取后端拓词，确保刚在“机型词组”页保存的关键词立即生效，
    // 不依赖页面首次加载时的旧缓存。
    let modelGroupsForExport: NegativeModelGroup[] = [];
    try {
      const response = await apiFetch('/api/model-groups', { timeoutMs: 15000 });
      modelGroupsForExport = Array.isArray(response?.groups)
        ? response.groups
          .filter((group: any) => group && String(group.name || '').trim())
          .map((group: any) => ({
            name: String(group.name || '').trim(),
            keywords: Array.isArray(group.keywords)
              ? group.keywords.map((keyword: unknown) => String(keyword ?? '').trim()).filter(Boolean)
              : [],
            enabled: group.enabled !== false,
          }))
        : [];
    } catch (error) {
      // 拓词服务不可达时保留旧的自动识别结果，不阻断用户导出；
      // 只有明确找到对应组且命中拓词时才会把词组降级成精准否定。
      console.warn('[否词工具] 导出前读取机型拓词失败，跳过二次拓词降级:', error);
    }
    const activeDataStore = campaignIdScopeKey(
      activeStoreScopeRef.current || activeMarketplaceRef.current || 'US',
      activeMarketplaceRef.current || 'US',
    );
    const exportStoreScope = normalizeCampaignScope(campaignIdExportStore || activeDataStore);
    const selectedExportScope = campaignIdScopeOptions.find(option => option.scope === exportStoreScope)
      || campaignIdScopeOptions.find(option => option.scope === defaultCampaignIdExportScope);
    const exportScopeAliases = campaignIdScopeAliases(selectedExportScope, campaignIdScopeOptions);
    const campaignLookupName = (row: KeywordRow): string => {
      if (row.campaignIdMatchName) return row.campaignIdMatchName;
      // 兼容升级前已经导入但尚未重新导入的页面数据：rawRow 仍保留原始表头，
      // 优先从“广告活动名称”列找真实活动名，避免继续拿第11列机型匹配。
      const rawRow = row.rawRow;
      if (rawRow) {
        const key = Object.keys(rawRow).find(header => (
          /^广告活动名称$/i.test(header)
          || /^广告活动$/i.test(header)
          || /^campaign\s*name$/i.test(header)
          || /^campaign$/i.test(header)
        ));
        if (key) {
          const value = String(rawRow[key] ?? '').trim();
          if (value) return value;
        }
      }
      return row.campaign;
    };
    const enrichedRows = data.map(row => {
      const matchName = campaignLookupName(row);
      const rowStoreScope = normalizeCampaignScope(row.campaignIdScope || activeDataStore);
      const rowBelongsToExportStore = rowStoreScope === exportStoreScope
        || (rowStoreScope === selectedExportScope?.storeId
          && selectedExportScope?.marketplace === normalizeCampaignScope(activeMarketplaceRef.current));
      const resolved = resolveCampaignId(campaignIdMappings, matchName, exportStoreScope, exportScopeAliases);
      const campaignId = resolved.campaignId || (rowBelongsToExportStore ? row.campaignId || '' : '');
      const campaignIdAmbiguous = resolved.ambiguous || (!campaignId && rowBelongsToExportStore && row.campaignIdAmbiguous);
      if (resolved.campaignId) mappedCampaignIdCount += 1;
      if (campaignIdAmbiguous) ambiguousCampaignIdCount += 1;
      return {
        key: row.key,
        index: row.index,
        searchTerm: row.searchTerm,
        campaign: row.campaign,
        campaignIdMatchName: matchName,
        campaignId,
        campaignIdScope: exportStoreScope,
        campaignIdAmbiguous,
        adGroup: row.adGroup,
        modelGroupName: row.mappedGroup || row.model || row.campaign,
        reason: row.reason,
        tag: row.tag,
      };
    });
    const result = buildAmazonNegativeTemplateRows(enrichedRows.map(row => ({
      key: row.key,
      index: row.index,
      searchTerm: row.searchTerm,
      campaign: row.campaign,
      campaignIdMatchName: row.campaignIdMatchName,
      campaignId: row.campaignId,
      campaignIdScope: row.campaignIdScope,
      adGroup: row.adGroup,
      modelGroupName: row.modelGroupName,
      reason: row.reason,
      tag: row.tag,
    })), amazonNegativeMatchMode, amazonNegativeScope, modelGroupsForExport);

    if (result.rows.length === 0) {
      if (result.check.deniedSourceRows === 0) {
        message.warning('当前没有“否掉”记录，请先完成分类或手动标记否掉');
      } else {
        message.warning('“否掉”记录缺少客户搜索词或广告活动名称，无法生成上传行');
      }
      return;
    }

    setAmazonTemplateExporting(true);
    try {
      const uploadData: AmazonNegativeUploadRow[] = result.rows;
      const check = result.check;

      // 官方上传页不能把广告组合名称写进 Ad Group ID，否则 Amazon 会拒绝文件。
      // 另外生成一页可核对的映射信息，让用户可以直接查看
      // Campaign ID → 广告组合名称 → Ad Group ID 的对应关系。
      const auditNameQueues = new Map<string, Array<{ campaignName: string; originalSearchTerm: string; reason: string }>>();
      for (const row of enrichedRows) {
        if (row.tag !== 'deny') continue;
        const resolvedKeyword = resolveNegativeKeyword(row.searchTerm, amazonNegativeMatchMode, {
          modelGroupName: row.modelGroupName,
          modelGroupHints: [row.modelGroupName, row.campaign].filter(Boolean),
          modelGroups: modelGroupsForExport,
          reason: row.reason,
        });
        const key = [row.campaignId || '', row.adGroup || '', resolvedKeyword.keywordText.trim(), resolvedKeyword.matchType].join('\u0000');
        const queue = auditNameQueues.get(key) || [];
        queue.push({
          campaignName: row.campaignIdMatchName || row.campaign || '',
          originalSearchTerm: row.searchTerm,
          reason: row.reason || '未记录分类原因',
        });
        auditNameQueues.set(key, queue);
      }
      const mappingAuditData = uploadData.map(uploadRow => {
        const key = [
          uploadRow['Campaign ID'],
          uploadRow['Ad Group ID'],
          uploadRow['Keyword Text'].trim(),
          uploadRow['Match Type'],
        ].join('\u0000');
        const queue = auditNameQueues.get(key) || [];
        const source = queue.shift();
        return {
          'Campaign ID': uploadRow['Campaign ID'],
          '对应广告组合名称': source?.campaignName || '',
          '原客户搜索词': source?.originalSearchTerm || '',
          '否词原因': source?.reason || '未记录分类原因',
          'Ad Group ID': uploadRow['Ad Group ID'],
          'Keyword Text': uploadRow['Keyword Text'],
          '否词级别': uploadRow.Entity === 'Negative Keyword' ? '广告组否词' : '广告活动否词',
          'Match Type': uploadRow['Match Type'],
          State: uploadRow.State,
        };
      });

      const selectedExportStore = selectedExportScope;
      const safeFilePart = (value: unknown, fallback: string) => {
        const normalized = String(value ?? '')
          .trim()
          .replace(/[<>:"/\\|?*]/g, '_')
          .replace(/\s+/g, '_')
          .replace(/_+/g, '_')
          .replace(/^[_.]+|[_.]+$/g, '');
        return (normalized || fallback).slice(0, 64);
      };
      const exportSiteLabel = safeFilePart(
        `${selectedExportStore?.storeName || exportStoreScope}_${selectedExportStore?.marketplace || exportStoreScope}`,
        exportStoreScope,
      );
      const exportDate = new Date().toISOString().slice(0, 10);
      const uploadColumns = AMAZON_NEGATIVE_UPLOAD_HEADERS.map(header => ({
        header,
        key: header,
        width: header === 'Keyword Text' ? 38 : header === 'Campaign ID' ? 20 : header === 'Ad Group ID' ? 18 : 18,
      }));
      const mappingAuditColumns = [
        { header: 'Campaign ID', key: 'Campaign ID', width: 20 },
        { header: '对应广告组合名称', key: '对应广告组合名称', width: 42 },
        { header: '原客户搜索词', key: '原客户搜索词', width: 42 },
        { header: '否词原因', key: '否词原因', width: 42 },
        { header: 'Ad Group ID', key: 'Ad Group ID', width: 20 },
        { header: 'Keyword Text', key: 'Keyword Text', width: 38 },
        { header: '否词级别', key: '否词级别', width: 14 },
        { header: 'Match Type', key: 'Match Type', width: 18 },
        { header: 'State', key: 'State', width: 12 },
      ];
      const exportInfoData = [{
        '导出店铺': selectedExportStore?.storeName || exportStoreScope,
        '站点': selectedExportStore?.marketplace || exportStoreScope,
        'Campaign ID 映射作用域': exportStoreScope,
        '生成时间': new Date().toLocaleString(),
        '导出条数': check.exportedRows,
        '说明': 'Campaign ID 仅从本店铺/站点作用域匹配，不使用其它站点同名活动的 ID。',
      }];

      // 一次操作生成两个独立文件：
      // 1) 可直接上传文件：严格只保留 Amazon 官方字段，避免核对列干扰后台上传；
      // 2) 映射核对文件：保留同一份上传页、核对页和导出站点信息，方便逐条复核。
      await exportToExcel({
        fileName: `Amazon_SP_否词_后台上传模板_可直接上传_${exportSiteLabel}_${exportDate}`,
        title: `Amazon Sponsored Products 否词后台上传模板（${exportSiteLabel}）`,
        sheets: [{
          name: 'Sponsored Products',
          data: uploadData,
          columns: uploadColumns,
        }],
      });
      await exportToExcel({
        fileName: `Amazon_SP_否词_后台上传模板_映射核对_${exportSiteLabel}_${exportDate}`,
        title: `Amazon Sponsored Products 否词后台上传模板-映射核对（${exportSiteLabel}）`,
        sheets: [
          {
            name: 'Sponsored Products',
            data: uploadData,
            columns: uploadColumns,
          },
          {
            name: 'Campaign 映射核对',
            data: mappingAuditData,
            columns: mappingAuditColumns,
          },
          {
            name: '导出站点信息',
            data: exportInfoData,
            columns: [
              { header: '导出店铺', key: '导出店铺', width: 20 },
              { header: '站点', key: '站点', width: 12 },
              { header: 'Campaign ID 映射作用域', key: 'Campaign ID 映射作用域', width: 28 },
              { header: '生成时间', key: '生成时间', width: 22 },
              { header: '导出条数', key: '导出条数', width: 12 },
              { header: '说明', key: '说明', width: 72 },
            ],
          },
        ],
      });

      if (check.missingCampaignId > 0 || check.skippedMissingAdGroup > 0) {
        const warnings = [];
        if (check.missingCampaignId > 0) warnings.push(`${check.missingCampaignId} 条缺少 Campaign ID`);
        if (ambiguousCampaignIdCount > 0) warnings.push(`${ambiguousCampaignIdCount} 条 ID 映射冲突`);
        if (check.skippedMissingAdGroup > 0) warnings.push(`${check.skippedMissingAdGroup} 条缺少 Ad Group ID 已跳过`);
        message.warning(`已按${exportSiteLabel}导出两个文件，共 ${check.exportedRows} 条；${warnings.join('；')}；请检查“映射核对”文件后再上传`);
      } else {
        message.success(`已按${exportSiteLabel}导出两个文件：可直接上传模板 + Campaign 映射核对文件，共 ${check.exportedRows} 条`);
      }
    } catch (err) {
      message.error(`Amazon 否词模板导出失败: ${(err as Error).message}`);
    } finally {
      setAmazonTemplateExporting(false);
    }
  }, [activeMarketplaceRef, activeStoreScopeRef, amazonNegativeMatchMode, amazonNegativeScope, campaignIdExportStore, campaignIdMappings, campaignIdScopeOptions, data, defaultCampaignIdExportScope]);

  /** 导出 ASIN 判定结果为 Amazon Negative Product Targeting 模板。 */
  const handleExportNegativeAsinTemplate = useCallback(async () => {
    const deniedRows = asinRows.filter(row => row.decision === 'deny');
    if (deniedRows.length === 0) {
      message.warning('当前没有明确判定为“否定”的 ASIN');
      return;
    }

    setAsinTemplateExporting(true);
    try {
      const exportScope = normalizeCampaignScope(asinExportScope || defaultCampaignIdExportScope);
      const selectedExportScope = campaignIdScopeOptions.find(option => option.scope === exportScope)
        || campaignIdScopeOptions.find(option => option.scope === defaultCampaignIdExportScope);
      const exportScopeAliases = campaignIdScopeAliases(selectedExportScope, campaignIdScopeOptions);
      const sameScope = (row: AsinRow) => normalizeCampaignScope(row.scope) === exportScope;
      const normalizeName = (value: unknown) => normalizeCampaignName(String(value ?? '').trim());
      const adGroupIdsByKey = new Map<string, Set<string>>();
      const addAdGroupId = (campaignName: unknown, adGroupName: unknown, value: unknown) => {
        const campaignKey = normalizeName(campaignName);
        const groupKey = normalizeName(adGroupName);
        const id = String(value ?? '').trim().replace(/\.0$/, '');
        if (!groupKey || !id) return;
        for (const key of [`${campaignKey}\u0000${groupKey}`, `\u0000${groupKey}`]) {
          const values = adGroupIdsByKey.get(key) || new Set<string>();
          values.add(id);
          adGroupIdsByKey.set(key, values);
        }
      };
      try {
        const [adGroupRecords, keywordRecords] = await Promise.all([
          db.amzAdGroups.toArray().catch(() => [] as any[]),
          db.keywords.toArray().catch(() => [] as any[]),
        ]);
        for (const candidate of [...adGroupRecords, ...keywordRecords]) {
          const recordScope = String(candidate.store_marketplace || candidate.storeMarketplace || '').trim().toUpperCase();
          if (recordScope && !exportScopeAliases.includes(recordScope)) continue;
          addAdGroupId(
            candidate.campaignName || candidate.campaign_name || candidate.campaignId || candidate.campaign_id,
            candidate.adGroupName || candidate.ad_group_name || candidate.name,
            candidate.adGroupId || candidate.ad_group_id,
          );
        }
      } catch {
        // 若无本地广告组数据，则只使用与导入站点完全一致的源文件 ID。
      }

      const resolveUniqueAdGroupId = (row: AsinRow, campaignId: string) => {
        if (sameScope(row) && row.adGroupId) return row.adGroupId;
        const campaignName = normalizeName(row.campaignName);
        const groupName = normalizeName(row.adGroupName);
        const values = adGroupIdsByKey.get(`${campaignName}\u0000${groupName}`)
          || adGroupIdsByKey.get(`${normalizeName(campaignId)}\u0000${groupName}`)
          || adGroupIdsByKey.get(`\u0000${groupName}`);
        return values && values.size === 1 ? Array.from(values)[0] : '';
      };

      const sourceRows: NegativeAsinSourceRow[] = deniedRows.map(row => {
        const resolvedCampaign = resolveCampaignId(
          campaignIdMappings,
          row.campaignName,
          exportScope,
          exportScopeAliases,
        );
        const campaignId = resolvedCampaign.campaignId || (sameScope(row) ? row.campaignId : '');
        return {
          asin: row.asin,
          decision: row.decision,
          campaignName: row.campaignName,
          campaignId,
          adGroupName: row.adGroupName,
          adGroupId: asinNegativeScope === 'adGroup' ? resolveUniqueAdGroupId(row, campaignId) : '',
          reason: row.reason,
        };
      });
      const result = buildAmazonNegativeAsinTemplateRows(sourceRows, asinNegativeScope);
      const uploadData: AmazonNegativeAsinUploadRow[] = result.rows;
      const safeFilePart = (value: unknown, fallback: string) => {
        const normalized = String(value ?? '')
          .trim()
          .replace(/[<>:"/\\|?*]/g, '_')
          .replace(/\s+/g, '_')
          .replace(/_+/g, '_')
          .replace(/^[_.]+|[_.]+$/g, '');
        return (normalized || fallback).slice(0, 64);
      };
      const exportSiteLabel = safeFilePart(
        `${selectedExportScope?.storeName || exportScope}_${selectedExportScope?.marketplace || exportScope}`,
        exportScope,
      );
      const exportDate = new Date().toISOString().slice(0, 10);
      const uploadColumns = AMAZON_NEGATIVE_ASIN_UPLOAD_HEADERS.map(header => ({
        header,
        key: header,
        width: header === 'Product Targeting Expression' ? 34 : header.includes('ID') ? 20 : 22,
      }));

      const validKeys = new Set(uploadData.map(row => [
        row['Campaign ID'],
        row['Ad Group ID'],
        row['Product Targeting Expression'],
      ].join('\u0000')));
      const skippedReasonBySource = new Map<string, string>();
      for (const skipped of result.skippedRows) {
        const key = [skipped.source.campaignId || '', skipped.source.adGroupId || '', normalizeAsin(skipped.source.asin)].join('\u0000');
        if (!skippedReasonBySource.has(key)) skippedReasonBySource.set(key, skipped.reason);
      }
      const auditData = sourceRows.map(source => {
        const asin = normalizeAsin(source.asin);
        const expression = asin ? `asin="${asin}"` : '';
        const key = [source.campaignId || '', source.adGroupId || '', expression].join('\u0000');
        const status = validKeys.has(key)
          ? '可直接上传'
          : `未导出：${skippedReasonBySource.get([source.campaignId || '', source.adGroupId || '', asin].join('\u0000')) || '映射不完整'}`;
        return {
          ASIN: asin || source.asin,
          '判定结果': '否定',
          '否定原因': source.reason || '未记录判定原因',
          '对应广告活动名称': source.campaignName || '',
          'Campaign ID': source.campaignId || '',
          '对应广告组名称': source.adGroupName || '',
          'Ad Group ID': source.adGroupId || '',
          'Product Targeting Expression': expression,
          'Product Targeting Expression Type': 'Negative Targeting Expression',
          '导出站点': selectedExportScope?.marketplace || exportScope,
          '导出状态': status,
        };
      });
      const auditColumns = [
        { header: 'ASIN', key: 'ASIN', width: 18 },
        { header: '判定结果', key: '判定结果', width: 12 },
        { header: '否定原因', key: '否定原因', width: 42 },
        { header: '对应广告活动名称', key: '对应广告活动名称', width: 42 },
        { header: 'Campaign ID', key: 'Campaign ID', width: 20 },
        { header: '对应广告组名称', key: '对应广告组名称', width: 28 },
        { header: 'Ad Group ID', key: 'Ad Group ID', width: 20 },
        { header: 'Product Targeting Expression', key: 'Product Targeting Expression', width: 34 },
        { header: 'Product Targeting Expression Type', key: 'Product Targeting Expression Type', width: 30 },
        { header: '导出站点', key: '导出站点', width: 12 },
        { header: '导出状态', key: '导出状态', width: 24 },
      ];

      if (uploadData.length === 0) {
        const reasons: string[] = [];
        if (result.check.skippedInvalidAsin > 0) reasons.push(`ASIN格式无效 ${result.check.skippedInvalidAsin} 条`);
        if (result.check.skippedMissingCampaignId > 0) reasons.push(`缺少 Campaign ID ${result.check.skippedMissingCampaignId} 条`);
        if (result.check.skippedMissingAdGroupId > 0) reasons.push(`缺少 Ad Group ID ${result.check.skippedMissingAdGroupId} 条`);
        if (result.check.skippedDuplicate > 0) reasons.push(`重复 ASIN 投放 ${result.check.skippedDuplicate} 条`);
        message.error(`没有生成可直接上传的 ASIN 行：${reasons.join('，') || '没有满足上传条件的记录'}；请先重新确认 ASIN 列、站点和广告活动映射`);
        return;
      }

      await exportToExcel({
        fileName: `Amazon_SP_否ASIN_后台上传模板_可直接上传_${exportSiteLabel}_${exportDate}`,
        title: `Amazon Sponsored Products 否定 ASIN 后台上传模板（${exportSiteLabel}）`,
        sheets: [{
          name: 'Sponsored Products',
          data: uploadData,
          columns: uploadColumns,
        }],
      });
      await exportToExcel({
        fileName: `Amazon_SP_否ASIN_后台上传模板_映射核对_${exportSiteLabel}_${exportDate}`,
        title: `Amazon Sponsored Products 否定 ASIN 映射核对（${exportSiteLabel}）`,
        sheets: [
          { name: 'Sponsored Products', data: uploadData, columns: uploadColumns },
          { name: 'ASIN 映射核对', data: auditData, columns: auditColumns },
          {
            name: '导出站点信息',
            data: [{
              '导出店铺': selectedExportScope?.storeName || exportScope,
              '站点': selectedExportScope?.marketplace || exportScope,
              '映射作用域': exportScope,
              '否定级别': asinNegativeScope === 'adGroup' ? '广告组级 Negative Product Targeting' : '广告活动级 Negative Product Targeting',
              '生成时间': new Date().toLocaleString(),
              '可直接上传条数': result.check.exportedRows,
              '未导出条数': result.skippedRows.length,
            }],
            columns: [
              { header: '导出店铺', key: '导出店铺', width: 20 },
              { header: '站点', key: '站点', width: 12 },
              { header: '映射作用域', key: '映射作用域', width: 30 },
              { header: '否定级别', key: '否定级别', width: 36 },
              { header: '生成时间', key: '生成时间', width: 22 },
              { header: '可直接上传条数', key: '可直接上传条数', width: 18 },
              { header: '未导出条数', key: '未导出条数', width: 16 },
            ],
          },
        ],
      });

      if (result.skippedRows.length > 0) {
        const skippedSummary = [
          result.check.skippedInvalidAsin > 0 ? `ASIN格式无效 ${result.check.skippedInvalidAsin} 条` : '',
          result.check.skippedMissingCampaignId > 0 ? `缺少 Campaign ID ${result.check.skippedMissingCampaignId} 条` : '',
          result.check.skippedMissingAdGroupId > 0 ? `缺少 Ad Group ID ${result.check.skippedMissingAdGroupId} 条` : '',
          result.check.skippedDuplicate > 0 ? `重复 ASIN ${result.check.skippedDuplicate} 条` : '',
        ].filter(Boolean).join('；');
        message.warning(`已按${exportSiteLabel}生成 ASIN 上传模板 ${result.check.exportedRows} 条及映射核对文件；另有 ${result.skippedRows.length} 条未导出（${skippedSummary || '请查看核对文件'}）`);
      } else {
        message.success(`已按${exportSiteLabel}生成 Amazon 否ASIN上传模板和映射核对文件，共 ${result.check.exportedRows} 条`);
      }
    } catch (err) {
      message.error(`Amazon 否ASIN模板导出失败: ${(err as Error).message}`);
    } finally {
      setAsinTemplateExporting(false);
    }
  }, [asinExportScope, asinNegativeScope, asinRows, campaignIdMappings, campaignIdScopeOptions, defaultCampaignIdExportScope]);

  // ============ Table Columns ============

  const columns: ColumnsType<KeywordRow> = [
    { title: '#', dataIndex: 'index', sorter: (a: any, b: any) => (a.index ?? 0) - (b.index ?? 0), width: 50, fixed: 'left' },
    {
      title: '顾客搜索词', dataIndex: 'searchTerm', sorter: (a: any, b: any) => String(a.searchTerm ?? '').localeCompare(String(b.searchTerm ?? '')), width: 280, fixed: 'left', ellipsis: true,
      render: (text: string) => <Tooltip title={text}><Text style={{ fontSize: 12 }}>{text}</Text></Tooltip>,
    },
    {
      title: '广告活动', dataIndex: 'campaign', sorter: (a: any, b: any) => String(a.campaign ?? '').localeCompare(String(b.campaign ?? '')), width: 180, ellipsis: true,
      render: (text: string) => <Tooltip title={text}><Text type="secondary" style={{ fontSize: 11 }}>{text}</Text></Tooltip>,
    },
    {
      title: 'Campaign ID', dataIndex: 'campaignId', width: 175, ellipsis: true,
      render: (value: string, record: KeywordRow) => record.campaignIdAmbiguous
        ? <Tooltip title="同名活动对应多个 ID，导出时不会自动猜测"><Tag color="error">映射冲突</Tag></Tooltip>
        : value ? <Text code copyable={{ text: value }} style={{ fontSize: 11 }}>{value}</Text> : <Tag color="warning">未匹配</Tag>,
    },
    {
      title: '标注', dataIndex: 'tagLabel', sorter: (a: any, b: any) => String(a.tagLabel ?? '').localeCompare(String(b.tagLabel ?? '')), width: 90, align: 'center',
      render: (text: string, record: KeywordRow) => (
        <Dropdown
          menu={{
            items: [
              { key: 'deny', label: '🔴 否掉', danger: true },
              { key: 'keep', label: '🟢 保留' },
              { key: 'review', label: '🟡 待审' },
            ],
            onClick: ({ key }) => handleTagChange(record.key, key as 'deny' | 'keep' | 'review'),
          }}
          trigger={['click']}
        >
          <Tag color={record.tag === 'deny' ? 'red' : record.tag === 'keep' ? 'green' : 'orange'} style={{ cursor: 'pointer', fontWeight: 600 }}>
            {text} {record.manualOverride && <EditOutlined style={{ fontSize: 10 }} />}
          </Tag>
        </Dropdown>
      ),
    },
    {
      title: '命中原因', dataIndex: 'reason', sorter: (a: any, b: any) => String(a.reason ?? '').localeCompare(String(b.reason ?? '')), width: 260, ellipsis: true,
      render: (text: string) => <Tooltip title={text}><Text style={{ fontSize: 11, color: '#666' }}>{text}</Text></Tooltip>,
    },
    {
      title: '映射组', dataIndex: 'mappedGroup', sorter: (a: any, b: any) => String(a.mappedGroup ?? '').localeCompare(String(b.mappedGroup ?? '')), width: 160, ellipsis: true,
      render: (text: string) => text ? <Tooltip title={text}><Tag color="purple" style={{ fontSize: 10 }}>{text}</Tag></Tooltip> : <Text type="secondary" style={{ fontSize: 10 }}>-</Text>,
    },
    {
      title: '搜索量', dataIndex: 'searchVolume', sorter: (a: any, b: any) => String(a.searchVolume ?? '').localeCompare(String(b.searchVolume ?? '')), width: 80, align: 'right',
      render: (text: string) => <Text style={{ fontSize: 11 }}>{text}</Text>,
    },
  ];

  const asinAdGroupValueOptions = useMemo(() => {
    if (!pendingAsinImport || !asinImportMapping?.adGroupCol) return [];
    return Array.from(new Set(
      pendingAsinImport.rows
        .map(row => String(row[asinImportMapping.adGroupCol] ?? '').trim())
        .filter(Boolean),
    )).sort((a, b) => a.localeCompare(b));
  }, [asinImportMapping, pendingAsinImport]);

  const asinColumns: ColumnsType<AsinRow> = [
    { title: '#', dataIndex: 'index', width: 50, fixed: 'left' },
    {
      title: 'ASIN', dataIndex: 'asin', width: 155, fixed: 'left',
      render: (value: string, record: AsinRow) => (
        <Space size={4}>
          {value ? <Text code copyable={{ text: value }}>{value}</Text> : <Tag color="warning">无效</Tag>}
          {record.verifySource && (
            <Tooltip title="在亚马逊打开商品详情页">
              <a href={record.verifySource} target="_blank" rel="noreferrer" style={{ color: '#1677ff' }}>
                <LinkOutlined />
              </a>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: '判定结果', dataIndex: 'decisionLabel', width: 115, align: 'center', fixed: 'left',
      render: (value: string, record: AsinRow) => (
        <Select
          size="small"
          value={record.decision}
          style={{ width: 95 }}
          onChange={(newVal) => {
            const nextLabel = newVal === 'deny' ? '否定' : newVal === 'keep' ? '保留' : '待复核';
            setAsinRows(prev => prev.map(r => r.key === record.key ? { ...r, decision: newVal as any, decisionLabel: nextLabel } : r));
          }}
        >
          <Option value="deny"><Tag color="red" style={{ margin: 0 }}>否定</Tag></Option>
          <Option value="keep"><Tag color="green" style={{ margin: 0 }}>保留</Tag></Option>
          <Option value="review"><Tag color="orange" style={{ margin: 0 }}>待复核</Tag></Option>
        </Select>
      ),
    },
    {
      title: '商品详情标题', dataIndex: 'title', width: 300, ellipsis: true,
      render: (value: string) => (
        <Tooltip title={value || '未获取到有效标题'} placement="topLeft">
          <Text style={{ fontSize: 12 }}>{value || <Text type="secondary">未获取到标题</Text>}</Text>
        </Tooltip>
      ),
    },
    {
      title: '判定依据', dataIndex: 'reason', width: 320, ellipsis: true,
      render: (value: string) => (
        <Tooltip title={value} placement="topLeft">
          <Text type="secondary" style={{ fontSize: 12 }}>{value || '-'}</Text>
        </Tooltip>
      ),
    },
    {
      title: '目标机型', dataIndex: 'targetModel', width: 120,
      render: (v: string, r: AsinRow) => <Tag color="blue">{v || (r.rawRow as any)?.['机型'] || '-'}</Tag>,
    },
    { title: '广告活动名称', dataIndex: 'campaignName', width: 230, ellipsis: true },
    {
      title: 'Campaign ID', dataIndex: 'campaignId', width: 170,
      render: (value: string) => value ? <Text code copyable={{ text: value }}>{value}</Text> : <Tag color="warning">未匹配</Tag>,
    },
    { title: '广告组名称/标识', dataIndex: 'adGroupName', width: 190, ellipsis: true, render: (value: string) => value || '-' },
    {
      title: 'Ad Group ID', dataIndex: 'adGroupId', width: 170,
      render: (value: string, record: AsinRow) => record.scope && asinNegativeScope === 'campaign'
        ? <Text type="secondary">活动级无需</Text>
        : value ? <Text code copyable={{ text: value }}>{value}</Text> : <Tag color="warning">未匹配</Tag>,
    },
    {
      title: '曝光量', dataIndex: ['rawRow', '展示量'], width: 85, align: 'right',
      render: (_: any, r: AsinRow) => (r.rawRow as any)?.['展示量'] ?? '-',
    },
    {
      title: '点击量', dataIndex: ['rawRow', '点击量'], width: 85, align: 'right',
      render: (_: any, r: AsinRow) => (r.rawRow as any)?.['点击量'] ?? '-',
    },
    {
      title: '花费', dataIndex: ['rawRow', '花费'], width: 90, align: 'right',
      render: (_: any, r: AsinRow) => (r.rawRow as any)?.['花费'] != null ? Number((r.rawRow as any)['花费']).toFixed(2) : '-',
    },
    {
      title: '7天销售额', dataIndex: ['rawRow', '7天总销售额'], width: 100, align: 'right',
      render: (_: any, r: AsinRow) => (r.rawRow as any)?.['7天总销售额'] != null ? Number((r.rawRow as any)['7天总销售额']).toFixed(2) : '-',
    },
    { title: '导出站点', dataIndex: 'scope', width: 140, render: (value: string) => <Tag color="geekblue">{value || '-'}</Tag> },
  ];

  // ============ Render ============

  return (
    <div style={{ padding: 0 }}>
      {/* Config sync toolbar — visible on all tabs */}
      <PageHeader
        title="否词工具"
        subTitle={activePluginStore ? `当前店铺：${activePluginStore.name} (${activePluginStore.marketplace}) · 规则独立隔离` : '独立插件版 · 规则实时同步至 GitHub'}
        icon={<StopOutlined />}
        extra={(
          <Space size={8} wrap>
            <Text type="secondary" style={{ fontSize: 12 }}>当前店铺：</Text>
            <Select
              size="small"
              style={{ minWidth: 190 }}
              loading={storeSwitching}
              value={activeStoreId}
              onChange={(val) => { void handleSwitchStore(val); }}
              options={pluginStores.map(s => ({
                value: s.id,
                label: `${s.name} [${s.marketplace}]`,
              }))}
            />
            <Button
              size="small"
              icon={<PlusOutlined />}
              onClick={() => {
                setNewStoreCopyFrom(activeStoreId || 'default');
                setNewStoreOpen(true);
              }}
            >
              新增店铺
            </Button>
          </Space>
        )}
      />
      <Modal
        title="新增店铺（独立否词规则）"
        open={newStoreOpen}
        onCancel={() => setNewStoreOpen(false)}
        onOk={() => { void handleCreateStore(); }}
        confirmLoading={storeSwitching}
        okText="创建并切换"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Text style={{ display: 'block', marginBottom: 4 }}>店铺标识 ID（英文/数字/短横线，用于目录命名）：</Text>
            <Input
              placeholder="例如：suanpot-uk 或 shop-de"
              value={newStoreId}
              onChange={e => setNewStoreId(e.target.value)}
            />
          </div>
          <div>
            <Text style={{ display: 'block', marginBottom: 4 }}>店铺显示名称：</Text>
            <Input
              placeholder="例如：Suanpot 英国站"
              value={newStoreName}
              onChange={e => setNewStoreName(e.target.value)}
            />
          </div>
          <div>
            <Text style={{ display: 'block', marginBottom: 4 }}>所属站点：</Text>
            <Select
              style={{ width: '100%' }}
              value={newStoreMkt}
              onChange={setNewStoreMkt}
              options={['US', 'CA', 'UK', 'DE', 'FR', 'IT', 'ES', 'JP', 'AU'].map(m => ({ value: m, label: m }))}
            />
          </div>
          <div>
            <Text style={{ display: 'block', marginBottom: 4 }}>初始化规则来源（复制现有店铺规则作为起点）：</Text>
            <Select
              style={{ width: '100%' }}
              value={newStoreCopyFrom}
              onChange={setNewStoreCopyFrom}
              options={pluginStores.map(s => ({ value: s.id, label: `${s.name} (${s.id})` }))}
            />
          </div>
        </Space>
      </Modal>
      <Card
        size="small"
        style={{ marginBottom: 12 }}
        styles={{ body: { padding: '8px 14px' } }}
      >
        <Flex gap={10} wrap="wrap" align="center" justify="space-between">
          <Flex gap={8} wrap="wrap" align="center">
            <Badge status={syncing ? 'processing' : syncInfo?.errors?.length ? 'warning' : 'success'} />
            <Text strong style={{ fontSize: 13 }}>GitHub 规则实时同步</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              保存即自动备份当前店铺配置到 GitHub 仓库
            </Text>
            {syncInfo && (
              <Tag color={syncInfo.errors.length ? 'warning' : 'success'} style={{ margin: 0 }}>
                {syncInfo.errors.length ? '⚠️ ' : '✅ '}
                {syncInfo.synced.join(' / ')} ({(syncInfo.fileSize / 1024).toFixed(0)}KB · {syncInfo.durationMs}ms)
                {syncInfo.updated.length > 0 && ` · 更新 ${syncInfo.updated.join(', ')}`}
                {syncInfo.errors.length > 0 && ` · ${syncInfo.errors.join('; ')}`}
              </Tag>
            )}
          </Flex>
          <Button
            type="primary"
            icon={<SyncOutlined spin={syncing} />}
            loading={syncing}
            onClick={handleSyncConfig}
            size="small"
          >
            立即同步至 GitHub
          </Button>
        </Flex>
      </Card>
      <input
        ref={asinFileInputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        style={{ display: 'none' }}
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) handleAsinFileImport(file);
          e.target.value = '';
        }}
      />
      <Modal
        title="确认否词导入列与级别"
        open={Boolean(pendingImport && importMapping)}
        width={680}
        destroyOnClose
        maskClosable={false}
        onCancel={() => {
          if (!importConfirming) {
            setPendingImport(null);
            setImportMapping(null);
          }
        }}
        onOk={handleConfirmImportMapping}
        okText="确认导入并开始分类"
        cancelText="取消"
        confirmLoading={importConfirming}
      >
        {pendingImport && importMapping && (
          <Flex vertical gap={12}>
            <Alert
              type="info"
              showIcon
              message={`已读取文件：${pendingImport.fileName}（${pendingImport.rows.length} 行）`}
              description="页面展示列与 Campaign ID 匹配列已分开：默认第 11 列用于页面展示，默认第 5 列（E）用于按广告活动名称匹配 Campaign ID。导出时会严格按这里选择的否词级别生成 Match Type。"
            />
            <div>
              <Text strong>客户搜索词所在列</Text>
              <Select
                value={importMapping.termCol || undefined}
                onChange={value => setImportMapping(prev => prev ? { ...prev, termCol: value } : prev)}
                style={{ width: '100%', marginTop: 6 }}
                placeholder="请选择搜索词列"
              >
                {pendingImport.headers.map((header, index) => (
                  <Option key={`term-${index}-${header}`} value={header}>第{index + 1}列：{header}</Option>
                ))}
              </Select>
            </div>
            <div>
              <Text strong>广告活动名称所在列 <Text type="secondary">（页面展示，默认第11列）</Text></Text>
              <Select
                value={importMapping.campaignCol || undefined}
                onChange={value => setImportMapping(prev => prev ? { ...prev, campaignCol: value } : prev)}
                style={{ width: '100%', marginTop: 6 }}
                placeholder="请选择广告活动名称列"
              >
                {pendingImport.headers.map((header, index) => (
                  <Option key={`campaign-${index}-${header}`} value={header}>第{index + 1}列：{header}</Option>
                ))}
              </Select>
            </div>
            <div>
              <Text strong>Campaign ID 对应映射的广告组合列 <Text type="secondary">（默认第5列 E）</Text></Text>
              <Select
                value={importMapping.campaignIdMatchCol || undefined}
                onChange={value => setImportMapping(prev => prev ? { ...prev, campaignIdMatchCol: value } : prev)}
                style={{ width: '100%', marginTop: 6 }}
                placeholder="请选择用于匹配 Campaign ID 的广告活动名称列"
              >
                {pendingImport.headers.map((header, index) => (
                  <Option key={`campaign-id-match-${index}-${header}`} value={header}>第{index + 1}列：{header}</Option>
                ))}
              </Select>
            </div>
            <div>
              <Text strong>否词级别</Text>
              <Select
                value={importMapping.scope}
                onChange={value => {
                  const scope = value as AmazonNegativeScope;
                  setAmazonNegativeScope(scope);
                  setImportMapping(prev => prev ? {
                    ...prev,
                    scope,
                    adGroupCol: scope === 'campaign' ? undefined : prev.adGroupCol,
                  } : prev);
                }}
                style={{ width: '100%', marginTop: 6 }}
              >
                <Option value="campaign">广告活动否词（Campaign Negative，不填写 Ad Group ID）</Option>
                <Option value="adGroup">广告组否词（Negative，必须填写 Ad Group ID）</Option>
              </Select>
            </div>
            {importMapping.scope === 'adGroup' && (
              <div>
                <Text strong>Ad Group ID 所在列 <Text type="danger">（必选）</Text></Text>
                <Select
                  value={importMapping.adGroupCol || undefined}
                  onChange={value => setImportMapping(prev => prev ? { ...prev, adGroupCol: value } : prev)}
                  style={{ width: '100%', marginTop: 6 }}
                  placeholder="广告组否词必须选择 Ad Group ID 列"
                >
                  {pendingImport.headers.map((header, index) => (
                    <Option key={`ad-group-${index}-${header}`} value={header}>第{index + 1}列：{header}</Option>
                  ))}
                </Select>
              </div>
            )}
            <div>
              <Text strong>Campaign ID 所在列 <Text type="secondary">（可选）</Text></Text>
              <Select
                allowClear
                value={importMapping.campaignIdCol}
                onChange={value => setImportMapping(prev => prev ? { ...prev, campaignIdCol: value || undefined } : prev)}
                style={{ width: '100%', marginTop: 6 }}
                placeholder="没有真实 Campaign ID 可留空，系统会尝试从当前店铺活动数据匹配"
              >
                {pendingImport.headers.map((header, index) => (
                  <Option key={`campaign-id-${index}-${header}`} value={header}>第{index + 1}列：{header}</Option>
                ))}
              </Select>
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              当前选择：页面展示列=第{pendingImport.headers.indexOf(importMapping.campaignCol) + 1}列；Campaign ID匹配列=第{pendingImport.headers.indexOf(importMapping.campaignIdMatchCol) + 1}列；{importMapping.scope === 'campaign' ? '广告活动否词，Ad Group ID 将被清空' : importMapping.adGroupCol ? `广告组否词，使用第${pendingImport.headers.indexOf(importMapping.adGroupCol) + 1}列作为 Ad Group ID` : '广告组否词，尚未选择 Ad Group ID 列'}
            </Text>
          </Flex>
        )}
      </Modal>
      <Modal
        title="导入 ASIN 判定结果并设置映射"
        open={Boolean(pendingAsinImport && asinImportMapping)}
        width={780}
        destroyOnClose
        maskClosable={false}
        onCancel={() => {
          if (!asinImportConfirming) {
            setPendingAsinImport(null);
            setAsinImportMapping(null);
          }
        }}
        onOk={handleConfirmAsinImport}
        okText="确认导入 ASIN 判定结果"
        cancelText="取消"
        confirmLoading={asinImportConfirming}
      >
        {pendingAsinImport && asinImportMapping && (
          <Flex vertical gap={12}>
            <Alert
              type="info"
              showIcon
              message={`已读取文件：${pendingAsinImport.fileName}（${pendingAsinImport.rows.length} 行）`}
              description="导入只接受明确的“否定”结果；保留/待审会保留在核对页但不会进入上传文件。导出时会按所选站点映射 Campaign ID，并在广告组级别下映射 Ad Group ID。"
            />
            <div>
              <Text strong>导入并映射到的店铺/站点 <Text type="danger">（必选）</Text></Text>
              <Select
                value={campaignIdScopeKey(asinImportMapping.storeId, asinImportMapping.marketplace)}
                onChange={value => {
                  const scopeInfo = parseCampaignIdScope(value);
                  setAsinImportMapping(prev => prev ? {
                    ...prev,
                    storeId: scopeInfo.storeId,
                    marketplace: scopeInfo.marketplace || prev.marketplace,
                  } : prev);
                  setAsinExportScope(String(value));
                }}
                style={{ width: '100%', marginTop: 6 }}
                showSearch
                optionFilterProp="children"
              >
                {campaignIdScopeOptions.map(option => (
                  <Option key={`asin-import-scope-${option.scope}`} value={option.scope}>
                    {campaignIdScopeLabel(option)}
                  </Option>
                ))}
              </Select>
            </div>
            <Flex gap={12} wrap="wrap">
              <div style={{ flex: '1 1 300px' }}>
                <Text strong>否定级别</Text>
                <Select
                  value={asinImportMapping.scope}
                  onChange={value => {
                    const scope = value as AmazonNegativeScope;
                    setAsinNegativeScope(scope);
                    setAsinImportMapping(prev => prev ? { ...prev, scope } : prev);
                  }}
                  style={{ width: '100%', marginTop: 6 }}
                >
                  <Option value="campaign">广告活动级 Negative Product Targeting（不需要 Ad Group ID）</Option>
                  <Option value="adGroup">广告组级 Negative Product Targeting（需要 Ad Group ID）</Option>
                </Select>
              </div>
              <div style={{ flex: '1 1 300px' }}>
                <Text strong>ASIN 判定结果列 <Text type="danger">（必选）</Text></Text>
                <Select
                  value={asinImportMapping.resultCol || undefined}
                  onChange={value => setAsinImportMapping(prev => prev ? { ...prev, resultCol: value } : prev)}
                  style={{ width: '100%', marginTop: 6 }}
                  placeholder="请选择判定结果列"
                >
                  {pendingAsinImport.headers.map((header, index) => (
                    <Option key={`asin-result-${index}-${header}`} value={header}>第{index + 1}列：{header}</Option>
                  ))}
                </Select>
              </div>
            </Flex>
            <Flex gap={12} wrap="wrap">
              <div style={{ flex: '1 1 300px' }}>
                <Text strong>ASIN 所在列 <Text type="danger">（必选）</Text></Text>
                <Select
                  value={asinImportMapping.asinCol || undefined}
                  onChange={value => setAsinImportMapping(prev => prev ? { ...prev, asinCol: value } : prev)}
                  style={{ width: '100%', marginTop: 6 }}
                  placeholder="请选择 ASIN 列"
                >
                  {pendingAsinImport.headers.map((header, index) => (
                    <Option key={`asin-col-${index}-${header}`} value={header}>第{index + 1}列：{header}</Option>
                  ))}
                </Select>
              </div>
              <div style={{ flex: '1 1 300px' }}>
                <Text strong>判定原因列 <Text type="secondary">（可选）</Text></Text>
                <Select
                  allowClear
                  value={asinImportMapping.reasonCol}
                  onChange={value => setAsinImportMapping(prev => prev ? { ...prev, reasonCol: value || undefined } : prev)}
                  style={{ width: '100%', marginTop: 6 }}
                  placeholder="可选择保留判定依据"
                >
                  {pendingAsinImport.headers.map((header, index) => (
                    <Option key={`asin-reason-${index}-${header}`} value={header}>第{index + 1}列：{header}</Option>
                  ))}
                </Select>
              </div>
            </Flex>
            <Flex gap={12} wrap="wrap">
              <div style={{ flex: '1 1 300px' }}>
                <Text strong>广告活动名称所在列 <Text type="secondary">（用于展示和名称匹配）</Text></Text>
                <Select
                  allowClear
                  value={asinImportMapping.campaignCol || undefined}
                  onChange={value => setAsinImportMapping(prev => prev ? { ...prev, campaignCol: value || '', campaignIdMatchCol: prev.campaignIdMatchCol || value || '' } : prev)}
                  style={{ width: '100%', marginTop: 6 }}
                  placeholder="源文件没有活动名称可留空"
                >
                  {pendingAsinImport.headers.map((header, index) => (
                    <Option key={`asin-campaign-${index}-${header}`} value={header}>第{index + 1}列：{header}</Option>
                  ))}
                </Select>
              </div>
              <div style={{ flex: '1 1 300px' }}>
                <Text strong>Campaign ID 对应匹配列 <Text type="secondary">（默认同活动名称列）</Text></Text>
                <Select
                  allowClear
                  value={asinImportMapping.campaignIdMatchCol || undefined}
                  onChange={value => setAsinImportMapping(prev => prev ? { ...prev, campaignIdMatchCol: value || '' } : prev)}
                  style={{ width: '100%', marginTop: 6 }}
                  placeholder="选择用于匹配 Campaign ID 的列"
                >
                  {pendingAsinImport.headers.map((header, index) => (
                    <Option key={`asin-campaign-match-${index}-${header}`} value={header}>第{index + 1}列：{header}</Option>
                  ))}
                </Select>
              </div>
            </Flex>
            <Flex gap={12} wrap="wrap">
              <div style={{ flex: '1 1 300px' }}>
                <Text strong>源文件 Campaign ID 所在列 <Text type="secondary">（可选，优先使用真实 ID）</Text></Text>
                <Select
                  allowClear
                  value={asinImportMapping.campaignIdCol}
                  onChange={value => setAsinImportMapping(prev => prev ? { ...prev, campaignIdCol: value || undefined } : prev)}
                  style={{ width: '100%', marginTop: 6 }}
                  placeholder="没有真实 Campaign ID 可留空"
                >
                  {pendingAsinImport.headers.map((header, index) => (
                    <Option key={`asin-campaign-id-${index}-${header}`} value={header}>第{index + 1}列：{header}</Option>
                  ))}
                </Select>
              </div>
              <div style={{ flex: '1 1 300px' }}>
                <Text strong>广告组名称/标识所在列 {asinImportMapping.scope === 'adGroup' && <Text type="danger">（广告组级必选其一）</Text>}</Text>
                <Select
                  allowClear
                  value={asinImportMapping.adGroupCol || undefined}
                  onChange={value => setAsinImportMapping(prev => prev ? { ...prev, adGroupCol: value || '' } : prev)}
                  style={{ width: '100%', marginTop: 6 }}
                  placeholder="按每行读取广告组名称或编号"
                >
                  {pendingAsinImport.headers.map((header, index) => (
                    <Option key={`asin-ad-group-${index}-${header}`} value={header}>第{index + 1}列：{header}</Option>
                  ))}
                </Select>
              </div>
            </Flex>
            <Flex gap={12} wrap="wrap">
              <div style={{ flex: '1 1 300px' }}>
                <Text strong>源文件 Ad Group ID 所在列 <Text type="secondary">（可选，优先使用真实 ID）</Text></Text>
                <Select
                  allowClear
                  value={asinImportMapping.adGroupIdCol}
                  onChange={value => setAsinImportMapping(prev => prev ? { ...prev, adGroupIdCol: value || undefined } : prev)}
                  style={{ width: '100%', marginTop: 6 }}
                  placeholder="没有真实 Ad Group ID 可留空"
                >
                  {pendingAsinImport.headers.map((header, index) => (
                    <Option key={`asin-ad-group-id-${index}-${header}`} value={header}>第{index + 1}列：{header}</Option>
                  ))}
                </Select>
              </div>
              <div style={{ flex: '1 1 300px' }}>
                <Text strong>指定要映射的广告组 <Text type="secondary">（可选，空=按每行广告组）</Text></Text>
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="children"
                  value={asinImportMapping.selectedAdGroupValue || undefined}
                  onChange={value => setAsinImportMapping(prev => prev ? { ...prev, selectedAdGroupValue: value || '' } : prev)}
                  style={{ width: '100%', marginTop: 6 }}
                  placeholder={asinImportMapping.adGroupCol ? '选择后所有行映射到同一广告组' : '先选择广告组名称/标识列'}
                  disabled={!asinImportMapping.adGroupCol || asinAdGroupValueOptions.length === 0}
                >
                  {asinAdGroupValueOptions.map(value => <Option key={`asin-fixed-group-${value}`} value={value}>{value}</Option>)}
                </Select>
              </div>
            </Flex>
            <Text type="secondary" style={{ fontSize: 12 }}>
              当前站点：{campaignIdScopeLabel(campaignIdScopeOptions.find(option => option.scope === campaignIdScopeKey(asinImportMapping.storeId, asinImportMapping.marketplace)))}；
              {asinImportMapping.scope === 'campaign' ? '广告活动级导出不填写 Ad Group ID。' : '广告组级导出只会使用真实且唯一的 Ad Group ID，无法唯一映射的记录会进入映射核对文件，不会混入可直接上传模板。'}
            </Text>
          </Flex>
        )}
      </Modal>
      {/* Main tabs */}
      <Tabs
        key={storeVersion}
        activeKey={activeTab}
        onChange={setActiveTab}
        type="card"
        size="small"
        destroyInactiveTabPane
        items={[
          {
            key: 'classify',
            label: '🏷️ 搜索词分类',
            children: (
              <>
                {/* Stats */}
                <Row gutter={[12, 12]} style={{ marginBottom: 14 }}>
                  <Col xs={12} sm={8} md={4}>
                    <Card size="small" className="neg-kpi-card" style={{ borderTop: '3px solid #2563eb' }}>
                      <Statistic title="总计" value={stats.total} valueStyle={{ fontSize: 20, fontWeight: 600 }} />
                    </Card>
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Card size="small" className="neg-kpi-card" style={{ borderTop: '3px solid #ef4444' }}>
                      <Statistic title="否掉" value={stats.deny} valueStyle={{ color: '#dc2626', fontSize: 20, fontWeight: 600 }} suffix={stats.total ? <Text type="secondary" style={{ fontSize: 11 }}>({(stats.deny / stats.total * 100).toFixed(1)}%)</Text> : null} />
                    </Card>
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Card size="small" className="neg-kpi-card" style={{ borderTop: '3px solid #22c55e' }}>
                      <Statistic title="保留" value={stats.keep} valueStyle={{ color: '#16a34a', fontSize: 20, fontWeight: 600 }} suffix={stats.total ? <Text type="secondary" style={{ fontSize: 11 }}>({(stats.keep / stats.total * 100).toFixed(1)}%)</Text> : null} />
                    </Card>
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Card size="small" className="neg-kpi-card" style={{ borderTop: '3px solid #f59e0b' }}>
                      <Statistic title="待审" value={stats.review} valueStyle={{ color: '#d97706', fontSize: 20, fontWeight: 600 }} />
                    </Card>
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Card size="small" className="neg-kpi-card" style={{ borderTop: '3px solid #8b5cf6' }}>
                      <Statistic title="手动修改" value={stats.manual} valueStyle={{ color: '#7c3aed', fontSize: 20, fontWeight: 600 }} />
                    </Card>
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Card size="small" className="neg-kpi-card" style={{ borderTop: '3px solid #06b6d4' }}>
                      <Statistic title="否认率" value={stats.total ? (stats.deny / stats.total * 100).toFixed(1) : '0'} suffix="%" valueStyle={{ color: stats.deny / (stats.total || 1) > 0.5 ? '#dc2626' : '#16a34a', fontSize: 20, fontWeight: 600 }} />
                    </Card>
                  </Col>
                </Row>

                {/* Action bar */}
                <Card size="small" style={{ marginBottom: 12 }} styles={{ body: { padding: '10px 12px' } }}>
                  <Flex vertical gap={8}>
                    {/* 第一行：规则开关 + 导入与智能校验 */}
                    <Flex gap={8} wrap="wrap" align="center" justify="space-between" className="neg-toolbar-row">
                      <Flex gap={8} wrap="wrap" align="center">
                        <Text strong style={{ fontSize: 12 }}>规则开关</Text>
                        <Space size={4}>
                          <Switch checked={requireCase} onChange={checked => setRequireCase(checked)} size="small" />
                          <Text type="secondary" style={{ fontSize: 12 }}>{requireCase ? '需含壳类词' : '不需壳类词'}</Text>
                        </Space>
                        <Space size={4}>
                          <Switch checked={interceptBrand} onChange={checked => setInterceptBrand(checked)} size="small" />
                          <Text type="secondary" style={{ fontSize: 12 }}>{interceptBrand ? '拦截竞品品牌' : '不拦截竞品品牌'}</Text>
                        </Space>
                      </Flex>
                      <Flex gap={6} wrap="wrap" align="center">
                        <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => { const file = e.target.files?.[0]; if (file) handleFileImport(file); e.target.value = ''; }} />
                        <Button size="small" type="primary" ghost icon={<UploadOutlined />} onClick={() => fileInputRef.current?.click()} loading={loading}>导入Excel</Button>
                        <Button size="small" icon={<ImportOutlined />} onClick={() => asinFileInputRef.current?.click()} loading={asinLoading}>导入ASIN判定结果</Button>
                        <Button size="small" icon={<ImportOutlined />} onClick={() => setActiveTab('campaign-id-map')}>Campaign ID映射</Button>
                        <Divider type="vertical" style={{ margin: '0 2px' }} />
                        <Button size="small" icon={<ThunderboltOutlined />} onClick={handleReprocess} loading={processing} disabled={data.length === 0}>
                          {data.length > 0 ? '重新分类' : '开始分类'}
                        </Button>
                        <Button size="small" icon={<SearchOutlined />} onClick={handleAudit} loading={auditLoading} disabled={data.length === 0 || !stats.total} type="primary" ghost>
                          规则校验
                        </Button>
                      </Flex>
                    </Flex>

                    {/* 第二行：导出模板 + 批量操作 + 筛选 */}
                    <Flex gap={8} wrap="wrap" align="center" justify="space-between">
                      <Flex gap={6} wrap="wrap" align="center">
                        <Tooltip title="仅导出已标记“否掉”的记录。导出前请选择 Campaign ID 所属店铺/站点；系统只按所选作用域匹配同名广告组合，避免欧洲站错配。">
                          <Space.Compact size="small">
                            <Select
                              size="small"
                              value={amazonNegativeScope}
                              onChange={value => setAmazonNegativeScope(value as AmazonNegativeScope)}
                              style={{ width: 118 }}
                              aria-label="亚马逊否词级别"
                            >
                              <Option value="campaign">广告活动否词</Option>
                              <Option value="adGroup">广告组否词</Option>
                            </Select>
                            <Select
                              size="small"
                              value={amazonNegativeMatchMode}
                              onChange={value => setAmazonNegativeMatchMode(value as AmazonNegativeMatchMode)}
                              style={{ width: 124 }}
                              aria-label="亚马逊否词匹配类型"
                            >
                              <Option value="auto">自动识别机型</Option>
                              <Option value="exact">Exact 否词</Option>
                              <Option value="phrase">Phrase 整句</Option>
                            </Select>
                            <Select
                              size="small"
                              value={campaignIdExportStore || defaultCampaignIdExportScope}
                              onChange={value => setCampaignIdExportStore(String(value).trim().toUpperCase())}
                              style={{ width: 185 }}
                              showSearch
                              optionFilterProp="children"
                              aria-label="Amazon 模板 Campaign ID 映射店铺和站点"
                            >
                              {campaignIdScopeOptions.map(option => (
                                <Option key={`export-store-${option.scope}`} value={option.scope}>
                                  {campaignIdScopeLabel(option)}
                                </Option>
                              ))}
                            </Select>
                            <Button
                              type="primary"
                              size="small"
                              icon={<FileExcelOutlined />}
                              onClick={handleExportAmazonTemplate}
                              loading={amazonTemplateExporting}
                              disabled={data.filter(r => r.tag === 'deny').length === 0}
                            >
                              导出Amazon后台模板
                            </Button>
                          </Space.Compact>
                        </Tooltip>
                        <Button size="small" icon={<DownloadOutlined />} onClick={handleExport} disabled={data.length === 0}>导出全部</Button>
                        <Button size="small" icon={<FileExcelOutlined />} onClick={handleExportDenyList} disabled={data.filter(r => r.tag === 'deny').length === 0} danger>导出否词</Button>
                        <Button size="small" icon={<TableOutlined />} onClick={handleExportByGroup} disabled={data.length === 0}>按机型组导出</Button>
                        <Button
                          size="small"
                          type="dashed"
                          loading={geminiAuditing}
                          disabled={data.filter(r => r.tag === 'deny').length === 0}
                          onClick={async () => {
                            const denyRows = data.filter(r => r.tag === 'deny').slice(0, 100);
                            if (denyRows.length === 0) return;
                            setGeminiAuditing(true);
                            try {
                              const res = await apiFetch('/api/gemini-audit', {
                                method: 'POST',
                                body: JSON.stringify({
                                  site: activeMarketplaceRef.current || 'US',
                                  rows: denyRows.map(r => ({
                                    key: r.key,
                                    campaign: r.campaign,
                                    searchTerm: r.searchTerm,
                                    targetGroup: r.targetGroupName || '',
                                    reason: r.reason || '',
                                  })),
                                }),
                                timeoutMs: 60000,
                              });
                              if (res?.error) throw new Error(res.error);
                              setGeminiAuditMeta({
                                model: res.model,
                                auditedCount: res.audited_count,
                                falseDenyCount: res.false_deny_count,
                              });
                              setGeminiAuditRows(Array.isArray(res.results) ? res.results : []);
                              setGeminiAuditModalOpen(true);
                            } catch (err: any) {
                              message.error(`Gemini 复核失败: ${err?.message || err}`);
                            } finally {
                              setGeminiAuditing(false);
                            }
                          }}
                        >
                          Gemini AI 复核误否
                        </Button>
                      </Flex>
                      <Modal
                        title={`Gemini AI 否词复核报告 (${geminiAuditMeta.model || 'Gemini'})`}
                        open={geminiAuditModalOpen}
                        onCancel={() => setGeminiAuditModalOpen(false)}
                        width={920}
                        footer={[
                          <Button key="close" onClick={() => setGeminiAuditModalOpen(false)}>关闭</Button>,
                          <Button
                            key="apply-keep"
                            type="primary"
                            disabled={!geminiAuditRows.some(r => r.verdict === 'false_deny')}
                            onClick={() => {
                              const keepKeys = new Set(
                                geminiAuditRows.filter(r => r.verdict === 'false_deny').map(r => r.key),
                              );
                              setData(prev => prev.map(row => (
                                keepKeys.has(row.key)
                                  ? { ...row, tag: 'keep', reason: `Gemini AI 复核放行 (${row.reason})` }
                                  : row
                              )));
                              message.success(`已将 ${keepKeys.size} 条误否词改为「保留」`);
                              setGeminiAuditModalOpen(false);
                            }}
                          >
                            一键将 {geminiAuditRows.filter(r => r.verdict === 'false_deny').length} 条误否词改为保留
                          </Button>,
                        ]}
                      >
                        <Flex vertical gap={10}>
                          <Flex gap={8} wrap="wrap">
                            <Tag color="blue">本次复核 {geminiAuditMeta.auditedCount || 0} 条（按当前否词前 100 条）</Tag>
                            <Tag color="red">疑似误否 {geminiAuditRows.filter(r => r.verdict === 'false_deny').length} 条</Tag>
                            <Tag color="green">确认否掉 {geminiAuditRows.filter(r => r.verdict === 'correct_deny').length} 条</Tag>
                            <Tag color="gold">待定 {geminiAuditRows.filter(r => r.verdict === 'uncertain').length} 条</Tag>
                          </Flex>
                          <Table
                            size="small"
                            rowKey="key"
                            pagination={{ pageSize: 20 }}
                            scroll={{ y: 420 }}
                            dataSource={geminiAuditRows}
                            columns={[
                              {
                                title: 'AI 判定',
                                dataIndex: 'verdict',
                                width: 95,
                                filters: [
                                  { text: '误否', value: 'false_deny' },
                                  { text: '确认否掉', value: 'correct_deny' },
                                  { text: '待定', value: 'uncertain' },
                                ],
                                onFilter: (val, rec) => rec.verdict === val,
                                render: (v: string) => v === 'false_deny'
                                  ? <Tag color="red">疑似误否</Tag>
                                  : v === 'correct_deny'
                                    ? <Tag color="green">确认否掉</Tag>
                                    : <Tag color="gold">待定</Tag>,
                              },
                              { title: '广告活动', dataIndex: 'campaign', width: 200, ellipsis: true },
                              { title: '搜索词', dataIndex: 'searchTerm', width: 190 },
                              { title: '原否词原因', dataIndex: 'reason', width: 170, ellipsis: true },
                              { title: 'Gemini 复核意见', dataIndex: 'note' },
                            ]}
                          />
                        </Flex>
                      </Modal>

                      <Flex gap={6} wrap="wrap" align="center">
                        {selectedRowKeys.length > 0 && (
                          <Space size={4}>
                            <Tag color="blue" style={{ margin: 0 }}>已选 {selectedRowKeys.length} 条</Tag>
                            <Button size="small" danger onClick={() => handleBatchTag('deny')}>批量否掉</Button>
                            <Button size="small" type="primary" onClick={() => handleBatchTag('keep')}>批量保留</Button>
                            <Button size="small" onClick={() => handleBatchTag('review')}>批量待审</Button>
                            <Divider type="vertical" />
                          </Space>
                        )}
                        <Select value={filter.tag} onChange={val => setFilter(prev => ({ ...prev, tag: val }))} style={{ width: 105 }} size="small" allowClear placeholder="全部标注">
                          <Option value="deny">🔴 否掉</Option>
                          <Option value="keep">🟢 保留</Option>
                          <Option value="review">🟡 待审</Option>
                        </Select>
                        <Input placeholder="搜索关键词..." value={filter.searchTerm} onChange={e => setFilter(prev => ({ ...prev, searchTerm: e.target.value }))} style={{ width: 175 }} size="small" prefix={<SearchOutlined />} allowClear />
                        <Select value={filter.campaign} onChange={val => setFilter(prev => ({ ...prev, campaign: val || '' }))} style={{ width: 155 }} size="small" allowClear showSearch placeholder="筛选广告活动">
                          {campaignList.map(c => <Option key={c} value={c}>{c}</Option>)}
                        </Select>
                        <Tag style={{ margin: 0 }}>{filteredData.length} / {data.length}</Tag>
                      </Flex>
                    </Flex>
                  </Flex>
                </Card>

                {/* Progress */}
                {processing && <Progress percent={progress.total ? Math.round(progress.done / progress.total * 100) : 0} status="active" style={{ marginBottom: 12 }} format={() => `${progress.done} / ${progress.total}`} />}

                {/* Data table */}
                <Table<KeywordRow>
                  columns={columns}
                  dataSource={filteredData}
                  rowKey="key"
                  size="small"
                  scroll={{ x: 1100, y: 'calc(100vh - 510px)' }}
                  pagination={{ pageSize: 100, showSizeChanger: true, pageSizeOptions: ['50', '100', '200', '500'], showTotal: (total) => `共 ${total} 条` }}
                  rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
                  rowClassName={(record) => {
                    if (record.tag === 'deny') return 'row-deny';
                    if (record.tag === 'keep') return 'row-keep';
                    return 'row-review';
                  }}
                  locale={{ emptyText: <Empty description="请点击上方「导入Excel」开始否词分类" /> }}
                />
              </>
            ),
          },
          {
            key: 'asin-negative',
            label: `🧩 ASIN否定${asinRows.length ? ` (${asinRows.length})` : ''}`,
            children: (
              <>
                <Row gutter={[12, 12]} style={{ marginBottom: 14 }}>
                  <Col xs={12} sm={4}>
                    <Card size="small" className="neg-kpi-card" style={{ borderTop: '3px solid #2563eb' }}>
                      <Statistic title="总计 ASIN" value={asinRows.length} valueStyle={{ fontSize: 20, fontWeight: 600 }} />
                    </Card>
                  </Col>
                  <Col xs={12} sm={4}>
                    <Card size="small" className="neg-kpi-card" style={{ borderTop: '3px solid #ef4444' }}>
                      <Statistic title="明确否定" value={asinRows.filter(row => row.decision === 'deny').length} valueStyle={{ color: '#dc2626', fontSize: 20, fontWeight: 600 }} />
                    </Card>
                  </Col>
                  <Col xs={12} sm={4}>
                    <Card size="small" className="neg-kpi-card" style={{ borderTop: '3px solid #22c55e' }}>
                      <Statistic title="明确保留" value={asinRows.filter(row => row.decision === 'keep').length} valueStyle={{ color: '#16a34a', fontSize: 20, fontWeight: 600 }} />
                    </Card>
                  </Col>
                  <Col xs={12} sm={4}>
                    <Card size="small" className="neg-kpi-card" style={{ borderTop: '3px solid #f59e0b' }}>
                      <Statistic title="待复核" value={asinRows.filter(row => row.decision === 'review').length} valueStyle={{ color: '#d97706', fontSize: 20, fontWeight: 600 }} />
                    </Card>
                  </Col>
                  <Col xs={12} sm={4}>
                    <Card size="small" className="neg-kpi-card" style={{ borderTop: '3px solid #8b5cf6' }}>
                      <Statistic title="Campaign ID 已匹配" value={asinRows.filter(row => row.decision === 'deny' && row.campaignId).length} valueStyle={{ color: '#2563eb', fontSize: 20, fontWeight: 600 }} />
                    </Card>
                  </Col>
                  <Col xs={12} sm={4}>
                    <Card size="small" className="neg-kpi-card" style={{ borderTop: '3px solid #14b8a6' }}>
                      <Statistic title="Ad Group ID 已匹配" value={asinRows.filter(row => row.decision === 'deny' && row.adGroupId).length} valueStyle={{ color: '#0d9488', fontSize: 20, fontWeight: 600 }} />
                    </Card>
                  </Col>
                </Row>
                <Card size="small" style={{ marginBottom: 16 }}>
                  <Flex gap={10} wrap="wrap" align="center" style={{ marginBottom: 10 }}>
                    <Button
                      type="primary"
                      icon={<ThunderboltOutlined />}
                      onClick={() => autoAsinFileInputRef.current?.click()}
                      loading={autoAsinLoading}
                      style={{ background: 'linear-gradient(135deg, #1d4ed8, #2563eb)', borderColor: '#1d4ed8', fontWeight: 600 }}
                    >
                      ⚡ 导入报表自动判定ASIN
                    </Button>
                    <Button
                      icon={<FolderOpenOutlined />}
                      onClick={handleExportAsinFolder}
                      loading={asinFolderExporting}
                      disabled={asinRows.length === 0}
                      style={{ borderColor: '#8b5cf6', color: '#6d28d9', fontWeight: 500 }}
                    >
                      📁 导出判定文件夹
                    </Button>
                    <Button
                      icon={<FileExcelOutlined />}
                      onClick={handleExportAsinFullExcel}
                      disabled={asinRows.length === 0}
                    >
                      📊 导出完整判定Excel
                    </Button>
                    <Button
                      icon={<ExportOutlined />}
                      onClick={handleExportNegativeAsinTemplate}
                      loading={asinTemplateExporting}
                      disabled={asinRows.filter(row => row.decision === 'deny').length === 0}
                    >
                      ⚡ 导出Amazon否ASIN模板
                    </Button>
                    <Divider type="vertical" style={{ height: 20 }} />
                    <Button
                      size="small"
                      icon={<UploadOutlined />}
                      onClick={() => asinFileInputRef.current?.click()}
                      loading={asinLoading}
                    >
                      导入已判定结果
                    </Button>
                  </Flex>
                  <Flex gap={8} wrap="wrap" align="center">
                    <Text strong>导出站点/ID映射:</Text>
                    <Select
                      size="small"
                      value={asinExportScope || defaultCampaignIdExportScope}
                      onChange={value => setAsinExportScope(String(value).trim().toUpperCase())}
                      style={{ width: 220 }}
                      showSearch
                      optionFilterProp="children"
                      aria-label="ASIN模板 Campaign ID 映射店铺和站点"
                    >
                      {campaignIdScopeOptions.map(option => (
                        <Option key={`asin-export-scope-${option.scope}`} value={option.scope}>{campaignIdScopeLabel(option)}</Option>
                      ))}
                    </Select>
                    <Text strong>否定级别:</Text>
                    <Select
                      size="small"
                      value={asinNegativeScope}
                      onChange={value => setAsinNegativeScope(value as AmazonNegativeScope)}
                      style={{ width: 200 }}
                    >
                      <Option value="campaign">广告活动级否 ASIN</Option>
                      <Option value="adGroup">广告组级否 ASIN</Option>
                    </Select>
                  </Flex>
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginTop: 10 }}
                    message="自动判定与导出说明"
                    description="点击「⚡ 导入报表自动判定ASIN」上传搜索词广告报表，系统将自动调取西柚 MCP 批量查询 ASIN 标题五点并进行机型兼容性智能判定。判定后点击「📁 导出判定文件夹」将自动在本地生成完整 32 列判定明细与 Amazon 官方上传模板，并在资源管理器中直接打开。"
                  />
                </Card>
                <Table<AsinRow>
                  columns={asinColumns}
                  dataSource={asinRows}
                  rowKey="key"
                  size="small"
                  scroll={{ x: 2100, y: 'calc(100vh - 580px)' }}
                  pagination={{ pageSize: 100, showSizeChanger: true, pageSizeOptions: ['50', '100', '200', '500'], showTotal: total => `${total} 条` }}
                  rowClassName={record => record.decision === 'deny' ? 'row-deny' : record.decision === 'keep' ? 'row-keep' : 'row-review'}
                  locale={{ emptyText: <Empty description="请点击上方「⚡ 导入报表自动判定ASIN」开始智能判定" /> }}
                />

                {/* 自动判定确认 Modal */}
                <Modal
                  title="⚡ 智能 ASIN 判定确认 (调取西柚 MCP)"
                  open={autoAsinModalVisible}
                  onCancel={() => !autoAsinLoading && setAutoAsinModalVisible(false)}
                  footer={[
                    <Button key="cancel" disabled={autoAsinLoading} onClick={() => setAutoAsinModalVisible(false)}>
                      取消
                    </Button>,
                    <Button
                      key="run"
                      type="primary"
                      icon={<ThunderboltOutlined />}
                      loading={autoAsinLoading}
                      onClick={handleRunAutoAsinAudit}
                    >
                      {autoAsinLoading ? '正在调取西柚MCP判定中...' : '🚀 开始自动判定'}
                    </Button>,
                  ]}
                  destroyOnClose
                  width={560}
                >
                  {autoAsinPendingFile && (
                    <div style={{ marginTop: 8 }}>
                      <Alert
                        type="success"
                        showIcon
                        message={`已读取文件：${autoAsinPendingFile.fileName}`}
                        description={`共 ${autoAsinPendingFile.rows.length} 行数据。请确认以下列映射与站点，系统将自动调取西柚 MCP 查询商品标题五点并执行机型判定。`}
                        style={{ marginBottom: 16 }}
                      />
                      {autoAsinLoading && (
                        <div style={{ marginBottom: 16, textAlign: 'center' }}>
                          <Progress percent={85} status="active" />
                          <div style={{ marginTop: 8, color: '#1677ff', fontSize: 13 }}>{autoAsinProgress.text}</div>
                        </div>
                      )}
                      <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '12px 8px', alignItems: 'center' }}>
                        <Text strong>目标站点:</Text>
                        <Select
                          value={autoAsinMapping.country}
                          onChange={v => setAutoAsinMapping(m => ({ ...m, country: v }))}
                          disabled={autoAsinLoading}
                        >
                          <Option value="US">美国 (US)</Option>
                          <Option value="DE">德国 (DE)</Option>
                          <Option value="UK">英国 (UK)</Option>
                          <Option value="FR">法国 (FR)</Option>
                          <Option value="IT">意大利 (IT)</Option>
                          <Option value="ES">西班牙 (ES)</Option>
                          <Option value="CA">加拿大 (CA)</Option>
                          <Option value="JP">日本 (JP)</Option>
                        </Select>

                        <Text strong>ASIN / 搜索词列:</Text>
                        <Select
                          value={autoAsinMapping.asinCol}
                          onChange={v => setAutoAsinMapping(m => ({ ...m, asinCol: v }))}
                          disabled={autoAsinLoading}
                        >
                          {autoAsinPendingFile.headers.map(h => (
                            <Option key={h} value={h}>{h}</Option>
                          ))}
                        </Select>

                        <Text strong>目标机型列:</Text>
                        <Select
                          value={autoAsinMapping.modelCol}
                          onChange={v => setAutoAsinMapping(m => ({ ...m, modelCol: v }))}
                          disabled={autoAsinLoading}
                          allowClear
                          placeholder="选择机型列（留空则从活动名解析）"
                        >
                          {autoAsinPendingFile.headers.map(h => (
                            <Option key={h} value={h}>{h}</Option>
                          ))}
                        </Select>

                        <Text strong>广告活动名称列:</Text>
                        <Select
                          value={autoAsinMapping.campaignCol}
                          onChange={v => setAutoAsinMapping(m => ({ ...m, campaignCol: v }))}
                          disabled={autoAsinLoading}
                          allowClear
                        >
                          {autoAsinPendingFile.headers.map(h => (
                            <Option key={h} value={h}>{h}</Option>
                          ))}
                        </Select>

                        <Text strong>广告组名称列:</Text>
                        <Select
                          value={autoAsinMapping.adGroupCol}
                          onChange={v => setAutoAsinMapping(m => ({ ...m, adGroupCol: v }))}
                          disabled={autoAsinLoading}
                          allowClear
                        >
                          {autoAsinPendingFile.headers.map(h => (
                            <Option key={h} value={h}>{h}</Option>
                          ))}
                        </Select>
                      </div>
                    </div>
                  )}
                </Modal>

                {/* 隐藏的文件上传 input */}
                <input
                  type="file"
                  ref={autoAsinFileInputRef}
                  style={{ display: 'none' }}
                  accept=".xlsx,.xls,.csv"
                  onChange={handleAutoAsinFileSelect}
                />
              </>
            ),
          },
          {
            key: 'campaign-map',
            label: '🗺️ Campaign映射',
            children: <CampaignMapEditor />,
          },
          {
            key: 'campaign-id-map',
            label: '🆔 Campaign ID',
            children: (
              <CampaignIdMapEditor
                mappings={campaignIdMappings}
                stores={stores}
                activeStoreKey={activeShopKey || activeMarketplace}
                activeStoreLabel={activeStore?.storeName || activeShopKey || activeMarketplace}
                onSave={saveCampaignIdMappings}
              />
            ),
          },
          {
            key: 'model-groups',
            label: '📱 机型拓词',
            children: <ModelGroupEditor />,
          },
          {
            key: 'deny-library',
            label: '📚 否词库',
            children: <DenyLibraryEditor />,
          },
          {
            key: 'rules',
            label: '⚙️ 规则设置 (全局)',
            children: (
              <Tabs
                type="card"
                size="small"
                items={[
                  {
                    key: 'deny-brands',
                    label: '🚫 竞品品牌',
                    children: (
                      <Card size="small">
                        <TextListEditor
                          title="竞品品牌"
                          items={denyBrands}
                          onChange={handleDenyBrandsChange}
                          hint="每行一个品牌关键词（小写），匹配到这些品牌的搜索词将自动否掉"
                        />
                      </Card>
                    ),
                  },
                  {
                    key: 'deny-models',
                    label: '🚫 非目标机型',
                    children: (
                      <Card size="small">
                        <TextListEditor
                          title="非目标机型"
                          items={denyModels}
                          onChange={handleDenyModelsChange}
                          hint="每行一个机型关键词（小写），匹配到这些机型的搜索词将自动否掉"
                        />
                      </Card>
                    ),
                  },
                  {
                    key: 'keep-case',
                    label: '✅ 壳类词',
                    children: (
                      <Card size="small">
                        <TextListEditor
                          title="壳类词"
                          items={keepCaseWords}
                          onChange={handleKeepCaseWordsChange}
                          hint="每行一个壳类关键词（小写）。需含壳类词模式：机型词+壳类词=保留，仅机型词=否掉；不需壳类词模式：机型匹配即保留"
                        />
                      </Card>
                    ),
                  },
                  {
                    key: 'screen-protector',
                    label: '🛡️ 屏幕保护膜词',
                    children: (
                      <Card size="small">
                        <TextListEditor
                          title="屏幕保护膜词"
                          items={screenProtectorWords}
                          onChange={handleScreenProtectorWordsChange}
                          hint="每行一个屏幕保护膜关键词（小写），匹配到这些词且无壳类词的搜索词将自动否掉。内置中英文德语：screen protector/panzerglass/displayschutz/schutzglas/schutzfolie等"
                        />
                      </Card>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: 'alias-rules',
            label: '📝 别名规则',
            children: <AliasRuleEditor />,
          },
          {
            key: 'logs',
            label: '📋 操作日志',
            children: <OperationLogViewer />,
          },
        ]}
      />

      {/* === 否词结果规则审核结果面板 === */}
      <Drawer
        title={
          <Space>
            <span>🔍 否词结果规则审核报告</span>
            {auditResult?.summary && (
              <Space size={4}>
                <Badge count={auditResult.summary.high_priority} style={{ backgroundColor: '#cf1322' }} overflowCount={999} />
                <span style={{ fontSize: 12, color: '#666' }}>紧急</span>
                <Badge count={auditResult.summary.medium_priority} style={{ backgroundColor: '#fa8c16' }} overflowCount={999} />
                <span style={{ fontSize: 12, color: '#666' }}>高</span>
                <Badge count={auditResult.summary.total_issues - auditResult.summary.high_priority - auditResult.summary.medium_priority} style={{ backgroundColor: '#1890ff' }} overflowCount={999} />
                <span style={{ fontSize: 12, color: '#666' }}>中/低</span>
              </Space>
            )}
          </Space>
        }
        placement="right"
        width={900}
        open={auditDrawerOpen}
        onClose={() => setAuditDrawerOpen(false)}
        extra={
          <Space>
            <Button size="small" onClick={downloadAuditXlsx} disabled={!auditResult}>
              <FileExcelOutlined /> 导出Excel(分Sheet)
            </Button>
            <Button size="small" onClick={downloadAuditCsv} disabled={!auditResult}>
              <DownloadOutlined /> 下载修正清单CSV
            </Button>
          </Space>
        }
      >
        {auditResult && (
          <>
            {/* 总体评估 */}
            {auditResult.summary && (
              <Alert
                type={auditResult.summary.high_priority > 0 ? 'warning' : 'success'}
                showIcon
                message={
                  <Space>
                    <strong>总体评估：{auditResult.summary.overall_assessment}</strong>
                    <Text type="secondary">
                      保留 {auditResult.summary.total_keep} 词 / 否掉 {auditResult.summary.total_deny} 词 / 
                      总计 {auditResult.summary.total_issues} 个问题
                    </Text>
                  </Space>
                }
                style={{ marginBottom: 16 }}
              />
            )}

            {/* 建议操作 */}
            {auditResult.recommendations?.length > 0 && (
              <Card size="small" title="📋 建议操作（按优先级）" style={{ marginBottom: 16 }}>
                {auditResult.recommendations.map((rec: any, i: number) => (
                  <Alert
                    key={i}
                    type={rec.priority === '紧急' ? 'error' : rec.priority === '高' ? 'warning' : 'info'}
                    showIcon
                    message={<><Tag color={rec.priority === '紧急' ? 'red' : rec.priority === '高' ? 'orange' : 'blue'}>{rec.priority}</Tag>{rec.action}</>}
                    style={{ marginBottom: 8 }}
                  />
                ))}
              </Card>
            )}

            {/* 汇总统计看板 */}
            {auditResult.checks && (
              <Card size="small" title="📊 问题汇总" style={{ marginBottom: 16 }}>
                <Row gutter={[8, 8]}>
                  {Object.entries(auditResult.checks).map(([key, check]: [string, any]) => {
                    if (!check.count) return null;
                    const colors: Record<string, string> = {
                      conflicts: '#cf1322', false_negatives: '#fa541c', model_mismatch: '#fa8c16',
                      noise_in_keep: '#fadb14', year_mismatch: '#a0d911', duplicates: '#1890ff',
                      broad_terms: '#52c41a', brand_analysis: '#722ed1',
                    };
                    const icons: Record<string, string> = {
                      conflicts: '⚡', false_negatives: '🔴', model_mismatch: '🔄', noise_in_keep: '🧹',
                      year_mismatch: '📅', duplicates: '📑', broad_terms: '🌊', brand_analysis: '🏷️',
                    };
                    return (
                      <Col span={6} key={key}>
                        <Card size="small" hoverable style={{ textAlign: 'center', cursor: 'pointer' }}
                          onClick={() => setAuditActiveTab(key)}>
                          <Statistic
                            title={<span style={{ fontSize: 12 }}>{icons[key] || ''} {check.type?.slice(0, 8) || key}</span>}
                            value={check.count}
                            valueStyle={{ color: colors[key] || '#333', fontSize: 22 }}
                          />
                        </Card>
                      </Col>
                    );
                  })}
                </Row>
              </Card>
            )}

            {/* 一键应用修正按钮 */}
            {auditResult.checks && (
              <Flex gap={8} style={{ marginBottom: 12 }}>
                <Button
                  type="primary"
                  icon={<ThunderboltOutlined />}
                  loading={applyingFixes}
                  onClick={() => {
                    // 收集所有有建议操作的issue
                    const allIssues: any[] = [];
                    Object.values(auditResult.checks).forEach((check: any) => {
                      if (Array.isArray(check.items)) {
                        check.items.forEach((item: any) => {
                          if (item.suggestion && item.term) allIssues.push(item);
                        });
                      }
                    });
                    handleApplyFixes(allIssues);
                  }}
                >
                  一键应用所有修正 ({String(Object.values(auditResult.checks).reduce((s: number, c: any) => s + (Array.isArray(c.items) ? c.items.filter((i: any) => i.suggestion && i.term).length : 0), 0))}条)
                </Button>
                <Text type="secondary" style={{ fontSize: 12, lineHeight: '32px' }}>
                  将修正建议应用到数据表（误否→恢复保留、无关词→补否）
                </Text>
              </Flex>
            )}

            {/* 审核进度条 */}
            {auditProgress.total > 0 && auditProgress.done < auditProgress.total && (
              <Progress percent={Math.round(auditProgress.done / auditProgress.total * 100)} status="active" style={{ marginBottom: 12 }}
                format={() => `审核中 ${auditProgress.done} / ${auditProgress.total}`} />
            )}

            {/* 详细问题列表 */}
            <Tabs
              size="small"
              type="card"
              activeKey={auditActiveTab}
              onChange={setAuditActiveTab}
              items={[
                // 汇总Tab
                {
                  key: 'summary',
                  label: `📊 汇总`,
                  children: (
                    <Card size="small" title="各类问题分布">
                      <Table size="small" dataSource={Object.entries(auditResult.checks || {}).filter(([,c]: any) => c.count > 0).map(([k, c]: [string, any]) => ({
                        key: k, type: c.type || k, count: c.count,
                        severity: c.severity === 'high' ? '紧急' : c.severity === 'medium' ? '高' : '中',
                        summary: c.summary || '',
                      }))} rowKey="key" pagination={false}
                        columns={[
                          { title: '问题类型', dataIndex: 'type', width: 180 },
                          { title: '数量', dataIndex: 'count', width: 80 },
                          { title: '严重程度', dataIndex: 'severity', width: 100, render: (v: string) => <Tag color={v === '紧急' ? 'red' : v === '高' ? 'orange' : 'blue'}>{v}</Tag> },
                          { title: '说明', dataIndex: 'summary', width: 400 },
                        ]} />
                    </Card>
                  ),
                },
                ...(auditResult.checks?.conflicts?.count > 0 ? [{
                  key: 'conflicts',
                  label: `⚡冲突词 (${auditResult.checks.conflicts.count})`,
                  children: (
                    <Card size="small" title={auditResult.checks.conflicts.summary}
                      extra={<Button size="small" type="primary" ghost onClick={() => handleApplyFixes(auditResult.checks.conflicts.items.filter((i: any) => i.term))}>全部应用</Button>}>
                      <Table size="small" dataSource={auditResult.checks.conflicts.items.slice(0, 100)} rowKey="term" pagination={{ pageSize: 20 }}
                        columns={[
                          { title: '关键词', dataIndex: 'term', width: 220, render: (t: string) => <Text copyable style={{ fontSize: 12 }}>{t}</Text> },
                          { title: '保留在', dataIndex: 'keep_in', width: 130, render: (v: string[]) => v?.join(', ') },
                          { title: '否掉在', dataIndex: 'deny_in', width: 130, render: (v: string[]) => <Text type="danger">{v?.join(', ')}</Text> },
                          { title: '建议', dataIndex: 'suggestion', width: 200 },
                          { title: '操作', width: 70, render: (_: any, record: any) => record.term ? (
                            <Button size="small" type="link" onClick={() => handleApplyFixes([record])}>应用</Button>
                          ) : null },
                        ]} scroll={{ x: 800 }} />
                    </Card>
                  ),
                }] : []),
                ...(auditResult.checks?.false_negatives?.count > 0 ? [{
                  key: 'false-negatives', label: `🔴误否 (${auditResult.checks.false_negatives.count})`,
                  children: (
                    <Card size="small" title={auditResult.checks.false_negatives.summary}
                      extra={<Button size="small" type="primary" ghost onClick={() => handleApplyFixes(auditResult.checks.false_negatives.items.filter((i: any) => i.term))}>全部应用</Button>}>
                      <Table size="small" dataSource={auditResult.checks.false_negatives.items.slice(0, 100)} rowKey={(r: any) => r.term + r.group} pagination={{ pageSize: 20 }}
                        columns={[
                          { title: '关键词', dataIndex: 'term', width: 220, render: (t: string) => <Text copyable style={{ fontSize: 12 }}>{t}</Text> },
                          { title: '机型组', dataIndex: 'group', width: 100 },
                          { title: '问题类型', dataIndex: 'issue_type', width: 100 },
                          { title: '建议', dataIndex: 'suggestion', width: 160 },
                          { title: '操作', width: 60, render: (_: any, record: any) => record.term ? (
                            <Button size="small" type="link" onClick={() => handleApplyFixes([record])}>应用</Button>
                          ) : null },
                        ]} scroll={{ x: 700 }} />
                    </Card>
                  ),
                }] : []),
                ...(auditResult.checks?.model_mismatch?.count > 0 ? [{
                  key: 'model-mismatch', label: `🔄机型错配 (${auditResult.checks.model_mismatch.count})`,
                  children: (
                    <Card size="small" title={auditResult.checks.model_mismatch.summary}
                      extra={<Button size="small" type="primary" ghost onClick={() => handleApplyFixes(auditResult.checks.model_mismatch.items.filter((i: any) => i.term))}>全部应用</Button>}>
                      <Table size="small" dataSource={auditResult.checks.model_mismatch.items.slice(0, 100)} rowKey={(r: any) => r.term + r.issue_type} pagination={{ pageSize: 20 }}
                        columns={[
                          { title: '关键词', dataIndex: 'term', width: 220, render: (t: string) => <Text copyable style={{ fontSize: 12 }}>{t}</Text> },
                          { title: '工具标注', dataIndex: 'reason', width: 160 },
                          { title: '正确机型', dataIndex: 'correct_model', width: 100 },
                          { title: '问题', dataIndex: 'issue_type', width: 130 },
                          { title: '建议', dataIndex: 'suggestion', width: 160 },
                          { title: '操作', width: 60, render: (_: any, record: any) => record.term ? (
                            <Button size="small" type="link" onClick={() => handleApplyFixes([record])}>应用</Button>
                          ) : null },
                        ]} scroll={{ x: 900 }} />
                    </Card>
                  ),
                }] : []),
                ...(auditResult.checks?.noise_in_keep?.count > 0 ? [{
                  key: 'noise', label: `🧹无关词 (${auditResult.checks.noise_in_keep.count})`,
                  children: (
                    <Card size="small" title={auditResult.checks.noise_in_keep.summary}
                      extra={<Button size="small" type="primary" ghost onClick={() => handleApplyFixes(auditResult.checks.noise_in_keep.items.filter((i: any) => i.term))}>全部应用</Button>}>
                      <Table size="small" dataSource={auditResult.checks.noise_in_keep.items.slice(0, 100)} rowKey={(r: any) => r.term + r.issue_type} pagination={{ pageSize: 20 }}
                        columns={[
                          { title: '关键词', dataIndex: 'term', width: 220, render: (t: string) => <Text copyable style={{ fontSize: 12 }}>{t}</Text> },
                          { title: '机型组', dataIndex: 'group', width: 100 },
                          { title: '问题类型', dataIndex: 'issue_type', width: 130 },
                          { title: '建议', dataIndex: 'suggestion', width: 200 },
                          { title: '操作', width: 60, render: (_: any, record: any) => record.term ? (
                            <Button size="small" type="link" onClick={() => handleApplyFixes([record])}>应用</Button>
                          ) : null },
                        ]} scroll={{ x: 770 }} />
                    </Card>
                  ),
                }] : []),
                ...(auditResult.checks?.year_mismatch?.count > 0 ? [{
                  key: 'year-mismatch', label: `📅年份错配 (${auditResult.checks.year_mismatch.count})`,
                  children: (
                    <Card size="small" title={auditResult.checks.year_mismatch.summary}
                      extra={<Button size="small" type="primary" ghost onClick={() => handleApplyFixes(auditResult.checks.year_mismatch.items.filter((i: any) => i.term))}>全部应用</Button>}>
                      <Table size="small" dataSource={auditResult.checks.year_mismatch.items.slice(0, 100)} rowKey={(r: any) => r.term + r.group} pagination={{ pageSize: 20 }}
                        columns={[
                          { title: '关键词', dataIndex: 'term', width: 220, render: (t: string) => <Text copyable style={{ fontSize: 12 }}>{t}</Text> },
                          { title: '所在组', dataIndex: 'group', width: 100 },
                          { title: '词中年份', dataIndex: 'term_year', width: 70 },
                          { title: '组年份', dataIndex: 'group_year', width: 70 },
                          { title: '建议', dataIndex: 'suggestion', width: 200 },
                          { title: '操作', width: 60, render: (_: any, record: any) => record.term ? (
                            <Button size="small" type="link" onClick={() => handleApplyFixes([record])}>应用</Button>
                          ) : null },
                        ]} scroll={{ x: 780 }} />
                    </Card>
                  ),
                }] : []),
                ...(auditResult.checks?.duplicates?.count > 0 ? [{
                  key: 'duplicates', label: `📑重复词 (${auditResult.checks.duplicates.count})`,
                  children: (
                    <Card size="small" title={auditResult.checks.duplicates.summary}>
                      <Table size="small" dataSource={auditResult.checks.duplicates.items} rowKey="group" pagination={{ pageSize: 20 }}
                        columns={[
                          { title: '机型组', dataIndex: 'group', width: 150 },
                          { title: '重复条数', dataIndex: 'count', width: 100 },
                        ]} />
                    </Card>
                  ),
                }] : []),
                ...(auditResult.checks?.broad_terms?.count > 0 ? [{
                  key: 'broad', label: `🌊泛词 (${auditResult.checks.broad_terms.count})`,
                  children: (
                    <Card size="small" title={auditResult.checks.broad_terms.summary}
                      extra={<Button size="small" type="primary" ghost onClick={() => handleApplyFixes(auditResult.checks.broad_terms.items.filter((i: any) => i.term))}>全部应用</Button>}>
                      <Table size="small" dataSource={auditResult.checks.broad_terms.items.slice(0, 50)} rowKey={(r: any) => r.term + r.group} pagination={{ pageSize: 20 }}
                        columns={[
                          { title: '关键词', dataIndex: 'term', width: 220, render: (t: string) => <Text copyable style={{ fontSize: 12 }}>{t}</Text> },
                          { title: '机型组', dataIndex: 'group', width: 100 },
                          { title: '建议', dataIndex: 'suggestion', width: 300 },
                          { title: '操作', width: 60, render: (_: any, record: any) => record.term ? (
                            <Button size="small" type="link" onClick={() => handleApplyFixes([record])}>应用</Button>
                          ) : null },
                        ]} scroll={{ x: 720 }} />
                    </Card>
                  ),
                }] : []),
                ...(auditResult.checks?.brand_analysis?.count > 0 ? [{
                  key: 'brand', label: `🏷️品牌分析 (${auditResult.checks.brand_analysis.count})`,
                  children: (
                    <Card size="small" title={auditResult.checks.brand_analysis.summary}>
                      <Tabs size="small" items={Object.entries(auditResult.checks.brand_analysis.items || {}).map(([brand, entries]: [string, any]) => ({
                        key: brand, label: `${brand} (${Array.isArray(entries) ? entries.length : 0})`,
                        children: (
                          <Table size="small" dataSource={Array.isArray(entries) ? entries.slice(0, 50) : []} rowKey={((r: any, i: number) => String(r.term) + i) as any} pagination={{ pageSize: 20 }}
                            columns={[
                              { title: '关键词', dataIndex: 'term', width: 250, render: (t: string) => <Text copyable style={{ fontSize: 12 }}>{t}</Text> },
                              { title: '标注', dataIndex: 'tag', width: 80, render: (t: string) => <Tag color={t === 'keep' ? 'green' : 'red'}>{t}</Tag> },
                              { title: '机型组', dataIndex: 'group', width: 120 },
                            ]} />
                        ),
                      }))} />
                    </Card>
                  ),
                }] : []),
                ...(auditResult.config_improvements?.length > 0 ? [{
                  key: 'improvements', label: `🛠️工具改进建议 (${auditResult.config_improvements.length})`,
                  children: (
                    <Card size="small" title="否词工具改进建议（可反馈给ERP供应商）">
                      <Table size="small" dataSource={auditResult.config_improvements} rowKey="area" pagination={false}
                        columns={[
                          { title: '改进领域', dataIndex: 'area', width: 200 },
                          { title: '建议', dataIndex: 'suggestion', width: 500 },
                          { title: '优先级', dataIndex: 'priority', width: 80, render: (p: string) => <Tag color={p === '高' ? 'red' : p === '中' ? 'orange' : 'blue'}>{p}</Tag> },
                        ]} />
                    </Card>
                  ),
                }] : []),
              ]}
            />
          </>
        )}
      </Drawer>

      <style>{`
        .row-deny { background: #fff1f0 !important; }
        .row-keep { background: #f6ffed !important; }
        .row-review { background: #fffbe6 !important; }
        .ant-table-row:hover > td { background: inherit !important; }
      `}</style>
    </div>
  );};

export default NegKeywordTool;
