import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App as McpApp } from '@modelcontextprotocol/ext-apps';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Collapse,
  ConfigProvider,
  Divider,
  Empty,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import {
  AppstoreOutlined,
  BarChartOutlined,
  CheckCircleOutlined,
  DeleteOutlined,
  DownloadOutlined,
  ExperimentOutlined,
  FileExcelOutlined,
  FilterOutlined,
  InboxOutlined,
  MergeCellsOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
  StopOutlined,
  TableOutlined,
  UploadOutlined,
} from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;
const { Dragger } = Upload;
const mcpApp = new McpApp({ name: 'AMZ 快捷工作台', version: '1.0.0' }, {});

function guessDay(name) {
  const m = String(name || '').match(/(\d+)\s*(?:天|d|day)/i);
  return m ? m[1] : '7';
}
function guessType(name) {
  const n = String(name || '').toLowerCase();
  if (/(品牌|brand|sb|video)/i.test(n)) return 'brand';
  if (/(精确|手动|exact|manual)/i.test(n)) return 'exact';
  return 'auto';
}
function colLetter(i) {
  let s = '';
  let n = i;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取本地文件失败'));
    reader.readAsDataURL(file);
  });
}

// ============================================================
// 模块 1：否词工具（与本地 ERP NegKeywordTool 对齐）
// ============================================================
function NegKeywordTab({ files, rulesSummary, config, callTool, busy, onFileUploaded }) {
  const [subTab, setSubTab] = useState('work');
  const [filePath, setFilePath] = useState('');
  const [minSpend, setMinSpend] = useState(config?.negKeyword?.minSpendNoOrder ?? 15);
  const [minClicks, setMinClicks] = useState(config?.negKeyword?.minClicksNoOrder ?? 12);
  const [matchType, setMatchType] = useState(config?.negKeyword?.defaultMatchType ?? 'Negative Exact');
  const [result, setResult] = useState(null);
  const [decisionFilter, setDecisionFilter] = useState('all');
  const [searchKw, setSearchKw] = useState('');
  const [ruleSearch, setRuleSearch] = useState('');
  const [rulesData, setRulesData] = useState(rulesSummary || null);

  useEffect(() => {
    if (!filePath && files.length > 0) {
      const f = files.find((x) => x.category === 'search_term') || files[0];
      if (f) setFilePath(f.path);
    }
  }, [files, filePath]);

  const sortedFiles = useMemo(
    () => [...files].sort((a, b) => (a.category === 'search_term' ? 0 : 1) - (b.category === 'search_term' ? 0 : 1)),
    [files]
  );

  const filteredRows = useMemo(() => {
    const rows = result?.previewRows || [];
    return rows.filter((r) => {
      if (decisionFilter !== 'all' && r.decision !== decisionFilter) return false;
      if (searchKw && !`${r.term} ${r.campaign} ${r.reason}`.toLowerCase().includes(searchKw.toLowerCase())) return false;
      return true;
    });
  }, [result, decisionFilter, searchKw]);

  const toggleRowDecision = (id) => {
    if (!result) return;
    setResult({
      ...result,
      previewRows: result.previewRows.map((r) =>
        r.id === id ? { ...r, decision: r.decision === '否掉' ? '保留' : '否掉', reason: `${r.reason} (人工切换)` } : r
      ),
    });
  };

  const handleUpload = async (file) => {
    const b64 = await readFileAsBase64(file);
    const res = await callTool('workbench_upload_file', { fileName: file.name, base64Content: b64 });
    if (res?.path) {
      setFilePath(res.path);
      message.success(`已上传并读取 ${file.name}`);
      onFileUploaded?.();
    }
    return false;
  };

  const handleRun = async () => {
    const res = await callTool('workbench_run_neg_keyword', {
      filePath,
      minSpendNoOrder: Number(minSpend),
      minClicksNoOrder: Number(minClicks),
      matchType,
      runPythonAudit: true,
      exportTemplate: true,
    });
    if (res) {
      setResult(res);
      message.success(`否词分析完成：建议否掉 ${res.counts?.否掉 ?? 0} 词`);
    }
  };

  const columns = [
    {
      title: '判定',
      dataIndex: 'decision',
      width: 90,
      fixed: 'left',
      render: (v, rec) => (
        <Tag
          color={v === '否掉' ? 'red' : v === '待观察' ? 'orange' : 'green'}
          style={{ cursor: 'pointer' }}
          onClick={() => toggleRowDecision(rec.id)}
        >
          {v}
        </Tag>
      ),
    },
    { title: '搜索词 / ASIN', dataIndex: 'term', width: 200, ellipsis: true },
    { title: '广告活动', dataIndex: 'campaign', width: 170, ellipsis: true },
    { title: '花费($)', dataIndex: 'spend', width: 85, sorter: (a, b) => a.spend - b.spend },
    { title: '点击', dataIndex: 'clicks', width: 70, sorter: (a, b) => a.clicks - b.clicks },
    { title: '订单', dataIndex: 'orders', width: 70, sorter: (a, b) => a.orders - b.orders },
    { title: 'ACoS%', dataIndex: 'acos', width: 80, render: (v) => `${v}%` },
    { title: '判定原因', dataIndex: 'reason', width: 220, ellipsis: true },
  ];

  return (
    <Tabs
      type="card"
      size="small"
      activeKey={subTab}
      onChange={setSubTab}
      items={[
        {
          key: 'work',
          label: '🔍 否词作业台',
          children: (
            <Space direction="vertical" style={{ width: '100%' }} size={12}>
              <Card size="small" title={<Space><FilterOutlined /><span>搜索词报告导入与规则参数（直连 rules_config.json）</span></Space>}>
                <Row gutter={[10, 10]}>
                  <Col xs={24} md={12}>
                    <Text type="secondary" style={{ fontSize: 12 }}>从后端目录选择搜索词报告</Text>
                    <Select
                      style={{ width: '100%', marginTop: 4 }}
                      value={filePath || undefined}
                      onChange={setFilePath}
                      showSearch
                      optionFilterProp="label"
                      options={sortedFiles.map((f) => ({
                        value: f.path,
                        label: `[${f.category}] ${f.name} (${f.sizeKB} KB)`,
                      }))}
                    />
                  </Col>
                  <Col xs={24} md={12}>
                    <Text type="secondary" style={{ fontSize: 12 }}>或直接上传本地 Excel / CSV</Text>
                    <Upload showUploadList={false} beforeUpload={handleUpload} accept=".xlsx,.csv,.xlsm">
                      <Button icon={<UploadOutlined />} style={{ width: '100%', marginTop: 4 }}>
                        选择本地搜索词报告上传
                      </Button>
                    </Upload>
                  </Col>
                </Row>
                <Row gutter={[10, 10]} style={{ marginTop: 10 }}>
                  <Col xs={8}>
                    <Text type="secondary" style={{ fontSize: 12 }}>0单最小花费($)</Text>
                    <InputNumber style={{ width: '100%', marginTop: 4 }} min={0} value={minSpend} onChange={setMinSpend} />
                  </Col>
                  <Col xs={8}>
                    <Text type="secondary" style={{ fontSize: 12 }}>0单最小点击</Text>
                    <InputNumber style={{ width: '100%', marginTop: 4 }} min={0} value={minClicks} onChange={setMinClicks} />
                  </Col>
                  <Col xs={8}>
                    <Text type="secondary" style={{ fontSize: 12 }}>默认否定匹配</Text>
                    <Select
                      style={{ width: '100%', marginTop: 4 }}
                      value={matchType}
                      onChange={setMatchType}
                      options={[
                        { value: 'Negative Exact', label: '精准否定 (Exact)' },
                        { value: 'Negative Phrase', label: '词组否定 (Phrase)' },
                      ]}
                    />
                  </Col>
                </Row>
                <div style={{ marginTop: 12 }}>
                  <Button type="primary" icon={<PlayCircleOutlined />} loading={busy} disabled={!filePath} onClick={handleRun}>
                    执行否词分类 + AI审计 + 导出亚马逊批量模板
                  </Button>
                </div>
              </Card>

              {result && (
                <Card
                  size="small"
                  title={`分析结果：${result.fileName}`}
                  extra={
                    <Space size={6}>
                      <Select
                        size="small"
                        style={{ width: 100 }}
                        value={decisionFilter}
                        onChange={setDecisionFilter}
                        options={[
                          { value: 'all', label: '全部判定' },
                          { value: '否掉', label: '仅否掉' },
                          { value: '待观察', label: '待观察' },
                          { value: '保留', label: '仅保留' },
                        ]}
                      />
                      <Input.Search
                        size="small"
                        style={{ width: 150 }}
                        placeholder="搜索词/活动..."
                        value={searchKw}
                        onChange={(e) => setSearchKw(e.target.value)}
                      />
                    </Space>
                  }
                >
                  <Row gutter={[10, 10]} style={{ marginBottom: 10 }}>
                    <Col span={5}><Statistic title="总搜索词" value={result.totalTerms} /></Col>
                    <Col span={5}><Statistic title="建议否掉" value={result.counts?.否掉 ?? 0} valueStyle={{ color: '#cf1322' }} /></Col>
                    <Col span={5}><Statistic title="可省花费($)" value={result.totalDenySpend} valueStyle={{ color: '#d48806' }} /></Col>
                    <Col span={5}><Statistic title="待观察" value={result.counts?.待观察 ?? 0} /></Col>
                    <Col span={4}><Statistic title="ASIN词" value={result.counts?.asins ?? 0} /></Col>
                  </Row>
                  {result.exportPath && (
                    <Alert
                      type="success"
                      showIcon
                      style={{ marginBottom: 10 }}
                      message="亚马逊双 Sheet 上传模板已导出（点击判定标签可人工微调）"
                      description={result.exportPath}
                    />
                  )}
                  <Table
                    size="small"
                    rowKey="id"
                    columns={columns}
                    dataSource={filteredRows}
                    scroll={{ x: 960, y: 360 }}
                    pagination={{ pageSize: 50, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
                    rowClassName={(r) => (r.decision === '否掉' ? 'row-deny' : r.decision === '保留' ? 'row-keep' : 'row-review')}
                  />
                </Card>
              )}
            </Space>
          ),
        },
        {
          key: 'rules',
          label: `📱 机型拓词与规则库 (${rulesData?.modelGroupCount ?? 0})`,
          children: (
            <Card
              size="small"
              title={`后端 rules_config.json（${rulesData?.modelGroupCount ?? 0} 机型组 / ${rulesData?.denyBrandCount ?? 0} 竞品品牌）`}
              extra={
                <Space>
                  <Input
                    size="small"
                    style={{ width: 160 }}
                    placeholder="搜索机型组..."
                    value={ruleSearch}
                    onChange={(e) => setRuleSearch(e.target.value)}
                    onPressEnter={async () => {
                      const r = await callTool('workbench_get_neg_rules', { query: ruleSearch, limit: 80 });
                      if (r) setRulesData(r);
                    }}
                  />
                  <Button
                    size="small"
                    type="primary"
                    onClick={async () => {
                      const r = await callTool('workbench_get_neg_rules', { query: ruleSearch, limit: 80 });
                      if (r) setRulesData(r);
                    }}
                  >
                    查询
                  </Button>
                </Space>
              }
            >
              <div style={{ marginBottom: 10 }}>
                <Text strong>🚫 竞品品牌拦截词（前 80 项）：</Text>
                <div style={{ marginTop: 6, maxHeight: 110, overflow: 'auto' }}>
                  <Space wrap size={[4, 4]}>
                    {(rulesData?.denyBrands || []).map((b) => <Tag key={b} color="red">{b}</Tag>)}
                  </Space>
                </div>
              </div>
              <Table
                size="small"
                rowKey={(r, i) => r.id || i}
                dataSource={rulesData?.groups || []}
                pagination={{ pageSize: 20 }}
                columns={[
                  { title: '机型组名称', dataIndex: 'name' },
                  { title: '站点', dataIndex: 'marketplace', width: 90 },
                  {
                    title: '状态',
                    dataIndex: 'enabled',
                    width: 80,
                    render: (v) => <Tag color={v ? 'green' : 'default'}>{v ? '启用' : '禁用'}</Tag>,
                  },
                  {
                    title: '关键词数',
                    dataIndex: 'patterns',
                    width: 90,
                    render: (p) => (Array.isArray(p) ? p.length : 0),
                  },
                ]}
              />
            </Card>
          ),
        },
        {
          key: 'audit',
          label: `🤖 Python AI 审计 ${result?.pythonAudit?.issues?.length ? `(${result.pythonAudit.issues.length})` : ''}`,
          children: (
            <Card size="small" title="neg_audit_engine.py 审计结果">
              {!result?.pythonAudit ? (
                <Empty description="请先在「否词作业台」运行一次否词分析" />
              ) : (
                <pre style={{ background: '#fafafa', padding: 10, borderRadius: 6, maxHeight: 360, overflow: 'auto', fontSize: 12 }}>
                  {JSON.stringify(result.pythonAudit, null, 2)}
                </pre>
              )}
            </Card>
          ),
        },
      ]}
    />
  );
}

// ============================================================
// 模块 2：ROAS 合并（与本地 ERP RoasMerge 对齐）
// ============================================================
function RoasMergeTab({ files, roasPresets, config, callTool, busy, onFileUploaded }) {
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [pickPath, setPickPath] = useState('');
  const [presetKey, setPresetKey] = useState(config?.roasMerge?.defaultPreset || '');
  const [keyColsStr, setKeyColsStr] = useState((config?.roasMerge?.keyCols || [4, 6, 7]).join(','));
  const [appendCols, setAppendCols] = useState([]);
  const [result, setResult] = useState(null);
  const [activeSheetKey, setActiveSheetKey] = useState('0');
  const [levelFilter, setLevelFilter] = useState('all');

  useEffect(() => {
    if (selectedFiles.length === 0 && files.length > 0) {
      const roasList = files.filter((f) => f.category === 'roas_report').slice(0, 4);
      if (roasList.length > 0) {
        setSelectedFiles(
          roasList.map((f, i) => ({
            path: f.path, name: f.name, dayLabel: guessDay(f.name), campaignType: guessType(f.name), isMain: i === 0,
          }))
        );
      }
      setPickPath(files[0].path);
    }
  }, [files, selectedFiles.length]);

  const applyPreset = (p) => {
    setPresetKey(p.key);
    setKeyColsStr((p.cols || []).join(','));
    setAppendCols(Array.isArray(p.appendCols) ? p.appendCols : []);
    message.info(`已应用预设：${p.label}`);
  };

  const handleUpload = async (file) => {
    const b64 = await readFileAsBase64(file);
    const res = await callTool('workbench_upload_file', { fileName: file.name, base64Content: b64 });
    if (res?.path) {
      setSelectedFiles((prev) => [
        ...prev,
        { path: res.path, name: file.name, dayLabel: guessDay(file.name), campaignType: guessType(file.name), isMain: prev.length === 0 },
      ]);
      onFileUploaded?.();
    }
    return false;
  };

  const handleRun = async () => {
    const keyCols = keyColsStr.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0);
    const res = await callTool('workbench_run_roas_merge', {
      reports: selectedFiles.map(({ path, dayLabel, campaignType, isMain }) => ({ path, dayLabel, campaignType, isMain })),
      keyCols,
      appendCols: appendCols.length > 0 ? appendCols : undefined,
      autoJudge: true,
      exportExcel: true,
    });
    if (res) {
      setResult(res);
      setActiveSheetKey('0');
      message.success('ROAS 多周期合并与判定完成');
    }
  };

  const LEVEL_TAG_COLOR = { 极差: 'red', 差: 'orange', 较差: 'gold', 正常: 'green', 数据不足: 'default' };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Card size="small" title={<Space><SettingOutlined /><span>匹配配置（直连 roas_merge_config.json）</span></Space>}>
        <Row gutter={[8, 8]} align="middle">
          <Col flex="none"><Text strong>预设模板:</Text></Col>
          <Col flex="auto">
            <Space wrap size={6}>
              <Button size="small" type={presetKey === '' ? 'primary' : 'default'} onClick={() => { setPresetKey(''); setAppendCols([]); }}>
                自动检测指标列
              </Button>
              {roasPresets.map((p) => (
                <Button key={p.key} size="small" type={presetKey === p.key ? 'primary' : 'default'} onClick={() => applyPreset(p)}>
                  {p.label}
                </Button>
              ))}
            </Space>
          </Col>
        </Row>
        <Row gutter={[10, 10]} style={{ marginTop: 10 }} align="middle">
          <Col xs={24} md={10}>
            <Text type="secondary" style={{ fontSize: 12 }}>匹配列索引 (0-based，如 4,6,7 对应 E/G/H)：</Text>
            <Input size="small" style={{ marginTop: 4 }} value={keyColsStr} onChange={(e) => setKeyColsStr(e.target.value)} />
          </Col>
          <Col xs={24} md={14}>
            {appendCols.length > 0 && (
              <Space wrap size={[4, 4]} style={{ marginTop: 18 }}>
                {appendCols.map((ac, i) => (
                  <Tag key={i} color="blue">列 {colLetter(ac.colIdx)}({ac.colIdx}): {ac.label || '默认'}</Tag>
                ))}
              </Space>
            )}
          </Col>
        </Row>
      </Card>

      <Card
        size="small"
        title={<Space><MergeCellsOutlined /><span>报告上传与推广类型分组</span></Space>}
        extra={
          <Space size={6}>
            <Select
              size="small"
              style={{ width: 200 }}
              value={pickPath || undefined}
              onChange={setPickPath}
              options={files.map((f) => ({ value: f.path, label: `[${f.category}] ${f.name}` }))}
            />
            <Button
              size="small"
              icon={<PlusOutlined />}
              onClick={() => {
                const f = files.find((x) => x.path === pickPath);
                if (f) {
                  setSelectedFiles((p) => [
                    ...p,
                    { path: f.path, name: f.name, dayLabel: guessDay(f.name), campaignType: guessType(f.name), isMain: p.length === 0 },
                  ]);
                }
              }}
            >
              添加
            </Button>
          </Space>
        }
      >
        <Dragger multiple showUploadList={false} beforeUpload={handleUpload} accept=".xlsx,.csv,.xlsm" style={{ marginBottom: 10 }}>
          <p className="ant-upload-drag-icon"><InboxOutlined /></p>
          <p className="ant-upload-text">点击或拖拽多周期 ROAS 广告报告到此处上传（7天 / 15天 / 30天 / 65天）</p>
        </Dragger>

        <Table
          size="small"
          rowKey={(_, i) => String(i)}
          pagination={false}
          dataSource={selectedFiles}
          locale={{ emptyText: '请从右上角添加后端报告或拖拽上传' }}
          columns={[
            { title: '文件名', dataIndex: 'name', ellipsis: true },
            {
              title: '天数',
              dataIndex: 'dayLabel',
              width: 80,
              render: (v, _, idx) => (
                <Input size="small" value={v} onChange={(e) => setSelectedFiles((p) => p.map((x, i) => i === idx ? { ...x, dayLabel: e.target.value } : x))} />
              ),
            },
            {
              title: '推广类型',
              dataIndex: 'campaignType',
              width: 110,
              render: (v, _, idx) => (
                <Select
                  size="small"
                  style={{ width: '100%' }}
                  value={v}
                  onChange={(val) => setSelectedFiles((p) => p.map((x, i) => i === idx ? { ...x, campaignType: val } : x))}
                  options={[
                    { value: 'auto', label: '自动推广' },
                    { value: 'exact', label: '精确推广' },
                    { value: 'brand', label: '品牌推广' },
                  ]}
                />
              ),
            },
            {
              title: '主表',
              dataIndex: 'isMain',
              width: 70,
              render: (v, _, idx) => (
                <Switch size="small" checked={v} onChange={() => setSelectedFiles((p) => p.map((x, i) => ({ ...x, isMain: i === idx })))} />
              ),
            },
            {
              title: '操作',
              width: 60,
              render: (_, __, idx) => (
                <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => setSelectedFiles((p) => p.filter((_, i) => i !== idx))} />
              ),
            },
          ]}
        />

        <div style={{ marginTop: 12 }}>
          <Button type="primary" icon={<PlayCircleOutlined />} loading={busy} disabled={selectedFiles.length === 0} onClick={handleRun}>
            开始合并与规则判定（自动导出着色 Excel）
          </Button>
        </div>
      </Card>

      {result && (
        <Card
          size="small"
          title="合并与判定结果"
          extra={
            <Select
              size="small"
              style={{ width: 130 }}
              value={levelFilter}
              onChange={setLevelFilter}
              options={[
                { value: 'all', label: '全部判定等级' },
                { value: '极差', label: '极差·立即否定' },
                { value: '差', label: '差·降竞价' },
                { value: '较差', label: '较差·待观察' },
                { value: '正常', label: '正常' },
              ]}
            />
          }
        >
          <Row gutter={[10, 10]} style={{ marginBottom: 10 }}>
            <Col span={6}><Statistic title="极差·立即否定" value={result.summaryCounts?.极差 ?? 0} valueStyle={{ color: '#cf1322' }} /></Col>
            <Col span={6}><Statistic title="差·降竞价" value={result.summaryCounts?.差 ?? 0} valueStyle={{ color: '#d46b08' }} /></Col>
            <Col span={6}><Statistic title="较差·待观察" value={result.summaryCounts?.较差 ?? 0} valueStyle={{ color: '#d4b106' }} /></Col>
            <Col span={6}><Statistic title="正常" value={result.summaryCounts?.正常 ?? 0} valueStyle={{ color: '#389e0d' }} /></Col>
          </Row>
          {result.exportPath && (
            <Alert type="success" showIcon style={{ marginBottom: 10 }} message="带着色判定列的 Excel 已导出" description={result.exportPath} />
          )}
          <Tabs
            type="card"
            size="small"
            activeKey={activeSheetKey}
            onChange={setActiveSheetKey}
            items={(result.sheets || []).map((sh, idx) => {
              const tailHeaders = (sh.headers || []).slice(-7);
              const lvlColIdx = (sh.headers || []).length - 3;
              const rows = (sh.previewRows || [])
                .filter((r) => levelFilter === 'all' || r[lvlColIdx] === levelFilter)
                .slice(0, 80)
                .map((r, ri) => {
                  const obj = { key: ri };
                  tailHeaders.forEach((h, hi) => { obj[`c${hi}`] = r[sh.headers.length - tailHeaders.length + hi]; });
                  return obj;
                });
              const cols = tailHeaders.map((h, hi) => ({
                title: h,
                dataIndex: `c${hi}`,
                width: h === '命中规则' ? 240 : 110,
                ellipsis: true,
                render: (val) => (h === '判定等级' ? <Tag color={LEVEL_TAG_COLOR[val] || 'default'}>{val}</Tag> : val),
              }));
              return {
                key: String(idx),
                label: `${sh.label} (${sh.totalRows}行)`,
                children: <Table size="small" columns={cols} dataSource={rows} scroll={{ x: 800, y: 320 }} pagination={{ pageSize: 30 }} />,
              };
            })}
          />
          {result.logs?.length > 0 && (
            <Collapse
              size="small"
              style={{ marginTop: 10 }}
              items={[{
                key: 'logs',
                label: `合并执行日志 (${result.logs.length} 条)`,
                children: <pre style={{ fontSize: 11, maxHeight: 150, overflow: 'auto', margin: 0 }}>{result.logs.join('\n')}</pre>,
              }]}
            />
          )}
        </Card>
      )}
    </Space>
  );
}

// ============================================================
// 模块 3：库存销售分析（与本地 ERP InventorySalesAnalysis 对齐）
// ============================================================
function InventorySalesTab({ files, config, callTool, busy, onFileUploaded }) {
  const [saihuPath, setSaihuPath] = useState('');
  const [fbaPath, setFbaPath] = useState('');
  const [adPath, setAdPath] = useState('');
  const [warnDays, setWarnDays] = useState(config?.inventorySales?.stockoutWarnDays ?? 21);
  const [overDays, setOverDays] = useState(config?.inventorySales?.overstockWarnDays ?? 120);
  const [headerPreview, setHeaderPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [riskFilter, setRiskFilter] = useState('all');
  const [searchSku, setSearchSku] = useState('');

  useEffect(() => {
    if (!saihuPath && files.length > 0) {
      const f = files.find((x) => x.category === 'inventory_sales') || files[0];
      if (f) setSaihuPath(f.path);
    }
  }, [files, saihuPath]);

  const handleUploadSlot = (setter) => async (file) => {
    const b64 = await readFileAsBase64(file);
    const res = await callTool('workbench_upload_file', { fileName: file.name, base64Content: b64 });
    if (res?.path) {
      setter(res.path);
      setHeaderPreview(res);
      message.success(`已上传 ${file.name}`);
      onFileUploaded?.();
    }
    return false;
  };

  const handleRun = async () => {
    const res = await callTool('workbench_run_inventory_sales', {
      filePath: saihuPath || undefined,
      fbaFilePath: fbaPath || undefined,
      adFilePath: adPath || undefined,
      stockoutWarnDays: Number(warnDays),
      overstockWarnDays: Number(overDays),
      exportExcel: true,
    });
    if (res) {
      setResult(res);
      message.success(`库存销售分析完成：共 ${res.totalSkus} 个 SKU`);
    }
  };

  const filteredItems = useMemo(() => {
    return (result?.previewRows || []).filter((it) => {
      if (riskFilter !== 'all' && it.risk !== riskFilter) return false;
      if (searchSku && !`${it.sku} ${it.asin} ${it.productName}`.toLowerCase().includes(searchSku.toLowerCase())) return false;
      return true;
    });
  }, [result, riskFilter, searchSku]);

  const RISK_TAG = { 断货高危: 'red', 补货预警: 'orange', 健康: 'green', 库龄积压: 'gold', 无动销积压: 'default' };

  const columns = [
    { title: 'SKU / MSKU', dataIndex: 'sku', width: 135, fixed: 'left', ellipsis: true },
    { title: 'ASIN', dataIndex: 'asin', width: 110 },
    { title: 'ABC', dataIndex: 'abc', width: 60, render: (v) => <Tag color={v === 'A' ? 'blue' : v === 'B' ? 'cyan' : 'default'}>{v}</Tag> },
    { title: 'FBA可售', dataIndex: 'available', width: 80, sorter: (a, b) => a.available - b.available },
    { title: '在途', dataIndex: 'inTransit', width: 70, sorter: (a, b) => a.inTransit - b.inTransit },
    { title: '日均销量', dataIndex: 'avgDaily', width: 85, sorter: (a, b) => a.avgDaily - b.avgDaily },
    { title: '可售天数', dataIndex: 'daysOfSupply', width: 90, sorter: (a, b) => a.daysOfSupply - b.daysOfSupply },
    { title: '广告花费($)', dataIndex: 'adSpend', width: 95 },
    { title: 'ACoS%', dataIndex: 'adAcos', width: 80, render: (v) => `${v}%` },
    {
      title: '预警状态',
      dataIndex: 'risk',
      width: 100,
      fixed: 'right',
      render: (v) => <Tag color={RISK_TAG[v] || 'default'}>{v}</Tag>,
    },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Card
        size="small"
        title={<Space><TableOutlined /><span>三报告合一数据源（赛狐库存表 + Amazon FBA库存表 + 广告商品报告）</span></Space>}
        extra={
          saihuPath && (
            <Button
              size="small"
              onClick={async () => {
                const res = await callTool('workbench_preview_headers', { filePath: saihuPath });
                if (res) setHeaderPreview(res);
              }}
            >
              预览表头列映射
            </Button>
          )
        }
      >
        <Row gutter={[10, 10]}>
          <Col xs={24} md={8}>
            <Text type="secondary" style={{ fontSize: 12 }}>1. 主表：赛狐/库存销量表</Text>
            <Select
              style={{ width: '100%', marginTop: 4 }}
              allowClear
              value={saihuPath || undefined}
              onChange={(v) => setSaihuPath(v || '')}
              options={files.map((f) => ({ value: f.path, label: `[${f.category}] ${f.name}` }))}
            />
            <Upload showUploadList={false} beforeUpload={handleUploadSlot(setSaihuPath)} accept=".xlsx,.csv,.xlsm">
              <Button size="small" icon={<UploadOutlined />} style={{ width: '100%', marginTop: 6 }}>上传赛狐/销量表</Button>
            </Upload>
          </Col>
          <Col xs={24} md={8}>
            <Text type="secondary" style={{ fontSize: 12 }}>2. 可选：Amazon FBA 库存表</Text>
            <Select
              style={{ width: '100%', marginTop: 4 }}
              allowClear
              placeholder="不合并 FBA 表"
              value={fbaPath || undefined}
              onChange={(v) => setFbaPath(v || '')}
              options={files.map((f) => ({ value: f.path, label: `[${f.category}] ${f.name}` }))}
            />
            <Upload showUploadList={false} beforeUpload={handleUploadSlot(setFbaPath)} accept=".xlsx,.csv,.xlsm">
              <Button size="small" icon={<UploadOutlined />} style={{ width: '100%', marginTop: 6 }}>上传 FBA 库存表</Button>
            </Upload>
          </Col>
          <Col xs={24} md={8}>
            <Text type="secondary" style={{ fontSize: 12 }}>3. 可选：广告推广商品报告</Text>
            <Select
              style={{ width: '100%', marginTop: 4 }}
              allowClear
              placeholder="不合并广告表"
              value={adPath || undefined}
              onChange={(v) => setAdPath(v || '')}
              options={files.map((f) => ({ value: f.path, label: `[${f.category}] ${f.name}` }))}
            />
            <Upload showUploadList={false} beforeUpload={handleUploadSlot(setAdPath)} accept=".xlsx,.csv,.xlsm">
              <Button size="small" icon={<UploadOutlined />} style={{ width: '100%', marginTop: 6 }}>上传广告商品报告</Button>
            </Upload>
          </Col>
        </Row>

        <Row gutter={[10, 10]} style={{ marginTop: 10 }} align="bottom">
          <Col xs={12} md={6}>
            <Text type="secondary" style={{ fontSize: 12 }}>断货高危阈值(天 &lt;)</Text>
            <InputNumber style={{ width: '100%', marginTop: 4 }} value={warnDays} onChange={setWarnDays} />
          </Col>
          <Col xs={12} md={6}>
            <Text type="secondary" style={{ fontSize: 12 }}>库龄积压阈值(天 &gt;)</Text>
            <InputNumber style={{ width: '100%', marginTop: 4 }} value={overDays} onChange={setOverDays} />
          </Col>
          <Col xs={24} md={12}>
            <Button type="primary" icon={<BarChartOutlined />} loading={busy} disabled={!saihuPath && !fbaPath && !adPath} onClick={handleRun}>
              开始三报告关联分析并导出 Excel
            </Button>
          </Col>
        </Row>
      </Card>

      {headerPreview && (
        <Card
          size="small"
          title={`列匹配预览：${headerPreview.fileName}（Sheet: ${headerPreview.sheetName}，${headerPreview.rowCount} 行）`}
          extra={<Button size="small" onClick={() => setHeaderPreview(null)}>收起</Button>}
        >
          <Space wrap size={[4, 4]}>
            {(headerPreview.headers || []).map((h) => (
              <Tag key={h.index}>{colLetter(h.index)}({h.index}): {h.name}</Tag>
            ))}
          </Space>
        </Card>
      )}

      {result && (
        <Card
          size="small"
          title={`库存预警明细：${result.fileName}`}
          extra={
            <Space size={6}>
              <Select
                size="small"
                style={{ width: 115 }}
                value={riskFilter}
                onChange={setRiskFilter}
                options={[
                  { value: 'all', label: '全部状态' },
                  { value: '断货高危', label: '断货高危' },
                  { value: '补货预警', label: '补货预警' },
                  { value: '健康', label: '健康' },
                  { value: '库龄积压', label: '库龄积压' },
                  { value: '无动销积压', label: '无动销积压' },
                ]}
              />
              <Input.Search size="small" style={{ width: 150 }} placeholder="搜索 SKU/ASIN..." value={searchSku} onChange={(e) => setSearchSku(e.target.value)} />
            </Space>
          }
        >
          <Row gutter={[10, 10]} style={{ marginBottom: 10 }}>
            <Col span={5}><Statistic title="SKU 总数" value={result.totalSkus} /></Col>
            <Col span={5}><Statistic title="FBA 可售" value={result.totalAvail} /></Col>
            <Col span={4}><Statistic title="在途" value={result.totalTransit} /></Col>
            <Col span={5}><Statistic title="断货高危" value={result.riskCounts?.断货高危 ?? 0} valueStyle={{ color: '#cf1322' }} /></Col>
            <Col span={5}><Statistic title="补货预警" value={result.riskCounts?.补货预警 ?? 0} valueStyle={{ color: '#d48806' }} /></Col>
          </Row>
          {result.exportPath && (
            <Alert type="success" showIcon style={{ marginBottom: 10 }} message="库存销售分析 Excel 已导出" description={result.exportPath} />
          )}
          <Table
            size="small"
            bordered
            rowKey="sku"
            columns={columns}
            dataSource={filteredItems}
            scroll={{ x: 980, y: 360 }}
            pagination={{ pageSize: 50, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
            rowClassName={(rec) => (rec.risk === '断货高危' ? 'row-danger' : rec.risk === '补货预警' ? 'row-warning' : '')}
          />
        </Card>
      )}
    </Space>
  );
}

// ============================================================
// 模块 4：本地配置与数据目录管理
// ============================================================
function ConfigTab({ config, callTool, busy, onSaved }) {
  const [scanDirsText, setScanDirsText] = useState((config?.scanDirs || []).join('\n'));
  const [exportDir, setExportDir] = useState(config?.exportDir || '');

  const handleSave = async () => {
    const scanDirs = scanDirsText.split('\n').map((s) => s.trim()).filter(Boolean);
    const res = await callTool('workbench_save_config', { scanDirs, exportDir });
    if (res) {
      message.success('配置已保存并重新扫描目录');
      onSaved?.();
    }
  };

  return (
    <Card size="small" title={<Space><SettingOutlined /><span>工作台统一数据与本地配置</span></Space>}>
      <Space direction="vertical" style={{ width: '100%' }} size={10}>
        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>报表扫描目录（每行一个绝对路径）</Text>
          <Input.TextArea rows={4} style={{ marginTop: 4 }} value={scanDirsText} onChange={(e) => setScanDirsText(e.target.value)} />
        </div>
        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>Excel 统一导出目录</Text>
          <Input style={{ marginTop: 4 }} value={exportDir} onChange={(e) => setExportDir(e.target.value)} />
        </div>
        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>后端否词规则库 JSON（直连 AMZ 探险者1）</Text>
          <Input style={{ marginTop: 4 }} value={config?.rulesConfigPath || ''} readOnly />
        </div>
        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>Discover amzn 后端 ROAS 店铺配置目录（自动加入 GitHub 同步）</Text>
          <Input style={{ marginTop: 4 }} value={config?.roasConfigPath || ''} readOnly />
        </div>
        <Button type="primary" loading={busy} onClick={handleSave}>保存配置并刷新扫描</Button>
      </Space>
    </Card>
  );
}

// ============================================================
// 主容器：AMZ 探险者风格 Ant Design ConfigProvider
// ============================================================
function WorkbenchApp() {
  const [activeTab, setActiveTab] = useState('neg');
  const [payload, setPayload] = useState({ config: null, files: [], rulesSummary: null, roasPresets: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const callTool = async (name, args) => {
    setBusy(true);
    setError(null);
    try {
      const res = await mcpApp.callServerTool({ name, arguments: args });
      if (res?.isError) throw new Error(res?.structuredContent?.error || res?.content?.[0]?.text || '调用失败');
      return res?.structuredContent || {};
    } catch (err) {
      const msg = err.message || String(err);
      setError(msg);
      message.error(msg);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const refreshState = async () => {
    const res = await callTool('workbench_get_state', {});
    if (res) setPayload((p) => ({ ...p, ...res }));
  };

  useEffect(() => {
    mcpApp.ontoolresult = (params) => {
      if (params?.structuredContent) {
        const sc = params.structuredContent;
        if (sc.initialTab) setActiveTab(sc.initialTab);
        setPayload((p) => ({ ...p, ...sc }));
      }
    };
    (async () => {
      await mcpApp.connect();
      await refreshState();
    })();
  }, []);

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: '#3370ff',
          borderRadius: 8,
          colorBgLayout: '#f7f8fa',
        },
      }}
    >
      <div className="erp-shell">
        <div className="erp-page-header">
          <div className="erp-page-header__main">
            <div className="erp-page-header__icon"><AppstoreOutlined /></div>
            <div>
              <Title level={5} style={{ margin: 0 }}>AMZ 探险者 · 快捷工作台</Title>
              <Text type="secondary" style={{ fontSize: 12 }}>
                已扫描 {payload.files?.length || 0} 份本地报表 · 直连原 ERP 规则库与本地文件
              </Text>
            </div>
          </div>
          <Button size="small" icon={<ReloadOutlined />} loading={busy} onClick={refreshState}>
            刷新目录
          </Button>
        </div>

        {error && <Alert type="error" showIcon closable style={{ marginBottom: 10 }} message={error} onClose={() => setError(null)} />}

        <Spin spinning={busy} tip="正在调用后端引擎处理...">
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            items={[
              {
                key: 'neg',
                label: <Space><StopOutlined /><span>否词工具</span></Space>,
                children: (
                  <NegKeywordTab
                    files={payload.files || []}
                    rulesSummary={payload.rulesSummary}
                    config={payload.config}
                    callTool={callTool}
                    busy={busy}
                    onFileUploaded={refreshState}
                  />
                ),
              },
              {
                key: 'roas',
                label: <Space><MergeCellsOutlined /><span>ROAS 合并</span></Space>,
                children: (
                  <RoasMergeTab
                    files={payload.files || []}
                    roasPresets={payload.roasPresets || []}
                    config={payload.config}
                    callTool={callTool}
                    busy={busy}
                    onFileUploaded={refreshState}
                  />
                ),
              },
              {
                key: 'inventory',
                label: <Space><BarChartOutlined /><span>库存销售分析</span></Space>,
                children: (
                  <InventorySalesTab
                    files={payload.files || []}
                    config={payload.config}
                    callTool={callTool}
                    busy={busy}
                    onFileUploaded={refreshState}
                  />
                ),
              },
              {
                key: 'config',
                label: <Space><SettingOutlined /><span>本地配置</span></Space>,
                children: <ConfigTab config={payload.config} callTool={callTool} busy={busy} onSaved={refreshState} />,
              },
            ]}
          />
        </Spin>
      </div>
    </ConfigProvider>
  );
}

createRoot(document.getElementById('root')).render(<WorkbenchApp />);
