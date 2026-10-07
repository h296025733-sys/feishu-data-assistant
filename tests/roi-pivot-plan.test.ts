import { describe, expect, it } from "vitest";
import {
  ROI_FIELD_NAMES as F,
  ROI_PERIOD_TYPES as P,
  ROI_PIVOT_SECTIONS as S,
  ROI_RECORD_ROLES as R,
  TECHWAVE_PRODUCT_METRICS,
  TECHWAVE_STORE_METRICS,
  TECHWAVE_STORE_NAME,
  buildRoiPivotPlan,
  monthTotalLabel,
  weekLabel,
  type RoiApiRecord,
  type RoiPivotPlan,
} from "../src/feishu/roi-pivot-plan.js";

const NOW = Date.UTC(2026, 6, 29, 4);
const CURRENT_MONTH_LABEL = "合计2026年7月";

function row(
  recordId: string,
  product: string,
  metric: string,
  extra: Record<string, unknown> = {},
): RoiApiRecord {
  return { recordId, fields: { [F.product]: product, [F.metric]: metric, ...extra } };
}

function update(plan: RoiPivotPlan, recordId: string): Record<string, unknown> {
  return plan.updates.find((item) => item.recordId === recordId)?.fields ?? {};
}

function matchingCreates(
  plan: RoiPivotPlan,
  product: string,
  metric: string,
  periodType: string,
): Array<Record<string, unknown>> {
  return plan.creates
    .map((item) => item.fields)
    .filter((fields) => (
      fields[F.product] === product
      && fields[F.metric] === metric
      && fields[F.periodType] === periodType
    ));
}

function summaryValue(
  plan: RoiPivotPlan,
  records: RoiApiRecord[],
  product: string,
  metric: string,
  pivotColumn: string,
): unknown {
  const deleted = new Set(plan.deleteRecordIds);
  const existing = records
    .filter((item) => !deleted.has(item.recordId))
    .map((item) => ({ ...item.fields, ...update(plan, item.recordId) }))
    .find((fields) => (
      fields[F.product] === product
      && fields[F.metric] === metric
      && fields[F.pivotColumn] === pivotColumn
    ));
  if (existing) {
    return existing[F.value];
  }
  return plan.creates.find((item) => (
    item.fields[F.product] === product
    && item.fields[F.metric] === metric
    && item.fields[F.pivotColumn] === pivotColumn
  ))?.fields[F.value];
}

function dailyValue(
  plan: RoiPivotPlan,
  records: RoiApiRecord[],
  product: string,
  metric: string,
  date: string,
): unknown {
  const targetDate = (value: unknown): string => {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0
      ? new Date(timestamp).toISOString().slice(0, 10)
      : "";
  };
  const deleted = new Set(plan.deleteRecordIds);
  const existing = records
    .filter((item) => !deleted.has(item.recordId))
    .map((item) => ({ ...item.fields, ...update(plan, item.recordId) }))
    .find((fields) => (
      fields[F.product] === product
      && fields[F.metric] === metric
      && targetDate(fields[F.date]) === date
    ));
  if (existing) return existing[F.value];
  return plan.creates.find((item) => (
    item.fields[F.product] === product
    && item.fields[F.metric] === metric
    && targetDate(item.fields[F.date]) === date
  ))?.fields[F.value];
}

function applyPlan(records: RoiApiRecord[], plan: RoiPivotPlan): RoiApiRecord[] {
  const deleted = new Set(plan.deleteRecordIds);
  const updates = new Map(plan.updates.map((item) => [item.recordId, item.fields]));
  const kept = records
    .filter((item) => !deleted.has(item.recordId))
    .map((item) => ({ ...item, fields: { ...item.fields, ...updates.get(item.recordId) } }));
  return [
    ...kept,
    ...plan.creates.map((item, index) => ({
      recordId: `created-${index}`,
      fields: item.fields,
    })),
  ];
}

describe("buildRoiPivotPlan", () => {
  it("bootstraps the complete ordered TechWave store metric template from an empty table", () => {
    const plan = buildRoiPivotPlan([], NOW);
    const allTotalMetrics = plan.creates
      .filter((item) => (
        item.fields[F.product] === TECHWAVE_STORE_NAME
        && item.fields[F.periodType] === P.allTotal
      ))
      .map((item) => item.fields[F.metric]);

    expect(TECHWAVE_STORE_METRICS).toEqual([
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
    ]);
    expect(allTotalMetrics).toEqual([...TECHWAVE_STORE_METRICS]);
    expect(plan.stats.metricPairs).toBe(21);
    expect(plan.creates).toHaveLength((21 * 17) + 487 + 21);
    expect(plan.optionNames.slice(0, 7)).toEqual([
      "合计全部",
      CURRENT_MONTH_LABEL,
      "第71周",
      "第70周",
      "第69周",
      "第68周",
      "第67周",
    ]);
    expect(plan.creates.filter((item) => item.fields[F.pivotSection] === S.summary))
      .toHaveLength(21 * 17);
    expect(plan.creates.filter((item) => item.fields[F.pivotSection] === S.detail))
      .toHaveLength(487);
    expect(plan.creates.filter((item) => item.fields[F.recordRole] === R.inputTemplate))
      .toHaveLength(21);
    const scaffoldDates = plan.creates
      .filter((item) => item.fields[F.periodType] === P.placeholder)
      .map((item) => new Date(Number(item.fields[F.date])).toISOString().slice(0, 10));
    expect(scaffoldDates[0]).toBe("2025-04-01");
    expect(scaffoldDates.at(-1)).toBe("2026-07-31");
  });

  it("normalizes the source typo 总数量量 without creating a second metric pair", () => {
    const plan = buildRoiPivotPlan([
      row("quantity", TECHWAVE_STORE_NAME, "总数量量", {
        [F.date]: "2026-07-28",
        [F.value]: 9,
      }),
    ], NOW);

    expect(update(plan, "quantity")).toMatchObject({
      [F.metric]: "总数量",
      [F.periodType]: P.workday,
      [F.pivotColumn]: "第71周",
      [F.pivotSection]: S.detail,
    });
    expect(plan.stats.metricPairs).toBe(21);
    expect(plan.creates.some((item) => item.fields[F.metric] === "总数量量")).toBe(false);
  });

  it("creates exactly one total for every detail month plus the current month", () => {
    const records = [
      row("detail-may", "商品A", "销售额", { [F.date]: "2026-05-15", [F.value]: 5 }),
      row("detail-june", "商品A", "销售额", { [F.date]: "2026-06-15", [F.value]: 7 }),
      row("all", "商品A", "销售额", {
        [F.periodType]: P.allTotal,
        [F.pivotColumn]: "合计全部",
      }),
      row("may-a", "商品A", "销售额", {
        [F.periodType]: P.monthTotal,
        [F.pivotColumn]: "合计2026年5月",
      }),
      row("may-b", "商品A", "销售额", {
        [F.periodType]: P.monthTotal,
        [F.pivotColumn]: "合计2026年5月",
      }),
      row("june", "商品A", "销售额", {
        [F.periodType]: P.monthTotal,
        [F.pivotColumn]: "合计2026年6月",
      }),
      row("stale-april", "商品A", "销售额", {
        [F.periodType]: P.monthTotal,
        [F.pivotColumn]: "合计2026年4月",
      }),
      row("legacy-current", "商品A", "销售额", { [F.periodType]: P.monthTotal }),
    ];

    const first = buildRoiPivotPlan(records, NOW);
    const applied = applyPlan(records, first);
    const productMonthRows = applied.filter((item) => (
      item.fields[F.product] === "商品A"
      && item.fields[F.metric] === "销售额"
      && item.fields[F.periodType] === P.monthTotal
    ));

    expect(productMonthRows.map((item) => item.fields[F.pivotColumn]).sort()).toEqual([
      "合计2026年5月",
      "合计2026年6月",
      "合计2026年7月",
    ]);
    expect(first.deleteRecordIds).toEqual(expect.arrayContaining(["may-b", "stale-april"]));
    expect(first.deleteRecordIds).not.toEqual(expect.arrayContaining(["may-a", "june"]));
    expect(summaryValue(first, records, "商品A", "销售额", "合计2026年5月")).toBe(5);
    expect(summaryValue(first, records, "商品A", "销售额", "合计2026年6月")).toBe(7);
    expect(summaryValue(first, records, "商品A", "销售额", CURRENT_MONTH_LABEL)).toBe(0);
    expect(first.updates.find((item) => item.recordId === "all")?.fields[F.pivotSection])
      .toBe(S.summary);
    expect(first.updates.find((item) => item.recordId === "may-a")?.fields[F.pivotSection])
      .toBe(S.summary);

    const second = buildRoiPivotPlan(applied, NOW);
    expect(second.updates).toEqual([]);
    expect(second.creates).toEqual([]);
    expect(second.deleteRecordIds).toEqual([]);
  });

  it("computes daily, monthly, and all-time ratios from numerator sums divided by denominator sums", () => {
    const records = [
      row("order-june", "商品A", "总单量", { [F.date]: "2026-06-28", [F.value]: 10 }),
      row("view-june", "商品A", "店铺浏览量", { [F.date]: "2026-06-28", [F.value]: 100 }),
      row("rate-june", "商品A", "转化率", { [F.date]: "2026-06-28", [F.value]: 999 }),
      row("order-july", "商品A", "总单量", { [F.date]: "2026-07-28", [F.value]: 20 }),
      row("view-july", "商品A", "店铺浏览量", { [F.date]: "2026-07-28", [F.value]: 400 }),
      row("rate-july", "商品A", "转化率", { [F.date]: "2026-07-28" }),
    ];

    const plan = buildRoiPivotPlan(records, NOW);

    expect(update(plan, "rate-june")[F.value]).toBeCloseTo(10 / 100);
    expect(update(plan, "rate-july")[F.value]).toBeCloseTo(20 / 400);
    expect(summaryValue(plan, records, "商品A", "转化率", "合计全部")).toBeCloseTo(30 / 500);
    expect(summaryValue(plan, records, "商品A", "转化率", "合计2026年6月")).toBeCloseTo(0.1);
    expect(summaryValue(plan, records, "商品A", "转化率", CURRENT_MONTH_LABEL)).toBeCloseTo(0.05);
  });

  it("averages product ordering videos and keeps self-operated optional metrics blank", () => {
    const records = [
      row("video-a", "商品A", "出单视频", {
        [F.date]: "2026-07-27",
        [F.value]: 5,
      }),
      row("video-b", "商品A", "出单视频", {
        [F.date]: "2026-07-28",
        [F.value]: 7,
      }),
      row("self-order", "商品A", "自孵化出单量", {
        [F.date]: "2026-07-28",
        [F.value]: 3,
      }),
      row("self-launch", "商品A", "自孵化上线量", {
        [F.date]: "2026-07-28",
        [F.value]: 2,
      }),
    ];

    const plan = buildRoiPivotPlan(records, NOW);

    expect(summaryValue(plan, records, "商品A", "出单视频", CURRENT_MONTH_LABEL)).toBe(6);
    expect(summaryValue(plan, records, "商品A", "出单视频", "合计全部")).toBe(6);
    for (const metric of ["自孵化出单量", "自孵化上线量"]) {
      expect(summaryValue(plan, records, "商品A", metric, CURRENT_MONTH_LABEL)).toBeNull();
      expect(summaryValue(plan, records, "商品A", metric, "合计全部")).toBeNull();
    }
    expect(dailyValue(plan, records, TECHWAVE_STORE_NAME, "出单视频", "2026-07-28"))
      .toBeUndefined();
  });

  it("creates one lightweight calendar scaffold per day and adopts safe blank rows as input templates", () => {
    const records = [
      row("sales-detail", TECHWAVE_STORE_NAME, "销售额", {
        [F.date]: "2026-07-28",
        [F.value]: 99,
      }),
      row("cooperation-editing", TECHWAVE_STORE_NAME, "合作量"),
      row("other-detail", "商品A", "销售额", {
        [F.date]: "2026-07-28",
        [F.value]: 10,
      }),
      row("other-editing", "商品A", "单量"),
    ];

    const plan = buildRoiPivotPlan(records, NOW);

    expect(matchingCreates(
      plan,
      TECHWAVE_STORE_NAME,
      "销售额",
      P.placeholder,
    )).toHaveLength(0);
    expect(matchingCreates(
      plan,
      TECHWAVE_STORE_NAME,
      "合作量",
      P.placeholder,
    )).toHaveLength(487);
    expect(matchingCreates(plan, "商品A", "销售额", P.placeholder)).toHaveLength(0);
    expect(matchingCreates(plan, "商品A", "单量", P.placeholder)).toHaveLength(0);
    expect(update(plan, "cooperation-editing")).toEqual({
      [F.recordRole]: R.inputTemplate,
      [F.value]: 0,
    });
    expect(update(plan, "other-editing")).toEqual({ [F.recordRole]: R.inputTemplate });
    expect(plan.deleteRecordIds).not.toContain("cooperation-editing");
    expect(plan.deleteRecordIds).not.toContain("other-editing");
  });

  it("deduplicates summaries only within the same month and keeps different months", () => {
    const plan = buildRoiPivotPlan([
      row("detail-may", "商品A", "销售额", { [F.date]: "2026-05-10", [F.value]: 1 }),
      row("detail-june", "商品A", "销售额", { [F.date]: "2026-06-10", [F.value]: 1 }),
      row("all-a", "商品A", "销售额", { [F.periodType]: P.allTotal }),
      row("all-b", "商品A", "销售额", { [F.periodType]: P.allTotal }),
      row("may-a", "商品A", "销售额", {
        [F.periodType]: P.monthTotal,
        [F.pivotColumn]: "合计2026年5月",
      }),
      row("may-b", "商品A", "销售额", {
        [F.periodType]: P.monthTotal,
        [F.pivotColumn]: "合计2026年5月",
      }),
      row("june", "商品A", "销售额", {
        [F.periodType]: P.monthTotal,
        [F.pivotColumn]: "合计2026年6月",
      }),
    ], NOW);

    expect(plan.deleteRecordIds).toEqual(expect.arrayContaining(["all-b", "may-b"]));
    expect(plan.deleteRecordIds).not.toEqual(expect.arrayContaining(["may-a", "june"]));
    expect(matchingCreates(plan, "商品A", "销售额", P.monthTotal)).toHaveLength(1);
    expect(matchingCreates(plan, "商品A", "销售额", P.monthTotal)[0]?.[F.pivotColumn])
      .toBe(CURRENT_MONTH_LABEL);
  });

  it("uses zero for additive empty totals and blank for ratios with a zero denominator", () => {
    const records = [
      row("order", TECHWAVE_STORE_NAME, "总单量", {
        [F.date]: "2026-07-28",
        [F.value]: 5,
      }),
      row("view", TECHWAVE_STORE_NAME, "店铺浏览量", {
        [F.date]: "2026-07-28",
        [F.value]: 0,
      }),
    ];
    const plan = buildRoiPivotPlan(records, NOW);

    expect(summaryValue(
      plan,
      records,
      TECHWAVE_STORE_NAME,
      "合作量",
      "合计全部",
    )).toBe(0);
    expect(summaryValue(
      plan,
      records,
      TECHWAVE_STORE_NAME,
      "转化率",
      CURRENT_MONTH_LABEL,
    )).toBeNull();
  });

  it("orders month totals newest first and assigns every template week to one month only", () => {
    const records: RoiApiRecord[] = [];
    const newest = Date.UTC(2026, 6, 27, 12);
    for (let index = 0; index < 52; index += 1) {
      const timestamp = newest - (index * 7 * 86_400_000);
      records.push(row(`d-${index}`, "商品A", "销售额", {
        [F.date]: timestamp,
        [F.value]: 1,
      }));
    }
    const plan = buildRoiPivotPlan(records, NOW);
    const weeks = plan.optionNames.filter((name) => /^第-?\d+周$/.test(name));
    const months = plan.optionNames.filter((name) => /^合计\d{4}年\d+月$/.test(name));

    expect(weeks).toHaveLength(70);
    expect(new Set(weeks).size).toBe(70);
    expect(months).toEqual([...months].sort((a, b) => {
      const key = (value: string): string => {
        const match = /^合计(\d{4})年(\d+)月$/.exec(value);
        return `${match?.[1]}-${String(match?.[2]).padStart(2, "0")}`;
      };
      return key(b).localeCompare(key(a));
    }));
    expect(weeks.map((value) => Number(/\d+/.exec(value)?.[0]))).toEqual(
      [...weeks]
        .map((value) => Number(/\d+/.exec(value)?.[0]))
        .sort((a, b) => b - a),
    );
  });

  it("preloads every product metric when a product appears once", () => {
    const records = [
      row("new-product", "新品A", "", {}),
    ];
    const plan = buildRoiPivotPlan(records, NOW);
    const templates = [
      update(plan, "new-product")[F.metric],
      ...plan.creates
      .filter((item) => (
        item.fields[F.product] === "新品A"
        && item.fields[F.recordRole] === R.inputTemplate
      ))
        .map((item) => item.fields[F.metric]),
    ];

    expect(templates).toEqual([...TECHWAVE_PRODUCT_METRICS]);
    expect(update(plan, "new-product")).toMatchObject({
      [F.metric]: "合作量",
      [F.recordRole]: R.inputTemplate,
    });
    expect(plan.stats.metricPairs).toBe(21 + 12);
  });

  it("adopts only one concurrent product-name anchor and safely removes empty duplicates", () => {
    const records = [
      row("anchor-a", "杯子", "", {}),
      row("anchor-b", "杯子", "", {}),
    ];
    const first = buildRoiPivotPlan(records, NOW);

    expect(update(first, "anchor-a")).toMatchObject({
      [F.metric]: "合作量",
      [F.recordRole]: R.inputTemplate,
    });
    expect(first.deleteRecordIds).toContain("anchor-b");
    expect(first.creates.filter((item) => (
      item.fields[F.product] === "杯子"
      && item.fields[F.recordRole] === R.inputTemplate
    ))).toHaveLength(11);

    const second = buildRoiPivotPlan(applyPlan(records, first), NOW);
    expect(second.updates).toEqual([]);
    expect(second.creates).toEqual([]);
    expect(second.deleteRecordIds).toEqual([]);
  });

  it("adopts a view-inherited product anchor and clears fields that do not belong to creation", () => {
    const plan = buildRoiPivotPlan([
      row("anchor", "商品A", "", {
        [F.recordRole]: R.inputTemplate,
        [F.value]: 999,
        [F.date]: "2026-07-28",
        [F.remark]: "不应进入商品模板",
      }),
    ], NOW);

    expect(update(plan, "anchor")).toMatchObject({
      [F.metric]: "合作量",
      [F.value]: 0,
      [F.date]: null,
      [F.remark]: null,
    });
    expect(plan.deleteRecordIds).not.toContain("anchor");
  });

  it("turns a filled template into a detail and immediately replenishes a blank template", () => {
    const records = [
      row("filled-template", "商品A", "单量", {
        [F.recordRole]: R.inputTemplate,
        [F.date]: "2026-07-28",
        [F.value]: 8,
      }),
    ];
    const plan = buildRoiPivotPlan(records, NOW);

    expect(update(plan, "filled-template")).toMatchObject({
      [F.periodType]: P.workday,
      [F.pivotColumn]: "第71周",
      [F.recordRole]: R.manualInput,
    });
    expect(plan.creates.filter((item) => (
      item.fields[F.product] === "商品A"
      && item.fields[F.metric] === "单量"
      && item.fields[F.recordRole] === R.inputTemplate
    ))).toHaveLength(1);
  });

  it("dates a value-only template today, rolls it into TechWave, and replenishes input", () => {
    const records = [
      row("partial-template", "商品A", "销售额", {
        [F.recordRole]: R.inputTemplate,
        [F.value]: 88,
      }),
    ];
    const plan = buildRoiPivotPlan(records, NOW);

    expect(update(plan, "partial-template")).toMatchObject({
      [F.date]: Date.parse("2026-07-29T12:00:00Z"),
      [F.periodType]: P.workday,
      [F.recordRole]: R.manualInput,
    });
    expect(plan.deleteRecordIds).not.toContain("partial-template");
    expect(plan.creates.filter((item) => (
      item.fields[F.product] === "商品A"
      && item.fields[F.metric] === "销售额"
      && item.fields[F.recordRole] === R.inputTemplate
      && item.fields[F.value] === undefined
    ))).toHaveLength(1);
    expect(dailyValue(plan, records, TECHWAVE_STORE_NAME, "销售额", "2026-07-29")).toBe(88);
    expect(summaryValue(
      plan,
      records,
      TECHWAVE_STORE_NAME,
      "销售额",
      CURRENT_MONTH_LABEL,
    )).toBe(88);
  });

  it("shows controlled current-day calculations in the fixed visible templates", () => {
    const date = "2026-07-29";
    const records = [
      row("product-order", "商品A", "单量", {
        [F.date]: date,
        [F.value]: 8,
      }),
      row("product-card-order", "商品A", "商品卡出单量", {
        [F.date]: date,
        [F.value]: 3,
      }),
      row("product-derived-template", "商品A", "达人出单量", {
        [F.recordRole]: R.inputTemplate,
        [F.value]: 999,
      }),
      row("store-order-template", TECHWAVE_STORE_NAME, "总单量", {
        [F.recordRole]: R.inputTemplate,
        [F.value]: 999,
      }),
      row("store-derived-template", TECHWAVE_STORE_NAME, "达人出单量", {
        [F.recordRole]: R.inputTemplate,
        [F.value]: 999,
      }),
    ];

    const plan = buildRoiPivotPlan(records, NOW);

    expect(update(plan, "product-derived-template")).toEqual({ [F.value]: 5 });
    expect(update(plan, "store-order-template")).toEqual({ [F.value]: 8 });
    expect(update(plan, "store-derived-template")).toEqual({ [F.value]: 5 });
    expect(update(plan, "product-derived-template")[F.date]).toBeUndefined();
    expect(update(plan, "product-derived-template")[F.recordRole]).toBeUndefined();
  });

  it("keeps a date-only template visible until the value is supplied without duplicating it", () => {
    const records = [
      row("date-only", "商品A", "销售额", {
        [F.recordRole]: R.inputTemplate,
        [F.date]: "2026-07-28",
      }),
    ];
    const plan = buildRoiPivotPlan(records, NOW);

    expect(update(plan, "date-only")).toEqual({});
    expect(plan.deleteRecordIds).not.toContain("date-only");
    expect(plan.creates.filter((item) => (
      item.fields[F.product] === "商品A"
      && item.fields[F.metric] === "销售额"
      && item.fields[F.recordRole] === R.inputTemplate
    ))).toHaveLength(0);
  });

  it("derives product values, rolls all products into TechWave, and calculates store formulas", () => {
    const date = "2026-07-28";
    const records = [
      row("a-orders", "商品A", "单量", { [F.date]: date, [F.value]: 10 }),
      row("a-quantity", "商品A", "数量", { [F.date]: date, [F.value]: 12 }),
      row("a-card-orders", "商品A", "商品卡出单量", { [F.date]: date, [F.value]: 3 }),
      row("a-card-quantity", "商品A", "商品卡出单数量", { [F.date]: date, [F.value]: 4 }),
      row("a-sales", "商品A", "销售额", { [F.date]: date, [F.value]: 100 }),
      row("a-cooperation", "商品A", "合作量", { [F.date]: date, [F.value]: 2 }),
      row("a-launch", "商品A", "上线量", { [F.date]: date, [F.value]: 1 }),
      row("a-video", "商品A", "出单视频", { [F.date]: date, [F.value]: 5 }),
      row("b-orders", "商品B", "单量", { [F.date]: date, [F.value]: 5 }),
      row("b-quantity", "商品B", "数量", { [F.date]: date, [F.value]: 6 }),
      row("b-card-orders", "商品B", "商品卡出单量", { [F.date]: date, [F.value]: 1 }),
      row("b-card-quantity", "商品B", "商品卡出单数量", { [F.date]: date, [F.value]: 2 }),
      row("b-sales", "商品B", "销售额", { [F.date]: date, [F.value]: 50 }),
      row("traffic", TECHWAVE_STORE_NAME, "店铺浏览量", { [F.date]: date, [F.value]: 1000 }),
      row("yalan-orders", TECHWAVE_STORE_NAME, "雅岚广告出单量", {
        [F.date]: date,
        [F.value]: 2,
      }),
      row("k10-orders", TECHWAVE_STORE_NAME, "金凯悦-10广告出单量", {
        [F.date]: date,
        [F.value]: 3,
      }),
      row("k11-orders", TECHWAVE_STORE_NAME, "金凯悦-11广告出单量", {
        [F.date]: date,
        [F.value]: 4,
      }),
      row("gmv-orders", TECHWAVE_STORE_NAME, "GMV Max广告出单量", {
        [F.date]: date,
        [F.value]: 99,
      }),
      row("yalan-spend", TECHWAVE_STORE_NAME, "雅岚广告花费", {
        [F.date]: date,
        [F.value]: 10,
      }),
      row("k10-spend", TECHWAVE_STORE_NAME, "金凯悦-10广告花费", {
        [F.date]: date,
        [F.value]: 20,
      }),
      row("k11-spend", TECHWAVE_STORE_NAME, "金凯悦-11广告花费", {
        [F.date]: date,
        [F.value]: 30,
      }),
      row("gmv-spend", TECHWAVE_STORE_NAME, "GMV Max花费", {
        [F.date]: date,
        [F.value]: 999,
      }),
    ];
    const plan = buildRoiPivotPlan(records, NOW);

    expect(dailyValue(plan, records, "商品A", "达人出单量", date)).toBe(7);
    expect(dailyValue(plan, records, "商品A", "达人出单数量", date)).toBe(8);
    expect(dailyValue(plan, records, "商品B", "达人出单量", date)).toBe(4);
    expect(dailyValue(plan, records, TECHWAVE_STORE_NAME, "总单量", date)).toBe(15);
    expect(dailyValue(plan, records, TECHWAVE_STORE_NAME, "总数量", date)).toBe(18);
    expect(dailyValue(plan, records, TECHWAVE_STORE_NAME, "达人出单量", date)).toBe(11);
    expect(dailyValue(plan, records, TECHWAVE_STORE_NAME, "商品卡出单量", date)).toBe(4);
    expect(dailyValue(plan, records, TECHWAVE_STORE_NAME, "销售额", date)).toBe(150);
    expect(dailyValue(plan, records, TECHWAVE_STORE_NAME, "总广告出单量", date)).toBe(108);
    expect(dailyValue(plan, records, TECHWAVE_STORE_NAME, "总广告花费", date)).toBe(1059);
    expect(dailyValue(plan, records, TECHWAVE_STORE_NAME, "转化率", date)).toBeCloseTo(0.015);
    expect(summaryValue(
      plan,
      records,
      TECHWAVE_STORE_NAME,
      "转化率",
      CURRENT_MONTH_LABEL,
    )).toBeCloseTo(0.015);
  });

  it("averages defined TechWave daily conversion rates in monthly and all-time summaries", () => {
    const records = [
      row("orders-a", "商品A", "单量", {
        [F.date]: "2026-07-27",
        [F.value]: 10,
      }),
      row("orders-b", "商品A", "单量", {
        [F.date]: "2026-07-28",
        [F.value]: 10,
      }),
      row("traffic-a", TECHWAVE_STORE_NAME, "店铺浏览量", {
        [F.date]: "2026-07-27",
        [F.value]: 100,
      }),
      row("traffic-b", TECHWAVE_STORE_NAME, "店铺浏览量", {
        [F.date]: "2026-07-28",
        [F.value]: 900,
      }),
    ];

    const plan = buildRoiPivotPlan(records, NOW);
    const expected = ((10 / 100) + (10 / 900)) / 2;

    expect(dailyValue(plan, records, TECHWAVE_STORE_NAME, "转化率", "2026-07-27"))
      .toBeCloseTo(0.1);
    expect(dailyValue(plan, records, TECHWAVE_STORE_NAME, "转化率", "2026-07-28"))
      .toBeCloseTo(10 / 900);
    expect(summaryValue(
      plan,
      records,
      TECHWAVE_STORE_NAME,
      "转化率",
      CURRENT_MONTH_LABEL,
    )).toBeCloseTo(expected);
    expect(summaryValue(
      plan,
      records,
      TECHWAVE_STORE_NAME,
      "转化率",
      "合计全部",
    )).toBeCloseTo(expected);
  });

  it("averages TechWave visitors and ordering videos in monthly and all-time summaries", () => {
    const records = [
      row("view-a", TECHWAVE_STORE_NAME, "店铺浏览量", { [F.date]: "2026-07-27", [F.value]: 100 }),
      row("view-b", TECHWAVE_STORE_NAME, "店铺浏览量", { [F.date]: "2026-07-28", [F.value]: 300 }),
      row("video-a", TECHWAVE_STORE_NAME, "出单视频", { [F.date]: "2026-07-27", [F.value]: 1 }),
      row("video-b", TECHWAVE_STORE_NAME, "出单视频", { [F.date]: "2026-07-28", [F.value]: 3 }),
    ];
    const plan = buildRoiPivotPlan(records, NOW);

    expect(summaryValue(plan, records, TECHWAVE_STORE_NAME, "店铺浏览量", CURRENT_MONTH_LABEL)).toBe(200);
    expect(summaryValue(plan, records, TECHWAVE_STORE_NAME, "店铺浏览量", "合计全部")).toBe(200);
    expect(summaryValue(plan, records, TECHWAVE_STORE_NAME, "出单视频", CURRENT_MONTH_LABEL)).toBe(2);
    expect(summaryValue(plan, records, TECHWAVE_STORE_NAME, "出单视频", "合计全部")).toBe(2);
  });

  it("counts cooperation and launch source records by product and date before store rollups", () => {
    const date = "2026-07-28";
    const records = [
      row("anchor", "杯子", "", {}),
      row("legacy-cooperation", "杯子", "合作量", {
        [F.date]: date,
        [F.value]: 99,
      }),
      row("orders", "杯子", "单量", { [F.date]: date, [F.value]: 8 }),
      row("card-orders", "杯子", "商品卡出单量", { [F.date]: date, [F.value]: 3 }),
    ];
    const formulaInputs = [
      { product: "杯子", metric: "合作量" as const, date, value: 1 },
      { product: "杯子", metric: "合作量" as const, date, value: 1 },
      { product: "杯子", metric: "上线量" as const, date, value: 1 },
      { product: "不存在的旧商品", metric: "上线量" as const, date, value: 50 },
    ];

    const plan = buildRoiPivotPlan(records, NOW, formulaInputs);

    expect(dailyValue(plan, records, "杯子", "合作量", date)).toBe(2);
    expect(dailyValue(plan, records, "杯子", "上线量", date)).toBe(1);
    expect(dailyValue(plan, records, "杯子", "达人出单量", date)).toBe(5);
    expect(dailyValue(plan, records, TECHWAVE_STORE_NAME, "合作量", date)).toBe(2);
    expect(dailyValue(plan, records, TECHWAVE_STORE_NAME, "上线量", date)).toBe(1);
    expect(dailyValue(plan, records, TECHWAVE_STORE_NAME, "总单量", date)).toBe(8);
    expect(update(plan, "legacy-cooperation")).toMatchObject({
      [F.value]: 2,
      [F.recordRole]: R.formula,
    });
    expect(plan.creates.some((item) => item.fields[F.product] === "不存在的旧商品"))
      .toBe(false);
  });

  it("normalizes the lone legacy store typo into the unique TechWave block", () => {
    const plan = buildRoiPivotPlan([
      row("typo", "TechWav", "店铺浏览量", {
        [F.date]: "2026-07-28",
        [F.value]: 100,
      }),
    ], NOW);

    expect(update(plan, "typo")).toMatchObject({
      [F.product]: TECHWAVE_STORE_NAME,
    });
    expect(plan.stats.metricPairs).toBe(21);
    expect(plan.creates.some((item) => item.fields[F.product] === "TechWav")).toBe(false);
  });

  it("overwrites legacy store totals from product sources and converges idempotently", () => {
    const date = "2026-07-28";
    const records = [
      row("product-order", "商品A", "单量", { [F.date]: date, [F.value]: 6 }),
      row("legacy-store-order", TECHWAVE_STORE_NAME, "总单量", {
        [F.date]: date,
        [F.value]: 999,
      }),
    ];
    const first = buildRoiPivotPlan(records, NOW);

    expect(update(first, "legacy-store-order")).toMatchObject({
      [F.value]: 6,
      [F.recordRole]: R.productRollup,
    });
    const second = buildRoiPivotPlan(applyPlan(records, first), NOW);
    expect(second.updates).toEqual([]);
    expect(second.creates).toEqual([]);
    expect(second.deleteRecordIds).toEqual([]);
  });

  it("keeps concurrent raw rows independent and sums them without overwriting user values", () => {
    const date = "2026-07-28";
    const records = [
      row("user-a", "商品A", "单量", { [F.date]: date, [F.value]: 6 }),
      row("user-b", "商品A", "单量", { [F.date]: date, [F.value]: 4 }),
    ];
    const plan = buildRoiPivotPlan(records, NOW);

    expect(update(plan, "user-a")[F.value]).toBeUndefined();
    expect(update(plan, "user-b")[F.value]).toBeUndefined();
    expect(dailyValue(plan, records, TECHWAVE_STORE_NAME, "总单量", date)).toBe(10);
  });

  it("is idempotent after bootstrapping a completely empty table", () => {
    const first = buildRoiPivotPlan([], NOW);
    const second = buildRoiPivotPlan(applyPlan([], first), NOW);

    expect(second.updates).toEqual([]);
    expect(second.creates).toEqual([]);
    expect(second.deleteRecordIds).toEqual([]);
    expect(second.optionNames).toEqual(first.optionNames);
  });
});
