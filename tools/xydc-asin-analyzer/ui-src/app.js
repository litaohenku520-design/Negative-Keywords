import { App } from '@modelcontextprotocol/ext-apps';
import {
  DEFAULT_ASIN_DATA,
  DEFAULT_HISTORY,
  DEFAULT_COMPARE_DATA,
  DEFAULT_KEYWORD_DATA,
  DEFAULT_CATEGORY_DATA,
  DEFAULT_BREAKOUT_DATA,
  DEFAULT_QUOTA_DATA,
  TOOLS_METADATA,
  DEFAULT_PIPELINE_STATS,
  DEFAULT_EXECUTION_MANIFEST,
} from './default_data.js';

const app = new App({ name: '西柚洞察·全维亚马逊跨境情报总台', version: '3.0.0' }, {});

// Formatters
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString());
const fmtPrice = (p) => (p == null ? '—' : `$${Number(p).toFixed(2)}`);
const fmtPct = (p) => (p == null ? '—' : `${(Number(p) * 100).toFixed(1)}%`);

function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg><span>${msg}</span>`;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// Master State
const initialData = DEFAULT_ASIN_DATA || {};
if (!initialData.pipelineStats) initialData.pipelineStats = DEFAULT_PIPELINE_STATS;
if (!initialData.toolsExecutionManifest) initialData.toolsExecutionManifest = DEFAULT_EXECUTION_MANIFEST;

let state = {
  mainTab: 'asin', // 'asin' | 'compare' | 'keyword' | 'category' | 'breakout' | 'tools' | 'quota'
  country: 'US',
  loading: false,
  loadingMsg: '',

  // Tab 1: Single ASIN 360 & 62 Pipeline
  activeAsin: initialData?.asin || 'B0768N9N6M',
  data: initialData,
  asinSubTab: 'overview', // 'overview' | 'matrix62' | 'traffic' | 'trends' | 'keywords' | 'variations' | 'ads'
  manifestFilterCategory: 'ALL',
  inspectingToolName: null,
  kwSearchQuery: '',
  cogs: Math.round((initialData?.product?.price || 20) * 0.22 * 10) / 10,
  shippingCost: Math.round((initialData?.product?.price || 20) * 0.08 * 10) / 10,

  // Tab 2: Compare
  compareInput: 'B0768N9N6M, B00MNV8E0C',
  compareData: DEFAULT_COMPARE_DATA || null,

  // Tab 3: Keyword Explorer
  keywordInput: 'coffee pods',
  keywordData: DEFAULT_KEYWORD_DATA || null,

  // Tab 4: Category Market
  categoryQuery: 'coffee',
  categoryCycleDate: '2026-10-01',
  categoryData: DEFAULT_CATEGORY_DATA || null,

  // Tab 5: Breakout
  breakoutData: DEFAULT_BREAKOUT_DATA || null,

  // Tab 6: 62 Tools Playground
  toolsCatalog: TOOLS_METADATA || [],
  selectedToolName: 'find_related_keywords',
  toolFilterCategory: 'ALL',
  toolSearchQuery: '',
  toolArgsText: JSON.stringify({ country: 'US', keyword: 'coffee pods' }, null, 2),
  toolExecutionResult: null,
  toolExecuting: false,

  // Tab 7: Quota & History
  quota: DEFAULT_QUOTA_DATA || null,
  history: DEFAULT_HISTORY || [],
};

// =============================================================================
// Action Triggers
// =============================================================================
async function trigger62AsinDeepDive(asin, country = state.country) {
  const cleanAsin = (asin || '').trim().toUpperCase();
  if (!cleanAsin) {
    showToast('请输入有效的亚马逊 10 位 ASIN');
    return;
  }
  state.loading = true;
  state.loadingMsg = `正在并发调度 62 项 MCP 原生底层工具全息穿透 ASIN ${cleanAsin}...`;
  state.activeAsin = cleanAsin;
  state.country = country;
  render();

  try {
    const res = await app.callServerTool({
      name: 'analyze_asin',
      arguments: { asin: cleanAsin, country },
    });
    if (res?.structuredContent?.data) {
      state.data = res.structuredContent.data;
      const p = state.data?.product?.price || 20;
      state.cogs = Math.round(p * 0.22 * 10) / 10;
      state.shippingCost = Math.round(p * 0.08 * 10) / 10;
      if (res.structuredContent.history) state.history = res.structuredContent.history;
      showToast(`ASIN ${cleanAsin} 62项底层工具全息穿透完成`);
    } else if (res?.structuredContent?.error) {
      showToast(`查询失败: ${res.structuredContent.error}`);
    }
  } catch (err) {
    console.warn('ASIN analyze tool note:', err);
    showToast(`ASIN 查询异常: ${err.message || '请稍后重试'}`);
  } finally {
    state.loading = false;
    render();
  }
}

async function triggerCompareAnalysis(asinsStr, country = state.country) {
  const asins = (asinsStr || '')
    .split(/[,，\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z0-9]{10}$/.test(s));

  if (asins.length < 2) {
    showToast('对比分析至少需要输入 2 个标准 10 位 ASIN');
    return;
  }

  state.loading = true;
  state.loadingMsg = `正在拉取 ${asins.join(' vs ')} 共有词库与竞争矩阵...`;
  render();

  try {
    const res = await app.callServerTool({
      name: 'compare_asins',
      arguments: { asins, country },
    });
    if (res?.structuredContent?.compareData) {
      state.compareData = res.structuredContent.compareData;
      showToast(`已完成 ${asins.length} 款竞品攻防矩阵对比`);
    }
  } catch (err) {
    showToast(`对比分析异常: ${err.message || '查询失败'}`);
  } finally {
    state.loading = false;
    render();
  }
}

async function triggerKeywordAnalysis(keyword, country = state.country) {
  const cleanKeyword = (keyword || '').trim();
  if (!cleanKeyword) {
    showToast('请输入有效的关键词');
    return;
  }

  state.loading = true;
  state.loadingMsg = `正在反查关键词 "${cleanKeyword}" ABA 排位与衍生词矩阵...`;
  render();

  try {
    const res = await app.callServerTool({
      name: 'analyze_keyword',
      arguments: { keyword: cleanKeyword, country },
    });
    if (res?.structuredContent?.keywordData) {
      state.keywordData = res.structuredContent.keywordData;
      showToast(`关键词 "${cleanKeyword}" 情报挖掘完成`);
    }
  } catch (err) {
    showToast(`关键词查询异常: ${err.message || '查询失败'}`);
  } finally {
    state.loading = false;
    render();
  }
}

async function triggerCategorySearch(query, country = state.country) {
  state.loading = true;
  state.loadingMsg = `正在检索 "${query || '大盘'}" 对应亚马逊类目市场体量...`;
  render();

  try {
    const res = await app.callServerTool({
      name: 'search_categories',
      arguments: { query: query || '', country, cycleDate: state.categoryCycleDate },
    });
    if (res?.structuredContent?.categoryData) {
      state.categoryData = res.structuredContent.categoryData;
      showToast(`类目检索完成，共 ${state.categoryData.categories.length} 个类目`);
    }
  } catch (err) {
    showToast(`类目检索异常: ${err.message || '查询失败'}`);
  } finally {
    state.loading = false;
    render();
  }
}

async function triggerBreakoutScan(country = state.country) {
  state.loading = true;
  state.loadingMsg = '正在扫描近期亚马逊黑马高爆发潜力爆款...';
  render();

  try {
    const res = await app.callServerTool({
      name: 'discover_breakouts',
      arguments: { country },
    });
    if (res?.structuredContent?.breakoutData) {
      state.breakoutData = res.structuredContent.breakoutData;
      showToast(`黑马雷达已捕获 ${state.breakoutData.products.length} 款爆发新品`);
    }
  } catch (err) {
    showToast(`黑马扫描异常: ${err.message || '查询失败'}`);
  } finally {
    state.loading = false;
    render();
  }
}

async function triggerDirectToolExecution(toolName, argsObj) {
  state.toolExecuting = true;
  render();

  try {
    const res = await app.callServerTool({
      name: 'execute_mcp_tool',
      arguments: { tool_name: toolName, arguments: argsObj },
    });
    const resultData = res?.structuredContent?.mcpExecution?.result || res?.structuredContent || res;

    if (state.data?.toolsExecutionManifest) {
      const item = state.data.toolsExecutionManifest.find((m) => m.name === toolName);
      if (item) {
        item.status = 'SUCCESS';
        item.data = resultData;
        item.latency = res?.structuredContent?.mcpExecution?.duration || 320;
        item.costCredits = res?.structuredContent?.mcpExecution?.costCredits || 2;
      }
    }

    state.toolExecutionResult = { success: true, data: resultData, time: new Date().toLocaleTimeString() };
    showToast(`MCP 原生工具 ${toolName} 执行成功`);
  } catch (err) {
    state.toolExecutionResult = { success: false, error: err.message || String(err), time: new Date().toLocaleTimeString() };
    showToast(`MCP 执行报错: ${err.message || '未知异常'}`);
  } finally {
    state.toolExecuting = false;
    render();
  }
}

async function triggerRefreshQuota() {
  state.loading = true;
  state.loadingMsg = '正在同步西柚账户最新点数配额...';
  render();

  try {
    const res = await app.callServerTool({ name: 'get_quota', arguments: {} });
    if (res?.structuredContent?.quota) {
      state.quota = res.structuredContent.quota;
      showToast('账户配额已同步');
    }
  } catch (err) {
    showToast(`配额刷新异常: ${err.message}`);
  } finally {
    state.loading = false;
    render();
  }
}

// =============================================================================
// UI Renderers (Crisp White Enterprise Theme)
// =============================================================================
function renderNavbar() {
  const remaining = state.quota?.monthly?.remaining != null ? fmtNum(state.quota.monthly.remaining) : (state.data?.quota?.monthlyRemaining ? fmtNum(state.data.quota.monthlyRemaining) : '59,719');
  return `
    <header style="background: #ffffff; border-bottom: 1px solid var(--border); padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 50; box-shadow: var(--shadow-sm);">
      <div style="display: flex; align-items: center; gap: 12px;">
        <div style="width: 34px; height: 34px; border-radius: 9px; background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); display: flex; align-items: center; justify-content: center; box-shadow: 0 3px 10px rgba(249, 115, 22, 0.25);">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        </div>
        <div>
          <div style="font-size: 14.5px; font-weight: 800; color: #0f172a; letter-spacing: -0.3px; display: flex; align-items: center; gap: 8px;">
            西柚洞察 · 全维跨境情报总台
            <span class="badge badge-orange" style="font-size: 10px; padding: 2px 7px;">62项 MCP 全量就绪</span>
          </div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 1px;">
            白昼专业版 · ASIN 62工具穿透 / 多竞品PK / 关键词ABA / 类目大盘 / 黑马选品
          </div>
        </div>
      </div>

      <div style="display: flex; align-items: center; gap: 10px;">
        <div style="background: #f8fafc; border: 1px solid var(--border); border-radius: 20px; padding: 4px 11px; display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-muted);">
          <span style="display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #10b981;"></span>
          <span>点数余额: <strong style="color: #0f172a; font-family: var(--font-mono);">${remaining}</strong></span>
        </div>

        <select id="countrySelect" style="background: #ffffff; border: 1px solid #cbd5e1; color: #0f172a; border-radius: var(--radius-sm); padding: 5px 10px; font-size: 12px; font-weight: 600; cursor: pointer; outline: none;">
          <option value="US" ${state.country === 'US' ? 'selected' : ''}>🇺🇸 美国 (US)</option>
          <option value="UK" ${state.country === 'UK' ? 'selected' : ''}>🇬🇧 英国 (UK)</option>
          <option value="DE" ${state.country === 'DE' ? 'selected' : ''}>🇩🇪 德国 (DE)</option>
          <option value="JP" ${state.country === 'JP' ? 'selected' : ''}>🇯🇵 日本 (JP)</option>
          <option value="CA" ${state.country === 'CA' ? 'selected' : ''}>🇨🇦 加拿大 (CA)</option>
          <option value="FR" ${state.country === 'FR' ? 'selected' : ''}>🇫🇷 法国 (FR)</option>
          <option value="IT" ${state.country === 'IT' ? 'selected' : ''}>🇮🇹 意大利 (IT)</option>
          <option value="ES" ${state.country === 'ES' ? 'selected' : ''}>🇪🇸 西班牙 (ES)</option>
        </select>
      </div>
    </header>
  `;
}

function renderMainTabs() {
  const tabs = [
    { id: 'asin', label: '🎯 ASIN 62工具穿透', badge: '全量联动' },
    { id: 'compare', label: '⚔️ 多竞品攻防PK', badge: '词库交集' },
    { id: 'keyword', label: '🔍 关键词与ABA', badge: '大盘拓词' },
    { id: 'category', label: '📈 类目大盘与竞争', badge: '市场体量' },
    { id: 'breakout', label: '🚀 黑马新品选品', badge: '高爆发' },
    { id: 'tools', label: '⚡ 62项全能工具箱', badge: '自由调用' },
    { id: 'quota', label: '💳 账户额度', badge: '监控' },
  ];

  return `
    <div style="background: #ffffff; border-bottom: 1px solid var(--border); padding: 8px 16px; overflow-x: auto; display: flex; gap: 6px; align-items: center;">
      ${tabs
        .map(
          (t) => `
        <button class="main-tab-btn" data-tab="${t.id}" style="
          background: ${state.mainTab === t.id ? '#fff7ed' : 'transparent'};
          border: 1px solid ${state.mainTab === t.id ? '#fdba74' : 'transparent'};
          color: ${state.mainTab === t.id ? '#c2410c' : '#475569'};
          padding: 6px 12px;
          border-radius: var(--radius-sm);
          font-weight: ${state.mainTab === t.id ? '700' : '500'};
          font-size: 12.5px;
          display: flex;
          align-items: center;
          gap: 6px;
          cursor: pointer;
          white-space: nowrap;
          transition: all 0.16s ease;
        ">
          <span>${t.label}</span>
          <span style="font-size: 10px; padding: 1px 6px; border-radius: 10px; background: ${state.mainTab === t.id ? '#f97316' : '#f1f5f9'}; color: ${state.mainTab === t.id ? '#ffffff' : '#64748b'};">${t.badge}</span>
        </button>
      `
        )
        .join('')}
    </div>
  `;
}

// -----------------------------------------------------------------------------
// Tab 1: ASIN 62-Tool Holographic Penetration Cockpit
// -----------------------------------------------------------------------------
function renderTabAsin() {
  const d = state.data || {};
  const p = d.product || {};
  const t = d.traffic || {};
  const s = d.sales || {};
  const b = d.bsr || {};
  const k = d.keywords || { list: [] };
  const v = d.variations || { childAsins: [] };
  const ad = d.adOverview || {};
  const stats = d.pipelineStats || DEFAULT_PIPELINE_STATS;
  const manifest = d.toolsExecutionManifest || DEFAULT_EXECUTION_MANIFEST;

  const filteredKw = (k.list || []).filter((kw) => {
    if (!state.kwSearchQuery) return true;
    const q = state.kwSearchQuery.toLowerCase();
    return (kw.searchTerm || '').toLowerCase().includes(q) || (kw.searchTermZh || '').toLowerCase().includes(q);
  });

  // Profit Calculator math
  const price = p.price || 14.39;
  const fba = p.fbaFee || 3.74;
  const referral = price * 0.15;
  const netMarginBeforeAd = price - fba - referral - state.cogs - state.shippingCost;
  const breakEvenAcos = price > 0 ? Math.max(0, netMarginBeforeAd / price) : 0;

  return `
    <div style="padding: 18px 20px; display: flex; flex-direction: column; gap: 16px;">
      <!-- Search Bar -->
      <div class="panel-card" style="padding: 16px; display: flex; flex-direction: column; gap: 12px;">
        <div style="display: flex; gap: 10px;">
          <input id="asinInput" type="text" value="${state.activeAsin}" placeholder="输入任意 10 位亚马逊 ASIN (例如 B0H7R2X98W)，立即触发 62 项工具全息穿透..." style="flex: 1; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: var(--radius-sm); padding: 9px 14px; font-size: 13.5px; color: #0f172a; outline: none; font-family: var(--font-mono); font-weight: 700;">
          <button id="btnStart62Analysis" class="btn btn-primary" style="padding: 0 22px; font-size: 13px;">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            <span>62项工具全息穿透</span>
          </button>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; font-size: 11.5px; color: var(--text-muted);">
          <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <span>快速切换样本:</span>
            <button class="sample-tag btn btn-secondary btn-sm" data-asin="B0H7R2X98W">📱 B0H7R2X98W (UPBestKS 钱包壳)</button>
            <button class="sample-tag btn btn-secondary btn-sm" data-asin="B0768N9N6M">☕ B0768N9N6M (Nespresso 标杆)</button>
            <button class="sample-tag btn btn-secondary btn-sm" data-asin="B00MNV8E0C">🔋 B00MNV8E0C (AmazonBasics)</button>
          </div>
          <span style="color: #ea580c; font-weight: 600;">⚡ 并发穿透 + 自动级联拓词</span>
        </div>
      </div>

      <!-- 62-Tool Execution Pipeline Status Banner -->
      <div style="background: linear-gradient(135deg, #ffffff 0%, #fffaf5 100%); border: 1px solid #fed7aa; border-radius: var(--radius-md); padding: 14px 18px; display: flex; flex-direction: column; gap: 10px; box-shadow: var(--shadow-sm);">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <div style="width: 28px; height: 28px; border-radius: 6px; background: #fff7ed; border: 1px solid #fdba74; display: flex; align-items: center; justify-content: center; color: #ea580c;">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            </div>
            <div>
              <div style="font-size: 13px; font-weight: 800; color: #0f172a;">62 项 MCP 原生底层工具全息透视与执行态矩阵</div>
              <div style="font-size: 11px; color: #475569;">
                当前 ASIN: <strong style="color: #0284c7; font-family: var(--font-mono);">${d.asin || state.activeAsin}</strong> · 
                已并发穿透 <strong style="color: #059669;">${stats.executedCount || 27}</strong> / ${stats.totalTools || 62} 项 · 
                智能待命 <strong style="color: #d97706;">${stats.standbyCount || 35}</strong> 项 · 
                耗时 <strong style="color: #0f172a;">${((stats.totalPipelineDuration || 1850) / 1000).toFixed(2)}s</strong>
              </div>
            </div>
          </div>
          <button class="btn btn-secondary btn-sm" id="btnToggleMatrixSubtab">
            <span>查看 62 工具明细清单</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        </div>

        <div style="display: flex; gap: 5px; flex-wrap: wrap; max-height: 76px; overflow-y: auto;">
          ${manifest
            .map(
              (m) => `
            <div class="hologram-chip" data-toolname="${m.name}" style="
              background: ${m.status === 'SUCCESS' ? '#ecfdf5' : m.status === 'CASCADED' ? '#f0f9ff' : '#fffbeb'};
              border: 1px solid ${m.status === 'SUCCESS' ? '#a7f3d0' : m.status === 'CASCADED' ? '#bae6fd' : '#fde68a'};
              color: ${m.status === 'SUCCESS' ? '#047857' : m.status === 'CASCADED' ? '#0369a1' : '#b45309'};
              padding: 2px 7px;
              border-radius: 4px;
              font-size: 10.5px;
              font-family: var(--font-mono);
              display: flex;
              align-items: center;
              gap: 4px;
              cursor: pointer;
              transition: all 0.15s ease;
            " title="${m.summary}">
              <span style="display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: currentColor;"></span>
              <span>${m.name}</span>
              ${m.latency ? `<span style="opacity: 0.75; font-size: 9.5px;">${m.latency}ms</span>` : ''}
            </div>
          `
            )
            .join('')}
        </div>
      </div>

      <!-- Hero Card -->
      <div class="panel-card" style="padding: 18px 20px; display: flex; gap: 18px; align-items: flex-start;">
        ${p.mainImage ? `<img src="${p.mainImage}" alt="Product" style="width: 96px; height: 96px; object-fit: contain; background: #f8fafc; border-radius: var(--radius-sm); border: 1px solid var(--border); padding: 4px; flex-shrink: 0;">` : ''}
        <div style="flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px;">
            <span class="badge badge-orange">${d.country || 'US'} 站点</span>
            <span class="badge badge-cyan">${p.brand || '品牌未明'}</span>
            <span style="font-family: var(--font-mono); font-size: 12px; font-weight: 700; color: #334155;">${d.asin}</span>
            <span style="font-size: 11px; color: var(--text-dim); margin-left: auto;">上架: ${p.streetDate || '—'} · 更新: ${d.analyzedAt || '—'}</span>
          </div>
          <div style="font-size: 15px; font-weight: 700; color: #0f172a; line-height: 1.4; margin-bottom: 12px;">${p.title}</div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(125px, 1fr)); gap: 10px;">
            <div style="background: #f8fafc; border: 1px solid var(--border); padding: 8px 12px; border-radius: var(--radius-sm);">
              <div style="font-size: 11px; color: var(--text-muted);">现售价</div>
              <div style="font-size: 16px; font-weight: 800; color: #ea580c;">${fmtPrice(p.price)}</div>
            </div>
            <div style="background: #f8fafc; border: 1px solid var(--border); padding: 8px 12px; border-radius: var(--radius-sm);">
              <div style="font-size: 11px; color: var(--text-muted);">近30天销量</div>
              <div style="font-size: 16px; font-weight: 800; color: #059669;">${fmtNum(s.last30dOrders)} <span style="font-size: 11px; font-weight: 400;">单</span></div>
            </div>
            <div style="background: #f8fafc; border: 1px solid var(--border); padding: 8px 12px; border-radius: var(--radius-sm);">
              <div style="font-size: 11px; color: var(--text-muted);">近7天总流量</div>
              <div style="font-size: 16px; font-weight: 800; color: #0284c7;">${fmtNum(t.totalTraffic)}</div>
            </div>
            <div style="background: #f8fafc; border: 1px solid var(--border); padding: 8px 12px; border-radius: var(--radius-sm);">
              <div style="font-size: 11px; color: var(--text-muted);">BSR 排名</div>
              <div style="font-size: 16px; font-weight: 800; color: #e11d48;">#${b.mainRank ? b.mainRank.rank : '—'}</div>
            </div>
            <div style="background: #f8fafc; border: 1px solid var(--border); padding: 8px 12px; border-radius: var(--radius-sm);">
              <div style="font-size: 11px; color: var(--text-muted);">评分口碑</div>
              <div style="font-size: 16px; font-weight: 800; color: #d97706;">★ ${p.stars || '—'} <span style="font-size: 11px; font-weight: 400; color: var(--text-muted);">(${fmtNum(p.ratings)})</span></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Sub Navigation Bar -->
      <div style="border-bottom: 1px solid var(--border); display: flex; gap: 6px; overflow-x: auto; padding-bottom: 6px;">
        ${[
          { id: 'overview', label: '六维雷达与利润测算' },
          { id: 'matrix62', label: `⚡ 62项工具明细 (${manifest.length})` },
          { id: 'traffic', label: '自然/广告流量结构' },
          { id: 'trends', label: '多维历史趋势' },
          { id: 'keywords', label: `核心流量词 (${k.list.length})` },
          { id: 'variations', label: `变体列表 (${v.childAsins.length})` },
          { id: 'ads', label: `父体广告 (${ad.campaignsCount || 0})` },
        ]
          .map(
            (st) => `
          <button class="asin-subtab-btn" data-subtab="${st.id}" style="
            background: ${state.asinSubTab === st.id ? '#0f172a' : '#ffffff'};
            border: 1px solid ${state.asinSubTab === st.id ? '#0f172a' : '#cbd5e1'};
            color: ${state.asinSubTab === st.id ? '#ffffff' : '#334155'};
            padding: 5px 12px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            white-space: nowrap;
          ">${st.label}</button>
        `
          )
          .join('')}
      </div>

      <!-- Subtab Contents -->
      ${
        state.asinSubTab === 'overview'
          ? `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px;">
          <!-- Radar Card -->
          <div class="panel-card" style="padding: 18px;">
            <div style="font-size: 13.5px; font-weight: 700; color: #0f172a; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
              <span>六维竞争力雷达</span>
              <span class="badge badge-orange">综合评分: ${d.overallScore}/100</span>
            </div>
            <div style="display: flex; justify-content: center; padding: 6px 0;">
              ${renderRadarSvg(d.radar || {})}
            </div>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 10px; font-size: 11px; text-align: center;">
              <div style="background: #f8fafc; border: 1px solid var(--border); padding: 6px; border-radius: 4px;">流量: <strong style="color: #ea580c;">${d.radar?.traffic || 0}</strong></div>
              <div style="background: #f8fafc; border: 1px solid var(--border); padding: 6px; border-radius: 4px;">自然: <strong style="color: #059669;">${d.radar?.organic || 0}</strong></div>
              <div style="background: #f8fafc; border: 1px solid var(--border); padding: 6px; border-radius: 4px;">销量: <strong style="color: #0284c7;">${d.radar?.sales || 0}</strong></div>
              <div style="background: #f8fafc; border: 1px solid var(--border); padding: 6px; border-radius: 4px;">口碑: <strong style="color: #d97706;">${d.radar?.reputation || 0}</strong></div>
              <div style="background: #f8fafc; border: 1px solid var(--border); padding: 6px; border-radius: 4px;">变体: <strong style="color: #7c3aed;">${d.radar?.variation || 0}</strong></div>
              <div style="background: #f8fafc; border: 1px solid var(--border); padding: 6px; border-radius: 4px;">广告: <strong style="color: #e11d48;">${d.radar?.adStrength || 0}</strong></div>
            </div>
          </div>

          <!-- Profit & Break-even ACoS Simulator -->
          <div class="panel-card" style="padding: 18px; display: flex; flex-direction: column; gap: 12px;">
            <div style="font-size: 13.5px; font-weight: 700; color: #0f172a; display: flex; justify-content: space-between; align-items: center;">
              <span>单品利润与保本 ACoS 测算器</span>
              <span class="badge badge-emerald">FBA费: $${fba.toFixed(2)}</span>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
              <div style="background: #f8fafc; border: 1px solid var(--border); padding: 10px; border-radius: 6px;">
                <div style="font-size: 11px; color: var(--text-muted);">广告前毛利</div>
                <div style="font-size: 18px; font-weight: 800; color: ${netMarginBeforeAd >= 0 ? '#059669' : '#e11d48'};">${fmtPrice(netMarginBeforeAd)}</div>
              </div>
              <div style="background: #fff7ed; border: 1px solid #fed7aa; padding: 10px; border-radius: 6px;">
                <div style="font-size: 11px; color: #9a3412;">盈亏平衡 ACoS 临界点</div>
                <div style="font-size: 18px; font-weight: 800; color: #ea580c;">${fmtPct(breakEvenAcos)}</div>
              </div>
            </div>
            <div style="display: flex; flex-direction: column; gap: 8px; font-size: 12px;">
              <div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                  <span style="color: var(--text-muted);">采购成本 (COGS)</span>
                  <strong style="font-family: var(--font-mono);">${fmtPrice(state.cogs)}</strong>
                </div>
                <input id="cogsSlider" type="range" min="1" max="${Math.max(20, Math.round(price))}" step="0.2" value="${state.cogs}" style="width: 100%; accent-color: #f97316;">
              </div>
              <div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                  <span style="color: var(--text-muted);">头程物流运费</span>
                  <strong style="font-family: var(--font-mono);">${fmtPrice(state.shippingCost)}</strong>
                </div>
                <input id="shipSlider" type="range" min="0.5" max="${Math.max(15, Math.round(price * 0.5))}" step="0.2" value="${state.shippingCost}" style="width: 100%; accent-color: #f97316;">
              </div>
            </div>
            <div style="font-size: 11px; color: var(--text-dim); background: #f8fafc; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border);">
              测算公式：售价(${fmtPrice(price)}) - 15%佣金(${fmtPrice(referral)}) - FBA(${fmtPrice(fba)}) - 采购 - 头程
            </div>
          </div>
        </div>
      `
          : state.asinSubTab === 'matrix62'
          ? `
        <div class="panel-card" style="padding: 20px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; flex-wrap: wrap; gap: 10px;">
            <div>
              <div style="font-size: 14.5px; font-weight: 800; color: #0f172a;">全部 62 项 MCP 原生底层工具执行态全景</div>
              <div style="font-size: 11.5px; color: var(--text-muted);">点击任意工具卡片，立即展开针对该 ASIN 返回的明细数据或一键补充调用</div>
            </div>
            <div style="display: flex; gap: 6px;">
              <button class="manifest-filter-btn btn btn-secondary btn-sm" data-filter="ALL">全部 (62)</button>
              <button class="manifest-filter-btn btn btn-secondary btn-sm" data-filter="SUCCESS">已穿透 (${stats.executedCount || 27})</button>
              <button class="manifest-filter-btn btn btn-secondary btn-sm" data-filter="STANDBY">智能待命 (${stats.standbyCount || 35})</button>
            </div>
          </div>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; max-height: 480px; overflow-y: auto; padding-right: 4px;">
            ${manifest
              .filter((m) => {
                if (state.manifestFilterCategory === 'SUCCESS') return m.status === 'SUCCESS' || m.status === 'CASCADED';
                if (state.manifestFilterCategory === 'STANDBY') return m.status === 'STANDBY_READY';
                return true;
              })
              .map(
                (m) => `
              <div class="manifest-card" data-toolname="${m.name}" style="background: #f8fafc; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 11px; display: flex; flex-direction: column; gap: 6px; cursor: pointer; transition: all 0.15s ease;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <span style="font-family: var(--font-mono); font-size: 11.5px; font-weight: 700; color: #0f172a;">${m.name}</span>
                  <span class="badge ${m.status === 'SUCCESS' ? 'badge-emerald' : m.status === 'CASCADED' ? 'badge-cyan' : 'badge-amber'}">${m.status === 'SUCCESS' ? '已穿透' : m.status === 'CASCADED' ? '关联串联' : '待命秒查'}</span>
                </div>
                <div style="font-size: 11px; color: var(--text-muted); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${m.summary}</div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px; font-size: 10.5px; color: var(--text-dim);">
                  <span>${m.categoryName || 'MCP'}</span>
                  <span>${m.latency ? `⚡ ${m.latency}ms · ${m.costCredits}点` : '点击秒查'}</span>
                </div>
              </div>
            `
              )
              .join('')}
          </div>

          ${
            state.inspectingToolName
              ? `
            <div id="manifestInspector" style="margin-top: 16px; background: #ffffff; border: 1.5px solid #f97316; border-radius: var(--radius-sm); padding: 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: var(--shadow-md);">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <div style="font-size: 13.5px; font-weight: 800; color: #0f172a; font-family: var(--font-mono);">${state.inspectingToolName}</div>
                <button id="btnCloseInspector" class="btn btn-secondary btn-sm">关闭检查器</button>
              </div>
              <div style="display: flex; gap: 10px;">
                <button id="btnRunInspectorTool" class="btn btn-primary btn-sm">🚀 针对当前 ASIN 立即执行此工具</button>
              </div>
              <div class="json-box" style="max-height: 260px;">
                ${JSON.stringify((manifest.find((x) => x.name === state.inspectingToolName) || {}).data || (manifest.find((x) => x.name === state.inspectingToolName) || {}).inputArgs, null, 2)}
              </div>
            </div>
          `
              : ''
          }
        </div>
      `
          : state.asinSubTab === 'traffic'
          ? `
        <div class="panel-card" style="padding: 20px;">
          <div style="font-size: 14px; font-weight: 700; color: #0f172a; margin-bottom: 14px;">近7天自然 vs 广告流量解构</div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; align-items: center;">
            <div style="display: flex; justify-content: center;">
              ${renderDonutSvg(t.organicRatio ?? 0)}
            </div>
            <div style="display: flex; flex-direction: column; gap: 10px;">
              <div style="background: #f8fafc; border: 1px solid var(--border); padding: 12px 16px; border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center;">
                <span style="display: flex; align-items: center; gap: 8px; font-weight: 600;"><span style="width: 10px; height: 10px; border-radius: 50%; background: #059669;"></span>自然流量</span>
                <span style="font-weight: 700; color: #059669;">${fmtNum(t.organicTraffic)} (${fmtPct(t.organicRatio)})</span>
              </div>
              <div style="background: #f8fafc; border: 1px solid var(--border); padding: 12px 16px; border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center;">
                <span style="display: flex; align-items: center; gap: 8px; font-weight: 600;"><span style="width: 10px; height: 10px; border-radius: 50%; background: #f97316;"></span>付费广告流量</span>
                <span style="font-weight: 700; color: #ea580c;">${fmtNum(t.adTraffic)} (${fmtPct(t.adRatio)})</span>
              </div>
              <div style="background: #f8fafc; border: 1px solid var(--border); padding: 12px 16px; border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center;">
                <span style="font-weight: 600;">总流量规模</span>
                <span style="font-weight: 800; color: #0f172a;">${fmtNum(t.totalTraffic)}</span>
              </div>
            </div>
          </div>
        </div>
      `
          : state.asinSubTab === 'trends'
          ? `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px;">
          <div class="panel-card" style="padding: 18px;">
            <div style="font-size: 13.5px; font-weight: 700; color: #0f172a; margin-bottom: 4px;">周度流量历史趋势</div>
            <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 12px;">数据源: get_asin_traffic_trends_weekly (${(t.weeklyTrends || []).length} 个周期)</div>
            ${
              (t.weeklyTrends || []).length > 0
                ? `<div style="height: 140px; background: #f8fafc; border: 1px solid var(--border); border-radius: 6px; display: flex; align-items: flex-end; gap: 6px; padding: 12px;">
                    ${(() => {
                      const arr = t.weeklyTrends.slice(-12);
                      const maxVal = Math.max(...arr.map((x) => x.totalTraffic || x.total || 1), 1);
                      return arr
                        .map((x) => {
                          const val = x.totalTraffic || x.total || 0;
                          const h = Math.max(8, Math.round((val / maxVal) * 100));
                          return `<div style="flex: 1; height: ${h}%; background: #f97316; border-radius: 3px 3px 0 0;" title="${x.week || x.startDate || ''}: ${val}"></div>`;
                        })
                        .join('');
                    })()}
                  </div>`
                : '<div style="padding: 40px 10px; text-align: center; color: var(--text-dim); background: #f8fafc; border-radius: 6px; border: 1px dashed var(--border);">该 ASIN 暂无足够周度历史流量走势数据</div>'
            }
          </div>

          <div class="panel-card" style="padding: 18px;">
            <div style="font-size: 13.5px; font-weight: 700; color: #0f172a; margin-bottom: 4px;">关键词收录数日趋势</div>
            <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 12px;">数据源: get_asin_keyword_count_trends (${(k.keywordCountTrends || []).length} 天)</div>
            ${
              (k.keywordCountTrends || []).length > 0
                ? `<div style="height: 140px; background: #f8fafc; border: 1px solid var(--border); border-radius: 6px; display: flex; align-items: flex-end; gap: 4px; padding: 12px;">
                    ${(() => {
                      const arr = k.keywordCountTrends.slice(-15);
                      const maxVal = Math.max(...arr.map((x) => x.totalCount || x.count || 1), 1);
                      return arr
                        .map((x) => {
                          const val = x.totalCount || x.count || 0;
                          const h = Math.max(8, Math.round((val / maxVal) * 100));
                          return `<div style="flex: 1; height: ${h}%; background: #0284c7; border-radius: 3px 3px 0 0;" title="${x.date || ''}: ${val}词"></div>`;
                        })
                        .join('');
                    })()}
                  </div>`
                : '<div style="padding: 40px 10px; text-align: center; color: var(--text-dim); background: #f8fafc; border-radius: 6px; border: 1px dashed var(--border);">该 ASIN 暂无关键词收录数趋势数据</div>'
            }
          </div>
        </div>
      `
          : state.asinSubTab === 'keywords'
          ? `
        <div class="panel-card" style="padding: 20px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; flex-wrap: wrap; gap: 10px;">
            <div style="font-size: 14px; font-weight: 700; color: #0f172a;">TOP 核心流量词排位矩阵 (${filteredKw.length})</div>
            <div style="display: flex; gap: 8px; align-items: center;">
              <input id="kwFilterInput" type="text" value="${state.kwSearchQuery}" placeholder="搜索关键词..." style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; padding: 5px 10px; font-size: 12px; color: #0f172a; outline: none;">
              <button id="btnExportKeywordsCsv" class="btn btn-secondary btn-sm">导出 CSV</button>
            </div>
          </div>
          <div style="overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
              <thead>
                <tr style="border-bottom: 1px solid var(--border); color: var(--text-muted); text-align: left; background: #f8fafc;">
                  <th style="padding: 9px 12px;">关键词</th>
                  <th style="padding: 9px 12px;">总流量</th>
                  <th style="padding: 9px 12px;">获流占比</th>
                  <th style="padding: 9px 12px;">自然排名</th>
                  <th style="padding: 9px 12px;">广告排名</th>
                </tr>
              </thead>
              <tbody>
                ${filteredKw
                  .map(
                    (kw) => `
                  <tr style="border-bottom: 1px solid var(--border-subtle);">
                    <td style="padding: 10px 12px;">
                      <div style="font-weight: 600; color: #0f172a;">${kw.searchTerm}</div>
                      ${kw.searchTermZh ? `<div style="font-size: 11px; color: var(--text-dim);">${kw.searchTermZh}</div>` : ''}
                    </td>
                    <td style="padding: 10px 12px; font-family: var(--font-mono); font-weight: 600; color: #0284c7;">${fmtNum(kw.totalTraffic)}</td>
                    <td style="padding: 10px 12px; font-family: var(--font-mono); font-weight: 600; color: #ea580c;">${fmtPct(kw.trafficRatio)}</td>
                    <td style="padding: 10px 12px;">${kw.organicRank != null ? `<span class="badge ${kw.organicRank <= 3 ? 'badge-rose' : kw.organicRank <= 10 ? 'badge-amber' : 'badge-emerald'}">#${kw.organicRank}</span>` : '—'}</td>
                    <td style="padding: 10px 12px;">${kw.adRank != null ? `<span class="badge badge-purple">#${kw.adRank}</span>` : '—'}</td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      `
          : state.asinSubTab === 'variations'
          ? `
        <div class="panel-card" style="padding: 20px;">
          <div style="font-size: 14px; font-weight: 700; color: #0f172a; margin-bottom: 14px;">父体 ${v.parentAsin} 下全部子体矩阵 (${v.childAsins.length} 个子体)</div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px;">
            ${(v.childAsins || [])
              .map(
                (c) => `
              <div style="background: #f8fafc; border: 1px solid ${c.asin === state.activeAsin ? '#fdba74' : 'var(--border)'}; border-radius: var(--radius-sm); padding: 12px; display: flex; flex-direction: column; gap: 6px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <span style="font-family: var(--font-mono); font-weight: 700; color: #0f172a;">${c.asin}</span>
                  ${c.asin === state.activeAsin ? '<span class="badge badge-orange">当前</span>' : ''}
                </div>
                <div style="font-size: 11px; color: var(--text-muted);">${c.dimensions?.color || c.dimensions?.flavor || c.dimensions?.size || '子体变体'}</div>
                <button class="btn btn-secondary btn-sm switch-asin-btn" data-asin="${c.asin}" style="margin-top: 6px;">穿透此子体</button>
              </div>
            `
              )
              .join('')}
          </div>
        </div>
      `
          : `
        <div class="panel-card" style="padding: 20px; display: flex; flex-direction: column; gap: 12px;">
          <div style="font-size: 14px; font-weight: 700; color: #0f172a;">父体广告投放全景</div>
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;">
            <div style="background: #f8fafc; border: 1px solid var(--border); padding: 12px; border-radius: 6px;">
              <div style="font-size: 11px; color: var(--text-muted);">在投广告活动数</div>
              <div style="font-size: 20px; font-weight: 800; color: #ea580c;">${ad.campaignsCount || 0}</div>
            </div>
            <div style="background: #f8fafc; border: 1px solid var(--border); padding: 12px; border-radius: 6px;">
              <div style="font-size: 11px; color: var(--text-muted);">广告投放关键词数</div>
              <div style="font-size: 20px; font-weight: 800; color: #0284c7;">${ad.keywordsCount || 0}</div>
            </div>
            <div style="background: #f8fafc; border: 1px solid var(--border); padding: 12px; border-radius: 6px;">
              <div style="font-size: 11px; color: var(--text-muted);">广告状态</div>
              <div style="font-size: 14px; font-weight: 700; color: #059669; margin-top: 4px;">${ad.active ? '✅ 广告活跃投放中' : '⚪ 暂未检测到活动'}</div>
            </div>
          </div>
        </div>
      `
      }
    </div>
  `;
}

// -----------------------------------------------------------------------------
// Tab 2: Multi-ASIN Comparison PK
// -----------------------------------------------------------------------------
function renderTabCompare() {
  const cd = state.compareData;
  return `
    <div style="padding: 20px; display: flex; flex-direction: column; gap: 18px;">
      <div class="panel-card" style="padding: 16px; display: flex; flex-direction: column; gap: 12px;">
        <div style="display: flex; gap: 10px;">
          <input id="compareAsinsInput" type="text" value="${state.compareInput}" placeholder="输入 2~5 个 ASIN，逗号或空格隔开 (如 B0H7R2X98W, B0768N9N6M)..." style="flex: 1; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: var(--radius-sm); padding: 9px 14px; font-size: 13px; color: #0f172a; outline: none; font-family: var(--font-mono); font-weight: 600;">
          <button id="btnRunCompare" class="btn btn-primary" style="padding: 0 20px;">攻防横向PK</button>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--text-muted);">
          <span>快捷对决:</span>
          <button class="compare-preset-tag btn btn-secondary btn-sm" data-asins="B0H7R2X98W, B0H7QWT72P">同父体颜色变体 PK</button>
          <button class="compare-preset-tag btn btn-secondary btn-sm" data-asins="B0768N9N6M, B00MNV8E0C">Nespresso vs AmazonBasics</button>
        </div>
      </div>

      ${
        cd
          ? `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px;">
          ${(cd.products || [])
            .map(
              (p) => `
            <div class="panel-card" style="padding: 16px; display: flex; flex-direction: column; gap: 10px;">
              <div style="display: flex; gap: 12px; align-items: center;">
                ${p.image ? `<img src="${p.image}" style="width: 52px; height: 52px; object-fit: contain; background: #f8fafc; border-radius: 6px; border: 1px solid var(--border);">` : ''}
                <div style="min-width: 0;">
                  <span class="badge badge-orange" style="margin-bottom: 4px;">${p.asin}</span>
                  <div style="font-size: 12.5px; font-weight: 700; color: #0f172a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${p.title}</div>
                  <div style="font-size: 11px; color: var(--text-muted);">${p.brand}</div>
                </div>
              </div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 11.5px;">
                <div style="background: #f8fafc; border: 1px solid var(--border); padding: 8px; border-radius: 4px;">
                  <div style="color: var(--text-muted);">售价</div>
                  <div style="font-weight: 700; color: #ea580c;">${fmtPrice(p.price)}</div>
                </div>
                <div style="background: #f8fafc; border: 1px solid var(--border); padding: 8px; border-radius: 4px;">
                  <div style="color: var(--text-muted);">近30天销量</div>
                  <div style="font-weight: 700; color: #059669;">${fmtNum(p.ordersLast30d)} 单</div>
                </div>
              </div>
            </div>
          `
            )
            .join('')}
        </div>

        <div class="panel-card" style="padding: 20px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
            <div style="font-size: 14px; font-weight: 700; color: #0f172a;">竞品共有核心流量大词 (交集词库)</div>
            <span class="badge badge-cyan">共有词: ${cd.sharedCount || 0} 个</span>
          </div>
          <div style="overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
              <thead>
                <tr style="border-bottom: 1px solid var(--border); color: var(--text-muted); text-align: left; background: #f8fafc;">
                  <th style="padding: 8px 12px;">共有搜索词</th>
                  ${(cd.asins || []).map((a) => `<th style="padding: 8px 12px;">${a} 自然 / 广告位</th>`).join('')}
                </tr>
              </thead>
              <tbody>
                ${(cd.sharedKeywords || [])
                  .map(
                    (kw) => `
                  <tr style="border-bottom: 1px solid var(--border-subtle);">
                    <td style="padding: 10px 12px;">
                      <div style="font-weight: 600; color: #0f172a;">${kw.searchTerm}</div>
                      ${kw.searchTermZh ? `<div style="font-size: 11px; color: var(--text-dim);">${kw.searchTermZh}</div>` : ''}
                    </td>
                    ${(cd.asins || [])
                      .map((asin) => {
                        const d = (kw.asinsDetail || []).find((x) => x.asin === asin);
                        if (!d) return '<td style="padding: 10px 12px; color: var(--text-dim);">—</td>';
                        return `
                        <td style="padding: 10px 12px;">
                          <span class="badge ${d.organicRank && d.organicRank <= 5 ? 'badge-rose' : 'badge-emerald'}">自: #${d.organicRank || '—'}</span>
                          <span class="badge badge-purple">广: #${d.adRank || '—'}</span>
                        </td>
                      `;
                      })
                      .join('')}
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      `
          : ''
      }
    </div>
  `;
}

// -----------------------------------------------------------------------------
// Tab 3: Keyword Explorer & ABA
// -----------------------------------------------------------------------------
function renderTabKeyword() {
  const kd = state.keywordData;
  return `
    <div style="padding: 20px; display: flex; flex-direction: column; gap: 18px;">
      <div class="panel-card" style="padding: 16px; display: flex; flex-direction: column; gap: 12px;">
        <div style="display: flex; gap: 10px;">
          <input id="keywordSearchInput" type="text" value="${state.keywordInput}" placeholder="输入亚马逊搜索词 (如 iphone 18 case wallet, coffee pods)..." style="flex: 1; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: var(--radius-sm); padding: 9px 14px; font-size: 13px; color: #0f172a; outline: none; font-weight: 600;">
          <button id="btnSearchKeyword" class="btn btn-primary" style="padding: 0 20px;">挖掘大盘与拓词</button>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--text-muted);">
          <span>热词测试:</span>
          <button class="kw-preset-tag btn btn-secondary btn-sm" data-kw="iphone 18 case wallet">iphone 18 case wallet</button>
          <button class="kw-preset-tag btn btn-secondary btn-sm" data-kw="coffee pods">coffee pods</button>
          <button class="kw-preset-tag btn btn-secondary btn-sm" data-kw="wallet phone case">wallet phone case</button>
        </div>
      </div>

      ${
        kd
          ? `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px;">
          <div class="panel-card" style="padding: 14px;">
            <div style="font-size: 11px; color: var(--text-muted);">周搜索量</div>
            <div style="font-size: 20px; font-weight: 800; color: #0284c7; margin-top: 4px;">${fmtNum(kd.searchVolume)}</div>
          </div>
          <div class="panel-card" style="padding: 14px;">
            <div style="font-size: 11px; color: var(--text-muted);">ABA 排名</div>
            <div style="font-size: 20px; font-weight: 800; color: #ea580c; margin-top: 4px;">#${fmtNum(kd.searchFrequencyRank)}</div>
          </div>
          <div class="panel-card" style="padding: 14px;">
            <div style="font-size: 11px; color: var(--text-muted);">点击转化率 (CVR)</div>
            <div style="font-size: 20px; font-weight: 800; color: #059669; margin-top: 4px;">${fmtPct(kd.clickConversionRate)}</div>
          </div>
          <div class="panel-card" style="padding: 14px;">
            <div style="font-size: 11px; color: var(--text-muted);">建议 CPC 出价</div>
            <div style="font-size: 20px; font-weight: 800; color: #e11d48; margin-top: 4px;">$${kd.costPerClick?.suggestedBid || '—'}</div>
          </div>
        </div>

        <div class="panel-card" style="padding: 20px;">
          <div style="font-size: 14px; font-weight: 700; color: #0f172a; margin-bottom: 12px;">以词找词 · 衍生相关词与长尾机会</div>
          <div style="overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
              <thead>
                <tr style="border-bottom: 1px solid var(--border); color: var(--text-muted); text-align: left; background: #f8fafc;">
                  <th style="padding: 8px 12px;">关键词</th>
                  <th style="padding: 8px 12px;">ABA 排名</th>
                  <th style="padding: 8px 12px;">预估周搜索量</th>
                  <th style="padding: 8px 12px;">点击份额</th>
                  <th style="padding: 8px 12px;">转化份额</th>
                </tr>
              </thead>
              <tbody>
                ${(kd.relatedKeywords || [])
                  .map(
                    (r) => `
                  <tr style="border-bottom: 1px solid var(--border-subtle);">
                    <td style="padding: 10px 12px;">
                      <div style="font-weight: 600; color: #0f172a;">${r.searchTerm}</div>
                      ${r.searchTermZh ? `<div style="font-size: 11px; color: var(--text-dim);">${r.searchTermZh}</div>` : ''}
                    </td>
                    <td style="padding: 10px 12px; font-family: var(--font-mono); color: #ea580c;">#${fmtNum(r.abaRank)}</td>
                    <td style="padding: 10px 12px; font-family: var(--font-mono); color: #0284c7;">${fmtNum(r.searchVolume)}</td>
                    <td style="padding: 10px 12px;">${fmtPct(r.clickShare)}</td>
                    <td style="padding: 10px 12px; font-weight: 600; color: #059669;">${fmtPct(r.conversionShare)}</td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      `
          : ''
      }
    </div>
  `;
}

// -----------------------------------------------------------------------------
// Tab 4: Category Market & Insights
// -----------------------------------------------------------------------------
function renderTabCategory() {
  const cat = state.categoryData;
  return `
    <div style="padding: 20px; display: flex; flex-direction: column; gap: 18px;">
      <div class="panel-card" style="padding: 16px; display: flex; gap: 10px;">
        <input id="categorySearchInput" type="text" value="${state.categoryQuery}" placeholder="输入品类关键词或 ASIN (如 flip cases, coffee)..." style="flex: 1; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: var(--radius-sm); padding: 9px 14px; font-size: 13px; color: #0f172a; outline: none; font-weight: 600;">
        <button id="btnSearchCategory" class="btn btn-primary" style="padding: 0 20px;">检索类目大盘</button>
      </div>

      ${
        cat
          ? `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px;">
          ${(cat.categories || [])
            .map(
              (c) => `
            <div class="panel-card" style="padding: 18px; display: flex; flex-direction: column; gap: 12px;">
              <div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                  <span class="badge badge-orange">Level ${c.level || 5} 类目</span>
                  <span style="font-family: var(--font-mono); font-size: 11px; color: var(--text-dim);">${c.categoryId}</span>
                </div>
                <div style="font-size: 14px; font-weight: 700; color: #0f172a;">${c.name}</div>
                <div style="font-size: 11px; color: var(--text-muted);">${c.nameEn}</div>
              </div>
              <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; font-size: 11.5px;">
                <div style="background: #f8fafc; border: 1px solid var(--border); padding: 8px; border-radius: 4px;">
                  <div style="color: var(--text-muted);">月销量</div>
                  <div style="font-weight: 700; color: #059669;">${fmtNum(c.monthlySales)}</div>
                </div>
                <div style="background: #f8fafc; border: 1px solid var(--border); padding: 8px; border-radius: 4px;">
                  <div style="color: var(--text-muted);">月销售额</div>
                  <div style="font-weight: 700; color: #0284c7;">$${fmtNum(c.monthlyRevenue)}</div>
                </div>
                <div style="background: #f8fafc; border: 1px solid var(--border); padding: 8px; border-radius: 4px;">
                  <div style="color: var(--text-muted);">活跃父ASIN</div>
                  <div style="font-weight: 700; color: #ea580c;">${fmtNum(c.parentCount)}</div>
                </div>
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      `
          : ''
      }
    </div>
  `;
}

// -----------------------------------------------------------------------------
// Tab 5: Breakout Products
// -----------------------------------------------------------------------------
function renderTabBreakout() {
  const bo = state.breakoutData;
  return `
    <div style="padding: 20px; display: flex; flex-direction: column; gap: 18px;">
      <div class="panel-card" style="padding: 16px; display: flex; justify-content: space-between; align-items: center;">
        <div>
          <div style="font-size: 15px; font-weight: 800; color: #0f172a;">黑马爆发爆款雷达</div>
          <div style="font-size: 11.5px; color: var(--text-muted);">基于西柚官方算法，近 30 天销量陡峭上升、具备黑马潜质的代表单品</div>
        </div>
        <button id="btnScanBreakout" class="btn btn-primary">⚡ 立即重新扫描</button>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); gap: 16px;">
        ${((bo && bo.products) || [])
          .map(
            (p) => `
          <div class="panel-card" style="padding: 16px; display: flex; flex-direction: column; gap: 12px;">
            <div style="display: flex; gap: 12px; align-items: flex-start;">
              ${p.image ? `<img src="${p.image}" style="width: 64px; height: 64px; object-fit: contain; background: #f8fafc; border-radius: 6px; border: 1px solid var(--border); flex-shrink: 0;">` : ''}
              <div style="min-width: 0;">
                <div style="display: flex; align-items: center; gap: 6px;">
                  <span class="badge badge-rose" style="font-size: 10px;">爆发 +${Math.round((p.salesMomRate || 1) * 100)}%</span>
                  <span style="font-family: var(--font-mono); font-size: 11px; color: var(--text-muted);">${p.asin}</span>
                </div>
                <div style="font-size: 13px; font-weight: 700; color: #0f172a; line-height: 1.4; margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${p.title}</div>
              </div>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 11.5px;">
              <div style="background: #f8fafc; border: 1px solid var(--border); padding: 8px; border-radius: 4px;">
                <div style="color: var(--text-muted);">近30天销量</div>
                <div style="font-weight: 700; color: #059669;">${fmtNum(p.salesLast30d)} 单</div>
              </div>
              <div style="background: #f8fafc; border: 1px solid var(--border); padding: 8px; border-radius: 4px;">
                <div style="color: var(--text-muted);">月预估销售额</div>
                <div style="font-weight: 700; color: #0284c7;">${fmtPrice(p.revenueLast30d)}</div>
              </div>
            </div>
            <button class="btn btn-secondary btn-sm breakout-drill-btn" data-asin="${p.asin}">带入 ASIN 62工具全息透视</button>
          </div>
        `
          )
          .join('')}
      </div>
    </div>
  `;
}

// -----------------------------------------------------------------------------
// Tab 6: 62-Tool Universal MCP Sandbox
// -----------------------------------------------------------------------------
function renderTabTools() {
  const tools = state.toolsCatalog || [];
  const categories = [
    { id: 'ALL', label: '全部 (62)' },
    { id: 'asin', label: 'ASIN (14)' },
    { id: 'keyword', label: '关键词 (21)' },
    { id: 'category', label: '类目 (17)' },
    { id: 'ad', label: '广告 (6)' },
    { id: 'discovery', label: '选品 (2)' },
    { id: 'system', label: '系统 (2)' },
  ];

  const filteredTools = tools.filter((t) => {
    if (state.toolFilterCategory !== 'ALL' && t.category !== state.toolFilterCategory) return false;
    if (state.toolSearchQuery) {
      const q = state.toolSearchQuery.toLowerCase();
      return t.name.toLowerCase().includes(q) || t.summary.toLowerCase().includes(q);
    }
    return true;
  });

  const curTool = tools.find((t) => t.name === state.selectedToolName) || tools[0] || {};

  return `
    <div style="padding: 18px 20px; display: grid; grid-template-columns: 300px 1fr; gap: 18px; min-height: 600px;">
      <div class="panel-card" style="display: flex; flex-direction: column; overflow: hidden;">
        <div style="padding: 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px;">
          <input id="toolCatalogSearchInput" type="text" value="${state.toolSearchQuery}" placeholder="搜索 62 项 MCP 工具..." style="width: 100%; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: var(--radius-sm); padding: 7px 10px; font-size: 12px; color: #0f172a; outline: none;">
          <div style="display: flex; gap: 4px; overflow-x: auto; padding-bottom: 2px;">
            ${categories
              .map(
                (c) => `
              <button class="tool-cat-btn btn btn-secondary btn-sm" data-cat="${c.id}" style="font-size: 11px; padding: 3px 8px; ${state.toolFilterCategory === c.id ? 'background: #f97316; color: #ffffff; border-color: #f97316;' : ''}">${c.label}</button>
            `
              )
              .join('')}
          </div>
        </div>

        <div style="flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; max-height: calc(100vh - 220px);">
          ${filteredTools
            .map(
              (t) => `
            <div class="tool-catalog-item ${t.name === state.selectedToolName ? 'active' : ''}" data-toolname="${t.name}">
              <div style="font-size: 12px; font-weight: 700; color: ${t.name === state.selectedToolName ? '#ea580c' : '#0f172a'}; font-family: var(--font-mono);">${t.name}</div>
              <div style="font-size: 11px; color: var(--text-muted); line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${t.summary}</div>
            </div>
          `
            )
            .join('')}
        </div>
      </div>

      <div class="panel-card" style="padding: 20px; display: flex; flex-direction: column; gap: 16px;">
        <div style="border-bottom: 1px solid var(--border); padding-bottom: 14px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <div style="font-size: 16px; font-weight: 800; color: #0f172a; font-family: var(--font-mono);">${curTool.name || 'Select Tool'}</div>
            <span class="badge badge-orange">${curTool.categoryName || 'MCP Tool'}</span>
          </div>
          <div style="font-size: 12px; color: #475569; line-height: 1.5; white-space: pre-wrap; max-height: 90px; overflow-y: auto; background: #f8fafc; padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border);">${curTool.fullDesc || curTool.summary || '暂无详细描述'}</div>
        </div>

        <div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="font-size: 12px; font-weight: 600; color: var(--text-muted);">入参 JSON 字典 (Arguments)</span>
            <button id="btnLoadToolSampleArgs" class="btn btn-secondary btn-sm">💡 一键填入典型测试参数</button>
          </div>
          <textarea id="toolArgsTextarea" style="width: 100%; height: 110px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: var(--radius-sm); padding: 10px; font-family: var(--font-mono); font-size: 12px; color: #0369a1; outline: none;">${state.toolArgsText}</textarea>
        </div>

        <button id="btnExecuteMcpTool" class="btn btn-primary" style="padding: 10px 24px; font-size: 13px; align-self: flex-start;" ${state.toolExecuting ? 'disabled' : ''}>
          ${state.toolExecuting ? '⏳ 正在发往西柚官方 MCP 接口...' : '🚀 立即执行 MCP 工具调用'}
        </button>

        <div style="flex: 1; display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 12px; font-weight: 600; color: var(--text-muted);">执行结果与原始响应 (JSON)</span>
            ${state.toolExecutionResult ? `<button id="btnCopyJsonResult" class="btn btn-secondary btn-sm">📋 复制结果 JSON</button>` : ''}
          </div>
          <div class="json-box" style="flex: 1; min-height: 200px;">
            ${
              state.toolExecuting
                ? '<div style="color: var(--text-muted);">⏳ 请求已发出，正在向官方西柚 MCP 拉取实时数据...</div>'
                : state.toolExecutionResult
                ? JSON.stringify(state.toolExecutionResult.data || state.toolExecutionResult, null, 2)
                : '<div style="color: var(--text-dim);">点击上方“立即执行 MCP 工具调用”按钮，此处将呈现格式化响应数据。</div>'
            }
          </div>
        </div>
      </div>
    </div>
  `;
}

// -----------------------------------------------------------------------------
// Tab 7: Account Quota
// -----------------------------------------------------------------------------
function renderTabQuota() {
  const q = state.quota || {};
  const m = q.monthly || {};
  return `
    <div style="padding: 24px; max-width: 800px; margin: 0 auto;">
      <div class="panel-card" style="padding: 24px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <div>
            <div style="font-size: 16px; font-weight: 800; color: #0f172a;">西柚洞察 MCP Token 账户状态</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">当前接入官方服务: https://mcp.xydc.com/mcp</div>
          </div>
          <button id="btnRefreshQuota" class="btn btn-secondary btn-sm">🔄 刷新额度</button>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; margin-top: 16px;">
          <div style="background: #f8fafc; border: 1px solid var(--border); padding: 16px; border-radius: var(--radius-sm);">
            <div style="font-size: 11.5px; color: var(--text-muted);">本月剩余可用点数</div>
            <div style="font-size: 24px; font-weight: 800; color: #059669; margin-top: 4px;">${fmtNum(m.remaining || 59719)}</div>
          </div>
          <div style="background: #f8fafc; border: 1px solid var(--border); padding: 16px; border-radius: var(--radius-sm);">
            <div style="font-size: 11.5px; color: var(--text-muted);">本月总额度上限</div>
            <div style="font-size: 24px; font-weight: 800; color: #0f172a; margin-top: 4px;">${fmtNum(m.limit || 60000)}</div>
          </div>
          <div style="background: #f8fafc; border: 1px solid var(--border); padding: 16px; border-radius: var(--radius-sm);">
            <div style="font-size: 11.5px; color: var(--text-muted);">本月已消耗点数</div>
            <div style="font-size: 24px; font-weight: 800; color: #ea580c; margin-top: 4px;">${fmtNum(m.used || 281)}</div>
          </div>
          <div style="background: #f8fafc; border: 1px solid var(--border); padding: 16px; border-radius: var(--radius-sm);">
            <div style="font-size: 11.5px; color: var(--text-muted);">额度重置周期</div>
            <div style="font-size: 13px; font-weight: 700; color: #0284c7; margin-top: 8px;">${m.resetTime || '2026-12-19'}</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// -----------------------------------------------------------------------------
// Visual SVG Helpers (Light Theme Adapted)
// -----------------------------------------------------------------------------
function renderRadarSvg(r = {}) {
  const size = 220;
  const center = size / 2;
  const radius = 80;
  const keys = ['traffic', 'organic', 'sales', 'reputation', 'variation', 'adStrength'];
  const labels = ['流量规模', '自然壁垒', '销量爆发', '口碑评价', '变体深度', '广告渗透'];
  const count = keys.length;

  const points = keys.map((k, i) => {
    const val = Math.min(100, Math.max(0, r[k] || 50));
    const angle = (Math.PI * 2 * i) / count - Math.PI / 2;
    const rDist = (val / 100) * radius;
    return `${center + rDist * Math.cos(angle)},${center + rDist * Math.sin(angle)}`;
  });

  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      ${[0.25, 0.5, 0.75, 1]
        .map((pct) => {
          const ringPoints = Array.from({ length: count })
            .map((_, i) => {
              const angle = (Math.PI * 2 * i) / count - Math.PI / 2;
              return `${center + radius * pct * Math.cos(angle)},${center + radius * pct * Math.sin(angle)}`;
            })
            .join(' ');
          return `<polygon points="${ringPoints}" fill="none" stroke="#e2e8f0" stroke-width="1.2"/>`;
        })
        .join('')}
      ${Array.from({ length: count })
        .map((_, i) => {
          const angle = (Math.PI * 2 * i) / count - Math.PI / 2;
          return `<line x1="${center}" y1="${center}" x2="${center + radius * Math.cos(angle)}" y2="${center + radius * Math.sin(angle)}" stroke="#e2e8f0" stroke-width="1.2"/>`;
        })
        .join('')}
      <polygon points="${points.join(' ')}" fill="rgba(249, 115, 22, 0.22)" stroke="#f97316" stroke-width="2.2"/>
      ${labels
        .map((lbl, i) => {
          const angle = (Math.PI * 2 * i) / count - Math.PI / 2;
          const x = center + (radius + 20) * Math.cos(angle);
          const y = center + (radius + 20) * Math.sin(angle);
          return `<text x="${x}" y="${y + 4}" fill="#475569" font-size="10.5" font-weight="600" text-anchor="middle">${lbl}</text>`;
        })
        .join('')}
    </svg>
  `;
}

function renderDonutSvg(organicRatio = 0) {
  const size = 180;
  const stroke = 24;
  const radius = (size - stroke) / 2;
  const circum = 2 * Math.PI * radius;
  const orgOffset = circum * (1 - organicRatio);

  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="transform: rotate(-90deg);">
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="#f97316" stroke-width="${stroke}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="#10b981" stroke-width="${stroke}" stroke-dasharray="${circum}" stroke-dashoffset="${orgOffset}"/>
    </svg>
  `;
}

// =============================================================================
// Master Render
// =============================================================================
function render() {
  const container = document.getElementById('app');
  if (!container) return;

  try {
    container.innerHTML = `
      ${renderNavbar()}
      ${renderMainTabs()}

      ${
        state.loading
          ? `
        <div style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px;">
          <div style="width: 48px; height: 48px; border: 3px solid #fed7aa; border-top-color: #f97316; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 16px;"></div>
          <div style="font-size: 14.5px; font-weight: 800; color: #0f172a;">${state.loadingMsg || '正在处理中...'}</div>
          <div style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">西柚官方 MCP 算力集群实时穿透中</div>
        </div>
      `
          : state.mainTab === 'asin'
          ? renderTabAsin()
          : state.mainTab === 'compare'
          ? renderTabCompare()
          : state.mainTab === 'keyword'
          ? renderTabKeyword()
          : state.mainTab === 'category'
          ? renderTabCategory()
          : state.mainTab === 'breakout'
          ? renderTabBreakout()
          : state.mainTab === 'tools'
          ? renderTabTools()
          : renderTabQuota()
      }
    `;

    attachEventHandlers();
  } catch (err) {
    console.error('Render error:', err);
    container.innerHTML = `<div style="padding: 24px; color: #e11d48; font-weight: 700;">渲染异常: ${err.message}</div>`;
  }
}

// =============================================================================
// Event Handlers Binding
// =============================================================================
function attachEventHandlers() {
  document.querySelectorAll('.main-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.mainTab = btn.getAttribute('data-tab');
      render();
    });
  });

  const countrySelect = document.getElementById('countrySelect');
  if (countrySelect) {
    countrySelect.addEventListener('change', (e) => {
      state.country = e.target.value;
      showToast(`已切换至 ${state.country} 站点`);
    });
  }

  // Tab 1 Handlers
  const btnStart62 = document.getElementById('btnStart62Analysis');
  const asinInput = document.getElementById('asinInput');
  if (btnStart62 && asinInput) {
    btnStart62.addEventListener('click', () => trigger62AsinDeepDive(asinInput.value, state.country));
  }
  if (asinInput) {
    asinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') trigger62AsinDeepDive(asinInput.value, state.country);
    });
  }
  document.querySelectorAll('.sample-tag').forEach((btn) => {
    btn.addEventListener('click', () => {
      const a = btn.getAttribute('data-asin');
      if (a) trigger62AsinDeepDive(a, state.country);
    });
  });
  document.querySelectorAll('.asin-subtab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.asinSubTab = btn.getAttribute('data-subtab');
      render();
    });
  });
  document.querySelectorAll('.switch-asin-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const a = btn.getAttribute('data-asin');
      if (a) trigger62AsinDeepDive(a, state.country);
    });
  });
  const btnToggleMatrix = document.getElementById('btnToggleMatrixSubtab');
  if (btnToggleMatrix) {
    btnToggleMatrix.addEventListener('click', () => {
      state.asinSubTab = 'matrix62';
      render();
    });
  }
  document.querySelectorAll('.hologram-chip, .manifest-card').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.inspectingToolName = chip.getAttribute('data-toolname');
      state.asinSubTab = 'matrix62';
      render();
      document.getElementById('manifestInspector')?.scrollIntoView({ behavior: 'smooth' });
    });
  });
  document.querySelectorAll('.manifest-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.manifestFilterCategory = btn.getAttribute('data-filter');
      render();
    });
  });
  document.getElementById('btnCloseInspector')?.addEventListener('click', () => {
    state.inspectingToolName = null;
    render();
  });
  document.getElementById('btnRunInspectorTool')?.addEventListener('click', () => {
    const item = (state.data?.toolsExecutionManifest || []).find((x) => x.name === state.inspectingToolName);
    if (item) triggerDirectToolExecution(state.inspectingToolName, item.inputArgs || { country: state.country });
  });
  const kwFilterInput = document.getElementById('kwFilterInput');
  if (kwFilterInput) {
    kwFilterInput.addEventListener('input', (e) => {
      state.kwSearchQuery = e.target.value;
      render();
      const el = document.getElementById('kwFilterInput');
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
  }
  document.getElementById('cogsSlider')?.addEventListener('input', (e) => {
    state.cogs = parseFloat(e.target.value);
    render();
  });
  document.getElementById('shipSlider')?.addEventListener('input', (e) => {
    state.shippingCost = parseFloat(e.target.value);
    render();
  });
  document.getElementById('btnExportKeywordsCsv')?.addEventListener('click', () => {
    const list = state.data?.keywords?.list || [];
    let csv = 'Keyword,KeywordZh,TotalTraffic,TrafficRatio,OrganicRank,AdRank\n';
    list.forEach((kw) => {
      csv += `"${kw.searchTerm}","${kw.searchTermZh || ''}",${kw.totalTraffic},${kw.trafficRatio},${kw.organicRank || ''},${kw.adRank || ''}\n`;
    });
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${state.activeAsin}_keywords_${state.country}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('关键词 CSV 导出成功');
  });

  // Tab 2 Handlers (Compare)
  const compareInput = document.getElementById('compareAsinsInput');
  document.getElementById('btnRunCompare')?.addEventListener('click', () => {
    if (compareInput) {
      state.compareInput = compareInput.value;
      triggerCompareAnalysis(compareInput.value, state.country);
    }
  });
  document.querySelectorAll('.compare-preset-tag').forEach((btn) => {
    btn.addEventListener('click', () => {
      const as = btn.getAttribute('data-asins');
      if (as) {
        state.compareInput = as;
        triggerCompareAnalysis(as, state.country);
      }
    });
  });

  // Tab 3 Handlers (Keyword)
  const kwInput = document.getElementById('keywordSearchInput');
  document.getElementById('btnSearchKeyword')?.addEventListener('click', () => {
    if (kwInput) {
      state.keywordInput = kwInput.value;
      triggerKeywordAnalysis(kwInput.value, state.country);
    }
  });
  document.querySelectorAll('.kw-preset-tag').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kw = btn.getAttribute('data-kw');
      if (kw) {
        state.keywordInput = kw;
        triggerKeywordAnalysis(kw, state.country);
      }
    });
  });

  // Tab 4 Handlers (Category)
  const catInput = document.getElementById('categorySearchInput');
  document.getElementById('btnSearchCategory')?.addEventListener('click', () => {
    if (catInput) {
      state.categoryQuery = catInput.value;
      triggerCategorySearch(catInput.value, state.country);
    }
  });

  // Tab 5 Handlers (Breakout)
  document.getElementById('btnScanBreakout')?.addEventListener('click', () => triggerBreakoutScan(state.country));
  document.querySelectorAll('.breakout-drill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const a = btn.getAttribute('data-asin');
      if (a) {
        state.mainTab = 'asin';
        trigger62AsinDeepDive(a, state.country);
      }
    });
  });

  // Tab 6 Handlers (62 Tools Playground)
  const toolSearchInput = document.getElementById('toolCatalogSearchInput');
  if (toolSearchInput) {
    toolSearchInput.addEventListener('input', (e) => {
      state.toolSearchQuery = e.target.value;
      render();
      const el = document.getElementById('toolCatalogSearchInput');
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
  }
  document.querySelectorAll('.tool-cat-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.toolFilterCategory = btn.getAttribute('data-cat');
      render();
    });
  });
  document.querySelectorAll('.tool-catalog-item').forEach((item) => {
    item.addEventListener('click', () => {
      const name = item.getAttribute('data-toolname');
      state.selectedToolName = name;
      const t = (state.toolsCatalog || []).find((x) => x.name === name);
      if (t && t.sampleArgs) state.toolArgsText = JSON.stringify(t.sampleArgs, null, 2);
      state.toolExecutionResult = null;
      render();
    });
  });
  document.getElementById('btnLoadToolSampleArgs')?.addEventListener('click', () => {
    const t = (state.toolsCatalog || []).find((x) => x.name === state.selectedToolName);
    if (t && t.sampleArgs) {
      state.toolArgsText = JSON.stringify(t.sampleArgs, null, 2);
      const ta = document.getElementById('toolArgsTextarea');
      if (ta) ta.value = state.toolArgsText;
      showToast('已加载典型测试参数');
    }
  });
  document.getElementById('btnExecuteMcpTool')?.addEventListener('click', () => {
    const ta = document.getElementById('toolArgsTextarea');
    if (ta) state.toolArgsText = ta.value;
    try {
      const argsObj = JSON.parse(state.toolArgsText || '{}');
      triggerDirectToolExecution(state.selectedToolName, argsObj);
    } catch {
      showToast('JSON 格式不合法，请检查参数');
    }
  });
  document.getElementById('btnCopyJsonResult')?.addEventListener('click', () => {
    if (state.toolExecutionResult) {
      navigator.clipboard.writeText(JSON.stringify(state.toolExecutionResult.data || state.toolExecutionResult, null, 2));
      showToast('JSON 结果已复制到剪贴板');
    }
  });

  // Tab 7 Handlers (Quota)
  document.getElementById('btnRefreshQuota')?.addEventListener('click', () => triggerRefreshQuota());
}

const styleEl = document.createElement('style');
styleEl.textContent = `@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
document.head.appendChild(styleEl);

app.ontoolresult = (result) => {
  if (result?.structuredContent) {
    const sc = result.structuredContent;
    if (sc.initialTab) state.mainTab = sc.initialTab;
    if (sc.data) {
      state.data = sc.data;
      const p = state.data?.product?.price || 20;
      state.cogs = Math.round(p * 0.22 * 10) / 10;
      state.shippingCost = Math.round(p * 0.08 * 10) / 10;
    }
    if (sc.activeAsin) state.activeAsin = sc.activeAsin;
    if (sc.country) state.country = sc.country;
    if (sc.history) state.history = sc.history;
    if (sc.toolsCatalog) state.toolsCatalog = sc.toolsCatalog;
    if (sc.quota) state.quota = sc.quota;
    render();
  }
};

async function init() {
  render();
  try {
    await app.connect();
  } catch (err) {
    console.warn('ext-apps host connection note:', err);
  }
}

init();
