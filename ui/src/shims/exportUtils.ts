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
  await exportWorkbook({ wb, fileName, cellStyles: true });
}
