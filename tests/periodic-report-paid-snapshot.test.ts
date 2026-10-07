import { describe, expect, it } from "vitest";
import {
  buildPeriodicReportPaidSnapshot,
  periodicSnapshotChunks,
  type PeriodicReportProductMap,
} from "../src/bot/periodic-report-paid-snapshot.js";
import type { BusinessProfile } from "../src/config/business-profile.js";
import type { TikTokPaidOrderSnapshotContract } from "../src/realtime/tiktok-cli.js";

describe("periodic report paid snapshot", () => {
  it("maps only formal products, preserves zero days, and sums privacy-safe orders", () => {
    const result = buildPeriodicReportPaidSnapshot(
      contract([
        row("2026-08-01", "p1", [key(1), key(2)], 3, "10.50"),
        row("2026-08-01", "old", [key(3)], 99, "999"),
      ]),
      profile,
      productMap,
      "2026-08-01",
      "2026-08-02",
    );
    expect(result).toEqual([
      { date: "2026-08-01", name: "正式商品", orders: 2, items: 3, sales: 10.5 },
      { date: "2026-08-02", name: "正式商品", orders: 0, items: 0, sales: 0 },
    ]);
    expect(JSON.stringify(result)).not.toContain("old");
    expect(JSON.stringify(result)).not.toContain(key(1));
  });

  it("rejects conflicting duplicate order evidence across mapped product ids", () => {
    const duplicateMap: PeriodicReportProductMap = {
      shop: "Store",
      products: { p1: "正式商品", p2: "正式商品" },
    };
    expect(() => buildPeriodicReportPaidSnapshot(
      contract([
        row("2026-08-01", "p1", [key(1)], 1, "3"),
        row("2026-08-01", "p2", [key(1)], 1, "3"),
      ], ["2026-08-01"]),
      profile,
      duplicateMap,
      "2026-08-01",
      "2026-08-01",
    )).toThrow("去重数与接口汇总不一致");
  });

  it("splits a 31-day calendar month so the seven-day create-time buffer stays safe", () => {
    expect(periodicSnapshotChunks("2026-07-01", "2026-07-31")).toEqual([
      { startDate: "2026-07-01", endDateInclusive: "2026-07-24" },
      { startDate: "2026-07-25", endDateInclusive: "2026-07-31" },
    ]);
  });
});

const profile: BusinessProfile = {
  schemaVersion: 1,
  templateMode: false,
  businessDisplayName: "Store",
  businessTimeZone: "Asia/Shanghai",
  storeAggregateLabel: "店铺汇总",
  tables: { development: "开发", cooperation: "合作", online: "上线", roi: "投产比" },
  tiktok: {
    shopAlias: "Store",
    shopId: "shop",
    credentialProfile: "store",
    shopTimeZone: "America/Los_Angeles",
    currencyCode: "USD",
    productMapFile: "unused.json",
    includedCanonicalProducts: ["正式商品"],
    roiDateBasis: "shop_registered",
  },
};

const productMap: PeriodicReportProductMap = {
  shop: "Store",
  products: { p1: "正式商品" },
};

function contract(
  rows: Record<string, unknown>[],
  dates = ["2026-08-01", "2026-08-02"],
): TikTokPaidOrderSnapshotContract {
  return {
    ok: true,
    dataset: "paid_order_snapshot",
    shop: { id: "shop", name: "Store" },
    window_start: dates[0],
    window_end_exclusive: "2026-08-03",
    fetched_at: "2026-08-03T10:00:00Z",
    business_time_zone: "Asia/Shanghai",
    paid_snapshot_policy: "paid_positive_non_sample_local_day_exact_v2",
    paid_snapshot_dates: dates,
    paid_snapshot_rows: rows,
    paid_snapshot_store_rows: [],
    paid_snapshot_sales_errors: [],
    paid_snapshot_ready: true,
    video_attribution_policy: "affiliate_content_id_exact_v1",
    video_attribution_ready: false,
    video_order_rows: [],
    video_attribution_errors: ["missing scope"],
    request_ids: [],
    raw_source_paths: [],
    normalized_source_path: "normalized.json",
    required_scope: ["seller.order.info"],
    granted_scope: ["seller.order.info"],
    missing_capabilities: [],
    errors: [],
    pagination_truncated: false,
  } as TikTokPaidOrderSnapshotContract;
}

function row(
  date: string,
  productId: string,
  orderKeys: string[],
  items: number,
  sales: string,
): Record<string, unknown> {
  return {
    date,
    product_id: productId,
    total_orders: orderKeys.length,
    total_items: items,
    sales_amount: sales,
    sales_currency: "USD",
    sales_ready: true,
    total_order_keys: orderKeys,
    total_order_paid_at: Object.fromEntries(orderKeys.map((value) => [value, 1_786_000_000])),
  };
}

function key(value: number): string {
  return value.toString(16).padStart(20, "0");
}
