import { describe, expect, it } from "vitest";
import { canonicalizeProductName, requireCanonicalProductName } from "../src/business/product-naming.js";

describe("四表商品命名规范", () => {
  it("保留精炼中文名", () => {
    for (const name of ["闪亮棒", "水枪喷头", "防蚊门帘", "透明收纳箱", "泡沫清洁剂"]) {
      expect(canonicalizeProductName(name)).toBe(name);
    }
  });

  it("统一多件装为全角括号和大写PCS", () => {
    expect(canonicalizeProductName("透明收纳箱 (2pcs)")).toBe("透明收纳箱（2PCS）");
    expect(canonicalizeProductName("透明收纳箱（4个装）")).toBe("透明收纳箱（4PCS）");
  });

  it("拒绝把长标题或链接直接当作正式商品名", () => {
    expect(() => requireCanonicalProductName("https://example.com/product/1")).toThrow("精炼中文名");
    expect(() => requireCanonicalProductName("超长促销爆款商品名称包含大量无关关键词以及完全不适合业务表的营销描述")).toThrow("精炼中文名");
  });
});
