import fs from 'node:fs';
import path from 'node:path';

function parseCSV(text) {
  const rows = [];
  let row = [];
  let inQuotes = false;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i+1];
    if (c === '"') {
      if (inQuotes && next === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (c === ',' && !inQuotes) {
      row.push(cur); cur = '';
    } else if ((c === '\r' || c === '\n') && !inQuotes) {
      if (c === '\r' && next === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else {
      cur += c;
    }
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

export function loadSaihuReplenishment(csvPath) {
  if (!fs.existsSync(csvPath)) return null;
  const content = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCSV(content);
  if (!rows || rows.length < 2) return null;

  const headers = rows[0].map(h => h.trim());
  const rawRecords = rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, idx) => obj[h] = (r[idx] || '').trim());
    return obj;
  });

  const num = (v) => {
    if (v === '' || v === '-' || v === '--' || v === null || v === undefined) return 0;
    const n = Number(String(v).replace(/[$,%\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  const list = rawRecords.map(r => {
    const msku = r['MSKU'] || '';
    const sku = r['SKU'] || '';
    const asin = r['ASIN'] || '';
    const title = r['标题'] || '';
    const cnName = r['品名'] || '';
    const dailyAvg = num(r['日均销量（动态）']);
    const d7Sales = num(r['7天销量']);
    const d14Sales = num(r['14天销量']);
    const d30Sales = num(r['30天销量']);

    const localAvail = Math.round(num(r['本地仓可用']));
    const purchTransit = Math.round(num(r['采购在途']));
    const purchPlan = Math.round(num(r['采购计划']));
    const fbaSellable = Math.round(num(r['可售']));
    const fbaReserved = Math.round(num(r['预留转运'])) + Math.round(num(r['预留处理中']));
    const fbaTransit = Math.round(num(r['FBA在途']));
    const fbaTotal = Math.round(num(r['FBA库存']));
    const shippedFba = Math.round(num(r['SHIPPED（已寄送）']));
    const readyToShip = Math.round(num(r['READY_TO_SHIP（准备装运）']));

    const dosInStock = num(r['在库库存可售天数(FBA)']);
    const dosEstBeforeOut = num(r['预估断货前可售天数(FBA)']);
    const stockoutDate = r['断货日期（FBA）'] || '';

    const suggestedPurchDate = r['建议采购日'] || '';
    const suggestedPurchTotal = Math.round(num(r['建议采购量（汇总）']));
    const suggestedPurchB1 = Math.round(num(r['建议采购量（第1批）']));
    const suggestedPurchCycle = Math.round(num(r['建议采购量（备货周期）']));
    const suggestedReplenishTotal = Math.round(num(r['建议补货量（汇总）']));
    const suggestedReplenishCycle = Math.round(num(r['建议补货量（备货周期）']));
    const leadCycle = Math.round(num(r['备货周期']));
    const safetyDays = Math.round(num(r['安全天数']));
    const salesForecast = Math.round(num(r['销量预测']));

    const shipSea = r['本地仓至FBA发货日 (FBA海运（默认）-35)'] || '';
    const shipAir = r['本地仓至FBA发货日 (FBA空运（默认）-15)'] || '';
    const shipSlow = r['本地仓至FBA发货日 (美国慢船-智善)'] || '';
    const shipSeaB1Qty = Math.round(num(r['本地仓发FBA量（第1批-FBA海运（默认）-35)']));
    const shipSlowB1Qty = Math.round(num(r['本地仓发FBA量（第1批-美国慢船-智善)']));
    const afterArrivalSellable = Math.round(num(r['到货后可售库存量']));
    const afterArrivalOutDate = r['到货后断货日期 (美国慢船-智善)'] || r['到货后断货日期 (FBA海运（默认）-35)'] || r['到货后断货日期 (FBA空运（默认）-15)'] || '';

    // Condition 1: 哪些需要提前补货还没进行采购的
    const isNeedPurchNoPo = (suggestedPurchTotal > 0 || Boolean(suggestedPurchDate)) && purchTransit === 0 && purchPlan === 0;
    const isPurchDateDue = Boolean(suggestedPurchDate && suggestedPurchDate.includes('2026-11-26')) && purchTransit === 0 && purchPlan === 0;

    // 补货计划（含建议补货、备货周期补货、海运/慢船/空运发FBA排期）
    const isReplenishPlan = suggestedReplenishTotal > 0 || suggestedReplenishCycle > 0 || suggestedPurchTotal > 0 || Boolean(shipSea) || Boolean(shipSlow) || Boolean(shipAir);

    // Condition 2: 采购超期与发货滞留 (>15天未发货/未入库风险)
    const isPurchInTransit = purchTransit > 0;
    const isLocalStockAwaitingShip = localAvail > 0;
    const isReadyToShipStalled = readyToShip > 0;
    const isOverdueShipRisk = isPurchInTransit || (isLocalStockAwaitingShip && (dosInStock < 45 || Boolean(shipSea) || Boolean(shipSlow) || Boolean(shipAir)));
    const isOverdueOrStalled = isPurchInTransit || isLocalStockAwaitingShip || isReadyToShipStalled || isPurchDateDue;

    let overdueType = '';
    if (isPurchInTransit && dosInStock <= 15) overdueType = '采购在途极危(排查>15天)';
    else if (isPurchInTransit) overdueType = '采购在途(排查>15天未交货)';
    else if (isLocalStockAwaitingShip && dosInStock <= 25) overdueType = '已采购入库超期未发FBA';
    else if (isLocalStockAwaitingShip) overdueType = '本地仓现货滞留未发';
    else if (isReadyToShipStalled) overdueType = '已建单准备装运停滞';
    else if (isPurchDateDue) overdueType = '采购日今日到期未下单';

    let urgencyLevel = 'NORMAL';
    let urgencyBadge = '正常';
    let urgencyTone = 'gray';

    if (isNeedPurchNoPo) {
      if (dosInStock <= 15 || suggestedPurchDate.includes('2026-11-26')) {
        urgencyLevel = 'CRITICAL_PURCHASE';
        urgencyBadge = '紧急采购';
        urgencyTone = 'red';
      } else {
        urgencyLevel = 'WARN_PURCHASE';
        urgencyBadge = '待下单';
        urgencyTone = 'amber';
      }
    } else if (isLocalStockAwaitingShip && dosInStock <= 25) {
      urgencyLevel = 'CRITICAL_SHIP';
      urgencyBadge = '急需发FBA';
      urgencyTone = 'red';
    } else if (isPurchInTransit) {
      urgencyLevel = 'IN_TRANSIT_PO';
      urgencyBadge = '采购在途';
      urgencyTone = 'blue';
    } else if (isLocalStockAwaitingShip) {
      urgencyLevel = 'LOCAL_STOCK';
      urgencyBadge = '本地在库';
      urgencyTone = 'purple';
    }

    return {
      msku,
      sku,
      asin,
      cnName,
      title,
      dailyAvg,
      d7Sales,
      d14Sales,
      d30Sales,
      localAvail,
      purchTransit,
      purchPlan,
      fbaSellable,
      fbaReserved,
      fbaTransit,
      fbaTotal,
      shippedFba,
      readyToShip,
      dosInStock,
      dosEstBeforeOut,
      stockoutDate,
      suggestedPurchDate,
      suggestedPurchTotal,
      suggestedPurchB1,
      suggestedPurchCycle,
      suggestedReplenishTotal,
      suggestedReplenishCycle,
      leadCycle,
      safetyDays,
      salesForecast,
      shipSea,
      shipAir,
      shipSlow,
      shipSeaB1Qty,
      shipSlowB1Qty,
      afterArrivalSellable,
      afterArrivalOutDate,
      isNeedPurchNoPo,
      isPurchDateDue,
      isReplenishPlan,
      isPurchInTransit,
      isLocalStockAwaitingShip,
      isReadyToShipStalled,
      isOverdueShipRisk,
      isOverdueOrStalled,
      overdueType,
      urgencyLevel,
      urgencyBadge,
      urgencyTone,
    };
  });

  const needPurchList = list.filter(x => x.isNeedPurchNoPo).sort((a, b) => a.dosInStock - b.dosInStock);
  const replenishPlanList = list.filter(x => x.isReplenishPlan).sort((a, b) => a.dosInStock - b.dosInStock);
  const purchInTransitList = list.filter(x => x.isPurchInTransit).sort((a, b) => a.dosInStock - b.dosInStock);
  const localStockList = list.filter(x => x.isLocalStockAwaitingShip).sort((a, b) => a.dosInStock - b.dosInStock);
  const readyToShipList = list.filter(x => x.isReadyToShipStalled).sort((a, b) => a.dosInStock - b.dosInStock);
  const overdueList = list.filter(x => x.isOverdueOrStalled).sort((a, b) => a.dosInStock - b.dosInStock);

  const summary = {
    totalRows: list.length,
    needPurchCount: needPurchList.length,
    replenishPlanCount: replenishPlanList.length,
    inTransitPurchCount: purchInTransitList.length,
    localStockCount: localStockList.length,
    readyToShipCount: readyToShipList.length,
    overdueCount: overdueList.length,
    purchDueTodayCount: list.filter(x => x.isPurchDateDue).length,
    totalLocalStockUnits: list.reduce((a, b) => a + b.localAvail, 0),
    totalPurchTransitUnits: list.reduce((a, b) => a + b.purchTransit, 0),
    totalReadyToShipUnits: list.reduce((a, b) => a + b.readyToShip, 0),
    totalSuggestedPurchUnits: list.reduce((a, b) => a + b.suggestedPurchTotal, 0),
    totalSuggestedReplenishUnits: list.reduce((a, b) => a + b.suggestedReplenishTotal, 0),
    totalSuggestedReplenishCycleUnits: list.reduce((a, b) => a + b.suggestedReplenishCycle, 0),
    criticalDosCount: list.filter(x => x.dosInStock > 0 && x.dosInStock < 15).length,
  };

  return {
    summary,
    needPurchList,
    replenishPlanList,
    purchInTransitList,
    localStockList,
    readyToShipList,
    overdueList,
    list,
  };
}

if (process.argv[1] && process.argv[1].endsWith('saihu-parser.mjs')) {
  const res = loadSaihuReplenishment('D:/反重力/UPBestKS/UPBestKS_赛狐补货建议_2026-11-26.csv');
  console.log('Summary:', res.summary);
}
