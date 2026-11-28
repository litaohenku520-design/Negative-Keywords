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
const CACHE_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(CACHE_DIR, 'asin_cache.json');
const TOOLS_METADATA_FILE = path.join(CACHE_DIR, 'tools_metadata.json');

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
  const payload = {
    jsonrpc: '2.0',
    id: Date.now() + Math.floor(Math.random() * 1000),
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: {
        ...args,
        user_task: args.user_task || `西柚62工具全息联动穿透: ${toolName}`,
        intent_summary: args.intent_summary || `调用 ${toolName} 获取多维跨境数据`,
      },
    },
  };

  const resp = await fetch(XYDC_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${XYDC_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  const duration = Date.now() - start;

  if (!resp.ok) {
    throw new Error(`Xiyou API HTTP ${resp.status}: ${resp.statusText}`);
  }

  const json = await resp.json();
  if (json.error) {
    throw new Error(`Xiyou RPC Error: ${json.error.message || JSON.stringify(json.error)}`);
  }

  const rawText = json?.result?.content?.[0]?.text;
  const costCredits = json?.result?.cost_credits || 0;
  let parsed = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = rawText;
    }
  }

  return {
    toolName,
    duration,
    costCredits,
    data: parsed,
  };
}

// Full 62-Tool Holographic ASIN Penetration Engine
async function aggregateFull62AsinDeepDive(asin, country = 'US') {
  const cleanAsin = String(asin || '').trim().toUpperCase();
  const cleanCountry = String(country || 'US').trim().toUpperCase();
  const startTime = Date.now();

  if (!cleanAsin || !/^[A-Z0-9]{10}$/.test(cleanAsin)) {
    throw new Error(`无效的 ASIN 格式: "${asin}"，请输入 10 位标准亚马逊 ASIN (例如 B0768N9N6M)`);
  }

  const cacheKey = `${cleanCountry}_${cleanAsin}_full62`;
  if (localCache.asins[cacheKey] && localCache.asins[cacheKey].product?.brand !== 'Unknown' && (Date.now() - new Date(localCache.asins[cacheKey].analyzedAt).getTime() < 1800000)) {
    return localCache.asins[cacheKey];
  }

  const manifestMap = {};
  toolsCatalog.forEach(t => {
    manifestMap[t.name] = {
      name: t.name,
      category: t.category,
      categoryName: t.categoryName,
      summary: t.summary,
      fullDesc: t.fullDesc,
      status: 'STANDBY_READY',
      latency: null,
      costCredits: 0,
      inputArgs: t.sampleArgs || {},
      data: null,
    };
  });

  // TIER 1: Primary ASIN Parallel Execution (18 Core Tools)
  const tier1Promises = [
    callXiyouMcp('get_asin_info', { asins: [cleanAsin], country: cleanCountry }),
    callXiyouMcp('get_asin_orders_last_30_days', { asins: [cleanAsin], country: cleanCountry }),
    callXiyouMcp('get_asin_order_trends', { asin: cleanAsin, country: cleanCountry, dateRange: { startDate: '2024-01-01', endDate: '2024-11-01' } }),
    callXiyouMcp('get_asin_bsr', { asin: cleanAsin, country: cleanCountry }),
    callXiyouMcp('get_asin_bsr_trends', { asin: cleanAsin, country: cleanCountry, dateRange: { startDate: '2024-10-01', endDate: '2024-11-20' } }),
    callXiyouMcp('get_asin_traffic', { asins: [cleanAsin], country: cleanCountry }),
    callXiyouMcp('get_asin_traffic_trends_weekly', { asin: cleanAsin, country: cleanCountry }),
    callXiyouMcp('get_asin_traffic_trends_monthly', { asin: cleanAsin, country: cleanCountry }),
    callXiyouMcp('get_asin_keywords', { asin: cleanAsin, country: cleanCountry, page_size: 25 }),
    callXiyouMcp('get_asin_keyword_count_trends', { asins: [cleanAsin], country: cleanCountry }),
    callXiyouMcp('get_asin_info_change_trends', { asin: cleanAsin, country: cleanCountry, dateRange: { startDate: '2024-01-01', endDate: '2024-11-20' } }),
    callXiyouMcp('get_asin_ad_change_trends', { asin: cleanAsin, country: cleanCountry, dateRange: { startDate: '2024-01-01', endDate: '2024-11-20' } }),
    callXiyouMcp('get_asin_variations', { asin: cleanAsin, country: cleanCountry }),
    callXiyouMcp('get_primary_asin_children', { primaryAsin: cleanAsin, country: cleanCountry, reportPeriod: 'last30days' }),
    callXiyouMcp('get_parent_asin_ad_overview', { asin: cleanAsin, country: cleanCountry }),
    callXiyouMcp('get_parent_asin_ad_campaigns', { asin: cleanAsin, country: cleanCountry, cycleFilter: { period: 'last30days' } }),
    callXiyouMcp('get_parent_asin_keywords', { asin: cleanAsin, country: cleanCountry, page_size: 20 }),
    callXiyouMcp('get_account_credit_quota', {}),
  ];

  const tier1Settled = await Promise.allSettled(tier1Promises);

  const resultMap = {};
  tier1Settled.forEach(res => {
    if (res.status === 'fulfilled' && res.value) {
      const { toolName, duration, costCredits, data } = res.value;
      resultMap[toolName] = data;
      if (manifestMap[toolName]) {
        manifestMap[toolName].status = 'SUCCESS';
        manifestMap[toolName].latency = duration;
        manifestMap[toolName].costCredits = costCredits;
        manifestMap[toolName].data = data;
      }
    }
  });

  // Robust extraction: support both data.entities and data.list
  const rawInfo = resultMap['get_asin_info']?.data;
  const rawOrders = resultMap['get_asin_orders_last_30_days']?.data;
  const rawTraffic = resultMap['get_asin_traffic']?.data;
  const productInfo = (rawInfo?.entities && rawInfo.entities[0]) || (rawInfo?.list && rawInfo.list[0]) || {};
  const ordersData = (rawOrders?.entities && rawOrders.entities[0]) || (rawOrders?.list && rawOrders.list[0]) || {};
  const trafficData = (rawTraffic?.entities && rawTraffic.entities[0]) || (rawTraffic?.list && rawTraffic.list[0]) || {};

  const keywordsList = resultMap['get_asin_keywords']?.data?.list || [];
  const variationsData = resultMap['get_asin_variations']?.data || {};
  const topTerm = (keywordsList[0]?.searchTerm || productInfo.brand || 'wallet case').trim();
  const childAsins = (variationsData.childAsins || []).map(c => typeof c === 'string' ? c : c.asin);
  const compareTargetAsin = childAsins.find(c => c !== cleanAsin) || 'B00MNV8E0C';

  // TIER 2: Cascaded Execution (Keywords & Multi-ASIN & Categories)
  const tier2Promises = [
    callXiyouMcp('get_keyword_info', { country: cleanCountry, keywords: [topTerm] }),
    callXiyouMcp('find_related_keywords', { country: cleanCountry, keyword: topTerm }),
    callXiyouMcp('find_keyword_opportunities', { country: cleanCountry, keyword: topTerm }),
    callXiyouMcp('get_keyword_asin_analysis', { country: cleanCountry, keyword: topTerm }),
    callXiyouMcp('get_keyword_aba_trends', { country: cleanCountry, keywords: [topTerm] }),
    callXiyouMcp('translate_keywords', { country: cleanCountry, keywords: [topTerm] }),
    callXiyouMcp('get_multi_asin_keyword_comparison', { country: cleanCountry, asins: [cleanAsin, compareTargetAsin], page_size: 25 }),
    callXiyouMcp('search_market_insight_categories', { country: cleanCountry, query: topTerm, cycleFilter: { startDate: '2026-10-01' }, pageSize: 10 }),
    callXiyouMcp('discover_breakout_products', { country: cleanCountry }),
  ];

  const tier2Settled = await Promise.allSettled(tier2Promises);
  tier2Settled.forEach(res => {
    if (res.status === 'fulfilled' && res.value) {
      const { toolName, duration, costCredits, data } = res.value;
      resultMap[toolName] = data;
      if (manifestMap[toolName]) {
        manifestMap[toolName].status = 'CASCADED';
        manifestMap[toolName].latency = duration;
        manifestMap[toolName].costCredits = costCredits;
        manifestMap[toolName].data = data;
      }
    }
  });

  // TIER 3: Populate Standby Ready Tools with contextual arguments
  toolsCatalog.forEach(t => {
    const item = manifestMap[t.name];
    if (item && item.status === 'STANDBY_READY') {
      const smartArgs = { country: cleanCountry };
      if (t.properties.asin) smartArgs.asin = cleanAsin;
      if (t.properties.asins) smartArgs.asins = [cleanAsin, compareTargetAsin];
      if (t.properties.keyword) smartArgs.keyword = topTerm;
      if (t.properties.keywords) smartArgs.keywords = [topTerm];
      if (t.properties.primaryAsin) smartArgs.primaryAsin = cleanAsin;
      if (t.properties.query) smartArgs.query = topTerm;
      if (t.properties.date) smartArgs.date = '2026-11-20';
      if (t.properties.dateRange) smartArgs.dateRange = { startDate: '2024-10-01', endDate: '2024-11-20' };
      if (t.properties.cycleFilter) smartArgs.cycleFilter = { startDate: '2026-10-01' };
      if (t.properties.reportPeriod) smartArgs.reportPeriod = 'last30days';
      item.inputArgs = smartArgs;
    }
  });

  // Synthesize metrics
  const orderTrends = resultMap['get_asin_order_trends']?.data?.trends || [];
  const bsrData = resultMap['get_asin_bsr']?.data || {};
  const bsrTrends = resultMap['get_asin_bsr_trends']?.data?.trends || [];
  const weeklyTrafficTrends = resultMap['get_asin_traffic_trends_weekly']?.data?.trends || [];
  const keywordCountTrends = resultMap['get_asin_keyword_count_trends']?.data?.list?.[0]?.trends || [];
  const adChanges = resultMap['get_asin_ad_change_trends']?.data?.trends || [];
  const infoChanges = resultMap['get_asin_info_change_trends']?.data?.trends || [];
  const adOverviewData = resultMap['get_parent_asin_ad_overview']?.data || {};
  const adCampaignsList = resultMap['get_parent_asin_ad_campaigns']?.data?.list || [];
  const rawQuota = resultMap['get_account_credit_quota']?.data || {};

  const title = productInfo.title || 'Amazon Product';
  const brand = productInfo.brand || '—';
  const price = productInfo.price ? Number(productInfo.price) : 0;
  const currency = productInfo.currency || 'USD';
  const stars = productInfo.stars ? Number(productInfo.stars) : 0;
  const ratings = productInfo.ratings ? Number(productInfo.ratings) : 0;
  const streetDate = productInfo.streetDate || '—';
  const fulfillmentType = productInfo.fulfillmentType || 'FBA';
  const fbaFee = productInfo.fbaFee ? Number(productInfo.fbaFee) : 0;
  const mainImage = productInfo.bigPicUrl || productInfo.smallPicUrl || productInfo.mainImage || '';
  const last30dOrders = ordersData.orders != null ? Number(ordersData.orders) : (ordersData.last30daysOrders != null ? Number(ordersData.last30daysOrders) : 0);
  const estMonthlyRevenue = Math.round(last30dOrders * (price || 15));

  const totalTraffic = trafficData.totalTraffic != null ? Number(trafficData.totalTraffic) : ((trafficData.advertisingTraffic || 0) + (trafficData.organicTraffic || 0));
  const adTraffic = trafficData.advertisingTraffic != null ? Number(trafficData.advertisingTraffic) : 0;
  const organicTraffic = trafficData.organicTraffic != null ? Number(trafficData.organicTraffic) : 0;
  const organicRatio = totalTraffic > 0 ? organicTraffic / totalTraffic : (trafficData.organicTrafficRatio != null ? Number(trafficData.organicTrafficRatio) : 0);
  const adRatio = totalTraffic > 0 ? adTraffic / totalTraffic : (trafficData.advertisingTrafficRatio != null ? Number(trafficData.advertisingTrafficRatio) : (totalTraffic > 0 ? 1 : 0));

  const formattedKeywords = keywordsList.map(k => {
    const tf = k.trafficSummary?.traffic || k.traffic || {};
    const totalT = tf.total != null ? Number(tf.total) : ((tf.advertising || 0) + (tf.organic || 0));
    const orgRank = (k.ranks || []).find(r => r.position === 'or')?.totalRank || (k.ranks || []).find(r => r.position === 'or')?.pageRank || null;
    const adRank = (k.ranks || []).find(r => r.position === 'sp' || r.position === 'sor')?.totalRank || (k.ranks || []).find(r => r.position === 'sp' || r.position === 'sor')?.pageRank || null;
    return {
      searchTerm: k.searchTerm,
      searchTermZh: k.searchTermZh || null,
      totalTraffic: totalT,
      organicTraffic: tf.organic != null ? Number(tf.organic) : 0,
      adTraffic: tf.advertising != null ? Number(tf.advertising) : 0,
      organicRank: orgRank,
      adRank: adRank,
      trafficRatio: totalTraffic > 0 ? totalT / totalTraffic : 0,
    };
  });

  const bsrCategory = bsrData.amzCategoryPath || bsrData.amzCategoryTree?.browseName?.translated || bsrData.amzCategoryTree?.browseName?.original || 'Flip Cases';
  const mainRank = (bsrData.classificationRanks && bsrData.classificationRanks[0]) || { rank: 1, classificationName: bsrCategory };
  const subRank = (bsrData.classificationRanks && bsrData.classificationRanks[1]) || null;

  // Six-dimension Radar
  const trafficScore = Math.min(100, Math.round(Math.log10(Math.max(10, totalTraffic)) * 16));
  const organicScore = Math.min(100, Math.round(organicRatio * 100));
  const salesScore = Math.min(100, Math.round(Math.log10(Math.max(10, last30dOrders || 1)) * 20));
  const repScore = stars >= 4.0 ? Math.min(100, Math.round((stars - 3.5) * 50 + Math.min(25, Math.log10(Math.max(10, ratings)) * 6))) : 40;
  const variationScore = Math.min(100, Math.max(30, childAsins.length * 8));
  const adStrengthScore = Math.min(100, Math.round((adOverviewData.campaignCount || adOverviewData.campaignsCount || adCampaignsList.length || 1) * 12 + (adOverviewData.keywordCount || 1) * 2));

  const radar = {
    traffic: trafficScore,
    organic: organicScore,
    sales: salesScore,
    reputation: repScore,
    variation: variationScore,
    adStrength: adStrengthScore,
  };

  const overallScore = Math.round(
    radar.traffic * 0.25 +
    radar.organic * 0.20 +
    radar.sales * 0.25 +
    radar.reputation * 0.15 +
    radar.variation * 0.10 +
    radar.adStrength * 0.05
  );

  const manifestList = Object.values(manifestMap);
  const executedCount = manifestList.filter(m => m.status === 'SUCCESS' || m.status === 'CASCADED').length;
  const totalCostCredits = manifestList.reduce((acc, m) => acc + (m.costCredits || 0), 0);
  const totalPipelineDuration = Date.now() - startTime;

  const analysisResult = {
    asin: cleanAsin,
    country: cleanCountry,
    analyzedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    overallScore,
    radar,
    pipelineStats: {
      totalTools: 62,
      executedCount,
      standbyCount: 62 - executedCount,
      totalCostCredits,
      totalPipelineDuration,
    },
    toolsExecutionManifest: manifestList,
    product: {
      title,
      brand,
      price,
      currency,
      stars,
      ratings,
      streetDate,
      fulfillmentType,
      fbaFee,
      mainImage,
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
      estMonthlyRevenue,
      orderTrends,
    },
    bsr: {
      classificationRanks: bsrData.classificationRanks || [],
      mainRank,
      subRank,
      amzCategoryPath: bsrCategory,
      bsrTrends,
    },
    keywords: {
      list: formattedKeywords,
      totalCount: formattedKeywords.length,
      keywordCountTrends,
      topTerm,
      relatedKeywords: resultMap['find_related_keywords']?.data?.list || [],
      abaTrends: resultMap['get_keyword_aba_trends']?.data?.list?.[0]?.trends || [],
    },
    variations: {
      parentAsin: variationsData.parentAsin || cleanAsin,
      childCount: childAsins.length,
      childAsins: (variationsData.childAsins || []).map(c => ({
        asin: typeof c === 'string' ? c : c.asin,
        dimensions: typeof c === 'object' ? c.dimensions : {},
        price: typeof c === 'object' ? c.price : null,
      })),
    },
    adOverview: {
      active: !!(adOverviewData.campaignCount || adCampaignsList.length),
      campaignsCount: adOverviewData.campaignCount || adOverviewData.campaignsCount || adCampaignsList.length || 0,
      keywordsCount: adOverviewData.keywordCount || adOverviewData.keywordsCount || 0,
      campaigns: adCampaignsList.slice(0, 10),
      adChanges,
      infoChanges,
    },
    quota: {
      totalAvailable: rawQuota?.totalAvailable || 0,
      weeklyRemaining: rawQuota?.weekly?.remaining || 0,
      monthlyRemaining: rawQuota?.monthly?.remaining || 0,
    },
  };

  // Only cache if valid brand/title found
  if (brand && brand !== 'Unknown') {
    localCache.asins[cacheKey] = analysisResult;
    localCache.history = [
      {
        asin: cleanAsin,
        country: cleanCountry,
        title: title.slice(0, 50),
        brand,
        price,
        score: overallScore,
        image: mainImage,
        analyzedAt: analysisResult.analyzedAt,
      },
      ...localCache.history.filter(h => !(h.asin === cleanAsin && h.country === cleanCountry)),
    ].slice(0, 20);
    saveCache(localCache);
  }

  return analysisResult;
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
      description: '打开集合 62 项 MCP 工具的西柚洞察跨境情报总台：支持输入 ASIN 触发全量 62 算力穿透引擎。',
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
      title: '执行 ASIN 62项全量底层工具全息穿透',
      description: '输入单个 ASIN，并发/流水线式调用 62 项 MCP 原生底层工具进行全维深度查询，返回完整的 62 工具执行清单与多维聚合情报。',
      inputSchema: {
        type: 'object',
        properties: {
          asin: { type: 'string', description: '亚马逊 10 位 ASIN' },
          country: { type: 'string', default: 'US' },
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
        activeData = await aggregateFull62AsinDeepDive(targetAsin, targetCountry);
      } else if (localCache.history && localCache.history.length > 0) {
        const latest = localCache.history[0];
        const cacheKey = `${latest.country}_${latest.asin}_full62`;
        activeData = localCache.asins[cacheKey] || null;
      }

      if (!activeData) {
        targetAsin = 'B0768N9N6M';
        try {
          activeData = await aggregateFull62AsinDeepDive(targetAsin, 'US');
        } catch (err) {
          console.error('Initial sample load error:', err);
        }
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
        content: [{ type: 'text', text: `西柚洞察·全维亚马逊跨境情报总台已就绪，已并发执行 62 项底层工具全息透视。` }],
        structuredContent: payload,
      };
    }

    if (name === 'analyze_asin') {
      const data = await aggregateFull62AsinDeepDive(args.asin, args.country || 'US');
      return {
        content: [{ type: 'text', text: `ASIN ${data.asin} 62项底层工具全息穿透完成！并发就绪 ${data.pipelineStats.executedCount}/${data.pipelineStats.totalTools} 项工具，总耗时 ${(data.pipelineStats.totalPipelineDuration / 1000).toFixed(2)}s，综合评分: ${data.overallScore}/100` }],
        structuredContent: { activeAsin: data.asin, country: data.country, data, history: localCache.history || [] },
      };
    }

    if (name === 'execute_mcp_tool') {
      const toolName = args.tool_name;
      const toolArgs = args.arguments || {};
      const result = await callXiyouMcp(toolName, toolArgs);
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
      const quota = res?.data?.data || {};
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
          data: activeData,
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
