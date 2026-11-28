import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { COLOR_ORDER, REPORT_OUT_PATH, computeSalesAnalytics, round1, round2 } from './sales-engine.mjs';

const COLORS = {
  navy: '0F172A',
  indigo: '1E3A8A',
  slate: '334155',
  blue: '2563EB',
  sky: '0284C7',
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

const FONT_NAME = 'Microsoft YaHei';
const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const thinBorder = {
  top: { style: 'thin', color: { argb: COLORS.border } },
  left: { style: 'thin', color: { argb: COLORS.border } },
  bottom: { style: 'thin', color: { argb: COLORS.border } },
  right: { style: 'thin', color: { argb: COLORS.border } },
};

function styleTitle(ws, title, subtitle, colCount) {
  ws.mergeCells(1, 1, 1, colCount);
  const c1 = ws.getCell(1, 1);
  c1.value = title;
  c1.font = { name: FONT_NAME, size: 14, bold: true, color: { argb: 'FFFFFF' } };
  c1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } };
  c1.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(1).height = 30;

  ws.mergeCells(2, 1, 2, colCount);
  const c2 = ws.getCell(2, 1);
  c2.value = subtitle;
  c2.font = { name: FONT_NAME, size: 9.5, color: { argb: COLORS.slate } };
  c2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.ice } };
  c2.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(2).height = 20;
}

function styleSectionBanner(ws, rowNum, text, colCount, bg = '1E293B') {
  ws.mergeCells(rowNum, 1, rowNum, colCount);
  const cell = ws.getCell(rowNum, 1);
  cell.value = text;
  cell.font = { name: FONT_NAME, size: 10.5, bold: true, color: { argb: 'FFFFFF' } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
  cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(rowNum).height = 22;
}

function setHeaderRow(ws, rowNum, headers, bg = COLORS.indigo) {
  const row = ws.getRow(rowNum);
  row.height = 26;
  headers.forEach((h, i) => {
    const cell = row.getCell(i + 1);
    cell.value = h;
    cell.font = { name: FONT_NAME, size: 9.5, bold: true, color: { argb: 'FFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder;
  });
}

function styleDataCell(cell, { fmt, align = 'right', bold = false, zebra = false, color } = {}) {
  cell.font = { name: FONT_NAME, size: 9.5, bold, color: { argb: color || '0F172A' } };
  if (zebra) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.zebra } };
  cell.alignment = { vertical: 'middle', horizontal: align };
  cell.border = thinBorder;
  if (fmt) cell.numFmt = fmt;
}

function styleBadge(cell, tone) {
  const map = {
    red: [COLORS.redBg, COLORS.redTxt],
    amber: [COLORS.amberBg, COLORS.amberTxt],
    green: [COLORS.greenBg, COLORS.greenTxt],
    blue: [COLORS.blueBg, COLORS.blueTxt],
    purple: [COLORS.purpleBg, COLORS.purpleTxt],
    gray: [COLORS.grayBg, COLORS.grayTxt],
  };
  const [bg, txt] = map[tone] || map.gray;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
  cell.font = { name: FONT_NAME, size: 9.5, bold: true, color: { argb: txt } };
  cell.alignment = { vertical: 'middle', horizontal: 'center' };
  cell.border = thinBorder;
}

function styleTotalRow(row, colCount) {
  row.height = 22;
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E2E8F0' } };
    cell.font = { name: FONT_NAME, size: 9.5, bold: true, color: { argb: '0F172A' } };
    cell.border = {
      top: { style: 'medium', color: { argb: COLORS.navy } },
      bottom: { style: 'double', color: { argb: COLORS.navy } },
      left: { style: 'thin', color: { argb: COLORS.border } },
      right: { style: 'thin', color: { argb: COLORS.border } },
    };
  }
}

function buildBarChartXml({ title, barDir = 'col', showLegend = true, legendPos = 'b', valFmt = '$#,##0', series, pointColors = null }) {
  const serXml = series.map((s, idx) => {
    const spPr = s.color ? `<c:spPr><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>` : '';
    let dPtXml = '';
    if (pointColors && idx === 0) {
      dPtXml = pointColors.map((hex, pi) =>
        `<c:dPt><c:idx val="${pi}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${hex}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:dPt>`
      ).join('');
    }
    const dLbls = s.dataLabels === false ? '' : `
      <c:dLbls>
        <c:numFmt formatCode="${escXml(s.labelFmt || valFmt)}" sourceLinked="0"/>
        <c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="800" b="1"><a:solidFill><a:srgbClr val="1E293B"/></a:solidFill><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/></a:defRPr></a:pPr><a:endParaRPr lang="zh-CN"/></a:p></c:txPr>
        <c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/>
      </c:dLbls>`;
    return `
      <c:ser>
        <c:idx val="${idx}"/><c:order val="${idx}"/>
        <c:tx><c:v>${escXml(s.name)}</c:v></c:tx>
        ${spPr}
        <c:invertIfNegative val="0"/>
        ${dPtXml}
        ${dLbls}
        <c:cat><c:strRef><c:f>${escXml(s.catFormula)}</c:f></c:strRef></c:cat>
        <c:val><c:numRef><c:f>${escXml(s.valFormula)}</c:f></c:numRef></c:val>
      </c:ser>`;
  }).join('');

  const legendXml = showLegend ? `
    <c:legend>
      <c:legendPos val="${legendPos}"/>
      <c:overlay val="0"/>
      <c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"><a:solidFill><a:srgbClr val="334155"/></a:solidFill><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/></a:defRPr></a:pPr><a:endParaRPr lang="zh-CN"/></a:p></c:txPr>
    </c:legend>` : '';

  const catAxPos = barDir === 'bar' ? 'l' : 'b';
  const valAxPos = barDir === 'bar' ? 'b' : 'l';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:lang val="zh-CN"/>
  <c:roundedCorners val="0"/>
  <c:chart>
    <c:title>
      <c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1050" b="1"><a:solidFill><a:srgbClr val="0F172A"/></a:solidFill><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/></a:defRPr></a:pPr><a:r><a:rPr lang="zh-CN" sz="1050" b="1"><a:solidFill><a:srgbClr val="0F172A"/></a:solidFill><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/></a:rPr><a:t>${escXml(title)}</a:t></a:r></a:p></c:rich></c:tx>
      <c:overlay val="0"/>
    </c:title>
    <c:autoTitleDeleted val="0"/>
    <c:plotArea>
      <c:layout/>
      <c:barChart>
        <c:barDir val="${barDir}"/>
        <c:grouping val="clustered"/>
        <c:varyColors val="0"/>
        ${serXml}
        <c:gapWidth val="75"/>
        <c:overlap val="-15"/>
        <c:axId val="11111111"/>
        <c:axId val="22222222"/>
      </c:barChart>
      <c:catAx>
        <c:axId val="11111111"/>
        <c:scaling><c:orientation val="${barDir === 'bar' ? 'maxMin' : 'minMax'}"/></c:scaling>
        <c:delete val="0"/>
        <c:axPos val="${catAxPos}"/>
        <c:majorTickMark val="none"/><c:minorTickMark val="none"/>
        <c:tickLblPos val="nextTo"/>
        <c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:ln></c:spPr>
        <c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="800"><a:solidFill><a:srgbClr val="334155"/></a:solidFill><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/></a:defRPr></a:pPr><a:endParaRPr lang="zh-CN"/></a:p></c:txPr>
        <c:crossAx val="22222222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/>
      </c:catAx>
      <c:valAx>
        <c:axId val="22222222"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/>
        <c:axPos val="${valAxPos}"/>
        <c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E2E8F0"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>
        <c:numFmt formatCode="${escXml(valFmt)}" sourceLinked="0"/>
        <c:majorTickMark val="none"/><c:minorTickMark val="none"/>
        <c:tickLblPos val="nextTo"/>
        <c:spPr><a:ln><a:noFill/></a:ln></c:spPr>
        <c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="800"><a:solidFill><a:srgbClr val="64748B"/></a:solidFill><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/></a:defRPr></a:pPr><a:endParaRPr lang="zh-CN"/></a:p></c:txPr>
        <c:crossAx val="11111111"/><c:crosses val="autoZero"/><c:crossBetween val="between"/>
      </c:valAx>
    </c:plotArea>
    ${legendXml}
    <c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/>
  </c:chart>
  <c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:ln></c:spPr>
</c:chartSpace>`;
}

function buildDrawingXml(anchors) {
  const items = anchors.map((a, i) => `
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>${a.c1}</xdr:col><xdr:colOff>50000</xdr:colOff><xdr:row>${a.r1}</xdr:row><xdr:rowOff>50000</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>${a.c2}</xdr:col><xdr:colOff>-50000</xdr:colOff><xdr:row>${a.r2}</xdr:row><xdr:rowOff>-50000</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro="">
      <xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${a.chartId}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>
      <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
        <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId${i + 1}"/>
      </a:graphicData></a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${items}</xdr:wsDr>`;
}

function buildDrawingRelsXml(anchors) {
  const rels = anchors.map((a, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${a.chartId}.xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

function heatBg(val, maxVal, baseHex = 'DBEAFE', midHex = '93C5FD', hiHex = '2563EB') {
  if (!val || maxVal <= 0) return { bg: 'FFFFFF', txt: '94A3B8' };
  const ratio = val / maxVal;
  if (ratio >= 0.6) return { bg: hiHex, txt: 'FFFFFF' };
  if (ratio >= 0.25) return { bg: midHex, txt: '0F172A' };
  return { bg: baseHex, txt: '1E3A8A' };
}

export async function generateSalesExcel(data, outPath = REPORT_OUT_PATH) {
  if (!data) data = await computeSalesAnalytics();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'UPBestKS Sales Hub';
  wb.created = new Date();

  const { meta, summary, periods, cohorts, monthly, weekly, daily, models, colors, matrix, invBuckets, inventorySummary, skus } = data;

  // =========================================================================
  // SHEET 1: 1_总览看板与周期趋势
  // =========================================================================
  const ws1 = wb.addWorksheet('1_总览看板与周期趋势', { views: [{ showGridLines: true, state: 'frozen', ySplit: 2 }] });
  styleTitle(
    ws1,
    `UPBestKS 美国站销售与库存深度分析看板（${meta.earliestDate} 至 ${meta.latestDate}）`,
    `店铺：${meta.store} | 共 ${meta.totalDays} 天 | ${meta.modelsCount} 款机型 / ${meta.skusCount} 个 SKU | 累计总销量 ${summary.totalUnits} 件 / 总销售额 $${summary.totalSales.toFixed(2)} | FBA 总库存 ${inventorySummary.fbaTotal} 件`,
    10
  );

  styleSectionBanner(ws1, 3, '一、全周期与多窗口对比摘要（7天 / 15天 / 30天环比）', 10);
  setHeaderRow(ws1, 4, ['统计窗口', '日期范围', '天数', '活跃SKU数', '总销量(件)', '总订单量', '总销售额($)', '日均销量(件)', '日均销售额($)', '客单价 ASP($)']);
  const winRows = [
    ['全周期汇总', `${periods.all.startDate} ~ ${periods.all.endDate}`, periods.all],
    ['前 30 天', `${periods.prev30.startDate} ~ ${periods.prev30.endDate}`, periods.prev30],
    ['近 30 天', `${periods.d30.startDate} ~ ${periods.d30.endDate}`, periods.d30],
    ['前 15 天', `${periods.prev15.startDate} ~ ${periods.prev15.endDate}`, periods.prev15],
    ['近 15 天', `${periods.d15.startDate} ~ ${periods.d15.endDate}`, periods.d15],
    ['前 7 天', `${periods.prev7.startDate} ~ ${periods.prev7.endDate}`, periods.prev7],
    ['近 7 天', `${periods.d7.startDate} ~ ${periods.d7.endDate}`, periods.d7],
  ];
  winRows.forEach(([label, range, p], idx) => {
    const r = ws1.getRow(5 + idx);
    r.height = 20;
    const z = idx % 2 === 1;
    const isLatest = label.startsWith('近');
    r.getCell(1).value = label; styleDataCell(r.getCell(1), { align: 'left', bold: isLatest || idx === 0, zebra: z });
    r.getCell(2).value = range; styleDataCell(r.getCell(2), { align: 'center', zebra: z });
    r.getCell(3).value = p.days; styleDataCell(r.getCell(3), { fmt: '#,##0', align: 'center', zebra: z });
    r.getCell(4).value = p.activeSkus; styleDataCell(r.getCell(4), { fmt: '#,##0', align: 'center', zebra: z });
    r.getCell(5).value = p.units; styleDataCell(r.getCell(5), { fmt: '#,##0', bold: isLatest, zebra: z });
    r.getCell(6).value = p.orders; styleDataCell(r.getCell(6), { fmt: '#,##0', zebra: z });
    r.getCell(7).value = p.sales; styleDataCell(r.getCell(7), { fmt: '$#,##0.00', bold: isLatest, zebra: z });
    r.getCell(8).value = p.dailyAvgUnits; styleDataCell(r.getCell(8), { fmt: '0.00', zebra: z });
    r.getCell(9).value = p.dailyAvgSales; styleDataCell(r.getCell(9), { fmt: '$#,##0.00', bold: isLatest, zebra: z });
    r.getCell(10).value = p.asp; styleDataCell(r.getCell(10), { fmt: '$#,##0.00', zebra: z });
  });

  // Section II: Cohorts
  styleSectionBanner(ws1, 13, '二、老品主力（8月上架 5款）vs 11月新品（11/03起售 9款）贡献拆解', 10);
  setHeaderRow(ws1, 14, ['产品梯队', '机型数', 'SKU数', '全周期销量', '全周期销售额($)', '全周期销售占比', '近15天销量', '近15天销售额($)', '近15天销售占比', 'FBA总库存(件)']);
  cohorts.forEach((c, idx) => {
    const r = ws1.getRow(15 + idx);
    r.height = 21;
    const z = idx % 2 === 1;
    r.getCell(1).value = c.cohort; styleDataCell(r.getCell(1), { align: 'left', bold: true, zebra: z });
    r.getCell(2).value = c.modelsCount; styleDataCell(r.getCell(2), { fmt: '#,##0', align: 'center', zebra: z });
    r.getCell(3).value = c.skusCount; styleDataCell(r.getCell(3), { fmt: '#,##0', align: 'center', zebra: z });
    r.getCell(4).value = c.units; styleDataCell(r.getCell(4), { fmt: '#,##0', zebra: z });
    r.getCell(5).value = c.sales; styleDataCell(r.getCell(5), { fmt: '$#,##0.00', bold: true, zebra: z });
    r.getCell(6).value = c.salesShare; styleDataCell(r.getCell(6), { fmt: '0.0%', zebra: z });
    r.getCell(7).value = c.d15Units; styleDataCell(r.getCell(7), { fmt: '#,##0', zebra: z });
    r.getCell(8).value = c.d15Sales; styleDataCell(r.getCell(8), { fmt: '$#,##0.00', bold: true, zebra: z });
    r.getCell(9).value = c.d15Share; styleDataCell(r.getCell(9), { fmt: '0.0%', zebra: z });
    r.getCell(10).value = c.fbaTotal; styleDataCell(r.getCell(10), { fmt: '#,##0', zebra: z });
  });
  const cohTot = ws1.getRow(17);
  cohTot.getCell(1).value = '全盘总计';
  cohTot.getCell(2).value = meta.modelsCount;
  cohTot.getCell(3).value = meta.skusCount;
  cohTot.getCell(4).value = summary.totalUnits;
  cohTot.getCell(5).value = summary.totalSales;
  cohTot.getCell(6).value = 1;
  cohTot.getCell(7).value = periods.d15.units;
  cohTot.getCell(8).value = periods.d15.sales;
  cohTot.getCell(9).value = 1;
  cohTot.getCell(10).value = inventorySummary.fbaTotal;
  styleTotalRow(cohTot, 10);
  cohTot.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };
  cohTot.getCell(3).alignment = { vertical: 'middle', horizontal: 'center' };
  cohTot.getCell(4).numFmt = '#,##0';
  cohTot.getCell(5).numFmt = '$#,##0.00';
  cohTot.getCell(6).numFmt = '0.0%';
  cohTot.getCell(7).numFmt = '#,##0';
  cohTot.getCell(8).numFmt = '$#,##0.00';
  cohTot.getCell(9).numFmt = '0.0%';
  cohTot.getCell(10).numFmt = '#,##0';

  // Section III: Monthly Trend
  styleSectionBanner(ws1, 19, '三、月度销售与日均增速趋势（2026-08 至 2026-11）', 10);
  setHeaderRow(ws1, 20, ['月份', '统计天数', '活跃SKU数', '月销量(件)', '月订单量', '月销售额($)', '日均销量(件)', '日均销售额($)', '客单价 ASP($)', '日均销售额环比']);
  monthly.forEach((m, idx) => {
    const r = ws1.getRow(21 + idx);
    r.height = 20;
    const z = idx % 2 === 1;
    r.getCell(1).value = m.month; styleDataCell(r.getCell(1), { align: 'center', bold: true, zebra: z });
    r.getCell(2).value = m.days; styleDataCell(r.getCell(2), { fmt: '#,##0', align: 'center', zebra: z });
    r.getCell(3).value = m.activeSkus; styleDataCell(r.getCell(3), { fmt: '#,##0', align: 'center', zebra: z });
    r.getCell(4).value = m.units; styleDataCell(r.getCell(4), { fmt: '#,##0', zebra: z });
    r.getCell(5).value = m.orders; styleDataCell(r.getCell(5), { fmt: '#,##0', zebra: z });
    r.getCell(6).value = m.sales; styleDataCell(r.getCell(6), { fmt: '$#,##0.00', bold: true, zebra: z });
    r.getCell(7).value = m.dailyAvgUnits; styleDataCell(r.getCell(7), { fmt: '0.00', zebra: z });
    r.getCell(8).value = m.dailyAvgSales; styleDataCell(r.getCell(8), { fmt: '$#,##0.00', bold: true, zebra: z });
    r.getCell(9).value = m.asp; styleDataCell(r.getCell(9), { fmt: '$#,##0.00', zebra: z });
    r.getCell(10).value = m.qoqDailySalesPct === null ? '—' : m.qoqDailySalesPct;
    if (m.qoqDailySalesPct !== null) {
      styleBadge(r.getCell(10), m.qoqDailySalesPct >= 0.1 ? 'green' : (m.qoqDailySalesPct < 0 ? 'red' : 'blue'));
      r.getCell(10).numFmt = '+0.0%;-0.0%;0.0%';
    } else {
      styleDataCell(r.getCell(10), { align: 'center', zebra: z });
    }
  });
  const monthStartRow = 21;
  const monthEndRow = 20 + monthly.length;

  // Section IV: Weekly Trend
  const wkBannerRow = monthEndRow + 2;
  styleSectionBanner(ws1, wkBannerRow, '四、周度滚动趋势（7天为一周，锚定最新日期 2026-11-25 倒推）', 10);
  const wkHdrRow = wkBannerRow + 1;
  setHeaderRow(ws1, wkHdrRow, ['周次区间', '天数', '周销量(件)', '周订单量', '周销售额($)', '老品销售额($)', '新品销售额($)', '日均销售额($)', 'ASP($)', '周日均环比']);
  const wkDataStart = wkHdrRow + 1;
  weekly.forEach((w, idx) => {
    const r = ws1.getRow(wkDataStart + idx);
    r.height = 19;
    const z = idx % 2 === 1;
    r.getCell(1).value = w.weekLabel; styleDataCell(r.getCell(1), { align: 'left', bold: idx === weekly.length - 1, zebra: z });
    r.getCell(2).value = w.days; styleDataCell(r.getCell(2), { fmt: '#,##0', align: 'center', zebra: z });
    r.getCell(3).value = w.units; styleDataCell(r.getCell(3), { fmt: '#,##0', zebra: z });
    r.getCell(4).value = w.orders; styleDataCell(r.getCell(4), { fmt: '#,##0', zebra: z });
    r.getCell(5).value = w.sales; styleDataCell(r.getCell(5), { fmt: '$#,##0.00', bold: true, zebra: z });
    r.getCell(6).value = w.legacySales; styleDataCell(r.getCell(6), { fmt: '$#,##0.00', zebra: z });
    r.getCell(7).value = w.newSales; styleDataCell(r.getCell(7), { fmt: '$#,##0.00', zebra: z });
    r.getCell(8).value = w.dailyAvgSales; styleDataCell(r.getCell(8), { fmt: '$#,##0.00', zebra: z });
    r.getCell(9).value = w.asp; styleDataCell(r.getCell(9), { fmt: '$#,##0.00', zebra: z });
    r.getCell(10).value = w.qoqSalesPct === null ? '—' : w.qoqSalesPct;
    if (w.qoqSalesPct !== null) {
      styleBadge(r.getCell(10), w.qoqSalesPct >= 0.05 ? 'green' : (w.qoqSalesPct <= -0.10 ? 'red' : 'gray'));
      r.getCell(10).numFmt = '+0.0%;-0.0%;0.0%';
    } else {
      styleDataCell(r.getCell(10), { align: 'center', zebra: z });
    }
  });
  const wkDataEnd = wkDataStart + weekly.length - 1;
  ws1.columns = [
    { width: 22 }, { width: 23 }, { width: 10 }, { width: 11 }, { width: 13 },
    { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 },
  ];

  // =========================================================================
  // SHEET 2: 2_分机型周期对比与新品追踪
  // =========================================================================
  const ws2 = wb.addWorksheet('2_分机型周期对比与新品追踪', { views: [{ showGridLines: true, state: 'frozen', xSplit: 2, ySplit: 4 }] });
  styleTitle(
    ws2,
    'UPBestKS 分机型 15天/7天周期对比与 11月新品追踪（共 14 款机型）',
    '口径：近15天(11.11-11.25) vs 前15天(10.27-11.10)；近7天(11.19-11.25) vs 前7天(11.12-11.18)；估算总周转天 = FBA总库存 ÷ 近15天日均销量',
    20
  );
  styleSectionBanner(ws2, 3, '一、14 款手机壳机型全周期销售贡献、环比动销与 FBA 库存周转诊断', 20);
  setHeaderRow(ws2, 4, [
    '机型代码', '梯队分类', 'SKU数', '首单日期', '全周期销量', '全周期销售额($)', '销售额占比', 'ASP($)',
    '前15天销售额($)', '近15天销售额($)', '15天环比', '前7天销售额($)', '近7天销售额($)', '7天环比',
    'FBA可售', 'FBA预留', 'FBA在途', 'FBA总库存', '近15天预估总周转(天)', '动销评级'
  ]);
  models.forEach((m, idx) => {
    const r = ws2.getRow(5 + idx);
    r.height = 21;
    const z = idx % 2 === 1;
    r.getCell(1).value = m.model; styleDataCell(r.getCell(1), { align: 'left', bold: true, zebra: z });
    r.getCell(2).value = m.cohort; styleBadge(r.getCell(2), m.cohort === '老品主力' ? 'blue' : 'purple');
    r.getCell(3).value = m.skusCount; styleDataCell(r.getCell(3), { fmt: '#,##0', align: 'center', zebra: z });
    r.getCell(4).value = m.firstSaleDate; styleDataCell(r.getCell(4), { align: 'center', zebra: z });
    r.getCell(5).value = m.units; styleDataCell(r.getCell(5), { fmt: '#,##0', bold: true, zebra: z });
    r.getCell(6).value = m.sales; styleDataCell(r.getCell(6), { fmt: '$#,##0.00', bold: true, zebra: z });
    r.getCell(7).value = m.salesShare; styleDataCell(r.getCell(7), { fmt: '0.0%', zebra: z });
    r.getCell(8).value = m.asp; styleDataCell(r.getCell(8), { fmt: '$#,##0.00', zebra: z });
    r.getCell(9).value = m.prev15Sales; styleDataCell(r.getCell(9), { fmt: '$#,##0.00', zebra: z });
    r.getCell(10).value = m.d15Sales; styleDataCell(r.getCell(10), { fmt: '$#,##0.00', bold: true, zebra: z });
    r.getCell(11).value = m.d15SalesPct === null ? '新品无基期' : m.d15SalesPct;
    if (m.d15SalesPct !== null) {
      styleBadge(r.getCell(11), m.d15SalesPct >= 0.1 ? 'green' : (m.d15SalesPct <= -0.1 ? 'red' : 'gray'));
      r.getCell(11).numFmt = '+0.0%;-0.0%;0.0%';
    } else {
      styleBadge(r.getCell(11), 'purple');
    }
    r.getCell(12).value = m.prev7Sales; styleDataCell(r.getCell(12), { fmt: '$#,##0.00', zebra: z });
    r.getCell(13).value = m.d7Sales; styleDataCell(r.getCell(13), { fmt: '$#,##0.00', bold: true, zebra: z });
    r.getCell(14).value = m.d7SalesPct === null ? '—' : m.d7SalesPct;
    if (m.d7SalesPct !== null) {
      styleBadge(r.getCell(14), m.d7SalesPct >= 0.1 ? 'green' : (m.d7SalesPct <= -0.15 ? 'red' : 'gray'));
      r.getCell(14).numFmt = '+0.0%;-0.0%;0.0%';
    } else {
      styleDataCell(r.getCell(14), { align: 'center', zebra: z });
    }
    r.getCell(15).value = m.fbaSellable; styleDataCell(r.getCell(15), { fmt: '#,##0', zebra: z });
    r.getCell(16).value = m.fbaReserved; styleDataCell(r.getCell(16), { fmt: '#,##0', zebra: z });
    r.getCell(17).value = m.fbaTransit; styleDataCell(r.getCell(17), { fmt: '#,##0', zebra: z });
    r.getCell(18).value = m.fbaTotal; styleDataCell(r.getCell(18), { fmt: '#,##0', bold: true, zebra: z });
    r.getCell(19).value = m.estTotalDos >= 999 ? '极慢' : m.estTotalDos;
    if (m.estTotalDos < 999) {
      styleBadge(r.getCell(19), m.estTotalDos < 45 ? 'amber' : (m.estTotalDos > 180 ? 'purple' : 'green'));
      r.getCell(19).numFmt = '0.0';
    } else {
      styleBadge(r.getCell(19), 'red');
    }
    r.getCell(20).value = m.grade;
    styleBadge(r.getCell(20), m.grade.includes('黑马') || m.grade.includes('加速') ? 'green' : (m.grade.includes('回落') ? 'amber' : 'blue'));
  });
  const mEndRow = 4 + models.length;
  const mTot = ws2.getRow(mEndRow + 1);
  mTot.getCell(1).value = '全机型总计';
  mTot.getCell(2).value = '14款';
  mTot.getCell(3).value = meta.skusCount;
  mTot.getCell(4).value = meta.earliestDate;
  mTot.getCell(5).value = summary.totalUnits;
  mTot.getCell(6).value = summary.totalSales;
  mTot.getCell(7).value = 1;
  mTot.getCell(8).value = summary.asp;
  mTot.getCell(9).value = periods.prev15.sales;
  mTot.getCell(10).value = periods.d15.sales;
  mTot.getCell(11).value = periods.prev15.sales > 0 ? (periods.d15.sales - periods.prev15.sales) / periods.prev15.sales : 0;
  mTot.getCell(12).value = periods.prev7.sales;
  mTot.getCell(13).value = periods.d7.sales;
  mTot.getCell(14).value = periods.prev7.sales > 0 ? (periods.d7.sales - periods.prev7.sales) / periods.prev7.sales : 0;
  mTot.getCell(15).value = inventorySummary.fbaSellable;
  mTot.getCell(16).value = inventorySummary.fbaReserved;
  mTot.getCell(17).value = inventorySummary.fbaTransit;
  mTot.getCell(18).value = inventorySummary.fbaTotal;
  mTot.getCell(19).value = inventorySummary.d15EstTotalDays;
  mTot.getCell(20).value = '全盘健康';
  styleTotalRow(mTot, 20);
  [3, 5, 15, 16, 17, 18].forEach(c => { mTot.getCell(c).numFmt = '#,##0'; });
  [6, 8, 9, 10, 12, 13].forEach(c => { mTot.getCell(c).numFmt = '$#,##0.00'; });
  [7, 11, 14].forEach(c => { mTot.getCell(c).numFmt = '+0.0%;-0.0%;0.0%'; });
  mTot.getCell(7).numFmt = '0.0%';
  mTot.getCell(19).numFmt = '0.0';
  mTot.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };
  mTot.getCell(4).alignment = { vertical: 'middle', horizontal: 'center' };
  mTot.getCell(20).alignment = { vertical: 'middle', horizontal: 'center' };

  ws2.autoFilter = { from: { row: 4, column: 1 }, to: { row: mEndRow, column: 20 } };
  ws2.columns = [
    { width: 24 }, { width: 12 }, { width: 8 }, { width: 12 }, { width: 11 }, { width: 14 }, { width: 11 }, { width: 10 },
    { width: 14 }, { width: 14 }, { width: 12 }, { width: 13 }, { width: 13 }, { width: 11 },
    { width: 10 }, { width: 10 }, { width: 10 }, { width: 11 }, { width: 16 }, { width: 15 },
  ];

  // =========================================================================
  // SHEET 3: 3_分颜色结构与机型矩阵
  // =========================================================================
  const ws3 = wb.addWorksheet('3_分颜色结构与机型矩阵', { views: [{ showGridLines: true, state: 'frozen', xSplit: 1, ySplit: 4 }] });
  styleTitle(
    ws3,
    'UPBestKS 8 大颜色销量结构 & 14机型×8颜色 交叉热力透视矩阵',
    '识别全店色彩集中度（黑/蓝/酒红/深紫占约 67%）与各机型颜色备货失衡（玫瑰金/橙色滞销积压）',
    14
  );
  styleSectionBanner(ws3, 3, '一、8 大颜色全周期销售表现与 FBA 库存配比汇总', 14);
  setHeaderRow(ws3, 4, ['颜色(EN)', '颜色(中文)', '在售SKU数', '全周期销量', '销量占比', '全周期销售额($)', '销售额占比', 'ASP($)', '近15天销量', '近7天销量', 'FBA可售', 'FBA在途', 'FBA总库存', '备货建议']);
  colors.forEach((c, idx) => {
    const r = ws3.getRow(5 + idx);
    r.height = 20;
    const z = idx % 2 === 1;
    r.getCell(1).value = c.color; styleDataCell(r.getCell(1), { align: 'left', bold: true, zebra: z });
    r.getCell(2).value = c.colorCn; styleDataCell(r.getCell(2), { align: 'center', zebra: z });
    r.getCell(3).value = c.skusCount; styleDataCell(r.getCell(3), { fmt: '#,##0', align: 'center', zebra: z });
    r.getCell(4).value = c.units; styleDataCell(r.getCell(4), { fmt: '#,##0', bold: true, zebra: z });
    r.getCell(5).value = c.unitsShare; styleDataCell(r.getCell(5), { fmt: '0.0%', zebra: z });
    r.getCell(6).value = c.sales; styleDataCell(r.getCell(6), { fmt: '$#,##0.00', bold: true, zebra: z });
    r.getCell(7).value = c.salesShare; styleDataCell(r.getCell(7), { fmt: '0.0%', zebra: z });
    r.getCell(8).value = c.asp; styleDataCell(r.getCell(8), { fmt: '$#,##0.00', zebra: z });
    r.getCell(9).value = c.d15Units; styleDataCell(r.getCell(9), { fmt: '#,##0', zebra: z });
    r.getCell(10).value = c.d7Units; styleDataCell(r.getCell(10), { fmt: '#,##0', zebra: z });
    r.getCell(11).value = c.fbaSellable; styleDataCell(r.getCell(11), { fmt: '#,##0', zebra: z });
    r.getCell(12).value = c.fbaTransit; styleDataCell(r.getCell(12), { fmt: '#,##0', zebra: z });
    r.getCell(13).value = c.fbaTotal; styleDataCell(r.getCell(13), { fmt: '#,##0', bold: true, zebra: z });
    r.getCell(14).value = c.advice;
    styleBadge(r.getCell(14), c.advice.includes('核心') ? 'green' : (c.advice.includes('积压') ? 'red' : 'blue'));
    r.getCell(14).alignment = { vertical: 'middle', horizontal: 'left' };
  });
  const cEndRow = 4 + colors.length; // 12
  const cTot = ws3.getRow(cEndRow + 1); // 13
  cTot.getCell(1).value = '全色总计';
  cTot.getCell(2).value = '8色';
  cTot.getCell(3).value = meta.skusCount;
  cTot.getCell(4).value = summary.totalUnits;
  cTot.getCell(5).value = 1;
  cTot.getCell(6).value = summary.totalSales;
  cTot.getCell(7).value = 1;
  cTot.getCell(8).value = summary.asp;
  cTot.getCell(9).value = periods.d15.units;
  cTot.getCell(10).value = periods.d7.units;
  cTot.getCell(11).value = inventorySummary.fbaSellable;
  cTot.getCell(12).value = inventorySummary.fbaTransit;
  cTot.getCell(13).value = inventorySummary.fbaTotal;
  cTot.getCell(14).value = '前4色贡献超67%销量';
  styleTotalRow(cTot, 14);
  [3, 4, 9, 10, 11, 12, 13].forEach(col => { cTot.getCell(col).numFmt = '#,##0'; });
  [6, 8].forEach(col => { cTot.getCell(col).numFmt = '$#,##0.00'; });
  [5, 7].forEach(col => { cTot.getCell(col).numFmt = '0.0%'; });

  // Table B: 14x8 Units Heat Matrix
  const mat1Banner = 15;
  styleSectionBanner(ws3, mat1Banner, '二、14机型 × 8颜色 全周期销量热力交叉矩阵（单位：件）', 11);
  setHeaderRow(ws3, mat1Banner + 1, ['机型代码', '梯队', ...COLOR_ORDER.map(c => `${c}\n(${colors.find(x => x.color === c)?.colorCn || c})`), '机型小计']);
  ws3.getRow(mat1Banner + 1).height = 30;
  const maxUnitCell = Math.max(...skus.map(s => s.totalUnits), 1);
  matrix.forEach((mRow, idx) => {
    const r = ws3.getRow(mat1Banner + 2 + idx);
    r.height = 20;
    r.getCell(1).value = mRow.model; styleDataCell(r.getCell(1), { align: 'left', bold: true });
    r.getCell(2).value = mRow.cohort; styleBadge(r.getCell(2), mRow.cohort === '老品主力' ? 'blue' : 'purple');
    let rowSum = 0;
    COLOR_ORDER.forEach((c, ci) => {
      const cellData = mRow.cells[c];
      const cell = r.getCell(3 + ci);
      if (!cellData) {
        cell.value = '—';
        styleDataCell(cell, { align: 'center', color: '94A3B8' });
      } else {
        rowSum += cellData.units;
        cell.value = cellData.units;
        const { bg, txt } = heatBg(cellData.units, maxUnitCell);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
        cell.font = { name: FONT_NAME, size: 9.5, bold: cellData.units >= 30, color: { argb: txt } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
        cell.border = thinBorder;
        cell.numFmt = '#,##0';
      }
    });
    r.getCell(11).value = rowSum; styleDataCell(r.getCell(11), { fmt: '#,##0', bold: true, zebra: true });
  });
  const mat1TotRow = ws3.getRow(mat1Banner + 2 + matrix.length);
  mat1TotRow.getCell(1).value = '颜色合计';
  mat1TotRow.getCell(2).value = '全站';
  COLOR_ORDER.forEach((c, ci) => {
    const cObj = colors.find(x => x.color === c);
    mat1TotRow.getCell(3 + ci).value = cObj ? cObj.units : 0;
    mat1TotRow.getCell(3 + ci).numFmt = '#,##0';
    mat1TotRow.getCell(3 + ci).alignment = { vertical: 'middle', horizontal: 'center' };
  });
  mat1TotRow.getCell(11).value = summary.totalUnits;
  mat1TotRow.getCell(11).numFmt = '#,##0';
  styleTotalRow(mat1TotRow, 11);

  // Table C: 14x8 Sales Matrix
  const mat2Banner = mat1Banner + 2 + matrix.length + 2;
  styleSectionBanner(ws3, mat2Banner, '三、14机型 × 8颜色 全周期销售额交叉矩阵（单位：USD）', 11);
  setHeaderRow(ws3, mat2Banner + 1, ['机型代码', '梯队', ...COLOR_ORDER.map(c => `${c}\n(${colors.find(x => x.color === c)?.colorCn || c})`), '机型小计($)']);
  ws3.getRow(mat2Banner + 1).height = 30;
  const maxSaleCell = Math.max(...skus.map(s => s.totalSales), 1);
  matrix.forEach((mRow, idx) => {
    const r = ws3.getRow(mat2Banner + 2 + idx);
    r.height = 20;
    r.getCell(1).value = mRow.model; styleDataCell(r.getCell(1), { align: 'left', bold: true });
    r.getCell(2).value = mRow.cohort; styleBadge(r.getCell(2), mRow.cohort === '老品主力' ? 'blue' : 'purple');
    let rowSum = 0;
    COLOR_ORDER.forEach((c, ci) => {
      const cellData = mRow.cells[c];
      const cell = r.getCell(3 + ci);
      if (!cellData) {
        cell.value = '—';
        styleDataCell(cell, { align: 'center', color: '94A3B8' });
      } else {
        rowSum += cellData.sales;
        cell.value = cellData.sales;
        const { bg, txt } = heatBg(cellData.sales, maxSaleCell, 'DCFCE7', '86EFAC', '15803D');
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
        cell.font = { name: FONT_NAME, size: 9, bold: cellData.sales >= 500, color: { argb: txt } };
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
        cell.border = thinBorder;
        cell.numFmt = '$#,##0.00';
      }
    });
    r.getCell(11).value = round2(rowSum); styleDataCell(r.getCell(11), { fmt: '$#,##0.00', bold: true, zebra: true });
  });
  const mat2TotRow = ws3.getRow(mat2Banner + 2 + matrix.length);
  mat2TotRow.getCell(1).value = '颜色合计($)';
  mat2TotRow.getCell(2).value = '全站';
  COLOR_ORDER.forEach((c, ci) => {
    const cObj = colors.find(x => x.color === c);
    mat2TotRow.getCell(3 + ci).value = cObj ? cObj.sales : 0;
    mat2TotRow.getCell(3 + ci).numFmt = '$#,##0.00';
  });
  mat2TotRow.getCell(11).value = summary.totalSales;
  mat2TotRow.getCell(11).numFmt = '$#,##0.00';
  styleTotalRow(mat2TotRow, 11);

  ws3.columns = [
    { width: 22 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 12 },
    { width: 12 }, { width: 12 }, { width: 12 }, { width: 13 }, { width: 11 }, { width: 12 }, { width: 32 },
  ];

  // =========================================================================
  // SHEET 4: 4_FBA库存健康与补货预警
  // =========================================================================
  const ws4 = wb.addWorksheet('4_FBA库存健康与补货预警', { views: [{ showGridLines: true, state: 'frozen', xSplit: 1, ySplit: 4 }] });
  styleTitle(
    ws4,
    'UPBestKS FBA 库存健康分层与 108 SKU 断货/积压预警明细',
    `全盘总库存 ${inventorySummary.fbaTotal} 件（可售 ${inventorySummary.fbaSellable} / 预留 ${inventorySummary.fbaReserved} / 在途 ${inventorySummary.fbaTransit}）| <15天断货高危 ${inventorySummary.criticalDosCount} 个 SKU | >180天积压 ${inventorySummary.overstockCount} 个 SKU`,
    15
  );
  styleSectionBanner(ws4, 3, '一、FBA 可售天数 (DOS) 5档健康分层总览', 9);
  setHeaderRow(ws4, 4, ['库存健康分层', 'SKU数量', 'FBA可售', 'FBA在途', 'FBA总库存', '总库存占比', '全周期销量', '全周期销售额($)', '销售额占比']);
  invBuckets.forEach((b, idx) => {
    const r = ws4.getRow(5 + idx);
    r.height = 20;
    const z = idx % 2 === 1;
    r.getCell(1).value = b.key; styleBadge(r.getCell(1), b.tone); r.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
    r.getCell(2).value = b.skusCount; styleDataCell(r.getCell(2), { fmt: '#,##0', align: 'center', zebra: z });
    r.getCell(3).value = b.fbaSellable; styleDataCell(r.getCell(3), { fmt: '#,##0', zebra: z });
    r.getCell(4).value = b.fbaTransit; styleDataCell(r.getCell(4), { fmt: '#,##0', zebra: z });
    r.getCell(5).value = b.fbaTotal; styleDataCell(r.getCell(5), { fmt: '#,##0', bold: true, zebra: z });
    r.getCell(6).value = b.fbaShare; styleDataCell(r.getCell(6), { fmt: '0.0%', zebra: z });
    r.getCell(7).value = b.units; styleDataCell(r.getCell(7), { fmt: '#,##0', zebra: z });
    r.getCell(8).value = b.sales; styleDataCell(r.getCell(8), { fmt: '$#,##0.00', bold: true, zebra: z });
    r.getCell(9).value = b.salesShare; styleDataCell(r.getCell(9), { fmt: '0.0%', zebra: z });
  });
  const bTot = ws4.getRow(10);
  bTot.getCell(1).value = '全盘总计';
  bTot.getCell(2).value = meta.skusCount;
  bTot.getCell(3).value = inventorySummary.fbaSellable;
  bTot.getCell(4).value = inventorySummary.fbaTransit;
  bTot.getCell(5).value = inventorySummary.fbaTotal;
  bTot.getCell(6).value = 1;
  bTot.getCell(7).value = summary.totalUnits;
  bTot.getCell(8).value = summary.totalSales;
  bTot.getCell(9).value = 1;
  styleTotalRow(bTot, 9);
  [2, 3, 4, 5, 7].forEach(c => { bTot.getCell(c).numFmt = '#,##0'; });
  bTot.getCell(8).numFmt = '$#,##0.00';
  [6, 9].forEach(c => { bTot.getCell(c).numFmt = '0.0%'; });

  // Table B starts at row 20 (leaving rows 3..18 cols 10..15 clear for Chart 6!)
  const invTblStart = 20;
  styleSectionBanner(ws4, invTblStart - 1, '二、全量 108 SKU 库存健康预警清单（按 FBA 可售天数升序排列，断货高危置顶）', 15);
  setHeaderRow(ws4, invTblStart, [
    'MSKU', '机型', '颜色', '梯队', 'ASIN', 'FBA可售天数(DOS)', '库存健康状态',
    '近7天日均(件)', '近15天日均(件)', 'FBA可售', 'FBA预留', 'FBA在途', 'FBA总库存', '含在途可售(天)', '补货与清理建议'
  ]);
  const skusByDos = [...skus].sort((a, b) => a.dos - b.dos);
  skusByDos.forEach((s, idx) => {
    const r = ws4.getRow(invTblStart + 1 + idx);
    r.height = 19;
    const z = idx % 2 === 1;
    r.getCell(1).value = s.msku; styleDataCell(r.getCell(1), { align: 'left', bold: s.dos < 21, zebra: z });
    r.getCell(2).value = s.model; styleDataCell(r.getCell(2), { align: 'left', zebra: z });
    r.getCell(3).value = `${s.color} (${s.colorCn})`; styleDataCell(r.getCell(3), { align: 'center', zebra: z });
    r.getCell(4).value = s.cohort; styleBadge(r.getCell(4), s.cohort === '老品主力' ? 'blue' : 'purple');
    r.getCell(5).value = s.asin; styleDataCell(r.getCell(5), { align: 'center', zebra: z });
    r.getCell(6).value = s.dos; styleDataCell(r.getCell(6), { fmt: '0.0', bold: true, zebra: z });
    r.getCell(7).value = s.invStatus; styleBadge(r.getCell(7), s.invTone);
    r.getCell(8).value = s.d7Avg; styleDataCell(r.getCell(8), { fmt: '0.00', zebra: z });
    r.getCell(9).value = s.d15Avg; styleDataCell(r.getCell(9), { fmt: '0.00', zebra: z });
    r.getCell(10).value = s.fbaSellable; styleDataCell(r.getCell(10), { fmt: '#,##0', zebra: z });
    r.getCell(11).value = s.fbaReserved; styleDataCell(r.getCell(11), { fmt: '#,##0', zebra: z });
    r.getCell(12).value = s.fbaTransit; styleDataCell(r.getCell(12), { fmt: '#,##0', zebra: z });
    r.getCell(13).value = s.fbaTotal; styleDataCell(r.getCell(13), { fmt: '#,##0', bold: true, zebra: z });
    r.getCell(14).value = s.estTotalDos >= 999 ? '极慢' : s.estTotalDos;
    styleDataCell(r.getCell(14), { fmt: s.estTotalDos >= 999 ? undefined : '0.0', align: s.estTotalDos >= 999 ? 'center' : 'right', zebra: z });
    r.getCell(15).value = s.advice; styleDataCell(r.getCell(15), { align: 'left', zebra: z });
  });
  ws4.columns = [
    { width: 34 }, { width: 21 }, { width: 17 }, { width: 11 }, { width: 13 }, { width: 16 }, { width: 18 },
    { width: 13 }, { width: 14 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 11 }, { width: 13 }, { width: 42 },
  ];

  // =========================================================================
  // SHEET 5: 5_全量108SKU销售明细
  // =========================================================================
  const ws5 = wb.addWorksheet('5_全量108SKU销售明细', { views: [{ showGridLines: true, state: 'frozen', xSplit: 1, ySplit: 4 }] });
  styleTitle(
    ws5,
    'UPBestKS 全量 108 SKU 销售贡献、ABC 帕累托分级与多周期明细表',
    `按全周期销售额降序排列 | A类核心(前80%销售额): ${summary.abcACount}个 SKU | B类中坚(80-95%): ${summary.abcBCount}个 SKU | C类长尾(后5%): ${summary.abcCCount}个 SKU`,
    21
  );
  styleSectionBanner(ws5, 3, '全量 SKU 销售表现与库存台账（支持筛选排序）', 21);
  setHeaderRow(ws5, 4, [
    '排名', 'MSKU', '父ASIN', 'ASIN', '机型', '颜色', '梯队', 'ABC分级', '首单日期',
    '全周期销量', '全周期订单', '全周期销售额($)', '销售占比', '累计占比', 'ASP($)',
    '前15天销量', '近15天销量', '近15天销售额($)', '近7天销量', '近7天销售额($)', 'FBA总库存'
  ]);
  skus.forEach((s, idx) => {
    const r = ws5.getRow(5 + idx);
    r.height = 19;
    const z = idx % 2 === 1;
    r.getCell(1).value = s.rank; styleDataCell(r.getCell(1), { fmt: '#,##0', align: 'center', zebra: z });
    r.getCell(2).value = s.msku; styleDataCell(r.getCell(2), { align: 'left', bold: s.abcClass === 'A类核心', zebra: z });
    r.getCell(3).value = s.parentAsin; styleDataCell(r.getCell(3), { align: 'center', zebra: z });
    r.getCell(4).value = s.asin; styleDataCell(r.getCell(4), { align: 'center', zebra: z });
    r.getCell(5).value = s.model; styleDataCell(r.getCell(5), { align: 'left', zebra: z });
    r.getCell(6).value = `${s.color} (${s.colorCn})`; styleDataCell(r.getCell(6), { align: 'center', zebra: z });
    r.getCell(7).value = s.cohort; styleBadge(r.getCell(7), s.cohort === '老品主力' ? 'blue' : 'purple');
    r.getCell(8).value = s.abcClass; styleBadge(r.getCell(8), s.abcClass === 'A类核心' ? 'green' : (s.abcClass === 'B类中坚' ? 'amber' : 'gray'));
    r.getCell(9).value = s.firstSaleDate || '—'; styleDataCell(r.getCell(9), { align: 'center', zebra: z });
    r.getCell(10).value = s.totalUnits; styleDataCell(r.getCell(10), { fmt: '#,##0', bold: true, zebra: z });
    r.getCell(11).value = s.totalOrders; styleDataCell(r.getCell(11), { fmt: '#,##0', zebra: z });
    r.getCell(12).value = s.totalSales; styleDataCell(r.getCell(12), { fmt: '$#,##0.00', bold: true, zebra: z });
    r.getCell(13).value = s.salesShare; styleDataCell(r.getCell(13), { fmt: '0.0%', zebra: z });
    r.getCell(14).value = s.cumSalesShare; styleDataCell(r.getCell(14), { fmt: '0.0%', zebra: z });
    r.getCell(15).value = s.asp; styleDataCell(r.getCell(15), { fmt: '$#,##0.00', zebra: z });
    r.getCell(16).value = s.prev15Units; styleDataCell(r.getCell(16), { fmt: '#,##0', zebra: z });
    r.getCell(17).value = s.d15Units; styleDataCell(r.getCell(17), { fmt: '#,##0', bold: true, zebra: z });
    r.getCell(18).value = s.d15Sales; styleDataCell(r.getCell(18), { fmt: '$#,##0.00', zebra: z });
    r.getCell(19).value = s.d7Units; styleDataCell(r.getCell(19), { fmt: '#,##0', zebra: z });
    r.getCell(20).value = s.d7Sales; styleDataCell(r.getCell(20), { fmt: '$#,##0.00', zebra: z });
    r.getCell(21).value = s.fbaTotal; styleDataCell(r.getCell(21), { fmt: '#,##0', zebra: z });
  });
  ws5.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + skus.length, column: 21 } };
  ws5.columns = [
    { width: 7 }, { width: 34 }, { width: 13 }, { width: 13 }, { width: 21 }, { width: 17 }, { width: 11 }, { width: 11 }, { width: 12 },
    { width: 11 }, { width: 11 }, { width: 14 }, { width: 10 }, { width: 10 }, { width: 10 },
    { width: 11 }, { width: 11 }, { width: 14 }, { width: 11 }, { width: 14 }, { width: 11 },
  ];

  // =========================================================================
  // SHEET 6: 6_每日销售趋势明细(104天)
  // =========================================================================
  const ws6 = wb.addWorksheet('6_每日销售趋势明细', { views: [{ showGridLines: true, state: 'frozen', ySplit: 4 }] });
  styleTitle(
    ws6,
    `UPBestKS 全站每日销售与新老品拆分明细（${meta.earliestDate} ~ ${meta.latestDate}，共 ${daily.length} 天）`,
    '含每日销量、订单量、销售额、ASP、7日移动均线（MA7）及老品主力 vs 11月新品每日销售额拆解',
    12
  );
  styleSectionBanner(ws6, 3, '全站逐日销售时间序列明细（按最新日期倒序排列）', 12);
  setHeaderRow(ws6, 4, ['日期', '星期', '销量(件)', '订单量', '销售额($)', 'ASP($)', '活跃SKU数', '7日均销量', '7日均销售额($)', '老品销售额($)', '新品销售额($)', '新品销售占比']);
  const dailyDesc = [...daily].reverse();
  dailyDesc.forEach((d, idx) => {
    const r = ws6.getRow(5 + idx);
    r.height = 19;
    const z = idx % 2 === 1;
    r.getCell(1).value = d.date; styleDataCell(r.getCell(1), { align: 'center', bold: true, zebra: z });
    r.getCell(2).value = d.weekday; styleDataCell(r.getCell(2), { align: 'center', zebra: z });
    r.getCell(3).value = d.units; styleDataCell(r.getCell(3), { fmt: '#,##0', bold: true, zebra: z });
    r.getCell(4).value = d.orders; styleDataCell(r.getCell(4), { fmt: '#,##0', zebra: z });
    r.getCell(5).value = d.sales; styleDataCell(r.getCell(5), { fmt: '$#,##0.00', bold: true, zebra: z });
    r.getCell(6).value = d.asp; styleDataCell(r.getCell(6), { fmt: '$#,##0.00', zebra: z });
    r.getCell(7).value = d.activeSkus; styleDataCell(r.getCell(7), { fmt: '#,##0', align: 'center', zebra: z });
    r.getCell(8).value = d.ma7Units; styleDataCell(r.getCell(8), { fmt: '0.00', zebra: z });
    r.getCell(9).value = d.ma7Sales; styleDataCell(r.getCell(9), { fmt: '$#,##0.00', zebra: z });
    r.getCell(10).value = d.legacySales; styleDataCell(r.getCell(10), { fmt: '$#,##0.00', zebra: z });
    r.getCell(11).value = d.newSales; styleDataCell(r.getCell(11), { fmt: '$#,##0.00', zebra: z });
    r.getCell(12).value = d.sales > 0 ? d.newSales / d.sales : 0; styleDataCell(r.getCell(12), { fmt: '0.0%', zebra: z });
  });
  ws6.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + dailyDesc.length, column: 12 } };
  ws6.columns = [
    { width: 13 }, { width: 8 }, { width: 10 }, { width: 10 }, { width: 13 }, { width: 10 },
    { width: 11 }, { width: 11 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 13 },
  ];

  // =========================================================================
  // SHEET 7: 7_赛狐ERP补货建议与采购跟踪
  // =========================================================================
  if (data.saihu) {
    const { summary: sSum, needPurchList, replenishPlanList = [], overdueList = [], purchInTransitList, localStockList, list: saihuAll } = data.saihu;
    const ws7 = wb.addWorksheet('7_赛狐ERP补货建议与采购跟踪', { views: [{ showGridLines: true, state: 'frozen', ySplit: 4 }] });

    styleTitle(
      ws7,
      'UPBestKS 赛狐 ERP 补货计划、采购超期预警与发货滞留跟踪表',
      `数据源：赛狐 ERP 136 款全量 ASIN · 补货计划 ${sSum.replenishPlanCount || replenishPlanList.length} 款 (${sSum.totalSuggestedReplenishUnits || 0}件) | 未采购 ${sSum.needPurchCount} 款 | 采购超期/滞留预警 ${sSum.overdueCount || overdueList.length} 款`,
      16
    );

    // Section 1: KPI Summary Banner
    styleSectionBanner(ws7, 3, '一、赛狐 ERP 补货计划与采购超期核心指标概览', 16, COLORS.navy);
    setHeaderRow(ws7, 4, [
      '指标类型', '诊断项数量/件数', '业务含义与操作指示', '', '', '', '', '', '', '', '', '', '', '', '', ''
    ], COLORS.indigo);
    ws7.mergeCells(4, 3, 4, 16);

    const kpiItems = [
      { k: '🚨 急需提前补货（未下采购单）', v: `${sSum.needPurchCount} 款 MSKU (${sSum.purchDueTodayCount || 0}款今日到期)`, d: '赛狐系统已产生采购建议，但采购在途=0且采购计划=0，FBA即将断货，需立即向供应商下采购单', tone: 'red' },
      { k: '📋 全店补货计划（含备货周期）', v: `${sSum.replenishPlanCount || replenishPlanList.length} 款 (${sSum.totalSuggestedReplenishUnits || 0} 件)`, d: `建议补货汇总 ${sSum.totalSuggestedReplenishUnits || 0} 件 / 备货周期补货 ${sSum.totalSuggestedReplenishCycleUnits || 0} 件 / 建议采购汇总 ${sSum.totalSuggestedPurchUnits || 0} 件`, tone: 'purple' },
      { k: '⏰ 采购超期与发货滞留风险', v: `${sSum.overdueCount || overdueList.length} 款 (在途${sSum.totalPurchTransitUnits} / 本地${sSum.totalLocalStockUnits} / 待装${sSum.totalReadyToShipUnits || 0})`, d: '含：采购在途14款(排查>15天未交货)、本地仓滞留24款(503件未发FBA)、准备装运停滞4款(79件)、今日到期未下单4款', tone: 'amber' },
      { k: '🏬 本地仓库存滞留（待发 FBA）', v: `${sSum.localStockCount} 款 (${sSum.totalLocalStockUnits} 件)`, d: '货物已采购入库国内本地仓，但滞留未发往 FBA，需按补货计划中的海运/慢船/空运排期立即发运', tone: 'blue' },
    ];

    kpiItems.forEach((item, ki) => {
      const r = ws7.getRow(5 + ki);
      r.height = 20;
      r.getCell(1).value = item.k; styleBadge(r.getCell(1), item.tone);
      r.getCell(2).value = item.v; styleDataCell(r.getCell(2), { align: 'center', bold: true });
      ws7.mergeCells(5 + ki, 3, 5 + ki, 16);
      r.getCell(3).value = item.d; styleDataCell(r.getCell(3), { align: 'left' });
    });

    // Section 2: Table A - 需要提前补货还没进行采购的清单
    const s2Row = 10;
    styleSectionBanner(ws7, s2Row, `二、【红线警戒】需要提前补货但尚未进行采购的 SKU 清单（共 ${needPurchList.length} 款，按可售天数升序）`, 16, COLORS.redTxt);
    setHeaderRow(ws7, s2Row + 1, [
      '序号', 'MSKU', '品名', '动态日均销', 'FBA可售', '在库DOS(天)', '预估断货DOS', '赛狐预估断货日',
      '建议采购日', '首批建议量', '采购汇总量', '补货汇总量', '本地仓可用', 'FBA在途', '紧迫度评级', '建议运营行动'
    ], '991B1B');

    needPurchList.forEach((s, idx) => {
      const r = ws7.getRow(s2Row + 2 + idx);
      r.height = 20;
      const z = idx % 2 === 1;
      r.getCell(1).value = idx + 1; styleDataCell(r.getCell(1), { align: 'center', zebra: z });
      r.getCell(2).value = s.msku; styleDataCell(r.getCell(2), { align: 'left', bold: true, zebra: z });
      r.getCell(3).value = s.cnName; styleDataCell(r.getCell(3), { align: 'left', zebra: z });
      r.getCell(4).value = s.dailyAvg; styleDataCell(r.getCell(4), { fmt: '0.00', zebra: z });
      r.getCell(5).value = s.fbaSellable; styleDataCell(r.getCell(5), { fmt: '#,##0', zebra: z });
      r.getCell(6).value = s.dosInStock; styleDataCell(r.getCell(6), { fmt: '#,##0', bold: true, color: 'DC2626', zebra: z });
      r.getCell(7).value = s.dosEstBeforeOut; styleDataCell(r.getCell(7), { fmt: '#,##0', zebra: z });
      r.getCell(8).value = s.stockoutDate || '—'; styleDataCell(r.getCell(8), { align: 'center', zebra: z });
      r.getCell(9).value = s.suggestedPurchDate || '—'; styleDataCell(r.getCell(9), { align: 'center', bold: true, zebra: z });
      r.getCell(10).value = s.suggestedPurchB1; styleDataCell(r.getCell(10), { fmt: '#,##0', zebra: z });
      r.getCell(11).value = s.suggestedPurchTotal; styleDataCell(r.getCell(11), { fmt: '#,##0', bold: true, zebra: z });
      r.getCell(12).value = s.suggestedReplenishTotal; styleDataCell(r.getCell(12), { fmt: '#,##0', zebra: z });
      r.getCell(13).value = s.localAvail; styleDataCell(r.getCell(13), { fmt: '#,##0', zebra: z });
      r.getCell(14).value = s.fbaTransit; styleDataCell(r.getCell(14), { fmt: '#,##0', zebra: z });
      r.getCell(15).value = s.urgencyBadge; styleBadge(r.getCell(15), s.urgencyTone);
      r.getCell(16).value = s.dosInStock <= 15 ? `急需立即向供应商下采购单 ${s.suggestedPurchTotal || s.suggestedPurchB1} 件，防范断货` : `建议在 ${s.suggestedPurchDate ? s.suggestedPurchDate.slice(0, 15) : '近期'} 前完成采购审批`;
      styleDataCell(r.getCell(16), { align: 'left', zebra: z });
    });

    // Section 3: Table B - 全店补货计划明细表
    const sPlanRow = s2Row + 3 + needPurchList.length;
    styleSectionBanner(ws7, sPlanRow, `三、【补货计划】赛狐智能补货计划与发运排期明细（共 ${replenishPlanList.length} 款，含备货周期与到货后预测）`, 16, '5B21B6');
    setHeaderRow(ws7, sPlanRow + 1, [
      '序号', 'MSKU', '品名', '备货周期(天)', '安全天数', '销量预测', '在库DOS(天)', '建议补货汇总',
      '备货周期补货量', '建议采购汇总', '备货周期采购量', '第1批海运量', '第1批慢船量', '到货后可售', '建议采购日', '本地仓至FBA发货排期(海运/空运/慢船)'
    ], '4C1D95');

    replenishPlanList.forEach((s, idx) => {
      const r = ws7.getRow(sPlanRow + 2 + idx);
      r.height = 20;
      const z = idx % 2 === 1;
      r.getCell(1).value = idx + 1; styleDataCell(r.getCell(1), { align: 'center', zebra: z });
      r.getCell(2).value = s.msku; styleDataCell(r.getCell(2), { align: 'left', bold: true, zebra: z });
      r.getCell(3).value = s.cnName; styleDataCell(r.getCell(3), { align: 'left', zebra: z });
      r.getCell(4).value = s.leadCycle; styleDataCell(r.getCell(4), { fmt: '#,##0', align: 'center', zebra: z });
      r.getCell(5).value = s.safetyDays; styleDataCell(r.getCell(5), { fmt: '#,##0', align: 'center', zebra: z });
      r.getCell(6).value = s.salesForecast; styleDataCell(r.getCell(6), { fmt: '#,##0', zebra: z });
      r.getCell(7).value = s.dosInStock; styleDataCell(r.getCell(7), { fmt: '#,##0', bold: s.dosInStock <= 21, color: s.dosInStock <= 15 ? 'DC2626' : undefined, zebra: z });
      r.getCell(8).value = s.suggestedReplenishTotal; styleDataCell(r.getCell(8), { fmt: '#,##0', bold: true, zebra: z });
      r.getCell(9).value = s.suggestedReplenishCycle; styleDataCell(r.getCell(9), { fmt: '#,##0', zebra: z });
      r.getCell(10).value = s.suggestedPurchTotal; styleDataCell(r.getCell(10), { fmt: '#,##0', bold: s.suggestedPurchTotal > 0, zebra: z });
      r.getCell(11).value = s.suggestedPurchCycle; styleDataCell(r.getCell(11), { fmt: '#,##0', zebra: z });
      r.getCell(12).value = s.shipSeaB1Qty; styleDataCell(r.getCell(12), { fmt: '#,##0', zebra: z });
      r.getCell(13).value = s.shipSlowB1Qty; styleDataCell(r.getCell(13), { fmt: '#,##0', zebra: z });
      r.getCell(14).value = s.afterArrivalSellable; styleDataCell(r.getCell(14), { fmt: '#,##0', zebra: z });
      r.getCell(15).value = s.suggestedPurchDate || '—'; styleDataCell(r.getCell(15), { align: 'left', zebra: z });
      const shipTxt = [s.shipSea ? `海:${s.shipSea}` : '', s.shipAir ? `空:${s.shipAir}` : '', s.shipSlow ? `慢:${s.shipSlow}` : ''].filter(Boolean).join(' | ');
      r.getCell(16).value = shipTxt || '—'; styleDataCell(r.getCell(16), { align: 'left', zebra: z });
    });

    // Section 4: Table C - 采购超期与发货滞留跟踪 (>15天未发货/未入库风险)
    const s3Row = sPlanRow + 3 + replenishPlanList.length;
    styleSectionBanner(ws7, s3Row, `四、【采购超期与发货滞留】在途PO排查(>15天)、本地仓滞留、准备装运停滞及到期未采（共 ${overdueList.length} 项）`, 16, '1E40AF');
    setHeaderRow(ws7, s3Row + 1, [
      '序号', 'MSKU', '品名', '采购在途(件)', '本地仓可用(件)', 'READY_TO_SHIP', 'FBA可售(件)', '在库DOS(天)',
      '海运发FBA建议日', '空运发FBA建议日', '慢船发FBA建议日', '建议采购日', 'SHIPPED发货量', '超期/滞留分类', '风险评级', '采购超期排查与发货行动'
    ], '1E3A8A');

    overdueList.forEach((s, idx) => {
      const r = ws7.getRow(s3Row + 2 + idx);
      r.height = 20;
      const z = idx % 2 === 1;
      r.getCell(1).value = idx + 1; styleDataCell(r.getCell(1), { align: 'center', zebra: z });
      r.getCell(2).value = s.msku; styleDataCell(r.getCell(2), { align: 'left', bold: true, zebra: z });
      r.getCell(3).value = s.cnName; styleDataCell(r.getCell(3), { align: 'left', zebra: z });
      r.getCell(4).value = s.purchTransit; styleDataCell(r.getCell(4), { fmt: '#,##0', bold: s.purchTransit > 0, zebra: z });
      r.getCell(5).value = s.localAvail; styleDataCell(r.getCell(5), { fmt: '#,##0', bold: s.localAvail > 0, zebra: z });
      r.getCell(6).value = s.readyToShip; styleDataCell(r.getCell(6), { fmt: '#,##0', bold: s.readyToShip > 0, zebra: z });
      r.getCell(7).value = s.fbaSellable; styleDataCell(r.getCell(7), { fmt: '#,##0', zebra: z });
      r.getCell(8).value = s.dosInStock; styleDataCell(r.getCell(8), { fmt: '#,##0', zebra: z });
      r.getCell(9).value = s.shipSea || '—'; styleDataCell(r.getCell(9), { align: 'center', zebra: z });
      r.getCell(10).value = s.shipAir || '—'; styleDataCell(r.getCell(10), { align: 'center', zebra: z });
      r.getCell(11).value = s.shipSlow || '—'; styleDataCell(r.getCell(11), { align: 'center', zebra: z });
      r.getCell(12).value = s.suggestedPurchDate || '—'; styleDataCell(r.getCell(12), { align: 'center', zebra: z });
      r.getCell(13).value = s.shippedFba; styleDataCell(r.getCell(13), { fmt: '#,##0', zebra: z });
      r.getCell(14).value = s.overdueType || '滞留关注';
      styleBadge(r.getCell(14), s.overdueType.includes('极危') || s.overdueType.includes('超期') || s.overdueType.includes('到期') ? 'red' : (s.purchTransit > 0 ? 'blue' : 'purple'));
      r.getCell(15).value = s.dosInStock <= 15 ? '红线超期极危' : (s.dosInStock <= 25 ? '严重缺货预警' : (s.localAvail >= 30 ? '高滞留占用' : '需跟进核查'));
      styleBadge(r.getCell(15), s.dosInStock <= 25 ? 'red' : (s.localAvail >= 30 ? 'amber' : 'blue'));
      let actionTxt = '';
      if (s.purchTransit > 0) actionTxt = `采购在途 ${s.purchTransit} 件，核查PO下单是否超15天未交货/未发`;
      else if (s.localAvail > 0) actionTxt = s.dosInStock <= 25 ? `国内现货 ${s.localAvail} 件已入库，FBA仅剩 ${s.dosInStock} 天，立即发FBA！` : `本地仓现货 ${s.localAvail} 件滞留，按排期打单发 FBA`;
      else if (s.readyToShip > 0) actionTxt = `已建单准备装运 ${s.readyToShip} 件停滞未发出，排查货代提货`;
      else actionTxt = `采购日今日到期未下单，需立即采购 ${s.suggestedPurchTotal || s.suggestedPurchB1} 件`;
      r.getCell(16).value = actionTxt;
      styleDataCell(r.getCell(16), { align: 'left', zebra: z });
    });

    // Section 5: Table D - 136 款全量明细表
    const s4Row = s3Row + 3 + overdueList.length;
    styleSectionBanner(ws7, s4Row, `五、【赛狐ERP全量台账】全量 136 款 ASIN 补货计划与采购跟踪明细表`, 16, COLORS.slate);
    setHeaderRow(ws7, s4Row + 1, [
      '序号', 'MSKU', 'ASIN', '品名', '日均销量', '本地仓可用', '采购在途', 'FBA可售', 'FBA在途', 'FBA总库存',
      '在库DOS(天)', '预估断货日', '建议采购汇总', '建议补货汇总', '建议采购日', '建议发FBA发货日'
    ], COLORS.indigo);

    saihuAll.forEach((s, idx) => {
      const r = ws7.getRow(s4Row + 2 + idx);
      r.height = 19;
      const z = idx % 2 === 1;
      r.getCell(1).value = idx + 1; styleDataCell(r.getCell(1), { align: 'center', zebra: z });
      r.getCell(2).value = s.msku; styleDataCell(r.getCell(2), { align: 'left', zebra: z });
      r.getCell(3).value = s.asin; styleDataCell(r.getCell(3), { align: 'center', zebra: z });
      r.getCell(4).value = s.cnName; styleDataCell(r.getCell(4), { align: 'left', zebra: z });
      r.getCell(5).value = s.dailyAvg; styleDataCell(r.getCell(5), { fmt: '0.00', zebra: z });
      r.getCell(6).value = s.localAvail; styleDataCell(r.getCell(6), { fmt: '#,##0', zebra: z });
      r.getCell(7).value = s.purchTransit; styleDataCell(r.getCell(7), { fmt: '#,##0', zebra: z });
      r.getCell(8).value = s.fbaSellable; styleDataCell(r.getCell(8), { fmt: '#,##0', zebra: z });
      r.getCell(9).value = s.fbaTransit; styleDataCell(r.getCell(9), { fmt: '#,##0', zebra: z });
      r.getCell(10).value = s.fbaTotal; styleDataCell(r.getCell(10), { fmt: '#,##0', zebra: z });
      r.getCell(11).value = s.dosInStock; styleDataCell(r.getCell(11), { fmt: '#,##0', zebra: z });
      r.getCell(12).value = s.stockoutDate || '—'; styleDataCell(r.getCell(12), { align: 'center', zebra: z });
      r.getCell(13).value = s.suggestedPurchTotal; styleDataCell(r.getCell(13), { fmt: '#,##0', zebra: z });
      r.getCell(14).value = s.suggestedReplenishTotal; styleDataCell(r.getCell(14), { fmt: '#,##0', zebra: z });
      r.getCell(15).value = s.suggestedPurchDate || '—'; styleDataCell(r.getCell(15), { align: 'left', zebra: z });
      const shipTxt = [s.shipSea, s.shipAir, s.shipSlow].filter(Boolean).join('; ');
      r.getCell(16).value = shipTxt || '—'; styleDataCell(r.getCell(16), { align: 'left', zebra: z });
    });

    ws7.columns = [
      { width: 6 }, { width: 34 }, { width: 13 }, { width: 26 }, { width: 11 }, { width: 12 }, { width: 12 },
      { width: 11 }, { width: 11 }, { width: 11 }, { width: 12 }, { width: 18 }, { width: 13 }, { width: 13 },
      { width: 32 }, { width: 42 },
    ];
    ws7.autoFilter = { from: { row: s4Row + 1, column: 1 }, to: { row: s4Row + 1 + saihuAll.length, column: 16 } };

    // =========================================================================
    // SHEET 8: 8_补货计划 (独立工作表，方便直接查看)
    // =========================================================================
    const ws8 = wb.addWorksheet('8_补货计划', { views: [{ showGridLines: true, state: 'frozen', ySplit: 4 }] });
    styleTitle(
      ws8,
      'UPBestKS 赛狐 ERP 全店智能补货计划明细表（含备货周期与多渠道发运排期）',
      `共 ${replenishPlanList.length} 款有补货/发运排期 SKU · 建议补货汇总 ${sSum.totalSuggestedReplenishUnits || 0} 件 · 备货周期补货 ${sSum.totalSuggestedReplenishCycleUnits || 0} 件 · 建议采购汇总 ${sSum.totalSuggestedPurchUnits || 0} 件`,
      16
    );
    styleSectionBanner(ws8, 3, `全店补货计划明细（共 ${replenishPlanList.length} 款，按 FBA 在库 DOS 升序排列）`, 16, '5B21B6');
    setHeaderRow(ws8, 4, [
      '序号', 'MSKU', 'ASIN', '品名', '备货周期(天)', '安全天数', '销量预测', '在库DOS(天)',
      '建议补货汇总', '备货周期补货量', '建议采购汇总', '备货周期采购量', '第1批海运量', '第1批慢船量', '到货后可售', '建议采购日与发FBA排期'
    ], '4C1D95');

    replenishPlanList.forEach((s, idx) => {
      const r = ws8.getRow(5 + idx);
      r.height = 20;
      const z = idx % 2 === 1;
      r.getCell(1).value = idx + 1; styleDataCell(r.getCell(1), { align: 'center', zebra: z });
      r.getCell(2).value = s.msku; styleDataCell(r.getCell(2), { align: 'left', bold: true, zebra: z });
      r.getCell(3).value = s.asin; styleDataCell(r.getCell(3), { align: 'center', zebra: z });
      r.getCell(4).value = s.cnName; styleDataCell(r.getCell(4), { align: 'left', zebra: z });
      r.getCell(5).value = s.leadCycle; styleDataCell(r.getCell(5), { fmt: '#,##0', align: 'center', zebra: z });
      r.getCell(6).value = s.safetyDays; styleDataCell(r.getCell(6), { fmt: '#,##0', align: 'center', zebra: z });
      r.getCell(7).value = s.salesForecast; styleDataCell(r.getCell(7), { fmt: '#,##0', zebra: z });
      r.getCell(8).value = s.dosInStock; styleDataCell(r.getCell(8), { fmt: '#,##0', bold: s.dosInStock <= 21, color: s.dosInStock <= 15 ? 'DC2626' : undefined, zebra: z });
      r.getCell(9).value = s.suggestedReplenishTotal; styleDataCell(r.getCell(9), { fmt: '#,##0', bold: true, zebra: z });
      r.getCell(10).value = s.suggestedReplenishCycle; styleDataCell(r.getCell(10), { fmt: '#,##0', zebra: z });
      r.getCell(11).value = s.suggestedPurchTotal; styleDataCell(r.getCell(11), { fmt: '#,##0', bold: s.suggestedPurchTotal > 0, zebra: z });
      r.getCell(12).value = s.suggestedPurchCycle; styleDataCell(r.getCell(12), { fmt: '#,##0', zebra: z });
      r.getCell(13).value = s.shipSeaB1Qty; styleDataCell(r.getCell(13), { fmt: '#,##0', zebra: z });
      r.getCell(14).value = s.shipSlowB1Qty; styleDataCell(r.getCell(14), { fmt: '#,##0', zebra: z });
      r.getCell(15).value = s.afterArrivalSellable; styleDataCell(r.getCell(15), { fmt: '#,##0', zebra: z });
      const planTxt = [s.suggestedPurchDate ? `采购:${s.suggestedPurchDate}` : '', s.shipSea ? `海:${s.shipSea}` : '', s.shipAir ? `空:${s.shipAir}` : '', s.shipSlow ? `慢:${s.shipSlow}` : ''].filter(Boolean).join(' | ');
      r.getCell(16).value = planTxt || '—'; styleDataCell(r.getCell(16), { align: 'left', zebra: z });
    });
    ws8.columns = [
      { width: 6 }, { width: 34 }, { width: 13 }, { width: 26 }, { width: 12 }, { width: 10 }, { width: 10 },
      { width: 12 }, { width: 13 }, { width: 14 }, { width: 13 }, { width: 14 }, { width: 12 }, { width: 12 },
      { width: 12 }, { width: 52 },
    ];
    ws8.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + replenishPlanList.length, column: 16 } };

    // =========================================================================
    // SHEET 9: 9_采购超期与发货滞留 (独立工作表，方便直接查看)
    // =========================================================================
    const ws9 = wb.addWorksheet('9_采购超期与发货滞留', { views: [{ showGridLines: true, state: 'frozen', ySplit: 4 }] });
    styleTitle(
      ws9,
      'UPBestKS 采购超期（>15天未发货/未入库）与发货滞留专项排查表',
      `共 ${overdueList.length} 款风险 SKU · 含采购在途 ${sSum.inTransitPurchCount} 款(${sSum.totalPurchTransitUnits}件) / 本地仓滞留 ${sSum.localStockCount} 款(${sSum.totalLocalStockUnits}件) / 准备装运停滞 ${sSum.readyToShipCount || 0} 款(${sSum.totalReadyToShipUnits || 0}件) / 今日到期未采 ${sSum.purchDueTodayCount || 0} 款`,
      16
    );
    styleSectionBanner(ws9, 3, `采购超期与发货滞留专项清单（按 FBA 在库 DOS 升序排列 · 赛狐导出无原始PO日期，已纳入全部在途/滞留/停滞/到期项）`, 16, '991B1B');
    setHeaderRow(ws9, 4, [
      '序号', 'MSKU', 'ASIN', '品名', '采购在途(件)', '本地仓可用(件)', 'READY_TO_SHIP', 'FBA可售(件)',
      '在库DOS(天)', '海运发FBA建议日', '空运发FBA建议日', '慢船发FBA建议日', '建议采购日', '超期/滞留分类', '风险评级', '采购超期排查与发货行动'
    ], '7F1D1D');

    overdueList.forEach((s, idx) => {
      const r = ws9.getRow(5 + idx);
      r.height = 20;
      const z = idx % 2 === 1;
      r.getCell(1).value = idx + 1; styleDataCell(r.getCell(1), { align: 'center', zebra: z });
      r.getCell(2).value = s.msku; styleDataCell(r.getCell(2), { align: 'left', bold: true, zebra: z });
      r.getCell(3).value = s.asin; styleDataCell(r.getCell(3), { align: 'center', zebra: z });
      r.getCell(4).value = s.cnName; styleDataCell(r.getCell(4), { align: 'left', zebra: z });
      r.getCell(5).value = s.purchTransit; styleDataCell(r.getCell(5), { fmt: '#,##0', bold: s.purchTransit > 0, zebra: z });
      r.getCell(6).value = s.localAvail; styleDataCell(r.getCell(6), { fmt: '#,##0', bold: s.localAvail > 0, zebra: z });
      r.getCell(7).value = s.readyToShip; styleDataCell(r.getCell(7), { fmt: '#,##0', bold: s.readyToShip > 0, zebra: z });
      r.getCell(8).value = s.fbaSellable; styleDataCell(r.getCell(8), { fmt: '#,##0', zebra: z });
      r.getCell(9).value = s.dosInStock; styleDataCell(r.getCell(9), { fmt: '#,##0', bold: s.dosInStock <= 25, color: s.dosInStock <= 15 ? 'DC2626' : undefined, zebra: z });
      r.getCell(10).value = s.shipSea || '—'; styleDataCell(r.getCell(10), { align: 'center', zebra: z });
      r.getCell(11).value = s.shipAir || '—'; styleDataCell(r.getCell(11), { align: 'center', zebra: z });
      r.getCell(12).value = s.shipSlow || '—'; styleDataCell(r.getCell(12), { align: 'center', zebra: z });
      r.getCell(13).value = s.suggestedPurchDate || '—'; styleDataCell(r.getCell(13), { align: 'center', zebra: z });
      r.getCell(14).value = s.overdueType || '滞留关注';
      styleBadge(r.getCell(14), s.overdueType.includes('极危') || s.overdueType.includes('超期') || s.overdueType.includes('到期') ? 'red' : (s.purchTransit > 0 ? 'blue' : 'purple'));
      r.getCell(15).value = s.dosInStock <= 15 ? '红线超期极危' : (s.dosInStock <= 25 ? '严重缺货预警' : (s.localAvail >= 30 ? '高滞留占用' : '需跟进核查'));
      styleBadge(r.getCell(15), s.dosInStock <= 25 ? 'red' : (s.localAvail >= 30 ? 'amber' : 'blue'));
      let actionTxt = '';
      if (s.purchTransit > 0) actionTxt = `采购在途 ${s.purchTransit} 件，核查PO下单是否超15天未交货/未发`;
      else if (s.localAvail > 0) actionTxt = s.dosInStock <= 25 ? `国内现货 ${s.localAvail} 件已入库，FBA仅剩 ${s.dosInStock} 天，立即发FBA！` : `本地仓现货 ${s.localAvail} 件滞留，按排期打单发 FBA`;
      else if (s.readyToShip > 0) actionTxt = `已建单准备装运 ${s.readyToShip} 件停滞未发出，排查货代提货`;
      else actionTxt = `采购日今日到期未下单，需立即采购 ${s.suggestedPurchTotal || s.suggestedPurchB1} 件`;
      r.getCell(16).value = actionTxt;
      styleDataCell(r.getCell(16), { align: 'left', zebra: z });
    });
    ws9.columns = [
      { width: 6 }, { width: 34 }, { width: 13 }, { width: 26 }, { width: 12 }, { width: 13 }, { width: 15 },
      { width: 11 }, { width: 12 }, { width: 22 }, { width: 18 }, { width: 24 }, { width: 24 }, { width: 22 },
      { width: 15 }, { width: 44 },
    ];
    ws9.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + overdueList.length, column: 16 } };
  }

  // =========================================================================
  // INJECT NATIVE EXCEL CHARTS (6 Charts across Sheets 1, 2, 3, 4)
  // =========================================================================
  const rawBuf = await wb.xlsx.writeBuffer();
  const zip = await JSZip.loadAsync(rawBuf);

  const modelColors = models.map(m => m.cohort === '老品主力' ? '2563EB' : '7C3AED');
  const charts = [
    {
      id: 1,
      xml: buildBarChartXml({
        title: '月度日均销售额趋势 (USD/天) — 11月新品放量跃升',
        barDir: 'col', showLegend: false, valFmt: '$#,##0',
        pointColors: ['94A3B8', '3B82F6', '64748B', '10B981'],
        series: [{
          name: '日均销售额', color: '10B981', labelFmt: '$#,##0',
          catFormula: `'1_总览看板与周期趋势'!$A$${monthStartRow}:$A$${monthEndRow}`,
          valFormula: `'1_总览看板与周期趋势'!$H$${monthStartRow}:$H$${monthEndRow}`,
        }],
      }),
    },
    {
      id: 2,
      xml: buildBarChartXml({
        title: '周度老品 vs 11月新品销售额趋势 (W01~W15, USD)',
        barDir: 'col', showLegend: true, valFmt: '$#,##0',
        series: [
          {
            name: '老品主力销售额', color: '2563EB', dataLabels: false,
            catFormula: `'1_总览看板与周期趋势'!$A$${wkDataStart}:$A$${wkDataEnd}`,
            valFormula: `'1_总览看板与周期趋势'!$F$${wkDataStart}:$F$${wkDataEnd}`,
          },
          {
            name: '11月新品销售额', color: '8B5CF6', dataLabels: false,
            catFormula: `'1_总览看板与周期趋势'!$A$${wkDataStart}:$A$${wkDataEnd}`,
            valFormula: `'1_总览看板与周期趋势'!$G$${wkDataStart}:$G$${wkDataEnd}`,
          },
        ],
      }),
    },
    {
      id: 3,
      xml: buildBarChartXml({
        title: '14 款机型全周期销售额排行 (蓝=老品主力 | 紫=11月新品)',
        barDir: 'bar', showLegend: false, valFmt: '$#,##0',
        pointColors: modelColors,
        series: [{
          name: '全周期销售额', color: '2563EB', labelFmt: '$#,##0',
          catFormula: `'2_分机型周期对比与新品追踪'!$A$5:$A$${mEndRow}`,
          valFormula: `'2_分机型周期对比与新品追踪'!$F$5:$F$${mEndRow}`,
        }],
      }),
    },
    {
      id: 4,
      xml: buildBarChartXml({
        title: '各机型 前15天 vs 近15天 销售额对比 (USD)',
        barDir: 'col', showLegend: true, valFmt: '$#,##0',
        series: [
          {
            name: '前15天 (10.27-11.10)', color: '94A3B8', dataLabels: false,
            catFormula: `'2_分机型周期对比与新品追踪'!$A$5:$A$${mEndRow}`,
            valFormula: `'2_分机型周期对比与新品追踪'!$I$5:$I$${mEndRow}`,
          },
          {
            name: '近15天 (11.11-11.25)', color: '059669', dataLabels: false,
            catFormula: `'2_分机型周期对比与新品追踪'!$A$5:$A$${mEndRow}`,
            valFormula: `'2_分机型周期对比与新品追踪'!$J$5:$J$${mEndRow}`,
          },
        ],
      }),
    },
    {
      id: 5,
      xml: buildBarChartXml({
        title: '8 大颜色全周期销量 vs FBA总库存对比 (件)',
        barDir: 'col', showLegend: true, valFmt: '#,##0',
        series: [
          {
            name: '全周期销量(件)', color: '2563EB', dataLabels: true, labelFmt: '#,##0',
            catFormula: `'3_分颜色结构与机型矩阵'!$A$5:$A$${cEndRow}`,
            valFormula: `'3_分颜色结构与机型矩阵'!$D$5:$D$${cEndRow}`,
          },
          {
            name: 'FBA总库存(件)', color: 'F59E0B', dataLabels: true, labelFmt: '#,##0',
            catFormula: `'3_分颜色结构与机型矩阵'!$A$5:$A$${cEndRow}`,
            valFormula: `'3_分颜色结构与机型矩阵'!$M$5:$M$${cEndRow}`,
          },
        ],
      }),
    },
    {
      id: 6,
      xml: buildBarChartXml({
        title: 'FBA 可售天数分层 SKU 数 vs 总库存对比',
        barDir: 'col', showLegend: true, valFmt: '#,##0',
        series: [
          {
            name: 'SKU数量', color: 'EF4444', dataLabels: true, labelFmt: '#,##0',
            catFormula: `'4_FBA库存健康与补货预警'!$A$5:$A$9`,
            valFormula: `'4_FBA库存健康与补货预警'!$B$5:$B$9`,
          },
          {
            name: 'FBA总库存(件)', color: '3B82F6', dataLabels: true, labelFmt: '#,##0',
            catFormula: `'4_FBA库存健康与补货预警'!$A$5:$A$9`,
            valFormula: `'4_FBA库存健康与补货预警'!$E$5:$E$9`,
          },
        ],
      }),
    },
  ];
  charts.forEach(ch => zip.file(`xl/charts/chart${ch.id}.xml`, ch.xml));

  zip.file('xl/drawings/drawing1.xml', buildDrawingXml([
    { chartId: 1, c1: 11, r1: 2, c2: 19, r2: 19 },
    { chartId: 2, c1: 11, r1: 20, c2: 19, r2: 40 },
  ]));
  zip.file('xl/drawings/_rels/drawing1.xml.rels', buildDrawingRelsXml([{ chartId: 1 }, { chartId: 2 }]));

  const s2ChartRow = mEndRow + 2;
  zip.file('xl/drawings/drawing2.xml', buildDrawingXml([
    { chartId: 3, c1: 0, r1: s2ChartRow, c2: 9, r2: s2ChartRow + 18 },
    { chartId: 4, c1: 9, r1: s2ChartRow, c2: 19, r2: s2ChartRow + 18 },
  ]));
  zip.file('xl/drawings/_rels/drawing2.xml.rels', buildDrawingRelsXml([{ chartId: 3 }, { chartId: 4 }]));

  const s3ChartRow = mat2Banner + 2 + matrix.length + 2;
  zip.file('xl/drawings/drawing3.xml', buildDrawingXml([
    { chartId: 5, c1: 0, r1: s3ChartRow, c2: 11, r2: s3ChartRow + 18 },
  ]));
  zip.file('xl/drawings/_rels/drawing3.xml.rels', buildDrawingRelsXml([{ chartId: 5 }]));

  zip.file('xl/drawings/drawing4.xml', buildDrawingXml([
    { chartId: 6, c1: 10, r1: 2, c2: 16, r2: 17 },
  ]));
  zip.file('xl/drawings/_rels/drawing4.xml.rels', buildDrawingRelsXml([{ chartId: 6 }]));

  async function attachDrawing(sheetIdx, drawingIdx) {
    const sPath = `xl/worksheets/sheet${sheetIdx}.xml`;
    const rPath = `xl/worksheets/_rels/sheet${sheetIdx}.xml.rels`;
    let sXml = await zip.file(sPath).async('string');
    let rXml = zip.file(rPath) ? await zip.file(rPath).async('string') : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    const matches = [...rXml.matchAll(/Id="rId(\d+)"/g)].map(m => Number(m[1]));
    const nextRid = (matches.length ? Math.max(...matches) : 0) + 1;
    rXml = rXml.replace('</Relationships>', `<Relationship Id="rId${nextRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingIdx}.xml"/></Relationships>`);
    zip.file(rPath, rXml);
    sXml = sXml.replace('</worksheet>', `<drawing r:id="rId${nextRid}"/></worksheet>`);
    zip.file(sPath, sXml);
  }
  await attachDrawing(1, 1);
  await attachDrawing(2, 2);
  await attachDrawing(3, 3);
  await attachDrawing(4, 4);

  let ctXml = await zip.file('[Content_Types].xml').async('string');
  const overrides = [
    ...charts.map(ch => `<Override PartName="/xl/charts/chart${ch.id}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`),
    `<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`,
    `<Override PartName="/xl/drawings/drawing2.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`,
    `<Override PartName="/xl/drawings/drawing3.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`,
    `<Override PartName="/xl/drawings/drawing4.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`,
  ].join('');
  ctXml = ctXml.replace('</Types>', `${overrides}</Types>`);
  zip.file('[Content_Types].xml', ctXml);

  const outBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  let finalPath = outPath;
  try {
    fs.writeFileSync(outPath, outBuf);
  } catch (e) {
    if (e.code === 'EBUSY' || e.code === 'EPERM') {
      let wrote = false;
      for (let k = 2; k <= 10; k++) {
        const cand = outPath.replace('.xlsx', `_v${k}.xlsx`);
        try {
          fs.writeFileSync(cand, outBuf);
          finalPath = cand;
          wrote = true;
          break;
        } catch (err2) {
          if (err2.code !== 'EBUSY' && err2.code !== 'EPERM') throw err2;
        }
      }
      if (!wrote) throw e;
    } else throw e;
  }

  // Self-audit via ExcelJS reload
  const verifyWb = new ExcelJS.Workbook();
  await verifyWb.xlsx.load(fs.readFileSync(finalPath));
  return {
    outPath: finalPath,
    sheets: verifyWb.worksheets.map(w => `${w.name} (${w.rowCount}行×${w.columnCount}列)`),
    chartsCount: charts.length,
  };
}

if (process.argv[1] && (process.argv[1].endsWith('excel-report.mjs') || process.argv[1].includes('excel-report'))) {
  console.log('Generating Excel report with Sheet 7...');
  generateSalesExcel().then(res => {
    console.log('Excel generated successfully:', JSON.stringify(res, null, 2));
  }).catch(e => {
    console.error('Failed to generate Excel:', e);
    process.exit(1);
  });
}

