// Excel 解析 Web Worker：把 xlsx.read 移到后台线程，主线程上传大文件不再阻塞/假死。
import { read as xlsxRead, utils as xlsxUtils } from 'xlsx';

interface ParseRequest {
  id: number;
  buffer: ArrayBuffer;
}
interface ParseResponse {
  id: number;
  ok: boolean;
  data?: any[][];
  error?: string;
}

const ctx: any = self;

const MAX_EXCEL_COLS = 16_384;
const MAX_EXCEL_ROWS = 1_048_576;

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value) === '';
}

/** 去掉 Excel !ref 带出的纯空白尾行/尾列，避免后续合并/导出分配异常大数组。 */
function compactRows(raw: any[][]): any[][] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  let last = raw.length;
  while (last > 1) {
    const row = raw[last - 1];
    if (!Array.isArray(row) || row.slice(0, MAX_EXCEL_COLS).every(isBlank)) last--;
    else break;
  }
  return raw.slice(0, last).map((row) => {
    if (!Array.isArray(row)) return [];
    const safe = row.length > MAX_EXCEL_COLS ? row.slice(0, MAX_EXCEL_COLS) : row.slice();
    while (safe.length > 0 && isBlank(safe[safe.length - 1])) safe.pop();
    return safe;
  });
}

ctx.onmessage = (e: MessageEvent<ParseRequest>) => {
  const { id, buffer } = e.data;
  try {
    const bytes = new Uint8Array(buffer);
    const workbook = xlsxRead(bytes, { type: 'array', cellStyles: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error('工作簿没有可读取的工作表');
    const json = xlsxUtils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false }) as any[][];
    const compactData = compactRows(json);
    if (compactData.length > MAX_EXCEL_ROWS) throw new Error(`报告行数超过 Excel 上限 ${MAX_EXCEL_ROWS.toLocaleString()}`);
    const header = compactData[0];
    if (!Array.isArray(header) || header.length === 0 || header.every(isBlank)) {
      throw new Error('报告没有有效表头，请确认导入的是广告报告而不是空模板');
    }
    if (compactData.length < 2) {
      throw new Error('报告只有表头没有数据行，请检查报告日期范围或重新导出');
    }
    const res: ParseResponse = { id, ok: true, data: compactData };
    ctx.postMessage(res);
  } catch (err: any) {
    const res: ParseResponse = { id, ok: false, error: err?.message || String(err) };
    ctx.postMessage(res);
  }
};
