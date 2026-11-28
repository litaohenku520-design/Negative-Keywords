// UPBestKS 纯 SVG 高性能可视化图表库（现代高级 SaaS 视觉标准）

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const usd = (v) => `$${Number(v || 0).toFixed(2)}`;
const pct = (v) => `${(Number(v || 0) * 100).toFixed(1)}%`;

/**
 * 渲染分组柱状图 (Grouped Bar Chart)
 */
export function renderGroupedBarChart({
  title,
  subtitle = '',
  categories = [],
  series = [],
  unit = '',
  valFmt = (v) => unit === '$' ? usd(v) : unit === '%' ? pct(v) : Number(v || 0).toLocaleString(),
  height = 220,
  width = 560,
  showValOnTop = false,
  rotateX = false,
}) {
  const padL = 52, padR = 20, padT = 32, padB = rotateX ? 46 : 28;
  const pW = width - padL - padR;
  const pH = height - padT - padB;

  const allVals = series.flatMap(s => (s.data || []).map(v => Number(v || 0)));
  const rawMax = Math.max(...allVals, 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const norm = rawMax / mag;
  const niceMultiplier = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const maxVal = Math.max(niceMultiplier * mag, rawMax * 1.05);

  const nCat = Math.max(categories.length, 1);
  const nSer = Math.max(series.length, 1);
  const slotW = pW / nCat;
  const grpW = slotW * 0.78;
  const barW = Math.max(Math.min(grpW / nSer - 2, 28), 4);
  const grpPad = (slotW - (barW + 2) * nSer) / 2;

  // Y轴背景网格线 (4档)
  const yTicks = [0, maxVal * 0.333, maxVal * 0.667, maxVal];
  const gridLines = yTicks.map(t => {
    const y = padT + pH - (t / maxVal) * pH;
    return `
      <line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="currentColor" stroke-opacity="0.08" stroke-dasharray="3,3" />
      <text x="${padL - 8}" y="${y + 3.5}" text-anchor="end" font-size="10" font-family="inherit" fill="currentColor" fill-opacity="0.55">${valFmt(t)}</text>
    `;
  }).join('');

  // 柱子生成
  const bars = categories.map((cat, ci) => {
    const xBase = padL + ci * slotW + grpPad;
    const catBars = series.map((ser, si) => {
      const v = Number(ser.data[ci] || 0);
      const bH = Math.max((v / maxVal) * pH, v > 0 ? 3 : 0);
      const bx = xBase + si * (barW + 2);
      const by = padT + pH - bH;
      const topLabel = showValOnTop && bH > 14 ? `<text x="${bx + barW / 2}" y="${by - 4}" text-anchor="middle" font-size="9.5" font-weight="700" font-family="inherit" fill="currentColor">${valFmt(v)}</text>` : '';
      return `
        <rect x="${bx}" y="${by}" width="${barW}" height="${bH}" rx="3" fill="${ser.color}" style="transition: opacity 0.2s; cursor: pointer;">
          <title>${esc(cat)} - ${esc(ser.name)}: ${valFmt(v)}</title>
        </rect>
        ${topLabel}
      `;
    }).join('');

    const cx = padL + (ci + 0.5) * slotW;
    const cy = padT + pH + 16;
    const xTxt = rotateX
      ? `<text x="${cx}" y="${cy}" text-anchor="end" transform="rotate(-35, ${cx}, ${cy})" font-size="9" font-family="inherit" fill="currentColor" fill-opacity="0.7">${esc(cat)}</text>`
      : `<text x="${cx}" y="${cy}" text-anchor="middle" font-size="10" font-family="inherit" fill="currentColor" fill-opacity="0.7">${esc(cat)}</text>`;

    return `<g>${catBars}${xTxt}</g>`;
  }).join('');

  const legendHtml = series.map(s => `
    <span class="lg-item"><span class="lg-dot" style="background:${s.color}"></span>${esc(s.name)}</span>
  `).join('');

  return `
    <div class="chart-box">
      <div class="chart-hdr">
        <div>
          <h3>${esc(title)}</h3>
          ${subtitle ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">${esc(subtitle)}</div>` : ''}
        </div>
        <div class="chart-legend">${legendHtml}</div>
      </div>
      <svg viewBox="0 0 ${width} ${height}" class="chart-svg" style="color:var(--text)">
        ${gridLines}
        ${bars}
        <line x1="${padL}" y1="${padT + pH}" x2="${width - padR}" y2="${padT + pH}" stroke="currentColor" stroke-opacity="0.2" />
      </svg>
    </div>
  `;
}

/**
 * 渲染每日 ACoS 彩色柱状图 (带45.2%目标参考线与60%警戒线)
 */
export function renderAcosBarChart({
  title,
  subtitle = '',
  categories = [],
  acosValues = [],
  targetVal = 0.452,
  warnVal = 0.60,
  height = 220,
  width = 560,
}) {
  const padL = 48, padR = 24, padT = 32, padB = 30;
  const pW = width - padL - padR;
  const pH = height - padT - padB;

  const maxVal = Math.max(...acosValues, warnVal * 1.25, 0.80);
  const slotW = pW / Math.max(categories.length, 1);
  const barW = Math.max(slotW * 0.66, 8);

  const yTarget = padT + pH - (targetVal / maxVal) * pH;
  const yWarn = padT + pH - (warnVal / maxVal) * pH;

  const bars = categories.map((cat, i) => {
    const v = Number(acosValues[i] || 0);
    const bH = Math.max((v / maxVal) * pH, v > 0 ? 3 : 0);
    const bx = padL + i * slotW + (slotW - barW) / 2;
    const by = padT + pH - bH;
    const color = v <= targetVal ? '#10b981' : (v <= warnVal ? '#f59e0b' : '#f43f5e');
    const txtY = by > padT + 14 ? by - 4 : by + 12;
    const txtFill = by > padT + 14 ? 'currentColor' : '#ffffff';

    return `
      <g>
        <rect x="${bx}" y="${by}" width="${barW}" height="${bH}" rx="3" fill="${color}">
          <title>${esc(cat)}: ACoS ${pct(v)}</title>
        </rect>
        <text x="${bx + barW / 2}" y="${txtY}" text-anchor="middle" font-size="9" font-weight="700" font-family="inherit" fill="${txtFill}">${(v * 100).toFixed(1)}%</text>
        <text x="${bx + barW / 2}" y="${padT + pH + 16}" text-anchor="middle" font-size="9.5" font-family="inherit" fill="currentColor" fill-opacity="0.7">${esc(cat)}</text>
      </g>
    `;
  }).join('');

  return `
    <div class="chart-box">
      <div class="chart-hdr">
        <div>
          <h3>${esc(title)}</h3>
          ${subtitle ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">${esc(subtitle)}</div>` : ''}
        </div>
        <div class="chart-legend">
          <span class="lg-item"><span class="lg-dot" style="background:#10b981"></span>达标 ≤45.2%</span>
          <span class="lg-item"><span class="lg-dot" style="background:#f59e0b"></span>偏高 45.2~60%</span>
          <span class="lg-item"><span class="lg-dot" style="background:#f43f5e"></span>失控 &gt;60%</span>
        </div>
      </div>
      <svg viewBox="0 0 ${width} ${height}" class="chart-svg" style="color:var(--text)">
        <line x1="${padL}" y1="${padT + pH}" x2="${width - padR}" y2="${padT + pH}" stroke="currentColor" stroke-opacity="0.2" />
        
        <!-- 60% 警戒参考线 -->
        <line x1="${padL}" y1="${yWarn}" x2="${width - padR}" y2="${yWarn}" stroke="#f43f5e" stroke-width="1.2" stroke-dasharray="4,3" />
        <text x="${width - padR + 4}" y="${yWarn + 3.5}" font-size="9" fill="#f43f5e" font-weight="700" font-family="inherit">60% 警戒</text>
        
        <!-- 45.2% 目标参考线 -->
        <line x1="${padL}" y1="${yTarget}" x2="${width - padR}" y2="${yTarget}" stroke="#10b981" stroke-width="1.5" stroke-dasharray="4,2" />
        <text x="${width - padR + 4}" y="${yTarget + 3.5}" font-size="9" fill="#10b981" font-weight="700" font-family="inherit">45.2% 目标</text>

        ${bars}
      </svg>
    </div>
  `;
}

/**
 * 渲染横向排名柱状图 (Horizontal Ranking Bar Chart)
 */
export function renderHorizontalBarChart({
  title,
  subtitle = '',
  items = [],
  targetVal = 0.452,
  unit = '%',
  maxVal = 1.0,
  height = null,
  width = 560,
}) {
  const rowH = 24;
  const padT = 30, padB = 18, padL = 145, padR = 90;
  const h = height || (items.length * rowH + padT + padB);
  const pW = width - padL - padR;

  const targetX = padL + (targetVal / maxVal) * pW;

  const rows = items.map((it, idx) => {
    const y = padT + idx * rowH;
    const bW = Math.max(Math.min((it.value / maxVal) * pW, pW), it.value > 0 ? 3 : 0);
    const color = it.color || (it.value <= targetVal ? '#10b981' : it.value <= 0.60 ? '#f59e0b' : '#f43f5e');

    return `
      <g>
        <text x="${padL - 10}" y="${y + 12}" text-anchor="end" font-size="10.5" font-weight="600" font-family="inherit" fill="currentColor">${esc(it.label)}</text>
        <rect x="${padL}" y="${y + 2}" width="${pW}" height="13" rx="3" fill="currentColor" fill-opacity="0.06" />
        <rect x="${padL}" y="${y + 2}" width="${bW}" height="13" rx="3" fill="${color}">
          <title>${esc(it.label)}: ${(it.value * 100).toFixed(1)}% (${esc(it.sublabel || '')})</title>
        </rect>
        <text x="${padL + pW + 8}" y="${y + 12}" font-size="10" font-weight="700" font-family="inherit" fill="${color}">
          ${(it.value * 100).toFixed(1)}% <tspan font-size="9" font-weight="normal" fill="var(--text-sub)">${esc(it.deltaText || '')}</tspan>
        </text>
      </g>
    `;
  }).join('');

  return `
    <div class="chart-box">
      <div class="chart-hdr">
        <div>
          <h3>${esc(title)}</h3>
          ${subtitle ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">${esc(subtitle)}</div>` : ''}
        </div>
        <div class="chart-legend">
          <span class="lg-item"><span class="lg-dot" style="background:#10b981"></span>≤45.2% 达标</span>
          <span class="lg-item"><span class="lg-dot" style="background:#f59e0b"></span>45.2~60% 观察</span>
          <span class="lg-item"><span class="lg-dot" style="background:#f43f5e"></span>&gt;60% 严重</span>
        </div>
      </div>
      <svg viewBox="0 0 ${width} ${h}" class="chart-svg" style="color:var(--text)">
        <line x1="${targetX}" y1="${padT - 8}" x2="${targetX}" y2="${h - padB}" stroke="#10b981" stroke-width="1.3" stroke-dasharray="3,2" />
        <text x="${targetX}" y="${padT - 12}" text-anchor="middle" font-size="9" fill="#10b981" font-weight="700" font-family="inherit">45.2% 目标</text>
        ${rows}
      </svg>
    </div>
  `;
}

/**
 * 渲染 3 大广告位综合诊断卡片组 (高质感微型进度条)
 */
export function renderPlacementVisualCards(p14Items = [], p7Items = []) {
  const p14Map = Object.fromEntries(p14Items.map(x => [x.pl, x]));
  const p7Map = Object.fromEntries(p7Items.map(x => [x.pl, x]));

  const plOrder = [
    { pl: '搜索结果顶部（首页）', name: 'TOS 搜索顶部（首页）', badge: '黄金位置 · 必须加权保护', badgeCls: 'b-green', barColor: '#10b981' },
    { pl: '搜索结果其余位置', name: 'ROS 搜索其余位置', badge: '主出血源 · 60%花费 · 必须压Bid', badgeCls: 'b-red', barColor: '#f43f5e' },
    { pl: '商品详情页', name: 'PP 商品详情页', badge: '漏水严重 · 73% ACoS · 削弱溢价', badgeCls: 'b-amber', barColor: '#f59e0b' }
  ];

  return `
    <div class="kpi-grid" style="grid-template-columns: repeat(3, 1fr); margin-bottom: 16px;">
      ${plOrder.map(cfg => {
        const d14 = p14Map[cfg.pl] || {};
        const d7 = p7Map[cfg.pl] || {};
        const acos14 = d14.acos || 0;
        const acos7 = d7.acos || 0;
        const cvr14 = d14.cvr || 0;
        const cvr7 = d7.cvr || 0;
        const spendShare7 = (d7.spendShare || 0) * 100;
        const acosColor = acos7 <= 0.452 ? 'var(--green)' : acos7 <= 0.60 ? 'var(--amber)' : 'var(--red)';

        return `
          <div class="kpi-card" style="--accent-bar: ${cfg.barColor}">
            <div class="kpi-top">
              <span class="kpi-label" style="font-size: 13px; font-weight: 700; color: var(--text)">${esc(cfg.name)}</span>
              <span class="badge ${cfg.badgeCls}">${cfg.badge}</span>
            </div>
            <div style="font-size: 12px; color: var(--text-muted); margin: 6px 0 10px;">
              近7天花费 <b>${usd(d7.spend)}</b> (占 <b>${spendShare7.toFixed(1)}%</b>) · 产出 <b>${d7.ord || 0}单</b> <span style="color:var(--text-sub)">(14天${d14.ord || 0}单)</span>
            </div>
            
            <!-- ACoS 14d vs 7d 对比条 -->
            <div style="margin-bottom: 8px;">
              <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:3px;">
                <span style="color:var(--text-muted)">ACoS 14天 <b>${pct(acos14)}</b> → 近7天 <b>${pct(acos7)}</b></span>
                <span style="color:${acosColor}; font-weight:700">${acos7 > acos14 ? '+' : ''}${((acos7 - acos14)*100).toFixed(1)}pp</span>
              </div>
              <div class="metric-bar-bg">
                <div class="metric-bar-fill" style="width:${Math.min(acos7 * 100, 100)}%; background:${acosColor}"></div>
              </div>
            </div>

            <!-- CVR 14d vs 7d 对比条 -->
            <div style="margin-bottom: 4px;">
              <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:3px;">
                <span style="color:var(--text-muted)">CVR 14天 <b>${pct(cvr14)}</b> → 近7天 <b>${pct(cvr7)}</b></span>
                <span style="color:var(--text-sub)">CPC ${usd(d7.cpc)} <span style="font-size:9.5px">(14d ${usd(d14.cpc)})</span></span>
              </div>
              <div class="metric-bar-bg">
                <div class="metric-bar-fill" style="width:${Math.min(cvr7 * 300, 100)}%; background:var(--blue)"></div>
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}
