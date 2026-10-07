import { describe, expect, it } from "vitest";
import { loadBusinessProfileFile } from "../src/config/business-profile.js";
import { buildProductSpikeSnapshot } from "../src/bot/product-spike-snapshot.js";
import type { TikTokPaidOrderSnapshotContract } from "../src/realtime/tiktok-cli.js";

const profile = loadBusinessProfileFile("tests/fixtures/storeone.profile.json");

describe("buildProductSpikeSnapshot", () => {
  it("unions listing IDs into one canonical product and keeps exact video IDs", () => {
    const contract = baseContract();
    contract.paid_snapshot_rows = [
      paidRow("p-blue", [key(1), key(2)], 2, "6.50"),
      paidRow("p-black", [key(2), key(3)], 2, "7.50"),
      paidRow("unmapped", [key(4)], 1, "9.00"),
    ];
    contract.paid_snapshot_store_rows = [{
      date: "2026-08-12",
      total_orders: 4,
      total_items: 5,
      total_order_keys: [key(1), key(2), key(3), key(4)],
      total_order_paid_at: {
        [key(1)]: 1_786_500_000,
        [key(2)]: 1_786_500_000,
        [key(3)]: 1_786_500_000,
        [key(4)]: 1_786_500_000,
      },
    }];
    contract.video_attribution_ready = true;
    contract.video_attribution_errors = [];
    contract.video_order_rows = [
      {
        date: "2026-08-12",
        product_id: "p-blue",
        video_id: "7667000000000000001",
        total_items: 2,
        total_order_keys: [key(2), key(3)],
        total_order_paid_at: {
          [key(2)]: 1_786_500_000,
          [key(3)]: 1_786_500_000,
        },
      },
    ];
    const result = buildProductSpikeSnapshot(contract, profile, {
      shop: "STOREONE",
      products: {
        "p-blue": "户外蓝牙音箱",
        "p-black": "户外蓝牙音箱",
        "p-portable": "便携蓝牙音箱",
      },
    }, "2026-08-12");

    expect(result.products).toEqual([
      {
        name: "户外蓝牙音箱",
        productIds: ["p-blue", "p-black"],
        orderKeys: [key(1), key(2), key(3)],
        paidAtByOrderKey: {
          [key(1)]: 1_786_500_000_000,
          [key(2)]: 1_786_500_000_000,
          [key(3)]: 1_786_500_000_000,
        },
        orders: 3,
        items: 4,
        sales: 14,
        salesCurrency: "USD",
      },
      {
        name: "便携蓝牙音箱",
        productIds: ["p-portable"],
        orderKeys: [],
        paidAtByOrderKey: {},
        orders: 0,
        items: 0,
        sales: 0,
        salesCurrency: "USD",
      },
    ]);
    expect(result.videos).toMatchObject([{
      videoId: "7667000000000000001",
      productName: "户外蓝牙音箱",
      orderKeys: [key(2), key(3)],
      orders: 2,
    }]);
    expect(result.unmappedOrderKeys).toEqual([key(4)]);
  });

  it("refuses a raw or malformed order identifier", () => {
    const contract = baseContract();
    contract.paid_snapshot_rows = [paidRow("p-blue", ["raw-order-id"], 1, "3.25")];
    expect(() => buildProductSpikeSnapshot(contract, profile, {
      shop: "STOREONE",
      products: { "p-blue": "户外蓝牙音箱", "p-portable": "便携蓝牙音箱" },
    }, "2026-08-12")).toThrow("非脱敏订单键");
  });
});

function baseContract(): TikTokPaidOrderSnapshotContract {
  return {
    ok: true,
    dataset: "paid_order_snapshot",
    shop: { id: "7494514159832827679", name: "STOREONE" },
    window_start: "2026-08-12",
    window_end_exclusive: "2026-08-13",
    fetched_at: "2026-08-12T02:00:00+00:00",
    business_time_zone: "Asia/Shanghai",
    paid_snapshot_policy: "paid_positive_non_sample_local_day_exact_v2",
    paid_snapshot_dates: ["2026-08-12"],
    paid_snapshot_rows: [],
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
    missing_capabilities: ["seller.affiliate_collaboration.read"],
    errors: [],
    pagination_truncated: false,
  };
}

function paidRow(productId: string, keys: string[], items: number, sales: string) {
  return {
    date: "2026-08-12",
    product_id: productId,
    total_items: items,
    total_orders: keys.length,
    sales_amount: sales,
    sales_currency: "USD",
    sales_ready: true,
    total_order_keys: keys,
    total_order_paid_at: Object.fromEntries(keys.map((key) => [key, 1_786_500_000])),
  };
}

function key(value: number): string {
  return value.toString(16).padStart(20, "0");
}
