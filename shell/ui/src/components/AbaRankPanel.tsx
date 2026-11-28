import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  Row,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import {
  CloudUploadOutlined,
  FileExcelOutlined,
  ReloadOutlined,
  RocketOutlined,
  SearchOutlined,
} from '@ant-design/icons';

const { Text, Title } = Typography;

async function apiFetch(path: string, options?: RequestInit & { timeoutMs?: number }) {
  if (typeof window !== 'undefined' && typeof (window as any).__MCP_API_FETCH__ === 'function') {
    return (window as any).__MCP_API_FETCH__(path, options);
  }
  const timeoutMs = options?.timeoutMs ?? 120000;
  const { timeoutMs: _, ...restOptions } = (options ?? {}) as any;
  const resp = await fetch(`http://127.0.0.1:19890${path}`, {
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

interface RankRow {
  row: number;
  type: string;
  b1: number;
  b2: number;
  b3: number;
  b4: number;
  b5: number;
  b6: number;
  bestKw: string;
  bestRank: number;
  heatScore: number;
  totalTerms: number;
  heatRank: number | string;
  lastHeat: number;
  lastTotalTerms: number;
  lastRank: number;
  rankChange: string;
  estTotalVol: number;
  trafficRank: number | string;
}

interface DetailRow {
  row: number;
  abaRank: number;
  keyword: string;
  model: string;
  bucket: string;
  status: string;
  hit: string;
  estVol: number;
}

interface AbaRankState {
  sourcePath: string;
  sourceExists: boolean;
  sourceMtime: string;
  targetPath: string;
  targetExists: boolean;
  targetMtime: string;
  summary: {
    totalModels: number;
    activeModels: number;
    matchedTerms: number;
    unmatchedTerms: number;
    totalTerms: number;
  };
  ranks: RankRow[];
  detailPreview: DetailRow[];
  importResult?: {
    source: string;
    matchedTerms: number;
    unmatchedTerms: number;
    activeModels: number;
    backupPath: string;
    excelRecalc: boolean;
    elapsedMs: number;
  };
}

export default function AbaRankPanel() {
  const [state, setState] = useState<AbaRankState | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [sourcePath, setSourcePath] = useState('');
  const [targetPath, setTargetPath] = useState('');
  const [searchText, setSearchText] = useState('');
  const [onlyActive, setOnlyActive] = useState(true);
  const [detailFilter, setDetailFilter] = useState('');
  const [lastImportMsg, setLastImportMsg] = useState<string>('');

  const loadState = useCallback(async (sPath?: string, tPath?: string) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (tPath) qs.set('target_path', tPath);
      if (sPath) qs.set('source_path', sPath);
      const qstr = qs.toString() ? `?${qs.toString()}` : '';
      const data: AbaRankState = await apiFetch(`/api/aba-rank/state${qstr}`);
      setState(data);
      if (!sPath) setSourcePath(data.sourcePath);
      if (!tPath) setTargetPath(data.targetPath);
    } catch (e: any) {
      message.error(`加载排名数据失败: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const handleOneClickImport = async (fileBase64?: string, fileName?: string) => {
    setImporting(true);
    try {
      const res: AbaRankState = await apiFetch('/api/aba-rank/import', {
        method: 'POST',
        timeoutMs: 180000,
        body: JSON.stringify({
          source_path: sourcePath || undefined,
          target_path: targetPath || undefined,
          file_base64: fileBase64 || undefined,
          file_name: fileName || undefined,
          run_excel_recalc: true,
        }),
      });
      setState(res);
      if (res.importResult) {
        const ir = res.importResult;
        const msg = `导入完成（${(ir.elapsedMs / 1000).toFixed(1)}s）：匹配 ${ir.matchedTerms} 词 / 覆盖 ${ir.activeModels} 个机型，旧数据已归档至「上周数据」并自动重排热度榜`;
        setLastImportMsg(msg);
        message.success(msg);
      }
    } catch (e: any) {
      message.error(`导入失败: ${e?.message || e}`);
    } finally {
      setImporting(false);
    }
  };

  const handleOpenExcel = async () => {
    try {
      await apiFetch('/api/aba-rank/open-excel', {
        method: 'POST',
        body: JSON.stringify({ target_path: targetPath || undefined }),
      });
      message.success('已在系统默认程序中打开 Excel 总表');
    } catch (e: any) {
      message.error(`打开失败: ${e?.message || e}`);
    }
  };

  const filteredRanks = useMemo(() => {
    const list = state?.ranks || [];
    const q = searchText.trim().toLowerCase();
    return list.filter((r) => {
      if (onlyActive && r.totalTerms <= 0) return false;
      if (!q) return true;
      return r.type.toLowerCase().includes(q) || r.bestKw.toLowerCase().includes(q);
    });
  }, [state, searchText, onlyActive]);

  const filteredDetails = useMemo(() => {
    const list = state?.detailPreview || [];
    const q = detailFilter.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (d) =>
        (d.keyword || '').toLowerCase().includes(q) ||
        (d.model || '').toLowerCase().includes(q) ||
        (d.status || '').toLowerCase().includes(q)
    );
  }, [state, detailFilter]);

  const topModel = state?.ranks?.[0];

  const rankColumns: any[] = [
    {
      title: '排名',
      dataIndex: 'heatRank',
      width: 66,
      fixed: 'left',
      align: 'center',
      render: (v: any) =>
        v ? (
          <Tag color={Number(v) <= 3 ? 'gold' : Number(v) <= 10 ? 'blue' : 'default'} style={{ margin: 0, fontWeight: 700 }}>
            #{v}
          </Tag>
        ) : (
          '—'
        ),
    },
    {
      title: '变化',
      dataIndex: 'rankChange',
      width: 72,
      align: 'center',
      render: (v: string) => {
        if (!v || v === '—') return <Text type="secondary">—</Text>;
        if (v === 'New') return <Tag color="purple" style={{ margin: 0 }}>New</Tag>;
        if (v.startsWith('↑')) return <Text style={{ color: '#16a34a', fontWeight: 600 }}>{v}</Text>;
        if (v.startsWith('↓')) return <Text style={{ color: '#dc2626', fontWeight: 600 }}>{v}</Text>;
        return v;
      },
    },
    {
      title: '机型 (type)',
      dataIndex: 'type',
      width: 145,
      fixed: 'left',
      render: (v: string) => <Text strong>{v}</Text>,
    },
    {
      title: '新热度指数',
      dataIndex: 'heatScore',
      width: 105,
      align: 'right',
      sorter: (a: RankRow, b: RankRow) => a.heatScore - b.heatScore,
      render: (v: number) => <Text strong style={{ color: '#2563eb' }}>{v.toFixed(1)}</Text>,
    },
    {
      title: '全词预估搜索量',
      dataIndex: 'estTotalVol',
      width: 130,
      align: 'right',
      sorter: (a: RankRow, b: RankRow) => a.estTotalVol - b.estTotalVol,
      render: (v: number) => (v ? v.toLocaleString() : '0'),
    },
    {
      title: '总词数',
      dataIndex: 'totalTerms',
      width: 78,
      align: 'right',
      sorter: (a: RankRow, b: RankRow) => a.totalTerms - b.totalTerms,
    },
    {
      title: 'Best_Kw',
      dataIndex: 'bestKw',
      width: 210,
      ellipsis: true,
    },
    {
      title: 'Best_Rank',
      dataIndex: 'bestRank',
      width: 96,
      align: 'right',
      sorter: (a: RankRow, b: RankRow) => (a.bestRank || 999999) - (b.bestRank || 999999),
      render: (v: number) => (v ? `#${v.toLocaleString()}` : '—'),
    },
    { title: '1-1万', dataIndex: 'b1', width: 68, align: 'right' },
    { title: '1-3万', dataIndex: 'b2', width: 68, align: 'right' },
    { title: '3-5万', dataIndex: 'b3', width: 68, align: 'right' },
    { title: '5-7万', dataIndex: 'b4', width: 68, align: 'right' },
    { title: '7-10万', dataIndex: 'b5', width: 72, align: 'right' },
    { title: '10-20万', dataIndex: 'b6', width: 76, align: 'right' },
    {
      title: '上周排名',
      dataIndex: 'lastRank',
      width: 82,
      align: 'right',
      render: (v: number) => (v ? `#${v}` : '—'),
    },
  ];

  const detailColumns: any[] = [
    { title: 'ABA排名', dataIndex: 'abaRank', width: 90, align: 'right', render: (v: number) => `#${v?.toLocaleString()}` },
    { title: '搜索词', dataIndex: 'keyword', width: 260, ellipsis: true },
    {
      title: '匹配型号',
      dataIndex: 'model',
      width: 145,
      render: (v: string) => (v && v !== '—' ? <Tag color="blue">{v}</Tag> : <Text type="secondary">—</Text>),
    },
    { title: '排名区间', dataIndex: 'bucket', width: 120 },
    {
      title: '匹配状态',
      dataIndex: 'status',
      width: 130,
      render: (v: string) => <Tag color={v === '唯一匹配' ? 'green' : 'default'}>{v}</Tag>,
    },
    { title: '命中型号词', dataIndex: 'hit', width: 130 },
    {
      title: '预估搜索量',
      dataIndex: 'estVol',
      width: 110,
      align: 'right',
      render: (v: number) => (v ? v.toLocaleString() : '0'),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card size="small">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <Title level={5} style={{ margin: 0 }}>
              美国站 ABA 搜索词机型热度排行
            </Title>
            <Text type="secondary" style={{ fontSize: 12 }}>
              一键导入 ABA搜索词 → 自动归档旧数据至「上周数据」→ 匹配生成机型词表并按逐词连续流量自动重排 SearchTermRank
            </Text>
          </div>
          <Space wrap>
            <Button
              type="primary"
              icon={<RocketOutlined />}
              loading={importing}
              onClick={() => void handleOneClickImport()}
            >
              一键导入 ABA搜索词并更新排名
            </Button>
            <Upload
              accept=".xlsx"
              showUploadList={false}
              beforeUpload={(file) => {
                const reader = new FileReader();
                reader.onload = () => {
                  void handleOneClickImport(String(reader.result || ''), file.name);
                };
                reader.readAsDataURL(file);
                return false;
              }}
            >
              <Button icon={<CloudUploadOutlined />} disabled={importing}>
                选择其他 ABA 文件导入
              </Button>
            </Upload>
            <Button icon={<FileExcelOutlined />} onClick={() => void handleOpenExcel()}>
              打开 Excel 总表
            </Button>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadState(sourcePath, targetPath)}>
              刷新
            </Button>
          </Space>
        </div>

        <Row gutter={10} style={{ marginTop: 10 }}>
          <Col xs={24} md={12}>
            <Input
              size="small"
              addonBefore="ABA 源文件"
              value={sourcePath}
              onChange={(e) => setSourcePath(e.target.value)}
              suffix={
                state?.sourceExists ? (
                  <Tag color="green" style={{ margin: 0 }}>就绪 {state.sourceMtime}</Tag>
                ) : (
                  <Tag color="red" style={{ margin: 0 }}>未找到</Tag>
                )
              }
            />
          </Col>
          <Col xs={24} md={12}>
            <Input
              size="small"
              addonBefore="排名总表"
              value={targetPath}
              onChange={(e) => setTargetPath(e.target.value)}
              suffix={
                state?.targetExists ? (
                  <Tag color="blue" style={{ margin: 0 }}>更新于 {state.targetMtime}</Tag>
                ) : (
                  <Tag color="red" style={{ margin: 0 }}>未找到</Tag>
                )
              }
            />
          </Col>
        </Row>

        {lastImportMsg && (
          <Alert type="success" showIcon message={lastImportMsg} style={{ marginTop: 10 }} closable onClose={() => setLastImportMsg('')} />
        )}
      </Card>

      <Row gutter={10}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="有词覆盖机型"
              value={state?.summary.activeModels ?? 0}
              suffix={`/ ${state?.summary.totalModels ?? 0}`}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="已匹配搜索词"
              value={state?.summary.matchedTerms ?? 0}
              suffix={`/ ${state?.summary.totalTerms ?? 0}`}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="榜首机型"
              value={topModel?.type || '—'}
              valueStyle={{ fontSize: 18, color: '#2563eb' }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="榜首热度指数"
              value={topModel?.heatScore ?? 0}
              precision={1}
              suffix={topModel ? `(${(topModel.estTotalVol / 10000).toFixed(1)}万)` : ''}
            />
          </Card>
        </Col>
      </Row>

      <Card size="small">
        <Tabs
          items={[
            {
              key: 'rank',
              label: `机型热度排行 (${filteredRanks.length})`,
              children: (
                <div>
                  <Space style={{ marginBottom: 10 }} wrap>
                    <Input
                      allowClear
                      prefix={<SearchOutlined />}
                      placeholder="搜索机型或 Best_Kw..."
                      value={searchText}
                      onChange={(e) => setSearchText(e.target.value)}
                      style={{ width: 240 }}
                    />
                    <Button
                      size="small"
                      type={onlyActive ? 'primary' : 'default'}
                      onClick={() => setOnlyActive((v) => !v)}
                    >
                      {onlyActive ? '仅显示有词机型' : '显示全部 131 个机型'}
                    </Button>
                  </Space>
                  <Table
                    size="small"
                    rowKey="type"
                    loading={loading || importing}
                    dataSource={filteredRanks}
                    columns={rankColumns}
                    scroll={{ x: 1350, y: 520 }}
                    pagination={{ pageSize: 50, showSizeChanger: true }}
                  />
                </div>
              ),
            },
            {
              key: 'detail',
              label: `搜索词分布预览 (前300条)`,
              children: (
                <div>
                  <Input
                    allowClear
                    prefix={<SearchOutlined />}
                    placeholder="过滤搜索词、匹配型号或状态..."
                    value={detailFilter}
                    onChange={(e) => setDetailFilter(e.target.value)}
                    style={{ width: 280, marginBottom: 10 }}
                  />
                  <Table
                    size="small"
                    rowKey="row"
                    loading={loading || importing}
                    dataSource={filteredDetails}
                    columns={detailColumns}
                    scroll={{ x: 960, y: 520 }}
                    pagination={{ pageSize: 50 }}
                  />
                </div>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
