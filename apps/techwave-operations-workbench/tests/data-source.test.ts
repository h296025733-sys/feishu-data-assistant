import { describe, expect, it } from "vitest";
import { DemoWorkbenchDataSource, isAccountSideNumericFieldType } from "../src/data-source";
import { dateKeyToTimestamp, setRuntimeStoreAggregateLabel, type NormalizedRecord } from "../src/domain";

function record(): NormalizedRecord {
  return {
    recordId: "rec1",
    product: "电动磨脚器",
    dateKey: "2026-07-23",
    timestamp: dateKeyToTimestamp("2026-07-23"),
    status: "✓",
    values: { 单量: 6 },
  };
}

describe("写入保护契约（隔离演示适配器）", () => {
  it("账号端接受普通数字与货币字段作为数值指标", () => {
    expect(isAccountSideNumericFieldType(2)).toBe(true);
    expect(isAccountSideNumericFieldType(99003)).toBe(true);
    expect(isAccountSideNumericFieldType(1)).toBe(false);
  });

  it("空白与0保持不同值", async () => {
    const source = new DemoWorkbenchDataSource([record()]);
    const cleared = await source.saveCell({ recordId: "rec1", fieldName: "单量", expectedValue: 6, nextValue: null });
    expect(cleared).toMatchObject({ state: "saved", value: null });
    const zero = await source.saveCell({ recordId: "rec1", fieldName: "单量", expectedValue: null, nextValue: 0 });
    expect(zero).toMatchObject({ state: "saved", value: 0 });
  });

  it("预期值落后时返回冲突且不覆盖", async () => {
    const source = new DemoWorkbenchDataSource([record()]);
    const conflict = await source.saveCell({ recordId: "rec1", fieldName: "单量", expectedValue: 5, nextValue: 7 });
    expect(conflict).toMatchObject({ state: "conflict", value: 6 });
    const loaded = await source.load();
    expect(loaded.records[0].values.单量).toBe(6);
  });

  it("新增前检查相同商品日期并保持幂等", async () => {
    const source = new DemoWorkbenchDataSource([record()]);
    const existing = await source.createDailyRecord({ productName: "电动磨脚器", dateKey: "2026-07-23", tiktokProductId: "1732482160735195549" });
    expect(existing.created).toBe(false);
    const created = await source.createDailyRecord({ productName: "电动磨脚器", dateKey: "2026-07-24", tiktokProductId: "1732482160735195549" });
    expect(created.created).toBe(true);
    const loaded = await source.load();
    expect(loaded.records.filter((item) => item.product === "电动磨脚器" && item.dateKey === "2026-07-24")).toHaveLength(1);
  });

  it("允许人工字段先创建店铺当日汇总行", async () => {
    const source = new DemoWorkbenchDataSource([record()]);
    const created = await source.createDailyRecord({ productName: "店铺汇总", dateKey: "2026-07-24" });
    expect(created.created).toBe(true);
    const loaded = await source.load();
    expect(loaded.records.some((item) => item.product === "店铺汇总" && item.dateKey === "2026-07-24")).toBe(true);
  });

  it("四表商品名统一多件装规格且不做机器翻译", async () => {
    const source = new DemoWorkbenchDataSource([record()]);
    await source.createDailyRecord({ productName: " 透明收纳箱 (2pcs) ", dateKey: "2026-07-25", tiktokProductId: "1732482160735195550" });
    const loaded = await source.load();
    expect(loaded.records.some((item) => item.product === "透明收纳箱（2PCS）")).toBe(true);
  });

  it("删除商品只删除完全同名商品并保留其他数据", async () => {
    const other = { ...record(), recordId: "rec2", product: "电动磨脚器（2PCS）" };
    const source = new DemoWorkbenchDataSource([record(), other]);
    const result = await source.deleteProduct("电动磨脚器");
    expect(result.deletedCount).toBe(1);
    const loaded = await source.load();
    expect(loaded.canDeleteProducts).toBe(true);
    expect(loaded.records.map((item) => item.product)).toEqual(["电动磨脚器（2PCS）"]);
  });

  it("每个Base可保存独立店铺显示与汇总配置", async () => {
    const source = new DemoWorkbenchDataSource([record()]);
    await source.saveConfig({
      businessDisplayName: "Store A",
      storeAggregateLabel: "Store A",
      roiTableName: "经营数据",
    });
    expect(await source.getConfig()).toEqual({
      businessDisplayName: "Store A",
      storeAggregateLabel: "Store A",
      roiTableName: "经营数据",
    });
    setRuntimeStoreAggregateLabel("TechWave");
  });
});
