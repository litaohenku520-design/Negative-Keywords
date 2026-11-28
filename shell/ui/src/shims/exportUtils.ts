import * as XLSX from 'xlsx-js-style';
import { message } from 'antd';

async function saveViaMcpBackend(fileName: string, base64Content: string): Promise<string | null> {
  if (typeof window !== 'undefined' && typeof (window as any).__MCP_API_FETCH__ === 'function') {
    const res = await (window as any).__MCP_API_FETCH__('/api/export/save', {
      method: 'POST',
      body: JSON.stringify({ fileName, base64Content }),
    });
    if (res?.path) {
      message.success(`文件已保存到：${res.path}`, 6);
      return res.path;
    }
  }
  return null;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Blob 读取失败'));
    reader.readAsDataURL(blob);
  });
}

const THIN_BORDER = {
  top: { style: 'thin', color: { rgb: 'CBD5E1' } },
  bottom: { style: 'thin', color: { rgb: 'CBD5E1' } },
  left: { style: 'thin', color: { rgb: 'CBD5E1' } },
  right: { style: 'thin', color: { rgb: 'CBD5E1' } },
};

const HEADER_STYLE = {
  font: { name: 'Microsoft YaHei', sz: 10.5, bold: true, color: { rgb: 'FFFFFF' } },
  fill: { patternType: 'solid', fgColor: { rgb: '1E40AF' } },
  alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
  border: {
    top: { style: 'thin', color: { rgb: '1E3A8A' } },
    bottom: { style: 'medium', color: { rgb: '1E3A8A' } },
    left: { style: 'thin', color: { rgb: '3B82F6' } },
    right: { style: 'thin', color: { rgb: '3B82F6' } },
  },
};

function applyZebraAndBeautify(ws: XLSX.WorkSheet): void {
  if (!ws || !ws['!ref']) return;
  const range = XLSX.utils.decode_range(ws['!ref']);
  const totalRows = range.e.r + 1;
  const totalCols = range.e.c + 1;

  // 行高：表头 26pt，数据行 22pt（拉开行间距方便阅读核对）
  const rowsMeta: Array<{ hpt: number }> = [];
  for (let r = 0; r < totalRows; r++) {
    rowsMeta.push({ hpt: r === 0 ? 26 : 22 });
  }
  ws['!rows'] = rowsMeta;

  // 计算每列智能宽度（若原列宽未设定或偏窄）
  const existingCols = (ws['!cols'] || []) as Array<{ wch?: number }>;
  const autoWidths: number[] = new Array(totalCols).fill(14);
  for (let c = 0; c < totalCols; c++) {
    if (existingCols[c]?.wch) autoWidths[c] = existingCols[c].wch!;
  }

  for (let r = range.s.r; r <= range.e.r; r++) {
    const isHeader = r === 0;
    const isEvenDataRow = r > 0 && r % 2 === 0;
    const rowBg = isEvenDataRow ? 'EFF6FF' : 'FFFFFF';

    for (let c = range.s.c; c <= range.e.c; c++) {
      const ref = XLSX.utils.encode_cell({ r, c });
      if (!ws[ref]) {
        ws[ref] = { t: 's', v: '' };
      }
      const cell = ws[ref];

      // 估算文本显示宽度
      const valStr = cell.v != null ? String(cell.v) : '';
      if (valStr) {
        let visualLen = 0;
        for (let i = 0; i < valStr.length; i++) {
          visualLen += valStr.charCodeAt(i) > 127 ? 2 : 1;
        }
        autoWidths[c] = Math.min(50, Math.max(autoWidths[c], visualLen + 4));
      }

      if (isHeader) {
        cell.s = HEADER_STYLE;
      } else {
        const prev = (cell.s || {}) as Record<string, any>;
        cell.s = {
          ...prev,
          font: {
            name: 'Microsoft YaHei',
            sz: 10,
            color: { rgb: '1E293B' },
            ...(prev.font || {}),
          },
          fill: prev.fill || { patternType: 'solid', fgColor: { rgb: rowBg } },
          alignment: {
            vertical: 'center',
            horizontal: prev.alignment?.horizontal || 'left',
            wrapText: true,
          },
          border: prev.border || THIN_BORDER,
        };
      }
    }
  }

  ws['!cols'] = autoWidths.map((w) => ({ wch: w }));
  ws['!autofilter'] = { ref: ws['!ref'] };
  // 冻结首行（兼容 Excel / WPS）
  ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
  ws['!views'] = [{ state: 'frozen', ySplit: 1 }];
}

function beautifyWorkbook(wb: XLSX.WorkBook): void {
  for (const name of wb.SheetNames || []) {
    const ws = wb.Sheets?.[name];
    if (ws) applyZebraAndBeautify(ws);
  }
}

export async function downloadBlob({ blob, fileName }: { blob: Blob; fileName: string }) {
  try {
    const b64 = await blobToBase64(blob);
    const saved = await saveViaMcpBackend(fileName, b64);
    if (saved) return;
  } catch (err) {
    message.error(`保存文件失败: ${(err as Error).message}`);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportWorkbook({
  wb,
  fileName,
  cellStyles = true,
}: {
  wb: XLSX.WorkBook;
  fileName: string;
  cellStyles?: boolean;
}) {
  beautifyWorkbook(wb);
  const safeName = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  if (typeof window !== 'undefined' && typeof (window as any).__MCP_API_FETCH__ === 'function') {
    try {
      const b64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64', cellStyles });
      const saved = await saveViaMcpBackend(safeName, b64);
      if (saved) return;
    } catch (err) {
      message.error(`保存 Excel 失败: ${(err as Error).message}`);
      return;
    }
  }
  XLSX.writeFile(wb, safeName, { cellStyles });
}

interface ExportColumn {
  header: string;
  key: string;
  width?: number;
}

interface ExportSheetDef {
  name: string;
  data: any[];
  columns?: ExportColumn[];
}

function buildWorksheet(data: any[], columns?: ExportColumn[]): XLSX.WorkSheet {
  const cols = columns || [];
  let ws: XLSX.WorkSheet;
  if (cols.length > 0) {
    const aoa: any[][] = [cols.map((c) => c.header)];
    for (const row of data || []) {
      aoa.push(cols.map((c) => (row?.[c.key] ?? '')));
    }
    ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = cols.map((c) => ({ wch: c.width || 18 }));
  } else {
    ws = XLSX.utils.json_to_sheet(data || []);
  }
  return ws;
}

export async function exportToExcel({
  data,
  columns,
  fileName,
  sheetName = 'Sheet1',
  sheets,
}: {
  data?: any[];
  columns?: ExportColumn[];
  fileName: string;
  sheetName?: string;
  sheets?: ExportSheetDef[];
  [k: string]: any;
}) {
  const wb = XLSX.utils.book_new();
  if (Array.isArray(sheets) && sheets.length > 0) {
    sheets.forEach((sheet, idx) => {
      const safeSheetName = (sheet.name || `Sheet${idx + 1}`).slice(0, 31);
      const ws = buildWorksheet(sheet.data || [], sheet.columns);
      XLSX.utils.book_append_sheet(wb, ws, safeSheetName);
    });
  } else {
    const safeSheetName = (sheetName || 'Sheet1').slice(0, 31);
    const ws = buildWorksheet(data || [], columns);
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName);
  }
  await exportWorkbook({ wb, fileName, cellStyles: true });
}
