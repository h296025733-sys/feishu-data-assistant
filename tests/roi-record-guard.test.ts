import { describe, expect, it } from "vitest";
import { buildRoiRecordGuardPlan } from "../src/feishu/roi-record-guard.js";

const JULY_23 = Date.parse("2026-07-22T16:00:00.000Z");
const JULY_24 = Date.parse("2026-07-23T16:00:00.000Z");

describe("buildRoiRecordGuardPlan", () => {
  it("creates one store row per existing product date when missing", () => {
    const plan = buildRoiRecordGuardPlan([
      { product: "杯子", date: JULY_23 },
      { product: "牙刷", date: JULY_23 },
      { product: "水枪", date: JULY_24 },
    ]);
    expect(plan.missingProductDates).toEqual([]);
    expect(plan.missingStoreDates).toEqual([
      { dateKey: "2026-07-23", timestamp: JULY_23 },
      { dateKey: "2026-07-24", timestamp: JULY_24 },
    ]);
    expect(plan.duplicateKeys).toEqual([]);
  });

  it("creates source-driven product and store rows without touching existing rows", () => {
    const plan = buildRoiRecordGuardPlan([], {
      sourceRecords: [{ products: ["水杨酸沐浴露"], date: JULY_23 }],
      allowedProducts: ["水杨酸沐浴露"],
      storeName: "店铺汇总",
    });
    expect(plan.missingProductDates).toEqual([
      { product: "水杨酸沐浴露", dateKey: "2026-07-23", timestamp: JULY_23 },
    ]);
    expect(plan.missingStoreDates).toEqual([
      { dateKey: "2026-07-23", timestamp: JULY_23 },
    ]);
  });

  it("creates two product rows but only one store row for one multi-product source record", () => {
    const plan = buildRoiRecordGuardPlan([], {
      sourceRecords: [{ products: ["户外蓝牙音箱", "便携蓝牙音箱"], date: JULY_24 }],
      allowedProducts: ["户外蓝牙音箱", "便携蓝牙音箱"],
      storeName: "店铺汇总",
    });
    expect(plan.missingProductDates.map((item) => item.product)).toEqual([
      "便携蓝牙音箱",
      "户外蓝牙音箱",
    ]);
    expect(plan.missingStoreDates).toHaveLength(1);
  });

  it("ignores source products outside the confirmed store whitelist", () => {
    const plan = buildRoiRecordGuardPlan([], {
      sourceRecords: [{ products: ["历史测试商品"], date: JULY_23 }],
      allowedProducts: ["水杨酸沐浴露"],
      storeName: "店铺汇总",
    });
    expect(plan.missingProductDates).toEqual([]);
    expect(plan.missingStoreDates).toEqual([]);
  });

  it("does not create rows that already exist", () => {
    const plan = buildRoiRecordGuardPlan([
      { product: "杯子", date: JULY_23 },
      { product: "店铺汇总", date: JULY_23 },
    ], {
      sourceRecords: [{ products: ["杯子"], date: JULY_23 }],
      allowedProducts: ["杯子"],
      storeName: "店铺汇总",
    });
    expect(plan.missingProductDates).toEqual([]);
    expect(plan.missingStoreDates).toEqual([]);
  });

  it("reports duplicate product-date and store-date keys", () => {
    const plan = buildRoiRecordGuardPlan([
      { product: "杯子", date: JULY_23 },
      { product: "杯子", date: JULY_23 },
      { product: "店铺汇总", date: JULY_23 },
      { product: "店铺汇总", date: JULY_23 },
    ], { storeName: "店铺汇总" });
    expect(plan.duplicateKeys).toEqual([
      "店铺汇总 + 2026-07-23",
      "杯子 + 2026-07-23",
    ]);
  });

  it("ignores blank anchors", () => {
    const plan = buildRoiRecordGuardPlan([
      { product: "杯子", date: null },
      { product: "", date: JULY_23 },
    ]);
    expect(plan).toEqual({ missingProductDates: [], missingStoreDates: [], duplicateKeys: [] });
  });
});
