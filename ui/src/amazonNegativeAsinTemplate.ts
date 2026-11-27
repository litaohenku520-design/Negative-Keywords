/**
 * Amazon Sponsored Products 否定 ASIN 商品投放模板转换。
 *
 * ASIN 与否词不是同一种实体：不能写入 Keyword Text/Match Type，
 * 必须使用 Negative Product Targeting（广告组级）或
 * Campaign Negative Product Targeting（广告活动级）+ Product Targeting Expression。
 */

export const AMAZON_NEGATIVE_ASIN_UPLOAD_HEADERS = [
  'Product',
  'Entity',
  'Operation',
  'Campaign ID',
  'Ad Group ID',
  'Product Targeting Expression',
  'Product Targeting Expression Type',
  'State',
] as const;

export type AmazonNegativeAsinUploadRow = Record<
  typeof AMAZON_NEGATIVE_ASIN_UPLOAD_HEADERS[number],
  string
>;

export type AsinDecision = 'deny' | 'keep' | 'review';

export interface NegativeAsinSourceRow {
  asin: string;
  decision?: AsinDecision | string;
  campaignName?: string;
  campaignId?: string;
  adGroupName?: string;
  adGroupId?: string;
  reason?: string;
}

export interface NegativeAsinSkippedRow {
  source: NegativeAsinSourceRow;
  reason: '非否定结果' | 'ASIN格式无效' | '缺少Campaign ID' | '缺少Ad Group ID' | '重复ASIN投放';
}

export interface AmazonNegativeAsinTemplateCheck {
  importedRows: number;
  deniedSourceRows: number;
  exportedRows: number;
  skippedNonDeny: number;
  skippedInvalidAsin: number;
  skippedMissingCampaignId: number;
  skippedMissingAdGroupId: number;
  skippedDuplicate: number;
}

export interface AmazonNegativeAsinTemplateResult {
  rows: AmazonNegativeAsinUploadRow[];
  skippedRows: NegativeAsinSkippedRow[];
  check: AmazonNegativeAsinTemplateCheck;
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\u00a0/g, ' ').trim();
}

/** 识别 Excel 中的 ASIN、ASIN URL、带引号或带空格的 ASIN。 */
export function normalizeAsin(value: unknown): string {
  let text = clean(value).toUpperCase();
  if (!text) return '';

  const urlMatch = text.match(/(?:\/DP\/|\/PRODUCT\/|ASIN[=:]\s*)([A-Z0-9]{10})(?:[^A-Z0-9]|$)/i);
  if (urlMatch) text = urlMatch[1];
  text = text.replace(/[\s'"`]/g, '');
  return /^[A-Z0-9]{10}$/.test(text) ? text : '';
}

/** 将判定结果统一为 deny/keep/review；空值不会被默认当成否定。 */
export function normalizeAsinDecision(value: unknown): AsinDecision {
  const text = clean(value).toLocaleLowerCase();
  if (!text) return 'review';
  // “未否定/无需否定”不能因为包含“否定”二字而误判为 deny。
  if (/不相关|不匹配/.test(text)) return 'deny';
  if (/未否定|无需否定|不否定|保留|通过|保有|keep|retain|留存|相关|^(是|yes|true|1)$/.test(text)) return 'keep';
  if (/^否$|^no$|^false$|^0$|否定|否掉|否词|negative|deny|reject|淘汰|需否/.test(text)) return 'deny';
  return 'review';
}

function normalizeId(value: unknown): string {
  return clean(value).replace(/\.0$/, '');
}

/**
 * 生成可直接上传的有效行；缺少真实 Campaign/Ad Group ID 的记录进入 skippedRows，
 * 由页面另行放入“ASIN 映射核对”文件，不把空 ID 混进 Amazon 上传文件。
 */
export function buildAmazonNegativeAsinTemplateRows(
  sourceRows: NegativeAsinSourceRow[],
  scope: 'campaign' | 'adGroup' = 'campaign',
): AmazonNegativeAsinTemplateResult {
  const check: AmazonNegativeAsinTemplateCheck = {
    importedRows: sourceRows.length,
    deniedSourceRows: 0,
    exportedRows: 0,
    skippedNonDeny: 0,
    skippedInvalidAsin: 0,
    skippedMissingCampaignId: 0,
    skippedMissingAdGroupId: 0,
    skippedDuplicate: 0,
  };
  const rows: AmazonNegativeAsinUploadRow[] = [];
  const skippedRows: NegativeAsinSkippedRow[] = [];
  const seen = new Set<string>();

  for (const source of sourceRows) {
    if (normalizeAsinDecision(source.decision) !== 'deny') {
      check.skippedNonDeny += 1;
      skippedRows.push({ source, reason: '非否定结果' });
      continue;
    }
    check.deniedSourceRows += 1;

    const asin = normalizeAsin(source.asin);
    if (!asin) {
      check.skippedInvalidAsin += 1;
      skippedRows.push({ source, reason: 'ASIN格式无效' });
      continue;
    }

    const campaignId = normalizeId(source.campaignId);
    if (!campaignId) {
      check.skippedMissingCampaignId += 1;
      skippedRows.push({ source: { ...source, asin }, reason: '缺少Campaign ID' });
      continue;
    }

    const adGroupId = normalizeId(source.adGroupId);
    if (scope === 'adGroup' && !adGroupId) {
      check.skippedMissingAdGroupId += 1;
      skippedRows.push({ source: { ...source, asin, campaignId }, reason: '缺少Ad Group ID' });
      continue;
    }

    const dedupeKey = [campaignId, scope === 'adGroup' ? adGroupId : '', asin].join('|');
    if (seen.has(dedupeKey)) {
      check.skippedDuplicate += 1;
      skippedRows.push({ source: { ...source, asin, campaignId, adGroupId }, reason: '重复ASIN投放' });
      continue;
    }
    seen.add(dedupeKey);

    rows.push({
      Product: 'Sponsored Products',
      // Amazon 用实体名称区分作用域。广告活动级必须使用
      // Campaign Negative Product Targeting，否则即使 Ad Group ID 为空，
      // Amazon 也会按广告组级校验并提示缺少 Ad Group ID。
      Entity: scope === 'campaign' ? 'Campaign Negative Product Targeting' : 'Negative Product Targeting',
      Operation: 'Create',
      'Campaign ID': campaignId,
      'Ad Group ID': scope === 'adGroup' ? adGroupId : '',
      'Product Targeting Expression': `asin="${asin}"`,
      'Product Targeting Expression Type': 'Negative Targeting Expression',
      State: 'enabled',
    });
  }

  check.exportedRows = rows.length;
  return { rows, skippedRows, check };
}

