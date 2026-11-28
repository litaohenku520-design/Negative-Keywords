import ExcelJS from 'exceljs';

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile('D:/反重力/UPBestKS/广告数据/asin补货建议(0)-20261126164307529.xlsx');
console.log('Worksheets:', wb.worksheets.map(w => w.name));
const ws = wb.worksheets[0];
console.log('Row count:', ws.rowCount, 'Col count:', ws.columnCount);
const headerRow = ws.getRow(1);
console.log('Headers length:', headerRow.values.length);
console.log('Sample row 2 MSKU:', ws.getRow(2).getCell(3).value);
