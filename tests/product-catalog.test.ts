import { describe, expect, it } from "vitest";
import { buildProductCatalogPlan } from "../src/automation/product-catalog.js";
import type { TikTokMachineContract } from "../src/realtime/types.js";

function contract(): TikTokMachineContract {
  return {
    ok: true,
    dataset: "shop_product_performance",
    shop: { name: "Storefour" },
    window_start: "2026-08-01",
    window_end_exclusive: "2026-08-03",
    fetched_at: "2026-08-04T00:00:00Z",
    rows: [
      { id: "1", name: "long source title" },
      { id: "2", name: "unknown source title" },
    ],
    row_count: 2,
    exact_duplicate_count: 0,
    conflicting_duplicate_ids: [],
    request_ids: [],
    raw_source_paths: [],
    normalized_source_path: null,
    required_scope: [],
    granted_scope: [],
    missing_capabilities: [],
    errors: [],
  };
}

describe("product catalog", () => {
  it("provisions only human-confirmed canonical names and reports unknown products", () => {
    expect(buildProductCatalogPlan(contract(), {
      shop: "Store Four",
      products: { "1": "电动磨脚器", "9": "防蚊门帘" },
    })).toEqual({
      canonicalNames: ["电动磨脚器", "防蚊门帘"].sort((a, b) => a.localeCompare(b, "zh-CN")),
      observedMappedNames: ["电动磨脚器"],
      unmappedProducts: [{ id: "2", sourceTitle: "unknown source title" }],
    });
  });

  it("strictly ignores mapped and unknown products outside the store allowlist", () => {
    expect(buildProductCatalogPlan(contract(), {
      shop: "Storefour",
      products: { "1": "水杨酸沐浴露", "9": "电动磨脚器" },
    }, undefined, ["水杨酸沐浴露"])).toEqual({
      canonicalNames: ["水杨酸沐浴露"],
      observedMappedNames: ["水杨酸沐浴露"],
      unmappedProducts: [],
    });
  });

  it("refuses a contract from another store", () => {
    const other = contract();
    other.shop = { name: "Other" };
    expect(() => buildProductCatalogPlan(other, { shop: "Storefour", products: {} }))
      .toThrow("当前店铺不是");
  });

  it("uses API video product titles only as a review hint, never as a canonical option", () => {
    const videos = contract();
    videos.dataset = "shop_video_performance";
    videos.rows = [{ products: JSON.stringify([{ id: "2", name: "Long English Product Title" }]) }];
    const plan = buildProductCatalogPlan(contract(), { shop: "Storefour", products: { "1": "电动磨脚器" } }, videos);
    expect(plan.canonicalNames).toEqual(["电动磨脚器"]);
    expect(plan.unmappedProducts).toContainEqual({ id: "2", sourceTitle: "unknown source title" });

    const withoutTitle = contract();
    withoutTitle.rows[1] = { id: "2" };
    expect(buildProductCatalogPlan(withoutTitle, { shop: "Storefour", products: { "1": "电动磨脚器" } }, videos)
      .unmappedProducts).toContainEqual({ id: "2", sourceTitle: "Long English Product Title" });
  });

  it("uses official product details and excludes deactivated products from new options", () => {
    const performance = contract();
    performance.rows = [{ id: "1" }, { id: "2" }];
    const details = contract();
    details.dataset = "product_detail";
    details.rows = [
      { id: "1", title: "Active title", status: "ACTIVATE" },
      { id: "2", title: "Old title", status: "SELLER_DEACTIVATED" },
    ];
    expect(buildProductCatalogPlan(performance, { shop: "Storefour", products: {} }, details))
      .toEqual({
        canonicalNames: [],
        observedMappedNames: [],
        unmappedProducts: [{ id: "1", sourceTitle: "Active title" }],
      });
  });
});
