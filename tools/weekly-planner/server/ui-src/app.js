import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import {
  renderGroupedBarChart,
  renderAcosBarChart,
  renderHorizontalBarChart,
  renderPlacementVisualCards,
} from './charts.js';

const app = new App({ name: 'UPBestKS 广告优化', version: '1.2.0' }, {});
let state = null;
let activeTab = 'overview';
let campFilter = 'ALL';
let campSearch = '';
let autoFilter = 'ALL';
let autoSearch = '';
let logFilter = 'ALL';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const usd = (v) => `$${Number(v || 0).toFixed(2)}`;
const pct = (v) => `${(Number(v || 0) * 100).toFixed(1)}%`;
const acosBadge = (a) => a >= 0.60 ? 'b-red' : (a > 0.452 ? 'b-amber' : 'b-green');

function render() {
  const root = document.getElementById('root');
  if (!state) return;
  const { summary, placementSummary, daily, portfolios, campaigns, autoTypes, autoRows, checklist, optLog, refreshedAt, excelSyncMsg } = state;
  const doneCnt = checklist.filter(x => x.done).length;
  const pendingOpt = optLog.filter(x => x.status === '待执行' || x.status === '已执行待复盘').length;
  const fmtPlCell = (p) => p && (p.spend > 0 || p.imp > 0) ? `<div style="font-weight:600">${usd(p.spend)} / ${p.ord}单</div><div style="margin-top:2px"><span class="badge ${p.sales ? acosBadge(p.acos) : 'b-red'}">${p.sales ? pct(p.acos) : '0单'}</span> <span style="color:var(--text-sub);font-size:10px">CPC ${usd(p.cpc)}</span></div>` : '<span style="color:var(--text-sub)">-</span>';

  let body = '';
  if (activeTab === 'overview') {
    const s14 = summary.d14, sPre = summary.pre7, s7 = summary.d7, s24 = summary.day24;

    // 15 日每日花费 vs 销售额柱状对比图
    const dailyCats = daily.map(d => d.date.slice(5));
    const dailySpend = daily.map(d => d.spend);
    const dailySales = daily.map(d => d.sales);
    const spendSalesChart = renderGroupedBarChart({
      title: '15 日每日花费 vs 广告销售额对比 (11/10–11/24)',
      subtitle: '观察点：11/19~11/21 放量冲高，11/24 调价首日花费压至 $88.89，销售产出 $206.45',
      categories: dailyCats,
      series: [
        { name: '广告花费 ($)', color: '#3b82f6', data: dailySpend },
        { name: '广告销售额 ($)', color: '#10b981', data: dailySales }
      ],
      unit: '$',
      height: 220,
      rotateX: false
    });

    // 15 日每日 ACoS 彩色柱状图 (带45.2%目标线与60%警戒线)
    const dailyAcos = daily.map(d => d.acos);
    const acosChart = renderAcosBarChart({
      title: '15 日每日 ACoS 趋势图 (45.2% 目标基准线 & 60% 警戒线)',
      subtitle: '绿色≤45.2%达标 | 黄色45.2%~60%观察 | 红色>60%失控 | 11/24 调价首日 ACoS 强势压降至 43.1%！',
      categories: dailyCats,
      acosValues: dailyAcos,
      targetVal: 0.452,
      warnVal: 0.60,
      height: 220
    });

    body = `
      <div class="diag-banner">
        <div class="diag-icon">🎯</div>
        <div>
          <b>AI 核心经营诊断与拐点洞察：</b>近 7 天全店平均 CPC 从前期 <b>${usd(sPre.cpc)}</b> 持续受控压降至 <b>${usd(s7.cpc)}</b>（11/24 调价首日仅 <b>${usd(s24.cpc)}</b>，单日 ACoS 强势回落至 <b>${pct(s24.acos)}</b> 击穿目标线！）。7d ACoS 阶段性上升主因黑五前观望期全店 CVR 跌至 <b>${pct(s7.cvr)}</b>，且 4 大未调出血组吞掉 <b>$345.23 (27.3%)</b> 花费。
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card" style="--accent-bar: #6366f1">
          <div class="kpi-top">
            <span class="kpi-label">14天全周期大盘</span>
            <span class="kpi-period">11/10–11/24</span>
          </div>
          <div class="kpi-val-row">
            <span class="kpi-val">${usd(s14.spend)}</span>
            <span class="badge ${acosBadge(s14.acos)}">${pct(s14.acos)} ACoS</span>
          </div>
          <div class="kpi-badges">
            <span class="kpi-tag">${s14.ord} 总单 (他品 ${pct(s14.othPct)})</span>
            <span class="kpi-tag">CPC ${usd(s14.cpc)}</span>
            <span class="kpi-tag">CVR ${pct(s14.cvr)}</span>
            <span class="kpi-tag">ROAS ${s14.roas.toFixed(2)}</span>
          </div>
        </div>

        <div class="kpi-card" style="--accent-bar: #f43f5e">
          <div class="kpi-top">
            <span class="kpi-label">近7天周期</span>
            <span class="kpi-period">11/18–11/24</span>
          </div>
          <div class="kpi-val-row">
            <span class="kpi-val">${usd(s7.spend)}</span>
            <span class="badge ${acosBadge(s7.acos)}">${pct(s7.acos)} ACoS</span>
          </div>
          <div class="kpi-badges">
            <span class="kpi-tag">${s7.ord} 总单 (他品 ${pct(s7.othPct)})</span>
            <span class="kpi-tag">CPC ${usd(s7.cpc)}</span>
            <span class="kpi-tag">CVR ${pct(s7.cvr)}</span>
            <span class="kpi-tag">ROAS ${s7.roas.toFixed(2)}</span>
          </div>
        </div>

        <div class="kpi-card" style="--accent-bar: #3b82f6">
          <div class="kpi-top">
            <span class="kpi-label">前期基线</span>
            <span class="kpi-period">11/10–11/17</span>
          </div>
          <div class="kpi-val-row">
            <span class="kpi-val">${usd(sPre.spend)}</span>
            <span class="badge ${acosBadge(sPre.acos)}">${pct(sPre.acos)} ACoS</span>
          </div>
          <div class="kpi-badges">
            <span class="kpi-tag">${sPre.ord} 总单</span>
            <span class="kpi-tag">CPC ${usd(sPre.cpc)}</span>
            <span class="kpi-tag">CVR ${pct(sPre.cvr)}</span>
            <span class="kpi-tag">ROAS ${sPre.roas.toFixed(2)}</span>
          </div>
        </div>

        <div class="kpi-card" style="--accent-bar: #10b981">
          <div class="kpi-top">
            <span class="kpi-label">11/24 调价首日单日</span>
            <span class="kpi-period">验证拐点</span>
          </div>
          <div class="kpi-val-row">
            <span class="kpi-val">${usd(s24.spend)}</span>
            <span class="badge b-green">${pct(s24.acos)} 达标</span>
          </div>
          <div class="kpi-badges">
            <span class="kpi-tag">${s24.ord} 单</span>
            <span class="kpi-tag">CPC ${usd(s24.cpc)} (低位)</span>
            <span class="kpi-tag">ROAS ${s24.roas.toFixed(2)}x</span>
          </div>
        </div>
      </div>

      <!-- 可视化柱状图双列并排展示 -->
      <div class="chart-grid">
        ${spendSalesChart}
        ${acosChart}
      </div>

      <div class="card">
        <div class="card-hdr">
          <div>
            <h2 class="card-title">15 日每日大盘明细 (11/10–11/24)</h2>
            <div class="card-sub">每日曝光量、点击量、花费、CPC、订单(本品/他品)、转化率、销售额与 ACoS</div>
          </div>
        </div>
        <div class="scroll-tbl"><table>
          <thead><tr><th>日期</th><th>曝光</th><th>点击</th><th>花费</th><th>CPC</th><th>订单 (本/他)</th><th>CVR</th><th>销售额</th><th>ACoS</th></tr></thead>
          <tbody>${daily.slice().reverse().map(d => `
            <tr>
              <td><b>${esc(d.date.slice(5))}</b></td>
              <td>${d.imp.toLocaleString()}</td>
              <td>${d.clk.toLocaleString()}</td>
              <td style="font-weight:600">${usd(d.spend)}</td>
              <td>${usd(d.cpc)}</td>
              <td><b>${d.ord}</b> <span style="color:var(--text-sub);font-size:10.5px">(${d.selfOrd}/${d.othOrd})</span></td>
              <td>${pct(d.cvr)}</td>
              <td>${usd(d.sales)}</td>
              <td><span class="badge ${acosBadge(d.acos)}">${pct(d.acos)}</span></td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </div>
    `;
  } else if (activeTab === 'placements') {
    const p14Map = Object.fromEntries((placementSummary?.d14?.items || []).map(x => [x.pl, x]));
    const pW1Map = Object.fromEntries((placementSummary?.w1?.items || []).map(x => [x.pl, x]));
    const p7Items = placementSummary?.d7?.items || [];
    const p7Map = Object.fromEntries(p7Items.map(x => [x.pl, x]));
    const filtered = campaigns.filter(c => {
      if (campFilter !== 'ALL' && !c.prio.includes(campFilter)) return false;
      if (campSearch && !c.name.toLowerCase().includes(campSearch.toLowerCase()) && !c.portfolio.toLowerCase().includes(campSearch.toLowerCase())) return false;
      return true;
    });

    const plCats = ['TOS 首页', 'ROS 其余位置', 'PP 商品详情'];
    const plSpend14 = [p14Map['搜索结果顶部（首页）']?.spend || 0, p14Map['搜索结果其余位置']?.spend || 0, p14Map['商品详情页']?.spend || 0];
    const plSpend7 = [p7Map['搜索结果顶部（首页）']?.spend || 0, p7Map['搜索结果其余位置']?.spend || 0, p7Map['商品详情页']?.spend || 0];
    const plSpendChart = renderGroupedBarChart({
      title: '3 大广告位 14天全周期 vs 近7天 花费柱状对比',
      subtitle: 'ROS 其余位置吞掉 60.0% ($758.39) 广告费；TOS 仅占 24.6% ($311.23)；PP 占 15.3% ($193.75)',
      categories: plCats,
      series: [
        { name: '14天花费 ($)', color: '#64748b', data: plSpend14 },
        { name: '近7天花费 ($)', color: '#3b82f6', data: plSpend7 }
      ],
      unit: '$',
      height: 220,
      showValOnTop: true
    });

    const plAcos7 = [(p7Map['搜索结果顶部（首页）']?.acos || 0) * 100, (p7Map['搜索结果其余位置']?.acos || 0) * 100, (p7Map['商品详情页']?.acos || 0) * 100];
    const plCvr7 = [(p7Map['搜索结果顶部（首页）']?.cvr || 0) * 100, (p7Map['搜索结果其余位置']?.cvr || 0) * 100, (p7Map['商品详情页']?.cvr || 0) * 100];
    const plEffChart = renderGroupedBarChart({
      title: '3 大广告位 近7天 CVR(转化率) vs ACoS(投产比) 效率对比',
      subtitle: 'TOS 转化率最高 (15.8%) 且 ACoS 相对稳健；ROS 转化率仅 9.5% 导致 ACoS 63.6%；PP ACoS 73.0% 最差',
      categories: plCats,
      series: [
        { name: '近7天 CVR (%)', color: '#10b981', data: plCvr7 },
        { name: '近7天 ACoS (%)', color: '#f59e0b', data: plAcos7 }
      ],
      unit: '%',
      valFmt: (v) => `${Number(v).toFixed(1)}%`,
      height: 220,
      showValOnTop: true
    });

    body = `
      <div class="diag-banner">
        <div class="diag-icon">🎯</div>
        <div>
          <b>位置分流真相：</b>近 7 天 <b>ROS 其余位置</b> 吞掉 <b>60.0% ($758.39)</b> 花费但 ACoS 高达 <b>63.6%</b>；<b>TOS 首页</b> 转化率高居 <b>15.8% (14d 18.3%)</b> 且他品互抢最低 (42.1%)！因此调价必须严格遵循「<b>降基础 Bid + 反向补偿健康位置溢价</b>」，严防误砍优质位置流量。
        </div>
      </div>

      <!-- 3 大广告位高质感微型进度诊断卡片 -->
      ${renderPlacementVisualCards(placementSummary?.d14?.items || [], p7Items)}

      <!-- 3 大广告位花费与效率可视化柱状图组 -->
      <div class="chart-grid">
        ${plSpendChart}
        ${plEffChart}
      </div>

      <div class="card">
        <div class="card-hdr">
          <div>
            <h2 class="card-title">全店 3 大广告位 14天(W1→W2) vs 近7天 对比明细</h2>
            <div class="card-sub">各位置花费占比、前后周期 ACoS 演进及 CPC/CVR</div>
          </div>
        </div>
        <table>
          <thead><tr><th>广告位</th><th>近7d占比</th><th>14d花/单/ACoS</th><th>前7d ACoS</th><th>近7d花费/单</th><th>近7d CPC/CVR</th><th>近7d ACoS</th></tr></thead>
          <tbody>${p7Items.map(it => {
            const p14 = p14Map[it.pl] || {};
            const pw1 = pW1Map[it.pl] || {};
            return `<tr>
              <td><b>${esc(it.short)}</b></td>
              <td>${pct(it.spendShare)}</td>
              <td>${usd(p14.spend)} / ${p14.ord||0} / ${p14.sales?pct(p14.acos):'-'}</td>
              <td>${pw1.sales ? pct(pw1.acos) : '-'}</td>
              <td>${usd(it.spend)} / ${it.ord}单</td>
              <td>${usd(it.cpc)} / ${pct(it.cvr)}</td>
              <td><span class="badge ${it.sales?acosBadge(it.acos):'b-red'}">${it.sales?pct(it.acos):'0单'}</span></td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-hdr">
          <div>
            <h2 class="card-title">全量 ${filtered.length} 个活动「位置 7d/14d × 双向卡点」处方</h2>
            <div class="card-sub">包含基础 Bid 微调建议、溢价调整及各位置 7 天真实表现</div>
          </div>
        </div>
        <div class="toolbar">
          <input id="campSearchInput" placeholder="搜索广告活动..." value="${esc(campSearch)}" style="flex:1;min-width:140px" />
          <select id="campFilterSel">
            <option value="ALL" ${campFilter==='ALL'?'selected':''}>全部活动 (${campaigns.length})</option>
            <option value="P0-温和卡点" ${campFilter==='P0-温和卡点'?'selected':''}>P0-温和卡点</option>
            <option value="P0-风控" ${campFilter==='P0-风控'?'selected':''}>P0-风控</option>
            <option value="P1-温和" ${campFilter==='P1-温和'?'selected':''}>P1-温和</option>
            <option value="明星位置扩量" ${campFilter==='明星位置扩量'?'selected':''}>明星位置扩量</option>
            <option value="v4观察" ${campFilter==='v4观察'?'selected':''}>11/24 v4观察</option>
          </select>
        </div>
        <div class="scroll-tbl"><table>
          <thead><tr><th>优先级 / 活动</th><th>现Bid→新Bid</th><th>现溢价→新溢价</th><th>TOS 首页 (7d)</th><th>ROS 其余 (7d)</th><th>PP 详情 (7d)</th><th>位置卡点依据</th></tr></thead>
          <tbody>${filtered.map(c => `
            <tr>
              <td style="text-align:left"><span class="badge ${c.prio.startsWith('P0')?'b-red':c.prio.includes('明星')?'b-green':c.prio.startsWith('P1')||c.prio==='v4观察'?'b-amber':'b-gray'}">${esc(c.prio)}</span><br/><b style="display:inline-block;margin-top:3px">${esc(c.name)}</b></td>
              <td>${c.bid?usd(c.bid):'-'} → <b style="color:var(--indigo)">${esc(c.newBid)}</b></td>
              <td>${c.tos}/${c.ros}/${c.pp}% → <b>${esc(c.newMod)}</b></td>
              <td>${fmtPlCell(c.pl?.tos7)}</td>
              <td>${fmtPlCell(c.pl?.ros7)}</td>
              <td>${fmtPlCell(c.pl?.pp7)}</td>
              <td style="text-align:left;min-width:160px;font-size:11.5px;color:var(--text-muted)">${esc(c.act)}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </div>
    `;
  } else if (activeTab === 'portfolios') {
    const top10P = portfolios.slice(0, 10);
    const pCats = top10P.map(p => p.name.replace('UP-US-', '').slice(0, 14));
    const pSpend14 = top10P.map(p => p.a14.spend);
    const pSpend7 = top10P.map(p => p.a7.spend);
    const pfSpendChart = renderGroupedBarChart({
      title: 'Top 10 广告组合 14天全期 vs 近7天 花费柱状对比',
      subtitle: '前4大出血组合（S24U-Deep Purple, S25Edge-DP, Moto/G-DP, A17-DP）吞掉 $345.23 (27.3%) 花费',
      categories: pCats,
      series: [
        { name: '14天花费 ($)', color: '#64748b', data: pSpend14 },
        { name: '近7天花费 ($)', color: '#3b82f6', data: pSpend7 }
      ],
      unit: '$',
      height: 230,
      rotateX: true
    });

    const sortedByAcos = [...portfolios].sort((a, b) => a.a7.acos - b.a7.acos);
    const pfRankChart = renderHorizontalBarChart({
      title: '全量 15 个广告组合 近7天 ACoS 横向排名 (45.2% 目标基准)',
      subtitle: '按 7d ACoS 从优到劣排序 | 绿色达标 (≤45.2%) | 黄色偏高 | 红色严重超标 (>60%)',
      items: sortedByAcos.map(p => ({
        label: p.name.replace('UP-US-', ''),
        value: p.a7.acos,
        deltaText: `${p.diffPp >= 0 ? '+' : ''}${p.diffPp.toFixed(1)}pp`,
        sublabel: `${usd(p.a7.spend)} / ${p.a7.ord}单`
      })),
      targetVal: 0.452,
      maxVal: 1.05
    });

    const sortedByOth = [...portfolios].sort((a, b) => b.a7.othPct - a.a7.othPct);
    const pfOthChart = renderHorizontalBarChart({
      title: '全量 15 个广告组合 他品他款互抢订单占比 (Cannibalization Rate)',
      subtitle: '他品率 >45% 说明关键词匹配发生泛化漂移，需重点压制出价或做精准卡位',
      items: sortedByOth.map(p => ({
        label: p.name.replace('UP-US-', ''),
        value: p.a7.othPct,
        deltaText: `${p.a7.othOrd}他 / ${p.a7.ord}总单`,
        color: p.a7.othPct > 0.45 ? '#f59e0b' : '#3b82f6'
      })),
      targetVal: 0.30,
      maxVal: 0.80
    });

    body = `
      ${pfSpendChart}

      <div class="chart-grid">
        ${pfRankChart}
        ${pfOthChart}
      </div>

      <div class="card">
        <div class="card-hdr">
          <div>
            <h2 class="card-title">全量 15 个广告组合 7天 vs 14天 对比明细</h2>
            <div class="card-sub">花费、单量(他品占比)、CPC、转化率、ACoS 及周期健康状态评估</div>
          </div>
        </div>
        <div class="scroll-tbl"><table>
          <thead><tr><th>广告组合</th><th>14d花费/单/ACoS</th><th>7d花费</th><th>7d单 (他品%)</th><th>7d CPC</th><th>7d CVR</th><th>7d ACoS</th><th>变化</th><th>健康状态</th></tr></thead>
          <tbody>${portfolios.map(p => `
            <tr>
              <td><b>${esc(p.name)}</b></td>
              <td>${usd(p.a14.spend)} / ${p.a14.ord} / ${pct(p.a14.acos)}</td>
              <td style="font-weight:600">${usd(p.a7.spend)}</td>
              <td>${p.a7.ord} <span style="color:var(--text-sub);font-size:10px">(${pct(p.a7.othPct)})</span></td>
              <td>${usd(p.a7.cpc)}</td>
              <td>${pct(p.a7.cvr)}</td>
              <td><span class="badge ${acosBadge(p.a7.acos)}">${pct(p.a7.acos)}</span></td>
              <td style="font-weight:700;color:${p.diffPp > 0 ? '#f43f5e' : '#10b981'}">${p.diffPp >= 0 ? '+' : ''}${p.diffPp.toFixed(1)}pp</td>
              <td><span class="badge ${p.status === '严重恶化' ? 'b-red' : (p.status === '明星盈利' || p.status === '明显改善' ? 'b-green' : 'b-amber')}">${esc(p.status)}</span></td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </div>
    `;
  } else if (activeTab === 'campaigns') {
    const filtered = campaigns.filter(c => {
      if (campFilter !== 'ALL' && !c.prio.includes(campFilter)) return false;
      if (campSearch && !c.name.toLowerCase().includes(campSearch.toLowerCase()) && !c.portfolio.toLowerCase().includes(campSearch.toLowerCase())) return false;
      return true;
    });
    body = `
      <div class="card">
        <div class="card-hdr">
          <div>
            <h2 class="card-title">全量 ${campaigns.length} 个活动 7d/14d 数据与调价处方</h2>
            <div class="card-sub">包含各活动当前溢价、近7天花费、订单、ACoS、基础出价与分时当前出价</div>
          </div>
        </div>
        <div class="toolbar">
          <input id="campSearchInput" placeholder="搜索活动或组合名称..." value="${esc(campSearch)}" style="flex:1;min-width:140px" />
          <select id="campFilterSel">
            <option value="ALL" ${campFilter==='ALL'?'selected':''}>全部活动 (${campaigns.length})</option>
            <option value="P0-卡点止血" ${campFilter==='P0-卡点止血'?'selected':''}>P0-卡点止血</option>
            <option value="P0-风控" ${campFilter==='P0-风控'?'selected':''}>P0-风控</option>
            <option value="P1-卡点" ${campFilter==='P1-卡点'?'selected':''}>P1-卡点</option>
            <option value="明星位置扩量" ${campFilter==='明星位置扩量'?'selected':''}>明星位置扩量</option>
            <option value="v4观察" ${campFilter==='v4观察'?'selected':''}>11/24 v4观察期</option>
            <option value="明星盈利" ${campFilter==='明星盈利'?'selected':''}>明星盈利</option>
          </select>
        </div>
        <div class="scroll-tbl"><table>
          <thead><tr><th>优先级</th><th>广告活动 / 组合</th><th>溢价(首/余/详)</th><th>14d花费/ACoS</th><th>7d花费/单</th><th>7d ACoS</th><th>closeMatch Bid→Live</th><th>处方建议</th></tr></thead>
          <tbody>${filtered.map(c => `
            <tr>
              <td><span class="badge ${c.prio.startsWith('P0')?'b-red':c.prio==='明星盈利'?'b-green':c.prio==='v4观察'?'b-amber':'b-gray'}">${esc(c.prio)}</span></td>
              <td style="text-align:left"><b>${esc(c.name)}</b><br/><span style="color:var(--text-sub);font-size:10.5px">${esc(c.portfolio)}</span></td>
              <td>${c.tos}%/${c.ros}%/${c.pp}%</td>
              <td>${usd(c.a14.spend)} / ${pct(c.a14.acos)}</td>
              <td><b>${usd(c.a7.spend)}</b> / ${c.a7.ord}单</td>
              <td><span class="badge ${acosBadge(c.a7.acos)}">${c.a7.sales?pct(c.a7.acos):'0单'}</span></td>
              <td>${c.bid?`${usd(c.bid)}→<b style="color:var(--indigo)">${usd(c.live)}</b>`:'-'}</td>
              <td style="text-align:left;min-width:170px;font-size:11.5px;color:var(--text-muted)">${esc(c.act)}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </div>
    `;
  } else if (activeTab === 'auto') {
    const filtered = autoRows.filter(r => {
      if (autoFilter !== 'ALL' && r.type !== autoFilter) return false;
      if (autoSearch && !r.campaign.toLowerCase().includes(autoSearch.toLowerCase())) return false;
      return true;
    });

    const autoCats = autoTypes.map(t => t.type);
    const autoSpend = autoTypes.map(t => t.spend);
    const autoSales = autoTypes.map(t => t.sales);
    const autoSpendChart = renderGroupedBarChart({
      title: '4 种自动定向 近7天 花费 vs 销售额 柱状对比',
      subtitle: 'closeMatch 产出 95.2% 销售；substitutes ($24.89) 和 complements ($2.26) 7天 0单严重漏水',
      categories: autoCats,
      series: [
        { name: '近7天花费 ($)', color: '#f43f5e', data: autoSpend },
        { name: '近7天销售额 ($)', color: '#10b981', data: autoSales }
      ],
      unit: '$',
      height: 220,
      showValOnTop: true
    });

    const autoBase = autoTypes.map(t => t.avgBid);
    const autoLive = autoTypes.map(t => t.avgLive);
    const autoBidChart = renderGroupedBarChart({
      title: '4 种自动定向 平均基础出价 (Base) vs ERP分时折损当前出价 (Live)',
      subtitle: 'ERP 分时当前平均执行约 0.87x 折扣；针对漏水组将基础 Bid 压至 $0.33 可实现双重压制',
      categories: autoCats,
      series: [
        { name: '平均基础Bid ($)', color: '#64748b', data: autoBase },
        { name: '当前Live出价 ($)', color: '#3b82f6', data: autoLive }
      ],
      unit: '$',
      height: 220,
      showValOnTop: true
    });

    body = `
      <div class="chart-grid">
        ${autoSpendChart}
        ${autoBidChart}
      </div>

      <div class="card">
        <div class="card-hdr">
          <div>
            <h2 class="card-title">4 种自动定向 & ERP 分时当前出价汇总 (11/19–11/25)</h2>
            <div class="card-sub">基础 Bid、当前分时出价、分时倍率、花费、订单与 ACoS</div>
          </div>
        </div>
        <table>
          <thead><tr><th>定向类型</th><th>组数</th><th>基础Bid</th><th>当前出价</th><th>倍率</th><th>花费</th><th>订单</th><th>CVR</th><th>ACoS</th></tr></thead>
          <tbody>${autoTypes.map(t => `
            <tr>
              <td><b>${esc(t.type)}</b></td>
              <td>${t.count}</td>
              <td>${usd(t.avgBid)}</td>
              <td><b style="color:var(--indigo)">${usd(t.avgLive)}</b></td>
              <td>${t.avgRatio.toFixed(3)}x</td>
              <td><b>${usd(t.spend)}</b></td>
              <td>${t.ord}</td>
              <td>${pct(t.cvr)}</td>
              <td><span class="badge ${acosBadge(t.acos)}">${t.sales?pct(t.acos):'0单'}</span></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-hdr">
          <div>
            <h2 class="card-title">全量在投定向明细 (${filtered.length} / ${autoRows.length} 条)</h2>
            <div class="card-sub">各广告活动的单项定向出价、ERP 分时倍率与转化数据</div>
          </div>
        </div>
        <div class="toolbar">
          <input id="autoSearchInput" placeholder="搜索广告活动..." value="${esc(autoSearch)}" style="flex:1" />
          <select id="autoFilterSel">
            <option value="ALL" ${autoFilter==='ALL'?'selected':''}>全部 4 种定向</option>
            <option value="closeMatch" ${autoFilter==='closeMatch'?'selected':''}>closeMatch</option>
            <option value="looseMatch" ${autoFilter==='looseMatch'?'selected':''}>looseMatch</option>
            <option value="substitutes" ${autoFilter==='substitutes'?'selected':''}>substitutes</option>
            <option value="complements" ${autoFilter==='complements'?'selected':''}>complements</option>
          </select>
        </div>
        <div class="scroll-tbl"><table>
          <thead><tr><th>定向</th><th>广告活动</th><th>基础→Live</th><th>倍率</th><th>点击 / 花费</th><th>订单</th><th>ACoS</th></tr></thead>
          <tbody>${filtered.map(r => `
            <tr>
              <td><b>${esc(r.type)}</b></td>
              <td style="text-align:left">${esc(r.campaign)}${r.v4Locked?' <span class="badge b-gray">v4锁</span>':''}</td>
              <td>${usd(r.bid)}→<b style="color:var(--indigo)">${usd(r.live)}</b></td>
              <td>${r.live===0 && r.bid>0 ? '<span class="badge b-red">0.00x异常</span>' : r.ratio.toFixed(2)+'x'}</td>
              <td>${r.clk} / ${usd(r.spend)}</td>
              <td><b>${r.ord}</b></td>
              <td><span class="badge ${acosBadge(r.acos)}">${r.sales?pct(r.acos):'0单'}</span></td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </div>
    `;
  } else if (activeTab === 'strategy') {
    body = `
      <div class="card">
        <div class="card-hdr">
          <div>
            <h2 class="card-title">具体优化实操指南（小步快跑：单步 ≤8% 位置×定向×分时总纲）</h2>
            <div class="card-sub">黑五全周期出价安全边界与溢价对冲执行法则</div>
          </div>
        </div>
        <div class="strat-step"><b>1. 11/25-11/26 第 1 轮小步卡点（单次 Bid ≤ -8%，溢价 ≤ +8pp，不惊动大盘权重）：</b>
          <br/>• <code>S24Ultra-Blue</code>：<b>closeMatch $0.77→$0.71 (-7.8%) + TOS 0%→+8%</b>（保首页$1.53，ROS温和回落至$1.07）；
          <br/>• <code>Stylus-Deep Purple</code>：<b>$0.75→$0.70 (-6.7%) + ROS 0%→+7%</b>（保ROS 45.1%盈利位$1.12，TOS至$1.40）；
          <br/>• <code>Moto/G-Light Brown</code>：<b>$0.77→$0.71 (-7.8%) + 撤PP 5%→0% + TOS 5%→+12%</b>（保首页$1.59，压PP/ROS至$1.07）；
          <br/>• <code>A17-Blue</code>：先仅撤 <b>ROS 5%→0%（暂留TOS 5%）+ $0.77→$0.72 (-6.5%)</b> + ERP切75折；
          <br/>• <code>S26Ultra-Blue1</code>(<b>$0.70+ROS7%</b>)、<code>A17-Deep Purple3</code>(<b>$0.73+TOS5%/ROS10%</b>)、<code>IP17-Light Brown</code>(<b>$0.71+TOS6%</b>)。
        </div>
        <div class="strat-step"><b>2. 温和封堵漏水与观察期锁定：</b><code>substitutes/complements</code> 先由 $0.40-$0.45 分两步温和压至 <b>$0.33</b>（不一步腰斩防断权重），4天后仍0单再压$0.25；排查 2 个 ERP=$0.00 异常组；严格锁定 11/24 v4 12 个活动至 11/29。</div>
        <div class="strat-step"><b>3. 风控纠偏：</b><code>UP-Attack-IP18ProMax</code> 取消加首页，手动基础Bid微降-6%~-8%（或TOS 40→32%）并洗PP/ROS词；<code>UP-Auto-A17-Wine Red</code> 暂缓加ROS，维持$0.77观望明日Coupon。</div>
        <div class="strat-step"><b>4. 11/26 $2 Coupon 切换与明星位+5%试探：</b>确认前台 Coupon 生效后，ERP 切回 <b>90折/85折</b>；明星组 <code>Stylus-Light Brown</code>(TOS+5%)、<code>S24U-LB1</code>(TOS+5%/PP+5%)、<code>Pixel11-DP</code>(TOS+5%) 小幅放量。</div>
      </div>

      <div class="card">
        <div class="card-hdr">
          <div>
            <h2 class="card-title">本周执行清单打卡 (${doneCnt}/${checklist.length})</h2>
            <div class="card-sub">点击卡片即可即时切换打卡状态，并自动持久化保存</div>
          </div>
        </div>
        ${checklist.map(item => `
          <div class="chk-item ${item.done ? 'done' : ''}" data-chk="${esc(item.id)}">
            <input type="checkbox" ${item.done ? 'checked' : ''} style="margin-top:3px" />
            <div style="flex:1">
              <div class="chk-title"><span class="badge ${item.prio === 'P0' ? 'b-red' : 'b-amber'}">${esc(item.prio)}</span> [${esc(item.day)}] ${esc(item.title)}</div>
              <div class="chk-detail">${esc(item.detail)}</div>
            </div>
          </div>`).join('')}
      </div>
    `;
  } else {
    const fLog = optLog.filter(x => logFilter === 'ALL' || x.status.includes(logFilter));
    body = `
      <div class="card">
        <div class="card-hdr">
          <div>
            <h2 class="card-title">+ 录入优化操作 · 实时记录到台账并自动同步 Excel</h2>
            <div class="card-sub">支持单项活动微调或批量规则登记，自动补全 7d 基线</div>
          </div>
        </div>
        <div class="form-grid">
          <select id="newCamp">${campaigns.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('')}<option value="全量 UP-Auto">全量 UP-Auto</option></select>
          <select id="newTarget"><option value="closeMatch">closeMatch</option><option value="looseMatch">looseMatch</option><option value="substitutes/complements">substitutes/complements</option><option value="位置溢价(TOS/ROS/PP)">位置溢价(TOS/ROS/PP)</option><option value="ERP分时模板">ERP分时模板</option></select>
          <input id="newAction" placeholder="调整动作，如 Bid $0.77 -> $0.71 (-7.8%)" />
          <input id="newReviewDate" value="2026-11-30" placeholder="复盘日期 YYYY-MM-DD" />
        </div>
        <div class="toolbar">
          <input id="newReason" placeholder="调整依据 / 原因（可选）" style="flex:1" />
          <button class="btn btn-green" id="btnAddOpt">保存记录并写入 Excel</button>
        </div>
        ${excelSyncMsg ? `<div style="font-size:12px;color:#10b981;font-weight:600;margin-top:6px">${esc(excelSyncMsg)}</div>` : ''}
      </div>

      <div class="card">
        <div class="card-hdr">
          <div>
            <h2 class="card-title">优化项目与复盘台账 (${fLog.length} 条已记录，带 7d 调价前基线)</h2>
            <div class="card-sub">方便在 11/29、11/30 导出新数据时对比复盘效果</div>
          </div>
        </div>
        <div class="toolbar">
          <select id="logFilterSel">
            <option value="ALL" ${logFilter==='ALL'?'selected':''}>全部记录 (${optLog.length})</option>
            <option value="待执行" ${logFilter==='待执行'?'selected':''}>待执行</option>
            <option value="已执行待复盘" ${logFilter==='已执行待复盘'?'selected':''}>已执行待复盘 (${optLog.filter(x=>x.status==='已执行待复盘').length})</option>
            <option value="观察期" ${logFilter==='观察期'?'selected':''}>11/24 观察期 (11/29复盘)</option>
            <option value="已复盘" ${logFilter==='已复盘'?'selected':''}>已复盘</option>
          </select>
          <button class="btn btn-secondary" id="btnSyncExcel">立即重刷 Excel 台账</button>
        </div>
        <div class="scroll-tbl"><table>
          <thead><tr><th>日期 / 复盘日</th><th>状态</th><th>活动 / 定向</th><th>优化动作</th><th>调价前7d基线</th><th>复盘操作</th></tr></thead>
          <tbody>${fLog.map(item => `
            <tr>
              <td style="text-align:left"><b>${esc(item.opDate)}</b><br/><span style="color:var(--text-sub);font-size:10.5px">复盘: ${esc(item.reviewDate)}</span></td>
              <td><span class="badge ${item.status.includes('待执行')?'b-red':item.status.includes('已复盘')?'b-green':'b-amber'}">${esc(item.status)}</span></td>
              <td style="text-align:left"><b>${esc(item.campaign)}</b><br/><span style="color:var(--text-sub);font-size:10.5px">${esc(item.target)} | ${esc(item.category)}</span></td>
              <td style="text-align:left">${esc(item.action)}${item.postNote?`<br/><span style="color:#10b981;font-weight:600">复盘结论: ${esc(item.postNote)}</span>`:''}</td>
              <td>${item.base7d?.spend ? `${usd(item.base7d.spend)} / ${item.base7d.orders}单 / ${item.base7d.acos}%` : '-'}</td>
              <td>
                ${item.status==='待执行' ? `<button class="btn btn-sm" data-mark="${esc(item.id)}" data-st="已执行待复盘">标已执行</button>` : ''}
                ${!item.status.includes('已复盘') ? `<div style="margin-top:4px;display:flex;gap:4px"><input id="rev_${esc(item.id)}" placeholder="复盘结论..." style="width:120px;padding:3px 6px;font-size:11px" /><button class="btn btn-sm btn-green" data-rev="${esc(item.id)}">提交</button></div>` : ''}
              </td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </div>
    `;
  }

  root.innerHTML = `
    <div class="app-wrap">
      <div class="hdr">
        <div class="brand-group">
          <div class="brand-icon">UP</div>
          <div>
            <h1 class="brand-title">UPBestKS 广告优化 <span class="badge b-green" style="font-size:10px;padding:2px 6px">v1.2 PRO</span></h1>
            <div class="brand-sub">
              <span class="pulse-dot"></span> 实时看板 · 7d/14d 全盘洞察与复盘 · Excel 双向同步 · 更新于 ${esc(refreshedAt)}
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" id="btnSyncTop">同步 Excel</button>
          <button class="btn" id="btnRefresh">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
            刷新数据
          </button>
        </div>
      </div>

      <div class="tabs-bar">
        <button class="tab-btn ${activeTab==='overview'?'active':''}" data-tab="overview">大盘趋势 (15日)</button>
        <button class="tab-btn ${activeTab==='placements'?'active':''}" data-tab="placements">广告位 7d/14d</button>
        <button class="tab-btn ${activeTab==='portfolios'?'active':''}" data-tab="portfolios">广告组合 <span class="tab-count">15</span></button>
        <button class="tab-btn ${activeTab==='campaigns'?'active':''}" data-tab="campaigns">全量活动 <span class="tab-count">${campaigns.length}</span></button>
        <button class="tab-btn ${activeTab==='auto'?'active':''}" data-tab="auto">4定向 & ERP <span class="tab-count">${autoRows.length}</span></button>
        <button class="tab-btn ${activeTab==='strategy'?'active':''}" data-tab="strategy">优化清单 <span class="tab-count">${doneCnt}/${checklist.length}</span></button>
        <button class="tab-btn ${activeTab==='review'?'active':''}" data-tab="review">复盘台账 <span class="tab-count">${pendingOpt}</span></button>
      </div>

      ${body}
    </div>
  `;

  root.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { activeTab = b.getAttribute('data-tab'); render(); }));
  root.querySelector('#btnRefresh')?.addEventListener('click', async () => {
    const res = await app.callServerTool({ name: 'get_state', arguments: {} });
    if (res?.structuredContent) { state = res.structuredContent; render(); }
  });
  root.querySelector('#btnSyncTop')?.addEventListener('click', async () => {
    const res = await app.callServerTool({ name: 'save_opt', arguments: { syncExcel: true } });
    if (res?.structuredContent) { state = res.structuredContent; render(); }
  });
  root.querySelector('#campSearchInput')?.addEventListener('input', (e) => { campSearch = e.target.value; render(); });
  root.querySelector('#campFilterSel')?.addEventListener('change', (e) => { campFilter = e.target.value; render(); });
  root.querySelector('#autoSearchInput')?.addEventListener('input', (e) => { autoSearch = e.target.value; render(); });
  root.querySelector('#autoFilterSel')?.addEventListener('change', (e) => { autoFilter = e.target.value; render(); });
  root.querySelector('#logFilterSel')?.addEventListener('change', (e) => { logFilter = e.target.value; render(); });
  root.querySelectorAll('[data-chk]').forEach(el => el.addEventListener('click', async () => {
    const res = await app.callServerTool({ name: 'toggle_item', arguments: { id: el.getAttribute('data-chk') } });
    if (res?.structuredContent) { state = res.structuredContent; render(); }
  }));
  root.querySelector('#btnAddOpt')?.addEventListener('click', async () => {
    const campaign = document.getElementById('newCamp').value;
    const target = document.getElementById('newTarget').value;
    const action = document.getElementById('newAction').value.trim();
    const reason = document.getElementById('newReason').value.trim();
    const reviewDate = document.getElementById('newReviewDate').value.trim() || '2026-11-30';
    if (!action) return;
    const res = await app.callServerTool({ name: 'save_opt', arguments: { campaign, target, action, reason, reviewDate, syncExcel: true } });
    if (res?.structuredContent) { state = res.structuredContent; activeTab = 'review'; render(); }
  });
  root.querySelector('#btnSyncExcel')?.addEventListener('click', async () => {
    const res = await app.callServerTool({ name: 'save_opt', arguments: { syncExcel: true } });
    if (res?.structuredContent) { state = res.structuredContent; render(); }
  });
  root.querySelectorAll('[data-mark]').forEach(b => b.addEventListener('click', async () => {
    const res = await app.callServerTool({ name: 'save_opt', arguments: { id: b.getAttribute('data-mark'), status: b.getAttribute('data-st'), syncExcel: true } });
    if (res?.structuredContent) { state = res.structuredContent; render(); }
  }));
  root.querySelectorAll('[data-rev]').forEach(b => b.addEventListener('click', async () => {
    const id = b.getAttribute('data-rev');
    const inp = document.getElementById(`rev_${id}`);
    const note = inp && inp.value.trim() ? inp.value.trim() : '效果达标，ACoS回落继续观察';
    const res = await app.callServerTool({ name: 'save_opt', arguments: { id, status: '已复盘完成', postNote: note, syncExcel: true } });
    if (res?.structuredContent) { state = res.structuredContent; render(); }
  }));
}

app.ontoolinput = ({ arguments: args }) => { if (args?.tab) activeTab = args.tab; };
app.ontoolresult = (res) => {
  if (res?.structuredContent) { state = res.structuredContent; if (state.initialTab) activeTab = state.initialTab; render(); }
};
app.onhostcontextchanged = (ctx) => {
  if (ctx?.theme) { applyDocumentTheme(ctx.theme); document.documentElement.setAttribute('data-theme', ctx.theme); }
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

async function init() {
  await app.connect();
  const ctx = app.getHostContext();
  if (ctx?.theme) { applyDocumentTheme(ctx.theme); document.documentElement.setAttribute('data-theme', ctx.theme); }
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  setTimeout(async () => {
    if (!state) {
      const res = await app.callServerTool({ name: 'get_state', arguments: {} });
      if (res?.structuredContent) { state = res.structuredContent; render(); }
    }
  }, 300);
}
init().catch(err => { document.getElementById('root').innerHTML = `<div>加载失败: ${esc(err?.message || err)}</div>`; });
