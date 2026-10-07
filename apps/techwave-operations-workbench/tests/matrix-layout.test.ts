import { describe, expect, it } from "vitest";
import {
  buildMatrixColumns,
  buildMetricAggregateIndex,
  advertisingLayoutForMetric,
  compactAdvertisingAccount,
  hierarchyLayoutForMetric,
  hierarchyGridClass,
  hierarchyToneClass,
  metricPresentationClass,
  PRODUCT_HEADER_LAYOUT,
  readMetricAggregate,
  shouldOfferMissingRecordAction,
  stickyMonthLeft,
  stickyMonthOffset,
} from "../src/Matrix";
import { aggregateMetric, buildShopMetrics, PRODUCT_METRICS, SHOP_METRICS, SHOP_NAME, type AdvertisingAccount, type NormalizedRecord } from "../src/domain";

describe("operations matrix layout", () => {
  it("inserts an independent monthly total at every month boundary", () => {
    expect(buildMatrixColumns(["2026-06-30", "2026-07-01", "2026-07-31", "2026-08-01"]))
      .toMatchObject([
        { kind: "monthTotal", monthKey: "2026-06" },
        { kind: "date", dateKey: "2026-06-30" },
        { kind: "monthTotal", monthKey: "2026-07" },
        { kind: "date", dateKey: "2026-07-01" },
        { kind: "date", dateKey: "2026-07-31" },
        { kind: "monthTotal", monthKey: "2026-08" },
        { kind: "date", dateKey: "2026-08-01" },
      ]);
  });

  it("keeps the most recent month and date at the left when dates are recent-first", () => {
    expect(buildMatrixColumns(["2026-08-02", "2026-08-01", "2026-07-31"]))
      .toMatchObject([
        { kind: "monthTotal", monthKey: "2026-08" },
        { kind: "date", dateKey: "2026-08-02" },
        { kind: "date", dateKey: "2026-08-01" },
        { kind: "monthTotal", monthKey: "2026-07" },
        { kind: "date", dateKey: "2026-07-31" },
      ]);
  });

  it("truncates a long product name without displacing the delete button", () => {
    expect(PRODUCT_HEADER_LAYOUT.collapse).toMatchObject({ minWidth: 0, overflow: "hidden" });
    expect(PRODUCT_HEADER_LAYOUT.name).toMatchObject({ textOverflow: "ellipsis", whiteSpace: "nowrap" });
    expect(PRODUCT_HEADER_LAYOUT.remove).toMatchObject({ flex: "0 0 25px", width: 25, marginLeft: "auto" });
  });

  it("pushes the sticky monthly total away when the following month reaches it", () => {
    expect(stickyMonthLeft(0, 116, 620, 0)).toBe(514);
    expect(stickyMonthLeft(0, 116, 620, 250)).toBe(764);
    expect(stickyMonthLeft(0, 116, 620, 700)).toBe(1018);
    expect(stickyMonthLeft(620, 116, undefined, 700)).toBe(1214);
    expect(stickyMonthOffset(0, 116, 620, 0)).toBe(0);
    expect(stickyMonthOffset(0, 116, 620, 250)).toBe(250);
    expect(stickyMonthOffset(0, 116, 620, 700)).toBe(504);
  });

  it("uses a distinct tone for every order-attribution group", () => {
    expect(hierarchyToneClass("\u8054\u76df\u8fbe\u4eba\u51fa\u5355")).toBe("tone-alliance");
    expect(hierarchyToneClass("\u81ea\u8425\u8fbe\u4eba\u51fa\u5355")).toBe("tone-self");
    expect(hierarchyToneClass("\u5546\u54c1\u5361\u51fa\u5355")).toBe("tone-product-card");
    expect(hierarchyToneClass("other")).toBe("");
  });

  it("collapses the unused channel column for product-card metrics", () => {
    const productCard = PRODUCT_METRICS.find((metric) => metric.hierarchy?.group === "商品卡出单")!;
    const allianceVideo = PRODUCT_METRICS.find((metric) => metric.hierarchy?.channel === "视频出单")!;
    expect(hierarchyGridClass(productCard.hierarchy!)).toBe("hierarchy-channel-less");
    expect(hierarchyGridClass(allianceVideo.hierarchy!)).toBe("");
  });

  it("marks only channel and group boundaries so same-category color bands stay continuous", () => {
    const metrics = PRODUCT_METRICS.filter((metric) => metric.hierarchy);
    const layouts = metrics.map((_, index) => hierarchyLayoutForMetric(metrics, index));
    expect(layouts.map((layout) => layout.groupStart)).toEqual([true, false, false, false, true, false, false, false, true, false]);
    expect(layouts.map((layout) => layout.groupEnd)).toEqual([false, false, false, true, false, false, false, true, false, true]);
    expect(layouts.map((layout) => layout.channelEnd)).toEqual([false, true, false, true, false, true, false, true, false, true]);
    expect(layouts.map((layout) => layout.showGroupLabel)).toEqual([true, false, false, false, true, false, false, false, true, false]);
    expect(layouts.map((layout) => layout.groupRowSpan)).toEqual([4, 0, 0, 0, 4, 0, 0, 0, 2, 0]);
    expect(layouts.map((layout) => layout.channelRowSpan)).toEqual([2, 0, 2, 0, 2, 0, 2, 0, 2, 0]);
  });

  it("builds paired advertiser rows below the totals and preserves a compact account label", () => {
    const account: AdvertisingAccount = {
      id: "spend:orders",
      name: "MAX-LUHENGCHANG COMPANY LIMITED-6061-1",
      spendFieldId: "spend",
      spendFieldName: "MAX-LUHENGCHANG COMPANY LIMITED-6061-1广告花费",
      orderFieldId: "orders",
      orderFieldName: "MAX-LUHENGCHANG COMPANY LIMITED-6061-1广告出单量",
      active: true,
    };
    const metrics = buildShopMetrics([account]);
    expect(compactAdvertisingAccount("MAX-LUHENGCHANG COMPANY LIMITED-6061-1"))
      .toBe("LUHENGCHANG · 6061-1");
    expect(compactAdvertisingAccount("MAX-QI RUI XIN LIMITED-1100-1"))
      .toBe("QI RUI XIN · 1100-1");
    expect(metricPresentationClass(SHOP_METRICS.find((metric) => metric.name === "总广告花费")!))
      .toContain("metric-presentation-money");
    expect(metricPresentationClass(metrics.find((metric) => metric.fieldName === account.spendFieldName)!))
      .toBe("metric-presentation-manual");
    const start = metrics.findIndex((metric) => metric.fieldName === account.spendFieldName);
    const summaryStart = metrics.findIndex((metric) => metric.fieldName === "总广告花费");
    expect(advertisingLayoutForMetric(metrics, summaryStart)).toEqual({ advertisingStart: true, advertisingEnd: false, showAdvertisingAccount: false, advertisingRowSpan: 0 });
    expect(advertisingLayoutForMetric(metrics, summaryStart + 1)).toEqual({ advertisingStart: false, advertisingEnd: true, showAdvertisingAccount: false, advertisingRowSpan: 0 });
    expect(metrics.slice(start, start + 2).map((metric) => metric.fieldName)).toEqual([account.spendFieldName, account.orderFieldName]);
    expect(advertisingLayoutForMetric(metrics, start)).toEqual({ advertisingStart: true, advertisingEnd: false, showAdvertisingAccount: true, advertisingRowSpan: 2 });
    expect(advertisingLayoutForMetric(metrics, start + 1)).toEqual({ advertisingStart: false, advertisingEnd: true, showAdvertisingAccount: false, advertisingRowSpan: 0 });
    expect(shouldOfferMissingRecordAction("shop", metrics[start])).toBe(true);
    expect(shouldOfferMissingRecordAction("shop", SHOP_METRICS.find((metric) => metric.fieldName === "店铺浏览量")!)).toBe(false);
    expect(shouldOfferMissingRecordAction("shop", SHOP_METRICS.find((metric) => metric.fieldName === "退货量")!)).toBe(true);
    expect(shouldOfferMissingRecordAction("product", PRODUCT_METRICS.find((metric) => metric.fieldName === "单量")!)).toBe(false);
    expect(shouldOfferMissingRecordAction("product", PRODUCT_METRICS.find((metric) => metric.hierarchy)!)).toBe(false);
  });

  it("precomputes all-time and monthly totals without changing blank-versus-zero semantics", () => {
    const records: NormalizedRecord[] = [
      { recordId: "1", product: "商品A", dateKey: "2026-07-31", timestamp: 1, status: "", values: { 单量: 0, 销售额: 12.5 } },
      { recordId: "2", product: "商品A", dateKey: "2026-08-01", timestamp: 2, status: "", values: { 单量: 3, 销售额: 20 } },
      { recordId: "3", product: "商品A", dateKey: "2026-08-02", timestamp: 3, status: "", values: { 单量: null, 销售额: 7.5 } },
    ];
    const index = buildMetricAggregateIndex(records);
    for (const metric of PRODUCT_METRICS.filter((item) => item.fieldName === "单量" || item.fieldName === "销售额")) {
      expect(readMetricAggregate(index, "商品A", metric)).toBe(aggregateMetric(records, "商品A", metric));
      expect(readMetricAggregate(index, "商品A", metric, "2026-08")).toBe(aggregateMetric(records, "商品A", metric, "2026-08"));
      expect(readMetricAggregate(index, "不存在", metric)).toBeNull();
    }
  });

  it("applies average aggregation in the final display index, including zero and excluding blanks", () => {
    const records: NormalizedRecord[] = [
      { recordId: "p1", product: "商品A", dateKey: "2026-07-31", timestamp: 1, status: "", values: { 出单视频: 9 } },
      { recordId: "p2", product: "商品A", dateKey: "2026-08-01", timestamp: 2, status: "", values: { 出单视频: 2 } },
      { recordId: "p3", product: "商品A", dateKey: "2026-08-02", timestamp: 3, status: "", values: { 出单视频: 0 } },
      { recordId: "p4", product: "商品A", dateKey: "2026-08-03", timestamp: 4, status: "", values: { 出单视频: null } },
      { recordId: "s1", product: SHOP_NAME, dateKey: "2026-07-31", timestamp: 5, status: "", values: { 店铺浏览量: 50, 转化率: 0.05, 出单视频: 5 } },
      { recordId: "s2", product: SHOP_NAME, dateKey: "2026-08-01", timestamp: 6, status: "", values: { 店铺浏览量: 100, 转化率: 0.1, 出单视频: 1 } },
      { recordId: "s3", product: SHOP_NAME, dateKey: "2026-08-02", timestamp: 7, status: "", values: { 店铺浏览量: 300, 转化率: 0.3, 出单视频: 3 } },
      { recordId: "s4", product: SHOP_NAME, dateKey: "2026-08-03", timestamp: 8, status: "", values: { 店铺浏览量: null, 转化率: null, 出单视频: 0 } },
    ];
    const index = buildMetricAggregateIndex(records);
    const productVideos = PRODUCT_METRICS.find((metric) => metric.fieldName === "出单视频")!;
    const shopVisits = SHOP_METRICS.find((metric) => metric.fieldName === "店铺浏览量")!;
    const shopConversion = SHOP_METRICS.find((metric) => metric.fieldName === "转化率")!;
    const shopVideos = SHOP_METRICS.find((metric) => metric.fieldName === "出单视频")!;

    expect(readMetricAggregate(index, "商品A", productVideos)).toBeCloseTo(11 / 3);
    expect(readMetricAggregate(index, "商品A", productVideos, "2026-08")).toBe(1);
    expect(readMetricAggregate(index, SHOP_NAME, shopVisits)).toBe(150);
    expect(readMetricAggregate(index, SHOP_NAME, shopVisits, "2026-08")).toBe(200);
    expect(readMetricAggregate(index, SHOP_NAME, shopConversion)).toBeCloseTo(0.15);
    expect(readMetricAggregate(index, SHOP_NAME, shopConversion, "2026-08")).toBeCloseTo(0.2);
    expect(readMetricAggregate(index, SHOP_NAME, shopVideos)).toBeCloseTo(2.25);
    expect(readMetricAggregate(index, SHOP_NAME, shopVideos, "2026-08")).toBeCloseTo(4 / 3);
  });
});
