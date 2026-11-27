import { normalizeAsin } from './amazonNegativeAsinTemplate';

export type AsinImportScope = 'campaign' | 'adGroup';

/**
 * Saihu/自动广告关联商品导出有时把 ASIN 放在“客户搜索词”列。
 * 不能只按表头包含 ASIN 判断，否则会把日期列误当成 ASIN。
 */
export function inferAsinColumn(
  headers: string[],
  rows: Array<Record<string, unknown>> = [],
): string {
  const direct = headers.find(header => (
    /^ASIN$/i.test(header)
    || /商品\s*ASIN/i.test(header)
    || /广告\s*ASIN/i.test(header)
    || /关联商品.*ASIN/i.test(header)
  ));
  if (direct) return direct;

  // 赛狐的“客户搜索词”在自动广告关联商品报告中实际承载 ASIN。
  const semantic = headers.find(header => (
    /客户搜索词|搜索词|关联商品|商品投放/i.test(header)
    && rows.some(row => Boolean(normalizeAsin(row[header])))
  ));
  if (semantic) return semantic;

  // 兼容其它没有标准表头的粘贴文件：只有在样本中确实能识别出 ASIN 时才采用。
  const sample = rows.slice(0, 100);
  const candidate = headers
    .map((header, index) => ({
      header,
      index,
      valid: sample.reduce((count, row) => count + (normalizeAsin(row[header]) ? 1 : 0), 0),
    }))
    .sort((a, b) => b.valid - a.valid || a.index - b.index)
    .find(item => item.valid > 0);
  return candidate?.header || headers[0] || '';
}

/**
 * 只有真实 Ad Group ID 列存在且至少有一个有效值时才默认广告组级。
 *
 * Amazon 官方的 Campaign Negative Product Targeting 模板固定包含
 * `Ad Group ID` 列，但广告活动级行会把这一列全部留空。不能仅凭表头
 * 存在就推断为广告组级，否则导入官方活动级模板后会错误要求 Ad Group ID。
 */
export function inferAsinImportScope(
  adGroupIdColumn?: string,
  rows: Array<Record<string, unknown>> = [],
): AsinImportScope {
  if (!adGroupIdColumn) return 'campaign';
  const hasRealAdGroupId = rows.some(row => {
    const value = String(row[adGroupIdColumn] ?? '').trim().replace(/\.0$/, '');
    return Boolean(value) && !/^ad\s*group\s*id$/i.test(value);
  });
  return hasRealAdGroupId ? 'adGroup' : 'campaign';
}

const MARKETPLACE_ALIASES: Array<[string, string]> = [
  ['美国', 'US'],
  ['英国', 'UK'],
  ['德国', 'DE'],
  ['法国', 'FR'],
  ['意大利', 'IT'],
  ['西班牙', 'ES'],
  ['荷兰', 'NL'],
  ['瑞典', 'SE'],
  ['波兰', 'PL'],
  ['比利时', 'BE'],
  ['爱尔兰', 'IE'],
  ['奥地利', 'AT'],
  ['日本', 'JP'],
  ['澳大利亚', 'AU'],
  ['加拿大', 'CA'],
  ['墨西哥', 'MX'],
  ['新加坡', 'SG'],
  ['阿联酋', 'AE'],
  ['沙特', 'SA'],
  ['印度', 'IN'],
  ['土耳其', 'TR'],
];

const MARKETPLACE_CODES = [
  'US', 'CA', 'MX', 'UK', 'DE', 'FR', 'IT', 'ES', 'NL', 'SE', 'PL', 'BE', 'IE', 'AT',
  'JP', 'AU', 'SG', 'AE', 'SA', 'IN', 'TR',
];

/** 从文件名、国家/地区列等文本推断站点；无法判断时保留传入的当前站点。 */
export function detectMarketplaceFromText(value: unknown, fallback = 'US'): string {
  const text = String(value ?? '').replace(/\u00a0/g, ' ').trim();
  for (const [alias, code] of MARKETPLACE_ALIASES) {
    if (text.includes(alias)) return code;
  }
  const upper = text.toUpperCase();
  const detected = MARKETPLACE_CODES.find(code => (
    new RegExp(`(?:^|[^A-Z])${code}(?:$|[^A-Z])`, 'i').test(upper)
  ));
  return detected || String(fallback || 'US').trim().toUpperCase() || 'US';
}
