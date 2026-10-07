export const ROI_FIELD_NAMES = {
  product: "产品", date: "日期", periodType: "周期类型",
  metric: "指标代码", metricDisplay: "指标",
  value: "数值", remark: "备注", month: "月份", week: "周", weekday: "星期",
  pivotColumn: "透视列", pivotDate: "透视日期", pivotSection: "透视分区",
  recordRole: "记录角色",
} as const;
export const ROI_PERIOD_TYPES = {
  workday: "工作日", weekend: "周末", monthTotal: "月合计", allTotal: "全部合计",
  placeholder: "模板占位",
} as const;
export const ROI_PIVOT_SECTIONS = {
  summary: "汇总",
  detail: "明细",
} as const;
export const ROI_RECORD_ROLES = {
  inputTemplate: "录入模板",
  manualInput: "明细输入",
  productRollup: "商品汇总",
  formula: "公式计算",
  summary: "汇总记录",
  calendar: "日历骨架",
} as const;
export const ROI_WEEK_EPOCH = "2025-03-23";
export const ROI_TEMPLATE_START_DATE = "2025-04-01";
export const TECHWAVE_STORE_NAME = "TechWave";
export const TECHWAVE_STORE_METRICS = [
  "合作量",
  "上线量",
  "店铺浏览量",
  "总单量",
  "总数量",
  "转化率",
  "达人出单量",
  "商品卡出单量",
  "销售额",
  "出单视频",
  "总广告出单量",
  "总广告花费",
  "雅岚广告花费",
  "雅岚广告出单量",
  "金凯悦-10广告花费",
  "金凯悦-10广告出单量",
  "金凯悦-11广告花费",
  "金凯悦-11广告出单量",
  "GMV Max花费",
  "GMV Max广告出单量",
  "退货量",
] as const;
export const TECHWAVE_PRODUCT_METRICS = [
  "合作量",
  "上线量",
  "单量",
  "数量",
  "达人出单量",
  "达人出单数量",
  "商品卡出单量",
  "商品卡出单数量",
  "销售额",
  "出单视频",
  "自孵化出单量",
  "自孵化上线量",
] as const;
export const ROI_ALL_METRICS = [
  ...TECHWAVE_STORE_METRICS,
  ...TECHWAVE_PRODUCT_METRICS.filter(
    (metric) => !(TECHWAVE_STORE_METRICS as readonly string[]).includes(metric),
  ),
] as const;
const PRODUCT_DERIVED_RULES = {
  达人出单量: { minuend: "单量", subtrahend: "商品卡出单量" },
  达人出单数量: { minuend: "数量", subtrahend: "商品卡出单数量" },
} as const;
const PRODUCT_UNSUMMARIZED_METRICS = new Set<string>([
  "自孵化出单量",
  "自孵化上线量",
]);
const AVERAGE_SUMMARY_METRICS = new Set<string>([
  "出单视频",
]);
const STORE_AVERAGE_SUMMARY_METRICS = new Set<string>([
  "店铺浏览量",
  "转化率",
]);
const STORE_PRODUCT_ROLLUPS = {
  合作量: "合作量",
  上线量: "上线量",
  总单量: "单量",
  总数量: "数量",
  达人出单量: "达人出单量",
  商品卡出单量: "商品卡出单量",
  销售额: "销售额",
} as const;
const STORE_FORMULA_SUMS = {
  总广告出单量: [
    "雅岚广告出单量",
    "金凯悦-10广告出单量",
    "金凯悦-11广告出单量",
    "GMV Max广告出单量",
  ],
  总广告花费: [
    "雅岚广告花费",
    "金凯悦-10广告花费",
    "金凯悦-11广告花费",
    "GMV Max花费",
  ],
} as const;
export interface RoiApiRecord { recordId: string; fields: Record<string, unknown> }
export interface RoiFormulaInput {
  product: string;
  metric: "合作量" | "上线量";
  date: unknown;
  value?: number;
}
export interface RoiRecordUpdate { recordId: string; fields: Record<string, unknown> }
export interface RoiPivotPlan {
  optionNames: string[];
  updates: RoiRecordUpdate[];
  creates: Array<{ fields: Record<string, unknown> }>;
  deleteRecordIds: string[];
  stats: {
    inputRecords: number; detailRecords: number; metricPairs: number;
    weeks: number; reusedTemplateRows: number; ratioMetrics: number;
  };
}
interface ParsedRecord extends RoiApiRecord {
  product: string; rawProduct: string; metric: string; rawMetric: string; periodType: string;
  dateKey: string; value: number | null; recordRole: string;
}
interface RatioRule { numerator: string; denominator: string }
export const ROI_RATIO_RULES: Readonly<Record<string, RatioRule>> = {
  转化率: { numerator: "总单量", denominator: "店铺浏览量" },
  投产比: { numerator: "销售额", denominator: "总广告花费" },
  ROI: { numerator: "销售额", denominator: "总广告花费" },
  广告投产比: { numerator: "销售额", denominator: "总广告花费" },
  客单价: { numerator: "销售额", denominator: "总单量" },
};
const summaryTypes = new Set<string>([
  ROI_PERIOD_TYPES.monthTotal,
  ROI_PERIOD_TYPES.allTotal,
  "周合计",
]);
const shanghaiDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function buildRoiPivotPlan(
  records: RoiApiRecord[],
  nowMs = Date.now(),
  formulaInputs: readonly RoiFormulaInput[] = [],
): RoiPivotPlan {
  const parsedAll = records.map(parseRecord);
  const obsoleteStoreTypoIds = new Set(
    parsedAll
      .filter((row) => (
        row.product === TECHWAVE_STORE_NAME
        && row.rawProduct !== row.product
        && row.metric
        && !(TECHWAVE_STORE_METRICS as readonly string[]).includes(row.metric)
        && row.recordRole !== ROI_RECORD_ROLES.manualInput
      ))
      .map((row) => row.recordId),
  );
  const parsed = parsedAll.filter((row) => !obsoleteStoreTypoIds.has(row.recordId));
  const currentDate = dateKey(nowMs);
  const currentMonth = currentDate.slice(0, 7);
  const calendarDates = templateCalendarDates(currentDate);
  const templateMonths = [...new Set(calendarDates.map((key) => key.slice(0, 7)))];
  const updates: RoiRecordUpdate[] = [];
  const creates: Array<{ fields: Record<string, unknown> }> = [];
  const deleteIds = new Set<string>(obsoleteStoreTypoIds);
  adoptProductAnchors(parsed, updates, deleteIds);
  promoteUndatedTemplateValues(parsed, currentDate, updates);
  const details = parsed.filter((row) => (
    row.product
    && row.metric
    && row.dateKey
    && !summaryTypes.has(row.periodType)
    && row.periodType !== ROI_PERIOD_TYPES.placeholder
    && !isIncompleteInputTemplate(row)
  ));
  const detailIds = new Set(details.map((row) => row.recordId));
  const metricPairs = uniquePairs(parsed);
  let reusedTemplateRows = 0;
  const sourceDetails = details.filter((row) => !isControlledDaily(row.product, row.metric));
  for (const row of parsed) {
    const fields: Record<string, unknown> = {};
    if (row.product !== row.rawProduct) {
      setIfChanged(fields, row.fields, ROI_FIELD_NAMES.product, row.product);
    }
    if (row.metric !== row.rawMetric) {
      setIfChanged(fields, row.fields, ROI_FIELD_NAMES.metric, row.metric);
    }
    if (!detailIds.has(row.recordId)) {
      if (Object.keys(fields).length) updates.push({ recordId: row.recordId, fields });
      continue;
    }
    setIfChanged(fields, row.fields, ROI_FIELD_NAMES.periodType, dayPeriod(row.dateKey));
    setIfChanged(fields, row.fields, ROI_FIELD_NAMES.pivotColumn, weekLabel(row.dateKey));
    setIfChanged(fields, row.fields, ROI_FIELD_NAMES.pivotDate, dateKeyToTimestamp(row.dateKey));
    setIfChanged(fields, row.fields, ROI_FIELD_NAMES.pivotSection, ROI_PIVOT_SECTIONS.detail);
    if (!isControlledDaily(row.product, row.metric)) {
      setIfChanged(
        fields,
        row.fields,
        ROI_FIELD_NAMES.recordRole,
        ROI_RECORD_ROLES.manualInput,
      );
    }
    const ratio = ROI_RATIO_RULES[row.metric];
    if (ratio && !isControlledDaily(row.product, row.metric)) {
      setIfChanged(
        fields,
        row.fields,
        ROI_FIELD_NAMES.value,
        ratioValue(sourceDetails, row.product, ratio, (item) => item.dateKey === row.dateKey),
      );
    }
    if (Object.keys(fields).length) updates.push({ recordId: row.recordId, fields });
  }
  const computedDetails = reconcileComputedDailyRows(
    parsed,
    sourceDetails,
    updates,
    creates,
    deleteIds,
    formulaInputs,
  );
  const effectiveDetails = [...sourceDetails, ...computedDetails];
  const monthsByProduct = productMonths(
    metricPairs,
    effectiveDetails,
    currentMonth,
    templateMonths,
  );
  reconcileInputTemplates(
    parsed,
    metricPairs,
    effectiveDetails,
    currentDate,
    updates,
    creates,
    deleteIds,
  );
  for (const [product, metric] of metricPairs) {
    const pairRows = parsed
      .filter((row) => row.product === product && row.metric === metric)
      .sort((a, b) => a.recordId.localeCompare(b.recordId));
    const allRows = pairRows.filter((row) => row.periodType === ROI_PERIOD_TYPES.allTotal);
    const monthRows = pairRows.filter((row) => row.periodType === ROI_PERIOD_TYPES.monthTotal);
    const placeholderRows = pairRows.filter(
      (row) => row.periodType === ROI_PERIOD_TYPES.placeholder,
    );
    const obsoleteWeekRows = pairRows.filter((row) => row.periodType === "周合计");
    const allKeeper = allRows[0];
    const allValue = aggregateSummary(effectiveDetails, product, metric, () => true);
    if (allKeeper) {
      planSummaryUpdate(
        updates,
        allKeeper,
        ROI_PERIOD_TYPES.allTotal,
        "合计全部",
        allValue,
      );
    } else {
      creates.push(summaryCreate(product, metric, ROI_PERIOD_TYPES.allTotal, "合计全部", allValue));
    }
    for (const row of allRows.slice(1)) deleteIds.add(row.recordId);

    const desiredMonths = monthsByProduct.get(product) ?? [currentMonth];
    const monthRowsByMonth = new Map<string, ParsedRecord[]>();
    const reusableLegacyMonthRows: ParsedRecord[] = [];
    for (const row of monthRows) {
      const month = summaryMonth(row);
      if (!month) {
        reusableLegacyMonthRows.push(row);
        continue;
      }
      const grouped = monthRowsByMonth.get(month) ?? [];
      grouped.push(row);
      monthRowsByMonth.set(month, grouped);
    }
    for (const month of desiredMonths) {
      const matchingRows = monthRowsByMonth.get(month) ?? [];
      const monthKeeper = matchingRows[0] ?? reusableLegacyMonthRows.shift();
      const monthValue = aggregateSummary(
        effectiveDetails,
        product,
        metric,
        (row) => row.dateKey.startsWith(`${month}-`),
      );
      if (monthKeeper) {
        if (!matchingRows.length) reusedTemplateRows += 1;
        planSummaryUpdate(
          updates,
          monthKeeper,
          ROI_PERIOD_TYPES.monthTotal,
          monthTotalLabel(month),
          monthValue,
        );
      } else {
        creates.push(summaryCreate(
          product,
          metric,
          ROI_PERIOD_TYPES.monthTotal,
          monthTotalLabel(month),
          monthValue,
        ));
      }
      for (const row of matchingRows.slice(1)) deleteIds.add(row.recordId);
    }
    const desiredMonthSet = new Set(desiredMonths);
    for (const [month, rows] of monthRowsByMonth) {
      if (!desiredMonthSet.has(month)) {
        for (const row of rows) deleteIds.add(row.recordId);
      }
    }
    for (const row of reusableLegacyMonthRows) deleteIds.add(row.recordId);

    if (
      product === TECHWAVE_STORE_NAME
      && metric === TECHWAVE_STORE_METRICS[0]
    ) {
      reconcileCalendarScaffolds(
        placeholderRows,
        calendarDates,
        updates,
        creates,
        deleteIds,
      );
    } else {
      for (const row of placeholderRows) deleteIds.add(row.recordId);
    }
    for (const row of obsoleteWeekRows) deleteIds.add(row.recordId);
  }
  const optionNames = pivotOptionNames(
    effectiveDetails,
    currentMonth,
    calendarDates,
  );
  const survivingUpdates = mergeUpdates(updates)
    .filter((update) => !deleteIds.has(update.recordId));
  return {
    optionNames,
    updates: survivingUpdates,
    creates,
    deleteRecordIds: [...deleteIds].sort(),
    stats: {
      inputRecords: records.length,
      detailRecords: effectiveDetails.length,
      metricPairs: metricPairs.length,
      weeks: optionNames.filter((name) => /^第-?\d+周$/.test(name)).length,
      reusedTemplateRows,
      ratioMetrics: metricPairs.filter(([, metric]) => Boolean(ROI_RATIO_RULES[metric])).length,
    },
  };
}
function parseRecord(record: RoiApiRecord): ParsedRecord {
  const rawProduct = cellText(record.fields[ROI_FIELD_NAMES.product]);
  const rawMetric = cellText(record.fields[ROI_FIELD_NAMES.metric])
    || cellText(record.fields[ROI_FIELD_NAMES.metricDisplay]);
  return {
    ...record,
    product: normalizeProduct(rawProduct),
    rawProduct,
    metric: normalizeMetric(rawMetric),
    rawMetric,
    periodType: cellText(record.fields[ROI_FIELD_NAMES.periodType]),
    dateKey: dateKey(record.fields[ROI_FIELD_NAMES.date]),
    value: numberValue(record.fields[ROI_FIELD_NAMES.value]),
    recordRole: cellText(record.fields[ROI_FIELD_NAMES.recordRole]),
  };
}
function adoptProductAnchors(
  rows: ParsedRecord[],
  updates: RoiRecordUpdate[],
  deleteIds: Set<string>,
): void {
  const byProduct = new Map<string, ParsedRecord[]>();
  for (const row of rows) {
    if (
      !row.product
      || row.metric
      || (
        row.recordRole
        && row.recordRole !== ROI_RECORD_ROLES.inputTemplate
      )
    ) {
      continue;
    }
    const grouped = byProduct.get(row.product) ?? [];
    grouped.push(row);
    byProduct.set(row.product, grouped);
  }
  for (const [product, anchors] of byProduct) {
    const ordered = anchors.sort((left, right) => left.recordId.localeCompare(right.recordId));
    if (product === TECHWAVE_STORE_NAME) {
      for (const row of ordered) deleteIds.add(row.recordId);
      continue;
    }
    const adopted = ordered[0];
    if (!adopted) continue;
    adopted.metric = TECHWAVE_PRODUCT_METRICS[0];
    adopted.dateKey = "";
    adopted.value = null;
    adopted.periodType = "";
    adopted.recordRole = ROI_RECORD_ROLES.inputTemplate;
    const fields: Record<string, unknown> = {};
    setIfChanged(fields, adopted.fields, ROI_FIELD_NAMES.metric, adopted.metric);
    setIfChanged(fields, adopted.fields, ROI_FIELD_NAMES.value, null);
    setIfChanged(fields, adopted.fields, ROI_FIELD_NAMES.date, null);
    setIfChanged(fields, adopted.fields, ROI_FIELD_NAMES.remark, null);
    setIfChanged(fields, adopted.fields, ROI_FIELD_NAMES.periodType, null);
    setIfChanged(fields, adopted.fields, ROI_FIELD_NAMES.pivotColumn, null);
    setIfChanged(fields, adopted.fields, ROI_FIELD_NAMES.pivotDate, null);
    setIfChanged(fields, adopted.fields, ROI_FIELD_NAMES.pivotSection, null);
    setIfChanged(
      fields,
      adopted.fields,
      ROI_FIELD_NAMES.recordRole,
      ROI_RECORD_ROLES.inputTemplate,
    );
    if (Object.keys(fields).length) updates.push({ recordId: adopted.recordId, fields });
    for (const duplicate of ordered.slice(1)) deleteIds.add(duplicate.recordId);
  }
}

function promoteUndatedTemplateValues(
  rows: ParsedRecord[],
  currentDate: string,
  updates: RoiRecordUpdate[],
): void {
  for (const row of rows) {
    if (
      !row.product
      || !row.metric
      || row.dateKey
      || row.value === null
      || isControlledDaily(row.product, row.metric)
      || row.periodType
      || cellText(row.fields[ROI_FIELD_NAMES.pivotColumn])
      || cellText(row.fields[ROI_FIELD_NAMES.pivotDate])
      || (
        row.recordRole
        && row.recordRole !== ROI_RECORD_ROLES.inputTemplate
      )
    ) {
      continue;
    }
    row.dateKey = currentDate;
    row.recordRole = ROI_RECORD_ROLES.manualInput;
    updates.push({
      recordId: row.recordId,
      fields: {
        [ROI_FIELD_NAMES.date]: dateKeyToTimestamp(currentDate),
        [ROI_FIELD_NAMES.recordRole]: ROI_RECORD_ROLES.manualInput,
      },
    });
  }
}

function isIncompleteInputTemplate(row: ParsedRecord): boolean {
  return (
    (
      row.recordRole === ROI_RECORD_ROLES.inputTemplate
      || (
        !row.recordRole
        && !isControlledDaily(row.product, row.metric)
        && !ROI_RATIO_RULES[row.metric]
      )
    )
    && row.value === null
  );
}
function uniquePairs(rows: ParsedRecord[]): Array<[string, string]> {
  const pairs = new Map<string, [string, string]>();
  for (const metric of TECHWAVE_STORE_METRICS) {
    pairs.set(pairKey(TECHWAVE_STORE_NAME, metric), [TECHWAVE_STORE_NAME, metric]);
  }
  const products = new Set(
    rows
      .map((row) => row.product)
      .filter((product) => product && product !== TECHWAVE_STORE_NAME),
  );
  for (const product of products) {
    for (const metric of TECHWAVE_PRODUCT_METRICS) {
      pairs.set(pairKey(product, metric), [product, metric]);
    }
  }
  for (const row of rows) {
    if (!row.product || !row.metric) continue;
    pairs.set(pairKey(row.product, row.metric), [row.product, row.metric]);
  }
  const storeMetricOrder = new Map<string, number>(
    TECHWAVE_STORE_METRICS.map((metric, index) => [metric, index]),
  );
  const productMetricOrder = new Map<string, number>(
    TECHWAVE_PRODUCT_METRICS.map((metric, index) => [metric, index]),
  );
  return [...pairs.values()].sort(([ap, am], [bp, bm]) => {
    if (ap === TECHWAVE_STORE_NAME && bp !== TECHWAVE_STORE_NAME) return -1;
    if (bp === TECHWAVE_STORE_NAME && ap !== TECHWAVE_STORE_NAME) return 1;
    const productOrder = ap.localeCompare(bp, "zh-CN");
    if (productOrder) return productOrder;
    const order = ap === TECHWAVE_STORE_NAME ? storeMetricOrder : productMetricOrder;
    const ai = order.get(am) ?? Number.MAX_SAFE_INTEGER;
    const bi = order.get(bm) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return am.localeCompare(bm, "zh-CN");
  });
}
function normalizeMetric(metric: string): string {
  return metric === "总数量量" ? "总数量" : metric;
}
function normalizeProduct(product: string): string {
  const compact = product.replace(/\s+/g, "");
  return /^tech-?wav(?:e)?$/i.test(compact) ? TECHWAVE_STORE_NAME : product.trim();
}
function pairKey(product: string, metric: string): string {
  return `${product}\u0000${metric}`;
}
function isControlledDaily(product: string, metric: string): boolean {
  if (!product || !metric) return false;
  if (product !== TECHWAVE_STORE_NAME) {
    return metric === "合作量"
      || metric === "上线量"
      || Object.prototype.hasOwnProperty.call(PRODUCT_DERIVED_RULES, metric);
  }
  return Object.prototype.hasOwnProperty.call(STORE_PRODUCT_ROLLUPS, metric)
    || Object.prototype.hasOwnProperty.call(STORE_FORMULA_SUMS, metric)
    || metric === "转化率";
}
function isDailyRecord(row: ParsedRecord): boolean {
  return Boolean(
    row.product
    && row.metric
    && row.dateKey
    && !summaryTypes.has(row.periodType)
    && row.periodType !== ROI_PERIOD_TYPES.placeholder,
  );
}
function reconcileInputTemplates(
  rows: ParsedRecord[],
  pairs: Array<[string, string]>,
  effectiveDetails: ParsedRecord[],
  currentDate: string,
  updates: RoiRecordUpdate[],
  creates: Array<{ fields: Record<string, unknown> }>,
  deleteIds: Set<string>,
): void {
  for (const [product, metric] of pairs) {
    const controlled = isControlledDaily(product, metric);
    const templateRows = rows
      .filter((row) => (
        row.product === product
        && row.metric === metric
        && (
          (!row.dateKey && (controlled || row.value === null))
          || (row.dateKey && row.value === null && isIncompleteInputTemplate(row))
        )
        && !row.periodType
        && !cellText(row.fields[ROI_FIELD_NAMES.pivotColumn])
        && !cellText(row.fields[ROI_FIELD_NAMES.pivotDate])
      ))
      .sort((left, right) => left.recordId.localeCompare(right.recordId));
    const owned = templateRows.filter(
      (row) => row.recordRole === ROI_RECORD_ROLES.inputTemplate,
    );
    const adopted = owned[0] ?? templateRows.find((row) => !row.recordRole);
    const currentValue = controlled
      ? aggregate(
        effectiveDetails,
        product,
        metric,
        (row) => row.dateKey === currentDate,
      )
      : undefined;
    if (adopted) {
      const fields: Record<string, unknown> = {};
      setIfChanged(
        fields,
        adopted.fields,
        ROI_FIELD_NAMES.recordRole,
        ROI_RECORD_ROLES.inputTemplate,
      );
      setIfChanged(fields, adopted.fields, ROI_FIELD_NAMES.pivotSection, null);
      if (controlled) {
        setIfChanged(fields, adopted.fields, ROI_FIELD_NAMES.value, currentValue ?? null);
      }
      if (Object.keys(fields).length) updates.push({ recordId: adopted.recordId, fields });
    } else {
      creates.push({
        fields: {
          [ROI_FIELD_NAMES.product]: product,
          [ROI_FIELD_NAMES.metric]: metric,
          ...(controlled ? { [ROI_FIELD_NAMES.value]: currentValue ?? null } : {}),
          [ROI_FIELD_NAMES.recordRole]: ROI_RECORD_ROLES.inputTemplate,
        },
      });
    }
    for (const row of templateRows) {
      if (row.recordId !== adopted?.recordId) deleteIds.add(row.recordId);
    }
  }
}
interface DesiredDailyRow {
  product: string;
  metric: string;
  dateKey: string;
  value: number | null;
  recordRole: string;
}
function reconcileComputedDailyRows(
  parsed: ParsedRecord[],
  sourceDetails: ParsedRecord[],
  updates: RoiRecordUpdate[],
  creates: Array<{ fields: Record<string, unknown> }>,
  deleteIds: Set<string>,
  formulaInputs: readonly RoiFormulaInput[],
): ParsedRecord[] {
  const existingDaily = parsed.filter(isDailyRecord);
  const desired: DesiredDailyRow[] = [];
  const products = new Set(
    parsed
      .map((row) => row.product)
      .filter((product) => product && product !== TECHWAVE_STORE_NAME),
  );

  const externalValues = new Map<string, number>();
  for (const input of formulaInputs) {
    const product = normalizeProduct(input.product);
    const inputDate = dateKey(input.date);
    if (!products.has(product) || !inputDate) continue;
    const key = `${pairKey(product, input.metric)}\u0000${inputDate}`;
    externalValues.set(key, (externalValues.get(key) ?? 0) + (input.value ?? 1));
  }
  for (const product of products) {
    for (const metric of ["合作量", "上线量"] as const) {
      const dates = new Set<string>();
      const prefix = `${pairKey(product, metric)}\u0000`;
      for (const key of externalValues.keys()) {
        if (key.startsWith(prefix)) dates.add(key.slice(prefix.length));
      }
      for (const row of existingDaily) {
        if (row.product === product && row.metric === metric) dates.add(row.dateKey);
      }
      for (const currentDate of [...dates].filter(Boolean).sort()) {
        desired.push({
          product,
          metric,
          dateKey: currentDate,
          value: externalValues.get(`${prefix}${currentDate}`) ?? 0,
          recordRole: ROI_RECORD_ROLES.formula,
        });
      }
    }
  }

  const externalDetails = desired.map(desiredToParsed);
  const productSourceDetails = [...sourceDetails, ...externalDetails];
  for (const product of products) {
    for (const [metric, rule] of Object.entries(PRODUCT_DERIVED_RULES)) {
      const dates = desiredDates(
        productSourceDetails,
        existingDaily,
        product,
        metric,
        [rule.minuend, rule.subtrahend],
      );
      for (const currentDate of dates) {
        desired.push({
          product,
          metric,
          dateKey: currentDate,
          value: sourceSum(productSourceDetails, product, rule.minuend, currentDate)
            - sourceSum(productSourceDetails, product, rule.subtrahend, currentDate),
          recordRole: ROI_RECORD_ROLES.formula,
        });
      }
    }
  }

  const productDerived = desired.map(desiredToParsed);
  const productEffective = [...sourceDetails, ...productDerived];
  for (const [metric, sourceMetric] of Object.entries(STORE_PRODUCT_ROLLUPS)) {
    const dates = new Set(
      productEffective
        .filter((row) => row.product !== TECHWAVE_STORE_NAME && row.metric === sourceMetric)
        .map((row) => row.dateKey),
    );
    for (const row of existingDaily) {
      if (row.product === TECHWAVE_STORE_NAME && row.metric === metric) {
        dates.add(row.dateKey);
      }
    }
    for (const currentDate of [...dates].filter(Boolean).sort()) {
      desired.push({
        product: TECHWAVE_STORE_NAME,
        metric,
        dateKey: currentDate,
        value: productEffective
          .filter((row) => (
            row.product !== TECHWAVE_STORE_NAME
            && row.metric === sourceMetric
            && row.dateKey === currentDate
          ))
          .reduce((sum, row) => sum + (row.value ?? 0), 0),
        recordRole: ROI_RECORD_ROLES.productRollup,
      });
    }
  }

  for (const [metric, sourceMetrics] of Object.entries(STORE_FORMULA_SUMS)) {
    const dates = desiredDates(
      sourceDetails,
      existingDaily,
      TECHWAVE_STORE_NAME,
      metric,
      sourceMetrics,
    );
    for (const currentDate of dates) {
      desired.push({
        product: TECHWAVE_STORE_NAME,
        metric,
        dateKey: currentDate,
        value: sourceMetrics.reduce(
          (sum, sourceMetric) => (
            sum + sourceSum(sourceDetails, TECHWAVE_STORE_NAME, sourceMetric, currentDate)
          ),
          0,
        ),
        recordRole: ROI_RECORD_ROLES.formula,
      });
    }
  }

  const beforeConversion = [...sourceDetails, ...desired.map(desiredToParsed)];
  const conversionDates = desiredDates(
    beforeConversion,
    existingDaily,
    TECHWAVE_STORE_NAME,
    "转化率",
    ["总单量", "店铺浏览量"],
  );
  for (const currentDate of conversionDates) {
    const numerator = sourceSum(
      beforeConversion,
      TECHWAVE_STORE_NAME,
      "总单量",
      currentDate,
    );
    const denominator = sourceSum(
      beforeConversion,
      TECHWAVE_STORE_NAME,
      "店铺浏览量",
      currentDate,
    );
    desired.push({
      product: TECHWAVE_STORE_NAME,
      metric: "转化率",
      dateKey: currentDate,
      value: denominator === 0 ? null : numerator / denominator,
      recordRole: ROI_RECORD_ROLES.formula,
    });
  }

  for (const target of desired) {
    const matches = existingDaily
      .filter((row) => (
        row.product === target.product
        && row.metric === target.metric
        && row.dateKey === target.dateKey
      ))
      .sort((left, right) => {
        const leftOwned = left.recordRole === target.recordRole ? 0 : 1;
        const rightOwned = right.recordRole === target.recordRole ? 0 : 1;
        return leftOwned - rightOwned || left.recordId.localeCompare(right.recordId);
      });
    const keeper = matches[0];
    if (keeper) {
      planDailyUpdate(updates, keeper, target);
    } else {
      creates.push({ fields: dailyFields(target) });
    }
    for (const duplicate of matches.slice(1)) deleteIds.add(duplicate.recordId);
  }
  return desired.map(desiredToParsed);
}
function desiredDates(
  sourceRows: ParsedRecord[],
  existingRows: ParsedRecord[],
  product: string,
  controlledMetric: string,
  sourceMetrics: readonly string[],
): string[] {
  const sourceMetricSet = new Set(sourceMetrics);
  const dates = new Set(
    sourceRows
      .filter((row) => row.product === product && sourceMetricSet.has(row.metric))
      .map((row) => row.dateKey),
  );
  for (const row of existingRows) {
    if (row.product === product && row.metric === controlledMetric) dates.add(row.dateKey);
  }
  return [...dates].filter(Boolean).sort();
}
function sourceSum(
  rows: ParsedRecord[],
  product: string,
  metric: string,
  currentDate: string,
): number {
  return rows
    .filter((row) => (
      row.product === product
      && row.metric === metric
      && row.dateKey === currentDate
    ))
    .reduce((sum, row) => sum + (row.value ?? 0), 0);
}
function desiredToParsed(row: DesiredDailyRow): ParsedRecord {
  const fields = dailyFields(row);
  return {
    recordId: `computed:${pairKey(row.product, row.metric)}:${row.dateKey}`,
    fields,
    product: row.product,
    rawProduct: row.product,
    metric: row.metric,
    rawMetric: row.metric,
    periodType: dayPeriod(row.dateKey),
    dateKey: row.dateKey,
    value: row.value,
    recordRole: row.recordRole,
  };
}
function dailyFields(row: DesiredDailyRow): Record<string, unknown> {
  const timestamp = dateKeyToTimestamp(row.dateKey);
  return {
    [ROI_FIELD_NAMES.product]: row.product,
    [ROI_FIELD_NAMES.metric]: row.metric,
    [ROI_FIELD_NAMES.date]: timestamp,
    [ROI_FIELD_NAMES.value]: row.value,
    [ROI_FIELD_NAMES.periodType]: dayPeriod(row.dateKey),
    [ROI_FIELD_NAMES.pivotColumn]: weekLabel(row.dateKey),
    [ROI_FIELD_NAMES.pivotDate]: timestamp,
    [ROI_FIELD_NAMES.pivotSection]: ROI_PIVOT_SECTIONS.detail,
    [ROI_FIELD_NAMES.recordRole]: row.recordRole,
  };
}
function planDailyUpdate(
  updates: RoiRecordUpdate[],
  row: ParsedRecord,
  desired: DesiredDailyRow,
): void {
  const fields: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(dailyFields(desired))) {
    setIfChanged(fields, row.fields, field, value);
  }
  if (Object.keys(fields).length) updates.push({ recordId: row.recordId, fields });
}
function productMonths(
  pairs: Array<[string, string]>,
  details: ParsedRecord[],
  currentMonth: string,
  templateMonths: readonly string[],
): Map<string, string[]> {
  const byProduct = new Map<string, Set<string>>();
  for (const [product] of pairs) {
    const months = byProduct.get(product) ?? new Set<string>();
    months.add(currentMonth);
    if (product === TECHWAVE_STORE_NAME) {
      for (const month of templateMonths) months.add(month);
    }
    byProduct.set(product, months);
  }
  for (const row of details) {
    const months = byProduct.get(row.product) ?? new Set<string>();
    months.add(row.dateKey.slice(0, 7));
    byProduct.set(row.product, months);
  }
  return new Map(
    [...byProduct].map(([product, months]) => [
      product,
      [...months].sort((a, b) => b.localeCompare(a)),
    ]),
  );
}
function summaryMonth(row: ParsedRecord): string {
  const fromPivot = monthKeyFromLabel(cellText(row.fields[ROI_FIELD_NAMES.pivotColumn]));
  if (fromPivot) return fromPivot;
  return normalizeMonthKey(cellText(row.fields[ROI_FIELD_NAMES.month]));
}
function monthKeyFromLabel(label: string): string {
  const match = /^合计(\d{4})年(\d{1,2})月$/.exec(label);
  if (!match) return "";
  return normalizeMonthKey(`${match[1]}-${match[2]}`);
}
function normalizeMonthKey(value: string): string {
  const match = /^(\d{4})-(\d{1,2})$/.exec(value.trim());
  if (!match) return "";
  const month = Number(match[2]);
  return month >= 1 && month <= 12
    ? `${match[1]}-${String(month).padStart(2, "0")}`
    : "";
}
function pivotOptionNames(
  details: ParsedRecord[],
  currentMonth: string,
  calendarDates: readonly string[],
): string[] {
  const dates = new Set([
    ...calendarDates,
    ...details.map((row) => row.dateKey),
  ]);
  const months = new Set<string>([currentMonth]);
  const latestDateByWeek = new Map<string, string>();
  for (const key of dates) {
    months.add(key.slice(0, 7));
    const week = weekLabel(key);
    const existing = latestDateByWeek.get(week);
    if (!existing || key > existing) latestDateByWeek.set(week, key);
  }
  const weeksByMonth = new Map<string, Array<{ week: string; date: string }>>();
  for (const [week, latestDate] of latestDateByWeek) {
    const month = latestDate.slice(0, 7);
    const weeks = weeksByMonth.get(month) ?? [];
    weeks.push({ week, date: latestDate });
    weeksByMonth.set(month, weeks);
  }
  const names = ["合计全部"];
  for (const month of [...months].sort((a, b) => b.localeCompare(a))) {
    names.push(monthTotalLabel(month));
    const weeks = weeksByMonth.get(month) ?? [];
    weeks.sort((a, b) => b.date.localeCompare(a.date));
    names.push(...weeks.map(({ week }) => week));
  }
  return names;
}
function templateCalendarDates(currentDate: string): string[] {
  const start = Date.parse(`${ROI_TEMPLATE_START_DATE}T00:00:00Z`);
  const endKey = monthEndKey(currentDate);
  const end = Date.parse(`${endKey}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return [currentDate];
  }
  const dates: string[] = [];
  for (let timestamp = start; timestamp <= end; timestamp += 86_400_000) {
    dates.push(new Date(timestamp).toISOString().slice(0, 10));
  }
  return dates;
}
function monthEndKey(key: string): string {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(key);
  if (!match) return key;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}
function aggregate(
  details: ParsedRecord[],
  product: string,
  metric: string,
  predicate: (row: ParsedRecord) => boolean,
): number | null {
  const rule = ROI_RATIO_RULES[metric];
  if (rule) return ratioValue(details, product, rule, predicate);
  const values = details
    .filter((row) => row.product === product && row.metric === metric && predicate(row))
    .map((row) => row.value)
    .filter((value): value is number => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : 0;
}
function aggregateSummary(
  details: ParsedRecord[],
  product: string,
  metric: string,
  predicate: (row: ParsedRecord) => boolean,
): number | null {
  if (product !== TECHWAVE_STORE_NAME && PRODUCT_UNSUMMARIZED_METRICS.has(metric)) {
    return null;
  }
  if (
    AVERAGE_SUMMARY_METRICS.has(metric)
    || (product === TECHWAVE_STORE_NAME && STORE_AVERAGE_SUMMARY_METRICS.has(metric))
  ) {
    const dailyValues = details
      .filter((row) => row.product === product && row.metric === metric && predicate(row))
      .map((row) => row.value)
      .filter((value): value is number => value !== null);
    return dailyValues.length
      ? dailyValues.reduce((sum, value) => sum + value, 0) / dailyValues.length
      : null;
  }
  return aggregate(details, product, metric, predicate);
}
function ratioValue(
  details: ParsedRecord[],
  product: string,
  rule: RatioRule,
  predicate: (row: ParsedRecord) => boolean,
): number | null {
  const sum = (metric: string): number | null => {
    const values = details
      .filter((row) => row.product === product && row.metric === metric && predicate(row))
      .map((row) => row.value)
      .filter((value): value is number => value !== null);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const numerator = sum(rule.numerator);
  const denominator = sum(rule.denominator);
  return numerator === null || denominator === null || denominator === 0
    ? null
    : numerator / denominator;
}
function planSummaryUpdate(
  updates: RoiRecordUpdate[],
  row: ParsedRecord,
  periodType: string,
  pivotColumn: string,
  value: number | null,
): void {
  const fields: Record<string, unknown> = {};
  setIfChanged(fields, row.fields, ROI_FIELD_NAMES.periodType, periodType);
  setIfChanged(fields, row.fields, ROI_FIELD_NAMES.date, null);
  setIfChanged(fields, row.fields, ROI_FIELD_NAMES.pivotColumn, pivotColumn);
  setIfChanged(fields, row.fields, ROI_FIELD_NAMES.pivotDate, null);
  setIfChanged(fields, row.fields, ROI_FIELD_NAMES.pivotSection, ROI_PIVOT_SECTIONS.summary);
  setIfChanged(fields, row.fields, ROI_FIELD_NAMES.value, value);
  setIfChanged(
    fields,
    row.fields,
    ROI_FIELD_NAMES.recordRole,
    ROI_RECORD_ROLES.summary,
  );
  if (Object.keys(fields).length) updates.push({ recordId: row.recordId, fields });
}
function summaryCreate(
  product: string,
  metric: string,
  periodType: string,
  pivotColumn: string,
  value: number | null,
): { fields: Record<string, unknown> } {
  return {
    fields: {
      [ROI_FIELD_NAMES.product]: product,
      [ROI_FIELD_NAMES.metric]: metric,
      [ROI_FIELD_NAMES.periodType]: periodType,
      [ROI_FIELD_NAMES.value]: value,
      [ROI_FIELD_NAMES.pivotColumn]: pivotColumn,
      [ROI_FIELD_NAMES.pivotSection]: ROI_PIVOT_SECTIONS.summary,
      [ROI_FIELD_NAMES.recordRole]: ROI_RECORD_ROLES.summary,
    },
  };
}
function planPlaceholderUpdate(
  updates: RoiRecordUpdate[],
  row: ParsedRecord,
  currentDate: string,
): void {
  const timestamp = dateKeyToTimestamp(currentDate);
  const fields: Record<string, unknown> = {};
  setIfChanged(fields, row.fields, ROI_FIELD_NAMES.periodType, ROI_PERIOD_TYPES.placeholder);
  setIfChanged(fields, row.fields, ROI_FIELD_NAMES.date, timestamp);
  setIfChanged(fields, row.fields, ROI_FIELD_NAMES.pivotColumn, weekLabel(currentDate));
  setIfChanged(fields, row.fields, ROI_FIELD_NAMES.pivotDate, timestamp);
  setIfChanged(fields, row.fields, ROI_FIELD_NAMES.pivotSection, ROI_PIVOT_SECTIONS.detail);
  setIfChanged(fields, row.fields, ROI_FIELD_NAMES.value, 0);
  setIfChanged(
    fields,
    row.fields,
    ROI_FIELD_NAMES.recordRole,
    ROI_RECORD_ROLES.calendar,
  );
  if (Object.keys(fields).length) updates.push({ recordId: row.recordId, fields });
}
function placeholderCreate(
  product: string,
  metric: string,
  currentDate: string,
): { fields: Record<string, unknown> } {
  const timestamp = dateKeyToTimestamp(currentDate);
  return {
    fields: {
      [ROI_FIELD_NAMES.product]: product,
      [ROI_FIELD_NAMES.metric]: metric,
      [ROI_FIELD_NAMES.periodType]: ROI_PERIOD_TYPES.placeholder,
      [ROI_FIELD_NAMES.date]: timestamp,
      [ROI_FIELD_NAMES.value]: 0,
      [ROI_FIELD_NAMES.pivotColumn]: weekLabel(currentDate),
      [ROI_FIELD_NAMES.pivotDate]: timestamp,
      [ROI_FIELD_NAMES.pivotSection]: ROI_PIVOT_SECTIONS.detail,
      [ROI_FIELD_NAMES.recordRole]: ROI_RECORD_ROLES.calendar,
    },
  };
}
function reconcileCalendarScaffolds(
  rows: ParsedRecord[],
  desiredDates: readonly string[],
  updates: RoiRecordUpdate[],
  creates: Array<{ fields: Record<string, unknown> }>,
  deleteIds: Set<string>,
): void {
  const byDate = new Map<string, ParsedRecord[]>();
  for (const row of rows) {
    const grouped = byDate.get(row.dateKey) ?? [];
    grouped.push(row);
    byDate.set(row.dateKey, grouped);
  }
  const desired = new Set(desiredDates);
  for (const key of desiredDates) {
    const matching = byDate.get(key) ?? [];
    const keeper = matching[0];
    if (keeper) {
      planPlaceholderUpdate(updates, keeper, key);
    } else {
      creates.push(placeholderCreate(
        TECHWAVE_STORE_NAME,
        TECHWAVE_STORE_METRICS[0],
        key,
      ));
    }
    for (const row of matching.slice(1)) deleteIds.add(row.recordId);
  }
  for (const row of rows) {
    if (!desired.has(row.dateKey)) deleteIds.add(row.recordId);
  }
}
function mergeUpdates(updates: RoiRecordUpdate[]): RoiRecordUpdate[] {
  const merged = new Map<string, Record<string, unknown>>();
  for (const update of updates) {
    merged.set(update.recordId, { ...(merged.get(update.recordId) ?? {}), ...update.fields });
  }
  return [...merged]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([recordId, fields]) => ({ recordId, fields }));
}
function setIfChanged(
  target: Record<string, unknown>,
  current: Record<string, unknown>,
  field: string,
  desired: unknown,
): void {
  const actual = current[field];
  if (desired === null && (actual === null || actual === undefined || actual === "")) return;
  if (typeof desired === "number" && numberValue(actual) === desired) return;
  if (typeof desired === "string" && cellText(actual) === desired) return;
  target[field] = desired;
}
export function weekLabel(value: unknown): string {
  const key = dateKey(value);
  if (!key) return "";
  const days = Math.round(
    (Date.parse(`${key}T00:00:00Z`) - Date.parse(`${ROI_WEEK_EPOCH}T00:00:00Z`))
      / 86_400_000,
  );
  return `第${Math.ceil(days / 7)}周`;
}
export function monthTotalLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? `合计${match[1]}年${Number(match[2])}月` : "合计当月";
}
function dayPeriod(key: string): string {
  const day = new Date(`${key}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6 ? ROI_PERIOD_TYPES.weekend : ROI_PERIOD_TYPES.workday;
}
function dateKeyToTimestamp(key: string): number {
  return Date.parse(`${key}T12:00:00Z`);
}
function dateKey(value: unknown): string {
  if (typeof value === "string") {
    const direct = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
    if (direct) return `${direct[1]}-${direct[2]}-${direct[3]}`;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return dateKey(numeric);
    return "";
  }
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const parts = shanghaiDate.formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes): string => (
    parts.find((item) => item.type === type)?.value ?? ""
  );
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function cellText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(cellText).join("").trim();
  if (value && typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "").trim();
  }
  return value === null || value === undefined ? "" : String(value).trim();
}
function numberValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
