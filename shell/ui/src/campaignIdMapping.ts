/**
 * Campaign ID 映射工具。
 *
 * Campaign ID 必须按文本处理：它是 Amazon 后台的标识符，不应该被
 * Excel/JavaScript 当作数值四舍五入或转换成科学计数法。
 */

export interface CampaignIdMappingRecord {
  /** 用户在报告中看到的活动名称（保留原始显示大小写） */
  campaignName: string;
  /** Amazon 后台 Campaign ID；冲突时为空字符串 */
  campaignId: string;
  /** 当前店铺站点，如 US / DE / UK */
  storeMarketplace: string;
  /** 同名活动对应多个 ID 时为 true，禁止自动回填 */
  ambiguous?: boolean;
  /** 冲突的全部 ID，便于页面解释和人工处理 */
  conflictIds?: string[];
  sourceFile?: string;
  updatedAt?: string;
}

export interface CampaignIdImportSummary {
  records: CampaignIdMappingRecord[];
  importedRows: number;
  skippedRows: number;
  duplicateRows: number;
  conflictRows: number;
}

export function normalizeCampaignName(value: unknown): string {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ');
}

export function normalizeCampaignId(value: unknown): string {
  return String(value ?? '').replace(/\u00a0/g, ' ').trim();
}

function normalizeScope(value: unknown): string {
  return String(value ?? '').replace(/\u00a0/g, ' ').trim().toLocaleLowerCase();
}

function mappingKey(storeMarketplace: string, campaignName: unknown): string {
  return `${String(storeMarketplace || 'US').trim().toLocaleLowerCase()}::${normalizeCampaignName(campaignName)}`;
}

/**
 * 将导入行按「店铺 + 活动名称」聚合。
 * 同一活动出现相同 ID 时去重；同一活动出现多个不同 ID 时生成冲突记录，
 * 导出时不会猜测其中任何一个 ID。
 */
export function buildCampaignIdMappings(
  rows: Array<Record<string, unknown>>,
  campaignNameColumn: string,
  campaignIdColumn: string,
  storeMarketplace: string,
  sourceFile?: string,
): CampaignIdImportSummary {
  const groups = new Map<string, {
    campaignName: string;
    ids: Set<string>;
    sourceFile?: string;
  }>();
  let skippedRows = 0;
  let duplicateRows = 0;

  for (const row of rows) {
    const campaignName = String(row[campaignNameColumn] ?? '').replace(/\u00a0/g, ' ').trim();
    const campaignId = normalizeCampaignId(row[campaignIdColumn]);
    if (!campaignName || !campaignId) {
      skippedRows += 1;
      continue;
    }
    const key = mappingKey(storeMarketplace, campaignName);
    const group = groups.get(key) || { campaignName, ids: new Set<string>(), sourceFile };
    if (group.ids.has(campaignId)) duplicateRows += 1;
    group.ids.add(campaignId);
    // 保留第一次出现的可读活动名称，避免仅大小写差异造成多条记录。
    groups.set(key, group);
  }

  const now = new Date().toISOString();
  const records = Array.from(groups.values()).map(group => {
    const ids = Array.from(group.ids);
    const ambiguous = ids.length > 1;
    return {
      campaignName: group.campaignName,
      campaignId: ambiguous ? '' : ids[0],
      storeMarketplace: String(storeMarketplace || 'US').trim().toUpperCase(),
      ...(ambiguous ? { ambiguous: true, conflictIds: ids } : {}),
      ...(sourceFile ? { sourceFile } : {}),
      updatedAt: now,
    } satisfies CampaignIdMappingRecord;
  });

  return {
    records,
    importedRows: records.length,
    skippedRows,
    duplicateRows,
    conflictRows: records.filter(record => record.ambiguous).length,
  };
}

/**
 * 仅替换当前导入文件涉及的活动，保留其它店铺、其它活动的映射。
 */
export function mergeCampaignIdMappings(
  existing: CampaignIdMappingRecord[],
  incoming: CampaignIdMappingRecord[],
): CampaignIdMappingRecord[] {
  const touched = new Set(incoming.map(record => mappingKey(record.storeMarketplace, record.campaignName)));
  return [
    ...existing.filter(record => !touched.has(mappingKey(record.storeMarketplace, record.campaignName))),
    ...incoming,
  ].sort((a, b) => {
    const storeCompare = String(a.storeMarketplace).localeCompare(String(b.storeMarketplace));
    return storeCompare || String(a.campaignName).localeCompare(String(b.campaignName));
  });
}

function resolveCandidates(
  candidates: CampaignIdMappingRecord[],
): { campaignId: string; ambiguous: boolean } {
  if (candidates.some(record => record.ambiguous || (record.conflictIds || []).length > 1)) {
    return { campaignId: '', ambiguous: true };
  }
  const ids = Array.from(new Set(candidates
    .map(record => normalizeCampaignId(record.campaignId))
    .filter(Boolean)));
  return ids.length === 1
    ? { campaignId: ids[0], ambiguous: false }
    : { campaignId: '', ambiguous: ids.length > 1 };
}

/**
 * 只按「店铺/站点作用域 + 活动名称」精确匹配。
 *
 * 不能再使用“全局同名且唯一”兜底：欧洲各站、甚至同一站点的不同店铺
 * 都可能有完全相同的广告组合名称。没有选中作用域的映射时必须留空，
 * 由导出页提示用户选择正确站点，不能把其它站点的 ID 猜进去。
 */
export function resolveCampaignId(
  mappings: CampaignIdMappingRecord[],
  campaignName: unknown,
  storeMarketplace: string,
  scopeAliases: unknown[] = [],
): { campaignId: string; ambiguous: boolean } {
  const store = String(storeMarketplace || 'US').trim().toUpperCase();
  const normalizedName = normalizeCampaignName(campaignName);
  if (!normalizedName) return { campaignId: '', ambiguous: false };

  // 先查完整的“店铺::站点”作用域。这样新导入的 UK 映射不会被旧版本
  // 同一店铺下的 DE/FR 记录干扰。
  const orderedScopes = [store, ...scopeAliases.map(scope => String(scope ?? '').trim().toUpperCase())]
    .filter(Boolean)
    .filter((scope, index, all) => all.indexOf(scope) === index);
  for (const scope of orderedScopes) {
    const candidates = mappings.filter(record =>
      String(record.storeMarketplace || '').trim().toUpperCase() === scope
      && normalizeCampaignName(record.campaignName) === normalizedName,
    );
    if (candidates.length === 0) continue;
    const resolution = resolveCandidates(candidates);
    if (resolution.campaignId || resolution.ambiguous) return resolution;
  }

  return { campaignId: '', ambiguous: false };
}
