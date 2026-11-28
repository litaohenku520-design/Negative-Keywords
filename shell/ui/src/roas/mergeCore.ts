// 纯函数合并核心：不依赖 React / FileReader / xlsx 读取，仅对「已解析的二维数组」做匹配与合并。
// 这样可在 Node 下用 node --test 直接单测（回归防护：精确匹配、大小写/空格归一、未匹配兜底、多追加列）。

export type MatchMode = 'all';

export interface AppendColConfig {
  colIdx: number; // 0-based 列索引（在非主报告中）
  label?: string; // 自定义列头标签（如 "花费"、"点击"）
  displayFormat?: 'value' | 'percent'; // 显示格式：数值 或 百分比（值×100 + %）
  color?: string; // 自定义列颜色（十六进制 #RRGGBB）
}

export interface MergeInput {
  main: { data: any[][]; dayLabel: string; name: string };
  extras: { data: any[][]; dayLabel: string; name: string }[];
  keyCols: number[];
  matchMode?: MatchMode;
  minMatchN?: number;
  requiredCols: boolean[];
  appendCols: AppendColConfig[];
}

export interface MergeResult {
  resultRows: any[][];
  matchedCounts: number[]; // 每个非主报告的匹配行数
  extraHeaders: string[]; // 追加列的新表头（顺序与 resultRows 追加区一致）
  logs: string[]; // 供 UI 展示的执行日志
}

const MAX_MERGE_ROWS = 1_048_576;
const MAX_MERGE_COLS = 16_384;

/**
 * 对上传的工作表做运行时校验。
 *
 * Excel 解析结果来自 Worker，TypeScript 的 any[][] 类型并不能保证运行时
 * 一定有表头、数据行或二维数组结构。品牌推广报告通常体积更大，空表/损坏
 * 表在切换推广类型后才进入分组判定，旧代码会在 header.findIndex 或 row.slice
 * 处抛异常，最终表现为 ERP 页面闪退。这里统一转换成可读的业务错误。
 */
export function validateReportData(data: unknown, reportName = '报告'): asserts data is any[][] {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`报告「${reportName}」没有可读取的数据，请重新导出后再导入`);
  }
  const header = data[0];
  if (!Array.isArray(header) || header.length === 0) {
    throw new Error(`报告「${reportName}」没有有效表头，请确认导入的是广告报告而不是空模板`);
  }
  if (header.length > MAX_MERGE_COLS) {
    throw new Error(`报告「${reportName}」列数 ${header.length.toLocaleString()} 超过 Excel 上限`);
  }
  if (data.length > MAX_MERGE_ROWS) {
    throw new Error(`报告「${reportName}」行数 ${data.length.toLocaleString()} 超过 Excel 上限`);
  }
  if (header.every((value) => value == null || String(value).trim() === '')) {
    throw new Error(`报告「${reportName}」表头为空，请确认导入的是广告报告`);
  }
  if (data.length < 2) {
    throw new Error(`报告「${reportName}」只有表头没有数据行，请检查报告日期范围或重新导出`);
  }
}

function isValidColumnIndex(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < MAX_MERGE_COLS;
}

/** 0-based index → 列字母 (0=A) */
export function colIndexToLetter(idx: number): string {
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_MERGE_COLS) return '?';
  let result = '';
  let n = idx;
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

/** 构建每行 key（多列拼接），header 行返回占位 __HEADER__ */
export function buildKeys(
  data: any[][],
  keyCols: number[],
  _matchMode: MatchMode = 'all',
  _minMatchN: number = 0,
  requiredCols?: boolean[],
): string[][] {
  if (!Array.isArray(data)) return [];
  return data.map((row, idx) => {
    if (idx === 0) return keyCols.map(() => '__HEADER__');
    const safeRow = Array.isArray(row) ? row : [];
    return keyCols.map((c) => String(safeRow[c] ?? '').trim());
  });
}

/** 构建全量 key 字符串（仅拼接「必须匹配」的列），逐字符精确相等 */
export function buildFullKey(rowKeys: string[], requiredCols?: boolean[]): string {
  const safeKeys = Array.isArray(rowKeys) ? rowKeys : [];
  if (requiredCols && requiredCols.length === safeKeys.length) {
    return safeKeys.filter((_, i) => requiredCols[i] !== false).join('||');
  }
  return safeKeys.join('||');
}

/** 核心合并：把非主报告的 ROAS + 追加列，按 key 精确匹配追加到主报告 */
export function mergeReports(input: MergeInput): MergeResult {
  const { main, matchMode = 'all', minMatchN = 0 } = input;
  const extras = Array.isArray(input.extras) ? input.extras : [];
  const keyCols = Array.isArray(input.keyCols) ? input.keyCols : [];
  const requiredCols = Array.isArray(input.requiredCols) ? input.requiredCols : [];
  const appendCols = Array.isArray(input.appendCols)
    ? input.appendCols.filter((ac) => ac && isValidColumnIndex(ac.colIdx))
    : [];
  const logs: string[] = [];
  validateReportData(main?.data, main?.name || '主报告');
  if (keyCols.length === 0) throw new Error('请至少配置一列匹配列');
  const invalidKeyCol = keyCols.find((c) => !isValidColumnIndex(c));
  if (invalidKeyCol !== undefined) throw new Error(`匹配列 ${String(invalidKeyCol)} 无效，请使用从 0 开始的列号`);
  const mainData = main.data;
  const headerRow = mainData[0];
  if (keyCols.some((c) => c >= headerRow.length)) {
    throw new Error(`主报告「${main.name}」的匹配列超出表头范围（当前 ${headerRow.length} 列）`);
  }

  let roasColIdx = headerRow.findIndex((h: any) => typeof h === 'string' && h.includes('ROAS'));
  if (roasColIdx === -1) {
    roasColIdx = headerRow.findIndex((h: any) => typeof h === 'string' && /roas/i.test(h));
  }
  if (roasColIdx === -1) {
    roasColIdx = 17; // 默认 col R (0-based=17)
    logs.push(`⚠️ 未找到ROAS列，使用默认列 ${roasColIdx}`);
  } else {
    logs.push(`📍 ROAS列位置: col${roasColIdx}(${colIndexToLetter(roasColIdx)}) = "${headerRow[roasColIdx]}"`);
  }

  const mainKeys = buildKeys(mainData, keyCols, matchMode, minMatchN, requiredCols);
  const colDesc = keyCols
    .map((c, i) => {
      const req = requiredCols[i] !== false;
      return `col${c}(${colIndexToLetter(c)}${req ? '' : '?选'})`;
    })
    .join(' / ');
  logs.push(`🔑 匹配列(${keyCols.length}列): ${colDesc}`);
  logs.push(`📋 匹配模式: 精确匹配(全部必须)（逐字符精确相等，一字不差）`);

  const hasAppendCols = appendCols.length > 0;
  if (hasAppendCols) {
    logs.push(`📎 追加列配置: ${appendCols.map((c) => `col${c.colIdx}(${colIndexToLetter(c.colIdx)})${c.label ? `=${c.label}` : ''}`).join(', ')}`);
  } else {
    logs.push(`⚠️ 未配置追加列，合并将只保留主报告数据`);
  }

  const extraMaps: { label: string; fullKeyMap: Record<string, { append: any[] }>; headers?: any[] }[] = [];
  for (const ext of extras) {
    validateReportData(ext?.data, ext?.name || '非主报告');
    if (keyCols.some((c) => c >= ext.data[0].length)) {
      throw new Error(`报告「${ext.name}」的匹配列超出表头范围（当前 ${ext.data[0].length} 列）`);
    }
    logs.push(`📥 加载 ${ext.dayLabel}天报告: ${ext.name}`);
    const extKeys = buildKeys(ext.data, keyCols, matchMode, minMatchN, requiredCols);
    const fullKeyMap: Record<string, { append: any[] }> = {};
    for (let i = 1; i < ext.data.length; i++) {
      if (extKeys[i].includes('__HEADER__')) continue;
      const fullKey = buildFullKey(extKeys[i], requiredCols);
      if (fullKey in fullKeyMap) continue; // 首次匹配优先
      const appendVals = appendCols.map((ac) => {
        const raw = ext.data[i]?.[ac.colIdx] ?? null;
        if (raw === null || raw === undefined || raw === '') return null;
        const num = Number(raw);
        if (ac.displayFormat === 'percent') {
          if (!isNaN(num)) return `${(num * 100).toFixed(2)}%`;
        } else {
          if (!isNaN(num)) return Math.round(num * 100) / 100;
        }
        return raw;
      });
      if (hasAppendCols && appendVals.some((v) => v !== null && v !== undefined && v !== '')) {
        fullKeyMap[fullKey] = { append: appendVals };
      }
    }
    extraMaps.push({ label: ext.dayLabel, fullKeyMap, headers: ext.data[0] });
    logs.push(`  ✅ ${ext.dayLabel}天 key数: ${Object.keys(fullKeyMap).length}`);
  }

  logs.push(`\n🔗 开始合并...`);
  const matchedCounts = extraMaps.map(() => 0);
  const resultRows: any[][] = [];

  const usedLabels = new Map<string, number>();
  const dedupeLabel = (base: string) => {
    const count = usedLabels.get(base) ?? 0;
    usedLabels.set(base, count + 1);
    return count === 0 ? base : `${base}(${count + 1})`;
  };

  const extraHeaders: string[] = [];
  for (const e of extraMaps) {
    for (const ac of appendCols) {
      const srcHeader = e.headers?.[ac.colIdx];
      const colHeader =
        ac.label || (srcHeader != null && srcHeader !== '' ? String(srcHeader) : `col${ac.colIdx}(${colIndexToLetter(ac.colIdx)})`);
      extraHeaders.push(dedupeLabel(`(${e.label}天)${colHeader}`));
    }
  }

  // 主报告 ROAS 列若已带 "(N天)" 前缀（即「合并导出文件再次合并」场景），不再二次包装，
  // 避免出现 "(7天)(7天)ROAS" 这类双前缀脏列头。
  const rawRoasHeader = headerRow[roasColIdx];
  const roasAlreadyPrefixed = typeof rawRoasHeader === 'string' && /^\(\d+天\)/.test(rawRoasHeader);
  const mainRoasLabel = roasAlreadyPrefixed
    ? String(rawRoasHeader)
    : `(${main.dayLabel}天)${rawRoasHeader || 'ROAS'}`;
  const newHeader = [
    ...headerRow.slice(0, roasColIdx),
    mainRoasLabel,
    ...extraHeaders,
    ...headerRow.slice(roasColIdx + 1),
  ];
  resultRows.push(newHeader);

  for (let i = 1; i < mainData.length; i++) {
    const mainRowKeys = mainKeys[i];
    if (mainRowKeys.includes('__HEADER__')) continue;

    const fullKey = buildFullKey(mainRowKeys, requiredCols);
    const extraValues: any[] = [];
    for (let ei = 0; ei < extraMaps.length; ei++) {
      const entry = extraMaps[ei].fullKeyMap[fullKey];
      if (entry) {
        matchedCounts[ei]++;
        extraValues.push(...entry.append);
      } else {
        extraValues.push(...appendCols.map(() => '')); // 未匹配 → 追加列空
      }
    }

    const mainRow = Array.isArray(mainData[i]) ? mainData[i] : [];
    const newRow = [
      ...mainRow.slice(0, roasColIdx + 1),
      ...extraValues,
      ...mainRow.slice(roasColIdx + 1),
    ];
    resultRows.push(newRow);
  }

  for (let ei = 0; ei < extraMaps.length; ei++) {
    logs.push(`  ✅ ${extraMaps[ei].label}天追加列匹配: ${matchedCounts[ei]}/${mainData.length - 1}`);
  }
  logs.push(`\n✅ 合并完成! 共 ${resultRows.length} 行 x ${resultRows[0].length} 列`);

  return { resultRows, matchedCounts, extraHeaders, logs };
}

// ========== 全域自检：追加列数据真实性 ==========

export type SelfCheckStatus = 'ok' | 'warn' | 'error';

export interface SelfCheckColResult {
  col: string; // 列头名
  empty: number; // 空值（未匹配）行数
  nonNumeric: number; // 数值列中出现非数值（疑似损坏）
  negative: number; // 负值（异常）
  extreme: number; // 异常大值（> 1e7）
  corrupted: number; // = nonNumeric + negative + extreme
  total: number; // 数据行数
  status: SelfCheckStatus;
  samples: { r: number; v: any }[]; // 异常样例（最多 5）
}

export interface SelfCheckResult {
  columns: SelfCheckColResult[];
  score: number; // 真实性评分 = (总格 - 损坏格) / 总格，0~1
  totalCells: number;
  corruptedCells: number;
  emptyCells: number;
  status: SelfCheckStatus; // 总体判定
  generatedAt: number;
}

const EXTREME_THRESHOLD = 1e7;

/**
 * 扫描合并结果的所有追加列，校验数据真实性：
 * - 空值 = 未匹配（覆盖缺口，不算损坏但计入匹配率）
 * - 非数值 / 负值 / 异常大值 = 数据损坏（真实性失败）
 * nExtra：非主报告数量；appendCols：追加列配置（用于判断数值/百分比格式）
 */
export function computeSelfCheck(resultRows: any[][], nExtra: number, appendCols: AppendColConfig[]): SelfCheckResult {
  const header = Array.isArray(resultRows?.[0]) ? resultRows[0] : [];
  const safeAppendCols = Array.isArray(appendCols)
    ? appendCols.filter((ac) => ac && isValidColumnIndex(ac.colIdx))
    : [];
  if (header.length === 0 || safeAppendCols.length === 0 || !Number.isFinite(nExtra) || nExtra <= 0) {
    return {
      columns: [],
      score: 1,
      totalCells: 0,
      corruptedCells: 0,
      emptyCells: 0,
      status: 'ok',
      generatedAt: Date.now(),
    };
  }
  const roasColIdx = header.findIndex((h: any) => typeof h === 'string' && h.includes('ROAS'));
  let startIdx = roasColIdx + 1;
  if (startIdx <= 0) {
    const fi = header.findIndex((h: any) => typeof h === 'string' && /^\((\d+)天\)/.test(h));
    startIdx = fi === -1 ? 1 : fi;
  }
  const nCols = safeAppendCols.length * Math.max(0, nExtra);
  const totalRows = Math.max(0, (Array.isArray(resultRows) ? resultRows.length : 0) - 1);
  const columns: SelfCheckColResult[] = [];
  let totalCells = 0;
  let corruptedCells = 0;
  let emptyCells = 0;
  let anyError = false;
  let anyWarn = false;

  for (let c = 0; c < nCols; c++) {
    const colIdx = startIdx + c;
    const ac = safeAppendCols[c % safeAppendCols.length];
    const isPercent = ac.displayFormat === 'percent';
    let empty = 0;
    let nonNumeric = 0;
    let negative = 0;
    let extreme = 0;
    const samples: { r: number; v: any }[] = [];

    for (let r = 1; r <= totalRows; r++) {
      const v = Array.isArray(resultRows[r]) ? resultRows[r][colIdx] : '';
      const s = v == null ? '' : String(v).trim();
      if (s === '') {
        empty++;
        continue;
      }
      const num = parseFloat(s.replace('%', ''));
      if (isNaN(num)) {
        nonNumeric++;
        if (samples.length < 5) samples.push({ r, v });
        continue;
      }
      if (num < 0) {
        negative++;
        if (samples.length < 5) samples.push({ r, v });
        continue;
      }
      if (num > EXTREME_THRESHOLD) {
        extreme++;
        if (samples.length < 5) samples.push({ r, v });
        continue;
      }
    }

    const corrupted = nonNumeric + negative + extreme;
    const status: SelfCheckStatus =
      corrupted > 0 ? 'error' : empty / Math.max(1, totalRows) > 0.3 ? 'warn' : 'ok';
    if (status === 'error') anyError = true;
    if (status === 'warn') anyWarn = true;

    totalCells += totalRows;
    corruptedCells += corrupted;
    emptyCells += empty;
    columns.push({ col: String(header[colIdx] ?? ''), empty, nonNumeric, negative, extreme, corrupted, total: totalRows, status, samples });
  }

  const score = totalCells ? (totalCells - corruptedCells) / totalCells : 1;
  const status: SelfCheckStatus = anyError ? 'error' : anyWarn ? 'warn' : 'ok';
  return { columns, score, totalCells, corruptedCells, emptyCells, status, generatedAt: Date.now() };
}
