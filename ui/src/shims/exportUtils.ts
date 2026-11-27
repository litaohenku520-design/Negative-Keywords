import * as XLSX from 'xlsx-js-style';

export async function downloadBlob({ blob, fileName }: { blob: Blob; fileName: string }) {
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
  const safeName = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  XLSX.writeFile(wb, safeName, { cellStyles });
}

export async function exportToExcel({
  data,
  columns,
  fileName,
  sheetName = 'Sheet1',
}: {
  data: any[];
  columns?: Array<{ header: string; key: string; width?: number }>;
  fileName: string;
  sheetName?: string;
  [k: string]: any;
}) {
  const rows = (data || []).map((row) => {
    if (!columns || !columns.length) return row;
    const obj: Record<string, any> = {};
    for (const col of columns) {
      obj[col.header] = row?.[col.key] ?? '';
    }
    return obj;
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  if (columns?.length) {
    ws['!cols'] = columns.map((c) => ({ wch: c.width || 18 }));
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const safeName = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  XLSX.writeFile(wb, safeName, { cellStyles: true });
}
