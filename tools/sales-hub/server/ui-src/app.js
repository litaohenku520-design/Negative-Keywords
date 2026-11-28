import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'UPBestKS 销售数据可视化', version: '2.0.0' }, {});

let payload = null;
let activeTab = 'overview';     // overview | models | colors | inventory | skus | saihu
let saihuSubTab = 'urgent';      // urgent | shipment | all
let saihuSearch = '';
let saihuFilter = 'ALL';         // ALL | NEED_PURCH | PURCH_TRANSIT | LOCAL_STOCK | CRITICAL_DOS
let periodKey = 'all';          // all | d30 | d15 | d7
let chartRange = '104';         // 104 | 30 | 15
let chartMetric = 'sales';      // sales | units
let cohortFilter = 'ALL';       // ALL | 老品主力 | 11月新品
let matrixMetric = 'units';     // units | sales | d15Units | d7Units | fbaTotal | dos
let invBucketFilter = 'ALL';
let skuSearch = '';
let skuModelFilter = 'ALL';
let skuColorFilter = 'ALL';
let skuAbcFilter = 'ALL';
let skuSortKey = 'totalSales';
let skuSortDir = -1;
let modelSortKey = 'sales';
let modelSortDir = -1;

// Color palette mapping with hex values for visual swatch dots
const COLOR_PALETTE = {
  'Black': '#1e293b',
  'Blue': '#2563eb',
  'Wine Red': '#881337',
  'Deep Purple': '#581c87',
  'Light Brown': '#b45309',
  'Blue Green': '#0f766e',
  'Red': '#dc2626',
  'Rose Gold': '#fda4af',
};

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtUsd = v => `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtUsd0 = v => `$${Math.round(Number(v || 0)).toLocaleString('en-US')}`;
const fmtInt = v => Math.round(Number(v || 0)).toLocaleString('en-US');
const fmtPct1 = v => `${(Number(v || 0) * 100).toFixed(1)}%`;

function showToast(msg, icon = '✓') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.innerHTML = `<span>${icon}</span> <span>${esc(msg)}</span>`;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}

function deltaPill(cur, prev) {
  if (!prev || prev <= 0) return '<span class="pill gray">—</span>';
  const pct = (cur - prev) / prev;
  const cls = pct >= 0.05 ? 'emerald' : (pct <= -0.05 ? 'rose' : 'gray');
  const sign = pct >= 0 ? '▲ +' : '▼ ';
  return `<span class="pill ${cls}">${sign}${(Math.abs(pct) * 100).toFixed(1)}%</span>`;
}

function pctPill(pct, emptyText = '—') {
  if (pct === null || pct === undefined) return `<span class="pill purple">${emptyText}</span>`;
  const cls = pct >= 0.08 ? 'emerald' : (pct <= -0.08 ? 'rose' : 'gray');
  const sign = pct >= 0 ? '▲ +' : '▼ ';
  return `<span class="pill ${cls}">${sign}${(Math.abs(pct) * 100).toFixed(1)}%</span>`;
}

async function refreshLive() {
  try {
    showToast('正在重新读取 UPBestKS 销售数据...', '🔄');
    const res = await app.callServerTool({ name: 'get_sales_state', arguments: { tab: activeTab } });
    if (res?.structuredContent) {
      payload = res.structuredContent;
      render();
      showToast('数据已实时刷新', '✓');
    }
  } catch (e) {
    showToast('刷新失败: ' + (e?.message || e), '⚠️');
  }
}

async function exportExcel() {
  try {
    showToast('正在生成 6 表原生图表 Excel 深度报表...', '⏳');
    const res = await app.callServerTool({ name: 'export_sales_excel', arguments: { tab: activeTab } });
    if (res?.structuredContent) {
      payload = res.structuredContent;
      const outPath = payload?.excelExported?.outPath || payload?.reportPath;
      showToast('Excel 已更新: ' + outPath, '📊');
      render();
    }
  } catch (e) {
    showToast('生成失败: ' + (e?.message || e), '⚠️');
  }
}

// =============================================================================
// SVG Charts with Executive Modern Aesthetics
// =============================================================================
function renderDailySvgChart(daily) {
  const n = chartRange === '15' ? 15 : (chartRange === '30' ? 30 : daily.length);
  const rows = daily.slice(-n);
  const W = 820, H = 250, padL = 52, padR = 20, padT = 20, padB = 40;
  const cw = W - padL - padR, ch = H - padT - padB;

  const getVal = d => chartMetric === 'sales' ? d.sales : d.units;
  const getMa = d => chartMetric === 'sales' ? d.ma7Sales : d.ma7Units;
  const getLeg = d => chartMetric === 'sales' ? d.legacySales : d.legacyUnits;
  const getNew = d => chartMetric === 'sales' ? d.newSales : d.newUnits;

  const maxV = Math.max(...rows.map(d => Math.max(getVal(d), getMa(d))), 1) * 1.15;
  const bw = cw / rows.length;
  const barW = Math.max(3, Math.min(22, bw * 0.74));

  let bars = '';
  let maPts = [];
  let areaPts = [];

  rows.forEach((d, i) => {
    const x = padL + i * bw + (bw - barW) / 2;
    const hLeg = (getLeg(d) / maxV) * ch;
    const hNew = (getNew(d) / maxV) * ch;
    const yLeg = padT + ch - hLeg;
    const yNew = yLeg - hNew;

    // Legacy bar (Sapphire)
    bars += `<rect class="bar-leg" x="${x.toFixed(1)}" y="${yLeg.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, hLeg).toFixed(1)}" fill="url(#blueBarGrad)" rx="2.5"/>`;
    // New products bar (Purple stacked on top)
    if (hNew > 0) {
      bars += `<rect class="bar-new" x="${x.toFixed(1)}" y="${yNew.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, hNew).toFixed(1)}" fill="url(#purpleBarGrad)" rx="2.5"/>`;
    }

    const cx = padL + i * bw + bw / 2;
    const cy = padT + ch - (getMa(d) / maxV) * ch;
    maPts.push(`${cx.toFixed(1)},${cy.toFixed(1)}`);
    areaPts.push(`${cx.toFixed(1)},${cy.toFixed(1)}`);
  });

  // Area under MA7 curve
  const firstX = (padL + bw / 2).toFixed(1);
  const lastX = (padL + (rows.length - 1) * bw + bw / 2).toFixed(1);
  const bottomY = (padT + ch).toFixed(1);
  const areaPath = `M ${firstX},${bottomY} L ${areaPts.join(' L ')} L ${lastX},${bottomY} Z`;

  // Horizontal Grid Lines & Y-Axis Labels
  let grid = '';
  for (let k = 0; k <= 4; k++) {
    const v = (maxV * k) / 4;
    const y = padT + ch - (ch * k) / 4;
    const lbl = chartMetric === 'sales' ? `$${Math.round(v)}` : `${Math.round(v)}`;
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--border-default)" stroke-dasharray="4,4" stroke-opacity="0.7"/>`;
    grid += `<text x="${padL - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" font-weight="600" fill="var(--text-muted)">${lbl}</text>`;
  }

  // X-Axis Labels
  const step = Math.max(1, Math.ceil(rows.length / 9));
  let xLbls = '';
  rows.forEach((d, i) => {
    if (i % step === 0 || i === rows.length - 1) {
      const cx = padL + i * bw + bw / 2;
      xLbls += `<text x="${cx.toFixed(1)}" y="${H - 14}" text-anchor="middle" font-size="10" font-weight="600" fill="var(--text-muted)">${d.date.slice(5)}</text>`;
    }
  });

  // Interactive Cursor & Hover Hitboxes
  let hits = '';
  rows.forEach((d, i) => {
    const x = padL + i * bw;
    const cx = x + bw / 2;
    hits += `<rect class="day-hit" data-idx="${i}" data-cx="${cx.toFixed(1)}" x="${x.toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${ch}" fill="transparent" style="cursor:crosshair;"/>`;
  });

  return `
    <svg id="daily-svg" class="chart-svg" viewBox="0 0 ${W} ${H}" data-range="${n}">
      <defs>
        <linearGradient id="blueBarGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3b82f6"/>
          <stop offset="100%" stop-color="#1d4ed8"/>
        </linearGradient>
        <linearGradient id="purpleBarGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#c084fc"/>
          <stop offset="100%" stop-color="#7c3aed"/>
        </linearGradient>
        <linearGradient id="maGlowGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="#f59e0b" stop-opacity="0.0"/>
        </linearGradient>
        <filter id="maDropShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#f59e0b" flood-opacity="0.35"/>
        </filter>
      </defs>

      ${grid}
      <path d="${areaPath}" fill="url(#maGlowGrad)" />
      ${bars}
      <polyline fill="none" stroke="#f59e0b" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" points="${maPts.join(' ')}" filter="url(#maDropShadow)" />
      
      <!-- Crosshair Line (Dynamic) -->
      <line id="crosshair-line" x1="0" y1="${padT}" x2="0" y2="${padT + ch}" stroke="var(--primary)" stroke-width="1.5" stroke-dasharray="3,3" opacity="0" style="pointer-events:none;"/>
      <circle id="crosshair-dot" cx="0" cy="0" r="4.5" fill="#f59e0b" stroke="#ffffff" stroke-width="2" opacity="0" style="pointer-events:none;"/>

      ${xLbls}
      ${hits}
    </svg>

    <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:center;font-size:11.5px;color:var(--text-muted);margin-top:8px;padding-left:6px;">
      <span style="display:inline-flex;align-items:center;gap:5px;">
        <span style="width:11px;height:11px;background:var(--primary-gradient);border-radius:3px;box-shadow:0 1px 3px rgba(37,99,235,0.3);"></span>
        <strong>老品主力 (5款)</strong>
      </span>
      <span style="display:inline-flex;align-items:center;gap:5px;">
        <span style="width:11px;height:11px;background:var(--purple-gradient);border-radius:3px;box-shadow:0 1px 3px rgba(124,58,237,0.3);"></span>
        <strong>11月新品 (9款)</strong>
      </span>
      <span style="display:inline-flex;align-items:center;gap:5px;">
        <span style="width:16px;height:3px;background:#f59e0b;border-radius:9999px;display:inline-block;"></span>
        <strong>7日移动均线 (MA7)</strong>
      </span>
      <span style="margin-left:auto;font-size:11px;color:var(--text-light);">💡 鼠标悬停可查看单日老品/新品拆解与均线趋势</span>
    </div>
  `;
}

function renderModelsHBarSvg(models) {
  const list = models.slice(0, 14);
  const W = 620, rowH = 26, padL = 150, padR = 120, padT = 10, padB = 10;
  const H = padT + padB + list.length * rowH;
  const cw = W - padL - padR;
  const maxSales = Math.max(...list.map(m => m.sales), 1);

  const rowsSvg = list.map((m, i) => {
    const y = padT + i * rowH;
    const w = Math.max(3, (m.sales / maxSales) * cw);
    const isTop3 = i < 3;
    const medal = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : `#${i + 1}`));
    const barGrad = m.cohort === '老品主力' ? 'url(#modelBlueGrad)' : 'url(#modelPurpleGrad)';

    return `
      <g class="model-bar-g" data-model="${esc(m.model)}" style="cursor:pointer;">
        <!-- Rank Medal -->
        <text x="${padL - 105}" y="${y + 16}" font-size="11" font-weight="700" fill="${isTop3 ? 'var(--text-main)' : 'var(--text-muted)'}">${medal}</text>
        <!-- Model Name -->
        <text x="${padL - 10}" y="${y + 16}" text-anchor="end" font-size="11" fill="var(--text-main)" font-weight="700">${esc(m.model)}</text>
        <!-- Background Track -->
        <rect x="${padL}" y="${y + 4}" width="${cw}" height="15" rx="4" fill="var(--bg-subtle)" />
        <!-- Filled Bar -->
        <rect x="${padL}" y="${y + 4}" width="${w.toFixed(1)}" height="15" rx="4" fill="${barGrad}" />
        <!-- Data Labels -->
        <text x="${(padL + w + 8).toFixed(1)}" y="${y + 16}" font-size="11" fill="var(--text-main)" font-weight="700">${fmtUsd0(m.sales)}</text>
        <text x="${(padL + w + 68).toFixed(1)}" y="${y + 16}" font-size="10" fill="var(--text-muted)">${fmtPct1(m.salesShare)} · ${m.units}件</text>
      </g>
    `;
  }).join('');

  return `
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}">
      <defs>
        <linearGradient id="modelBlueGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#3b82f6"/>
          <stop offset="100%" stop-color="#1d4ed8"/>
        </linearGradient>
        <linearGradient id="modelPurpleGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#a855f7"/>
          <stop offset="100%" stop-color="#6d28d9"/>
        </linearGradient>
      </defs>
      ${rowsSvg}
    </svg>
  `;
}

function renderColorsChartSvg(colors) {
  const W = 620, H = 210, padL = 46, padR = 16, padT = 20, padB = 44;
  const cw = W - padL - padR, ch = H - padT - padB;
  const maxV = Math.max(...colors.map(c => Math.max(c.units, c.fbaTotal)), 1) * 1.15;
  const grpW = cw / colors.length;
  const bw = Math.min(22, grpW * 0.36);

  let grid = '';
  for (let k = 0; k <= 4; k++) {
    const v = Math.round((maxV * k) / 4);
    const y = padT + ch - (ch * k) / 4;
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--border-default)" stroke-dasharray="3,3" stroke-opacity="0.6"/>`;
    grid += `<text x="${padL - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="9.5" font-weight="600" fill="var(--text-muted)">${v}</text>`;
  }

  const bars = colors.map((c, i) => {
    const x0 = padL + i * grpW + grpW / 2 - bw - 2;
    const x1 = padL + i * grpW + grpW / 2 + 2;
    const h0 = (c.units / maxV) * ch;
    const h1 = (c.fbaTotal / maxV) * ch;
    const swatchHex = COLOR_PALETTE[c.color] || '#64748b';

    return `
      <!-- Sales Units Bar -->
      <rect x="${x0.toFixed(1)}" y="${(padT + ch - h0).toFixed(1)}" width="${bw.toFixed(1)}" height="${h0.toFixed(1)}" fill="url(#colorSalesGrad)" rx="3"/>
      <text x="${(x0 + bw / 2).toFixed(1)}" y="${(padT + ch - h0 - 4).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700" fill="var(--text-main)">${c.units}</text>

      <!-- FBA Total Bar -->
      <rect x="${x1.toFixed(1)}" y="${(padT + ch - h1).toFixed(1)}" width="${bw.toFixed(1)}" height="${h1.toFixed(1)}" fill="url(#colorInvGrad)" rx="3"/>
      <text x="${(x1 + bw / 2).toFixed(1)}" y="${(padT + ch - h1 - 4).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700" fill="#d97706">${c.fbaTotal}</text>

      <!-- Color Dot & Name -->
      <circle cx="${(padL + i * grpW + grpW / 2 - 20).toFixed(1)}" cy="${H - 24}" r="4.5" fill="${swatchHex}" stroke="var(--border-strong)" stroke-width="1"/>
      <text x="${(padL + i * grpW + grpW / 2 + 4).toFixed(1)}" y="${H - 21}" text-anchor="middle" font-size="11" fill="var(--text-main)" font-weight="700">${esc(c.colorCn)}</text>
      <text x="${(padL + i * grpW + grpW / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle" font-size="9.5" fill="var(--text-muted)">${esc(c.color)}</text>
    `;
  }).join('');

  return `
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}">
      <defs>
        <linearGradient id="colorSalesGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3b82f6"/>
          <stop offset="100%" stop-color="#1d4ed8"/>
        </linearGradient>
        <linearGradient id="colorInvGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#fbbf24"/>
          <stop offset="100%" stop-color="#d97706"/>
        </linearGradient>
      </defs>
      ${grid}
      ${bars}
    </svg>
    <div style="display:flex;gap:18px;font-size:11.5px;color:var(--text-muted);margin-top:6px;padding-left:6px;">
      <span style="display:inline-flex;align-items:center;gap:5px;">
        <span style="width:11px;height:11px;background:var(--primary-gradient);border-radius:3px;"></span>
        <strong>全周期总销量 (件)</strong>
      </span>
      <span style="display:inline-flex;align-items:center;gap:5px;">
        <span style="width:11px;height:11px;background:linear-gradient(135deg,#fbbf24,#d97706);border-radius:3px;"></span>
        <strong>FBA 总在库总量 (件)</strong>
      </span>
      <span style="margin-left:auto;font-size:11px;color:var(--text-light);">黑色与蓝色合计占全店 53.6% 绝对主导</span>
    </div>
  `;
}

function renderSparkline(arr) {
  if (!arr || !arr.length) return '<span style="color:var(--text-light);font-size:10px;">—</span>';
  const max = Math.max(...arr, 1);
  const W = 80, H = 22;
  const pts = arr.map((v, i) => `${((i / (arr.length - 1)) * W).toFixed(1)},${(H - 2 - (v / max) * (H - 5)).toFixed(1)}`);
  const areaPath = `M 0,${H} L ${pts.join(' L ')} L ${W},${H} Z`;

  return `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="vertical-align:middle;overflow:visible;">
      <defs>
        <linearGradient id="spkGrad_${Math.random().toString(36).substr(2, 6)}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.0"/>
        </linearGradient>
      </defs>
      <path d="${areaPath}" fill="rgba(59, 130, 246, 0.15)"/>
      <polyline fill="none" stroke="#2563eb" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" points="${pts.join(' ')}"/>
    </svg>
  `;
}

// =============================================================================
// Tab Renderers
// =============================================================================
function renderOverview(d) {
  const { meta, periods, cohorts, monthly, weekly, daily, inventorySummary } = d;
  const curP = periods[periodKey] || periods.all;
  const prevP = periodKey === 'd7' ? periods.prev7 : (periodKey === 'd15' ? periods.prev15 : (periodKey === 'd30' ? periods.prev30 : null));
  const leg = cohorts.find(c => c.cohort === '老品主力') || {};
  const nw = cohorts.find(c => c.cohort === '11月新品') || {};

  const legPct = curP.sales > 0 ? (curP.legacySales / curP.sales) * 100 : 0;
  const newPct = 100 - legPct;

  return `
    <!-- Executive Takeaway Banner -->
    <div class="exec-banner">
      <div class="exec-banner-content">
        <h4><span>💡</span> 关键业务洞察与增长动能</h4>
        <p>
          <strong>11月新品放量显著</strong>：9款新品（11/03起售）在近15天销售贡献已突破 <strong>${fmtPct1(nw.d15Share)}</strong>（\$${Math.round(nw.d15Sales)}），S24 FE、A16 5G 跃居主力梯队；<br/>
          <strong>备货警戒</strong>：全店 <strong>${inventorySummary.criticalDosCount} 个 SKU</strong> 可售天数 &lt; 15天，重点缺货集中在 S26 黑色/蓝色及 S24 FE 核心色，需加急空运/红单补仓。
        </p>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <span class="pill emerald">新品近15天增速 +100%</span>
        <span class="pill rose">${inventorySummary.criticalDosCount} SKU 高危断货</span>
      </div>
    </div>

    <!-- Interval Selector Bar -->
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px;">
      <div class="seg-bar">
        <button class="seg-btn ${periodKey === 'all' ? 'active' : ''}" data-period="all">全周期 (104天)</button>
        <button class="seg-btn ${periodKey === 'd30' ? 'active' : ''}" data-period="d30">近 30 天</button>
        <button class="seg-btn ${periodKey === 'd15' ? 'active' : ''}" data-period="d15">近 15 天</button>
        <button class="seg-btn ${periodKey === 'd7' ? 'active' : ''}" data-period="d7">近 7 天</button>
      </div>
      <div style="font-size:11.5px;color:var(--text-muted);display:flex;align-items:center;gap:6px;">
        <span>统计范围：<strong style="color:var(--text-main);">${curP.startDate} ~ ${curP.endDate}</strong> (${curP.days}天)</span>
      </div>
    </div>

    <!-- 6 Executive KPI Cards -->
    <div class="kpi-grid">
      <div class="kpi-card emerald">
        <div class="kpi-header">
          <span class="kpi-label">区间总销售额</span>
          <span class="kpi-icon-pill">💵</span>
        </div>
        <div class="kpi-val">${fmtUsd(curP.sales)}</div>
        <div class="kpi-footer">
          ${prevP ? `环比 ${deltaPill(curP.sales, prevP.sales)}` : `<span class="pill emerald">日均 ${fmtUsd(curP.dailyAvgSales)}</span>`}
          <span style="color:var(--text-light)">·</span>
          <span>共 ${curP.days} 天</span>
        </div>
      </div>

      <div class="kpi-card">
        <div class="kpi-header">
          <span class="kpi-label">销量 / 订单量</span>
          <span class="kpi-icon-pill">📦</span>
        </div>
        <div class="kpi-val">${fmtInt(curP.units)} <small>/ ${fmtInt(curP.orders)}单</small></div>
        <div class="kpi-footer">
          ${prevP ? `环比 ${deltaPill(curP.units, prevP.units)}` : `<span class="pill blue">日均 ${curP.dailyAvgUnits} 件</span>`}
          <span style="color:var(--text-light)">·</span>
          <span>1.04 件/单</span>
        </div>
      </div>

      <div class="kpi-card">
        <div class="kpi-header">
          <span class="kpi-label">客单价 ASP & 动销SKU</span>
          <span class="kpi-icon-pill">🏷️</span>
        </div>
        <div class="kpi-val">${fmtUsd(curP.asp)}</div>
        <div class="kpi-footer">
          <span class="pill gray">动销 ${curP.activeSkus} / ${meta.skusCount} SKU</span>
          <span style="color:var(--text-light)">·</span>
          <span>动销率 ${(curP.activeSkus / meta.skusCount * 100).toFixed(0)}%</span>
        </div>
      </div>

      <div class="kpi-card purple">
        <div class="kpi-header">
          <span class="kpi-label">11月新品贡献 (9款)</span>
          <span class="kpi-icon-pill">🚀</span>
        </div>
        <div class="kpi-val">${fmtUsd(curP.newSales)}</div>
        <div class="kpi-footer">
          <span class="pill purple">占本区间 ${newPct.toFixed(1)}%</span>
          <span style="color:var(--text-light)">·</span>
          <span>${curP.newUnits} 件</span>
        </div>
      </div>

      <div class="kpi-card amber">
        <div class="kpi-header">
          <span class="kpi-label">FBA 总在库总量</span>
          <span class="kpi-icon-pill">🏬</span>
        </div>
        <div class="kpi-val">${fmtInt(inventorySummary.fbaTotal)} <small>件</small></div>
        <div class="kpi-footer">
          <span>可售 ${fmtInt(inventorySummary.fbaSellable)}</span>
          <span style="color:var(--text-light)">|</span>
          <span>在途 ${fmtInt(inventorySummary.fbaTransit)}</span>
        </div>
      </div>

      <div class="kpi-card rose">
        <div class="kpi-header">
          <span class="kpi-label">断货高危 & 积压预警</span>
          <span class="kpi-icon-pill">⚠️</span>
        </div>
        <div class="kpi-val">${inventorySummary.criticalDosCount} <small style="color:var(--rose)">高危</small> / ${inventorySummary.overstockCount} <small>积压</small></div>
        <div class="kpi-footer">
          <span class="pill rose">&lt;15天断货红线</span>
          <span style="color:var(--text-light)">|</span>
          <span class="pill purple">&gt;180天积压</span>
        </div>
      </div>
    </div>

    <!-- Cohort Stack Bar Card -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title-group">
          <span style="font-size:15px;">⚖️</span>
          <div>
            <h3 class="card-title">新老品梯队销售结构对比（老品 5 款 vs 11月新品 9 款）</h3>
            <div class="card-subtitle">老品奠定稳健基盘，新品爆发推动店铺日均销售额翻倍</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;">
          <span class="pill blue">老品 ${legPct.toFixed(1)}%</span>
          <span class="pill purple">新品 ${newPct.toFixed(1)}%</span>
        </div>
      </div>

      <div class="stack-bar-wrap">
        <div class="stack-bar">
          <div class="stack-segment" style="width:${legPct.toFixed(1)}%;background:var(--primary-gradient);" title="老品主力 ${legPct.toFixed(1)}%"></div>
          <div class="stack-segment" style="width:${newPct.toFixed(1)}%;background:var(--purple-gradient);" title="11月新品 ${newPct.toFixed(1)}%"></div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px;margin-top:10px;">
        <div style="background:var(--primary-soft);border:1px solid rgba(37,99,235,0.2);border-radius:var(--radius-md);padding:10px 12px;">
          <div style="font-weight:700;color:var(--primary);margin-bottom:3px;display:flex;align-items:center;gap:6px;">
            <span>🔵</span> 老品主力（S26 / IP17PM / Moto G / A17 / IP17P）
          </div>
          <div style="font-size:11.5px;color:var(--text-muted);">
            全周期累计销售 <strong>${fmtUsd(leg.sales)}</strong>（${leg.units}件）· 近15天占 <strong>${fmtPct1(leg.d15Share)}</strong>，基本盘保持坚挺。
          </div>
        </div>
        <div style="background:var(--purple-soft);border:1px solid rgba(124,58,237,0.2);border-radius:var(--radius-md);padding:10px 12px;">
          <div style="font-weight:700;color:var(--purple);margin-bottom:3px;display:flex;align-items:center;gap:6px;">
            <span>🟣</span> 11月新品（11/03首单 9款：S24 FE / A16 5G / G Power 2025等）
          </div>
          <div style="font-size:11.5px;color:var(--text-muted);">
            全周期已贡献 <strong>${fmtUsd(nw.sales)}</strong>（${nw.units}件）· 近15天贡献飙升至 <strong>${fmtPct1(nw.d15Share)}</strong>，日均已反超老品！
          </div>
        </div>
      </div>
    </div>

    <!-- Daily Trend Chart Card -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title-group">
          <span style="font-size:15px;">📊</span>
          <div>
            <h3 class="card-title">每日销售趋势与 7 日移动均线 (MA7)</h3>
            <div class="card-subtitle">观察单日放量波峰与周期平滑趋势</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <div class="seg-bar">
            <button class="seg-btn ${chartMetric === 'sales' ? 'active' : ''}" data-cmetric="sales">销售额 $</button>
            <button class="seg-btn ${chartMetric === 'units' ? 'active' : ''}" data-cmetric="units">销量 件</button>
          </div>
          <div class="seg-bar">
            <button class="seg-btn ${chartRange === '104' ? 'active' : ''}" data-crange="104">104天全览</button>
            <button class="seg-btn ${chartRange === '30' ? 'active' : ''}" data-crange="30">近30天</button>
            <button class="seg-btn ${chartRange === '15' ? 'active' : ''}" data-crange="15">近15天</button>
          </div>
        </div>
      </div>
      <div class="chart-box">${renderDailySvgChart(daily)}</div>
    </div>

    <!-- Monthly & Weekly 2-Column Tables -->
    <div class="two-col">
      <div class="card">
        <div class="card-hdr">
          <div class="card-title-group">
            <span style="font-size:14px;">📅</span>
            <h3 class="card-title">月度销售与日均增速 (MoM)</h3>
          </div>
        </div>
        <div class="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>月份</th>
                <th>天数</th>
                <th>动销</th>
                <th>销量</th>
                <th>销售额</th>
                <th>日均额</th>
                <th>ASP</th>
                <th>日均环比</th>
              </tr>
            </thead>
            <tbody>
              ${monthly.map(m => `
                <tr>
                  <td><strong>${m.month}</strong></td>
                  <td>${m.days}</td>
                  <td>${m.activeSkus}</td>
                  <td>${fmtInt(m.units)}</td>
                  <td><strong style="color:var(--primary);">${fmtUsd(m.sales)}</strong></td>
                  <td>${fmtUsd(m.dailyAvgSales)}</td>
                  <td>${fmtUsd(m.asp)}</td>
                  <td>${m.qoqDailySalesPct === null ? '<span class="pill gray">基期</span>' : pctPill(m.qoqDailySalesPct)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-hdr">
          <div class="card-title-group">
            <span style="font-size:14px;">📈</span>
            <h3 class="card-title">近 8 周滚动趋势（7天/周）</h3>
          </div>
        </div>
        <div class="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>周区间</th>
                <th>销量</th>
                <th>销售额</th>
                <th>老品额</th>
                <th>新品额</th>
                <th>日均额</th>
                <th>环比增速</th>
              </tr>
            </thead>
            <tbody>
              ${weekly.slice(-8).reverse().map(w => `
                <tr>
                  <td><strong>${w.weekLabel}</strong></td>
                  <td>${fmtInt(w.units)}</td>
                  <td><strong style="color:var(--primary);">${fmtUsd(w.sales)}</strong></td>
                  <td>${fmtUsd0(w.legacySales)}</td>
                  <td><strong style="color:var(--purple);">${fmtUsd0(w.newSales)}</strong></td>
                  <td>${fmtUsd(w.dailyAvgSales)}</td>
                  <td>${pctPill(w.qoqSalesPct, '—')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function renderModels(d) {
  let list = d.models.filter(m => cohortFilter === 'ALL' || m.cohort === cohortFilter);
  list = [...list].sort((a, b) => {
    const va = a[modelSortKey] ?? -999, vb = b[modelSortKey] ?? -999;
    return typeof va === 'string' ? va.localeCompare(vb) * modelSortDir : (va - vb) * modelSortDir;
  });

  return `
    <!-- Top 3 Podium Highlights -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-bottom:14px;">
      <div style="background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:12px 14px;box-shadow:var(--shadow-sm);position:relative;overflow:hidden;">
        <div style="position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#fbbf24,#f59e0b);"></div>
        <div style="font-size:11px;font-weight:700;color:#d97706;display:flex;align-items:center;gap:5px;">🥇 全店销量冠军</div>
        <div style="font-size:17px;font-weight:800;margin:3px 0;color:var(--text-main);">S26</div>
        <div style="font-size:11.5px;color:var(--text-muted);display:flex;justify-content:space-between;">
          <span>销售额 <strong>$6,554.49</strong></span>
          <span>销量 <strong>397 件</strong></span>
        </div>
      </div>

      <div style="background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:12px 14px;box-shadow:var(--shadow-sm);position:relative;overflow:hidden;">
        <div style="position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#94a3b8,#64748b);"></div>
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);display:flex;align-items:center;gap:5px;">🥈 全店销量亚军</div>
        <div style="font-size:17px;font-weight:800;margin:3px 0;color:var(--text-main);">IP17PM</div>
        <div style="font-size:11.5px;color:var(--text-muted);display:flex;justify-content:space-between;">
          <span>销售额 <strong>$5,420.91</strong></span>
          <span>销量 <strong>310 件</strong></span>
        </div>
      </div>

      <div style="background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:12px 14px;box-shadow:var(--shadow-sm);position:relative;overflow:hidden;">
        <div style="position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#b45309,#78350f);"></div>
        <div style="font-size:11px;font-weight:700;color:#b45309;display:flex;align-items:center;gap:5px;">🥉 全店销量季军</div>
        <div style="font-size:17px;font-weight:800;margin:3px 0;color:var(--text-main);">Moto G Play 2024</div>
        <div style="font-size:11.5px;color:var(--text-muted);display:flex;justify-content:space-between;">
          <span>销售额 <strong>$4,409.84</strong></span>
          <span>销量 <strong>252 件</strong></span>
        </div>
      </div>

      <div style="background:var(--purple-soft);border:1px solid rgba(124,58,237,0.25);border-radius:var(--radius-lg);padding:12px 14px;box-shadow:var(--shadow-sm);position:relative;overflow:hidden;">
        <div style="position:absolute;top:0;left:0;right:0;height:3px;background:var(--purple-gradient);"></div>
        <div style="font-size:11px;font-weight:700;color:var(--purple);display:flex;align-items:center;gap:5px;">🚀 11月极速黑马</div>
        <div style="font-size:17px;font-weight:800;margin:3px 0;color:var(--purple);">S24 FE</div>
        <div style="font-size:11.5px;color:var(--text-muted);display:flex;justify-content:space-between;">
          <span>近15天额 <strong>$999.03</strong></span>
          <span>近7天 <strong>$498.41</strong></span>
        </div>
      </div>
    </div>

    <div class="filter-bar">
      <div class="seg-bar">
        <button class="seg-btn ${cohortFilter === 'ALL' ? 'active' : ''}" data-cohort="ALL">全部 14 款机型</button>
        <button class="seg-btn ${cohortFilter === '老品主力' ? 'active' : ''}" data-cohort="老品主力">老品主力 (5款)</button>
        <button class="seg-btn ${cohortFilter === '11月新品' ? 'active' : ''}" data-cohort="11月新品">11月新品 (9款)</button>
      </div>
      <span style="font-size:11.5px;color:var(--text-muted);margin-left:auto;">💡 提示：点击任意行或柱状图，可自动穿透查看该机型 8 色全量 SKU 明细</span>
    </div>

    <!-- Models Horizontal Ranking Chart -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title-group">
          <span style="font-size:14px;">🏆</span>
          <h3 class="card-title">14 款机型销售额实力榜（🔵 老品主力 vs 🟣 11月新品）</h3>
        </div>
        <span style="font-size:11.5px;color:var(--text-muted);">S26 / IP17PM / Moto G 三强稳固，S24 FE 强势崛起</span>
      </div>
      <div class="chart-box">${renderModelsHBarSvg(list)}</div>
    </div>

    <!-- Models Detailed Comparative Table -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title-group">
          <span style="font-size:14px;">📋</span>
          <h3 class="card-title">分机型 15天/7天周期对比与周转诊断表（点击表头可任意排序）</h3>
        </div>
      </div>
      <div class="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th data-msort="model">机型</th>
              <th>梯队</th>
              <th data-msort="firstSaleDate" style="text-align:center;">首单日期</th>
              <th data-msort="units">总销量</th>
              <th data-msort="sales">总销售额</th>
              <th data-msort="salesShare">全店占比</th>
              <th data-msort="prev15Sales">前15天额</th>
              <th data-msort="d15Sales">近15天额</th>
              <th data-msort="d15SalesPct">15天环比</th>
              <th data-msort="d7Sales">近7天额</th>
              <th data-msort="fbaSellable">可售库存</th>
              <th data-msort="fbaTotal">总库存</th>
              <th data-msort="estTotalDos">周转天数</th>
              <th style="text-align:center;">运营诊断评级</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(m => `
              <tr class="row-click" data-drill-model="${esc(m.model)}">
                <td><strong style="color:var(--text-main);">${esc(m.model)}</strong></td>
                <td><span class="pill ${m.cohort === '老品主力' ? 'blue' : 'purple'}">${m.cohort}</span></td>
                <td style="text-align:center;color:var(--text-muted);">${m.firstSaleDate}</td>
                <td><strong>${fmtInt(m.units)}</strong></td>
                <td><strong style="color:var(--primary);">${fmtUsd(m.sales)}</strong></td>
                <td>${fmtPct1(m.salesShare)}</td>
                <td>${fmtUsd(m.prev15Sales)}</td>
                <td><strong style="color:${m.cohort === '11月新品' ? 'var(--purple)' : 'var(--text-main)'};">${fmtUsd(m.d15Sales)}</strong></td>
                <td>${pctPill(m.d15SalesPct, '新品首期')}</td>
                <td>${fmtUsd(m.d7Sales)}</td>
                <td>${fmtInt(m.fbaSellable)}</td>
                <td><strong>${fmtInt(m.fbaTotal)}</strong></td>
                <td>
                  <span class="pill ${m.estTotalDos < 45 ? 'amber' : (m.estTotalDos > 180 ? 'purple' : 'emerald')}">
                    ${m.estTotalDos >= 999 ? '极慢' : m.estTotalDos + '天'}
                  </span>
                </td>
                <td style="text-align:center;">
                  <span class="pill ${m.grade.includes('黑马') || m.grade.includes('加速') ? 'emerald' : (m.grade.includes('回落') ? 'amber' : 'blue')}">
                    ${m.grade}
                  </span>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderColors(d) {
  const { colors, matrix } = d;
  const colorOrder = ['Black', 'Blue', 'Wine Red', 'Deep Purple', 'Light Brown', 'Blue Green', 'Red', 'Rose Gold'];

  const getCellVal = (cell) => {
    if (!cell) return null;
    if (matrixMetric === 'sales') return cell.sales;
    if (matrixMetric === 'd15Units') return cell.d15Units;
    if (matrixMetric === 'd7Units') return cell.d7Units;
    if (matrixMetric === 'fbaTotal') return cell.fbaTotal;
    if (matrixMetric === 'dos') return cell.dos;
    return cell.units;
  };

  const allVals = [];
  matrix.forEach(r => colorOrder.forEach(c => {
    const v = getCellVal(r.cells[c]);
    if (v !== null && matrixMetric !== 'dos') allVals.push(v);
  }));
  const maxVal = Math.max(...allVals, 1);

  return `
    <!-- Colors Bar Chart -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title-group">
          <span style="font-size:14px;">🎨</span>
          <div>
            <h3 class="card-title">8 大颜色全周期销量 vs FBA 总库存结构</h3>
            <div class="card-subtitle">黑色与蓝色双雄领跑，玫瑰金与红色需防范积压</div>
          </div>
        </div>
      </div>
      <div class="chart-box">${renderColorsChartSvg(colors)}</div>
    </div>

    <!-- Colors Summary Table -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title-group">
          <span style="font-size:14px;">📊</span>
          <h3 class="card-title">分颜色销售贡献与备货策略建议</h3>
        </div>
        <span style="font-size:11.5px;color:var(--text-muted);">点击颜色行可过滤该颜色 SKU</span>
      </div>
      <div class="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>颜色名称</th>
              <th style="text-align:center;">SKU数</th>
              <th>总销量</th>
              <th>销量占比</th>
              <th>总销售额</th>
              <th>近15天销</th>
              <th>近7天销</th>
              <th>可售库存</th>
              <th>在途库存</th>
              <th>总库存</th>
              <th style="text-align:left;">运营与备货建议</th>
            </tr>
          </thead>
          <tbody>
            ${colors.map(c => {
              const hex = COLOR_PALETTE[c.color] || '#64748b';
              return `
                <tr class="row-click" data-drill-color="${esc(c.color)}">
                  <td>
                    <div style="display:flex;align-items:center;gap:7px;">
                      <span style="width:10px;height:10px;border-radius:50%;background:${hex};border:1px solid var(--border-strong);"></span>
                      <strong style="color:var(--text-main);">${esc(c.colorCn)}</strong>
                      <span style="color:var(--text-muted);font-size:10.5px;">(${esc(c.color)})</span>
                    </div>
                  </td>
                  <td style="text-align:center;">${c.skusCount}</td>
                  <td><strong style="color:var(--primary);">${fmtInt(c.units)}</strong></td>
                  <td>${fmtPct1(c.unitsShare)}</td>
                  <td><strong>${fmtUsd(c.sales)}</strong></td>
                  <td>${fmtInt(c.d15Units)}</td>
                  <td>${fmtInt(c.d7Units)}</td>
                  <td>${fmtInt(c.fbaSellable)}</td>
                  <td>${fmtInt(c.fbaTransit)}</td>
                  <td><strong>${fmtInt(c.fbaTotal)}</strong></td>
                  <td style="text-align:left;">
                    <span class="pill ${c.advice.includes('核心') ? 'emerald' : (c.advice.includes('积压') ? 'rose' : 'blue')}">
                      ${esc(c.advice)}
                    </span>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- 14 Models x 8 Colors Cross-Tabulation Matrix Heatmap -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title-group">
          <span style="font-size:14px;">🔲</span>
          <div>
            <h3 class="card-title">14 机型 × 8 颜色 交叉热力透视矩阵（点击任意单元格快速定位 SKU）</h3>
            <div class="card-subtitle">通过热力色阶快速发现爆款配色与滞销死角</div>
          </div>
        </div>
        <div class="seg-bar">
          <button class="seg-btn ${matrixMetric === 'units' ? 'active' : ''}" data-mmetric="units">全期销量</button>
          <button class="seg-btn ${matrixMetric === 'sales' ? 'active' : ''}" data-mmetric="sales">全期销售额</button>
          <button class="seg-btn ${matrixMetric === 'd15Units' ? 'active' : ''}" data-mmetric="d15Units">近15天销</button>
          <button class="seg-btn ${matrixMetric === 'd7Units' ? 'active' : ''}" data-mmetric="d7Units">近7天销</button>
          <button class="seg-btn ${matrixMetric === 'fbaTotal' ? 'active' : ''}" data-mmetric="fbaTotal">FBA总库存</button>
          <button class="seg-btn ${matrixMetric === 'dos' ? 'active' : ''}" data-mmetric="dos">可售天数(DOS)</button>
        </div>
      </div>

      <div class="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th style="min-width:120px;">机型</th>
              ${colorOrder.map(c => {
                const hex = COLOR_PALETTE[c] || '#64748b';
                const cn = colors.find(x => x.color === c)?.colorCn || c;
                return `
                  <th style="text-align:center;min-width:72px;">
                    <div style="display:flex;align-items:center;justify-content:center;gap:4px;">
                      <span style="width:7px;height:7px;border-radius:50%;background:${hex};display:inline-block;"></span>
                      <span>${esc(cn)}</span>
                    </div>
                  </th>
                `;
              }).join('')}
            </tr>
          </thead>
          <tbody>
            ${matrix.map(r => `
              <tr>
                <td><strong>${esc(r.model)}</strong></td>
                ${colorOrder.map(c => {
                  const cell = r.cells[c];
                  if (!cell) return '<td style="text-align:center;color:var(--text-light);font-size:11px;">—</td>';
                  const v = getCellVal(cell);
                  let bg = 'transparent', color = 'var(--text-main)';

                  if (matrixMetric === 'dos') {
                    if (v < 15) { bg = 'rgba(225, 29, 72, 0.28)'; color = 'var(--rose)'; }
                    else if (v < 30) { bg = 'rgba(217, 119, 6, 0.24)'; color = 'var(--amber)'; }
                    else if (v > 180) { bg = 'rgba(124, 58, 237, 0.24)'; color = 'var(--purple)'; }
                    else { bg = 'rgba(5, 150, 105, 0.18)'; color = 'var(--emerald)'; }
                  } else if (v > 0) {
                    const ratio = Math.min(1, v / maxVal);
                    const alpha = (0.10 + ratio * 0.70).toFixed(2);
                    bg = `rgba(37, 99, 235, ${alpha})`;
                    if (ratio > 0.48) color = '#ffffff';
                  }

                  const txt = matrixMetric === 'sales'
                    ? `$${Math.round(v)}`
                    : (matrixMetric === 'dos' ? (v >= 999 ? '∞' : `${Math.round(v)}d`) : v);

                  return `
                    <td class="heat-cell" data-drill-msku="${esc(cell.msku)}" style="background:${bg};color:${color};" title="${esc(cell.msku)} · 点击查看明细">
                      ${txt}
                    </td>
                  `;
                }).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderInventory(d) {
  const { invBuckets, inventorySummary, skus } = d;
  const sorted = [...skus].sort((a, b) => a.dos - b.dos);
  const filtered = sorted.filter(s => invBucketFilter === 'ALL' || s.invStatus === invBucketFilter);

  const totalFba = inventorySummary.fbaTotal || 1;
  const sellablePct = ((inventorySummary.fbaSellable / totalFba) * 100).toFixed(1);
  const transitPct = ((inventorySummary.fbaTransit / totalFba) * 100).toFixed(1);
  const reservedPct = ((inventorySummary.fbaReserved / totalFba) * 100).toFixed(1);

  return `
    <!-- Top Inventory KPI Grid -->
    <div class="kpi-grid">
      <div class="kpi-card emerald">
        <div class="kpi-header"><span class="kpi-label">FBA 可售库存</span><span class="kpi-icon-pill">✅</span></div>
        <div class="kpi-val">${fmtInt(inventorySummary.fbaSellable)} <small>件</small></div>
        <div class="kpi-footer"><span class="pill emerald">占总量 ${sellablePct}%</span><span>可售 ${inventorySummary.d15EstSellableDays} 天</span></div>
      </div>

      <div class="kpi-card amber">
        <div class="kpi-header"><span class="kpi-label">FBA 在途补货</span><span class="kpi-icon-pill">🚚</span></div>
        <div class="kpi-val">${fmtInt(inventorySummary.fbaTransit)} <small>件</small></div>
        <div class="kpi-footer"><span class="pill amber">占总量 ${transitPct}%</span><span>在途转可售中</span></div>
      </div>

      <div class="kpi-card rose">
        <div class="kpi-header"><span class="kpi-label">断货高危红线 (&lt;15天)</span><span class="kpi-icon-pill">🚨</span></div>
        <div class="kpi-val">${inventorySummary.criticalDosCount} <small style="color:var(--rose)">SKU</small></div>
        <div class="kpi-footer"><span class="pill rose">急需红单补货</span><span>紧俏共 ${inventorySummary.lowDosCount} 个</span></div>
      </div>

      <div class="kpi-card purple">
        <div class="kpi-header"><span class="kpi-label">严重积压 (&gt;180天)</span><span class="kpi-icon-pill">💤</span></div>
        <div class="kpi-val">${inventorySummary.overstockCount} <small style="color:var(--purple)">SKU</small></div>
        <div class="kpi-footer"><span class="pill purple">需清仓降价</span><span>长尾滞销 SKU</span></div>
      </div>
    </div>

    <!-- Inventory Composition Stack -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title-group">
          <span style="font-size:14px;">📦</span>
          <h3 class="card-title">FBA 全仓库存状态结构（总计 ${fmtInt(totalFba)} 件）</h3>
        </div>
        <div style="font-size:11.5px;color:var(--text-muted);display:flex;gap:8px;">
          <span>可售 ${sellablePct}%</span> · <span>在途 ${transitPct}%</span> · <span>预留 ${reservedPct}%</span>
        </div>
      </div>
      <div class="stack-bar-wrap">
        <div class="stack-bar">
          <div class="stack-segment" style="width:${sellablePct}%;background:var(--emerald-gradient);" title="可售 ${sellablePct}%"></div>
          <div class="stack-segment" style="width:${transitPct}%;background:linear-gradient(135deg,#fbbf24,#d97706);" title="在途 ${transitPct}%"></div>
          <div class="stack-segment" style="width:${reservedPct}%;background:var(--primary-gradient);" title="预留 ${reservedPct}%"></div>
        </div>
      </div>
    </div>

    <!-- 5 Health Buckets Filter Cards -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title-group">
          <span style="font-size:14px;">🎯</span>
          <div>
            <h3 class="card-title">可售天数 (DOS) 5 档健康分层（点击卡片进行单选过滤）</h3>
            <div class="card-subtitle">按近15天真实消耗流速测算</div>
          </div>
        </div>
        ${invBucketFilter !== 'ALL' ? `<button class="btn" data-ibucket="ALL">显示全部 108 SKU</button>` : ''}
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;">
        ${invBuckets.map(b => {
          const isActive = invBucketFilter === b.key;
          return `
            <div class="row-click" data-ibucket="${esc(b.key)}" style="padding:11px 13px;border-radius:var(--radius-md);border:1.5px solid ${isActive ? 'var(--primary)' : 'var(--border-default)'};background:${isActive ? 'var(--primary-soft)' : 'var(--bg-surface)'};box-shadow:var(--shadow-sm);transition:all 0.15s ease;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span class="pill ${b.tone}">${esc(b.key)}</span>
                ${isActive ? '<span style="font-size:11px;color:var(--primary);font-weight:700;">● 激活中</span>' : ''}
              </div>
              <div style="font-size:16px;font-weight:800;margin:6px 0 2px;color:var(--text-main);">
                ${b.skusCount} <span style="font-size:12px;font-weight:500;color:var(--text-muted)">个 SKU</span> · ${fmtInt(b.fbaTotal)} <span style="font-size:12px;font-weight:500;color:var(--text-muted)">件</span>
              </div>
              <div style="font-size:11px;color:var(--text-muted);">
                占库存 <strong>${fmtPct1(b.fbaShare)}</strong> · 销售贡献 <strong>${fmtPct1(b.salesShare)}</strong>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <!-- Detailed Inventory Health Table -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title-group">
          <span style="font-size:14px;">⚠️</span>
          <h3 class="card-title">库存健康度与补货清理明细（当前展示 ${filtered.length} 个 SKU，按可售天数升序）</h3>
        </div>
      </div>
      <div class="tbl-wrap" style="max-height:480px;">
        <table>
          <thead>
            <tr>
              <th>MSKU</th>
              <th style="text-align:center;">状态评级</th>
              <th>DOS(天)</th>
              <th>可售</th>
              <th>预留</th>
              <th>在途</th>
              <th>总库存</th>
              <th>近7天日均</th>
              <th>近15天日均</th>
              <th style="text-align:left;">建议行动指南</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map(s => `
              <tr>
                <td><strong style="color:var(--text-main);">${esc(s.msku)}</strong></td>
                <td style="text-align:center;"><span class="pill ${s.invTone}">${esc(s.invStatus)}</span></td>
                <td><strong style="color:${s.dos < 15 ? 'var(--rose)' : (s.dos < 30 ? 'var(--amber)' : 'inherit')};">${s.dos} 天</strong></td>
                <td>${s.fbaSellable}</td>
                <td>${s.fbaReserved}</td>
                <td>${s.fbaTransit}</td>
                <td><strong>${s.fbaTotal}</strong></td>
                <td>${s.d7Avg.toFixed(2)}</td>
                <td>${s.d15Avg.toFixed(2)}</td>
                <td style="text-align:left;white-space:normal;min-width:240px;color:var(--text-muted);font-size:11.5px;">
                  ${esc(s.advice)}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderSkus(d) {
  const modelsList = [...new Set(d.models.map(m => m.model))];
  const colorsList = [...new Set(d.colors.map(c => c.color))];
  const q = skuSearch.trim().toLowerCase();

  let list = d.skus.filter(s => {
    if (q && !s.msku.toLowerCase().includes(q) && !s.asin.toLowerCase().includes(q) && !s.cnName.toLowerCase().includes(q)) return false;
    if (skuModelFilter !== 'ALL' && s.model !== skuModelFilter) return false;
    if (skuColorFilter !== 'ALL' && s.color !== skuColorFilter) return false;
    if (skuAbcFilter !== 'ALL' && s.abcClass !== skuAbcFilter) return false;
    return true;
  });

  list = [...list].sort((a, b) => {
    const va = a[skuSortKey] ?? 0, vb = b[skuSortKey] ?? 0;
    return typeof va === 'string' ? va.localeCompare(vb) * skuSortDir : (va - vb) * skuSortDir;
  });

  return `
    <!-- SKU Search & Multi-Filter Bar -->
    <div class="filter-bar">
      <div class="inp-wrap">
        <span class="inp-icon">🔍</span>
        <input id="sku-search" class="inp" type="text" placeholder="搜索 MSKU / ASIN / 品名..." value="${esc(skuSearch)}" />
      </div>

      <select id="sku-model" class="sel">
        <option value="ALL">全部机型 (${modelsList.length})</option>
        ${modelsList.map(m => `<option value="${esc(m)}" ${skuModelFilter === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}
      </select>

      <select id="sku-color" class="sel">
        <option value="ALL">全部颜色 (${colorsList.length})</option>
        ${colorsList.map(c => `<option value="${esc(c)}" ${skuColorFilter === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select>

      <select id="sku-abc" class="sel">
        <option value="ALL">全部 ABC 评级</option>
        <option value="A类核心" ${skuAbcFilter === 'A类核心' ? 'selected' : ''}>A类核心 (前80%营收)</option>
        <option value="B类中坚" ${skuAbcFilter === 'B类中坚' ? 'selected' : ''}>B类中坚 (80-95%)</option>
        <option value="C类长尾" ${skuAbcFilter === 'C类长尾' ? 'selected' : ''}>C类长尾 (末尾5%)</option>
      </select>

      <button class="btn" id="sku-reset">重置所有筛选</button>
      <span style="font-size:11.5px;color:var(--text-muted);margin-left:auto;">当前匹配 <strong>${list.length}</strong> / ${d.skus.length} SKU</span>
    </div>

    <!-- Quick Chips Filter -->
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
      <button class="seg-btn ${skuAbcFilter === 'ALL' && skuModelFilter === 'ALL' && skuColorFilter === 'ALL' ? 'active' : ''}" id="chip-all">全部 108 款</button>
      <button class="seg-btn ${skuAbcFilter === 'A类核心' ? 'active' : ''}" id="chip-a">⭐ A类核心爆款</button>
      <button class="seg-btn ${skuAbcFilter === 'B类中坚' ? 'active' : ''}" id="chip-b">⚡ B类中坚潜力</button>
      <button class="seg-btn ${skuAbcFilter === 'C类长尾' ? 'active' : ''}" id="chip-c">💤 C类长尾滞销</button>
    </div>

    <!-- Full SKU Table -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title-group">
          <span style="font-size:14px;">📦</span>
          <h3 class="card-title">全量 SKU 销售表现与库存动态（点击列头可任意升降序）</h3>
        </div>
      </div>
      <div class="tbl-wrap" style="max-height:560px;">
        <table>
          <thead>
            <tr>
              <th data-ssort="rank" style="text-align:center;">#</th>
              <th data-ssort="msku">MSKU / ASIN / 机型配色</th>
              <th style="text-align:center;">近30天走势</th>
              <th style="text-align:center;">ABC评级</th>
              <th data-ssort="totalUnits">总销量</th>
              <th data-ssort="totalSales">总销售额</th>
              <th data-ssort="d15Units">近15天销</th>
              <th data-ssort="d7Units">近7天销</th>
              <th data-ssort="fbaTotal">FBA总库存</th>
              <th data-ssort="dos" style="text-align:center;">DOS(天)</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(s => {
              const hex = COLOR_PALETTE[s.color] || '#64748b';
              return `
                <tr>
                  <td style="text-align:center;font-weight:700;color:var(--text-muted);">${s.rank}</td>
                  <td>
                    <div style="font-weight:700;color:var(--text-main);font-size:12.5px;">${esc(s.msku)}</div>
                    <div style="font-size:10.5px;color:var(--text-muted);margin-top:2px;display:flex;align-items:center;gap:6px;">
                      <span style="width:7px;height:7px;border-radius:50%;background:${hex};"></span>
                      <span>${esc(s.model)}</span>
                      <span>·</span>
                      <span>${esc(s.colorCn)}</span>
                      <span>·</span>
                      <span>${esc(s.asin)}</span>
                      <span>·</span>
                      <span>首单 ${s.firstSaleDate || '—'}</span>
                    </div>
                  </td>
                  <td style="text-align:center;">${renderSparkline(s.recent30DailyUnits)}</td>
                  <td style="text-align:center;">
                    <span class="pill ${s.abcClass === 'A类核心' ? 'emerald' : (s.abcClass === 'B类中坚' ? 'amber' : 'gray')}">
                      ${s.abcClass}
                    </span>
                  </td>
                  <td><strong>${s.totalUnits}</strong></td>
                  <td><strong style="color:var(--primary);">${fmtUsd(s.totalSales)}</strong></td>
                  <td>${s.d15Units} <span style="color:var(--text-muted);font-size:10px;">(${fmtUsd0(s.d15Sales)})</span></td>
                  <td>${s.d7Units}</td>
                  <td>
                    <strong>${s.fbaTotal}</strong>
                    <div style="font-size:10px;color:var(--text-muted);">售${s.fbaSellable} / 途${s.fbaTransit}</div>
                  </td>
                  <td style="text-align:center;">
                    <span class="pill ${s.invTone}">${s.dos}天</span>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// =============================================================================
// Saihu ERP Replenishment & Shipment Decision Tab
// =============================================================================
function renderSaihu(d) {
  const saihu = d.saihu || { summary: {}, needPurchList: [], replenishPlanList: [], purchInTransitList: [], localStockList: [], readyToShipList: [], overdueList: [], list: [] };
  const sum = saihu.summary || {};
  const needPurch = saihu.needPurchList || [];
  const replenishPlan = saihu.replenishPlanList || [];
  const purchTransit = saihu.purchInTransitList || [];
  const localStock = saihu.localStockList || [];
  const readyToShip = saihu.readyToShipList || [];
  const overdueList = saihu.overdueList || [];
  let allList = saihu.list || [];

  if (saihuSearch) {
    const q = saihuSearch.toLowerCase().trim();
    allList = allList.filter(x => (x.msku && x.msku.toLowerCase().includes(q)) || (x.asin && x.asin.toLowerCase().includes(q)) || (x.cnName && x.cnName.toLowerCase().includes(q)));
  }
  if (saihuFilter === 'NEED_PURCH') allList = allList.filter(x => x.isNeedPurchNoPo);
  else if (saihuFilter === 'PLAN') allList = allList.filter(x => x.isReplenishPlan);
  else if (saihuFilter === 'OVERDUE') allList = allList.filter(x => x.isOverdueOrStalled);
  else if (saihuFilter === 'PURCH_TRANSIT') allList = allList.filter(x => x.isPurchInTransit);
  else if (saihuFilter === 'LOCAL_STOCK') allList = allList.filter(x => x.isLocalStockAwaitingShip);
  else if (saihuFilter === 'CRITICAL_DOS') allList = allList.filter(x => x.dosInStock > 0 && x.dosInStock < 21);

  let subContentHtml = '';

  if (saihuSubTab === 'urgent') {
    subContentHtml = `
      <div class="card" style="margin-bottom:14px;border-left:4px solid var(--rose);">
        <div style="display:flex;align-items:flex-start;gap:12px;">
          <span style="font-size:22px;line-height:1;">🚨</span>
          <div>
            <div style="font-weight:700;font-size:13.5px;color:var(--text-main);margin-bottom:4px;">
              采购断货预警判定：全店共 ${needPurch.length} 款 MSKU 必须提前补货且目前【尚未采购】（无 PO 在途，本地零库存）
            </div>
            <div style="font-size:12px;color:var(--text-muted);line-height:1.6;">
              • <strong>红线断货告急（DOS &lt; 15天）</strong>：<strong>Moto Stylus 酒红 (DOS 6天)</strong>、<strong>黑色 (DOS 9天)</strong>、<strong>蓝色 (DOS 11天)</strong> 与 <strong>S24 Ultra 橙色 (DOS 12天)</strong>，赛狐建议采购日即为 <strong>今天 (2026-11-26)</strong>，建议即刻下达采购审批！<br>
              • <strong>特别注意</strong>：<strong>Moto G 5G 深紫 (DOS 13天)</strong> FBA即将断货，但国内本地仓已有 <strong>50件现货</strong>，赛狐建议 <strong>今天 11-26</strong> 立即排期发运 46件慢船，无需等待新采购！
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-hdr">
          <div class="card-title-group">
            <span style="font-size:14px;">📋</span>
            <div>
              <h3 class="card-title">待补货未采购明细表 (按在库 DOS 升序排列 · 红线断货优先级)</h3>
              <div class="card-subtitle">共 ${needPurch.length} 款 MSKU · 建议首批采购合计 ${needPurch.reduce((a, b) => a + (b.suggestedPurchB1 || 0), 0)} 件 / 建议总采购 ${needPurch.reduce((a, b) => a + (b.suggestedPurchTotal || 0), 0)} 件</div>
            </div>
          </div>
        </div>
        <div class="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th style="text-align:center;">优先级</th>
                <th>MSKU / ASIN / 中文名</th>
                <th style="text-align:center;">日均销量</th>
                <th style="text-align:center;">FBA在库可售</th>
                <th style="text-align:center;">在库DOS</th>
                <th style="text-align:center;">预计断货日</th>
                <th style="text-align:center;">建议采购日</th>
                <th style="text-align:center;">首批建议量</th>
                <th style="text-align:center;">建议总采购量</th>
                <th style="text-align:center;">建议补货量</th>
                <th style="text-align:center;">建议慢船/海运排期</th>
                <th style="text-align:center;">状态与行动</th>
              </tr>
            </thead>
            <tbody>
              ${needPurch.map((s, idx) => {
                const isCrit = s.dosInStock < 15;
                const isToday = s.suggestedPurchDate && s.suggestedPurchDate.includes('2026-11-26');
                return `
                  <tr style="${isCrit ? 'background:rgba(239,68,68,0.04);' : ''}">
                    <td style="text-align:center;font-weight:700;color:${isCrit ? 'var(--rose)' : 'var(--text-muted)'};">#${idx + 1}</td>
                    <td>
                      <div style="font-weight:700;color:var(--text-main);font-size:12.5px;">${esc(s.msku)}</div>
                      <div style="font-size:10.5px;color:var(--text-muted);margin-top:2px;">
                        <span>ASIN: ${esc(s.asin)}</span> · <span>${esc(s.cnName || '')}</span>
                      </div>
                    </td>
                    <td style="text-align:center;"><strong>${s.dailyAvg}</strong> <span style="font-size:10px;color:var(--text-muted);">件/天</span></td>
                    <td style="text-align:center;"><strong>${s.fbaSellable}</strong> 件</td>
                    <td style="text-align:center;">
                      <span class="pill ${s.dosInStock < 15 ? 'rose' : (s.dosInStock < 25 ? 'amber' : 'emerald')}">
                        ${s.dosInStock} 天
                      </span>
                    </td>
                    <td style="text-align:center;color:${isCrit ? 'var(--rose)' : 'var(--text-main)'};font-weight:600;">
                      ${s.stockoutDate || '—'}
                    </td>
                    <td style="text-align:center;">
                      ${isToday ? '<span class="pill rose">今日 11-26</span>' : `<span style="font-size:11.5px;">${s.suggestedPurchDate || '—'}</span>`}
                    </td>
                    <td style="text-align:center;"><strong style="color:var(--rose);">${s.suggestedPurchB1 || 0}</strong> 件</td>
                    <td style="text-align:center;"><strong>${s.suggestedPurchTotal || 0}</strong> 件</td>
                    <td style="text-align:center;"><strong style="color:var(--purple);">${s.suggestedReplenishTotal || 0}</strong> 件</td>
                    <td style="text-align:center;font-size:11px;color:var(--text-muted);">
                      ${esc([s.shipSlow, s.shipSea].filter(Boolean).join('; ') || '—')}
                    </td>
                    <td style="text-align:center;">
                      <span class="pill ${s.urgencyTone}">${s.urgencyBadge}</span>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } else if (saihuSubTab === 'plan') {
    subContentHtml = `
      <div class="card" style="margin-bottom:14px;border-left:4px solid var(--purple);">
        <div style="display:flex;align-items:flex-start;gap:12px;">
          <span style="font-size:22px;line-height:1;">📋</span>
          <div>
            <div style="font-weight:700;font-size:13.5px;color:var(--text-main);margin-bottom:4px;">
              全店智能补货计划（共 ${replenishPlan.length} 款有补货/发运排期 · 建议补货汇总 ${sum.totalSuggestedReplenishUnits || 0} 件 · 备货周期补货 ${sum.totalSuggestedReplenishCycleUnits || 0} 件）
            </div>
            <div style="font-size:12px;color:var(--text-muted);line-height:1.6;">
              • 涵盖赛狐「备货周期」「安全天数」「销量预测」「建议补货量（汇总/备货周期）」「建议采购量（汇总/备货周期）」及「第1批本地仓发FBA海运/慢船/空运排期」与「到货后可售库存量」。
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-hdr">
          <div class="card-title-group">
            <span style="font-size:14px;">🚢</span>
            <div>
              <h3 class="card-title">赛狐补货计划与多渠道发运排期表 (${replenishPlan.length} 款)</h3>
              <div class="card-subtitle">按在库 DOS 升序排列 · 清晰展示海运(35天)/慢船/空运(15天)第1批发货量与发货日</div>
            </div>
          </div>
        </div>
        <div class="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th style="text-align:center;">序号</th>
                <th>MSKU / ASIN / 中文名</th>
                <th style="text-align:center;">备货/安全天数</th>
                <th style="text-align:center;">销量预测</th>
                <th style="text-align:center;">在库DOS</th>
                <th style="text-align:center;">建议补货(汇总/周期)</th>
                <th style="text-align:center;">建议采购(汇总/周期)</th>
                <th style="text-align:center;">第1批海运/慢船量</th>
                <th style="text-align:center;">到货后可售</th>
                <th style="text-align:center;">建议采购日</th>
                <th>本地仓至FBA发货排期 (海运/空运/慢船)</th>
              </tr>
            </thead>
            <tbody>
              ${replenishPlan.map((s, idx) => {
                const isCrit = s.dosInStock <= 15;
                const shipParts = [
                  s.shipSea ? `海运: ${s.shipSea}` : '',
                  s.shipAir ? `空运: ${s.shipAir}` : '',
                  s.shipSlow ? `慢船: ${s.shipSlow}` : ''
                ].filter(Boolean).join('<br>');
                return `
                  <tr style="${isCrit ? 'background:rgba(239,68,68,0.04);' : ''}">
                    <td style="text-align:center;font-weight:700;color:var(--text-muted);">#${idx + 1}</td>
                    <td>
                      <div style="font-weight:700;color:var(--text-main);font-size:12px;">${esc(s.msku)}</div>
                      <div style="font-size:10.5px;color:var(--text-muted);margin-top:2px;">
                        <span>${esc(s.asin)}</span> · <span>${esc(s.cnName || '')}</span>
                      </div>
                    </td>
                    <td style="text-align:center;font-size:11px;">${s.leadCycle}天 / ${s.safetyDays}天</td>
                    <td style="text-align:center;">${s.salesForecast} 件</td>
                    <td style="text-align:center;">
                      <span class="pill ${s.dosInStock <= 15 ? 'rose' : (s.dosInStock <= 25 ? 'amber' : 'emerald')}">${s.dosInStock} 天</span>
                    </td>
                    <td style="text-align:center;">
                      <strong style="color:var(--purple);">${s.suggestedReplenishTotal}</strong>
                      <span style="font-size:10.5px;color:var(--text-muted);"> / ${s.suggestedReplenishCycle}</span>
                    </td>
                    <td style="text-align:center;">
                      <strong style="color:var(--rose);">${s.suggestedPurchTotal}</strong>
                      <span style="font-size:10.5px;color:var(--text-muted);"> / ${s.suggestedPurchCycle}</span>
                    </td>
                    <td style="text-align:center;font-size:11px;">
                      ${s.shipSeaB1Qty > 0 ? `海${s.shipSeaB1Qty}` : ''}${s.shipSeaB1Qty > 0 && s.shipSlowB1Qty > 0 ? ' / ' : ''}${s.shipSlowB1Qty > 0 ? `慢${s.shipSlowB1Qty}` : ''}${!s.shipSeaB1Qty && !s.shipSlowB1Qty ? '—' : ''}
                    </td>
                    <td style="text-align:center;"><strong>${s.afterArrivalSellable}</strong> 件</td>
                    <td style="text-align:center;font-size:11px;">${esc(s.suggestedPurchDate || '—')}</td>
                    <td style="font-size:11px;color:var(--text-muted);line-height:1.45;">${shipParts || '—'}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } else if (saihuSubTab === 'shipment' || saihuSubTab === 'overdue') {
    subContentHtml = `
      <div class="card" style="margin-bottom:14px;border-left:4px solid var(--amber);">
        <div style="display:flex;align-items:flex-start;gap:12px;">
          <span style="font-size:22px;line-height:1;">⏰</span>
          <div>
            <div style="font-weight:700;font-size:13.5px;color:var(--text-main);margin-bottom:4px;">
              采购超期（>15天未发货/未入库）与发货滞留专项排查：共 ${overdueList.length} 款存在超期或滞留风险
            </div>
            <div style="font-size:12px;color:var(--text-muted);line-height:1.6;">
              • <strong>数据口径说明</strong>：赛狐导出表未包含「PO下单创建日期」字段，因此将以下 4 类超期/滞留信号全部纳入专项核查：<br>
              &nbsp;&nbsp;1) <strong>采购在途 PO（${purchTransit.length}款 / ${sum.totalPurchTransitUnits || 0}件）</strong>：已下单在途未交付本地仓，重点排查下单超 15 天未交货款（尤其 <strong>S26Ultra 蓝色</strong> FBA仅剩 8天！）；<br>
              &nbsp;&nbsp;2) <strong>已采购入库超期未发 FBA（${localStock.length}款 / ${sum.totalLocalStockUnits || 0}件）</strong>：货已采购到国内仓但滞留未发出（如 <strong>IP17PM 酒红</strong> 50件滞留而FBA已断货0件、<strong>Moto G 深紫</strong> 50件滞留而FBA仅13天）；<br>
              &nbsp;&nbsp;3) <strong>已建单准备装运停滞（${readyToShip.length}款 / ${sum.totalReadyToShipUnits || 0}件 READY_TO_SHIP）</strong>：货件已建单但停滞未开船（Pixel11 黑/酒红、S25 红、IP17e 红）；<br>
              &nbsp;&nbsp;4) <strong>采购日今日到期未下单（${sum.purchDueTodayCount || 0}款）</strong>：建议采购日为今天 11-26 但仍未建 PO。
            </div>
          </div>
        </div>
      </div>

      <!-- 14 In-Transit PO Table -->
      <div class="card" style="margin-bottom:14px;">
        <div class="card-hdr">
          <div class="card-title-group">
            <span style="font-size:14px;">📦</span>
            <div>
              <h3 class="card-title">一、采购在途 PO 超期交期排查 (14 款 / ${sum.totalPurchTransitUnits || 0} 件 · 核查是否超15天未交货)</h3>
              <div class="card-subtitle">按 FBA 在库 DOS 升序排列 · 红色项需立即联系供应商追查交期并走空运/快船</div>
            </div>
          </div>
        </div>
        <div class="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th style="text-align:center;">序号</th>
                <th>MSKU / ASIN / 中文名</th>
                <th style="text-align:center;">采购在途量</th>
                <th style="text-align:center;">本地可用现货</th>
                <th style="text-align:center;">FBA在库可售</th>
                <th style="text-align:center;">在库DOS</th>
                <th style="text-align:center;">预计断货日</th>
                <th style="text-align:center;">建议慢船/海运排期</th>
                <th style="text-align:center;">采购超期诊断</th>
              </tr>
            </thead>
            <tbody>
              ${purchTransit.map((s, idx) => `
                <tr style="${s.dosInStock <= 15 ? 'background:rgba(239,68,68,0.04);' : ''}">
                  <td style="text-align:center;font-weight:700;color:var(--text-muted);">#${idx + 1}</td>
                  <td>
                    <div style="font-weight:700;color:var(--text-main);font-size:12px;">${esc(s.msku)}</div>
                    <div style="font-size:10.5px;color:var(--text-muted);margin-top:2px;">
                      <span>ASIN: ${esc(s.asin)}</span> · <span>${esc(s.cnName || '')}</span>
                    </div>
                  </td>
                  <td style="text-align:center;"><strong style="color:var(--primary);font-size:13px;">${s.purchTransit}</strong> 件</td>
                  <td style="text-align:center;">${s.localAvail > 0 ? `<strong style="color:var(--purple);">${s.localAvail}</strong> 件` : '0'}</td>
                  <td style="text-align:center;"><strong>${s.fbaSellable}</strong> 件</td>
                  <td style="text-align:center;">
                    <span class="pill ${s.dosInStock <= 15 ? 'rose' : (s.dosInStock < 30 ? 'amber' : 'emerald')}">${s.dosInStock} 天</span>
                  </td>
                  <td style="text-align:center;font-size:11.5px;">${s.stockoutDate || '—'}</td>
                  <td style="text-align:center;font-size:11px;color:var(--text-muted);">
                    ${esc([s.shipSlow, s.shipSea].filter(Boolean).join('; ') || '—')}
                  </td>
                  <td style="text-align:center;">
                    <span class="pill ${s.dosInStock <= 15 ? 'rose' : 'blue'}">
                      ${s.dosInStock <= 15 ? '🚨 疑超15天极危·急催' : '排查PO下单超15天'}
                    </span>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- 24 Local Stock Table -->
      <div class="card" style="margin-bottom:14px;">
        <div class="card-hdr">
          <div class="card-title-group">
            <span style="font-size:14px;">🏭</span>
            <div>
              <h3 class="card-title">二、已采购入库但本地仓滞留未发 FBA (${localStock.length} 款 / ${sum.totalLocalStockUnits || 0} 件现货)</h3>
              <div class="card-subtitle">按 FBA 在库周转 DOS 升序排列 · 货已采购却长期压在国内仓未发运</div>
            </div>
          </div>
        </div>
        <div class="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th style="text-align:center;">优先级</th>
                <th>MSKU / ASIN / 中文名</th>
                <th style="text-align:center;">本地可用现货</th>
                <th style="text-align:center;">FBA在库可售</th>
                <th style="text-align:center;">在库DOS</th>
                <th style="text-align:center;">预计断货日</th>
                <th style="text-align:center;">赛狐发运排期建议</th>
                <th style="text-align:center;">超期滞留评级</th>
              </tr>
            </thead>
            <tbody>
              ${localStock.map((s, idx) => {
                const isCrit = s.dosInStock < 25;
                const isZeroFba = s.fbaSellable === 0;
                return `
                  <tr style="${isCrit ? 'background:rgba(239,68,68,0.04);' : ''}">
                    <td style="text-align:center;font-weight:700;color:${isCrit ? 'var(--rose)' : 'var(--text-muted)'};">#${idx + 1}</td>
                    <td>
                      <div style="font-weight:700;color:var(--text-main);font-size:12px;">${esc(s.msku)}</div>
                      <div style="font-size:10.5px;color:var(--text-muted);margin-top:2px;">
                        <span>ASIN: ${esc(s.asin)}</span> · <span>${esc(s.cnName || '')}</span>
                      </div>
                    </td>
                    <td style="text-align:center;"><strong style="color:var(--purple);font-size:13px;">${s.localAvail}</strong> 件</td>
                    <td style="text-align:center;">
                      ${isZeroFba ? '<span class="pill rose">断货 0件</span>' : `<strong>${s.fbaSellable}</strong> 件`}
                    </td>
                    <td style="text-align:center;">
                      <span class="pill ${s.dosInStock < 15 ? 'rose' : (s.dosInStock < 30 ? 'amber' : 'emerald')}">${s.dosInStock} 天</span>
                    </td>
                    <td style="text-align:center;font-size:11.5px;color:${isCrit ? 'var(--rose)' : 'var(--text-main)'};">
                      ${s.stockoutDate || '—'}
                    </td>
                    <td style="text-align:center;font-size:11px;color:var(--text-muted);">
                      ${esc([s.shipSlow, s.shipSea, s.shipAir].filter(Boolean).join('; ') || '—')}
                    </td>
                    <td style="text-align:center;">
                      <span class="pill ${isCrit ? 'rose' : 'purple'}">
                        ${isCrit ? '🚨 超期未发·今日建单' : '本地仓滞留待发'}
                      </span>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- 4 READY_TO_SHIP Stalled Table -->
      <div class="card">
        <div class="card-hdr">
          <div class="card-title-group">
            <span style="font-size:14px;">🚢</span>
            <div>
              <h3 class="card-title">三、已建单准备装运停滞 (READY_TO_SHIP · ${readyToShip.length} 款 / ${sum.totalReadyToShipUnits || 0} 件)</h3>
              <div class="card-subtitle">已创建 FBA 货件但处于准备装运状态尚未发出，需排查货代提货/开船是否超期</div>
            </div>
          </div>
        </div>
        <div class="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th style="text-align:center;">序号</th>
                <th>MSKU / ASIN / 中文名</th>
                <th style="text-align:center;">准备装运(件)</th>
                <th style="text-align:center;">FBA可售</th>
                <th style="text-align:center;">FBA在途</th>
                <th style="text-align:center;">在库DOS</th>
                <th style="text-align:center;">状态诊断</th>
              </tr>
            </thead>
            <tbody>
              ${readyToShip.map((s, idx) => `
                <tr>
                  <td style="text-align:center;font-weight:700;color:var(--text-muted);">#${idx + 1}</td>
                  <td>
                    <div style="font-weight:700;color:var(--text-main);font-size:12px;">${esc(s.msku)}</div>
                    <div style="font-size:10.5px;color:var(--text-muted);margin-top:2px;">
                      <span>${esc(s.asin)}</span> · <span>${esc(s.cnName || '')}</span>
                    </div>
                  </td>
                  <td style="text-align:center;"><strong style="color:var(--amber);font-size:13px;">${s.readyToShip}</strong> 件</td>
                  <td style="text-align:center;">${s.fbaSellable === 0 ? '<span class="pill rose">0 件</span>' : `${s.fbaSellable} 件`}</td>
                  <td style="text-align:center;">${s.fbaTransit} 件</td>
                  <td style="text-align:center;"><span class="pill ${s.dosInStock <= 15 ? 'rose' : 'gray'}">${s.dosInStock} 天</span></td>
                  <td style="text-align:center;"><span class="pill amber">货件停滞·催货代发出</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } else {
    // Sub-tab 4: Full 136 table
    subContentHtml = `
      <div class="card">
        <div class="card-hdr" style="flex-wrap:wrap;gap:10px;">
          <div class="card-title-group">
            <span style="font-size:14px;">📋</span>
            <div>
              <h3 class="card-title">赛狐 ERP 全量补货建议台账 (${allList.length} / 136 款)</h3>
              <div class="card-subtitle">支持 MSKU / ASIN 检索与补货计划、采购超期等分类筛选</div>
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <input type="text" class="inp" id="saihu-search" placeholder="搜索 MSKU / ASIN / 中文名..." value="${esc(saihuSearch)}" style="width:210px;">
            <div class="seg-bar">
              <button class="seg-btn ${saihuFilter === 'ALL' ? 'active' : ''}" data-sfilter="ALL">全部 (136)</button>
              <button class="seg-btn ${saihuFilter === 'NEED_PURCH' ? 'active' : ''}" data-sfilter="NEED_PURCH">待采购 (${needPurch.length})</button>
              <button class="seg-btn ${saihuFilter === 'PLAN' ? 'active' : ''}" data-sfilter="PLAN">补货计划 (${replenishPlan.length})</button>
              <button class="seg-btn ${saihuFilter === 'OVERDUE' ? 'active' : ''}" data-sfilter="OVERDUE">超期/滞留 (${overdueList.length})</button>
              <button class="seg-btn ${saihuFilter === 'PURCH_TRANSIT' ? 'active' : ''}" data-sfilter="PURCH_TRANSIT">在途PO (${purchTransit.length})</button>
              <button class="seg-btn ${saihuFilter === 'LOCAL_STOCK' ? 'active' : ''}" data-sfilter="LOCAL_STOCK">本地仓 (${localStock.length})</button>
              <button class="seg-btn ${saihuFilter === 'CRITICAL_DOS' ? 'active' : ''}" data-sfilter="CRITICAL_DOS">DOS&lt;21天</button>
            </div>
            <button class="btn" id="saihu-reset" style="padding:4px 9px;font-size:11.5px;">重置</button>
          </div>
        </div>
        <div class="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th style="text-align:center;">序号</th>
                <th>MSKU / ASIN</th>
                <th style="text-align:center;">状态</th>
                <th style="text-align:center;">日均销</th>
                <th style="text-align:center;">FBA可售</th>
                <th style="text-align:center;">在库DOS</th>
                <th style="text-align:center;">本地可用</th>
                <th style="text-align:center;">采购在途</th>
                <th style="text-align:center;">建议补货</th>
                <th style="text-align:center;">建议采购</th>
                <th style="text-align:center;">建议采购日</th>
                <th style="text-align:center;">建议发FBA排期</th>
              </tr>
            </thead>
            <tbody>
              ${allList.map((s, idx) => `
                <tr>
                  <td style="text-align:center;color:var(--text-muted);font-weight:600;">${idx + 1}</td>
                  <td>
                    <div style="font-weight:700;color:var(--text-main);font-size:12px;">${esc(s.msku)}</div>
                    <div style="font-size:10.5px;color:var(--text-muted);margin-top:1px;">
                      <span>${esc(s.asin)}</span> · <span>${esc(s.cnName || '')}</span>
                    </div>
                  </td>
                  <td style="text-align:center;">
                    <span class="pill ${s.urgencyTone}">${s.urgencyBadge}</span>
                  </td>
                  <td style="text-align:center;">${s.dailyAvg}</td>
                  <td style="text-align:center;"><strong>${s.fbaSellable}</strong></td>
                  <td style="text-align:center;">
                    <span class="pill ${s.dosInStock < 15 ? 'rose' : (s.dosInStock < 30 ? 'amber' : 'emerald')}">${s.dosInStock}天</span>
                  </td>
                  <td style="text-align:center;">${s.localAvail > 0 ? `<strong style="color:var(--purple);">${s.localAvail}</strong>` : '0'}</td>
                  <td style="text-align:center;">${s.purchTransit > 0 ? `<strong style="color:var(--primary);">${s.purchTransit}</strong>` : '0'}</td>
                  <td style="text-align:center;">${s.suggestedReplenishTotal > 0 ? `<strong style="color:var(--purple);">${s.suggestedReplenishTotal}</strong>` : '0'}</td>
                  <td style="text-align:center;">${s.suggestedPurchTotal > 0 ? `<strong style="color:var(--rose);">${s.suggestedPurchTotal}</strong>` : '0'}</td>
                  <td style="text-align:center;font-size:11px;">${s.suggestedPurchDate || '—'}</td>
                  <td style="text-align:center;font-size:10.5px;color:var(--text-muted);">${esc([s.shipSlow, s.shipSea, s.shipAir].filter(Boolean).join('; ') || '—')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  return `
    <!-- Top KPI Cards for Saihu Replenishment -->
    <div class="kpi-grid">
      <div class="kpi-card" style="border-color:rgba(239,68,68,0.3);background:linear-gradient(180deg, rgba(239,68,68,0.08) 0%, var(--bg-surface) 100%);">
        <div class="kpi-hdr">
          <span class="kpi-lbl">待采购告急（未建PO）</span>
          <span class="pill rose">🚨 需即刻下单</span>
        </div>
        <div class="kpi-val" style="color:var(--rose);">${sum.needPurchCount || 0} <span style="font-size:14px;color:var(--text-muted);font-weight:500;">款 SKU</span></div>
        <div class="kpi-sub">
          建议总采购 <strong style="color:var(--text-main);">${sum.totalSuggestedPurchUnits || 0} 件</strong> · 今日到期未采 ${sum.purchDueTodayCount || 0} 款
        </div>
      </div>

      <div class="kpi-card" style="border-color:rgba(168,85,247,0.3);background:linear-gradient(180deg, rgba(168,85,247,0.08) 0%, var(--bg-surface) 100%);">
        <div class="kpi-hdr">
          <span class="kpi-lbl">全店补货计划（含备货周期）</span>
          <span class="pill purple">📋 补货排期</span>
        </div>
        <div class="kpi-val" style="color:var(--purple);">${sum.replenishPlanCount || replenishPlan.length} <span style="font-size:14px;color:var(--text-muted);font-weight:500;">款 SKU</span></div>
        <div class="kpi-sub">
          补货汇总 <strong style="color:var(--text-main);">${sum.totalSuggestedReplenishUnits || 0} 件</strong> · 周期补货 ${sum.totalSuggestedReplenishCycleUnits || 0} 件
        </div>
      </div>

      <div class="kpi-card" style="border-color:rgba(245,158,11,0.3);background:linear-gradient(180deg, rgba(245,158,11,0.08) 0%, var(--bg-surface) 100%);">
        <div class="kpi-hdr">
          <span class="kpi-lbl">采购超期与发货滞留预警</span>
          <span class="pill amber">⏰ 排查&gt;15天</span>
        </div>
        <div class="kpi-val" style="color:var(--amber);">${sum.overdueCount || overdueList.length} <span style="font-size:14px;color:var(--text-muted);font-weight:500;">款 SKU</span></div>
        <div class="kpi-sub">
          在途 <strong style="color:var(--text-main);">${sum.totalPurchTransitUnits || 0}件</strong> · 本地 <strong style="color:var(--text-main);">${sum.totalLocalStockUnits || 0}件</strong> · 待装 ${sum.totalReadyToShipUnits || 0}件
        </div>
      </div>

      <div class="kpi-card" style="border-color:rgba(37,99,235,0.3);background:linear-gradient(180deg, rgba(37,99,235,0.08) 0%, var(--bg-surface) 100%);">
        <div class="kpi-hdr">
          <span class="kpi-lbl">FBA 断货红线 (&lt;15天DOS)</span>
          <span class="pill blue">⏳ 断货警戒</span>
        </div>
        <div class="kpi-val" style="color:var(--primary);">${sum.criticalDosCount || 0} <span style="font-size:14px;color:var(--text-muted);font-weight:500;">款 SKU</span></div>
        <div class="kpi-sub">
          Stylus酒红(6d) / S26U蓝(8d) / Stylus黑(9d) / G深紫(13d)
        </div>
      </div>
    </div>

    <!-- Saihu Sub-navigation segment -->
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px;">
      <div class="seg-bar">
        <button class="seg-btn ${saihuSubTab === 'urgent' ? 'active' : ''}" data-ssub="urgent">
          🚨 待采购告急 (${needPurch.length}款)
        </button>
        <button class="seg-btn ${saihuSubTab === 'plan' ? 'active' : ''}" data-ssub="plan">
          📋 补货计划 (${replenishPlan.length}款)
        </button>
        <button class="seg-btn ${(saihuSubTab === 'shipment' || saihuSubTab === 'overdue') ? 'active' : ''}" data-ssub="shipment">
          ⏰ 采购超期与发货滞留 (${overdueList.length}款)
        </button>
        <button class="seg-btn ${saihuSubTab === 'all' ? 'active' : ''}" data-ssub="all">
          📑 全量 136 台账
        </button>
      </div>
      <div style="font-size:11.5px;color:var(--text-muted);">
        数据源：赛狐 ERP 智能补货模型建议 · 匹配全量 108 销售 MSKU
      </div>
    </div>

    ${subContentHtml}
  `;
}

// =============================================================================
// Main Render & Event Wiring
// =============================================================================
function render() {
  const root = document.getElementById('root');
  if (!payload || !payload.data) {
    root.innerHTML = `
      <div class="loading-wrap">
        <div class="spinner"></div>
        <div style="font-weight:600;font-size:13px;color:var(--text-main);">正在等待 UPBestKS 销售数据...</div>
      </div>
    `;
    return;
  }
  const d = payload.data;
  const { meta } = d;

  let bodyHtml = '';
  if (activeTab === 'overview') bodyHtml = renderOverview(d);
  else if (activeTab === 'models') bodyHtml = renderModels(d);
  else if (activeTab === 'colors') bodyHtml = renderColors(d);
  else if (activeTab === 'inventory') bodyHtml = renderInventory(d);
  else if (activeTab === 'saihu') bodyHtml = renderSaihu(d);
  else bodyHtml = renderSkus(d);

  root.innerHTML = `
    <!-- Top Executive Header -->
    <div class="topbar">
      <div class="brand-wrap">
        <div class="brand-icon">UP</div>
        <div class="brand-info">
          <h1>
            UPBestKS 销售与库存数据决策看板
            <span class="brand-badge"><span class="dot"></span> 实时已连通</span>
          </h1>
          <div class="brand-meta">
            <span>🏬 店铺：<strong>${esc(meta.store)} (${esc(meta.site)})</strong></span>
            <span class="sep">/</span>
            <span>📅 周期：<strong>${meta.earliestDate} ~ ${meta.latestDate}</strong> (${meta.totalDays}天)</span>
            <span class="sep">/</span>
            <span>📱 规模：<strong>14款机型 · 108全量SKU</strong></span>
            <span class="sep">/</span>
            <span style="color:var(--text-light);">刷新于 ${esc(payload.refreshedAt)}</span>
          </div>
        </div>
      </div>
      <div class="top-actions">
        <button class="btn" id="btn-refresh">🔄 刷新数据</button>
        <button class="btn primary" id="btn-excel">📊 导出 Excel (9表原生图表)</button>
      </div>
    </div>

    <!-- Segmented Navigation Tabs -->
    <div class="nav-tabs">
      <button class="tab-btn ${activeTab === 'overview' ? 'active' : ''}" data-tab="overview">
        <span>📈</span> 销售总览
      </button>
      <button class="tab-btn ${activeTab === 'models' ? 'active' : ''}" data-tab="models">
        <span>📱</span> 分机型对比 <span class="badge">14</span>
      </button>
      <button class="tab-btn ${activeTab === 'colors' ? 'active' : ''}" data-tab="colors">
        <span>🎨</span> 颜色结构与矩阵 <span class="badge">8</span>
      </button>
      <button class="tab-btn ${activeTab === 'inventory' ? 'active' : ''}" data-tab="inventory">
        <span>📦</span> 库存预警分层 <span class="badge">5档</span>
      </button>
      <button class="tab-btn ${activeTab === 'saihu' ? 'active' : ''}" data-tab="saihu">
        <span>🚚</span> 赛狐补货决策 <span class="badge" style="background:var(--rose-soft);color:var(--rose);">136</span>
      </button>
      <button class="tab-btn ${activeTab === 'skus' ? 'active' : ''}" data-tab="skus">
        <span>🔍</span> 全量 SKU 明细 <span class="badge">108</span>
      </button>
    </div>

    <!-- Tab Content -->
    ${bodyHtml}
  `;

  bindEvents(d);
}

function bindEvents(d) {
  document.getElementById('btn-refresh')?.addEventListener('click', refreshLive);
  document.getElementById('btn-excel')?.addEventListener('click', exportExcel);

  // Tab switching
  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
    activeTab = b.dataset.tab;
    render();
  }));
  document.querySelectorAll('[data-period]').forEach(b => b.addEventListener('click', () => {
    periodKey = b.dataset.period;
    render();
  }));
  document.querySelectorAll('[data-cmetric]').forEach(b => b.addEventListener('click', () => {
    chartMetric = b.dataset.cmetric;
    render();
  }));
  document.querySelectorAll('[data-crange]').forEach(b => b.addEventListener('click', () => {
    chartRange = b.dataset.crange;
    render();
  }));
  document.querySelectorAll('[data-cohort]').forEach(b => b.addEventListener('click', () => {
    cohortFilter = b.dataset.cohort;
    render();
  }));
  document.querySelectorAll('[data-mmetric]').forEach(b => b.addEventListener('click', () => {
    matrixMetric = b.dataset.mmetric;
    render();
  }));
  document.querySelectorAll('[data-ibucket]').forEach(b => b.addEventListener('click', () => {
    const val = b.dataset.ibucket;
    invBucketFilter = (invBucketFilter === val && val !== 'ALL') ? 'ALL' : val;
    render();
  }));

  // Quick chips
  document.getElementById('chip-all')?.addEventListener('click', () => {
    skuAbcFilter = 'ALL'; skuModelFilter = 'ALL'; skuColorFilter = 'ALL'; skuSearch = '';
    render();
  });
  document.getElementById('chip-a')?.addEventListener('click', () => { skuAbcFilter = 'A类核心'; render(); });
  document.getElementById('chip-b')?.addEventListener('click', () => { skuAbcFilter = 'B类中坚'; render(); });
  document.getElementById('chip-c')?.addEventListener('click', () => { skuAbcFilter = 'C类长尾'; render(); });

  // Model & Color drilldown to SKUs
  document.querySelectorAll('[data-drill-model], .model-bar-g').forEach(el => el.addEventListener('click', () => {
    skuModelFilter = el.dataset.drillModel || el.dataset.model;
    skuColorFilter = 'ALL';
    skuSearch = '';
    activeTab = 'skus';
    render();
    showToast(`已筛选机型: ${skuModelFilter}`, '📱');
  }));
  document.querySelectorAll('[data-drill-color]').forEach(el => el.addEventListener('click', () => {
    skuColorFilter = el.dataset.drillColor;
    skuModelFilter = 'ALL';
    skuSearch = '';
    activeTab = 'skus';
    render();
    showToast(`已筛选颜色: ${skuColorFilter}`, '🎨');
  }));
  document.querySelectorAll('[data-drill-msku]').forEach(el => el.addEventListener('click', () => {
    skuSearch = el.dataset.drillMsku;
    skuModelFilter = 'ALL';
    skuColorFilter = 'ALL';
    activeTab = 'skus';
    render();
    showToast(`已定位 MSKU: ${skuSearch}`, '🔍');
  }));

  // Column sorting
  document.querySelectorAll('[data-msort]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.msort;
    if (modelSortKey === k) modelSortDir *= -1;
    else { modelSortKey = k; modelSortDir = -1; }
    render();
  }));
  document.querySelectorAll('[data-ssort]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.ssort;
    if (skuSortKey === k) skuSortDir *= -1;
    else { skuSortKey = k; skuSortDir = k === 'rank' ? 1 : -1; }
    render();
  }));

  // SKU filters
  const searchEl = document.getElementById('sku-search');
  if (searchEl) {
    searchEl.addEventListener('input', (e) => {
      skuSearch = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const ns = document.getElementById('sku-search');
      if (ns) { ns.focus(); ns.setSelectionRange(pos, pos); }
    });
  }
  document.getElementById('sku-model')?.addEventListener('change', e => { skuModelFilter = e.target.value; render(); });
  document.getElementById('sku-color')?.addEventListener('change', e => { skuColorFilter = e.target.value; render(); });
  document.getElementById('sku-abc')?.addEventListener('change', e => { skuAbcFilter = e.target.value; render(); });
  document.getElementById('sku-reset')?.addEventListener('click', () => {
    skuSearch = ''; skuModelFilter = 'ALL'; skuColorFilter = 'ALL'; skuAbcFilter = 'ALL';
    render();
    showToast('已重置所有筛选', '✓');
  });

  // Saihu Sub-tab & filter bindings
  document.querySelectorAll('[data-ssub]').forEach(b => b.addEventListener('click', () => {
    saihuSubTab = b.dataset.ssub;
    render();
  }));
  document.querySelectorAll('[data-sfilter]').forEach(b => b.addEventListener('click', () => {
    const val = b.dataset.sfilter;
    saihuFilter = (saihuFilter === val && val !== 'ALL') ? 'ALL' : val;
    render();
  }));
  const sSearchEl = document.getElementById('saihu-search');
  if (sSearchEl) {
    sSearchEl.addEventListener('input', (e) => {
      saihuSearch = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const ns = document.getElementById('saihu-search');
      if (ns) { ns.focus(); ns.setSelectionRange(pos, pos); }
    });
  }
  document.getElementById('saihu-reset')?.addEventListener('click', () => {
    saihuSearch = ''; saihuFilter = 'ALL';
    render();
    showToast('已重置补货筛选', '✓');
  });

  // Daily Chart Interactive Crosshair & Tooltip
  const svg = document.getElementById('daily-svg');
  const tip = document.getElementById('tooltip');
  const crosshairLine = document.getElementById('crosshair-line');
  const crosshairDot = document.getElementById('crosshair-dot');

  if (svg && tip) {
    const n = Number(svg.dataset.range || 104);
    const rows = d.daily.slice(-n);
    const padT = 20, H = 250, padB = 40, ch = H - padT - padB;
    const maxV = Math.max(...rows.map(x => Math.max(chartMetric === 'sales' ? x.sales : x.units, chartMetric === 'sales' ? x.ma7Sales : x.ma7Units)), 1) * 1.15;

    svg.querySelectorAll('.day-hit').forEach(rect => {
      rect.addEventListener('mouseenter', (ev) => {
        const idx = Number(rect.dataset.idx);
        const day = rows[idx];
        if (!day) return;

        const cx = Number(rect.dataset.cx);
        const maVal = chartMetric === 'sales' ? day.ma7Sales : day.ma7Units;
        const cy = padT + ch - (maVal / maxV) * ch;

        if (crosshairLine) {
          crosshairLine.setAttribute('x1', cx);
          crosshairLine.setAttribute('x2', cx);
          crosshairLine.setAttribute('opacity', '1');
        }
        if (crosshairDot) {
          crosshairDot.setAttribute('cx', cx);
          crosshairDot.setAttribute('cy', cy);
          crosshairDot.setAttribute('opacity', '1');
        }

        tip.innerHTML = `
          <div class="tooltip-title">
            <span>📅</span>
            <span>${day.date} (${day.weekday})</span>
          </div>
          <div>总销售额：<strong style="color:var(--primary);">${fmtUsd(day.sales)}</strong> (${day.units} 件 / ${day.orders} 单)</div>
          <div style="margin-top:3px;display:flex;gap:8px;">
            <span>🔵 老品：<strong>${fmtUsd(day.legacySales)}</strong> (${day.legacyUnits}件)</span>
            <span>🟣 新品：<strong>${fmtUsd(day.newSales)}</strong> (${day.newUnits}件)</span>
          </div>
          <div style="margin-top:4px;color:var(--text-muted);font-size:10.5px;border-top:1px solid #334155;padding-top:4px;">
            7日均线：${fmtUsd(day.ma7Sales)} · ASP ${fmtUsd(day.asp)} · 动销 ${day.activeSkus} SKU
          </div>
        `;
        tip.style.display = 'block';
        tip.style.left = Math.min(window.innerWidth - 280, ev.clientX + 14) + 'px';
        tip.style.top = Math.max(10, ev.clientY - 85) + 'px';
      });

      rect.addEventListener('mousemove', (ev) => {
        tip.style.left = Math.min(window.innerWidth - 280, ev.clientX + 14) + 'px';
        tip.style.top = Math.max(10, ev.clientY - 85) + 'px';
      });

      rect.addEventListener('mouseleave', () => {
        tip.style.display = 'none';
        if (crosshairLine) crosshairLine.setAttribute('opacity', '0');
        if (crosshairDot) crosshairDot.setAttribute('opacity', '0');
      });
    });
  }
}

// =============================================================================
// MCP App SDK Handshake
// =============================================================================
app.ontoolinput = ({ arguments: args }) => {
  if (args?.tab) activeTab = args.tab;
};

app.ontoolresult = (result) => {
  if (result?.structuredContent) {
    payload = result.structuredContent;
    if (payload.initialTab) activeTab = payload.initialTab;
    render();
  }
};

app.onhostcontextchanged = (ctx) => {
  if (ctx?.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.setAttribute('data-theme', ctx.theme);
  }
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

(async () => {
  await app.connect();
  const ctx = app.getHostContext();
  if (ctx?.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.setAttribute('data-theme', ctx.theme);
  }
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
})();