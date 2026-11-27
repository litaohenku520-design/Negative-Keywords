// 纯函数判定引擎：把按「推广类型」分组的已合并报表，按业务规则打「判定等级」标签。
// 与 mergeCore 一样，不依赖 React / FileReader / xlsx，可在 Node 下单测（回归防护）。
//
// 设计要点：
//  - 各组报表先用 mergeReports 做「宽表合并」（自动把 花费/订单/ROAS/CTR 从各非主报告按天数追加），
//    保证判定规则所需的 7/15/30/65 天指标齐全。
//  - 在合并后的表头上解析「天数×指标」列位置，逐行套规则，末尾追加 判定等级 / 命中规则 / 建议操作 三列。
//  - 规则严格按用户给定的阈值；某指标缺失（列不存在/空值）则该规则视为不命中，保证不会误判。

import { mergeReports, type AppendColConfig, type MatchMode } from './mergeCore';

export type CampaignType = 'auto' | 'exact' | 'brand';

export const CAMPAIGN_LABELS: Record<CampaignType, string> = {
  auto: '自动推广',
  exact: '精确推广',
  brand: '品牌推广',
};

export const CAMPAIGN_TYPE_OPTIONS = (Object.keys(CAMPAIGN_LABELS) as CampaignType[]).map((k) => ({
  value: k,
  label: CAMPAIGN_LABELS[k],
}));

// —— 文件名 → 推广类型 自动识别（上传时兜底，用户可在列表里手动改）——
export function detectCampaignTypeFromName(name: string): CampaignType {
  const n = name.toLowerCase();
  if (/(自动|auto|automatic|广泛|broad)/.test(n)) return 'auto';
  if (/(品牌|brand|sb|video|视频|sponsored\s*brand)/.test(n)) return 'brand';
  if (/(精确|手动|exact|manual|phrase|词组|精准)/.test(n)) return 'exact';
  return 'auto'; // 兜底默认自动推广
}

// 中文数字（零~万）→ 阿拉伯数字，用于「报告天数」支持中文输入（七天 / 三十 / 六十五 等）
function cnToNumber(cn: string): number | null {
  const map: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
    十: 10, 百: 100, 千: 1000, 万: 10000,
  };
  let total = 0, section = 0, num = 0;
  for (const ch of cn) {
    if (map[ch] === undefined) return null; // 含非中文数字字符
    const v = map[ch];
    if (v < 10) {
      num = v;
    } else if (v === 10 || v === 100 || v === 1000) {
      section += (num === 0 ? 1 : num) * v;
      num = 0;
    } else if (v === 10000) {
      section = (section + num) * v;
      total += section;
      section = 0; num = 0;
    }
  }
  total += section + num;
  return total;
}

// 把任意天数文本（纯数字 / 中文数字 / "7天" / "7d" / 日期区间）解析为纯数字字符串，失败兜底 "7"。
// 同时用于：文件名自动识别 + 报告列表「天数」编辑框（支持中文输入，如 七天 / 三十天 / 六十五）。
export function parseDayLabel(raw: string): string {
  if (!raw) return '7';
  let s = String(raw).trim().toLowerCase();
  s = s.replace(/(?:天|d|day|days)\s*$/i, '').trim(); // 去「天 / d / day」等后缀
  if (s === '') return '7';
  if (/^\d+$/.test(s)) return s; // 纯阿拉伯数字
  const dr = s.match(/(\d{4}-\d{2}-\d{2})\s*(?:to|~|至|到|-)\s*(\d{4}-\d{2}-\d{2})/);
  if (dr) {
    const a = new Date(dr[1]);
    const b = new Date(dr[2]);
    const days = Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
    if (days > 0) return String(days);
  }
  const cnRaw = cnToNumber(s); // 整串即中文数字
  if (cnRaw != null && cnRaw > 0) return String(cnRaw);
  const cnMatch = s.match(/[零〇一二两三四五六七八九十百千万]+/); // 从混合串中提取中文数字（容忍其他字符）
  if (cnMatch) {
    const cn = cnToNumber(cnMatch[0]);
    if (cn != null && cn > 0) return String(cn);
  }
  return '7';
}

// —— 列头 → 指标列识别 ——（严格区分 花费/点击数/点击率，避免 Clicks、CPC 误匹配）
function spendP(s: string): boolean {
  const l = s.toLowerCase();
  if (l.includes('click') || l.includes('cpc')) return false; // 排除 Clicks / CPC
  return /花费|总花费|spend|cost/i.test(s);
}
function ordersP(s: string): boolean {
  return /订单|order/i.test(s);
}
function roasP(s: string): boolean {
  return /roas/i.test(s);
}
function ctrP(s: string): boolean {
  // Click-Thru Rate (CTR) / 点击率；排除普通 Clicks（点击数）
  return /点击率|click.?thru|click.?through|\bctr\b/i.test(s);
}

export type MetricKey =
  | 'spend7' | 'orders7' | 'roas7' | 'ctr7'
  | 'spend15' | 'orders15' | 'roas15'
  | 'spend30' | 'orders30' | 'roas30' | 'ctr30'
  | 'roas65';

export type MetricResolver = Partial<Record<MetricKey, number>>;

// 在「已合并」表头上解析各 天数×指标 列位置
export function resolveMetricColumns(header: any[], baseDayLabel: string): MetricResolver {
  const map: MetricResolver = {};
  header.forEach((h, ci) => {
    const s = String(h ?? '');
    const dm = s.match(/^\((\d+)天\)(.+)$/); // 追加列格式："(N天)花费"
    if (dm) {
      const day = dm[1];
      const inner = dm[2];
      if (spendP(inner)) map[`spend${day}` as MetricKey] = ci;
      else if (ordersP(inner)) map[`orders${day}` as MetricKey] = ci;
      else if (roasP(inner)) map[`roas${day}` as MetricKey] = ci;
      else if (ctrP(inner)) map[`ctr${day}` as MetricKey] = ci;
    } else {
      // 主报告原生列（天数 = 主报告 dayLabel）。主报告 ROAS 已被 mergeReports 改名为 "(baseDay天)ROAS" → 走上面分支
      if (spendP(s)) map[`spend${baseDayLabel}` as MetricKey] = ci;
      else if (ordersP(s)) map[`orders${baseDayLabel}` as MetricKey] = ci;
      else if (ctrP(s)) map[`ctr${baseDayLabel}` as MetricKey] = ci;
    }
  });
  return map;
}

// 在「单个报表」自身表头上识别 花费/订单/ROAS/CTR 列（用于自动构建追加列）
export function detectReportMetricCols(header: any[]): { spend?: number; orders?: number; roas?: number; ctr?: number } {
  const res: { spend?: number; orders?: number; roas?: number; ctr?: number } = {};
  header.forEach((h, ci) => {
    const s = String(h ?? '');
    if (spendP(s) && res.spend === undefined) res.spend = ci;
    else if (ordersP(s) && res.orders === undefined) res.orders = ci;
    else if (roasP(s) && res.roas === undefined) res.roas = ci;
    else if (ctrP(s) && res.ctr === undefined) res.ctr = ci;
  });
  return res;
}

// 为某个非主报告构建自动追加列配置（花费/订单/ROAS/CTR）
export function buildAutoAppendCols(header: any[]): AppendColConfig[] {
  const m = detectReportMetricCols(header);
  const out: AppendColConfig[] = [];
  if (m.spend !== undefined) out.push({ colIdx: m.spend, label: '花费' });
  if (m.orders !== undefined) out.push({ colIdx: m.orders, label: '订单' });
  if (m.roas !== undefined) out.push({ colIdx: m.roas, label: 'ROAS' });
  if (m.ctr !== undefined) out.push({ colIdx: m.ctr, label: 'CTR' });
  return out;
}

export function getNum(row: any[], idx?: number): number | null {
  if (idx == null || idx < 0) return null;
  const v = row[idx];
  if (v == null) return null;
  const s = String(v).trim().replace('%', '');
  if (s === '') return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
}

// —— 判定等级短码 & 展示 ——
export type JudgeLevel = '极差' | '差' | '较差' | '正常' | '数据不足';
export const LEVEL_DISPLAY: Record<JudgeLevel, string> = {
  极差: '极差·立即否定',
  差: '差·降竞价',
  较差: '较差·待观察',
  正常: '正常',
  数据不足: '数据不足',
};
export const LEVEL_ACTION: Record<JudgeLevel, string> = {
  极差: '立即否定/暂停',
  差: '降低竞价',
  较差: '观察',
  正常: '—',
  数据不足: '检查列头',
};
// 颜色（Excel 填充 & 预览 Tag 共用）
export const LEVEL_COLOR: Record<JudgeLevel, string> = {
  极差: '#FF4D4F', // 红
  差: '#FA8C16', // 橙
  较差: '#FADB14', // 黄
  正常: '#52C41A', // 绿
  数据不足: '#BFBFBF', // 灰
};

// —— 规则辅助（null 视为缺失，比较必定失败；有值才参与）——
const nn = (v?: number | null): number => (v == null ? -Infinity : v);
const lt = (v: number | null, t: number): boolean => v != null && v < t;
const gt = (v: number | null, t: number): boolean => v != null && v > t;
const range = (v: number | null, lo: number, hi: number): boolean => v != null && v >= lo && v < hi;

interface Ctx {
  spend7: number | null; orders7: number | null; roas7: number | null; ctr7: number | null;
  spend15: number | null; orders15: number | null; roas15: number | null;
  spend30: number | null; orders30: number | null; roas30: number | null; ctr30: number | null;
  roas65: number | null;
}
export interface Rule { level: JudgeLevel; desc: string; test: (c: Ctx, env: { row: any[]; header: any[] }) => boolean; }

// ========== 可配置判定模板（用户可在「匹配设置」内预设 / 保存 / 勾选生效）==========
export type JudgeMetric =
  | 'spend7' | 'orders7' | 'roas7' | 'ctr7'
  | 'spend15' | 'orders15' | 'roas15'
  | 'spend30' | 'orders30' | 'roas30' | 'ctr30'
  | 'roas65';

// 比较运算符：对齐「大于 / 等于 / 小于 / 大于或等于 / 小于或等于」(+ 不等于 作为有用补充)
export type JudgeOp = '>=' | '>' | '<=' | '<' | '=' | '==' | '!=';

// 条件目标：固定指标（天数×指标） 或 任意追加列
export type JudgeTarget = 'metric' | 'appendCol';

export interface JudgeCondition {
  id: string;
  target: JudgeTarget;     // 'metric' = 固定指标(天数×指标)；'appendCol' = 任意追加列
  metric?: JudgeMetric;    // target==='metric' 时生效
  appendColKey?: string;   // target==='appendCol' 时：追加列标签（如 "ROAS"/"花费"），
                           // 匹配合并表头中去掉"(N天)"前缀后的文本（如 "(7天)ROAS" → "ROAS"）
  op: JudgeOp;
  value: number; // ctr 以百分比数值存储（如 2 表示 2%）
}

export interface JudgeRuleDef {
  id: string;
  level: JudgeLevel;     // 判定等级
  desc: string;          // 命中规则（展示文本）
  action: string;        // 建议操作
  conditions: JudgeCondition[]; // 全部满足(AND) 才命中
  enabled: boolean;
}

export interface JudgeTemplate {
  id: string;
  name: string;
  campaignType: CampaignType | 'all';
  rules: JudgeRuleDef[];
  createdAt: number;
}

export const METRIC_LABELS: Record<JudgeMetric, string> = {
  spend7: '7天花费', orders7: '7天订单', roas7: '7天ROAS', ctr7: '7天CTR(%)',
  spend15: '15天花费', orders15: '15天订单', roas15: '15天ROAS',
  spend30: '30天花费', orders30: '30天订单', roas30: '30天ROAS', ctr30: '30天CTR(%)',
  roas65: '65天ROAS',
};

export const JUDGE_OP_OPTIONS: { value: JudgeOp; label: string }[] = [
  { value: '>', label: '大于 >' },
  { value: '>=', label: '大于或等于 ≥' },
  { value: '<', label: '小于 <' },
  { value: '<=', label: '小于或等于 ≤' },
  { value: '=', label: '等于 =' },
  { value: '!=', label: '不等于 ≠' },
];

export const JUDGE_LEVEL_OPTIONS = (Object.keys(LEVEL_DISPLAY) as JudgeLevel[]).map((k) => ({
  value: k, label: LEVEL_DISPLAY[k],
}));

function compareNum(v: number | null, op: JudgeOp, t: number): boolean {
  if (v == null) return false; // 缺失值不参与比较，避免误判
  switch (op) {
    case '>=': return v >= t;
    case '>': return v > t;
    case '<=': return v <= t;
    case '<': return v < t;
    case '=': case '==': return v === t;
    case '!=': return v !== t;
  }
}

// 在合并后表头中按「追加列 key」定位列索引：
//   1) 先精确全表头匹配 —— 支持用户选 "(7天)ROAS" 这类带天前缀的精确列，避免同名歧义；
//   2) 退化匹配：去掉 "(N天)" 前缀后做标签比较 —— 兼容仅填 "ROAS" 的旧配置/模糊选择。
// 例：表头 ["花费","(7天)ROAS","(7天)花费","(15天)ROAS"]
//     key="(15天)ROAS" → 命中第 4 列（精确，区分不同天）；
//     key="ROAS"        → 命中首个 "(7天)ROAS"（退化，便于无天前缀的旧模板）。
export function resolveAppendColIndex(header: any[], key: string): number | null {
  if (!header || !key) return null;
  const k = String(key).trim().toLowerCase();
  // 1) 精确全表头匹配
  for (let ci = 0; ci < header.length; ci++) {
    if (String(header[ci] ?? '').trim().toLowerCase() === k) return ci;
  }
  // 2) 退化：去掉 "(N天)" 前缀后比较标签
  const kInner = k.replace(/^\(\d+天\)/, '');
  for (let ci = 0; ci < header.length; ci++) {
    const inner = String(header[ci] ?? '').replace(/^\(\d+天\)/, '').trim().toLowerCase();
    if (inner === kInner) return ci;
  }
  return null;
}

// 单条条件的求值：固定指标走 MetricResolver，追加列走表头实时解析。
function evalCondition(cond: JudgeCondition, c: Ctx, env: { row: any[]; header: any[] }): boolean {
  if (cond.target === 'appendCol' && cond.appendColKey) {
    const idx = resolveAppendColIndex(env.header, cond.appendColKey);
    const v = getNum(env.row, idx ?? undefined);
    return compareNum(v, cond.op, cond.value);
  }
  const mv: number | null = cond.metric ? (c as any)[cond.metric] : null;
  return compareNum(mv, cond.op, cond.value);
}

/** 把保存的判定模板转换为运行期规则（enabled 的才生效，顺序即优先级） */
export function templateToRules(t: JudgeTemplate): Rule[] {
  return t.rules.filter((r) => r.enabled).map((r) => ({
    level: r.level,
    desc: r.desc,
    test: (c: Ctx, env: { row: any[]; header: any[] }) =>
      r.conditions.length > 0 && r.conditions.every((cond) => evalCondition(cond, c, env)),
  }));
}

// 各类型规则：按 极差 > 差 > 较差 顺序，命中即停（优先级最高的最严重）
export const RULES: Record<CampaignType, Rule[]> = {
  auto: [
    { level: '极差', desc: '30天花费≥30 且 30天订单=0', test: (c) => nn(c.spend30) >= 30 && (c.orders30 ?? -1) === 0 },
    { level: '极差', desc: '30天花费≥30 且 7/30/65天ROAS<1.8 且 7天订单<5', test: (c) => nn(c.spend30) >= 30 && lt(c.roas7, 1.8) && lt(c.roas30, 1.8) && lt(c.roas65, 1.8) && nn(c.orders7) < 5 },
    { level: '极差', desc: '7天订单=0 且 7天花费>20 且 30/65天ROAS<1.8', test: (c) => (c.orders7 ?? -1) === 0 && nn(c.spend7) > 20 && lt(c.roas30, 1.8) && lt(c.roas65, 1.8) },
    { level: '较差', desc: '30天花费≥30 且 7/30/65天ROAS<1.8 且 30天CTR>2%', test: (c) => nn(c.spend30) >= 30 && lt(c.roas7, 1.8) && lt(c.roas30, 1.8) && lt(c.roas65, 1.8) && nn(c.ctr30) > 2 },
    // 注：原文字「7天ROAS<1.8 且 7天ROAS>2」自相矛盾；按业务语义取「近期恢复」解读：
    // 30天/65天ROAS<1.8（历史差）但 7天ROAS>2 且 7天订单>3（近期回暖）→ 待观察而非立即否定。
    { level: '较差', desc: '30天花费≥30 且 30/65天ROAS<1.8 但 7天ROAS>2 且 7天订单>3（近期回暖·待观察）', test: (c) => nn(c.spend30) >= 30 && lt(c.roas30, 1.8) && lt(c.roas65, 1.8) && gt(c.roas7, 2) && nn(c.orders7) > 3 },
  ],
  exact: [
    { level: '极差', desc: '15天花费≥20 且 15天订单=0', test: (c) => nn(c.spend15) >= 20 && (c.orders15 ?? -1) === 0 },
    { level: '极差', desc: '15天花费≥15 且 7/30/65天ROAS<1.5 且 7天订单<5 且 7天CTR<2%', test: (c) => nn(c.spend15) >= 15 && lt(c.roas7, 1.5) && lt(c.roas30, 1.5) && lt(c.roas65, 1.5) && nn(c.orders7) < 5 && lt(c.ctr7, 2) },
    { level: '差', desc: '30天花费≥30 且 7/30/65天ROAS<1.8 且 7天订单<5', test: (c) => nn(c.spend30) >= 30 && lt(c.roas7, 1.8) && lt(c.roas30, 1.8) && lt(c.roas65, 1.8) && nn(c.orders7) < 5 },
    { level: '较差', desc: '30天花费≥30 且 15/30/65天ROAS<2 但 7天ROAS>2 且 7天订单>3', test: (c) => nn(c.spend30) >= 30 && lt(c.roas15, 2) && lt(c.roas30, 2) && lt(c.roas65, 2) && gt(c.roas7, 2) && nn(c.orders7) > 3 },
  ],
  brand: [
    { level: '极差', desc: '30天花费≥30 且 7/30/65天ROAS<1.5 且 7天订单<5', test: (c) => nn(c.spend30) >= 30 && lt(c.roas7, 1.5) && lt(c.roas30, 1.5) && lt(c.roas65, 1.5) && nn(c.orders7) < 5 },
    { level: '极差', desc: '7天订单=0 且 7天花费>15 且 30/65天ROAS<1.5', test: (c) => (c.orders7 ?? -1) === 0 && nn(c.spend7) > 15 && lt(c.roas30, 1.5) && lt(c.roas65, 1.5) },
    { level: '差', desc: '30天花费≥30 且 7/30/65天1.5≤ROAS<1.8 且 7天订单<5', test: (c) => nn(c.spend30) >= 30 && range(c.roas7, 1.5, 1.8) && range(c.roas30, 1.5, 1.8) && range(c.roas65, 1.5, 1.8) && nn(c.orders7) < 5 },
    { level: '较差', desc: '30天花费≥30 且 15/30/65天ROAS<2 但 7天ROAS>2 且 7天订单>3', test: (c) => nn(c.spend30) >= 30 && lt(c.roas15, 2) && lt(c.roas30, 2) && lt(c.roas65, 2) && gt(c.roas7, 2) && nn(c.orders7) > 3 },
  ],
};

export interface MatchedRule {
  level: JudgeLevel;
  desc: string;
}

export interface JudgeResult {
  level: JudgeLevel;        // 最严重等级（用于着色与计数，多规则命中时取最高严重度）
  ruleDesc: string;         // 命中规则详细说明（多规则时按 ①/②/③ 编号列出）
  matched: MatchedRule[];   // 全部同时命中的规则
  multi: boolean;           // 是否同时命中多条规则
}

// 等级严重度（数值越大越严重），多规则命中时取最严重者作为该行判定等级
const LEVEL_SEVERITY: Record<JudgeLevel, number> = {
  极差: 4,
  差: 3,
  较差: 2,
  正常: 1,
  数据不足: 0,
};

export function evaluateRow(resolver: MetricResolver, row: any[], rules: Rule[], header?: any[]): JudgeResult {
  const c: Ctx = {
    spend7: getNum(row, resolver.spend7),
    orders7: getNum(row, resolver.orders7),
    roas7: getNum(row, resolver.roas7),
    ctr7: getNum(row, resolver.ctr7),
    spend15: getNum(row, resolver.spend15),
    orders15: getNum(row, resolver.orders15),
    roas15: getNum(row, resolver.roas15),
    spend30: getNum(row, resolver.spend30),
    orders30: getNum(row, resolver.orders30),
    roas30: getNum(row, resolver.roas30),
    ctr30: getNum(row, resolver.ctr30),
    roas65: getNum(row, resolver.roas65),
  };
  const env = { row, header: header ?? [] };
  // 收集「全部」命中的规则（不再命中即停，便于在判定等级与命中规则内完整说明）
  const matched: MatchedRule[] = [];
  for (const rule of rules) {
    if (rule.test(c, env)) matched.push({ level: rule.level, desc: rule.desc });
  }

  const anyMetric = [c.spend7, c.orders7, c.roas7, c.spend15, c.roas15, c.spend30, c.orders30, c.roas30, c.roas65].some((v) => v != null);
  if (matched.length === 0) {
    return anyMetric
      ? { level: '正常', ruleDesc: '未命中任何否定/观察规则', matched: [], multi: false }
      : { level: '数据不足', ruleDesc: '未识别到花费/ROAS等列，请检查报表列头', matched: [], multi: false };
  }

  // 判定等级：多规则命中时取最严重等级（严重度最高者决定整行等级，保证着色/计数一致）
  const level = matched.reduce(
    (acc, m) => (LEVEL_SEVERITY[m.level] > LEVEL_SEVERITY[acc] ? m.level : acc),
    matched[0].level,
  );
  const multi = matched.length > 1;

  // 命中规则详细说明：多规则按 ①/②/③ 编号逐条列出，并标注每条自身等级，便于一眼看清同时触发的全部规则
  const ruleDesc = multi
    ? matched.map((m, i) => `（${i + 1}）[${m.level}]${m.desc}`).join('；')
    : matched[0].desc;

  return { level, ruleDesc, matched, multi };
}

export interface GroupReport { data: any[][]; dayLabel: string; name: string; uid?: string; color?: string; }

export interface JudgedSheet {
  type: CampaignType;
  rows: any[][]; // 含表头，末尾追加 3 列：判定等级 / 命中规则 / 建议操作
  counts: Record<string, number>;
  baseDayLabel: string;
  appendCols: AppendColConfig[];
  extraHeaders: string[];
  matchedCounts: number[];
  nExtra: number;
  columnColors?: (string | undefined)[]; // 每列背景色（主报告/追加列自定义色），供预览/导出着色
}

// 对一个推广类型分组：宽表合并（自动追加 花费/订单/ROAS/CTR）+ 套判定规则
export function buildJudgedSheet(
  group: GroupReport[],
  type: CampaignType,
  keyCols: number[],
  requiredCols: boolean[],
  matchMode: MatchMode,
  mainIndex: number,
  userAppendCols: AppendColConfig[] = [],
  autoAppendCols: AppendColConfig[] = [],
  rules: Rule[] = [],
): JudgedSheet & { logs: string[] } {
  if (!Array.isArray(group) || group.length === 0) {
    throw new Error(`${CAMPAIGN_LABELS[type] || type}没有可判定的报告`);
  }
  const safeMain = Math.min(Math.max(0, mainIndex), group.length - 1);
  const main = group[safeMain];
  const extras = group.filter((_, i) => i !== safeMain);

  // 追加列去重（按列索引）：用户(ERP 设定)顺序优先，自动 4 指标补充在后，保证输出顺序遵循 ERP 配置
  const seen = new Set<number>();
  const finalAppend: AppendColConfig[] = [];
  for (const ac of [...userAppendCols, ...autoAppendCols]) {
    if (ac?.colIdx == null) continue;
    if (seen.has(ac.colIdx)) continue;
    seen.add(ac.colIdx);
    finalAppend.push(ac);
  }

  const res = mergeReports({
    main: { data: main.data, dayLabel: main.dayLabel, name: main.name },
    extras: extras.map((e) => ({ data: e.data, dayLabel: e.dayLabel, name: e.name })),
    keyCols,
    matchMode,
    requiredCols,
    appendCols: finalAppend,
  });

  const resultRows = res.resultRows;
  const resolver = resolveMetricColumns(resultRows[0], main.dayLabel);

  const counts: Record<string, number> = { 极差: 0, 差: 0, 较差: 0, 正常: 0, 数据不足: 0 };
  // 「合并导出文件再次合并」场景：主报告（已含 判定等级/命中规则/建议操作 三列）作为底座时，
  // 把其旧判定列重命名为「上期判定等级/上期命中规则/上期建议操作」，保留历史判定结果，
  // 避免与本次新生成的判定三列同名冲突（新判定列始终固定在末尾，预览/导出均能正确识别）。
  const srcHeader = resultRows[0];
  const JUDGE_RENAME: Record<string, string> = {
    '判定等级': '上期判定等级',
    '命中规则': '上期命中规则',
    '建议操作': '上期建议操作',
  };
  const renamedHeader = srcHeader.map((h: any) => {
    const s = String(h ?? '');
    return JUDGE_RENAME[s] || s;
  });
  const out: any[][] = [[...renamedHeader, '判定等级', '命中规则', '建议操作']];
  for (let i = 1; i < resultRows.length; i++) {
    const row = resultRows[i];
    const jr = evaluateRow(resolver, row, rules, resultRows[0]);
    counts[jr.level] = (counts[jr.level] || 0) + 1;
    out.push([...row, jr.level, jr.ruleDesc, LEVEL_ACTION[jr.level]]);
  }

  // 计算每列背景色（主报告自定义色 + 追加列/报告自定义色），供预览/导出着色
  const headerFinal = out[0];
  const totalCols = headerFinal.length;
  const perExtra = finalAppend.length;
  const nExtraReps = extras.length;
  const mainColor = main.color;
  const columnColors: (string | undefined)[] = new Array(totalCols).fill(undefined);
  let roasC = -1;
  for (let ci = 0; ci < resultRows[0].length; ci++) {
    if (typeof resultRows[0][ci] === 'string' && /roas/i.test(resultRows[0][ci] as string)) { roasC = ci; break; }
  }
  for (let ci = 0; ci < totalCols; ci++) {
    if (ci >= totalCols - 3) break; // 末尾 3 列（判定等级/命中规则/建议操作）单独处理
    if (roasC >= 0 && ci === roasC) { columnColors[ci] = mainColor || undefined; continue; }
    if (roasC >= 0 && ci > roasC && ci <= roasC + perExtra * nExtraReps) {
      const k = ci - (roasC + 1);
      const extraIdx = Math.floor(k / Math.max(1, perExtra));
      const appIdx = k % Math.max(1, perExtra);
      const acColor = finalAppend[appIdx]?.color;
      const repColor = extras[extraIdx]?.color;
      columnColors[ci] = acColor || repColor || undefined;
      continue;
    }
    columnColors[ci] = mainColor || undefined;
  }

  return {
    type,
    rows: out,
    counts,
    baseDayLabel: main.dayLabel,
    appendCols: finalAppend,
    extraHeaders: res.extraHeaders,
    matchedCounts: res.matchedCounts,
    nExtra: extras.length,
    columnColors,
    logs: res.logs,
  };
}
