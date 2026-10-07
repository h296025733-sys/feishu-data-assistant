import { describe, expect, it } from "vitest";
import {
  mergeMonotonicNumberFields,
  productOrderAttributionValues,
  type DailyOrderAttributionSource,
} from "../src/feishu/storefour-demo-gateway.js";

function source(overrides: Partial<DailyOrderAttributionSource> = {}): DailyOrderAttributionSource {
  return {
    date: "2026-08-08",
    orders: 9,
    items: 12,
    cardOrders: 3,
    cardItems: 4,
    allianceVideoOrders: 2,
    allianceVideoItems: 3,
    allianceLiveOrders: 1,
    allianceLiveItems: 1,
    selfOperatedVideoOrders: 2,
    selfOperatedVideoItems: 2,
    selfOperatedLiveOrders: 1,
    selfOperatedLiveItems: 2,
    sourceFiles: [],
    requestIds: [],
    ...overrides,
  };
}

describe("order attribution Feishu field mapping", () => {
  it("writes totals, channel split, and product-card metrics together", () => {
    expect(productOrderAttributionValues(source())).toEqual({
      单量: 9,
      数量: 12,
      联盟达人视频出单量: 2,
      联盟达人视频出单数量: 3,
      联盟达人直播出单量: 1,
      联盟达人直播出单数量: 1,
      自营达人视频出单量: 2,
      自营达人视频出单数量: 2,
      自营达人直播出单量: 1,
      自营达人直播出单数量: 2,
      商品卡出单量: 3,
      商品卡出单数量: 4,
    });
  });

  it("normalizes optional channel metrics to zero without adding unrelated fields", () => {
    const values = productOrderAttributionValues(source({
      allianceVideoOrders: undefined,
      allianceVideoItems: undefined,
      selfOperatedLiveOrders: undefined,
      selfOperatedLiveItems: undefined,
    }));

    expect(values.联盟达人视频出单量).toBe(0);
    expect(values.自营达人直播出单数量).toBe(0);
    expect(values).not.toHaveProperty("销售额");
    expect(values).not.toHaveProperty("广告花费");
    expect(values).not.toHaveProperty("退货量");
  });

  it("never subtracts a paid snapshot after a later cancellation", () => {
    expect(mergeMonotonicNumberFields(
      { 单量: 6, 数量: 8, 销售额: 99 },
      { 单量: 5, 数量: 9, 销售额: 80 },
      ["单量", "数量"],
    )).toEqual({ 单量: 6, 数量: 9, 销售额: 80 });
  });
});
