import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {
  COLOR_ORDER,
  REPORT_OUT_PATH,
  computeProductAnalytics,
  round2,
} from './product-engine.mjs';

const C = {
  navy: '0F172A',
  indigo: '1E3A8A',
  slate: '334155',
  ice: 'EFF6FF',
  zebra: 'F8FAFC',
  border: 'CBD5E1',
  greenBg: 'DCFCE7',
  greenTxt: '166534',
  amberBg: 'FEF3C7',
  amberTxt: '92400E',
  redBg: 'FEE2E2',
  redTxt: '991B1B',
  blueBg: 'DBEAFE',
  blueTxt: '1E40AF',
  purpleBg: 'EDE9FE',
  purpleTxt: '5B21B6',
  grayBg: 'F1F5F9',
  grayTxt: '475569',
};

const FONT = 'Microsoft YaHei';
const escXml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const thinBorder = {
  top: { style: 'thin', color: { argb: C.border } },
  left: { style: 'thin', color: { argb: C.border } },
  bottom: { style: 'thin', color: { argb: C.border } },
  right: { style: 'thin', color: { argb: C.border } },
};

function styleTitle(ws, title, subtitle, colCount) {
  ws.mergeCells(1, 1, 1, colCount);
  const c1 = ws.getCell(1, 1);
  c1.value = title;
  c1.font = { name: FONT, size: 14, bold: true, color: { argb: 'FFFFFF' } };
  c1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.navy } };
  c1.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(1).height = 30;

  ws.mergeCells(2, 1, 2, colCount);
  const c2 = ws.getCell(2, 1);
  c2.value = subtitle;
  c2.font = { name: FONT, size: 9.5, color: { argb: C.slate } };
  c2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.ice } };
  c2.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(2).height = 20;
}

function styleBanner(ws, rowNum, text, colCount, bg = '1E293B') {
  ws.mergeCells(rowNum, 1, rowNum, colCount);
  const cell = ws.getCell(rowNum, 1);
  cell.value = text;
  cell.font = { name: FONT, size: 10.5, bold: true, color: { argb: 'FFFFFF' } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
  cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(rowNum).height = 22;
}

function setHeaderRow(ws, rowNum, headers, bg = C.indigo) {
  const row = ws.getRow(rowNum);
  row.height = 26;
  headers.forEach((h, i) => {
    const cell = row.getCell(i + 1);
    cell.value = h;
    cell.font = { name: FONT, size: 9.5, bold: true, color: { argb: 'FFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder;
  });
}

function styleDataRow(ws, rowNum, colCount, isZebra = false, isTotal = false) {
  const row = ws.getRow(rowNum);
  row.height = isTotal ? 22 : 19;
  for (let i = 1; i <= colCount; i++) {
    const cell = row.getCell(i);
    cell.font = { name: FONT, size: 9.5, bold: isTotal, color: { argb: C.navy } };
    if (isTotal) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.ice } };
    } else if (isZebra) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.zebra } };
    }
    cell.border = thinBorder;
    if (!cell.alignment) {
      cell.alignment = { vertical: 'middle', horizontal: i === 1 ? 'left' : 'right' };
    }
  }
}

function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function buildBarChartXml({ title, sheetName, catRange, series }) {
  const serXml = series
    .map(
      (s, i) => `
      <c:ser>
        <c:idx val="${i}"/>
        <c:order val="${i}"/>
        <c:tx><c:v>${escXml(s.name)}</c:v></c:tx>
        <c:spPr><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill></c:spPr>
        <c:invertIfNegative val="0"/>
        <c:cat><c:strRef><c:f>'${escXml(sheetName)}'!${catRange}</c:f></c:strRef></c:cat>
        <c:val><c:numRef><c:f>'${escXml(sheetName)}'!${s.valRange}</c:f></c:numRef></c:val>
      </c:ser>`
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:chart>
    <c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="1100" b="1"/><a:t>${escXml(title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
    <c:autoTitleDeleted val="0"/>
    <c:plotArea>
      <c:layout/>
      <c:barChart>
        <c:barDir val="col"/>
        <c:grouping val="clustered"/>
        <c:varyColors val="0"/>
        ${serXml}
        <c:axId val="1"/>
        <c:axId val="2"/>
      </c:barChart>
      <c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>
      <c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:crossAx val="1"/></c:valAx>
    </c:plotArea>
    <c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>
    <c:plotVisOnly val="1"/>
  </c:chart>
</c:chartSpace>`;
}

function buildDrawingXml(anchors) {
  const items = anchors
    .map(
      (a, idx) => `
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>${a.c1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.r1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>${a.c2}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.r2}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro="">
      <xdr:nvGraphicFramePr>
        <xdr:cNvPr id="${idx + 2}" name="Chart ${idx + 1}"/>
        <xdr:cNvGraphicFramePr/>
      </xdr:nvGraphicFramePr>
      <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
          <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId${idx + 1}"/>
        </a:graphicData>
      </a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>`
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  ${items}
</xdr:wsDr>`;
}

async function injectChartsIntoXlsx(buffer, sheetCharts) {
  const zip = await JSZip.loadAsync(buffer);
  let ctXml = await zip.file('[Content_Types].xml').async('string');
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const wbRelsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');

  const sheetMap = new Map();
  const sheetRegex = /<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g;
  let m;
  while ((m = sheetRegex.exec(workbookXml)) !== null) {
    const [, name, rid] = m;
    const relRegex = new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]+)"`);
    const rm = wbRelsXml.match(relRegex);
    if (rm) sheetMap.set(name, 'xl/' + rm[1].replace(/^\/?xl\//, ''));
  }

  let chartIdx = 1;
  let drawingIdx = 1;

  for (const sc of sheetCharts) {
    const sheetPath = sheetMap.get(sc.sheetName);
    if (!sheetPath) continue;
    const sheetFile = sheetPath.split('/').pop();
    const sheetRelsPath = `xl/worksheets/_rels/${sheetFile}.rels`;

    const drawingName = `drawing${drawingIdx}.xml`;
    const drawingPath = `xl/drawings/${drawingName}`;
    const drawingRelsPath = `xl/drawings/_rels/${drawingName}.rels`;

    const drawingRels = [];
    for (const ch of sc.charts) {
      const cName = `chart${chartIdx}.xml`;
      const cPath = `xl/charts/${cName}`;
      zip.file(cPath, buildBarChartXml(ch));
      ctXml = ctXml.replace(
        '</Types>',
        `<Override PartName="/${cPath}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`
      );
      drawingRels.push(
        `<Relationship Id="rId${drawingRels.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/${cName}"/>`
      );
      chartIdx++;
    }

    zip.file(drawingPath, buildDrawingXml(sc.charts));
    zip.file(
      drawingRelsPath,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawingRels.join('')}</Relationships>`
    );
    ctXml = ctXml.replace(
      '</Types>',
      `<Override PartName="/${drawingPath}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`
    );

    let sRels = zip.file(sheetRelsPath)
      ? await zip.file(sheetRelsPath).async('string')
      : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    const newRid = `rId${90 + drawingIdx}`;
    sRels = sRels.replace(
      '</Relationships>',
      `<Relationship Id="${newRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/${drawingName}"/></Relationships>`
    );
    zip.file(sheetRelsPath, sRels);

    let sXml = await zip.file(sheetPath).async('string');
    if (!sXml.includes('<drawing ')) {
      sXml = sXml.replace('</worksheet>', `<drawing r:id="${newRid}"/></worksheet>`);
      zip.file(sheetPath, sXml);
    }

    drawingIdx++;
  }

  zip.file('[Content_Types].xml', ctXml);
  return await zip.generateAsync({ type: 'nodebuffer' });
}

export async function generateProductExcel(existingData = null, outPath = REPORT_OUT_PATH) {
  const data = existingData || (await computeProductAnalytics());
  const { meta, summary: s, byModel, byColor, byBrand, byBatch, matrix, alerts, skus } = data;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'UPBestKS Product Hub';
  wb.created = new Date();

  // =========================================================================
  // Sheet 1: 总览与核心洞察
  // =========================================================================
  const ws1 = wb.addWorksheet('总览与核心洞察', { views: [{ showGridLines: true }] });
  styleTitle(
    ws1,
    `UPBestKS 产品广告与销售深度分析报告（${meta.store} · ${meta.totalSkus} SKU）`,
    `数据源：${meta.sourceFile} | 覆盖 ${meta.modelCount} 款机型 × ${meta.colorCount} 种颜色 | 注：${meta.note}`,
    10
  );

  styleBanner(ws1, 4, '一、全店核心经营指标总览', 10);
  setHeaderRow(ws1, 5, [
    '总销量(件)', '总销售额($)', '净销售额($)', '平均售价(ASP)', '总Sessions',
    '整体转化率', '广告花费($)', '广告销售额($)', 'ACoS', 'TACoS(ACoAS)'
  ]);
  const r6 = ws1.getRow(6);
  r6.values = [
    s.units, s.sales, s.netSales, s.asp, s.sessions,
    s.cvr, s.adSpend, s.adSales, s.acos, s.tacos
  ];
  styleDataRow(ws1, 6, 10, false, true);
  [2, 3, 4, 7, 8].forEach((c) => (r6.getCell(c).numFmt = '$#,##0.00'));
  [1, 5].forEach((c) => (r6.getCell(c).numFmt = '#,##0'));
  [6, 9, 10].forEach((c) => (r6.getCell(c).numFmt = '0.0%'));

  setHeaderRow(ws1, 8, [
    '自然订单量', '自然订单占比', '广告订单量', '广告订单占比', '广告曝光量',
    '广告点击量', '广告CTR', '平均CPC($)', '退款量(率)', 'FBA可售/总库存'
  ], C.slate);
  const r9 = ws1.getRow(9);
  r9.values = [
    s.natOrders, s.natOrderShare, s.adOrders, s.adOrderShare, s.adImpr,
    s.adClicks, s.ctr, s.cpc, `${s.refundQty} (${(s.refundRate * 100).toFixed(1)}%)`, `${s.fbaSellable} / ${s.totalInv}`
  ];
  styleDataRow(ws1, 9, 10, false, false);
  [1, 3, 5, 6].forEach((c) => (r9.getCell(c).numFmt = '#,##0'));
  [2, 4, 7].forEach((c) => (r9.getCell(c).numFmt = '0.0%'));
  r9.getCell(8).numFmt = '$#,##0.00';

  // Brand table
  styleBanner(ws1, 11, '二、品牌阵营销售与广告表现对比', 10);
  setHeaderRow(ws1, 12, [
    '品牌阵营', '机型数', 'SKU数', '总销量', '销售额($)', '销售额占比',
    '广告花费($)', 'ACoS', 'TACoS', '转化率'
  ]);
  const brandStartRow = 13;
  byBrand.forEach((b, i) => {
    const rn = brandStartRow + i;
    const row = ws1.getRow(rn);
    row.values = [b.brand, b.modelCount, b.skuCount, b.units, b.sales, b.salesShare, b.adSpend, b.acos, b.tacos, b.cvr];
    styleDataRow(ws1, rn, 10, i % 2 === 1, false);
    [2, 3, 4].forEach((c) => (row.getCell(c).numFmt = '#,##0'));
    [5, 7].forEach((c) => (row.getCell(c).numFmt = '$#,##0.00'));
    [6, 8, 9, 10].forEach((c) => (row.getCell(c).numFmt = '0.0%'));
  });
  const brandEndRow = brandStartRow + byBrand.length - 1;

  // Batch table
  const batchBannerRow = brandEndRow + 2;
  styleBanner(ws1, batchBannerRow, '三、新老批次梯队对比（首批 07-05 vs 二批 09-16）', 10);
  setHeaderRow(ws1, batchBannerRow + 1, [
    '上架批次', '机型数', 'SKU数', '总销量', '近30天销量', '销售额($)',
    '销售额占比', '广告花费($)', 'TACoS', '转化率'
  ]);
  byBatch.forEach((b, i) => {
    const rn = batchBannerRow + 2 + i;
    const row = ws1.getRow(rn);
    row.values = [b.batch, b.modelCount, b.skuCount, b.units, b.d30, b.sales, b.salesShare, b.adSpend, b.tacos, b.cvr];
    styleDataRow(ws1, rn, 10, i % 2 === 1, false);
    [2, 3, 4, 5].forEach((c) => (row.getCell(c).numFmt = '#,##0'));
    [6, 8].forEach((c) => (row.getCell(c).numFmt = '$#,##0.00'));
    [7, 9, 10].forEach((c) => (row.getCell(c).numFmt = '0.0%'));
  });

  ws1.columns = [
    { width: 22 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 },
    { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 16 },
  ];

  // =========================================================================
  // Sheet 2: 分机型统计 (14 Models)
  // =========================================================================
  const ws2 = wb.addWorksheet('分机型统计', { views: [{ state: 'frozen', xSplit: 1, ySplit: 4 }] });
  styleTitle(ws2, 'UPBestKS 分机型(14款)销售、广告与库存统计', '按全周期销售额降序排列，含品牌归属、近30/14/7天动销、广告效率及主力色号', 18);
  setHeaderRow(ws2, 4, [
    '机型', '品牌', '批次', '总销量', '30天销量', '14天销量', '7天销量',
    '销售额($)', '销售占比', 'ASP($)', 'Sessions', '转化率',
    '广告花费($)', '广告销售额($)', 'ACoS', 'TACoS', '退款率', 'FBA可售 / 总库存'
  ]);
  byModel.forEach((m, i) => {
    const rn = 5 + i;
    const row = ws2.getRow(rn);
    row.values = [
      m.model, m.brand, m.batch, m.units, m.d30, m.d14, m.d7,
      m.sales, m.salesShare, m.asp, m.sessions, m.cvr,
      m.adSpend, m.adSales, m.acos, m.tacos, m.refundRate, `${m.fbaSellable} / ${m.totalInv}`
    ];
    styleDataRow(ws2, rn, 18, i % 2 === 1, false);
    [4, 5, 6, 7, 11].forEach((c) => (row.getCell(c).numFmt = '#,##0'));
    [8, 10, 13, 14].forEach((c) => (row.getCell(c).numFmt = '$#,##0.00'));
    [9, 12, 15, 16, 17].forEach((c) => (row.getCell(c).numFmt = '0.0%'));
    if (m.tacos >= 0.55) {
      row.getCell(16).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.redBg } };
      row.getCell(16).font = { name: FONT, size: 9.5, bold: true, color: { argb: C.redTxt } };
    } else if (m.tacos <= 0.35 && m.sales > 1500) {
      row.getCell(16).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.greenBg } };
      row.getCell(16).font = { name: FONT, size: 9.5, bold: true, color: { argb: C.greenTxt } };
    }
  });
  const mTotRow = 5 + byModel.length;
  const rMTot = ws2.getRow(mTotRow);
  rMTot.values = [
    '合计 / 均值', '-', '-', s.units, s.d30, s.d14, s.d7,
    s.sales, 1, s.asp, s.sessions, s.cvr,
    s.adSpend, s.adSales, s.acos, s.tacos, s.refundRate, `${s.fbaSellable} / ${s.totalInv}`
  ];
  styleDataRow(ws2, mTotRow, 18, false, true);
  [4, 5, 6, 7, 11].forEach((c) => (rMTot.getCell(c).numFmt = '#,##0'));
  [8, 10, 13, 14].forEach((c) => (rMTot.getCell(c).numFmt = '$#,##0.00'));
  [9, 12, 15, 16, 17].forEach((c) => (rMTot.getCell(c).numFmt = '0.0%'));

  ws2.autoFilter = { from: 'A4', to: `R${mTotRow - 1}` };
  ws2.columns = [
    { width: 22 }, { width: 15 }, { width: 16 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 },
    { width: 13 }, { width: 10 }, { width: 9 }, { width: 11 }, { width: 10 },
    { width: 13 }, { width: 13 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 16 },
  ];

  // =========================================================================
  // Sheet 3: 分颜色统计 (8 Colors)
  // =========================================================================
  const ws3 = wb.addWorksheet('分颜色统计', { views: [{ state: 'frozen', xSplit: 2, ySplit: 4 }] });
  styleTitle(ws3, 'UPBestKS 分颜色(8大色系)销售、广告与口碑统计', '跨全部 14 款机型的色号维度汇总，用于指导采购备货比例与主推色投放', 16);
  setHeaderRow(ws3, 4, [
    '颜色(英文)', '颜色(中文)', 'SKU数', '总销量', '30天销量', '销售额($)', '销售占比',
    'Sessions', '转化率', '广告花费($)', '广告销售额($)', 'ACoS', 'TACoS',
    '退款率', '平均评分', '最畅销机型'
  ]);
  byColor.forEach((c, i) => {
    const rn = 5 + i;
    const row = ws3.getRow(rn);
    row.values = [
      c.colorEn, c.colorCn, c.skuCount, c.units, c.d30, c.sales, c.salesShare,
      c.sessions, c.cvr, c.adSpend, c.adSales, c.acos, c.tacos,
      c.refundRate, c.avgRating, `${c.topModel} ($${c.topModelSales.toFixed(0)})`
    ];
    styleDataRow(ws3, rn, 16, i % 2 === 1, false);
    [3, 4, 5, 8].forEach((col) => (row.getCell(col).numFmt = '#,##0'));
    [6, 10, 11].forEach((col) => (row.getCell(col).numFmt = '$#,##0.00'));
    [7, 9, 12, 13, 14].forEach((col) => (row.getCell(col).numFmt = '0.0%'));
    row.getCell(15).numFmt = '0.00';
  });
  const cTotRow = 5 + byColor.length;
  const rCTot = ws3.getRow(cTotRow);
  rCTot.values = [
    '合计 / 均值', '全色系', s.skuCount, s.units, s.d30, s.sales, 1,
    s.sessions, s.cvr, s.adSpend, s.adSales, s.acos, s.tacos,
    s.refundRate, s.avgRating, '-'
  ];
  styleDataRow(ws3, cTotRow, 16, false, true);
  [3, 4, 5, 8].forEach((col) => (rCTot.getCell(col).numFmt = '#,##0'));
  [6, 10, 11].forEach((col) => (rCTot.getCell(col).numFmt = '$#,##0.00'));
  [7, 9, 12, 13, 14].forEach((col) => (rCTot.getCell(col).numFmt = '0.0%'));
  rCTot.getCell(15).numFmt = '0.00';

  ws3.columns = [
    { width: 15 }, { width: 12 }, { width: 8 }, { width: 10 }, { width: 10 }, { width: 13 }, { width: 10 },
    { width: 11 }, { width: 10 }, { width: 13 }, { width: 13 }, { width: 10 }, { width: 10 },
    { width: 10 }, { width: 10 }, { width: 24 },
  ];

  // =========================================================================
  // Sheet 4: 机型×颜色热力矩阵
  // =========================================================================
  const ws4 = wb.addWorksheet('机型×颜色热力矩阵', { views: [{ state: 'frozen', xSplit: 1, ySplit: 4 }] });
  const colorHeaders = COLOR_ORDER.map((c) => `${c.cn}\n(${c.en})`);
  styleTitle(ws4, 'UPBestKS 机型 × 颜色 交叉热力矩阵（14 机型 × 8 颜色）', '包含销售额($)、销量(件)、TACoS(%) 与 FBA可售库存 四大交叉矩阵', 10);

  const writeMatrixBlock = (startRow, title, field, fmt, heatFn) => {
    styleBanner(ws4, startRow, title, 10);
    setHeaderRow(ws4, startRow + 1, ['机型 \\ 颜色', ...colorHeaders, '机型合计/均值']);
    byModel.forEach((m, idx) => {
      const rn = startRow + 2 + idx;
      const row = ws4.getRow(rn);
      const vals = COLOR_ORDER.map((c) => {
        const cellData = matrix[m.model]?.[c.en];
        return cellData ? cellData[field] : 0;
      });
      const rowSummary = field === 'tacos' ? m.tacos : vals.reduce((a, b) => a + b, 0);
      row.values = [m.model, ...vals, rowSummary];
      styleDataRow(ws4, rn, 10, idx % 2 === 1, false);
      for (let ci = 2; ci <= 10; ci++) {
        const cell = row.getCell(ci);
        cell.numFmt = fmt;
        if (ci <= 9 && heatFn) {
          const fillHex = heatFn(vals[ci - 2]);
          if (fillHex) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillHex } };
        }
      }
    });
    return startRow + 2 + byModel.length + 1;
  };

  let nextR = 4;
  nextR = writeMatrixBlock(nextR, '矩阵 A：销售额 ($) 交叉分布', 'sales', '$#,##0.00', (v) =>
    v >= 800 ? 'BBF7D0' : v >= 400 ? 'DCFCE7' : v >= 150 ? 'EFF6FF' : null
  );
  nextR = writeMatrixBlock(nextR, '矩阵 B：总销量 (件) 交叉分布', 'units', '#,##0', (v) =>
    v >= 50 ? 'BBF7D0' : v >= 20 ? 'DCFCE7' : v >= 8 ? 'EFF6FF' : null
  );
  nextR = writeMatrixBlock(nextR, '矩阵 C：TACoS (广告花费/总销售额) 效率矩阵', 'tacos', '0.0%', (v) =>
    v >= 0.7 ? 'FECACA' : v >= 0.5 ? 'FEF3C7' : v > 0 && v <= 0.3 ? 'DCFCE7' : null
  );
  writeMatrixBlock(nextR, '矩阵 D：FBA 可售库存 (件) 分布矩阵', 'fbaSellable', '#,##0', (v) =>
    v === 0 ? 'FEE2E2' : v >= 60 ? 'FEF3C7' : null
  );

  ws4.columns = [
    { width: 22 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 13 },
    { width: 13 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 15 },
  ];

  // =========================================================================
  // Sheet 5: 广告效率与流量诊断
  // =========================================================================
  const ws5 = wb.addWorksheet('广告效率与流量诊断');
  styleTitle(ws5, 'UPBestKS 广告投放效率与异常预警诊断', '识别高 TACoS 烧钱止损款、高转化低曝光放量款、高退款隐患款与明星爆款', 11);

  const writeAlertSection = (startRow, banner, list, bg) => {
    styleBanner(ws5, startRow, banner, 11, bg);
    setHeaderRow(ws5, startRow + 1, [
      'MSKU', '机型', '颜色', '销量', '销售额($)', '广告花费($)', '广告销售额($)',
      'ACoS', 'TACoS', '转化率', '退款率'
    ]);
    list.forEach((x, i) => {
      const rn = startRow + 2 + i;
      const row = ws5.getRow(rn);
      row.values = [
        x.msku, x.model, x.colorCn, x.units, x.sales, x.adSpend, x.adSales,
        x.acos, x.tacos, x.cvr, x.refundRate
      ];
      styleDataRow(ws5, rn, 11, i % 2 === 1, false);
      row.getCell(4).numFmt = '#,##0';
      [5, 6, 7].forEach((c) => (row.getCell(c).numFmt = '$#,##0.00'));
      [8, 9, 10, 11].forEach((c) => (row.getCell(c).numFmt = '0.0%'));
    });
    return startRow + 2 + list.length + 1;
  };

  let aRow = 4;
  aRow = writeAlertSection(aRow, `一、高耗预警 SKU（广告花费 ≥ $80 且 TACoS ≥ 55%，共 ${alerts.highTacosCount} 款）`, alerts.highTacosSkus, '991B1B');
  aRow = writeAlertSection(aRow, `二、明星爆款 SKU（高产出 + TACoS ≤ 38%，共 ${alerts.starCount} 款）`, alerts.starSkus, '166534');
  aRow = writeAlertSection(aRow, `三、高潜待放量 SKU（转化率 ≥ 8% 但曝光偏低，共 ${alerts.potentialCount} 款）`, alerts.potentialSkus, '1E40AF');
  writeAlertSection(aRow, `四、高退款预警 SKU（销量 ≥ 10 且退款率 ≥ 12%，共 ${alerts.highRefundCount} 款）`, alerts.highRefundSkus, '92400E');

  ws5.columns = [
    { width: 32 }, { width: 20 }, { width: 10 }, { width: 9 }, { width: 12 }, { width: 12 },
    { width: 13 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 },
  ];

  // =========================================================================
  // Sheet 6: 全量SKU明细(112款)
  // =========================================================================
  const ws6 = wb.addWorksheet('全量SKU明细(112款)', { views: [{ state: 'frozen', xSplit: 3, ySplit: 4 }] });
  styleTitle(ws6, `UPBestKS 全量 ${skus.length} 个 SKU 完整经营明细表`, '含机型/颜色/品牌/批次解析、四象限标签、多周期销量、广告、流量、评分与库存', 24);
  setHeaderRow(ws6, 4, [
    'ASIN', 'MSKU', '机型', '颜色(中)', '颜色(英)', '品牌', '批次', '四象限诊断',
    '总销量', '30天销量', '7天销量', '销售额($)', '净销售额($)', 'ASP($)',
    'Sessions', '转化率', '自然订单', '广告花费($)', '广告销售额($)', 'ACoS', 'TACoS',
    '退款率', '评分(评分数)', 'FBA可售 / 总库存'
  ]);
  skus.forEach((x, i) => {
    const rn = 5 + i;
    const row = ws6.getRow(rn);
    row.values = [
      x.asin, x.msku, x.model, x.colorCn, x.colorEn, x.brand, x.batch, x.quadrant,
      x.units, x.d30, x.d7, x.sales, x.netSales, x.asp,
      x.sessions, x.cvr, x.natOrders, x.adSpend, x.adSales, x.acos, x.tacos,
      x.refundRate, `${x.rating} (${x.reviews})`, `${x.fbaSellable} / ${x.totalInv}`
    ];
    styleDataRow(ws6, rn, 24, i % 2 === 1, false);
    [9, 10, 11, 15, 17].forEach((c) => (row.getCell(c).numFmt = '#,##0'));
    [12, 13, 14, 18, 19].forEach((c) => (row.getCell(c).numFmt = '$#,##0.00'));
    [16, 20, 21, 22].forEach((c) => (row.getCell(c).numFmt = '0.0%'));
  });
  ws6.autoFilter = { from: 'A4', to: `X${4 + skus.length}` };
  ws6.columns = [
    { width: 13 }, { width: 32 }, { width: 20 }, { width: 10 }, { width: 13 }, { width: 15 }, { width: 16 }, { width: 13 },
    { width: 9 }, { width: 10 }, { width: 9 }, { width: 12 }, { width: 12 }, { width: 9 },
    { width: 10 }, { width: 9 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 9 }, { width: 9 },
    { width: 9 }, { width: 13 }, { width: 16 },
  ];

  const rawBuf = await wb.xlsx.writeBuffer();
  const finalBuf = await injectChartsIntoXlsx(rawBuf, [
    {
      sheetName: '总览与核心洞察',
      charts: [
        {
          title: '品牌阵营：销售额($) vs 广告花费($)',
          sheetName: '总览与核心洞察',
          catRange: `$A$${brandStartRow}:$A$${brandEndRow}`,
          series: [
            { name: '销售额($)', valRange: `$E$${brandStartRow}:$E$${brandEndRow}`, color: '2563EB' },
            { name: '广告花费($)', valRange: `$G$${brandStartRow}:$G$${brandEndRow}`, color: 'F59E0B' },
          ],
          c1: 0, r1: batchBannerRow + 5, c2: 10, r2: batchBannerRow + 22,
        },
      ],
    },
    {
      sheetName: '分机型统计',
      charts: [
        {
          title: '14 款机型：销售额($) vs 广告花费($)',
          sheetName: '分机型统计',
          catRange: `$A$5:$A$${4 + byModel.length}`,
          series: [
            { name: '销售额($)', valRange: `$H$5:$H$${4 + byModel.length}`, color: '2563EB' },
            { name: '广告花费($)', valRange: `$M$5:$M$${4 + byModel.length}`, color: 'F97316' },
          ],
          c1: 0, r1: mTotRow + 2, c2: 9, r2: mTotRow + 20,
        },
        {
          title: '14 款机型：ACoS vs TACoS 效率对比',
          sheetName: '分机型统计',
          catRange: `$A$5:$A$${4 + byModel.length}`,
          series: [
            { name: 'ACoS', valRange: `$O$5:$O$${4 + byModel.length}`, color: '8B5CF6' },
            { name: 'TACoS', valRange: `$P$5:$P$${4 + byModel.length}`, color: 'EF4444' },
          ],
          c1: 9, r1: mTotRow + 2, c2: 18, r2: mTotRow + 20,
        },
      ],
    },
    {
      sheetName: '分颜色统计',
      charts: [
        {
          title: '8 大颜色：销售额($) vs 广告花费($)',
          sheetName: '分颜色统计',
          catRange: `$B$5:$B$${4 + byColor.length}`,
          series: [
            { name: '销售额($)', valRange: `$F$5:$F$${4 + byColor.length}`, color: '10B981' },
            { name: '广告花费($)', valRange: `$J$5:$J$${4 + byColor.length}`, color: 'F59E0B' },
          ],
          c1: 0, r1: cTotRow + 2, c2: 8, r2: cTotRow + 19,
        },
        {
          title: '8 大颜色：转化率 vs TACoS',
          sheetName: '分颜色统计',
          catRange: `$B$5:$B$${4 + byColor.length}`,
          series: [
            { name: '转化率', valRange: `$I$5:$I$${4 + byColor.length}`, color: '3B82F6' },
            { name: 'TACoS', valRange: `$M$5:$M$${4 + byColor.length}`, color: 'E11D48' },
          ],
          c1: 8, r1: cTotRow + 2, c2: 16, r2: cTotRow + 19,
        },
      ],
    },
  ]);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, finalBuf);
  return {
    outPath,
    sheets: wb.worksheets.map((w) => w.name),
    chartsCount: 5,
    sizeKb: round2(finalBuf.length / 1024),
  };
}
