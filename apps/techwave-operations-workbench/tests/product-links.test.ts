import { describe, expect, it } from "vitest";
import {
  buildTikTokProductUrl,
  mergeProductMappings,
  productUrlForName,
  verifiedFormalProductMappings,
} from "../src/product-links";

describe("TikTok product direct links", () => {
  it("builds the current public US PDP route from a validated product id", () => {
    expect(buildTikTokProductUrl("1732523630634439455"))
      .toBe("https://shop.tiktok.com/us/pdp/product/1732523630634439455");
    expect(buildTikTokProductUrl("javascript:alert(1)")).toBeNull();
    expect(buildTikTokProductUrl("123")).toBeNull();
  });

  it("covers every currently formal product and exposes one link per name", () => {
    const mappings = verifiedFormalProductMappings();
    expect(mappings.map((mapping) => mapping.productName).sort()).toEqual([
      "便携蓝牙音箱",
      "户外蓝牙音箱",
      "水杨酸沐浴露",
    ]);
    expect(productUrlForName("户外蓝牙音箱", mappings))
      .toContain("1732523630634439455");
  });

  it("lets a verified per-Base mapping override the packaged fallback safely", () => {
    const merged = mergeProductMappings(
      [{ productName: "商品A", tiktokProductId: "1730000000000000001", updatedAt: "old" }],
      [{ productName: "商品A", tiktokProductId: "1730000000000000002", updatedAt: "new" }],
    );
    expect(merged).toEqual([
      { productName: "商品A", tiktokProductId: "1730000000000000002", updatedAt: "new" },
    ]);
    expect(productUrlForName("商品A", [merged[0], { ...merged[0] }])).toBeNull();
  });
});
