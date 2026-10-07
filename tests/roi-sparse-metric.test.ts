import { describe, expect, it } from "vitest";
import {
  aggregateMappedProductRows,
  groupMappedProductsByCanonicalName,
  sparseMetricNumber,
} from "../src/realtime/roi-sync.js";

describe("TikTok sparse ROI channel metrics", () => {
  it("treats an omitted product-card channel as zero activity", () => {
    expect(sparseMetricNumber(undefined, "card_orders")).toBe(0);
    expect(sparseMetricNumber(null, "card_items")).toBe(0);
    expect(sparseMetricNumber("", "card_orders")).toBe(0);
  });

  it("keeps valid numeric strings and rejects malformed values", () => {
    expect(sparseMetricNumber("3", "card_orders")).toBe(3);
    expect(() => sparseMetricNumber("not-a-number", "card_orders"))
      .toThrow("card_orders 不是有效数字");
  });
});

describe("canonical product grouping", () => {
  it("groups several TikTok listing IDs under one workbench product name", () => {
    const groups = groupMappedProductsByCanonicalName([
      { id: "a", name: "电动磨脚器" },
      { id: "b", name: "电动磨脚器" },
      { id: "c", name: "水杨酸沐浴露" },
    ]);
    expect(groups.size).toBe(2);
    expect(groups.get("电动磨脚器")?.productIds).toEqual(["a", "b"]);
  });

  it("sums API metrics across grouped IDs and keeps an omitted card channel at zero", () => {
    expect(aggregateMappedProductRows("2026-07-12", [
      {
        id: "a",
        row: {
          total_performance: { orders: 1, items_sold: 2, gmv: { amount: "5.99" } },
          seller_product_card_performance: { attributed_orders: 1, attributed_sold_items: 2 },
        },
      },
      {
        id: "b",
        row: {
          total_performance: { orders: 3, items_sold: 3, gmv: { amount: "17.92" } },
        },
      },
    ])).toEqual({
      orders: 4,
      items: 5,
      gmv: 23.91,
      cardOrders: 1,
      cardItems: 2,
    });
  });
});
