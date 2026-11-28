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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_URI = 'ui://amz-ops-planner/app.html';
const APP_HTML_PATH = path.join(__dirname, 'dist', 'app.html');

function resolveDataDir() {
  const arg = process.argv.find(a => a.startsWith('--data-dir='));
  if (arg) {
    const val = arg.slice('--data-dir='.length).trim();
    if (val && !val.includes('${PLUGIN_DATA}')) return val;
  }
  return path.join(__dirname, 'data');
}

const DATA_DIR = resolveDataDir();
const DATA_FILE = path.join(DATA_DIR, 'planner_data.json');

// =============================================================================
// Date & Helper Utilities (Asia/Shanghai default friendly)
// =============================================================================
function todayStr() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function nowIsoLocal() {
  const d = new Date();
  const datePart = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(d);
  const timePart = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d);
  return `${datePart}T${timePart}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function getMondayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  dt.setUTCDate(dt.getUTCDate() + diff);
  return dt.toISOString().slice(0, 10);
}

function genId(prefix = 't') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// =============================================================================
// Amazon Templates & Built-in Market Events
// =============================================================================
const AMZ_TEMPLATES = [
  {
    id: 'peak_bfcm',
    name: '🔥 黑五 / 网一大促全周期备战与恢复 SOP',
    category: '促销大促',
    description: '覆盖预热防窥期、Coupon/LD核查、分时折扣防重叠、主促日盯盘、网一冲刺与大促后 Bid/预算回调。',
    items: [
      { offsetStart: 0, offsetDue: 0, dueTime: '10:00', priority: 'P0', module: '广告投放', title: '核查黑五前防窥期竞价与预算红线', desc: '确认高ACoS词不盲目加价，预留大促当天翻倍预算空间。', alertBeforeMin: 60, tags: ['大促', '预算'], subtasks: ['检查每日预算上限', '关闭零单高花费无效词', '确认分时规则无双重打折'] },
      { offsetStart: 1, offsetDue: 1, dueTime: '14:00', priority: 'P0', module: '促销活动', title: 'Coupon / 专享折扣 / LD 价格重叠审计', desc: '排查是否存在 Coupon + Prime专享折扣 + Deal 叠加导致折上折穿底。', alertBeforeMin: 120, tags: ['防穿底', '合规'], subtasks: ['逐个ASIN检查促销互斥', '核对利润底线表'] },
      { offsetStart: 2, offsetDue: 2, dueTime: '09:00', priority: 'P1', module: '库存补货', title: '大促前 FBA 可售库存与断货防线盘点', desc: '确保主力链接有足够可售库存支撑峰值3-5倍销量，低库存及时控流。', alertBeforeMin: 60, tags: ['FBA', '断货预警'], subtasks: ['导出FBA可售天数', '标红<10天ASIN'] },
      { offsetStart: 3, offsetDue: 3, dueTime: '08:00', priority: 'P0', module: '促销活动', title: '【Black Friday】黑五主促日全天盯盘与分时调价', desc: '按小时监控转化率与预算消耗进度，防止上午预算烧光错失晚间高峰。', alertBeforeMin: 30, tags: ['黑五', 'P0重点'], isMilestone: true, subtasks: ['美西00:00开跑巡检', '美西12:00预算追加评估', '竞品价格与BSR异动记录'] },
      { offsetStart: 4, offsetDue: 5, dueTime: '18:00', priority: 'P1', module: '广告投放', title: '周末余温流量收割与否定低效词', desc: '清理黑五当天只点击不出单的高消费搜索词，为网一腾出预算。', alertBeforeMin: 60, tags: ['否定词', '调优'] },
      { offsetStart: 6, offsetDue: 6, dueTime: '08:30', priority: 'P0', module: '促销活动', title: '【Cyber Monday】网一冲刺加注与尾货清仓', desc: '重点推高转化长尾词和库存偏多SKU的秒杀/折扣。', alertBeforeMin: 30, tags: ['网一'], isMilestone: true },
      { offsetStart: 7, offsetDue: 7, dueTime: '10:00', priority: 'P0', module: '广告投放', title: '大促后 Bid / 位置溢价 / 预算安全回调', desc: '防止大促后高Bid在低转化期持续烧钱，逐步回调至日常基线。', alertBeforeMin: 60, tags: ['回调', '止损'], subtasks: ['恢复日常Budget', '下调激进TOS溢价', '复盘大促ROI'] },
    ],
  },
  {
    id: 'launch_30d',
    name: '🚀 新品上线 30 天 Launch 全周期计划',
    category: '新品推广',
    description: '从发货上架、Vine 申领、首批评价催评、自动/手动精准广告爬坡到30天盈亏复盘的完整日历。',
    items: [
      { offsetStart: 0, offsetDue: 1, dueTime: '10:00', priority: 'P0', module: 'Listing优化', title: '新品 Listing 埋词、五点、A+ 与主图 QA 终审', desc: '核对核心大词埋入标题与后台 Search Terms，检查变体父子关系。', alertBeforeMin: 60, tags: ['新品', 'Listing'], isMilestone: true },
      { offsetStart: 2, offsetDue: 2, dueTime: '15:00', priority: 'P1', module: '新品开发', title: 'FBA 首批入仓上架核对 & 开通 Vine 计划', desc: '确认库存可售状态，第一时间注册 Vine 获取早期高质量评论。', alertBeforeMin: 60, tags: ['Vine', '评论'] },
      { offsetStart: 3, offsetDue: 5, dueTime: '11:00', priority: 'P0', module: '广告投放', title: '开启新品自动广告 (Close/Loose) + 核心精准大词手动', desc: '配合新品期 Coupon 提升初始点击率与转化率，记录首批曝光点击。', alertBeforeMin: 60, tags: ['PPC', '冷启动'] },
      { offsetStart: 7, offsetDue: 7, dueTime: '16:00', priority: 'P1', module: '广告投放', title: 'Launch 第7天：首周搜索词报告清洗与否定', desc: '否定跑偏词，提炼高转化长尾词进入手动精准/词组活动。', alertBeforeMin: 120, tags: ['ST清洗', '第7天'] },
      { offsetStart: 14, offsetDue: 14, dueTime: '15:00', priority: 'P1', module: '促销活动', title: 'Launch 第14天：竞品价格对标 & 首波站外/Coupon测算', desc: '评估自然排名爬坡速度，决定是否加大 Coupon 力度冲击类目 New Release。', alertBeforeMin: 60, tags: ['排名', '第14天'] },
      { offsetStart: 21, offsetDue: 21, dueTime: '16:00', priority: 'P1', module: '库存补货', title: 'Launch 第21天：根据日均销量评估第二批补货发运', desc: '结合海运/空派时效提前锁定补货节点，防止推起后断货。', alertBeforeMin: 1440, tags: ['补货', '第21天'] },
      { offsetStart: 30, offsetDue: 30, dueTime: '17:00', priority: 'P0', module: '财务核算', title: 'Launch 第30天：新品首月 ROI / TACoS 与留评率复盘', desc: '核算自然单占比与广告占比，决定进入利润收割期或继续冲量。', alertBeforeMin: 120, tags: ['复盘', 'TACoS'], isMilestone: true },
    ],
  },
  {
    id: 'ppc_weekly',
    name: '🎯 每周亚马逊广告 PPC 巡检与调价 SOP',
    category: '广告日常',
    description: '每周一至周日标准化广告优化节奏：周一预算、周二否词、周四位置溢价、周五周报复盘。',
    items: [
      { offsetStart: 0, offsetDue: 0, dueTime: '10:00', priority: 'P1', module: '广告投放', title: '周一：全店铺广告预算分配 & 异常爆花活动排查', desc: '检查周末花费异常飙升活动，对高ROAS受限活动补充预算。', alertBeforeMin: 30, tags: ['周例行', '预算'] },
      { offsetStart: 1, offsetDue: 1, dueTime: '14:30', priority: 'P0', module: '广告投放', title: '周二：下载7天/14天搜索词报告 & 批量否定低效词', desc: '对点击>=15且0单、或ACoS严重穿底的词执行精准/词组否定。', alertBeforeMin: 60, tags: ['否定词', '周例行'] },
      { offsetStart: 3, offsetDue: 3, dueTime: '15:00', priority: 'P0', module: '广告投放', title: '周四：广告位置报告审计 & 贴边Bid/溢价调整', desc: '检查首页/其余/详情页位置表现，压低base bid并只保留高转化位置溢价。', alertBeforeMin: 60, tags: ['位置优化', 'Bid'] },
      { offsetStart: 4, offsetDue: 4, dueTime: '17:00', priority: 'P1', module: '财务核算', title: '周五：周度广告 TACoS / 串单率 / 利润红线复盘', desc: '输出本周广告优化战报，更新下周重点调整清单。', alertBeforeMin: 30, tags: ['周复盘'] },
    ],
  },
  {
    id: 'fba_restock',
    name: '📦 FBA 补货与防断货库存管理流',
    category: '供应链库存',
    description: '安全库存核算、货件创建、贴标装柜、在途跟踪与上架差异核查全流程。',
    items: [
      { offsetStart: 0, offsetDue: 0, dueTime: '11:00', priority: 'P0', module: '库存补货', title: '全店 SKU 可售天数 & 在途库存缺口盘点', desc: '按 7天/30天加权日均销量计算安全补货量，标红低于25天库存SKU。', alertBeforeMin: 60, tags: ['库存盘点'] },
      { offsetStart: 1, offsetDue: 2, dueTime: '16:00', priority: 'P1', module: '库存补货', title: '后台创建 FBA 货件 & 核对箱规贴标要求', desc: '避免合仓费激增，合理选择分仓或美西/美东配比。', alertBeforeMin: 60, tags: ['货件创建'] },
      { offsetStart: 5, offsetDue: 5, dueTime: '10:00', priority: 'P1', module: '库存补货', title: '追踪头程物流节点（开船/清关/派送预约）', desc: '核实货代追踪单号与预计入仓日期，如延误立即调整站内广告控速。', alertBeforeMin: 120, tags: ['物流追踪'] },
      { offsetStart: 14, offsetDue: 14, dueTime: '15:00', priority: 'P1', module: '库存补货', title: 'FBA 货件签收上架数量核对 & 丢失索赔检查', desc: '如存在 Receiving 差异，记录开 Case 索赔截止时间。', alertBeforeMin: 1440, tags: ['索赔', '上架'] },
    ],
  },
  {
    id: 'listing_audit',
    name: '🛡️ Listing 转化率提升 & 账户健康巡检',
    category: 'Listing与合规',
    description: '全面体检主图点击率、差评处置、退货原因分析、跟卖监控与账户绩效指标。',
    items: [
      { offsetStart: 0, offsetDue: 0, dueTime: '10:30', priority: 'P0', module: '客服绩效', title: '账户健康面板 (AHR)、ODR、退货率与政策警告巡检', desc: '检查是否有知识产权投诉、商品真实性警告或高退货率 NCX 提醒。', alertBeforeMin: 30, tags: ['AHR', '风控'] },
      { offsetStart: 1, offsetDue: 1, dueTime: '14:00', priority: 'P1', module: 'Listing优化', title: '高退货/低转化 Listing 买家之声 (VOC) 诊断', desc: '整理近30天1-3星差评与退货理由，迭代主图卖点或说明书防误解。', alertBeforeMin: 60, tags: ['VOC', '差评'] },
      { offsetStart: 2, offsetDue: 3, dueTime: '16:00', priority: 'P2', module: 'Listing优化', title: '主图与 A+ 页面 AB 测试 (Manage Your Experiments)', desc: '针对 CTR < 0.4% 的核心单品发起主图/标题 AB 测试。', alertBeforeMin: 60, tags: ['AB测试', 'CTR'] },
    ],
  },
];

const BUILTIN_AMZ_EVENTS = [
  { date: '2026-11-20', title: '黑五预热初期 (1-3档85折/4-6档80折)', type: 'promo', color: '#f59e0b' },
  { date: '2026-11-21', title: '预热周末 · 盯紧美西18-20点加购', type: 'promo', color: '#f59e0b' },
  { date: '2026-11-22', title: '周日基准 -0.05 · 预热加购蓄水', type: 'promo', color: '#d97706' },
  { date: '2026-11-23', title: '预热末期 · 防窥前夕数据复盘', type: 'promo', color: '#d97706' },
  { date: '2026-11-24', title: '🛡️ 防窥高峰 (1-2档80折/3-6档75折)', type: 'warning', color: '#dc2626' },
  { date: '2026-11-25', title: '🛡️ 防窥高峰Day2 (严禁双重降价)', type: 'warning', color: '#dc2626' },
  { date: '2026-11-26', title: '🦃 感恩节 & $2 Coupon开启 (90/85折)', type: 'holiday', color: '#7c3aed' },
  { date: '2026-11-27', title: '🔥 Black Friday 黑五主促 (100%/90/95折)', type: 'peak', color: '#dc2626' },
  { date: '2026-11-28', title: '🔥 黑五Day2 + v4调价观察期满复核', type: 'peak', color: '#ea580c' },
  { date: '2026-11-29', title: '🔥 黑五周末延续 (例行周日例外不降)', type: 'peak', color: '#ea580c' },
  { date: '2026-11-30', title: '⚡ Cyber Monday 网一主促 (100%/90/95折)', type: 'peak', color: '#dc2626' },
  { date: '2026-12-01', title: '🔄 余温收敛回调 (1-3档85折/4-6档80折)', type: 'ops', color: '#2563eb' },
  { date: '2026-12-02', title: '🧹 大促无效词清洗 & 防ACoS反弹', type: 'ops', color: '#2563eb' },
  { date: '2026-12-03', title: '📊 黑五全周期复盘 & 切v30八段基线', type: 'ops', color: '#059669' },
  { date: '2026-12-15', title: '📦 圣诞礼品季 FBA 配送截止日', type: 'cutoff', color: '#059669' },
  { date: '2026-12-25', title: '🎄 圣诞节 Christmas Day', type: 'holiday', color: '#7c3aed' },
  { date: '2026-12-31', title: '📅 Q4 年终清点与新年度预算定盘', type: 'ops', color: '#475569' },
];

const AMAZON_MARKETPLACE_TIMES = [
  { site: '🇺🇸 美国站 (US) / 🇨🇦 加拿大 (CA)', tz: 'America/Los_Angeles', tzLabel: '美西 PST (UTC-8)', bjDiff: '北京比美西快 16 小时 (冬令时)', bjReset: '16:00 (对应美西 00:00)', dealTime: '美西 00:00 = 北京 16:00', peakWindowBj: '北京 00:00–07:00 (美西 08:00–15:00)', dstNote: '3月第2个周日夏令时(+15h)；11月第1个周日冬令时(+16h)' },
  { site: '🇺🇸 美东参考 (EST)', tz: 'America/New_York', tzLabel: '美东 EST (UTC-5)', bjDiff: '北京比美东快 13 小时 (冬令时)', bjReset: '13:00 (对应美东 00:00)', dealTime: '美东 00:00 = 北京 13:00', peakWindowBj: '北京 21:00–04:00 (美东 08:00–15:00)', dstNote: '与美西固定相差 3 小时；US 后台广告报表统一以美西为准' },
  { site: '🇬🇧 英国站 (UK)', tz: 'Europe/London', tzLabel: '伦敦 GMT (UTC+0)', bjDiff: '北京比英国快 8 小时 (冬令时)', bjReset: '08:00 (对应英国 00:00)', dealTime: '英国 00:00 = 北京 08:00', peakWindowBj: '北京 16:00–04:00 (英国 08:00–20:00)', dstNote: '3月最后周日夏令时(+7h)；10月最后周日冬令时(+8h)' },
  { site: '🇩🇪 欧洲站 (DE/FR/IT/ES)', tz: 'Europe/Berlin', tzLabel: '欧洲 CET (UTC+1)', bjDiff: '北京比欧洲快 7 小时 (冬令时)', bjReset: '07:00 (对应欧洲 00:00)', dealTime: '欧洲 00:00 = 北京 07:00', peakWindowBj: '北京 15:00–03:00 (欧洲 08:00–20:00)', dstNote: '3月最后周日夏令时(+6h)；10月最后周日冬令时(+7h)' },
  { site: '🇯🇵 日本站 (JP)', tz: 'Asia/Tokyo', tzLabel: '东京 JST (UTC+9)', bjDiff: '东京比北京快 1 小时', bjReset: '前日 23:00 (对应东京 00:00)', dealTime: '东京 00:00 = 北京 23:00', peakWindowBj: '北京 08:00–22:00 (东京 09:00–23:00)', dstNote: '全年无夏令时，固定快 1 小时' },
  { site: '🇦🇺 澳洲站 (AU)', tz: 'Australia/Sydney', tzLabel: '悉尼 AEDT (UTC+11)', bjDiff: '悉尼比北京快 3 小时 (夏令时)', bjReset: '前日 21:00 (对应悉尼 00:00)', dealTime: '悉尼 00:00 = 北京 21:00', peakWindowBj: '北京 06:00–19:00 (悉尼 09:00–22:00)', dstNote: '南半球10月–4月为夏令时(+3h)，其余+2h' },
];

const DAYPARTING_24H_SLOTS = [
  { pstRange: '00:00–02:59', bjRange: '16:00–18:59', name: '深夜锁费期', v28: '0.80 (周日0.75)', v30: '0.65 (01-02点0.60)', bf1124: '≤7折 (专调7折下)', roasNote: 'UP14天 ROAS 0.42 (01-02点51点击0单)，重点压费', pstStartHour: 0, pstEndHour: 3 },
  { pstRange: '03:00–07:59', bjRange: '19:00–23:59', name: '清晨爬坡期', v28: '1.10 (新品1.05)', v30: '1.00 (新品0.98)', bf1124: '75折 / 80折', roasNote: '东海岸早起浏览转化启动期', pstStartHour: 3, pstEndHour: 8 },
  { pstRange: '08:00–14:59', bjRange: '00:00–06:59 (次日)', name: '🔥 核心黄金高产区', v28: '1.10 (新品1.05)', v30: '1.12 (新品1.05)', bf1124: '75折 / 80折', roasNote: 'UP14天 ROAS 1.74 / TACOS 48.2%，全天最强成交时段', pstStartHour: 8, pstEndHour: 15 },
  { pstRange: '15:00–16:59', bjRange: '07:00–08:59 (次日)', name: '⚠️ 下午低效洼地', v28: '1.10 (被掩盖)', v30: '0.95 (新品0.95)', bf1124: '控费观察', roasNote: '消耗占15.2%($589.71)但ROAS跌至1.29，v30单独降档', pstStartHour: 15, pstEndHour: 17 },
  { pstRange: '17:00–19:59', bjRange: '09:00–11:59 (次日)', name: '晚间下班回升期', v28: '1.10 (新品1.05)', v30: '1.02 (新品1.00)', bf1124: '盯紧加购与防窥', roasNote: '美西下班后购物恢复，大促预热重点盯盘 18–20 点', pstStartHour: 17, pstEndHour: 20 },
  { pstRange: '20:00–20:59', bjRange: '12:00–12:59 (次日)', name: '晚间过渡档', v28: '0.91 (周日0.86)', v30: '0.88 (周日0.83)', bf1124: '过渡回调', roasNote: '主峰结束平滑降价过渡', pstStartHour: 20, pstEndHour: 21 },
  { pstRange: '21:00–22:59', bjRange: '13:00–14:59 (次日)', name: '⚠️ 睡前比价底值', v28: '0.75 (周日0.70)', v30: '0.62 (周日0.57)', bf1124: '7折 (专调睡7)', roasNote: '21点 108点击仅3单(ROAS 0.48)，需重压', pstStartHour: 21, pstEndHour: 23 },
  { pstRange: '23:00–23:59', bjRange: '15:00–15:59 (次日)', name: '深夜捡漏尾盘', v28: '0.75 (周日0.70)', v30: '0.75 (周日0.70)', bf1124: '75折', roasNote: '三组数据稳定 ROAS 1.44–1.51，保留0.75捡漏', pstStartHour: 23, pstEndHour: 24 },
];

function getBlackFridayAndTimeTasks() {
  const now = nowIsoLocal();
  const make = (t) => ({
    description: '',
    module: '促销活动',
    marketplace: 'US',
    asin: '全店铺主力翻盖壳',
    campaign: 'UPBestKS-BFCM',
    priority: 'P1',
    status: 'todo',
    estimatedHours: 1,
    actualMinutes: 0,
    progress: 0,
    recurrence: 'none',
    isMilestone: false,
    okrId: 'okr_1',
    tags: [],
    subtasks: [],
    alerts: [],
    createdAt: now,
    updatedAt: now,
    ...t,
  });

  return [
    make({
      id: 'bf_1120',
      title: '【黑五11/20-11/23 预热初期】1-3档85折 / 4-6档80折 · 兜底提高和降低',
      description: '美西11/20 00:00（北京11/20 16:00）起进入预热初期：浏览走高、加购不买增多。1-3档85折、4-6档80折，Coupon未开启，盯紧美西18-20点（北京次日10:00-12:00）。',
      module: '促销活动',
      priority: 'P1',
      status: 'done',
      startDate: '2026-11-20',
      dueDate: '2026-11-23',
      dueTime: '16:00',
      pstTime: '美西 00:00–20:00',
      progress: 100,
      tags: ['黑五预热', '85折/80折', '美西00:00'],
      subtasks: [
        { id: 'bfst1', text: '第1-3档切85折，第4-6档切80折', done: true },
        { id: 'bfst2', text: '盯紧美西18-20点（北京10:00-12:00）加购波动', done: true },
      ],
    }),
    make({
      id: 'bf_1124_am',
      title: '【11/24 北京11:58/美西19:58】防窥高峰切0.75 · 严防双重打折',
      description: '11/24–11/25 进入比价观望顶峰（CVR最差）。第4-6档及恶化第3档切 75折_75% 或「专调版_深夜8昼75睡7」（21-23点7折），第1-2档保留80折保11/26 Coupon前坑位；严禁同时降基础Bid防跌破0.56腰斩。',
      module: '广告投放',
      priority: 'P0',
      status: 'in_progress',
      startDate: '2026-11-24',
      dueDate: '2026-11-24',
      dueTime: '15:30',
      pstTime: '美西 23:30 (11/23)',
      progress: 70,
      isMilestone: true,
      tags: ['防窥高峰', '75折', '防双重打折', 'v4调价'],
      subtasks: [
        { id: 'bfst3', text: '第1-2档保持80折保坑位', done: true },
        { id: 'bfst4', text: '第3-6档切75折或专调版_深夜8昼75睡7', done: true },
        { id: 'bfst5', text: '剔除#24 IP17-Blue与#28 IP16-Blue伪新品保护', done: false },
        { id: 'bfst6', text: '完成v4 12个触发活动贴边调价并锁4-5天观察期', done: false },
      ],
      alerts: [
        { id: 'bfal_1124', triggerType: 'before_due', offsetMinutes: 30, level: 'critical', label: '11/24 防窥期切价前30分警报', sound: true, snoozedUntil: null, dismissedAt: null },
      ],
    }),
    make({
      id: 'bf_1125',
      title: '【黑五11/25 防窥高峰Day2】单日ACoS>80%局部切70折 + 备战明日Coupon',
      description: '继续执行防窥控费：第1-2档80折，第3-6档75折；若单活动当日ACoS>80%局部切70折。晚上核对明天(11/26) $2 Coupon 提报状态与库存。',
      module: '促销活动',
      priority: 'P0',
      status: 'todo',
      startDate: '2026-11-25',
      dueDate: '2026-11-25',
      dueTime: '16:00',
      pstTime: '美西 00:00',
      tags: ['防窥Day2', '70折止损', 'Coupon准备'],
      subtasks: [
        { id: 'bfst7', text: '排查ACoS>80%活动，局部切70折', done: false },
        { id: 'bfst8', text: '核查11/26 $2 Coupon 生效时间与互斥折扣', done: false },
      ],
      alerts: [
        { id: 'bfal_1125', triggerType: 'before_due', offsetMinutes: 60, level: 'critical', label: '11/25 防窥期止损检查', sound: true, snoozedUntil: null, dismissedAt: null },
      ],
    }),
    make({
      id: 'bf_1126',
      title: '【11/26 感恩节 & $2 Coupon 开启】1-3档调回90折 / 4-6档85折 · 释放11-17点流量',
      description: '美西11/26 00:00（北京11/26 16:00）开启 $2 Coupon，转化明显回暖！分时模板从75/80折上调至 1-3档90折、4-6档85折，释放美西11-17点（北京次日03:00-09:00）流量并观察提速。',
      module: '促销活动',
      priority: 'P0',
      status: 'todo',
      startDate: '2026-11-26',
      dueDate: '2026-11-26',
      dueTime: '15:30',
      pstTime: '美西 23:30→00:00',
      isMilestone: true,
      tags: ['感恩节', '$2 Coupon', '90折/85折', '北京16:00'],
      subtasks: [
        { id: 'bfst9', text: '15:30 切第1-3档90折、第4-6档85折', done: false },
        { id: 'bfst10', text: '16:15 确认前台 $2 Coupon 绿标正常展示且无折上折', done: false },
        { id: 'bfst11', text: '核对美西08-14点核心高产区预算是否充足', done: false },
      ],
      alerts: [
        { id: 'bfal_1126', triggerType: 'before_due', offsetMinutes: 60, level: 'critical', label: '感恩节开启$2 Coupon前60分钟警报', sound: true, snoozedUntil: null, dismissedAt: null },
      ],
    }),
    make({
      id: 'bf_1127_pre',
      title: '【Black Friday 黑五开跑切换】北京15:30(美西23:30) 切1-3档100% / 4-5档90折 / 6档95折',
      description: '美西11/27 00:00（北京11/27 16:00）黑五主促正式引爆！1-3档恢复100%常规全力冲量，4-5档90折，第6档新品95折吃首单；检查主力活动日预算翻倍预留。',
      module: '促销活动',
      priority: 'P0',
      status: 'todo',
      startDate: '2026-11-27',
      dueDate: '2026-11-27',
      dueTime: '15:30',
      pstTime: '美西 23:30→00:00',
      isMilestone: true,
      tags: ['Black Friday', '100%/90/95折', '北京16:00开抢'],
      subtasks: [
        { id: 'bfst12', text: '15:30 切换黑五折扣模板 (1-3档100% / 4-5档90% / 6档95%)', done: false },
        { id: 'bfst13', text: '16:05 巡检Coupon+黑五价+广告竞价无异常飙升', done: false },
        { id: 'bfst14', text: '21:00 检查欧洲站/美国站早段预算消耗速度', done: false },
      ],
      alerts: [
        { id: 'bfal_1127', triggerType: 'before_due', offsetMinutes: 60, level: 'critical', label: '黑五开跑前1小时最高级别警报', sound: true, snoozedUntil: null, dismissedAt: null },
      ],
    }),
    make({
      id: 'bf_1128_peak',
      title: '【黑五次日高峰 + v4调价复核】美西08-14点黄金期(北京00-07点) + 4天观察期验收',
      description: '今日对应美西黑五黄金成交日（北京11/28 00:00-07:00为美西08:00-15:00最高产区），同时11/24执行的12个v4位置贴边调价活动满4天观察期，上午10:00拉表复核ACoS与订单恢复情况。',
      module: '广告投放',
      priority: 'P0',
      status: 'todo',
      startDate: '2026-11-28',
      dueDate: '2026-11-28',
      dueTime: '10:00',
      pstTime: '美西 18:00 (11/27)',
      tags: ['黑五Day2', 'v4复核', '黄金时段'],
      subtasks: [
        { id: 'bfst15', text: '核查11/27黑五全天预算撞线与ROI', done: false },
        { id: 'bfst16', text: '复核12个v4贴边调价活动4天表现', done: false },
      ],
      alerts: [
        { id: 'bfal_1128', triggerType: 'before_due', offsetMinutes: 30, level: 'warning', label: '黑五次日上午复核铃', sound: true, snoozedUntil: null, dismissedAt: null },
      ],
    }),
    make({
      id: 'bf_1129_sun',
      title: '【黑五周日特例】11/29 周日不执行常规-0.05降档，保持冲刺并备战网一',
      description: '常规周日全时段基准-0.05，但黑五周 11/27–11/29 例外保持 1-3档100%、4-5档90折、6档95折！下午清理黑五高耗0单垃圾词，为明天网一腾出预算。',
      module: '促销活动',
      priority: 'P1',
      status: 'todo',
      startDate: '2026-11-29',
      dueDate: '2026-11-29',
      dueTime: '16:00',
      pstTime: '美西 00:00',
      tags: ['周日特例', '黑五周末', '网一准备'],
      alerts: [
        { id: 'bfal_1129', triggerType: 'before_due', offsetMinutes: 60, level: 'warning', label: '周日黑五特例确认提醒', sound: true, snoozedUntil: null, dismissedAt: null },
      ],
    }),
    make({
      id: 'bf_1130_cm',
      title: '【Cyber Monday 网一主促】北京16:00(美西00:00) 全力冲刺收官 & 尾货清仓',
      description: '11/30 网一继续执行 1-3档100%、4-5档90折、6档95折，重点向高转化长尾词及库存偏充裕SKU倾斜；晚间准备明日(12/01)余温回调清单。',
      module: '促销活动',
      priority: 'P0',
      status: 'todo',
      startDate: '2026-11-30',
      dueDate: '2026-11-30',
      dueTime: '15:30',
      pstTime: '美西 23:30→00:00',
      isMilestone: true,
      tags: ['Cyber Monday', '网一冲刺', '北京16:00'],
      alerts: [
        { id: 'bfal_1130', triggerType: 'before_due', offsetMinutes: 60, level: 'critical', label: '网一主促启动前1小时警报', sound: true, snoozedUntil: null, dismissedAt: null },
      ],
    }),
    make({
      id: 'bf_1201_cool',
      title: '【12/01-12/03 余温收敛紧急回调】1-3档降回85折 / 4-6档降回80折 · 回调大促预算',
      description: '网一结束购买力透支、CPC回落慢，必须在美西12/01 00:00（北京12/01 16:00）前把分时倍率回调至 85折/80折，回调大促临时预算与溢价，视情况关闭 $2 Coupon！',
      module: '广告投放',
      priority: 'P0',
      status: 'todo',
      startDate: '2026-12-01',
      dueDate: '2026-12-01',
      dueTime: '15:30',
      pstTime: '美西 23:30→00:00',
      isMilestone: true,
      tags: ['余温回调', '85折/80折', '防ACoS反弹'],
      subtasks: [
        { id: 'bfst17', text: '15:30 切回 1-3档85折 / 4-6档80折', done: false },
        { id: 'bfst18', text: '回调大促翻倍日预算至日常安全线', done: false },
        { id: 'bfst19', text: '评估关闭或调整 $2 Coupon', done: false },
      ],
      alerts: [
        { id: 'bfal_1201', triggerType: 'before_due', offsetMinutes: 120, level: 'critical', label: '大促结束紧急回调预警', sound: true, snoozedUntil: null, dismissedAt: null },
      ],
    }),
    make({
      id: 'bf_1203_v30',
      title: '【12/03 黑五全周期复盘 & 上线 v30 八段精细分时基线】',
      description: '11/20–12/03 黑五全周期收官：导出全周期 Search Term 与位置报告清洗大促无效词，正式切换 v30 八段精细基线（00-02:0.65 / 03-07:1.00 / 08-14:1.12 / 15-16:0.95 / 17-19:1.02 / 20:0.88 / 21-22:0.62 / 23:0.75）。',
      module: '财务核算',
      priority: 'P1',
      status: 'todo',
      startDate: '2026-12-02',
      dueDate: '2026-12-03',
      dueTime: '17:00',
      pstTime: '美西 01:00',
      isMilestone: true,
      tags: ['黑五收官', 'v30上线', 'ST清洗'],
      alerts: [
        { id: 'bfal_1203', triggerType: 'before_due', offsetMinutes: 120, level: 'warning', label: '黑五收官切v30提醒', sound: true, snoozedUntil: null, dismissedAt: null },
      ],
    }),
    make({
      id: 'amz_daily_0900',
      title: '【每日亚马逊晨会时间点】北京09:00 = 美西17:00 晚间回升 + 欧洲01:00/日本10:00',
      description: '每日上午 09:00 运营例行巡检：检查美西 17:00–19:59 下班购物回升期表现、欧洲站夜间成交、日本站早盘，以及昨日 12–48h 归因延迟更新后的广告报表。',
      module: '常规运营',
      priority: 'P2',
      status: 'todo',
      startDate: '2026-11-24',
      dueDate: '2026-11-24',
      dueTime: '09:00',
      pstTime: '美西 17:00 / 日本 10:00',
      recurrence: 'daily',
      tags: ['北京09:00', '美西17:00', '每日例行'],
      alerts: [
        { id: 'bfal_0900', triggerType: 'daily_at', timeOfDay: '09:00', level: 'info', label: '09:00 晨会多站点巡检', sound: false, snoozedUntil: null, dismissedAt: null },
      ],
    }),
    make({
      id: 'weekly_bid_opt',
      title: 'UPBestKS 每周分时调价与广告竞价优化',
      description: '拉取近 14 天 24 小时数据与广告位置报告，统计每日销售最佳时段与低效时段，根据 ROS/TOS 表现优化分时倍率与竞价分组。',
      module: '广告优化',
      priority: 'P1',
      status: 'todo',
      startDate: '2026-11-27',
      dueDate: '2026-11-27',
      dueTime: '15:00',
      recurrence: 'weekly',
      tags: ['分时调价', '每周优化', '广告优化'],
      subtasks: [
        { id: 'st_opt_1', text: '拉取近 14 天 24h 销售与点击分布数据', done: false },
        { id: 'st_opt_2', text: '核对 15-16 点与 21 点低效区间是否需降档控费', done: false },
        { id: 'st_opt_3', text: '根据各档位表现更新分时模板分组并同步知识库', done: false },
      ],
      alerts: [
        { id: 'al_weekly_bid', triggerType: 'before_due', offsetMinutes: 60, level: 'warning', label: '周五 14:00 调价优化提醒', sound: true },
      ],
    }),
  ];
}

function migrateStoreV2(store) {
  let changed = false;
  if ((store.version || 1) < 2) {
    const existingIds = new Set((store.tasks || []).map(t => t.id));
    for (const t of getBlackFridayAndTimeTasks()) {
      if (!existingIds.has(t.id)) {
        store.tasks.push(t);
        changed = true;
      }
    }
    store.version = 2;
    changed = true;
  }
  return changed;
}

function createSeedData() {
  const today = todayStr(); // e.g., 2026-11-24
  const mon = getMondayOf(today);
  const tue = addDays(mon, 1);
  const wed = addDays(mon, 2);
  const thu = addDays(mon, 3);
  const fri = addDays(mon, 4);
  const sat = addDays(mon, 5);
  const sun = addDays(mon, 6);
  const nextMon = addDays(mon, 7);
  const nextTue = addDays(mon, 8);
  const yesterday = addDays(today, -1);

  return {
    version: 2,
    settings: {
      weekStartMonday: true,
      soundEnabled: true,
      browserNotify: false,
      defaultAlertMinutes: 30,
      dailyCapacityHours: 8,
      activeStore: 'UPBestKS-US',
    },
    okrs: [
      {
        id: 'okr_1',
        title: '黑五 & 网一大促周：零失误冲量且严控穿底亏损',
        period: '本周 (W48)',
        owner: '运营总控',
        targetValue: 100,
        currentValue: 68,
        unit: '%',
        keyResults: ['黑五前完成 12 个触发活动贴边 Bid 收口', 'Coupon 与专享折扣 0 重叠穿底', '大促期间 ACoS 控制在 42% 以内'],
      },
      {
        id: 'okr_2',
        title: '主力 iPhone 17 / S26 系列库存安全线 >= 25 天',
        period: '11月-12月',
        owner: '供应链/运营',
        targetValue: 100,
        currentValue: 82,
        unit: '%',
        keyResults: ['完成黑五后空派补货下单', '断货高风险 SKU 提前控广告流速'],
      },
    ],
    tasks: [
      {
        id: 'seed_1',
        title: '【紧急】核查 12 个触发调价活动位置溢价 & 防窥期禁止大改',
        description: '11/24 黑五前 3 天处于防窥与权重稳定期，只做高风险止损检查，避免大幅修改导致权重波动。',
        module: '广告投放',
        marketplace: 'US',
        asin: 'B0F-IP17PM / S26U',
        campaign: 'UP-Auto-IP17ProMax 等12活动',
        priority: 'P0',
        status: 'in_progress',
        startDate: today,
        dueDate: today,
        dueTime: '14:30',
        estimatedHours: 1.5,
        actualMinutes: 25,
        progress: 60,
        recurrence: 'none',
        isMilestone: false,
        okrId: 'okr_1',
        tags: ['防窥期', '位置优化', 'P0'],
        subtasks: [
          { id: 'st1', text: '核对 closeMatch 贴边 Bid 计算表', done: true },
          { id: 'st2', text: '确认零单高花费位置是否已拦截', done: true },
          { id: 'st3', text: '记录今日广告中控台变更日志', done: false },
        ],
        alerts: [
          { id: 'al_1', triggerType: 'before_due', offsetMinutes: 60, level: 'critical', label: '截止前60分钟强提醒', sound: true, snoozedUntil: null, dismissedAt: null },
          { id: 'al_2', triggerType: 'daily_at', timeOfDay: '13:00', level: 'warning', label: '今日午后盯盘铃', sound: true, snoozedUntil: null, dismissedAt: null },
        ],
        createdAt: `${yesterday}T10:00:00`,
        updatedAt: `${today}T09:00:00`,
      },
      {
        id: 'seed_2',
        title: '黑五分时调价 v30 与站内 Coupon 防双重打折终审',
        description: '核查所有参与黑五折扣的机型，避免「分时降价 + 黑五75折 + Coupon」叠加造成单件净亏。',
        module: '促销活动',
        marketplace: 'US',
        asin: '全店铺主力翻盖壳',
        campaign: 'BFCM-2026',
        priority: 'P0',
        status: 'todo',
        startDate: today,
        dueDate: wed,
        dueTime: '16:00',
        estimatedHours: 2,
        actualMinutes: 0,
        progress: 20,
        recurrence: 'none',
        isMilestone: true,
        okrId: 'okr_1',
        tags: ['黑五', '防双重打折'],
        subtasks: [
          { id: 'st4', text: '跑一遍防双重打折试算器（75折档）', done: true },
          { id: 'st5', text: '核查 Prime 专享折扣生效时段', done: false },
          { id: 'st6', text: '锁定周四夜里美西切换时段规则', done: false },
        ],
        alerts: [
          { id: 'al_3', triggerType: 'before_due', offsetMinutes: 1440, level: 'critical', label: '提前1天红色预警', sound: true, snoozedUntil: null, dismissedAt: null },
        ],
        createdAt: `${mon}T09:30:00`,
        updatedAt: `${today}T09:30:00`,
      },
      {
        id: 'seed_3',
        title: '下载周度 Search Term 报告 & 清洗 CTR<0.3% 垃圾词',
        description: '聚焦 Moto G 2026 与 Pixel 11 曝光虚高但点击极低的词组，批量加精准否定。',
        module: '广告投放',
        marketplace: 'US',
        asin: 'Moto G 2026 / Pixel 11',
        campaign: 'UP-Auto-Moto / Pixel',
        priority: 'P1',
        status: 'done',
        startDate: mon,
        dueDate: mon,
        dueTime: '17:00',
        estimatedHours: 1.5,
        actualMinutes: 80,
        progress: 100,
        recurrence: 'weekly',
        isMilestone: false,
        okrId: 'okr_1',
        tags: ['否定词', 'CTR清洗'],
        subtasks: [
          { id: 'st7', text: '导出近14天ST报告', done: true },
          { id: 'st8', text: '添加28个不相关型号否定词', done: true },
        ],
        alerts: [],
        createdAt: `${mon}T09:00:00`,
        updatedAt: `${mon}T17:10:00`,
      },
      {
        id: 'seed_4',
        title: '【Black Friday】黑五主促日全天分时段监控 & 预算动态加码',
        description: '美西 00:00（北京 16:00）起每 2 小时检查核心活动预算消耗、CPC 飙升与转化率变化。',
        module: '促销活动',
        marketplace: 'US',
        asin: '全店铺',
        campaign: 'All Active Campaigns',
        priority: 'P0',
        status: 'todo',
        startDate: fri,
        dueDate: fri,
        dueTime: '09:00',
        estimatedHours: 5,
        actualMinutes: 0,
        progress: 0,
        recurrence: 'none',
        isMilestone: true,
        okrId: 'okr_1',
        tags: ['Black Friday', '里程碑', '盯盘'],
        subtasks: [
          { id: 'st9', text: '15:30 切换黑五峰值分时策略', done: false },
          { id: 'st10', text: '20:00 检查高ROI活动是否撞预算上限', done: false },
          { id: 'st11', text: '次日 08:00 汇总黑五首日战报', done: false },
        ],
        alerts: [
          { id: 'al_4', triggerType: 'before_due', offsetMinutes: 120, level: 'critical', label: '黑五当日早间警报', sound: true, snoozedUntil: null, dismissedAt: null },
        ],
        createdAt: `${mon}T11:00:00`,
        updatedAt: `${mon}T11:00:00`,
      },
      {
        id: 'seed_5',
        title: '检查 iPhone 17 Pro Max 紫色/棕色 FBA 可售天数并安排空派补货',
        description: '核实当前在库 + 在途库存，防止黑五爆单后出现12月断货。',
        module: '库存补货',
        marketplace: 'US',
        asin: 'B0F-IP17PM-BRN',
        campaign: '',
        priority: 'P1',
        status: 'todo',
        startDate: yesterday,
        dueDate: yesterday,
        dueTime: '18:00',
        estimatedHours: 1,
        actualMinutes: 0,
        progress: 40,
        recurrence: 'none',
        isMilestone: false,
        okrId: 'okr_2',
        tags: ['断货预警', 'FBA补货'],
        subtasks: [
          { id: 'st12', text: '核对工厂成品库存', done: true },
          { id: 'st13', text: '下发空派发货单给货代', done: false },
        ],
        alerts: [
          { id: 'al_5', triggerType: 'before_due', offsetMinutes: 30, level: 'critical', label: '补货截止提醒（已逾期示范）', sound: true, snoozedUntil: null, dismissedAt: null },
        ],
        createdAt: `${addDays(today, -3)}T10:00:00`,
        updatedAt: `${yesterday}T14:00:00`,
      },
      {
        id: 'seed_6',
        title: '周末黑五余温巡检 & 清理0单异常高CPC活动',
        description: '周末流量偏散且转化略降，及时拦截0单超过20次点击的长尾浪费。',
        module: '广告投放',
        marketplace: 'US',
        asin: 'S25 / A17',
        campaign: 'UP-Auto-S25 / A17',
        priority: 'P2',
        status: 'backlog',
        startDate: sat,
        dueDate: sun,
        dueTime: '20:00',
        estimatedHours: 1.5,
        actualMinutes: 0,
        progress: 0,
        recurrence: 'weekly',
        isMilestone: false,
        okrId: 'okr_1',
        tags: ['周末控损'],
        subtasks: [],
        alerts: [
          { id: 'al_6', triggerType: 'before_due', offsetMinutes: 60, level: 'info', label: '周日控损巡检铃', sound: false, snoozedUntil: null, dismissedAt: null },
        ],
        createdAt: `${mon}T15:00:00`,
        updatedAt: `${mon}T15:00:00`,
      },
      {
        id: 'seed_7',
        title: '【Cyber Monday】网一冲刺 & 次日大促 Bid/预算安全回调',
        description: '11/30 网一收官冲刺后，12/01 上午必须回调大促临时预算与溢价，避免淡季空烧。',
        module: '促销活动',
        marketplace: 'US',
        asin: '全店铺',
        campaign: 'All Peak Campaigns',
        priority: 'P0',
        status: 'todo',
        startDate: nextMon,
        dueDate: nextTue,
        dueTime: '10:30',
        estimatedHours: 3,
        actualMinutes: 0,
        progress: 0,
        recurrence: 'none',
        isMilestone: true,
        okrId: 'okr_1',
        tags: ['Cyber Monday', '回调'],
        subtasks: [
          { id: 'st14', text: '网一晚间高峰流量冲刺', done: false },
          { id: 'st15', text: '12/01 回调日常预算与竞价乘数', done: false },
        ],
        alerts: [
          { id: 'al_7', triggerType: 'before_due', offsetMinutes: 1440, level: 'critical', label: '网一回调前1天预警', sound: true, snoozedUntil: null, dismissedAt: null },
        ],
        createdAt: `${today}T09:00:00`,
        updatedAt: `${today}T09:00:00`,
      },
      {
        id: 'seed_8',
        title: 'Listing 主图 A/B 测试 & 退货率偏高颜色（Light Brown）差评分析',
        description: '排查浅棕款色差退货原因，在五点描述和副图中补充实拍色卡说明。',
        module: 'Listing优化',
        marketplace: 'US',
        asin: 'S26Ultra-Light Brown',
        campaign: '',
        priority: 'P2',
        status: 'waiting',
        startDate: tue,
        dueDate: thu,
        dueTime: '18:00',
        estimatedHours: 2,
        actualMinutes: 45,
        progress: 50,
        recurrence: 'none',
        isMilestone: false,
        okrId: 'okr_2',
        tags: ['VOC', '视觉优化'],
        subtasks: [
          { id: 'st16', text: '导出近30天退货原因报表', done: true },
          { id: 'st17', text: '美工交付新色卡对比图', done: false },
        ],
        alerts: [],
        createdAt: `${mon}T14:00:00`,
        updatedAt: `${today}T10:00:00`,
      },
      ...getBlackFridayAndTimeTasks(),
    ],
    alertRules: [
      {
        id: 'rule_1',
        name: '每日早间 09:30 逾期与今日高危计划汇总警报',
        enabled: true,
        scheduleType: 'daily',
        timeOfDay: '09:30',
        condition: 'overdue_or_today_p0',
        level: 'critical',
        sound: true,
        note: '每天上午上班自动扫描所有逾期未完成或今日到期的 P0/P1 运营任务',
      },
      {
        id: 'rule_2',
        name: '每周四 15:00 广告位置报告 & 贴边 Bid 审计提醒',
        enabled: true,
        scheduleType: 'weekly',
        weekday: 4,
        timeOfDay: '15:00',
        condition: 'always',
        level: 'warning',
        sound: true,
        note: '下载最新位置报告并核查 closeMatch 贴边 Bid 与首页/详情溢价',
      },
      {
        id: 'rule_3',
        name: '每周五 17:30 周计划复盘 & 未完成顺延提醒',
        enabled: true,
        scheduleType: 'weekly',
        weekday: 5,
        timeOfDay: '17:30',
        condition: 'always',
        level: 'info',
        sound: false,
        note: '整理本周完成率，将未闭环任务顺延排入下周周计划',
      },
    ],
    pomodoroLogs: [],
  };
}

function loadStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const seed = createSeedData();
    saveStore(seed);
    return seed;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed.tasks) parsed.tasks = [];
    if (!parsed.okrs) parsed.okrs = [];
    if (!parsed.alertRules) parsed.alertRules = [];
    if (!parsed.pomodoroLogs) parsed.pomodoroLogs = [];
    if (!parsed.settings) parsed.settings = createSeedData().settings;
    if (migrateStoreV2(parsed)) saveStore(parsed);
    return parsed;
  } catch {
    const seed = createSeedData();
    saveStore(seed);
    return seed;
  }
}

function saveStore(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

// =============================================================================
// Alert Evaluation Engine (Server-side + Real-time Mirror)
// =============================================================================
function parseLocalDateTimeMs(dateStr, timeStr = '23:59') {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = (timeStr || '23:59').split(':').map(Number);
  // Treat as Asia/Shanghai (+08:00)
  return Date.UTC(y, m - 1, d, (hh || 0) - 8, mm || 0, 0);
}

function evaluateAlerts(store) {
  const nowMs = Date.now();
  const today = todayStr();
  const activeAlerts = [];

  for (const t of store.tasks) {
    if (t.status === 'done') continue;
    const dueMs = parseLocalDateTimeMs(t.dueDate, t.dueTime || '18:00');
    if (!dueMs) continue;

    // 1. Implicit overdue alert
    if (dueMs < nowMs) {
      const hoursOverdue = Math.max(1, Math.round((nowMs - dueMs) / 3600000));
      activeAlerts.push({
        id: `auto_overdue_${t.id}`,
        taskId: t.id,
        taskTitle: t.title,
        module: t.module,
        priority: t.priority,
        dueDate: t.dueDate,
        dueTime: t.dueTime || '18:00',
        kind: 'overdue',
        level: 'critical',
        label: `已逾期 ${hoursOverdue >= 24 ? Math.floor(hoursOverdue / 24) + '天' : hoursOverdue + '小时'}`,
        triggerAtMs: dueMs,
        sound: true,
        snoozedUntil: t._overdueSnoozeUntil || null,
        dismissed: Boolean(t._overdueDismissed),
      });
    }

    // 2. Explicit task alerts
    for (const al of t.alerts || []) {
      let trigMs = null;
      if (al.triggerType === 'before_due') {
        trigMs = dueMs - (Number(al.offsetMinutes || 30) * 60000);
      } else if (al.triggerType === 'exact_time' && al.exactAt) {
        const [ed, et] = al.exactAt.split('T');
        trigMs = parseLocalDateTimeMs(ed, (et || '09:00').slice(0, 5));
      } else if (al.triggerType === 'daily_at' && al.timeOfDay) {
        trigMs = parseLocalDateTimeMs(today, al.timeOfDay);
      }
      if (!trigMs) continue;

      const isTriggered = nowMs >= trigMs;
      const isUpcoming = !isTriggered && (trigMs - nowMs) <= 24 * 3600000;
      if (isTriggered || isUpcoming) {
        activeAlerts.push({
          id: al.id,
          taskId: t.id,
          taskTitle: t.title,
          module: t.module,
          priority: t.priority,
          dueDate: t.dueDate,
          dueTime: t.dueTime || '18:00',
          kind: isTriggered ? 'firing' : 'upcoming',
          level: al.level || 'warning',
          label: al.label || '计划提醒',
          triggerAtMs: trigMs,
          sound: Boolean(al.sound),
          snoozedUntil: al.snoozedUntil || null,
          dismissed: Boolean(al.dismissedAt),
        });
      }
    }
  }

  // Filter active (non-dismissed, non-snoozed) vs snoozed
  const liveFiring = activeAlerts.filter(a => {
    if (a.dismissed) return false;
    if (a.snoozedUntil && new Date(a.snoozedUntil).getTime() > nowMs) return false;
    return a.kind === 'overdue' || a.kind === 'firing';
  });

  const upcoming = activeAlerts.filter(a => !a.dismissed && a.kind === 'upcoming');
  const snoozed = activeAlerts.filter(a => !a.dismissed && a.snoozedUntil && new Date(a.snoozedUntil).getTime() > nowMs);

  return {
    evaluatedAt: nowIsoLocal(),
    firingCount: liveFiring.length,
    upcomingCount: upcoming.length,
    overdueCount: liveFiring.filter(a => a.kind === 'overdue').length,
    firing: liveFiring.sort((a, b) => (a.level === 'critical' ? -1 : 1) - (b.level === 'critical' ? -1 : 1) || a.triggerAtMs - b.triggerAtMs),
    upcoming: upcoming.sort((a, b) => a.triggerAtMs - b.triggerAtMs),
    snoozed,
  };
}

function listAntigravityConversations(limit = 30) {
  const brainDir = 'C:\\Users\\admin\\.gemini\\antigravity\\brain';
  try {
    if (!fs.existsSync(brainDir)) return [];
    const dirs = fs.readdirSync(brainDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^[0-9a-f-]{32,36}$/i.test(d.name))
      .map(d => {
        const full = path.join(brainDir, d.name);
        const stat = fs.statSync(full);
        return { id: d.name, full, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit);

    return dirs.map(d => {
      let title = '（空对话或系统对话）';
      const trPath = path.join(d.full, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        if (fs.existsSync(trPath)) {
          const fd = fs.openSync(trPath, 'r');
          const buf = Buffer.alloc(4096);
          const bytes = fs.readSync(fd, buf, 0, 4096, 0);
          fs.closeSync(fd);
          const firstLine = buf.toString('utf8', 0, bytes).split(/\r?\n/)[0];
          if (firstLine) {
            const parsed = JSON.parse(firstLine);
            const raw = String(parsed.content || '');
            const m = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
            const clean = (m ? m[1] : raw).replace(/\s+/g, ' ').trim();
            if (clean) title = clean.slice(0, 72) + (clean.length > 72 ? '…' : '');
          }
        }
      } catch { /* ignore */ }
      const updatedAt = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(d.mtimeMs)).replace(',', '');
      return { id: d.id, title, updatedAt };
    });
  } catch {
    return [];
  }
}

function getOptionalKbLink() {
  const plDir = 'C:\\Users\\admin\\.gemini\\antigravity\\scratch\\UPBestKS_Placement_KB';
  const dpDir = 'C:\\Users\\admin\\.gemini\\antigravity\\scratch\\UPBestKS_Dayparting_KB';
  try {
    const plMan = fs.existsSync(path.join(plDir, 'sync_manifest.json'))
      ? JSON.parse(fs.readFileSync(path.join(plDir, 'sync_manifest.json'), 'utf8'))
      : null;
    const dpMan = fs.existsSync(path.join(dpDir, 'sync_manifest.json'))
      ? JSON.parse(fs.readFileSync(path.join(dpDir, 'sync_manifest.json'), 'utf8'))
      : null;
    if (!plMan && !dpMan) return null;
    return {
      connected: true,
      placementUpdatedAt: plMan?.last_synced_at || plMan?.updated_at || null,
      daypartingUpdatedAt: dpMan?.last_synced_at || dpMan?.updated_at || null,
    };
  } catch {
    return null;
  }
}

function buildPayload(store, extra = {}) {
  const alertStatus = evaluateAlerts(store);
  const today = todayStr();
  const tasks = store.tasks || [];
  const doneCount = tasks.filter(t => t.status === 'done').length;
  const todayCount = tasks.filter(t => t.dueDate === today && t.status !== 'done').length;
  const mon = getMondayOf(today);
  const sun = addDays(mon, 6);
  const weekTasks = tasks.filter(t => t.dueDate >= mon && t.dueDate <= sun);
  const weekDone = weekTasks.filter(t => t.status === 'done').length;

  return {
    refreshedAt: nowIsoLocal(),
    today,
    currentWeekMonday: mon,
    dataFile: DATA_FILE,
    summary: {
      totalTasks: tasks.length,
      doneCount,
      openCount: tasks.length - doneCount,
      todayCount,
      weekTotal: weekTasks.length,
      weekDone,
      firingAlerts: alertStatus.firingCount,
      overdueCount: alertStatus.overdueCount,
      upcomingAlerts: alertStatus.upcomingCount,
    },
    settings: store.settings,
    tasks,
    okrs: store.okrs,
    alertRules: store.alertRules,
    alertStatus,
    templates: AMZ_TEMPLATES,
    builtinEvents: BUILTIN_AMZ_EVENTS,
    marketplaceTimes: AMAZON_MARKETPLACE_TIMES,
    daypartingSlots: DAYPARTING_24H_SLOTS,
    kbLink: getOptionalKbLink(),
    conversations: listAntigravityConversations(30),
    pomodoroLogs: store.pomodoroLogs || [],
    ...extra,
  };
}

// =============================================================================
// MCP Server Setup
// =============================================================================
const server = new Server(
  { name: 'amz_ops_planner', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'open_planner',
      title: '亚马逊运营计划看板',
      description: '打开亚马逊运营全能计划看板（月度日历、周计划看板、警报预警中心、Kanban拖拽、甘特图、多维列表、OKR目标、SOP模板库与番茄钟）。',
      inputSchema: {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            enum: ['today', 'calendar', 'weekly', 'timezones', 'conversations', 'kanban', 'gantt', 'list', 'alerts', 'templates', 'analytics'],
            description: 'Initial view tab to open.',
          },
          date: { type: 'string', description: 'Focus date YYYY-MM-DD.' },
          search: { type: 'string', description: 'Optional initial search keyword.' },
        },
      },
      _meta: {
        ui: { resourceUri: APP_URI },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: '亚马逊运营计划' },
            { type: 'global', title: '亚马逊运营计划' },
          ],
        },
      },
    },
    {
      name: 'get_planner_state',
      title: 'Get Planner State',
      description: 'Read live Amazon operations tasks, weekly plans, calendar events, OKRs, and active alerts.',
      inputSchema: { type: 'object', properties: {} },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
    {
      name: 'upsert_task',
      title: 'Create or Update Plan Task',
      description: 'Create or update an Amazon operations plan task with dates, priority, subtasks, and alerts.',
      inputSchema: {
        type: 'object',
        required: ['task'],
        properties: {
          task: {
            type: 'object',
            description: 'Task payload. Include id to update, omit id to create.',
          },
        },
      },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
    {
      name: 'delete_task',
      title: 'Delete Plan Task(s)',
      description: 'Delete one or multiple tasks by id or ids array.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          ids: { type: 'array', items: { type: 'string' } },
        },
      },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
    {
      name: 'batch_update_tasks',
      title: 'Batch Update Tasks',
      description: 'Batch update status, priority, shift dates, carry over overdue tasks, or add alert to selected tasks.',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['set_status', 'set_priority', 'shift_days', 'move_to_next_week', 'add_alert'] },
          ids: { type: 'array', items: { type: 'string' } },
          status: { type: 'string' },
          priority: { type: 'string' },
          days: { type: 'number' },
          alert: { type: 'object' },
        },
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    {
      name: 'manage_alert',
      title: 'Manage Alerts & Rules',
      description: 'Snooze or dismiss firing alerts, or create/update/delete automated alert rules.',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['snooze', 'dismiss', 'reset', 'upsert_rule', 'delete_rule', 'toggle_rule'] },
          alertId: { type: 'string' },
          taskId: { type: 'string' },
          minutes: { type: 'number' },
          rule: { type: 'object' },
          ruleId: { type: 'string' },
        },
      },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
    {
      name: 'manage_okr',
      title: 'Manage OKR Goals',
      description: 'Create, update, or delete weekly/monthly OKR objectives.',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['upsert', 'delete'] },
          okr: { type: 'object' },
          id: { type: 'string' },
        },
      },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
    {
      name: 'apply_template',
      title: 'Apply Amazon Ops Template',
      description: 'Instantiate a standard Amazon operations SOP template into calendar & weekly plans.',
      inputSchema: {
        type: 'object',
        required: ['templateId'],
        properties: {
          templateId: { type: 'string' },
          startDate: { type: 'string' },
          marketplace: { type: 'string' },
        },
      },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
    {
      name: 'save_settings_or_data',
      title: 'Save Planner Settings / Pomodoro / Import',
      description: 'Save planner preferences, log completed pomodoro session, or import JSON backup.',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['save_settings', 'log_pomodoro', 'import_json', 'reset_demo'] },
          settings: { type: 'object' },
          pomodoro: { type: 'object' },
          payload: { type: 'object' },
        },
      },
      _meta: { ui: { visibility: ['app'] } },
    },
  ],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: APP_URI,
      name: '亚马逊运营计划看板 UI',
      description: 'Amazon Operations Calendar, Weekly Planner, Kanban, Gantt & Alert Hub',
      mimeType: 'text/html;profile=mcp-app',
      _meta: { ui: { prefersBorder: false } },
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri !== APP_URI) throw new Error(`Unknown resource URI: ${req.params.uri}`);
  if (!fs.existsSync(APP_HTML_PATH)) throw new Error(`Built UI file missing: ${APP_HTML_PATH}`);
  const html = fs.readFileSync(APP_HTML_PATH, 'utf8');
  return {
    contents: [{ uri: APP_URI, mimeType: 'text/html;profile=mcp-app', text: html, _meta: { ui: { prefersBorder: false } } }],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const store = loadStore();

  if (name === 'open_planner' || name === 'get_planner_state') {
    const payload = buildPayload(store, {
      initialView: args.view || 'weekly',
      initialDate: args.date || todayStr(),
      initialSearch: args.search || '',
    });
    const s = payload.summary;
    const text =
      `亚马逊运营计划看板已加载 (${payload.refreshedAt})：\n` +
      `- 全部计划：${s.totalTasks} 项（已完成 ${s.doneCount}，待办 ${s.openCount}）\n` +
      `- 本周计划：${s.weekDone}/${s.weekTotal} 完成 | 今日待办：${s.todayCount} 项\n` +
      `- 实时警报：🔴 触发中 ${s.firingAlerts} 条（其中逾期 ${s.overdueCount} 项），🟠 24h即将触发 ${s.upcomingAlerts} 条`;
    return { content: [{ type: 'text', text }], structuredContent: payload };
  }

  if (name === 'upsert_task') {
    const raw = args.task || {};
    const now = nowIsoLocal();
    const today = todayStr();
    const id = raw.id || genId('t');
    const idx = store.tasks.findIndex(x => x.id === id);
    const existing = idx >= 0 ? store.tasks[idx] : {};

    const task = {
      id,
      title: String(raw.title ?? existing.title ?? '未命名运营计划').trim() || '未命名运营计划',
      description: String(raw.description ?? existing.description ?? ''),
      module: raw.module ?? existing.module ?? '广告投放',
      marketplace: raw.marketplace ?? existing.marketplace ?? 'US',
      asin: String(raw.asin ?? existing.asin ?? ''),
      campaign: String(raw.campaign ?? existing.campaign ?? ''),
      priority: raw.priority ?? existing.priority ?? 'P1',
      status: raw.status ?? existing.status ?? 'todo',
      startDate: raw.startDate ?? existing.startDate ?? raw.dueDate ?? existing.dueDate ?? today,
      dueDate: raw.dueDate ?? existing.dueDate ?? today,
      dueTime: raw.dueTime ?? existing.dueTime ?? '18:00',
      pstTime: String(raw.pstTime ?? existing.pstTime ?? ''),
      estimatedHours: Number(raw.estimatedHours ?? existing.estimatedHours ?? 1),
      actualMinutes: Number(raw.actualMinutes ?? existing.actualMinutes ?? 0),
      progress: raw.status === 'done' ? 100 : Number(raw.progress ?? existing.progress ?? 0),
      recurrence: raw.recurrence ?? existing.recurrence ?? 'none',
      isMilestone: Boolean(raw.isMilestone ?? existing.isMilestone ?? false),
      okrId: raw.okrId ?? existing.okrId ?? '',
      tags: Array.isArray(raw.tags) ? raw.tags : (existing.tags || []),
      subtasks: Array.isArray(raw.subtasks) ? raw.subtasks : (existing.subtasks || []),
      alerts: Array.isArray(raw.alerts) ? raw.alerts : (existing.alerts || []),
      _parentRecurrenceId: raw._parentRecurrenceId ?? existing._parentRecurrenceId ?? null,
      _overdueSnoozeUntil: raw._overdueSnoozeUntil !== undefined ? raw._overdueSnoozeUntil : (existing._overdueSnoozeUntil || null),
      _overdueDismissed: raw._overdueDismissed !== undefined ? raw._overdueDismissed : (existing._overdueDismissed || false),
      createdAt: existing.createdAt || now,
      updatedAt: now,
    };

    // Handle recurring task next-occurrence spawn when marked done
    if (idx >= 0 && existing.status !== 'done' && task.status === 'done' && task.recurrence && task.recurrence !== 'none') {
      const stepDays = task.recurrence === 'daily' ? 1 : task.recurrence === 'weekly' ? 7 : task.recurrence === 'biweekly' ? 14 : 30;
      const nextStart = addDays(task.startDate, stepDays);
      const nextDue = addDays(task.dueDate, stepDays);
      store.tasks.push({
        ...task,
        id: genId('t'),
        status: 'todo',
        progress: 0,
        actualMinutes: 0,
        startDate: nextStart,
        dueDate: nextDue,
        subtasks: (task.subtasks || []).map(s => ({ ...s, id: genId('st'), done: false })),
        alerts: (task.alerts || []).map(a => ({ ...a, id: genId('al'), snoozedUntil: null, dismissedAt: null })),
        _overdueSnoozeUntil: null,
        _overdueDismissed: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (idx >= 0) store.tasks[idx] = task;
    else store.tasks.unshift(task);
    saveStore(store);
    return {
      content: [{ type: 'text', text: `已${idx >= 0 ? '更新' : '新建'}运营计划：${task.title}（截止 ${task.dueDate} ${task.dueTime}）` }],
      structuredContent: buildPayload(store),
    };
  }

  if (name === 'delete_task') {
    const idSet = new Set([...(args.ids || []), ...(args.id ? [args.id] : [])]);
    const before = store.tasks.length;
    store.tasks = store.tasks.filter(t => !idSet.has(t.id));
    saveStore(store);
    return {
      content: [{ type: 'text', text: `已删除 ${before - store.tasks.length} 项计划` }],
      structuredContent: buildPayload(store),
    };
  }

  if (name === 'batch_update_tasks') {
    const idSet = new Set(args.ids || []);
    const now = nowIsoLocal();
    for (const t of store.tasks) {
      if (!idSet.has(t.id)) continue;
      if (args.action === 'set_status' && args.status) {
        t.status = args.status;
        if (args.status === 'done') t.progress = 100;
      } else if (args.action === 'set_priority' && args.priority) {
        t.priority = args.priority;
      } else if (args.action === 'shift_days' && Number.isFinite(args.days)) {
        t.startDate = addDays(t.startDate, args.days);
        t.dueDate = addDays(t.dueDate, args.days);
        t._overdueSnoozeUntil = null;
        t._overdueDismissed = false;
      } else if (args.action === 'move_to_next_week') {
        t.startDate = addDays(t.startDate, 7);
        t.dueDate = addDays(t.dueDate, 7);
        t._overdueSnoozeUntil = null;
        t._overdueDismissed = false;
      } else if (args.action === 'add_alert' && args.alert) {
        t.alerts = [...(t.alerts || []), { id: genId('al'), snoozedUntil: null, dismissedAt: null, ...args.alert }];
      }
      t.updatedAt = now;
    }
    saveStore(store);
    return {
      content: [{ type: 'text', text: `已批量更新 ${idSet.size} 项计划 (${args.action})` }],
      structuredContent: buildPayload(store),
    };
  }

  if (name === 'manage_alert') {
    const { action, alertId, taskId, minutes = 60, rule, ruleId } = args;
    if (action === 'snooze' || action === 'dismiss' || action === 'reset') {
      const snoozeIso = new Date(Date.now() + Number(minutes) * 60000).toISOString();
      for (const t of store.tasks) {
        if (taskId && t.id !== taskId) continue;
        if (alertId === `auto_overdue_${t.id}`) {
          if (action === 'snooze') t._overdueSnoozeUntil = snoozeIso;
          if (action === 'dismiss') t._overdueDismissed = true;
          if (action === 'reset') { t._overdueSnoozeUntil = null; t._overdueDismissed = false; }
        }
        for (const al of t.alerts || []) {
          if (al.id === alertId) {
            if (action === 'snooze') al.snoozedUntil = snoozeIso;
            if (action === 'dismiss') al.dismissedAt = nowIsoLocal();
            if (action === 'reset') { al.snoozedUntil = null; al.dismissedAt = null; }
          }
        }
      }
    } else if (action === 'upsert_rule' && rule) {
      const id = rule.id || genId('rule');
      const idx = store.alertRules.findIndex(r => r.id === id);
      const nextRule = { enabled: true, sound: true, level: 'warning', ...rule, id };
      if (idx >= 0) store.alertRules[idx] = nextRule;
      else store.alertRules.unshift(nextRule);
    } else if (action === 'delete_rule' && ruleId) {
      store.alertRules = store.alertRules.filter(r => r.id !== ruleId);
    } else if (action === 'toggle_rule' && ruleId) {
      const r = store.alertRules.find(x => x.id === ruleId);
      if (r) r.enabled = !r.enabled;
    }
    saveStore(store);
    return {
      content: [{ type: 'text', text: `已执行警报操作：${action}` }],
      structuredContent: buildPayload(store),
    };
  }

  if (name === 'manage_okr') {
    if (args.action === 'upsert' && args.okr) {
      const id = args.okr.id || genId('okr');
      const idx = store.okrs.findIndex(o => o.id === id);
      const obj = { targetValue: 100, currentValue: 0, unit: '%', keyResults: [], ...args.okr, id };
      if (idx >= 0) store.okrs[idx] = obj;
      else store.okrs.unshift(obj);
    } else if (args.action === 'delete' && args.id) {
      store.okrs = store.okrs.filter(o => o.id !== args.id);
    }
    saveStore(store);
    return {
      content: [{ type: 'text', text: `已更新运营 OKR 目标` }],
      structuredContent: buildPayload(store),
    };
  }

  if (name === 'apply_template') {
    const tpl = AMZ_TEMPLATES.find(t => t.id === args.templateId);
    if (!tpl) throw new Error(`Unknown template: ${args.templateId}`);
    const baseDate = args.startDate || todayStr();
    const mp = args.marketplace || store.settings?.activeStore || 'US';
    const now = nowIsoLocal();
    const created = tpl.items.map(it => {
      const sDate = addDays(baseDate, it.offsetStart || 0);
      const dDate = addDays(baseDate, it.offsetDue ?? it.offsetStart ?? 0);
      return {
        id: genId('t'),
        title: it.title,
        description: it.desc || '',
        module: it.module || '常规运营',
        marketplace: mp,
        asin: '',
        campaign: '',
        priority: it.priority || 'P1',
        status: 'todo',
        startDate: sDate,
        dueDate: dDate,
        dueTime: it.dueTime || '18:00',
        estimatedHours: 1.5,
        actualMinutes: 0,
        progress: 0,
        recurrence: 'none',
        isMilestone: Boolean(it.isMilestone),
        okrId: '',
        tags: it.tags || [tpl.category],
        subtasks: (it.subtasks || []).map(txt => ({ id: genId('st'), text: txt, done: false })),
        alerts: it.alertBeforeMin ? [{
          id: genId('al'),
          triggerType: 'before_due',
          offsetMinutes: it.alertBeforeMin,
          level: it.priority === 'P0' ? 'critical' : 'warning',
          label: `模板警报：提前${it.alertBeforeMin >= 60 ? (it.alertBeforeMin / 60) + '小时' : it.alertBeforeMin + '分钟'}`,
          sound: true,
          snoozedUntil: null,
          dismissedAt: null,
        }] : [],
        createdAt: now,
        updatedAt: now,
      };
    });
    store.tasks.unshift(...created);
    saveStore(store);
    return {
      content: [{ type: 'text', text: `已套用模板「${tpl.name}」，生成 ${created.length} 个带警报的运营计划（起始日 ${baseDate}）` }],
      structuredContent: buildPayload(store),
    };
  }

  if (name === 'save_settings_or_data') {
    if (args.action === 'save_settings' && args.settings) {
      store.settings = { ...store.settings, ...args.settings };
    } else if (args.action === 'log_pomodoro' && args.pomodoro) {
      const entry = { id: genId('pom'), at: nowIsoLocal(), ...args.pomodoro };
      store.pomodoroLogs.unshift(entry);
      if (entry.taskId) {
        const t = store.tasks.find(x => x.id === entry.taskId);
        if (t) {
          t.actualMinutes = (t.actualMinutes || 0) + Number(entry.minutes || 25);
          t.updatedAt = nowIsoLocal();
        }
      }
    } else if (args.action === 'import_json' && args.payload) {
      if (Array.isArray(args.payload.tasks)) store.tasks = args.payload.tasks;
      if (Array.isArray(args.payload.okrs)) store.okrs = args.payload.okrs;
      if (Array.isArray(args.payload.alertRules)) store.alertRules = args.payload.alertRules;
      if (args.payload.settings) store.settings = { ...store.settings, ...args.payload.settings };
    } else if (args.action === 'reset_demo') {
      const fresh = createSeedData();
      saveStore(fresh);
      return { content: [{ type: 'text', text: '已重置为默认示例数据' }], structuredContent: buildPayload(fresh) };
    }
    saveStore(store);
    return {
      content: [{ type: 'text', text: `已保存 (${args.action})` }],
      structuredContent: buildPayload(store),
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
