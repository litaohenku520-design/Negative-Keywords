/**
 * Amazon Sponsored Products 否词 bulksheet 的纯数据转换逻辑。
 *
 * 输入可以是完整搜索词报告，也可以是最小两列模板：
 *   客户搜索词 | 广告活动名称
 *
 * 输出严格采用当前 Amazon Sponsored Products 后台模板的字段结构：
 * Product、Entity、Operation、Campaign ID、Ad Group ID、Keyword ID、
 * Keyword Text、Match Type、State。
 *
 * 这里故意不猜 Campaign ID：Amazon 的 bulksheet 要求使用后台真实 ID，
 * 仅凭活动名称无法安全生成 ID。若来源文件带有活动 ID，会自动带入；
 * 否则保留为空，并由校验结果明确提示用户补齐，而不是写入虚假 ID。
 */

/**
 * Amazon 否词匹配方式：
 * - auto: 从搜索词中提取明确的机型短语；提取不到时安全回退整句 Exact
 * - exact / phrase: 保留用户手动指定整句匹配的兼容模式
 */
export type AmazonNegativeMatchMode = 'auto' | 'exact' | 'phrase';
export type AmazonNegativeScope = 'campaign' | 'adGroup';

/**
 * 否词导出时用于二次核对的机型拓词组。
 * 这里使用一个独立的轻量类型，避免把页面/后端的完整配置耦合进纯导出逻辑。
 */
export interface NegativeModelGroup {
  name: string;
  keywords?: string[];
  enabled?: boolean;
}

export interface NegativeKeywordContext {
  /** 当前搜索词所属广告活动对应的目标机型组名称。 */
  modelGroupName?: string;
  /**
   * 兼容历史映射可能残留基础机型组的情况，同时使用活动名/机型名重新核对。
   * 例如映射仍是 Samsung Galaxy S21，但活动名是 S21Plus-PU-CK-自动时，
   * 必须优先识别为 Samsung Galaxy S21+。
   */
  modelGroupHints?: string[];
  /** 当前后端保存的机型组拓词。 */
  modelGroups?: NegativeModelGroup[];
  /** 分类结果的否词原因；仅 style 壳类词命中会触发整句 Exact 回退。 */
  reason?: string;
}

export const AMAZON_NEGATIVE_UPLOAD_HEADERS = [
  'Product',
  'Entity',
  'Operation',
  'Campaign ID',
  'Ad Group ID',
  'Keyword ID',
  'Keyword Text',
  'Match Type',
  'State',
] as const;

export interface NegativeSourceRow {
  key?: string;
  index?: number;
  searchTerm: string;
  campaign: string;
  campaignIdMatchName?: string;
  campaignId?: string;
  adGroup?: string;
  /** 广告组级模板优先使用真实 Ad Group ID；旧数据仍可用 adGroup 兼容。 */
  adGroupId?: string;
  /** Campaign 映射得到的目标机型组，用于自动否词的二次拓词核对。 */
  modelGroupName?: string;
  /** 旧映射、机型列、活动名等可用于二次核对的候选提示。 */
  modelGroupHints?: string[];
  /** 分类规则返回的否词原因，仅用于导出核对页，不写入 Amazon 官方上传表。 */
  reason?: string;
  tag: 'deny' | 'keep' | 'review';
}

export type AmazonNegativeUploadRow = Record<typeof AMAZON_NEGATIVE_UPLOAD_HEADERS[number], string>;

export interface AmazonNegativeTemplateCheck {
  deniedSourceRows: number;
  exportedRows: number;
  skippedMissingTerm: number;
  skippedMissingCampaign: number;
  skippedMissingAdGroup: number;
  skippedDuplicate: number;
  missingCampaignId: number;
  campaignLevelRows: number;
  adGroupLevelRows: number;
}

export interface AmazonNegativeTemplateResult {
  rows: AmazonNegativeUploadRow[];
  check: AmazonNegativeTemplateCheck;
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\u00a0/g, ' ').trim();
}

function keyPart(value: string): string {
  return clean(value).toLocaleLowerCase().replace(/\s+/g, ' ');
}

function entityLabel(scope: AmazonNegativeScope): string {
  return scope === 'adGroup' ? 'Negative Keyword' : 'Campaign Negative Keyword';
}

function matchLabel(mode: AmazonNegativeMatchMode): 'negativeExact' | 'negativePhrase' {
  return mode === 'phrase' ? 'negativePhrase' : 'negativeExact';
}

function normalizeModelText(value: unknown): string {
  return clean(value)
    .toLocaleLowerCase()
    .replace(/[‐‑‒–—−_/.\\]+/g, ' ')
    // 保留 +：Samsung Galaxy S21 与 Samsung Galaxy S21+ 是两个不同机型组。
    .replace(/[^\p{L}\p{N}+]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactModelText(value: unknown): string {
  return normalizeModelText(value).replace(/\s+/g, '');
}

/** 从活动名/机型组名中提取 A42、A04E、S24 等稳定机型代码。 */
function extractModelCode(value: unknown): string {
  const text = clean(value).toLocaleLowerCase();
  const match = text.match(/(?:^|[^a-z0-9])([asmfnz])\s*[-/]?\s*(\d{1,3})(?:\s*(ultra|active|lite|mini|plus|edge|pro|max|fe|5g|4g|e|s))?(?=$|[^a-z0-9])/i);
  if (!match) return '';

  // S21Plus、S21 plus、S21+ 都归一为 s21+，不能与基础 S21 混为一组。
  let suffix = String(match[3] || '').toLocaleLowerCase();
  if (suffix === 'plus') suffix = '+';
  if (!suffix) {
    const afterMatch = text.slice((match.index || 0) + match[0].length);
    if (/^\s*\+/.test(afterMatch)) suffix = '+';
  }
  return `${match[1]}${match[2]}${suffix}`.toLocaleLowerCase();
}

/**
 * 提取“同系列”比较用的稳定键。
 *
 * 词组否定会屏蔽一个搜索词中包含该片段的更长搜索词，因此不能把同一
 * 代际/系列的机型误当成完全无关的机型来做 phrase negative。例如：
 *   - iPhone Air 活动 + "case for iphone 17"
 *   - Galaxy S21+ 活动 + "galaxy s21 plus ..."
 *
 * 这里故意只提取“品牌/系列 + 代际或型号主编号”，不把 Pro、Plus、Air、
 * 4G/5G 等变体当成不同系列。这样同系列词会安全回退为整句 Exact，仍然
 * 可以否定这条具体搜索词，但不会扩大到同系列的其它搜索词。
 */
function extractModelSeriesKey(value: unknown): string {
  const text = normalizeModelText(value);
  if (!text) return '';

  // iPhone E 系列（如 iPhone 16e/17e）与同代基础机型属于不同机型，
  // 搜索到 E 变体时允许生成该变体的词组否词，不要被“同代保护”降为整句精准词。
  const iphoneEVariant = text.match(/(?:^|\s)(?:iphone|ip)\s*(\d{1,2})\s*e\b/i);
  if (iphoneEVariant) return `iphone-${iphoneEVariant[1]}e`;

  // 活动名常写成 IP17Air，而机型组名通常写成 iPhone Air。
  // iPhone Air 是当前 iPhone 17 代的 Air 变体，统一到 iphone-17 系列。
  const iphoneGeneration = text.match(/(?:^|\s)(?:iphone|ip)\s*(\d{1,2})/i);
  if (iphoneGeneration) return `iphone-${iphoneGeneration[1]}`;
  if (/\biphone\s+air\b/i.test(text)) return 'iphone-17';

  const pixelGeneration = text.match(/\bpixel\s*(\d{1,2})/i);
  if (pixelGeneration) return `pixel-${pixelGeneration[1]}`;

  const noteGeneration = text.match(/\bnote\s*(\d{1,2})/i);
  if (noteGeneration) return `note-${noteGeneration[1]}`;

  // Z Fold/Flip 活动名把 Z 与代际分开写（如 “Z Fold 8 Ultra”），
  // 搜索词提取却会得到 “z8”；归一到同一代，避免对目标机型生成 z8 词组否定。
  const galaxyZGeneration = text.match(/(?:^|\s)z\s*(?:fold|flip)\s*(\d{1,2})/i);
  if (galaxyZGeneration) return `z-${galaxyZGeneration[1]}`;

  // Samsung 等活动名/搜索词常用 A42、S21+、s 21 plus 等写法。
  const modelCode = text.match(/(?:^|\s)([asmfnz])\s*(\d{1,3})/i);
  if (modelCode) return `${modelCode[1].toLocaleLowerCase()}-${modelCode[2]}`;

  // Moto 年款需要同时保留产品线变体：基础 Moto G 与 Moto G Stylus
  // 不是可互换机型。否则 Moto/G/2026 活动会把 “Moto G Stylus 2026”
  // 当成同系列词，错误地退回整句精准否定。
  const motoYear = text.match(/\bmoto(?:rola)?\b.*?\b(20\d{2})\b/i);
  if (motoYear) {
    const beforeYear = text.slice(0, (motoYear.index || 0) + motoYear[0].lastIndexOf(motoYear[1]));
    const motoG = beforeYear.match(/\bmoto(?:rola)?\s+g\b/i);
    if (motoG) {
      const familyTail = beforeYear.slice((motoG.index || 0) + motoG[0].length);
      const variant = familyTail.match(/^\s+(stylus|power|play|pure|fusion|ace|5g|4g)\b/i)?.[1]
        ?.toLocaleLowerCase();
      return `moto-g${variant ? `-${variant}` : ''}-${motoYear[1]}`;
    }
    return `moto-${motoYear[1]}`;
  }

  return '';
}

function matchesModelSeries(phrase: string, hints: string | string[]): boolean {
  const phraseSeries = extractModelSeriesKey(phrase);
  if (!phraseSeries) return false;

  const values = Array.isArray(hints) ? hints : [hints];
  return values.some(value => extractModelSeriesKey(value) === phraseSeries);
}

/**
 * 找到“当前活动对应”的机型组。
 * 优先使用分类结果返回的完整组名；历史数据没有组名时，再用活动/机型中的
 * A42、A04E、S24 等代码匹配组名。没有确认到对应组时不做降级，避免误把
 * 自动词组否定改成精准否定。
 */
function findCorrespondingModelGroup(
  hints: string | string[],
  modelGroups: NegativeModelGroup[] = [],
): NegativeModelGroup | undefined {
  const groups = modelGroups.filter(group => group && group.enabled !== false && clean(group.name));
  if (!groups.length) return undefined;

  const normalizedHints = (Array.isArray(hints) ? hints : [hints])
    .map(clean)
    .filter(Boolean)
    .map(value => ({
      value,
      normalized: normalizeModelText(value),
      code: extractModelCode(value),
    }));
  if (!normalizedHints.length) return undefined;

  // 先按机型代码匹配，并优先选择更具体的代码。这样即使旧映射把
  // S21Plus 活动错误保留成基础 S21 组，活动名中的 s21+ 仍会覆盖旧映射。
  const codeMatches = groups.flatMap((group, groupIndex) => {
    const groupCode = extractModelCode(group.name);
    if (!groupCode) return [];
    const matchedHint = normalizedHints.find(hint => hint.code === groupCode);
    return matchedHint
      ? [{ group, groupIndex, groupCode, exactName: matchedHint.normalized === normalizeModelText(group.name) }]
      : [];
  });
  if (codeMatches.length) {
    codeMatches.sort((left, right) => {
      const specificity = right.groupCode.length - left.groupCode.length;
      if (specificity !== 0) return specificity;
      if (left.exactName !== right.exactName) return left.exactName ? -1 : 1;
      return left.groupIndex - right.groupIndex;
    });
    return codeMatches[0].group;
  }

  const exact = groups.find(group => normalizedHints.some(
    hint => hint.normalized && normalizeModelText(group.name) === hint.normalized,
  ));
  if (exact) return exact;

  // 没有标准机型代码的旧组名，最后只接受完整 token 的包含关系。
  // 不使用短子串（例如 A4 不能命中 A42）。
  const byToken = groups.find(group => {
    const groupTokens = new Set(normalizeModelText(group.name).split(' '));
    return normalizedHints.some(hint => {
      const hintTokens = hint.normalized.split(' ').filter(token => token.length >= 3);
      return hintTokens.some(token => groupTokens.has(token));
    });
  });
  if (byToken) return byToken;

  return undefined;
}

/** 判断候选机型词是否出现在该机型组的拓词/组名中。 */
function matchesModelExpansion(phrase: string, group: NegativeModelGroup): boolean {
  const normalizedPhrase = normalizeModelText(phrase);
  if (!normalizedPhrase) return false;
  const phraseCompact = compactModelText(phrase);
  const candidates = [group.name, ...(Array.isArray(group.keywords) ? group.keywords : [])];

  return candidates.some(candidate => {
    const normalizedCandidate = normalizeModelText(candidate);
    if (!normalizedCandidate) return false;
    if (normalizedCandidate === normalizedPhrase) return true;

    // 词组边界匹配：避免 “a04e” 只因命中另一个普通单词的子串而误判。
    const paddedCandidate = ` ${normalizedCandidate} `;
    if (paddedCandidate.includes(` ${normalizedPhrase} `)) return true;

    // 兼容报告/拓词把型号拆开写成 “a 04e” 或 “a-04-e”。
    // 只有含数字的机型候选允许紧凑匹配，避免 pro/product 这类普通词误命中。
    return /\d/.test(normalizedPhrase)
      && phraseCompact.length >= 3
      && compactModelText(candidate).includes(phraseCompact);
  });
}

/**
 * 从搜索词中识别可以单独作为词组否定的机型片段。
 *
 * 重点处理手机壳广告里最常见的写法：
 *   - "samsung galaxy a 04e" → "a04e"
 *   - "handyhülle samsung galaxy s 24 ultra" → "s24 ultra"
 *   - "iphone 15 pro max case" → "iphone 15 pro max"
 *
 * 这里不把 case/cover/hülle 等品类词当成否定词，也不对纯数字做猜测。
 * 返回空字符串表示无法安全识别，调用方应回退为整句 Exact。
 */
export function extractNegativePhraseTerm(searchTerm: string): string {
  let text = clean(searchTerm);
  if (!text) return '';

  // 有些报告会把网络制式紧贴在型号后面（a335g/a334g）。先拆开，
  // 让后面的统一规则把 5G/4G 作为网络代际过滤掉，而不是误认为型号编号的一部分。
  text = text.replace(/\b([asmfnz])\s*(\d{1,3})(5g|4g)\b/giu, '$1$2 $3');

  // 先匹配 Samsung 等常见的“字母 + 数字”机型代码，允许报告把代码拆成多段。
  const patterns: RegExp[] = [
    // 数字后的字母不能再使用“任意 1-3 个字母”：
    //   s22wallet → s22（wallet 是品类词）
    //   s23ultra → s23ultra（ultra 是真实机型变体）
    // 只允许已知的机型后缀，避免旧规则把 wallet 截成 wal、把 ultra 截成 ult。
    // 只限制单独的 s 后缀：a35 samsung 不能把 samsung 的首字母 s 粘成 a35s，
    // 但 s22wallet 仍应在未知品类词前截取为 s22。
    // 5G/4G 虽然允许在匹配阶段通过，但稍后会从结果中剥离，不作为机型词组。
    // fold/flip 是手机壳功能或品类词，不能附着到前面的机型代码上：
    //   samsung galaxy a04s flip case → a04s
    // “e”后缀必须是独立尾缀；不能把下一单词 echtleder 的首字母并到型号里。
    /\b(?:a|s|m|f|n|z)\s*[-/]?\s*\d{1,3}(?:\s*(?:ultra|active|lite|mini|plus|edge|pro|max|fe|5g|4g|e(?![a-z])|s(?![a-z])))?(?:\s+(?:plus|ultra|pro|max|fe|edge|active|lite|mini))?/giu,
    /\biphone\s*\d{1,2}(?:\s*(?:pro\s*max|pro|max|plus|mini|se|e|air))?\b/giu,
    /\bpixel\s*\d{1,2}(?:\s*(?:pro|xl|a))?\b/giu,
    /\b(?:galaxy\s+)?note\s*\d{1,2}(?:\s*(?:pro|plus|ultra))?\b/giu,
    /\b(?:z\s*)?(?:fold|flip)\s*\d{1,2}\b/giu,
    /\b(?:moto(?:rola)?|oneplus|revvl|lg)\s+[a-z]?\s*\d{1,4}[a-z]?\b/giu,
  ];

  const candidates: Array<{ value: string; index: number }> = [];

  // Moto G Stylus 年份机型必须作为完整短语参与 phrase negative：
  // “moto g stylus 2025 wallet case” → “moto g stylus 2025”。
  // 不能只截取 “stylus” 或年份，也不能回退为整条搜索词 exact。
  const motoGStylusPattern = /\bmoto(?:rola)?[\s/-]+g[\s/-]+stylus[\s-]*(20\d{2})\b/giu;
  let motoGStylusMatch: RegExpExecArray | null;
  while ((motoGStylusMatch = motoGStylusPattern.exec(text)) !== null) {
    const value = clean(motoGStylusMatch[0])
      .toLocaleLowerCase()
      .replace(/[‐‑‒–—−]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
    candidates.push({ value, index: motoGStylusMatch.index });
  }

  // 有些搜索词会省略 Samsung S 系列型号前缀，写成“Galaxy 23 FE”。
  // 仅在明确的 Galaxy + 两位数字 + FE 语境下提取数字型号，避免把普通数字
  //（例如尺寸、年份）单独猜成机型；输出为搜索词实际包含的片段“23fe”。
  const abbreviatedGalaxyFePattern = /\b(?:samsung\s+)?galaxy\s+(\d{2})\s*(fe)\b/giu;
  let abbreviatedGalaxyFeMatch: RegExpExecArray | null;
  while ((abbreviatedGalaxyFeMatch = abbreviatedGalaxyFePattern.exec(text)) !== null) {
    const modelNumber = abbreviatedGalaxyFeMatch[1];
    const modelIndex = abbreviatedGalaxyFeMatch.index
      + abbreviatedGalaxyFeMatch[0].toLocaleLowerCase().lastIndexOf(modelNumber.toLocaleLowerCase());
    candidates.push({ value: `${modelNumber}fe`.toLocaleLowerCase(), index: modelIndex });
  }

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const value = clean(match[0])
        .toLocaleLowerCase()
        .replace(/[‐‑‒–—−]/g, '-')
        .replace(/[^\p{L}\p{N}+]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!value || !/\d/.test(value)) continue;

      // A04E / A 04E / A 04 E 都输出 Amazon 可以按词组匹配的稳定写法 a04e。
      // 只压缩代码本身的空格：a 04 e → a04e；不要把 s24 ultra
      // 压成 s24ultra，否则 Amazon 的词组边界会发生变化。
      const attachedCode = value.match(/^([asmfnz])\s*(\d{1,3})([a-z]{1,3})(?=\s|$)/i);
      const splitCode = value.match(/^([asmfnz])\s*(\d{1,3})\s+([a-z]{1,3})(?=\s|$)/i);
      const codePrefix = attachedCode || (splitCode && splitCode[3].length <= 3 ? splitCode : null);
      let normalized = codePrefix
        ? `${codePrefix[1]}${codePrefix[2]}${codePrefix[3]}${value.slice(codePrefix[0].length)}`.replace(/\s+/g, ' ').trim()
        : value;
      // 网络代际不是要加入否定的机型词：a55 5g → a55，a335g → a33。
      normalized = normalized
        .replace(/^([asmfnz]\s*\d{1,3})\s*(?:5g|4g)$/i, '$1')
        .replace(/\s+/g, ' ')
        .trim();
      candidates.push({ value: normalized, index: match.index });
    }
  }

  if (candidates.length === 0) return '';

  // 优先短而明确的机型代码（a04e/s24），再优先更长的完整型号。
  // 同一文本出现多个型号时取最先出现的候选，避免把后面的配件数字当机型。
  const unique = Array.from(new Map(candidates.map(candidate => [candidate.value, candidate])).values());
  unique.sort((left, right) => {
    const leftIsCode = /^[asmfnz]\d{1,3}[a-z]{0,3}(?:\s|$)/i.test(left.value);
    const rightIsCode = /^[asmfnz]\d{1,3}[a-z]{0,3}(?:\s|$)/i.test(right.value);
    if (leftIsCode !== rightIsCode) return leftIsCode ? -1 : 1;
    if (left.value.length !== right.value.length) return right.value.length - left.value.length;
    return left.index - right.index;
  });
  return unique[0]?.value || '';
}

export interface ResolvedNegativeKeyword {
  keywordText: string;
  matchType: 'negativeExact' | 'negativePhrase';
  autoDetected: boolean;
  /** 自动识别的机型片段命中对应机型拓词，因此降级为整句精准否定。 */
  matchedModelExpansion?: boolean;
  /** 搜索词与当前活动属于同一代际/系列，因此禁止扩大为词组否定。 */
  matchedModelSeries?: boolean;
  /** 命中指定词、Moto 型号词组或 style-only 规则时，自动模式保留整句精准否定。 */
  blockedByExplicitFallback?: boolean;
}

/** 用户明确列出的搜索词保持整句 Exact；其他未匹配机型可按明确机型片段做词组否定。 */
const AUTO_PHRASE_EXACT_FALLBACK_TERMS = new Set([
  'flip case for a 16 iphone',
  '6.6" motorola moto g 2023 cover',
  'phone case with card holder moto g 2023',
  'moto 5g 2024 case red',
  'motorola moto g 5g 2024 case red',
  'moto g 2025 leather case',
  'motorola 2022 g stylus case',
  'moto 5g 2024 case',
  'moto g 2024 phone case',
  'wallet style phone case for motorola g 26',
  'case moto g 2026 rust color',
  'moto g 2025 flip case',
  'moto g2025 phone case',
  'leather case for moto g 2026',
  'moto g 2025 phone case bling',
  'motorola 5 g 2025 phone case',
  'motorola g 2026 case bookshelf',
  'n20 case',
  'cell phone cases for t-mobile revvl 5',
  'revvl 5g book case',
  'case for revvl 5g phone',
  'samsung s1 5g wallet 6.7',
  'samsung flip z 8 case',
  'galaxy s8 phone case',
].map(keyPart));

function isExplicitExactFallbackTerm(searchTerm: string): boolean {
  return AUTO_PHRASE_EXACT_FALLBACK_TERMS.has(keyPart(searchTerm));
}

/** 仅 style 壳类词的命中仍不能作为机型词组否定。 */
function hasStyleOnlyNegativeReason(reason: unknown): boolean {
  const value = clean(reason);
  return /含机型否词库词\s*\[\s*style\s*\]/i.test(value);
}

/** Moto/Motorola 的机型短语可能覆盖多个年款；自动模式只否定完整搜索词。 */
function isMotoModelPhrase(phrase: string): boolean {
  return /^(?:moto|motorola)\b/i.test(normalizeModelText(phrase));
}

/** 依据当前导出模式决定写入 Amazon Keyword Text / Match Type 的值。 */
export function resolveNegativeKeyword(
  searchTerm: string,
  mode: AmazonNegativeMatchMode,
  context: NegativeKeywordContext = {},
): ResolvedNegativeKeyword {
  const term = clean(searchTerm);
  if (mode === 'auto') {
    const phrase = extractNegativePhraseTerm(term);
    if (phrase) {
      if (isExplicitExactFallbackTerm(term)
        || isMotoModelPhrase(phrase)
        || hasStyleOnlyNegativeReason(context.reason)) {
        return {
          keywordText: term,
          matchType: 'negativeExact',
          autoDetected: true,
          blockedByExplicitFallback: true,
        };
      }
      const targetGroup = findCorrespondingModelGroup(
        context.modelGroupHints?.length
          ? context.modelGroupHints
          : clean(context.modelGroupName),
        context.modelGroups || [],
      );
      if (targetGroup && matchesModelExpansion(phrase, targetGroup)) {
        return {
          keywordText: term,
          matchType: 'negativeExact',
          autoDetected: true,
          matchedModelExpansion: true,
        };
      }
      // 同系列机型不能扩大成 phrase negative：例如 iPhone Air 活动中的
      // "case for iphone 17"，以及 S21+ 活动中的 "s21 plus ..."。这些词
      // 仍按整句 Exact 否定，避免误伤同系列其它搜索词。
      if (matchesModelSeries(phrase, context.modelGroupHints?.length
        ? context.modelGroupHints
        : clean(context.modelGroupName))) {
        return {
          keywordText: term,
          matchType: 'negativeExact',
          autoDetected: true,
          matchedModelSeries: true,
        };
      }
      return { keywordText: phrase, matchType: 'negativePhrase', autoDetected: true };
    }
  }
  return {
    keywordText: term,
    matchType: matchLabel(mode),
    autoDetected: false,
  };
}

/**
 * 将分类后的“否掉”记录转换为 Amazon 官方 SP 否词上传行。
 * 只输出 tag=deny，且按「搜索词 + 广告活动 + 广告组 + 匹配类型」去重，
 * 防止同一批报告重复导入后生成重复否词。
 */
export function buildAmazonNegativeTemplateRows(
  sourceRows: NegativeSourceRow[],
  mode: AmazonNegativeMatchMode = 'exact',
  scope: AmazonNegativeScope = 'campaign',
  modelGroups: NegativeModelGroup[] = [],
): AmazonNegativeTemplateResult {
  const check: AmazonNegativeTemplateCheck = {
    deniedSourceRows: 0,
    exportedRows: 0,
    skippedMissingTerm: 0,
    skippedMissingCampaign: 0,
    skippedMissingAdGroup: 0,
    skippedDuplicate: 0,
    missingCampaignId: 0,
    campaignLevelRows: 0,
    adGroupLevelRows: 0,
  };
  const rows: AmazonNegativeUploadRow[] = [];
  const seen = new Set<string>();

  for (const source of sourceRows) {
    if (source.tag !== 'deny') continue;
    check.deniedSourceRows += 1;

    const searchTerm = clean(source.searchTerm);
    // 最新赛狐报告的页面展示列可能是机型（第11列），
    // 导出校验/去重必须使用实际活动名称列来识别活动。
    const campaign = clean(source.campaignIdMatchName || source.campaign);
    const campaignId = clean(source.campaignId);
    const adGroupId = clean(source.adGroupId || source.adGroup);
    if (!searchTerm) {
      check.skippedMissingTerm += 1;
      continue;
    }
    if (!campaign) {
      check.skippedMissingCampaign += 1;
      continue;
    }

    if (scope === 'adGroup' && !adGroupId) {
      check.skippedMissingAdGroup += 1;
      continue;
    }

    const outputAdGroupId = scope === 'adGroup' ? adGroupId : '';
    const resolvedKeyword = resolveNegativeKeyword(searchTerm, mode, {
      modelGroupName: clean(source.modelGroupName || source.campaign),
      modelGroupHints: [source.modelGroupName, source.campaign].filter(Boolean),
      modelGroups,
      reason: source.reason,
    });
    const dedupeKey = [source.campaignIdMatchName || campaign, campaign, campaignId, outputAdGroupId, resolvedKeyword.keywordText, resolvedKeyword.matchType]
      .map(keyPart)
      .join('|');
    if (seen.has(dedupeKey)) {
      check.skippedDuplicate += 1;
      continue;
    }
    seen.add(dedupeKey);

    if (!campaignId) check.missingCampaignId += 1;
    if (scope === 'adGroup') check.adGroupLevelRows += 1;
    else check.campaignLevelRows += 1;

    rows.push({
      Product: 'Sponsored Products',
      Entity: entityLabel(scope),
      Operation: 'Create',
      'Campaign ID': campaignId,
      'Ad Group ID': outputAdGroupId,
      'Keyword ID': '',
      'Keyword Text': resolvedKeyword.keywordText,
      'Match Type': resolvedKeyword.matchType,
      State: 'enabled',
    });
  }

  check.exportedRows = rows.length;
  return { rows, check };
}
