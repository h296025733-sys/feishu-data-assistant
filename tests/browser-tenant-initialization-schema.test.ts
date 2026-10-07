import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ROI_COLUMNS,
  PRODUCT_ROI_COLUMNS,
  storeRoiColumns,
  toBrowserTsv,
} from "../src/cli/browser-tenant-initialization-schema.js";

describe("browser tenant initialization target schemas", () => {
  it("matches the formal product ROI target order and preserves blank manual ad fields", () => {
    expect(PRODUCT_ROI_COLUMNS).toEqual([
      "检查", "店铺", "商品", "TikTok商品ID", "日期", "上线量", "出单视频", "单量", "数量", "视频曝光", "销售额", "数据状态",
      "广告花费有", "广告花费", "广告出单量",
    ]);

    const cells = toBrowserTsv(PRODUCT_ROI_COLUMNS, [{
      检查: "key",
      店铺: "Store",
      商品: "Product",
      TikTok商品ID: "1732490112262508744",
      日期: "2026-08-24",
      数据状态: "完整",
    }]).split("\t");
    expect(cells).toHaveLength(15);
    expect(cells.slice(11)).toEqual(["完整", "", "", ""]);
  });

  it("matches the formal account ROI target order and preserves blank manual ad fields", () => {
    expect(ACCOUNT_ROI_COLUMNS).toEqual([
      "检查", "店铺", "账号", "账号UID", "日期", "上线量", "出单视频", "单量", "数量", "视频曝光", "销售额", "数据状态", "账号类型",
      "广告花费", "广告出单量",
    ]);

    const cells = toBrowserTsv(ACCOUNT_ROI_COLUMNS, [{
      检查: "key",
      店铺: "Store",
      账号: "Account",
      日期: "2026-08-24",
      数据状态: "完整",
    }]).split("\t");
    expect(cells).toHaveLength(15);
    expect(cells.slice(11)).toEqual(["完整", "", "", ""]);
  });

  it("builds the 53-column store ROI order with tenant-specific API ad fields", () => {
    const columns = storeRoiColumns({
      spendFieldName: "Storetwo Botanical Care广告花费",
      orderFieldName: "Storetwo Botanical Care广告出单量",
    });
    expect(columns).toHaveLength(53);
    expect(columns.slice(24, 30)).toEqual([
      "总广告出单量",
      "总广告花费",
      "Storetwo Botanical Care广告花费",
      "Storetwo Botanical Care广告出单量",
      "退货量",
      "备注",
    ]);
    expect(columns.at(-2)).toBe("店铺商品卡出单量(API)");
    expect(columns.at(-1)).toBe("店铺商品卡出单数量");
  });
});
