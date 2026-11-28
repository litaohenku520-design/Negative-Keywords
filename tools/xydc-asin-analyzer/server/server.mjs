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

const APP_URI = 'ui://xydc-asin-analyzer/app.html';
const APP_HTML_PATH = path.join(__dirname, 'dist', 'app.html');
const STORE_ID = process.env.DISCOVER_STORE_ID || 'default';
const SHARED_DATA_DIR = path.join(__dirname, 'data');
const CACHE_DIR = process.env.DISCOVER_STORE_DATA_DIR || SHARED_DATA_DIR;
const CACHE_FILE = path.join(CACHE_DIR, 'asin_cache.json');
const TOOLS_METADATA_FILE = path.join(SHARED_DATA_DIR, 'tools_metadata.json');

const XYDC_ENDPOINT = 'https://mcp.xydc.com/mcp';
const XYDC_TOKEN = 'mcp_dd0041b77220885ec1468051603b24e4';

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading cache:', err);
  }
  return { history: [], asins: {} };
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving cache:', err);
  }
}

let localCache = loadCache();

let toolsCatalog = [];
try {
  if (fs.existsSync(TOOLS_METADATA_FILE)) {
    toolsCatalog = JSON.parse(fs.readFileSync(TOOLS_METADATA_FILE, 'utf8'));
  }
} catch (e) {
  console.error('Failed to load tools metadata:', e);
}

// Low-level call to external Xiyou MCP endpoint
async function callXiyouMcp(toolName, args = {}) {
  const start = Date.now();
  const requestArgs = {
    ...args,
    user_task: args.user_task || `Discover amzn 西柚洞察工具调用: ${toolName}`,
    intent_summary: args.intent_summary || `通过 ${toolName} 查询西柚洞察数据。`,
  };
  const payload = {
    jsonrpc: '2.0',
    id: Date.now() + Math.floor(Math.random() * 1000),
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: requestArgs,
    },
  };

  const resp = await fetch(XYDC_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${XYDC_TOKEN}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45000),
  });

  const duration = Date.now() - start;
  const responseText = await resp.text();
  let json;
  try {
    if (resp.headers.get('content-type')?.includes('text/event-stream')) {
      const dataLines = responseText.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
      json = JSON.parse(dataLines[dataLines.length - 1] || 'null');
    } else {
      json = JSON.parse(responseText);
    }
  } catch {
    if (!resp.ok) throw new Error(`Xiyou API HTTP ${resp.status}: ${resp.statusText}`);
    throw new Error(`西柚 MCP 返回了无法解析的响应 (${resp.headers.get('content-type') || 'unknown content type'})`);
  }
  if (!resp.ok) {
    const detail = json?.error?.message || json?.message || json?.detail || resp.statusText;
    throw new Error(`Xiyou API HTTP ${resp.status}: ${detail}`);
  }
  if (!json || typeof json !== 'object') {
    throw new Error('西柚 MCP 未返回 JSON-RPC 结果');
  }
  if (json.error) {
    throw new Error(`Xiyou RPC Error: ${json.error.message || JSON.stringify(json.error)}`);
  }
  if (!json.result) {
    throw new Error('西柚 MCP 响应缺少 result 字段');
  }

  const result = json?.result || {};
  const rawText = (result?.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
  if (result.isError) {
    throw new Error(rawText || `Xiyou MCP 工具 ${toolName} 执行失败`);
  }
  const costCreditsFromResult = result.cost_credits;
  let parsed = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
  }
  if (parsed === null && result.structuredContent !== undefined) parsed = result.structuredContent;
  if (parsed === null && rawText) parsed = rawText;
  if (parsed === null) parsed = result;

  if (parsed && typeof parsed === 'object') {
    const statusCode = Number(parsed.status ?? parsed.statusCode);
    const detail = parsed.data?.message || parsed.data?.errorMessage || parsed.message || parsed.error?.message || parsed.data?.error;
    if ((Number.isFinite(statusCode) && statusCode >= 400) || parsed.success === false || parsed.data?.error === true) {
      throw new Error(typeof detail === 'string' ? detail : `西柚 MCP 工具 ${toolName} 返回错误状态 ${statusCode || '失败'}`);
    }
  }

  return {
    toolName,
    duration,
    costCredits: Number(costCreditsFromResult ?? parsed?.cost_credits ?? 0),
    data: parsed,
  };
}

// Full 62-Tool Holographic ASIN Penetration Engine
async function aggregateFull62AsinDeepDive(asin, country = 'US', options = {}) {
  const cleanAsin = String(asin || '').trim().toUpperCase();
  const cleanCountry = String(country || 'US').trim().toUpperCase();
  const startTime = Date.now();

  if (!/^[A-Z0-9]{10}$/.test(cleanAsin)) {
    throw new Error('请输入 10 位标准亚马逊 ASIN。');
  }
  if (!/^[A-Z]{2}$/.test(cleanCountry)) {
    throw new Error('站点代码无效，请选择国家站点后重试。');
  }

  const cacheKey = cleanCountry + '_' + cleanAsin + '_full62';
  if (options.forceRefresh === false) {
    const cached = localCache.asins[cacheKey];
    if (cached?.product?.title) return { ...cached, fromCache: true };
  }

  const dateString = (offsetDays) => {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const monthString = (offsetMonths) => {
    const date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() + offsetMonths);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  };
  const userTask = options.userTask || ('查询 ASIN ' + cleanAsin + ' 在 ' + cleanCountry + ' 站点的西柚竞品信息');
  const manifestMap = new Map();
  for (const tool of toolsCatalog) {
    const inputArgs = { ...(tool.sampleArgs || {}) };
    const properties = tool.properties || {};
    if (properties.asin || Object.prototype.hasOwnProperty.call(inputArgs, 'asin')) inputArgs.asin = cleanAsin;
    if (properties.asins || Array.isArray(inputArgs.asins)) inputArgs.asins = [cleanAsin];
    if (properties.primaryAsin || Object.prototype.hasOwnProperty.call(inputArgs, 'primaryAsin')) inputArgs.primaryAsin = cleanAsin;
    if (properties.country || Object.prototype.hasOwnProperty.call(inputArgs, 'country')) inputArgs.country = cleanCountry;
    if (properties.start_date && !inputArgs.start_date) inputArgs.start_date = dateString(-14);
    if (properties.end_date && !inputArgs.end_date) inputArgs.end_date = dateString(0);
    if (properties.start_week && !inputArgs.start_week) inputArgs.start_week = dateString(-84);
    if (properties.end_week && !inputArgs.end_week) inputArgs.end_week = dateString(0);
    if (properties.start_month && !inputArgs.start_month) inputArgs.start_month = monthString(-5);
    if (properties.end_month && !inputArgs.end_month) inputArgs.end_month = monthString(0);
    manifestMap.set(tool.name, {
      name: tool.name,
      category: tool.category,
      categoryName: tool.categoryName,
      summary: tool.summary,
      fullDesc: tool.fullDesc,
      status: 'AVAILABLE',
      latency: null,
      costCredits: 0,
      inputArgs,
      data: null,
      error: null,
    });
  }

  const resultMap = {};
  const failures = [];
  const runTool = async (toolName, args, intentSummary) => {
    const item = manifestMap.get(toolName);
    if (item) {
      item.status = 'RUNNING';
      item.inputArgs = { ...args };
    }
    try {
      const response = await callXiyouMcp(toolName, {
        ...args,
        user_task: userTask,
        intent_summary: intentSummary,
      });
      const envelope = response.data;
      let payload = envelope;
      for (let depth = 0; depth < 3; depth += 1) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.prototype.hasOwnProperty.call(payload, 'data')) break;
        const wrapperKeys = ['status', 'success', 'cost_credits', 'message', 'code'];
        if (wrapperKeys.some((key) => Object.prototype.hasOwnProperty.call(payload, key)) || Object.keys(payload).length === 1) {
          payload = payload.data;
        } else {
          break;
        }
      }
      resultMap[toolName] = payload;
      if (item) {
        item.status = 'SUCCESS';
        item.latency = response.duration;
        item.costCredits = Number(response.costCredits || envelope?.cost_credits || 0);
        item.data = envelope;
      }
      return payload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ toolName, message });
      if (item) {
        item.status = 'ERROR';
        item.error = message;
      }
      return null;
    }
  };

  // Quota is free. Confirm access before issuing billable product calls.
  const quotaData = await runTool(
    'get_account_credit_quota',
    {},
    '确认 ASIN 竞品分析开始前的西柚 MCP 可调用状态与额度。',
  );
  if (!quotaData) {
    throw new Error(failures[failures.length - 1]?.message || '西柚 MCP 额度检查失败，未发起商品数据查询。');
  }
  if (quotaData.callable === false || quotaData.accountStatus === 'DISABLED') {
    const reason = Array.isArray(quotaData.restrictions) ? quotaData.restrictions.join('、') : quotaData.accountStatus;
    throw new Error('西柚 MCP 当前不可用：' + (reason || '账户当前不可调用') + '。未发起商品数据查询。');
  }

  const keywordPageSize = 100;
  const trendEndDate = dateString(0);
  const jobs = [
    {
      name: 'get_asin_info',
      args: { asins: [cleanAsin], country: cleanCountry },
      intent: '获取该 ASIN 的标题、图片、价格、评分、品牌、五点、尺寸、配送费用和类目等商品详情。',
    },
    {
      name: 'get_asin_orders_last_30_days',
      args: { asins: [cleanAsin], country: cleanCountry },
      intent: '获取该 ASIN 最近 30 天订单量，用于展示商品近期销量规模。',
    },
    {
      name: 'get_asin_bsr',
      args: { asin: cleanAsin, country: cleanCountry },
      intent: '获取该 ASIN 当前 BSR 排名和 Amazon 类目路径。',
    },
    {
      name: 'get_asin_traffic',
      args: { asins: [cleanAsin], country: cleanCountry },
      intent: '获取该 ASIN 近 7 天自然流量、广告流量和流量变化。',
    },
    {
      name: 'get_asin_keywords',
      args: { asin: cleanAsin, country: cleanCountry, page: 1, page_size: keywordPageSize },
      intent: '获取该 ASIN 近 7 天流量关键词和自然/广告排名，首批返回最多 ' + keywordPageSize + ' 条。',
    },
    {
      name: 'get_asin_traffic_trends_weekly',
      args: { asin: cleanAsin, country: cleanCountry, start_week: dateString(-84), end_week: trendEndDate },
      intent: '获取最近 12 周的自然与广告流量走势，填充 ASIN 历史流量图。',
    },
    {
      name: 'get_asin_keyword_count_trends',
      args: { asins: [cleanAsin], country: cleanCountry, start_date: dateString(-14), end_date: trendEndDate },
      intent: '获取最近 15 天关键词收录数量变化，填充 ASIN 关键词覆盖趋势图。',
    },
    {
      name: 'get_asin_variations',
      args: { asin: cleanAsin, country: cleanCountry },
      intent: '获取该 ASIN 的父体、子体和变体属性。',
    },
    {
      name: 'get_parent_asin_keywords',
      args: { asin: cleanAsin, country: cleanCountry, page: 1, page_size: 20 },
      intent: '获取该 ASIN 所属父体的核心关键词和各变体排名，用于补足父体级搜索流量结构。',
    },
    {
      name: 'get_parent_asin_ad_overview',
      args: { asin: cleanAsin, country: cleanCountry },
      intent: '获取该 ASIN 所属父体近 7 天广告规模、投放变体和关键词概况。',
    },
    {
      name: 'get_parent_asin_ad_campaigns',
      args: { asin: cleanAsin, country: cleanCountry, page: 1, page_size: 20, cycleFilter: { period: 'last7days' } },
      intent: '获取该 ASIN 所属父体近 7 天广告活动清单和活动流量。',
    },
  ];

  let nextJob = 0;
  const workerCount = Math.min(4, jobs.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextJob < jobs.length) {
      const job = jobs[nextJob++];
      await runTool(job.name, job.args, job.intent);
    }
  }));

  const getList = (value) => {
    const queue = [value];
    const visited = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (!current || typeof current !== 'object' || visited.has(current)) continue;
      visited.add(current);
      if (Array.isArray(current)) return current;
      for (const key of ['entities', 'list', 'items', 'records', 'campaigns']) {
        if (Array.isArray(current[key])) return current[key];
      }
      for (const key of ['data', 'result', 'payload']) {
        if (current[key] && typeof current[key] === 'object') queue.push(current[key]);
      }
    }
    return [];
  };
  const getTrendRows = (value) => {
    if (Array.isArray(value)) return value.flatMap(getTrendRows);
    if (!value || typeof value !== 'object') return [];
    for (const key of ['trends', 'series', 'items', 'records', 'days', 'points', 'periods', 'keywordCounts', 'asins', 'list', 'entities', 'data', 'result']) {
      if (value[key] && typeof value[key] === 'object') {
        const rows = getTrendRows(value[key]);
        if (rows.length) return rows;
      }
    }
    return ['date', 'day', 'timestamp', 'snapshotDate', 'week', 'startDate', 'weekStartDate', 'startWeek', 'period'].some((key) => value[key] != null) ? [value] : [];
  };
  const infoPayload = resultMap.get_asin_info;
  const infoList = getList(infoPayload);
  const productInfo = infoList.find((item) => String(item.asin || '').toUpperCase() === cleanAsin) || infoList[0] || infoPayload?.product || infoPayload || {};
  const ordersPayload = resultMap.get_asin_orders_last_30_days;
  const orderList = getList(ordersPayload);
  const ordersData = orderList.find((item) => String(item.asin || '').toUpperCase() === cleanAsin) || orderList[0] || ordersPayload?.product || ordersPayload || {};
  const trafficPayload = resultMap.get_asin_traffic;
  const trafficList = getList(trafficPayload);
  const trafficData = trafficList.find((item) => String(item.asin || '').toUpperCase() === cleanAsin) || trafficList[0] || trafficPayload?.product || trafficPayload || {};
  const bsrData = resultMap.get_asin_bsr || {};
  const keywordsPayload = resultMap.get_asin_keywords || {};
  const keywordsList = getList(keywordsPayload);
  const weeklyTrafficTrends = getTrendRows(resultMap.get_asin_traffic_trends_weekly);
  const keywordCountTrends = getTrendRows(resultMap.get_asin_keyword_count_trends);
  const parentKeywordsPayload = resultMap.get_parent_asin_keywords;
  const parentKeywordList = getList(parentKeywordsPayload);
  const variationsData = resultMap.get_asin_variations || {};
  const rawChildren = variationsData.childAsins || variationsData.children || [];
  const childAsins = getList(rawChildren).map((child) => typeof child === 'string' ? child : child.asin).filter(Boolean);
  const adOverviewData = resultMap.get_parent_asin_ad_overview || {};
  const adCampaignsData = resultMap.get_parent_asin_ad_campaigns || {};
  const adCampaignsList = getList(adCampaignsData);

  const numberOrNull = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const totalKeywordsCount = numberOrNull(keywordsPayload.total ?? keywordsPayload.searchTermCount) ?? keywordsList.length;
  const price = numberOrNull(productInfo.price);
  const stars = numberOrNull(productInfo.stars);
  const ratings = numberOrNull(productInfo.ratings);
  const orders = numberOrNull(ordersData.orders ?? ordersData.last30daysOrders ?? ordersData.ordersLast30d);
  const organicTraffic = numberOrNull(trafficData.organicTraffic ?? trafficData.organic ?? trafficData.naturalTraffic);
  const adTraffic = numberOrNull(trafficData.advertisingTraffic ?? trafficData.adTraffic ?? trafficData.advertising);
  const totalTraffic = numberOrNull(trafficData.totalTraffic ?? trafficData.total)
    ?? (organicTraffic !== null && adTraffic !== null ? organicTraffic + adTraffic : null);
  const organicRatio = numberOrNull(trafficData.organicTrafficRatio ?? trafficData.organicRatio)
    ?? (totalTraffic > 0 && organicTraffic !== null ? organicTraffic / totalTraffic : null);
  const adRatio = numberOrNull(trafficData.advertisingTrafficRatio ?? trafficData.adRatio)
    ?? (totalTraffic > 0 && adTraffic !== null ? adTraffic / totalTraffic : null);
  const classificationRanks = Array.isArray(bsrData.classificationRanks) ? bsrData.classificationRanks : [];
  const mainRank = classificationRanks[0] || null;
  const categoryTree = bsrData.amzCategoryTree || {};
  const internalCategory = productInfo.internalCategoryTree || {};
  const internalCategoryName = internalCategory.categoryName?.translated || internalCategory.categoryName?.original;
  const rawBsrPath = bsrData.amzCategoryPath;
  const bsrCategory = (Array.isArray(rawBsrPath) ? rawBsrPath.join(' › ') : rawBsrPath) || categoryTree.browseName?.translated
    || categoryTree.browseName?.original || internalCategoryName || '—';

  const formattedKeywords = keywordsList.map((keyword) => {
    const traffic = keyword.trafficSummary?.traffic || keyword.traffic || {};
    const organic = numberOrNull(traffic.organic ?? traffic.organicTraffic);
    const advertising = numberOrNull(traffic.advertising ?? traffic.advertisingTraffic);
    const total = numberOrNull(traffic.total ?? keyword.totalTraffic)
      ?? (organic !== null && advertising !== null ? organic + advertising : null);
    const ranks = Array.isArray(keyword.ranks) ? keyword.ranks : [];
    const organicRank = ranks.find((rank) => rank.position === 'or')?.totalRank
      || ranks.find((rank) => rank.position === 'or')?.pageRank || null;
    const adRank = ranks.find((rank) => ['sp', 'sor', 'sb', 'sbv'].includes(rank.position))?.totalRank
      || ranks.find((rank) => ['sp', 'sor', 'sb', 'sbv'].includes(rank.position))?.pageRank || null;
    return {
      searchTerm: keyword.searchTerm || keyword.keyword || '',
      searchTermZh: keyword.searchTermZh || null,
      totalTraffic: total,
      organicTraffic: organic,
      adTraffic: advertising,
      organicRank,
      adRank,
      trafficRatio: totalTraffic > 0 && total !== null ? total / totalTraffic : null,
      raw: keyword,
    };
  });

  const title = productInfo.title || '';
  const brand = productInfo.brand || '';
  const fulfillmentType = productInfo.fulfillmentType || '';
  const fbaFee = numberOrNull(productInfo.fbaFee);
  const last30dOrders = orders;
  const estimatedRevenue = orders !== null && price !== null ? Math.round(orders * price * 100) / 100 : null;
  const campaignsCount = numberOrNull(adOverviewData.campaignCount ?? adOverviewData.campaignsCount)
    ?? numberOrNull(adCampaignsData.totalCount ?? adCampaignsData.total)
    ?? (Array.isArray(adCampaignsData.campaigns) ? adCampaignsData.campaigns.length : null);
  const keywordsCount = numberOrNull(adOverviewData.keywordCount ?? adOverviewData.keywordsCount);
  const trafficScore = totalTraffic > 0 ? Math.min(100, Math.round(Math.log10(Math.max(10, totalTraffic)) * 16)) : null;
  const organicScore = organicRatio !== null ? Math.min(100, Math.round(organicRatio * 100)) : null;
  const salesScore = orders > 0 ? Math.min(100, Math.round(Math.log10(Math.max(10, orders)) * 20)) : null;
  const reputationScore = stars !== null ? (stars >= 4 ? Math.min(100, Math.round((stars - 3.5) * 50 + Math.min(25, Math.log10(Math.max(10, ratings || 0)) * 6))) : 40) : null;
  const variationScore = childAsins.length ? Math.min(100, childAsins.length * 8) : null;
  const adStrengthScore = campaignsCount ? Math.min(100, Math.round(campaignsCount * 12 + (keywordsCount || 0) * 2)) : null;
  const radar = {
    traffic: trafficScore,
    organic: organicScore,
    sales: salesScore,
    reputation: reputationScore,
    variation: variationScore,
    adStrength: adStrengthScore,
  };
  const scoreParts = [
    [trafficScore, 0.25], [organicScore, 0.20], [salesScore, 0.25],
    [reputationScore, 0.15], [variationScore, 0.10], [adStrengthScore, 0.05],
  ].filter(([score]) => score !== null);
  const overallScore = scoreParts.length >= 3
    ? Math.round(scoreParts.reduce((sum, [score, weight]) => sum + score * weight, 0) / scoreParts.reduce((sum, [, weight]) => sum + weight, 0))
    : null;

  const manifestList = Array.from(manifestMap.values());
  const executedCount = manifestList.filter((item) => item.status === 'SUCCESS').length;
  const failedCount = manifestList.filter((item) => item.status === 'ERROR').length;
  const totalCostCredits = manifestList.reduce((sum, item) => sum + (Number(item.costCredits) || 0), 0);
  const resultPayload = {
    asin: cleanAsin,
    country: cleanCountry,
    analyzedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    dataStatus: title ? (failures.length ? 'PARTIAL' : 'SUCCESS') : 'NO_PRODUCT',
    errors: failures,
    overallScore,
    radar,
    pipelineStats: {
      totalTools: toolsCatalog.length,
      autoRunCount: jobs.length + 1,
      executedCount,
      failedCount,
      standbyCount: manifestList.filter((item) => item.status === 'AVAILABLE').length,
      totalCostCredits,
      totalPipelineDuration: Date.now() - startTime,
    },
    toolsExecutionManifest: manifestList,
    product: {
      ...productInfo,
      title,
      brand,
      price,
      currency: productInfo.currency || '',
      stars,
      ratings,
      streetDate: productInfo.streetDate || '',
      fulfillmentType,
      fbaFee,
      referralFeeRatio: numberOrNull(productInfo.referralFeeRatio),
      mainImage: productInfo.bigPicUrl || productInfo.smallPicUrl || productInfo.mainImage || '',
      amazonUrl: productInfo.amazonUrl || ('https://www.amazon.com/dp/' + cleanAsin),
      bulletPoints: Array.isArray(productInfo.bulletPoints)
        ? productInfo.bulletPoints
        : Array.isArray(productInfo.bulletPoint) ? productInfo.bulletPoint : productInfo.bulletPoint ? [productInfo.bulletPoint] : [],
      size: productInfo.size || productInfo.dimensions?.productSize || null,
      weight: productInfo.weight || productInfo.dimensions?.productWeight || null,
      dimensions: productInfo.dimensions || null,
      internalCategoryTree: internalCategory,
      categoryName: bsrCategory,
    },
    traffic: {
      totalTraffic,
      organicTraffic,
      adTraffic,
      organicRatio,
      adRatio,
      weeklyTrends: weeklyTrafficTrends,
    },
    sales: {
      last30dOrders,
      estMonthlyRevenue: estimatedRevenue,
      orderTrends: [],
    },
    bsr: {
      classificationRanks,
      mainRank,
      subRank: classificationRanks[1] || null,
      amzCategoryPath: bsrCategory,
      bsrTrends: [],
    },
    keywords: {
      list: formattedKeywords,
      totalCount: totalKeywordsCount,
      keywordCountTrends,
      topTerm: formattedKeywords[0]?.searchTerm || '',
      relatedKeywords: [],
      abaTrends: [],
    },
    variations: {
      parentAsin: variationsData.parentAsin || cleanAsin,
      childCount: childAsins.length,
      childAsins: childAsins.map((childAsin) => {
        const source = getList(rawChildren).find((item) => (typeof item === 'string' ? item : item.asin) === childAsin);
        return typeof source === 'string' ? { asin: source, dimensions: {}, price: null } : {
          asin: childAsin,
          dimensions: source?.dimensions || source?.variationAttributes || {},
          price: numberOrNull(source?.price),
        };
      }),
    },
    adOverview: {
      active: campaignsCount == null ? null : campaignsCount > 0,
      campaignsCount,
      keywordsCount,
      parentKeywordCount: parentKeywordsPayload == null ? null : numberOrNull(parentKeywordsPayload.total ?? parentKeywordsPayload.searchTermCount) ?? parentKeywordList.length,
      parentKeywords: parentKeywordList.map((keyword) => ({
        searchTerm: keyword.searchTerm || keyword.keyword || '',
        searchTermZh: keyword.searchTermZh || null,
        asinCount: numberOrNull(keyword.asinCount) ?? (Array.isArray(keyword.asins) ? keyword.asins.length : 0),
        totalTraffic: (Array.isArray(keyword.asins) ? keyword.asins : []).reduce((sum, item) => sum + (numberOrNull(item.trafficSummary?.traffic?.total) || 0), 0),
        asins: Array.isArray(keyword.asins) ? keyword.asins : [],
      })),
      campaigns: adCampaignsList.slice(0, 20),
      adChanges: [],
      infoChanges: [],
    },
    quota: {
      totalAvailable: numberOrNull(quotaData?.totalAvailable),
      weeklyRemaining: numberOrNull(quotaData?.weekly?.remaining),
      monthlyRemaining: numberOrNull(quotaData?.monthly?.remaining),
    },
  };

  if (title) {
    localCache.asins[cacheKey] = resultPayload;
    localCache.history = [
      {
        asin: cleanAsin,
        country: cleanCountry,
        title: title.slice(0, 80),
        brand: brand || '—',
        price: price ?? 0,
        score: overallScore,
        image: resultPayload.product.mainImage,
        analyzedAt: resultPayload.analyzedAt,
      },
      ...localCache.history.filter((item) => !(item.asin === cleanAsin && item.country === cleanCountry)),
    ].slice(0, 20);
    saveCache(localCache);
  }

  return resultPayload;
}

// 2. Multi-ASIN Comparison Engine
async function aggregateMultiAsinComparison(asins = [], country = 'US') {
  const cleanAsins = asins.map(a => String(a).trim().toUpperCase()).filter(a => /^[A-Z0-9]{10}$/.test(a));
  if (cleanAsins.length < 2) throw new Error('对比分析至少需要 2 个有效的亚马逊 ASIN');

  const [multiKwRes, infoRes, ordersRes] = await Promise.allSettled([
    callXiyouMcp('get_multi_asin_keyword_comparison', { asins: cleanAsins, country, page_size: 40 }),
    callXiyouMcp('get_asin_info', { asins: cleanAsins, country }),
    callXiyouMcp('get_asin_orders_last_30_days', { asins: cleanAsins, country }),
  ]);

  const rawMultiKw = multiKwRes.status === 'fulfilled' ? multiKwRes.value?.data : null;
  const rawInfo = infoRes.status === 'fulfilled' ? infoRes.value?.data : null;
  const rawOrders = ordersRes.status === 'fulfilled' ? ordersRes.value?.data : null;

  const kwList = rawMultiKw?.data?.list || [];
  const infoMap = {};
  (rawInfo?.data?.entities || rawInfo?.data?.list || []).forEach(p => { infoMap[p.asin] = p; });
  const ordersMap = {};
  (rawOrders?.data?.entities || rawOrders?.data?.list || []).forEach(o => { ordersMap[o.asin] = o.orders ?? o.last30daysOrders; });

  const productsSummary = cleanAsins.map(asin => {
    const p = infoMap[asin] || {};
    return {
      asin,
      title: p.title || 'Amazon Item',
      brand: p.brand || '—',
      price: p.price ? Number(p.price) : null,
      stars: p.stars ? Number(p.stars) : null,
      ratings: p.ratings ? Number(p.ratings) : null,
      image: p.bigPicUrl || p.smallPicUrl || p.mainImage || '',
      ordersLast30d: ordersMap[asin] ?? null,
    };
  });

  const sharedKeywords = [];
  const exclusiveKeywords = {};
  cleanAsins.forEach(a => { exclusiveKeywords[a] = []; });

  kwList.forEach(item => {
    const coveredAsins = (item.asins || []).map(x => x.asin);
    const kwRow = {
      searchTerm: item.searchTerm,
      searchTermZh: item.searchTermZh || null,
      asinCount: item.asinCount || coveredAsins.length,
      asinsDetail: (item.asins || []).map(a => ({
        asin: a.asin,
        organicRank: a.ranks?.find(r => r.position === 'or')?.totalRank || a.ranks?.find(r => r.position === 'or')?.pageRank || null,
        adRank: a.ranks?.find(r => r.position === 'sp' || r.position === 'sor')?.totalRank || a.ranks?.find(r => r.position === 'sp' || r.position === 'sor')?.pageRank || null,
        traffic: a.trafficSummary?.traffic?.total || 0,
      })),
    };
    if (kwRow.asinCount >= 2) sharedKeywords.push(kwRow);
    else if (kwRow.asinCount === 1 && coveredAsins[0] && exclusiveKeywords[coveredAsins[0]]) exclusiveKeywords[coveredAsins[0]].push(kwRow);
  });

  return {
    asins: cleanAsins,
    country,
    products: productsSummary,
    totalKeywordsCount: kwList.length,
    sharedCount: sharedKeywords.length,
    sharedKeywords: sharedKeywords.slice(0, 30),
    exclusiveKeywords,
  };
}

// 3. Keyword Intelligence Engine
async function aggregateKeywordAnalysis(keyword, country = 'US') {
  const cleanKeyword = String(keyword || '').trim();
  if (!cleanKeyword) throw new Error('请输入有效的亚马逊关键词');

  const [infoRes, relatedRes, asinAnalysisRes, abaTrendsRes] = await Promise.allSettled([
    callXiyouMcp('get_keyword_info', { keywords: [cleanKeyword], country }),
    callXiyouMcp('find_related_keywords', { keyword: cleanKeyword, country }),
    callXiyouMcp('get_keyword_asin_analysis', { keyword: cleanKeyword, country }),
    callXiyouMcp('get_keyword_aba_trends', { keywords: [cleanKeyword], country }),
  ]);

  const rawInfo = infoRes.status === 'fulfilled' ? infoRes.value?.data : null;
  const rawRelated = relatedRes.status === 'fulfilled' ? relatedRes.value?.data : null;
  const rawAsinAnalysis = asinAnalysisRes.status === 'fulfilled' ? asinAnalysisRes.value?.data : null;
  const rawAba = abaTrendsRes.status === 'fulfilled' ? abaTrendsRes.value?.data : null;

  const mainInfo = rawInfo?.data?.list?.[0] || {};
  const relatedList = (rawRelated?.data?.list || []).slice(0, 30);
  const asinList = (rawAsinAnalysis?.data?.list || []).slice(0, 15);
  const abaTrends = rawAba?.data?.list?.[0]?.trends || [];

  return {
    keyword: cleanKeyword,
    country,
    searchVolume: mainInfo.weeklySearchVolume || mainInfo.abaReport?.weeklySearchVolume || null,
    searchFrequencyRank: mainInfo.searchFrequencyRank || mainInfo.abaReport?.searchFrequencyRank || null,
    clickConversionRate: mainInfo.clickConversionRate ? Number(mainInfo.clickConversionRate) : null,
    competitiveDifficulty: mainInfo.competitiveDifficulty || null,
    competitiveDifficultyTier: mainInfo.competitiveDifficultyTier || 'medium',
    costPerClick: mainInfo.costPerClick || null,
    topAsins: mainInfo.topAsins || mainInfo.abaReport?.topAsins || [],
    relatedKeywords: relatedList.map(r => ({
      searchTerm: r.searchTerm,
      searchTermZh: r.searchTermZh || null,
      searchVolume: r.searchTermInfo?.abaReport?.weeklySearchVolume || null,
      abaRank: r.searchTermInfo?.abaReport?.searchFrequencyRank || null,
      clickShare: r.searchTermInfo?.abaReport?.clickShare || null,
      conversionShare: r.searchTermInfo?.abaReport?.conversionShare || null,
    })),
    topTrafficAsins: asinList.map(a => ({
      asin: a.asin,
      title: a.title || 'Amazon Item',
      brand: a.brand || '—',
      image: a.bigPicUrl || a.mainImage || '',
      price: a.price || null,
      totalTraffic: a.traffic?.total || 0,
      organicRank: a.ranks?.organic?.totalRank || null,
      adRank: a.ranks?.advertising?.totalRank || null,
    })),
    abaTrends: abaTrends.slice(-12),
  };
}

// 4. Category Market Engine
async function aggregateCategorySearch(query = '', country = 'US', cycleDate = '2026-10-01') {
  const resp = await callXiyouMcp('search_market_insight_categories', {
    country,
    query: query || '',
    cycleFilter: { startDate: cycleDate || '2026-10-01' },
    pageSize: 15,
  });
  const rawList = resp?.data?.data?.list || [];
  return {
    query,
    country,
    cycleDate,
    categories: rawList.map(c => ({
      categoryId: c.categoryId,
      name: c.categoryName?.translated || c.categoryName?.original || 'Category',
      nameEn: c.categoryName?.original || '',
      level: c.level,
      parentCount: c.primaryAsinCount || c.activePrimaryAsinCount || 0,
      monthlySales: c.sales?.value || 0,
      monthlyRevenue: c.salesRevenue?.value || 0,
      salesMom: c.sales?.mom || null,
      newProductSalesRatio: c.newProductSalesRatio || null,
      newProductCount: c.newProductPrimaryAsinCount || 0,
      childrenCount: c.childrenCount || 0,
    })),
  };
}

// 5. Breakout Products Engine
async function aggregateBreakoutProducts(country = 'US') {
  const resp = await callXiyouMcp('discover_breakout_products', { country });
  const list = resp?.data?.data?.list || [];
  return {
    country,
    timestamp: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    products: list.map(item => {
      const p = item.product || {};
      const sales = item.asinsTrends?.periods?.find(x => x.period === 'last30days')?.sales || {};
      const rev = item.asinsTrends?.periods?.find(x => x.period === 'last30days')?.salesRevenue || {};
      return {
        asin: item.asin || p.asin,
        title: p.title || 'Potential Breakout Item',
        brand: p.brand || '—',
        price: p.price ? Number(p.price) : null,
        stars: p.stars ? Number(p.stars) : null,
        ratings: p.ratings ? Number(p.ratings) : null,
        image: p.bigPicUrl || p.mainImage || '',
        salesLast30d: sales.value || null,
        salesMomRate: sales.mom?.rate ? Number(sales.mom.rate) : null,
        revenueLast30d: rev.value ? Number(rev.value) : null,
      };
    }),
  };
}

// Server Setup
const server = new Server(
  { name: 'xydc-asin-analyzer', version: '2.9.0' },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'open_asin_analyzer',
      title: '打开西柚洞察·全维亚马逊跨境情报总台',
      description: '打开西柚竞品分析工作台。输入 ASIN 后查询商品详情、销量、流量、关键词、变体和父体广告；62 项 MCP 工具均可在工具箱按需执行。',
      inputSchema: {
        type: 'object',
        properties: {
          asin: { type: 'string', description: '亚马逊 ASIN' },
          country: { type: 'string', enum: ['US', 'UK', 'DE', 'JP', 'CA', 'FR', 'IT', 'ES'], default: 'US' },
          tab: { type: 'string', enum: ['asin', 'compare', 'keyword', 'category', 'breakout', 'tools', 'quota'], default: 'asin' },
        },
      },
      _meta: {
        ui: { resourceUri: APP_URI },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: '西柚全维跨境情报' },
            { type: 'global', title: '西柚全维跨境情报' },
          ],
        },
      },
    },
    {
      name: 'analyze_asin',
      title: '查询 ASIN 商品详情与竞品指标',
      description: '输入 ASIN 后先检查西柚 MCP 额度，再查询商品详情、近30天订单、近7天流量、BSR、关键词、12周流量与15天关键词数量趋势、变体、父体关键词和父体广告。其余工具可在工具箱按需执行。',
      inputSchema: {
        type: 'object',
        properties: {
          asin: { type: 'string', description: '亚马逊 10 位 ASIN' },
          country: { type: 'string', default: 'US' },
          user_task: { type: 'string', description: '当前 ASIN 查询任务的简短原始描述' },
        },
        required: ['asin'],
      },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
    {
      name: 'execute_mcp_tool',
      title: '执行任意西柚 MCP 原生工具',
      description: '直接调用西柚官方 62 项任意原生 MCP 工具，返回标准 JSON-RPC 结果。',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string', description: '原生工具名称' },
          arguments: { type: 'object', description: '入参字典' },
          user_task: { type: 'string', description: '发起当前查询的原始用户任务' },
          intent_summary: { type: 'string', description: '本次 MCP 调用的目的' },
        },
        required: ['tool_name', 'arguments'],
      },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
    {
      name: 'compare_asins',
      title: '多 ASIN 攻防矩阵横向对比',
      description: '对比 2~5 个 ASIN 的关键词重合交集、独占词分布与规格 PK。',
      inputSchema: {
        type: 'object',
        properties: {
          asins: { type: 'array', items: { type: 'string' } },
          country: { type: 'string', default: 'US' },
        },
        required: ['asins'],
      },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
    {
      name: 'analyze_keyword',
      title: '关键词全维情报挖掘',
      description: '深度分析关键词搜索量、ABA排位、建议CPC与衍生相关词。',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          country: { type: 'string', default: 'US' },
        },
        required: ['keyword'],
      },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
    {
      name: 'search_categories',
      title: '类目市场大盘与机会发现',
      description: '检索品类关键词对应类目的市场体量、销售额与新品份额。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          country: { type: 'string', default: 'US' },
          cycleDate: { type: 'string', default: '2026-10-01' },
        },
      },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
    {
      name: 'discover_breakouts',
      title: '发现黑马爆发潜力新品',
      description: '扫描最新高爆发潜力单品与月销量增长倍率。',
      inputSchema: {
        type: 'object',
        properties: { country: { type: 'string', default: 'US' } },
      },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
    {
      name: 'get_quota',
      title: '查询西柚账户调用点数额度',
      description: '查询本月剩余额度、已消耗点数与重置日期。',
      inputSchema: { type: 'object', properties: {} },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
    {
      name: 'get_analyzer_state',
      title: '获取中控台缓存与状态',
      description: '获取中控台已收录历史、最近分析 ASIN 及工具目录。',
      inputSchema: { type: 'object', properties: {} },
      _meta: { ui: { visibility: ['app', 'model'] } },
    },
  ],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: APP_URI,
      name: '西柚全维跨境情报总台 UI',
      description: 'All-in-one Xiyou Insight Amazon Intelligence Suite (62 MCP Tools)',
      mimeType: 'text/html;profile=mcp-app',
      _meta: { ui: { prefersBorder: false } },
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri !== APP_URI) throw new Error(`Unknown resource URI: ${req.params.uri}`);
  if (!fs.existsSync(APP_HTML_PATH)) {
    throw new Error(`Built UI file missing at ${APP_HTML_PATH}. Run build script first.`);
  }
  return {
    contents: [
      {
        uri: APP_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: fs.readFileSync(APP_HTML_PATH, 'utf8'),
        _meta: { ui: { prefersBorder: false } },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    if (name === 'open_asin_analyzer') {
      let activeData = null;
      let targetAsin = args.asin ? String(args.asin).trim().toUpperCase() : '';
      let targetCountry = args.country || 'US';

      if (targetAsin) {
        activeData = await aggregateFull62AsinDeepDive(targetAsin, targetCountry, {
          forceRefresh: true,
          userTask: args.user_task,
        });
      } else if (localCache.history && localCache.history.length > 0) {
        const latest = localCache.history[0];
        const cacheKey = `${latest.country}_${latest.asin}_full62`;
        const cached = localCache.asins[cacheKey];
        const age = cached?.analyzedAt ? Date.now() - new Date(cached.analyzedAt).getTime() : Infinity;
        if (cached?.product?.title && age >= 0 && age < 1800000) activeData = { ...cached, fromCache: true };
      }

      const payload = {
        initialTab: args.tab || 'asin',
        activeAsin: activeData?.asin || targetAsin,
        country: activeData?.country || targetCountry,
        data: activeData,
        history: localCache.history || [],
        toolsCatalog,
      };

      return {
        content: [{ type: 'text', text: activeData?.fromCache
          ? '西柚竞品分析已打开，展示最近一次缓存结果；输入 ASIN 可重新查询实时数据。'
          : '西柚竞品分析已就绪，请输入 ASIN 后查询实时商品数据。' }],
        structuredContent: payload,
      };
    }

    if (name === 'analyze_asin') {
      const data = await aggregateFull62AsinDeepDive(args.asin, args.country || 'US', {
        forceRefresh: true,
        userTask: args.user_task,
      });
      const summary = data.dataStatus === 'NO_PRODUCT'
        ? `西柚 MCP 未返回 ASIN ${data.asin} 的商品基础信息；成功 ${data.pipelineStats.executedCount} 项，失败 ${data.pipelineStats.failedCount} 项。`
        : `ASIN ${data.asin} 查询完成：核心数据成功 ${data.pipelineStats.executedCount} 项，失败 ${data.pipelineStats.failedCount} 项，耗时 ${(data.pipelineStats.totalPipelineDuration / 1000).toFixed(1)} 秒。`;
      return {
        content: [{ type: 'text', text: summary }],
        structuredContent: { activeAsin: data.asin, country: data.country, data, history: localCache.history || [] },
      };
    }

    if (name === 'execute_mcp_tool') {
      const toolName = args.tool_name;
      const toolArgs = args.arguments || {};
      const currentAsin = toolArgs.asin || toolArgs.asins?.[0] || toolArgs.primaryAsin || '';
      const userTask = args.user_task || (currentAsin
        ? `在 Discover amzn 查询 ASIN ${currentAsin} 的西柚竞品数据`
        : `在 Discover amzn 手动执行西柚 MCP 工具 ${toolName}`);
      const intentSummary = args.intent_summary || toolsCatalog.find((tool) => tool.name === toolName)?.summary || `执行西柚 MCP 工具 ${toolName}。`;
      const result = await callXiyouMcp(toolName, { ...toolArgs, user_task: userTask, intent_summary: intentSummary });
      return {
        content: [{ type: 'text', text: `MCP 工具 ${toolName} 执行成功。` }],
        structuredContent: {
          mcpExecution: {
            toolName,
            executedAt: new Date().toLocaleTimeString(),
            result: result.data,
            duration: result.duration,
            costCredits: result.costCredits,
          },
        },
      };
    }

    if (name === 'compare_asins') {
      const compareData = await aggregateMultiAsinComparison(args.asins, args.country || 'US');
      return {
        content: [{ type: 'text', text: `已完成 ${compareData.asins.join(', ')} 对比，共有词 ${compareData.sharedCount} 个。` }],
        structuredContent: { compareData },
      };
    }

    if (name === 'analyze_keyword') {
      const keywordData = await aggregateKeywordAnalysis(args.keyword, args.country || 'US');
      return {
        content: [{ type: 'text', text: `关键词 "${keywordData.keyword}" 挖掘完成。` }],
        structuredContent: { keywordData },
      };
    }

    if (name === 'search_categories') {
      const categoryData = await aggregateCategorySearch(args.query || '', args.country || 'US', args.cycleDate || '2026-10-01');
      return {
        content: [{ type: 'text', text: `类目检索完成，共 ${categoryData.categories.length} 个类目。` }],
        structuredContent: { categoryData },
      };
    }

    if (name === 'discover_breakouts') {
      const breakoutData = await aggregateBreakoutProducts(args.country || 'US');
      return {
        content: [{ type: 'text', text: `黑马扫描完成，共 ${breakoutData.products.length} 款潜力单品。` }],
        structuredContent: { breakoutData },
      };
    }

    if (name === 'get_quota') {
      const res = await callXiyouMcp('get_account_credit_quota', {});
      const quota = res?.data?.data || res?.data?.quota || res?.data || {};
      return {
        content: [{ type: 'text', text: `本月剩余点数: ${quota.monthly?.remaining ?? '—'}` }],
        structuredContent: { quota },
      };
    }

    if (name === 'get_analyzer_state') {
      const latest = localCache.history[0];
      const cacheKey = latest ? `${latest.country}_${latest.asin}_full62` : '';
      const activeData = cacheKey ? (localCache.asins[cacheKey] || null) : null;
      return {
        content: [{ type: 'text', text: `已获取中控台状态。` }],
        structuredContent: {
          activeAsin: activeData?.asin || '',
          country: activeData?.country || 'US',
          data: activeData ? { ...activeData, fromCache: true } : null,
          history: localCache.history || [],
          toolsCatalog,
        },
      };
    }

    throw new Error(`未知工具: ${name}`);
  } catch (err) {
    console.error(`Tool execution error [${name}]:`, err);
    return {
      content: [{ type: 'text', text: `执行失败: ${err.message}` }],
      isError: true,
      structuredContent: { error: err.message },
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
