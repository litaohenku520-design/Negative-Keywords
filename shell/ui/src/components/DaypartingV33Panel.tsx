import React, { useMemo, useState } from 'react';
import {
  Card, Row, Col, Statistic, Tag, Select, Switch, Button, Table, Space,
  Typography, Alert, Upload, message, Tooltip, Segmented,
} from 'antd';
import { CopyOutlined, UploadOutlined, CheckCircleOutlined } from '@ant-design/icons';

const { Text } = Typography;

interface V33DimensionDef {
  key: string;
  label: string;
  hoursLabel: string;
  hours: number[];
  t3Base: number;
  t6Base: number;
  color: string;
  bgColor: string;
  note: string;
}

const V33_DIMENSIONS: V33DimensionDef[] = [
  {
    key: 'day_core',
    label: '白昼连续主力',
    hoursLabel: '03:00–14:59 (12h)',
    hours: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    t3Base: 1.08,
    t6Base: 1.03,
    color: '#15803d',
    bgColor: '#dcfce7',
    note: '贡献 58% 订单 / ROAS 1.73，留空间给「提高和降低」自由竞抢',
  },
  {
    key: 'afternoon',
    label: '下午承接巅峰流',
    hoursLabel: '15:00–17:59 (3h)',
    hours: [15, 16, 17],
    t3Base: 1.02,
    t6Base: 0.98,
    color: '#0284c7',
    bgColor: '#e0f2fe',
    note: '温和回调 -5.6%，守住 17:00 全天最高曝光(53k impr/ROAS 1.74)',
  },
  {
    key: 'evening',
    label: '晚间控损承接',
    hoursLabel: '18:00–20:59 (3h)',
    hours: [18, 19, 20],
    t3Base: 0.90,
    t6Base: 0.87,
    color: '#b45309',
    bgColor: '#fef3c7',
    note: '温和回调 -11.8%，兼顾 20:00(ROAS 1.53) 与防 18–19 点虚耗',
  },
  {
    key: 'night',
    label: '跨零点夜间保护',
    hoursLabel: '21:00–02:59 (6h)',
    hours: [21, 22, 23, 0, 1, 2],
    t3Base: 0.75,
    t6Base: 0.75,
    color: '#475569',
    bgColor: '#e2e8f0',
    note: '跨 00:00 预算重置点零跳变，比例保底 ≥0.65 不失温断流',
  },
];

const V33_TIERS = [
  { idx: 1, name: '第1档｜强扩量 (ROAS ≥ 2.00)', prop: 1.055, tagColor: 'green' },
  { idx: 2, name: '第2档｜稳扩量 (1.80–2.00)', prop: 1.028, tagColor: 'cyan' },
  { idx: 3, name: '第3档｜基准组 (1.60–1.80)', prop: 1.000, tagColor: 'blue' },
  { idx: 4, name: '第4档｜轻控费 (1.40–1.60)', prop: 0.972, tagColor: 'orange' },
  { idx: 5, name: '第5档｜重控费 (ROAS < 1.40)', prop: 0.910, tagColor: 'red' },
  { idx: 6, name: '第6档｜新品观察 (<20clk 或 <3单)', prop: 1.000, tagColor: 'purple' },
];

const DISCOUNT_OPTIONS = [
  { value: 1.0, label: '100% 常规日基准' },
  { value: 0.95, label: '95折 (95%)' },
  { value: 0.9, label: '90折 (90%)' },
  { value: 0.85, label: '85折 (85%)' },
  { value: 0.8, label: '80折 (80%)' },
  { value: 0.75, label: '75折 (75%)' },
  { value: 0.7, label: '70折 (70%)' },
  { value: 0.65, label: '65折 (65%)' },
  { value: 0.6, label: '60折 (60%)' },
  { value: 0.55, label: '55折 (55%)' },
  { value: 0.5, label: '50折 (50%)' },
];

const WEEK_ROWS = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

function round2(n: number): number {
  return Math.round((n + 1e-9) * 100) / 100;
}

function getDimForHour(h: number): V33DimensionDef {
  return V33_DIMENSIONS.find((d) => d.hours.includes(h)) ?? V33_DIMENSIONS[3];
}

function parseCsvLine(line: string): string[] {
  const res: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      res.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  res.push(cur);
  return res;
}

interface HourlyPerf {
  impr: number;
  clk: number;
  spd: number;
  ord: number;
  sal: number;
}

export const DaypartingV33Panel: React.FC = () => {
  const [selectedTier, setSelectedTier] = useState<number>(3);
  const [discount, setDiscount] = useState<number>(1.0);
  const [sundayEnabled, setSundayEnabled] = useState<boolean>(true);
  const [onlyUpPrefix, setOnlyUpPrefix] = useState<boolean>(true);
  const [hourlyPerf, setHourlyPerf] = useState<Record<number, HourlyPerf> | null>(null);
  const [csvName, setCsvName] = useState<string>('');

  const tierObj = V33_TIERS.find((t) => t.idx === selectedTier) ?? V33_TIERS[2];

  const matrixRows = useMemo(() => {
    return WEEK_ROWS.map((dayName, dayIdx) => {
      const sunMult = sundayEnabled && dayIdx === 6 ? 0.95 : 1.0;
      const row: Record<string, string | number> = { key: dayIdx, dayName };
      for (let h = 0; h < 24; h++) {
        const dim = getDimForHour(h);
        const base = selectedTier === 6 ? dim.t6Base : dim.t3Base * tierObj.prop;
        row[`h${h}`] = round2(base * sunMult * discount);
      }
      return row;
    });
  }, [selectedTier, tierObj.prop, sundayEnabled, discount]);

  const handleCopySparkX = async () => {
    const tsv = matrixRows
      .map((r) => Array.from({ length: 24 }, (_, h) => Number(r[`h${h}`]).toFixed(2)).join('\t'))
      .join('\n');
    try {
      await navigator.clipboard.writeText(tsv);
      message.success(`已复制 ${tierObj.name} (${Math.round(discount * 100)}%) 7×24 矩阵，可直接粘贴至 SparkX`);
    } catch {
      message.error('剪贴板写入失败，请检查浏览器权限');
    }
  };

  const handleCsvUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = String(e.target?.result || '');
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length < 2) {
        message.warning('CSV 行数不足');
        return;
      }
      const map: Record<number, HourlyPerf> = {};
      for (let h = 0; h < 24; h++) map[h] = { impr: 0, clk: 0, spd: 0, ord: 0, sal: 0 };
      let matched = 0;
      for (let i = 1; i < lines.length; i++) {
        const r = parseCsvLine(lines[i]);
        if (r.length < 22) continue;
        const camp = r[5] || '';
        if (onlyUpPrefix && !camp.startsWith('UP-')) continue;
        const hr = parseInt((r[2] || '0').split(':')[0], 10);
        if (Number.isNaN(hr) || hr < 0 || hr > 23) continue;
        map[hr].impr += parseInt(r[13] || '0', 10) || 0;
        map[hr].clk += parseInt(r[14] || '0', 10) || 0;
        map[hr].spd += parseFloat((r[16] || '0').replace(/[$,]/g, '')) || 0;
        map[hr].ord += parseInt(r[18] || '0', 10) || 0;
        map[hr].sal += parseFloat((r[21] || '0').replace(/[$,]/g, '')) || 0;
        matched++;
      }
      setHourlyPerf(map);
      setCsvName(file.name);
      message.success(`已解析 ${file.name}（匹配 ${matched} 条小时记录）`);
    };
    reader.readAsText(file, 'utf-8');
    return false;
  };

  const dimPerfRows = useMemo(() => {
    if (!hourlyPerf) return [];
    const totalSpd = Object.values(hourlyPerf).reduce((a, b) => a + b.spd, 0);
    return V33_DIMENSIONS.map((d) => {
      const agg = d.hours.reduce(
        (acc, h) => ({
          impr: acc.impr + hourlyPerf[h].impr,
          clk: acc.clk + hourlyPerf[h].clk,
          spd: acc.spd + hourlyPerf[h].spd,
          ord: acc.ord + hourlyPerf[h].ord,
          sal: acc.sal + hourlyPerf[h].sal,
        }),
        { impr: 0, clk: 0, spd: 0, ord: 0, sal: 0 }
      );
      return {
        key: d.key,
        label: `${d.label} (${d.hoursLabel})`,
        mult: d.t3Base,
        clk: agg.clk,
        spd: agg.spd,
        spdShare: totalSpd > 0 ? (agg.spd / totalSpd) * 100 : 0,
        cpc: agg.clk > 0 ? agg.spd / agg.clk : 0,
        ord: agg.ord,
        cvr: agg.clk > 0 ? (agg.ord / agg.clk) * 100 : 0,
        sal: agg.sal,
        roas: agg.spd > 0 ? agg.sal / agg.spd : 0,
      };
    });
  }, [hourlyPerf]);

  const matrixColumns = useMemo(() => {
    const cols: Array<Record<string, unknown>> = [
      {
        title: '星期',
        dataIndex: 'dayName',
        key: 'dayName',
        fixed: 'left',
        width: 78,
        render: (v: string) => <Text strong>{v}</Text>,
      },
    ];
    for (let h = 0; h < 24; h++) {
      const dim = getDimForHour(h);
      cols.push({
        title: `${h.toString().padStart(2, '0')}`,
        dataIndex: `h${h}`,
        key: `h${h}`,
        width: 50,
        align: 'center',
        onHeaderCell: () => ({ style: { background: dim.color, color: '#fff', padding: '4px 2px', fontSize: 12 } }),
        onCell: () => ({ style: { background: dim.bgColor, padding: '4px 2px', fontSize: 12 } }),
        render: (val: number) => <span>{Number(val).toFixed(2)}</span>,
      });
    }
    return cols;
  }, []);

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="v33 亚马逊算法协同分时调价系统（跨零点 4 维度 + 比例式 6 档）"
        description="全天仅在 03:00 / 15:00 / 18:00 / 21:00 平滑切换 4 次，跨越 00:00 零点不跳变；前 5 档采用比例系数 (×1.055 / ×1.028 / ×1.00 / ×0.972 / ×0.91)，周日统一 ×0.95，周一至周六同频。"
      />

      <Row gutter={[12, 12]}>
        {V33_DIMENSIONS.map((d) => (
          <Col xs={24} sm={12} lg={6} key={d.key}>
            <Card size="small" style={{ borderTop: `3px solid ${d.color}` }}>
              <Space direction="vertical" size={2} style={{ width: '100%' }}>
                <Text strong style={{ color: d.color }}>{d.label}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>{d.hoursLabel}</Text>
                <Statistic
                  value={round2((selectedTier === 6 ? d.t6Base : d.t3Base * tierObj.prop) * discount)}
                  precision={2}
                  suffix={<Text type="secondary" style={{ fontSize: 12 }}>倍 (T{selectedTier})</Text>}
                />
                <Text type="secondary" style={{ fontSize: 11 }}>{d.note}</Text>
              </Space>
            </Card>
          </Col>
        ))}
      </Row>

      <Card
        title="7×24 分时倍率矩阵（SparkX 一键复制）"
        size="small"
        extra={
          <Button icon={<CopyOutlined />} type="primary" onClick={handleCopySparkX}>
            复制 7×24 矩阵 (TSV)
          </Button>
        }
      >
        <Space wrap style={{ marginBottom: 12 }}>
          <span>活动档位：</span>
          <Segmented
            value={selectedTier}
            onChange={(v) => setSelectedTier(Number(v))}
            options={V33_TIERS.map((t) => ({ label: `第${t.idx}档`, value: t.idx }))}
          />
          <Tag color={tierObj.tagColor}>{tierObj.name}</Tag>
          <span>折扣模板：</span>
          <Select
            value={discount}
            onChange={setDiscount}
            options={DISCOUNT_OPTIONS}
            style={{ width: 160 }}
          />
          <Tooltip title="周日全时段乘以 0.95">
            <Space>
              <span>周日 ×0.95：</span>
              <Switch checked={sundayEnabled} onChange={setSundayEnabled} size="small" />
            </Space>
          </Tooltip>
        </Space>

        <Table
          size="small"
          pagination={false}
          scroll={{ x: 1300 }}
          dataSource={matrixRows}
          columns={matrixColumns}
        />
      </Card>

      <Card
        title="分时段广告 CSV 实测归因对照"
        size="small"
        extra={
          <Space>
            <Switch
              checked={onlyUpPrefix}
              onChange={setOnlyUpPrefix}
              checkedChildren="仅 UP-"
              unCheckedChildren="全店"
            />
            <Upload accept=".csv" showUploadList={false} beforeUpload={handleCsvUpload}>
              <Button icon={<UploadOutlined />}>上传分时段广告 CSV</Button>
            </Upload>
          </Space>
        }
      >
        {!hourlyPerf ? (
          <Text type="secondary">
            上传亚马逊「商品推广_广告活动_报告」分时段 CSV，即可按 v33 四大维度自动汇总展示点击、花费、CPC、订单、CVR 与 ROAS。
          </Text>
        ) : (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Tag icon={<CheckCircleOutlined />} color="success">
              已加载：{csvName}（{onlyUpPrefix ? '仅 UP- 广告系列' : '全店广告系列'}）
            </Tag>
            <Table
              size="small"
              pagination={false}
              dataSource={dimPerfRows}
              columns={[
                { title: 'v33 维度时段', dataIndex: 'label', key: 'label' },
                { title: 'v33基准', dataIndex: 'mult', key: 'mult', render: (v: number) => v.toFixed(2) },
                { title: '点击', dataIndex: 'clk', key: 'clk' },
                { title: '花费($)', dataIndex: 'spd', key: 'spd', render: (v: number) => `$${v.toFixed(2)}` },
                { title: '花费占比', dataIndex: 'spdShare', key: 'spdShare', render: (v: number) => `${v.toFixed(1)}%` },
                { title: 'CPC', dataIndex: 'cpc', key: 'cpc', render: (v: number) => `$${v.toFixed(2)}` },
                { title: '订单', dataIndex: 'ord', key: 'ord' },
                { title: 'CVR', dataIndex: 'cvr', key: 'cvr', render: (v: number) => `${v.toFixed(2)}%` },
                { title: '销售额($)', dataIndex: 'sal', key: 'sal', render: (v: number) => `$${v.toFixed(2)}` },
                { title: 'ROAS', dataIndex: 'roas', key: 'roas', render: (v: number) => <Text strong>{v.toFixed(2)}</Text> },
              ]}
            />
          </Space>
        )}
      </Card>
    </Space>
  );
};

export default DaypartingV33Panel;
