import { describe, expect, it } from "vitest";
import {
  ACCOUNT_SIDE_TABLES,
  accountFields,
  accountSideRoiFields,
  accountSideManagedUpdateFields,
  advertisingOrdersByDateFromRows,
  advertisingSpendByDateFromRows,
  mergeAccountSideAdvertisingSpend,
  preserveAccountSideManualAdvertising,
  videoFields,
} from "../src/feishu/account-side-test.js";
import type { AccountSideAccount, AccountSidePlan, AccountSideRoiRow, AccountSideVideo } from "../src/account-side/plan.js";

describe("account-side formal manual-field safety", () => {
  const preserved = new Set(["负责人", "UID", "账号", "密码", "备注"]);

  it("does not overwrite user-owned fields when automatic fields are unchanged", () => {
    const update = accountSideManagedUpdateFields(
      { 账号主页: { text: "@account_a", link: "https://www.tiktok.com/@account_a" }, 账号名: "子账号A", 负责人: "用户填写", UID: "人工UID", 账号: "人工账号", 密码: "人工密码", 备注: "人工备注" },
      { 账号主页: { text: "@account_a", link: "https://www.tiktok.com/@account_a" }, 账号名: "子账号A" },
      preserved,
    );
    expect(update).toBeNull();
  });

  it("updates automatic fields without including user-owned fields in the patch", () => {
    const update = accountSideManagedUpdateFields(
      { 账号主页: { text: "@account_a", link: "https://www.tiktok.com/@account_a" }, 账号名: "旧名称", 负责人: "用户填写", UID: "人工UID", 账号: "人工账号", 密码: "人工密码", 备注: "人工备注" },
      { 账号主页: { text: "@account_a", link: "https://www.tiktok.com/@account_a" }, 账号名: "新名称" },
      preserved,
    );
    expect(update).toEqual({ 账号主页: { text: "@account_a", link: "https://www.tiktok.com/@account_a" }, 账号名: "新名称" });
    expect(update).not.toHaveProperty("负责人");
    expect(update).not.toHaveProperty("UID");
    expect(update).not.toHaveProperty("账号");
    expect(update).not.toHaveProperty("密码");
    expect(update).not.toHaveProperty("备注");
  });

  it("keeps only the requested display fields in the two source tables", () => {
    const account = ACCOUNT_SIDE_TABLES.find((table) => table.name === "视频号信息统计")!;
    const video = ACCOUNT_SIDE_TABLES.find((table) => table.name === "短视频数据表")!;
    expect(account.fields.map((field) => field.field_name)).toEqual([
      "负责人", "账号名", "UID", "账号", "密码", "账号主页", "账号类型", "备注",
    ]);
    expect(video.fields.map((field) => field.field_name)).toEqual([
      "达人昵称", "达人ID", "视频ID网址", "发布时间", "商品", "视频vv", "视频商品成交件数", "商品交易总额（视频） ($)",
    ]);
  });

  it("adds one advertising-spend and one advertising-order field to both account-side ROI tables", () => {
    for (const name of ["产品投产比", "账号投产比"] as const) {
      const table = ACCOUNT_SIDE_TABLES.find((item) => item.name === name)!;
      const spend = table.fields.filter((field) => field.field_name === "广告花费");
      const orders = table.fields.filter((field) => field.field_name === "广告出单量");
      expect(spend).toHaveLength(1);
      expect(spend[0]).toMatchObject({ type: 2, ui_type: "Currency" });
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({ type: 2, ui_type: "Number" });
    }
  });

  it("parses store-side formula shapes, preserves blank versus zero, and rejects duplicate store dates", () => {
    const timestamp = new Date("2026-08-11T00:00:00+08:00").getTime();
    const rows = [
      { fields: { 商品: "店铺汇总", 日期: timestamp, 总广告花费: [{ text: "0", type: "text" }], 总广告出单量: [{ text: "0", type: "text" }] } },
      { fields: { 商品: "店铺汇总", 日期: "2026-08-12", 总广告花费: { value: "$12.34" }, 总广告出单量: { value: "3" } } },
      { fields: { 商品: "店铺汇总", 日期: "2026-08-13", 总广告花费: [], 总广告出单量: [] } },
      { fields: { 商品: "户外蓝牙音箱", 日期: "2026-08-11", 总广告花费: 999, 总广告出单量: 999 } },
    ];
    const spend = advertisingSpendByDateFromRows(rows, {
      storeAggregateLabel: "店铺汇总",
      businessTimeZone: "Asia/Shanghai",
    });
    expect(spend.get("2026-08-11")).toBe(0);
    expect(spend.get("2026-08-12")).toBe(12.34);
    expect(spend.get("2026-08-13")).toBeNull();
    const orders = advertisingOrdersByDateFromRows(rows, {
      storeAggregateLabel: "店铺汇总",
      businessTimeZone: "Asia/Shanghai",
    });
    expect(orders.get("2026-08-11")).toBe(0);
    expect(orders.get("2026-08-12")).toBe(3);
    expect(orders.get("2026-08-13")).toBeNull();
    expect(() => advertisingSpendByDateFromRows([...rows, rows[0]!], {
      storeAggregateLabel: "店铺汇总",
      businessTimeZone: "Asia/Shanghai",
    })).toThrow("重复");
  });

  it("writes both advertising totals only to the two store-overview rows", () => {
    const row = (dimension: string, dimensionId: string): AccountSideRoiRow => ({
      key: `STOREONE|${dimension}|2026-08-11`, store: "STOREONE", dimension, dimensionId,
      accountTypeLabel: "", date: "2026-08-11", publishedVideos: 1, orderingVideos: 0,
      orders: 0, items: 0, views: 10, gmv: 0, status: "完整",
    });
    const plan = {
      version: 1,
      generatedAt: "2026-08-13T00:00:00.000Z",
      shop: { id: "shop", name: "STOREONE" },
      latestAvailableDate: "2026-08-11",
      startDate: "2026-08-11",
      endDateInclusive: "2026-08-11",
      dates: ["2026-08-11"],
      accounts: [], videos: [],
      productRows: [row("STOREONE", ""), row("户外蓝牙音箱", "product")],
      accountRows: [row("STOREONE", ""), row("storeone80", "account")],
      requestIds: [], sourceFiles: [], warnings: [],
    } satisfies AccountSidePlan;
    const merged = mergeAccountSideAdvertisingSpend(
      plan,
      new Map([["2026-08-11", 8.88]]),
      new Map([["2026-08-11", 2]]),
    );
    expect(merged.productRows[0].adSpend).toBe(8.88);
    expect(merged.accountRows[0].adSpend).toBe(8.88);
    expect(merged.productRows[0].adOrders).toBe(2);
    expect(merged.accountRows[0].adOrders).toBe(2);
    expect(Object.hasOwn(merged.productRows[1]!, "adSpend")).toBe(false);
    expect(Object.hasOwn(merged.accountRows[1]!, "adSpend")).toBe(false);
    expect(Object.hasOwn(merged.productRows[1]!, "adOrders")).toBe(false);
    expect(Object.hasOwn(merged.accountRows[1]!, "adOrders")).toBe(false);
    expect(accountSideRoiFields(merged.productRows[0]!, "商品", "TikTok商品ID")).toMatchObject({ 广告花费: 8.88, 广告出单量: 2 });
    expect(accountSideRoiFields({ ...merged.productRows[0]!, adSpend: null, adOrders: null }, "商品", "TikTok商品ID"))
      .toMatchObject({ 广告花费: null, 广告出单量: null });
    expect(accountSideRoiFields(merged.productRows[1]!, "商品", "TikTok商品ID")).not.toHaveProperty("广告花费");
    expect(accountSideRoiFields(merged.productRows[1]!, "商品", "TikTok商品ID")).not.toHaveProperty("广告出单量");
  });

  it("strips advertising values from the automatic plan so daily sync preserves manual cells", () => {
    const roiRow = (dimension: string, dimensionId: string): AccountSideRoiRow => ({
      key: `STOREONE|${dimension}|2026-08-11`, store: "STOREONE", dimension, dimensionId,
      accountTypeLabel: "", date: "2026-08-11", publishedVideos: 1, orderingVideos: 0,
      orders: 0, items: 0, views: 10, gmv: 0, status: "完整",
    });
    const plan = {
      version: 1,
      generatedAt: "2026-08-13T00:00:00.000Z",
      shop: { id: "shop", name: "STOREONE" },
      latestAvailableDate: "2026-08-11",
      startDate: "2026-08-11",
      endDateInclusive: "2026-08-11",
      dates: ["2026-08-11"],
      accounts: [], videos: [],
      productRows: [{ ...roiRow("STOREONE", ""), adSpend: 8.88, adOrders: 2 }, roiRow("户外蓝牙音箱", "product")],
      accountRows: [{ ...roiRow("STOREONE", ""), adSpend: 8.88, adOrders: 2 }, roiRow("storeone80", "account")],
      requestIds: [], sourceFiles: [], warnings: [],
    } satisfies AccountSidePlan;
    const automatic = preserveAccountSideManualAdvertising(plan);
    for (const target of [automatic.productRows[0]!, automatic.accountRows[0]!]) {
      expect(Object.hasOwn(target, "adSpend")).toBe(false);
      expect(Object.hasOwn(target, "adOrders")).toBe(false);
    }
    expect(accountSideRoiFields(automatic.productRows[0]!, "商品", "TikTok商品ID")).not.toHaveProperty("广告花费");
    expect(accountSideRoiFields(automatic.accountRows[0]!, "账号", "账号UID")).not.toHaveProperty("广告出单量");
  });

  it("never writes API UID or notes into the manual account fields", () => {
    const account: AccountSideAccount = {
      key: "STOREONE|api-uid",
      store: "STOREONE",
      owner: "STOREONE",
      accountName: "STOREONE_shop",
      uid: "api-uid",
      handle: "storeone80",
      accountType: "OFFICIAL_ACCOUNTS",
      accountTypeLabel: "官方账号",
      status: "启用",
      notes: "自动备注",
    };
    expect(accountFields(account)).toEqual({
      账号名: "STOREONE_shop",
      账号主页: { text: "@storeone80", link: "https://www.tiktok.com/@storeone80" },
      账号类型: "官方账号",
    });
    expect(accountFields(account, 1)).toEqual({
      账号名: "STOREONE_shop",
      账号主页: "https://www.tiktok.com/@storeone80",
      账号类型: "官方账号",
    });
  });

  it("maps short-video rows to the eight native template fields", () => {
    const video: AccountSideVideo = {
      key: "STOREONE|123|456",
      store: "STOREONE",
      accountNickName: "STOREONE音响店",
      accountName: "storeone80",
      accountUid: "creator-open-id",
      accountType: "OFFICIAL_ACCOUNTS",
      accountTypeLabel: "官方账号",
      videoId: "1234567890123456789",
      videoUrl: "https://www.tiktok.com/@storeone80/video/1234567890123456789",
      publishedAtMs: 1_786_000_000_000,
      publishedBusinessDate: "2026-08-10",
      productName: "户外蓝牙音箱",
      productId: "456",
      views: 321,
      orders: 2,
      items: 3,
      gmv: 65.99,
      metricStartDate: "2026-08-09",
      metricEndDate: "2026-08-15",
      fetchedAtMs: 1_786_100_000_000,
      status: "完整",
    };
    expect(videoFields(video)).toEqual({
      达人昵称: "STOREONE音响店",
      达人ID: "@storeone80",
      视频ID网址: "https://www.tiktok.com/@storeone80/video/1234567890123456789",
      发布时间: 1_786_000_000_000,
      商品: "户外蓝牙音箱",
      视频vv: 0.321,
      视频商品成交件数: 3,
      "商品交易总额（视频） ($)": 65.99,
    });
  });

});
