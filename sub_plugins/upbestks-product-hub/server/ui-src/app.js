import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'UPBestKS 产品分析可视化', version: '1.0.0' }, {});

const COLOR_ORDER = [
  { en: 'Black', cn: '黑色', hex: '#1E293B' },
  { en: 'Wine Red', cn: '酒红', hex: '#881337' },
  { en: 'Blue', cn: '蓝色', hex: '#2563EB' },
  { en: 'Deep Purple', cn: '深紫', hex: '#6D28D9' },
  { en: 'Light Brown', cn: '橙色', hex: '#D97706' },
  { en: 'Blue Green', cn: '蓝绿色', hex: '#0D9488' },
  { en: 'Red', cn: '红色', hex: '#DC2626' },
  { en: 'Rose Gold', cn: '玫瑰金', hex: '#EC4899' },
];

const state = {
  payload: null,
  tab: 'overview',
  loading: false,
  toast: '',
  modelSort: 'sales',
  modelBrandFilter: 'ALL',
  matrixMetric: 'sales',
  skuSearch: '',
  skuModel: 'ALL',
  skuColor: 'ALL',
  skuQuad: 'ALL',
  skuSort: 'sales',
};

const fmtUsd = (v) => '$' + (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (v) => Math.round(Number(v) || 0).toLocaleString('en-US');
const fmtPct = (v) => ((Number(v) || 0) * 100).toFixed(1) + '%';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function quadBadge(q) {
  if (q === '明星爆款') return '<span class="badge badge-green">明星爆款</span>';
  if (q === '高耗预警') return '<span class="badge badge-red">高耗预警</span>';
  if (q === '高潜待放量') return '<span class="badge badge-blue">高潜待放量</span>';
  if (q === '稳健主力') return '<span class="badge badge-purple">稳健主力</span>';
  return '<span class="badge badge-gray">长尾观察</span>';
}

function renderDualBars(items, labelFn, maxVal) {
  const safeMax = maxVal || 1;
  return items
    .map((x) => {
      const salesW = Math.min(100, (x.sales / safeMax) * 100).toFixed(1);
      const adW = Math.min(100, (x.adSpend / safeMax) * 100).toFixed(1);
      return `
      <div style="margin-bottom:9px;">
        <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:3px;">
          <span style="font-weight:600;">${labelFn(x)}</span>
          <span style="color:var(--text-muted);">销售 <b>${fmtUsd(x.sales)}</b> · 广告 <b style="color:var(--amber)">${fmtUsd(x.adSpend)}</b> · TACoS <b>${fmtPct(x.tacos)}</b></span>
        </div>
        <div class="bar-track" style="height:8px;margin-bottom:2px;">
          <div class="bar-fill" style="width:${salesW}%;background:#2563eb;"></div>
        </div>
        <div class="bar-track" style="height:6px;">
          <div class="bar-fill" style="width:${adW}%;background:#f59e0b;"></div>
        </div>
      </div>`;
    })
    .join('');
}

function renderOverview(d) {
  const s = d.summary;
  const maxBrandSales = Math.max(...d.byBrand.map((b) => b.sales), 1);
  const quadEntries = Object.entries(d.quadrantCounts || {});
  return `
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">全店总销售额 / 净销售额</div>
        <div class="kpi-val" style="color:var(--primary)">${fmtUsd(s.sales)}</div>
        <div class="kpi-sub"><span>净销 ${fmtUsd(s.netSales)}</span><span>总销量 ${fmtInt(s.units)} 件</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">广告总花费 / TACoS (ACoAS)</div>
        <div class="kpi-val" style="color:var(--amber)">${fmtUsd(s.adSpend)}</div>
        <div class="kpi-sub"><span>TACoS ${fmtPct(s.tacos)}</span><span>ACoS ${fmtPct(s.acos)}</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">总流量 Sessions / 转化率</div>
        <div class="kpi-val" style="color:var(--emerald)">${fmtInt(s.sessions)}</div>
        <div class="kpi-sub"><span>CVR ${fmtPct(s.cvr)}</span><span>自然订单占比 ${fmtPct(s.natOrderShare)}</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">退款率 / 评分 / FBA 可售</div>
        <div class="kpi-val">${fmtPct(s.refundRate)}</div>
        <div class="kpi-sub"><span>★ ${s.avgRating} (${fmtInt(s.reviews)}评)</span><span>FBA可售 ${fmtInt(s.fbaSellable)} / 总 ${fmtInt(s.totalInv)}</span></div>
      </div>
    </div>

    <div class="two-col">
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">品牌阵营对比（蓝=销售额 / 橙=广告花费）</div>
          <div class="panel-note">4 大品牌 · ${d.meta.modelCount} 款机型</div>
        </div>
        ${renderDualBars(d.byBrand, (b) => `${esc(b.brand)} (${b.modelCount}款)`, maxBrandSales)}
      </div>

      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">新老批次梯队 & 四象限结构</div>
          <div class="panel-note">${d.meta.totalSkus} 个 SKU 分布</div>
        </div>
        ${d.byBatch
          .map(
            (b) => `
          <div style="padding:8px 10px;background:var(--bg-subtle);border-radius:8px;margin-bottom:8px;">
            <div style="display:flex;justify-content:space-between;font-weight:700;">
              <span>${esc(b.batch)} · ${b.modelCount}款 (${b.skuCount} SKU)</span>
              <span style="color:var(--primary)">${fmtUsd(b.sales)} (${fmtPct(b.salesShare)})</span>
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">
              销量 ${fmtInt(b.units)} 件 (近30天 ${fmtInt(b.d30)}) · 广告 ${fmtUsd(b.adSpend)} · TACoS ${fmtPct(b.tacos)} · CVR ${fmtPct(b.cvr)}
            </div>
          </div>`
          )
          .join('')}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
          ${quadEntries.map(([k, v]) => `${quadBadge(k)} <span style="font-size:11px;margin-right:6px;">${v}款</span>`).join('')}
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">TOP 5 畅销机型 & TOP 4 畅销颜色速览</div>
        <div class="panel-note">点击上方「机型分类」或「颜色分类」查看完整统计</div>
      </div>
      <div class="two-col">
        <div>
          <div style="font-weight:700;margin-bottom:6px;">畅销机型 TOP 5</div>
          ${renderDualBars(d.byModel.slice(0, 5), (m) => esc(m.model), d.byModel[0]?.sales || 1)}
        </div>
        <div>
          <div style="font-weight:700;margin-bottom:6px;">畅销颜色 TOP 4</div>
          ${renderDualBars(
            d.byColor.slice(0, 4),
            (c) => `<span class="swatch" style="background:${c.colorHex}"></span> ${esc(c.colorCn)} (${esc(c.colorEn)})`,
            d.byColor[0]?.sales || 1
          )}
        </div>
      </div>
    </div>
  `;
}

function renderModels(d) {
  const brands = ['ALL', ...new Set(d.byModel.map((m) => m.brand))];
  const filtered = d.byModel
    .filter((m) => state.modelBrandFilter === 'ALL' || m.brand === state.modelBrandFilter)
    .sort((a, b) => (b[state.modelSort] || 0) - (a[state.modelSort] || 0));
  const maxVal = Math.max(...filtered.map((m) => m.sales), 1);

  return `
    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">14 款机型分类统计（点击行可下钻该机型 SKU）</div>
        <div class="filter-bar" style="margin:0;">
          <select id="modelBrandSel">
            ${brands.map((b) => `<option value="${esc(b)}" ${state.modelBrandFilter === b ? 'selected' : ''}>${b === 'ALL' ? '全部品牌' : esc(b)}</option>`).join('')}
          </select>
          <select id="modelSortSel">
            <option value="sales" ${state.modelSort === 'sales' ? 'selected' : ''}>按销售额排序</option>
            <option value="units" ${state.modelSort === 'units' ? 'selected' : ''}>按总销量排序</option>
            <option value="d30" ${state.modelSort === 'd30' ? 'selected' : ''}>按30天销量排序</option>
            <option value="adSpend" ${state.modelSort === 'adSpend' ? 'selected' : ''}>按广告花费排序</option>
            <option value="tacos" ${state.modelSort === 'tacos' ? 'selected' : ''}>按TACoS排序</option>
            <option value="cvr" ${state.modelSort === 'cvr' ? 'selected' : ''}>按转化率排序</option>
          </select>
        </div>
      </div>
      ${renderDualBars(filtered, (m) => `${esc(m.model)} <span style="color:var(--text-muted);font-weight:400;">(${esc(m.brand)})</span>`, maxVal)}
    </div>

    <div class="panel">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>机型</th><th>品牌</th><th>总销量</th><th>30天</th><th>销售额</th><th>占比</th>
              <th>转化率</th><th>广告花费</th><th>ACoS</th><th>TACoS</th><th>退款率</th><th>FBA可售/总</th><th>主力色号</th>
            </tr>
          </thead>
          <tbody>
            ${filtered
              .map(
                (m) => `
              <tr data-jump-model="${esc(m.model)}" style="cursor:pointer;" title="点击查看 ${esc(m.model)} 下属 8 个色号明细">
                <td><b>${esc(m.model)}</b></td>
                <td>${esc(m.brand)}</td>
                <td>${fmtInt(m.units)}</td>
                <td>${fmtInt(m.d30)}</td>
                <td><b>${fmtUsd(m.sales)}</b></td>
                <td>${fmtPct(m.salesShare)}</td>
                <td>${fmtPct(m.cvr)}</td>
                <td>${fmtUsd(m.adSpend)}</td>
                <td>${fmtPct(m.acos)}</td>
                <td>${m.tacos >= 0.55 ? `<span class="badge badge-red">${fmtPct(m.tacos)}</span>` : m.tacos <= 0.35 ? `<span class="badge badge-green">${fmtPct(m.tacos)}</span>` : fmtPct(m.tacos)}</td>
                <td>${fmtPct(m.refundRate)}</td>
                <td>${fmtInt(m.fbaSellable)} / ${fmtInt(m.totalInv)}</td>
                <td>${esc(m.topColorCn)} (${fmtUsd(m.topColorSales)})</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderColors(d) {
  const maxSales = Math.max(...d.byColor.map((c) => c.sales), 1);
  return `
    <div class="color-grid">
      ${d.byColor
        .map(
          (c) => `
        <div class="color-card" data-jump-color="${esc(c.colorEn)}" title="点击查看 ${esc(c.colorCn)} 全机型明细">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:700;font-size:13px;"><span class="swatch" style="background:${c.colorHex}"></span> ${esc(c.colorCn)} (${esc(c.colorEn)})</span>
            <span class="badge badge-blue">${fmtPct(c.salesShare)}</span>
          </div>
          <div style="font-size:18px;font-weight:800;margin:5px 0 2px;">${fmtUsd(c.sales)}</div>
          <div style="font-size:11px;color:var(--text-muted);">
            销量 ${fmtInt(c.units)}件 (30天 ${fmtInt(c.d30)}) · CVR ${fmtPct(c.cvr)}<br/>
            广告 ${fmtUsd(c.adSpend)} · TACoS ${fmtPct(c.tacos)} · 退款 ${fmtPct(c.refundRate)}<br/>
            爆款机型：<b>${esc(c.topModel)}</b>
          </div>
        </div>`
        )
        .join('')}
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">8 大颜色销售额 vs 广告花费对比</div>
        <div class="panel-note">点击上方色卡可筛选该颜色全部 14 款机型 SKU</div>
      </div>
      ${renderDualBars(d.byColor, (c) => `<span class="swatch" style="background:${c.colorHex}"></span> ${esc(c.colorCn)} (${esc(c.colorEn)})`, maxSales)}
    </div>

    <div class="panel">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>颜色</th><th>SKU数</th><th>总销量</th><th>30天</th><th>销售额</th><th>占比</th>
              <th>Sessions</th><th>转化率</th><th>广告花费</th><th>ACoS</th><th>TACoS</th><th>退款率</th><th>评分</th><th>FBA可售</th>
            </tr>
          </thead>
          <tbody>
            ${d.byColor
              .map(
                (c) => `
              <tr data-jump-color="${esc(c.colorEn)}" style="cursor:pointer;">
                <td><span class="swatch" style="background:${c.colorHex}"></span> <b>${esc(c.colorCn)}</b> (${esc(c.colorEn)})</td>
                <td>${c.skuCount}</td>
                <td>${fmtInt(c.units)}</td>
                <td>${fmtInt(c.d30)}</td>
                <td><b>${fmtUsd(c.sales)}</b></td>
                <td>${fmtPct(c.salesShare)}</td>
                <td>${fmtInt(c.sessions)}</td>
                <td>${fmtPct(c.cvr)}</td>
                <td>${fmtUsd(c.adSpend)}</td>
                <td>${fmtPct(c.acos)}</td>
                <td>${c.tacos >= 0.5 ? `<span class="badge badge-red">${fmtPct(c.tacos)}</span>` : fmtPct(c.tacos)}</td>
                <td>${fmtPct(c.refundRate)}</td>
                <td>★ ${c.avgRating}</td>
                <td>${fmtInt(c.fbaSellable)}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function heatBg(metric, val) {
  if (metric === 'sales') {
    if (val >= 800) return 'rgba(16, 185, 129, 0.35)';
    if (val >= 400) return 'rgba(16, 185, 129, 0.2)';
    if (val >= 150) return 'rgba(37, 99, 235, 0.14)';
    return 'transparent';
  }
  if (metric === 'units') {
    if (val >= 50) return 'rgba(16, 185, 129, 0.35)';
    if (val >= 20) return 'rgba(16, 185, 129, 0.2)';
    if (val >= 8) return 'rgba(37, 99, 235, 0.14)';
    return 'transparent';
  }
  if (metric === 'tacos') {
    if (val >= 0.7) return 'rgba(225, 29, 72, 0.32)';
    if (val >= 0.5) return 'rgba(245, 158, 11, 0.24)';
    if (val > 0 && val <= 0.3) return 'rgba(16, 185, 129, 0.22)';
    return 'transparent';
  }
  if (metric === 'fbaSellable') {
    if (val === 0) return 'rgba(225, 29, 72, 0.25)';
    if (val >= 60) return 'rgba(245, 158, 11, 0.22)';
    return 'transparent';
  }
  return 'transparent';
}

function renderMatrix(d) {
  const m = state.matrixMetric;
  const fmtCell = (v) => {
    if (m === 'sales' || m === 'adSpend') return '$' + Math.round(v);
    if (m === 'tacos' || m === 'cvr') return (v * 100).toFixed(0) + '%';
    return fmtInt(v);
  };
  return `
    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">14 机型 × 8 颜色交叉热力矩阵</div>
        <div class="filter-bar" style="margin:0;">
          <select id="matrixMetricSel">
            <option value="sales" ${m === 'sales' ? 'selected' : ''}>销售额 ($)</option>
            <option value="units" ${m === 'units' ? 'selected' : ''}>总销量 (件)</option>
            <option value="adSpend" ${m === 'adSpend' ? 'selected' : ''}>广告花费 ($)</option>
            <option value="tacos" ${m === 'tacos' ? 'selected' : ''}>TACoS (%)</option>
            <option value="cvr" ${m === 'cvr' ? 'selected' : ''}>转化率 (%)</option>
            <option value="fbaSellable" ${m === 'fbaSellable' ? 'selected' : ''}>FBA 可售库存</option>
          </select>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>机型 \\ 颜色</th>
              ${COLOR_ORDER.map((c) => `<th style="text-align:center;"><span class="swatch" style="background:${c.hex}"></span> ${c.cn}</th>`).join('')}
              <th>机型汇总</th>
            </tr>
          </thead>
          <tbody>
            ${d.byModel
              .map(
                (mod) => `
              <tr>
                <td><b>${esc(mod.model)}</b></td>
                ${COLOR_ORDER.map((c) => {
                  const cell = d.matrix[mod.model]?.[c.en];
                  const val = cell ? cell[m] : 0;
                  const tip = cell
                    ? `${cell.msku}\n销售: ${fmtUsd(cell.sales)} (${cell.units}件)\n广告: ${fmtUsd(cell.adSpend)} | TACoS: ${fmtPct(cell.tacos)}\nCVR: ${fmtPct(cell.cvr)} | FBA可售: ${cell.fbaSellable}`
                    : '无数据';
                  return `<td class="matrix-cell" style="background:${heatBg(m, val)}" title="${esc(tip)}">${fmtCell(val)}</td>`;
                }).join('')}
                <td><b>${fmtCell(mod[m])}</b></td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderAds(d) {
  const s = d.summary;
  const { alerts } = d;
  return `
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">广告花费结构 (SP / SB / SD)</div>
        <div class="kpi-val">${fmtUsd(s.adSpend)}</div>
        <div class="kpi-sub"><span>SP ${fmtUsd(s.spSpend)}</span><span>SB ${fmtUsd(s.sbSpend)} · SD ${fmtUsd(s.sdSpend)}</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">广告产出 (总广告销售 vs 本品)</div>
        <div class="kpi-val" style="color:var(--primary)">${fmtUsd(s.adSales)}</div>
        <div class="kpi-sub"><span>本品 ${fmtUsd(s.selfAdSales)}</span><span>跨品带动 ${fmtUsd(s.crossAdSales)}</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">点击效率 (CTR / CPC / 广告CVR)</div>
        <div class="kpi-val">${fmtPct(s.adCvr)}</div>
        <div class="kpi-sub"><span>CTR ${fmtPct(s.ctr)}</span><span>CPC ${fmtUsd(s.cpc)}</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">异常诊断统计</div>
        <div class="kpi-val" style="color:var(--rose)">${alerts.highTacosCount} 预警</div>
        <div class="kpi-sub"><span>明星款 ${alerts.starCount}</span><span>高潜 ${alerts.potentialCount} · 高退 ${alerts.highRefundCount}</span></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">高耗止损预警（广告花费 ≥ $80 且 TACoS ≥ 55%）</div>
        <span class="badge badge-red">${alerts.highTacosCount} 个 SKU</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>MSKU</th><th>机型</th><th>颜色</th><th>销量</th><th>销售额</th><th>广告花费</th><th>ACoS</th><th>TACoS</th><th>CVR</th></tr></thead>
          <tbody>
            ${alerts.highTacosSkus
              .map(
                (x) => `
              <tr>
                <td>${esc(x.msku)}</td><td>${esc(x.model)}</td><td>${esc(x.colorCn)}</td>
                <td>${x.units}</td><td>${fmtUsd(x.sales)}</td><td style="color:var(--rose);font-weight:700;">${fmtUsd(x.adSpend)}</td>
                <td>${fmtPct(x.acos)}</td><td><span class="badge badge-red">${fmtPct(x.tacos)}</span></td><td>${fmtPct(x.cvr)}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">高潜待放量（转化率 ≥ 8% 但曝光偏低）</div>
        <span class="badge badge-blue">${alerts.potentialCount} 个 SKU</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>MSKU</th><th>机型</th><th>颜色</th><th>销量</th><th>销售额</th><th>广告曝光</th><th>广告花费</th><th>TACoS</th><th>转化率</th></tr></thead>
          <tbody>
            ${alerts.potentialSkus
              .map(
                (x) => `
              <tr>
                <td>${esc(x.msku)}</td><td>${esc(x.model)}</td><td>${esc(x.colorCn)}</td>
                <td>${x.units}</td><td>${fmtUsd(x.sales)}</td><td>${fmtInt(x.adImpr)}</td>
                <td>${fmtUsd(x.adSpend)}</td><td>${fmtPct(x.tacos)}</td><td><span class="badge badge-green">${fmtPct(x.cvr)}</span></td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderSkus(d) {
  const models = ['ALL', ...d.byModel.map((m) => m.model)];
  const colors = ['ALL', ...d.byColor.map((c) => c.colorEn)];
  const quads = ['ALL', '明星爆款', '高潜待放量', '稳健主力', '高耗预警', '长尾观察'];
  const q = state.skuSearch.trim().toLowerCase();

  const list = d.skus
    .filter((x) => {
      if (state.skuModel !== 'ALL' && x.model !== state.skuModel) return false;
      if (state.skuColor !== 'ALL' && x.colorEn !== state.skuColor) return false;
      if (state.skuQuad !== 'ALL' && x.quadrant !== state.skuQuad) return false;
      if (q && !x.msku.toLowerCase().includes(q) && !x.asin.toLowerCase().includes(q) && !x.pinming.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => (b[state.skuSort] || 0) - (a[state.skuSort] || 0));

  return `
    <div class="panel">
      <div class="filter-bar">
        <input type="text" id="skuSearchInp" placeholder="搜索 MSKU / ASIN / 品名..." value="${esc(state.skuSearch)}" style="min-width:190px;" />
        <select id="skuModelSel">${models.map((m) => `<option value="${esc(m)}" ${state.skuModel === m ? 'selected' : ''}>${m === 'ALL' ? '全部机型' : esc(m)}</option>`).join('')}</select>
        <select id="skuColorSel">${colors.map((c) => `<option value="${esc(c)}" ${state.skuColor === c ? 'selected' : ''}>${c === 'ALL' ? '全部颜色' : esc(c)}</option>`).join('')}</select>
        <select id="skuQuadSel">${quads.map((qd) => `<option value="${esc(qd)}" ${state.skuQuad === qd ? 'selected' : ''}>${qd === 'ALL' ? '全部诊断' : esc(qd)}</option>`).join('')}</select>
        <select id="skuSortSel">
          <option value="sales" ${state.skuSort === 'sales' ? 'selected' : ''}>销售额降序</option>
          <option value="units" ${state.skuSort === 'units' ? 'selected' : ''}>销量降序</option>
          <option value="adSpend" ${state.skuSort === 'adSpend' ? 'selected' : ''}>广告花费降序</option>
          <option value="tacos" ${state.skuSort === 'tacos' ? 'selected' : ''}>TACoS降序</option>
          <option value="cvr" ${state.skuSort === 'cvr' ? 'selected' : ''}>转化率降序</option>
        </select>
        <span class="panel-note">匹配 ${list.length} / ${d.skus.length} 个 SKU</span>
      </div>
      <div class="table-wrap" style="max-height:520px;overflow-y:auto;">
        <table>
          <thead>
            <tr>
              <th>MSKU</th><th>机型</th><th>颜色</th><th>诊断</th><th>销量(30d)</th><th>销售额</th>
              <th>Sessions</th><th>CVR</th><th>广告花费</th><th>ACoS</th><th>TACoS</th><th>退款率</th><th>FBA可售/总</th>
            </tr>
          </thead>
          <tbody>
            ${list
              .map(
                (x) => `
              <tr>
                <td title="${esc(x.asin)}">${esc(x.msku)}</td>
                <td>${esc(x.model)}</td>
                <td><span class="swatch" style="background:${x.colorHex}"></span> ${esc(x.colorCn)}</td>
                <td>${quadBadge(x.quadrant)}</td>
                <td>${fmtInt(x.units)} (${fmtInt(x.d30)})</td>
                <td><b>${fmtUsd(x.sales)}</b></td>
                <td>${fmtInt(x.sessions)}</td>
                <td>${fmtPct(x.cvr)}</td>
                <td>${fmtUsd(x.adSpend)}</td>
                <td>${fmtPct(x.acos)}</td>
                <td>${fmtPct(x.tacos)}</td>
                <td>${fmtPct(x.refundRate)}</td>
                <td>${fmtInt(x.fbaSellable)} / ${fmtInt(x.totalInv)}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function render() {
  const root = document.getElementById('root');
  if (!state.payload || !state.payload.data) {
    root.innerHTML = '<div class="panel">正在等待数据加载...</div>';
    return;
  }
  const d = state.payload.data;
  const tabs = [
    ['overview', '总览洞察'],
    ['models', `机型分类 (${d.meta.modelCount})`],
    ['colors', `颜色分类 (${d.meta.colorCount})`],
    ['matrix', '机型×颜色矩阵'],
    ['ads', '广告与流量'],
    ['skus', `全量SKU (${d.meta.totalSkus})`],
  ];

  let body = '';
  if (state.tab === 'overview') body = renderOverview(d);
  else if (state.tab === 'models') body = renderModels(d);
  else if (state.tab === 'colors') body = renderColors(d);
  else if (state.tab === 'matrix') body = renderMatrix(d);
  else if (state.tab === 'ads') body = renderAds(d);
  else if (state.tab === 'skus') body = renderSkus(d);

  root.innerHTML = `
    <div class="topbar">
      <div>
        <div class="brand-title">📊 UPBestKS 产品分析可视化</div>
        <div class="brand-sub">${esc(d.meta.store)} · ${d.meta.totalSkus} SKU (${d.meta.modelCount}机型 × ${d.meta.colorCount}颜色) · 更新于 ${esc(state.payload.refreshedAt || '')}</div>
      </div>
      <div class="actions">
        <button class="btn" id="btnRefresh" ${state.loading ? 'disabled' : ''}>↻ 刷新数据</button>
        <button class="btn btn-primary" id="btnExport" ${state.loading ? 'disabled' : ''}>📥 导出 Excel 报告</button>
      </div>
    </div>
    ${state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ''}
    <div class="tabs">
      ${tabs.map(([id, label]) => `<button class="tab-btn ${state.tab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('')}
    </div>
    ${body}
  `;

  bindEvents();
}

function bindEvents() {
  document.querySelectorAll('[data-tab]').forEach((el) => {
    el.onclick = () => {
      state.tab = el.getAttribute('data-tab');
      render();
    };
  });

  document.querySelectorAll('[data-jump-model]').forEach((el) => {
    el.onclick = () => {
      state.skuModel = el.getAttribute('data-jump-model');
      state.skuColor = 'ALL';
      state.tab = 'skus';
      render();
    };
  });

  document.querySelectorAll('[data-jump-color]').forEach((el) => {
    el.onclick = () => {
      state.skuColor = el.getAttribute('data-jump-color');
      state.skuModel = 'ALL';
      state.tab = 'skus';
      render();
    };
  });

  const bindSel = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.onchange = (e) => { state[key] = e.target.value; render(); };
  };
  bindSel('modelBrandSel', 'modelBrandFilter');
  bindSel('modelSortSel', 'modelSort');
  bindSel('matrixMetricSel', 'matrixMetric');
  bindSel('skuModelSel', 'skuModel');
  bindSel('skuColorSel', 'skuColor');
  bindSel('skuQuadSel', 'skuQuad');
  bindSel('skuSortSel', 'skuSort');

  const searchInp = document.getElementById('skuSearchInp');
  if (searchInp) {
    searchInp.oninput = (e) => {
      state.skuSearch = e.target.value;
      render();
      const again = document.getElementById('skuSearchInp');
      if (again) {
        again.focus();
        again.setSelectionRange(again.value.length, again.value.length);
      }
    };
  }

  const btnRefresh = document.getElementById('btnRefresh');
  if (btnRefresh) {
    btnRefresh.onclick = async () => {
      state.loading = true;
      state.toast = '';
      render();
      try {
        const res = await app.callServerTool({ name: 'get_product_state', arguments: { tab: state.tab } });
        if (res?.structuredContent) state.payload = res.structuredContent;
        state.toast = '数据已刷新！';
      } catch (err) {
        state.toast = '刷新失败: ' + err.message;
      } finally {
        state.loading = false;
        render();
      }
    };
  }

  const btnExport = document.getElementById('btnExport');
  if (btnExport) {
    btnExport.onclick = async () => {
      state.loading = true;
      state.toast = '正在生成 6 表联动 Excel 报告...';
      render();
      try {
        const res = await app.callServerTool({ name: 'export_product_excel', arguments: {} });
        if (res?.structuredContent) {
          state.payload = res.structuredContent;
          const xl = res.structuredContent.excelExported;
          state.toast = xl ? `已导出 Excel：${xl.outPath} (${xl.sizeKb} KB)` : 'Excel 已导出！';
        }
      } catch (err) {
        state.toast = '导出失败: ' + err.message;
      } finally {
        state.loading = false;
        render();
      }
    };
  }
}

app.ontoolresult = (result) => {
  if (result?.structuredContent) {
    state.payload = result.structuredContent;
    if (result.structuredContent.initialTab) state.tab = result.structuredContent.initialTab;
    render();
  }
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

(async () => {
  await app.connect();
  const ctx = app.getHostContext();
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
})();
