import { describe, expect, it } from "vitest";
import {
  CrossTenantQueryService,
  emptyCrossTenantContext,
  localCrossTenantPlan,
  type CrossTenantRuntime,
} from "../src/bot/cross-tenant-query.js";
import { MockModelProvider } from "../src/ai/providers.js";
import type { DataSource, TableData } from "../src/types/index.js";

function runtime(
  id: string,
  name: string,
  currencyCode: string,
  rows: TableData["rows"],
): CrossTenantRuntime {
  const table: TableData = {
    sourceName: "test",
    sheetName: "投产比",
    headers: ["商品", "日期", "单量", "数量", "销售额", "总单量", "总数量", "店铺销售额"],
    rows,
    updatedAt: new Date("2026-08-06T00:00:00Z"),
  };
  const dataSource: DataSource = { async getTable() { return table; } };
  return {
    id,
    displayName: name,
    aliases: [`${name}官方店`],
    dataSource,
    queryConcurrency: 2,
    profile: {
      schemaVersion: 1,
      templateMode: false,
      businessDisplayName: name,
      businessTimeZone: "Asia/Shanghai",
      storeAggregateLabel: "店铺汇总",
      tables: { development: "开发", cooperation: "合作", online: "上线", roi: "投产比" },
      tiktok: {
        shopAlias: name,
        shopTimeZone: "America/Los_Angeles",
        currencyCode,
        productMapFile: `config/tenants/${id}.products.json`,
      },
    },
  };
}

const storeA = runtime("store-a", "晨光店", "USD", [
  { 商品: "磨脚器", 日期: "2026-08-03", 单量: 2, 数量: 3, 销售额: 30 },
  { 商品: "磨脚器", 日期: "2026-08-04", 单量: 3, 数量: 4, 销售额: 40 },
  { 商品: "店铺汇总", 日期: "2026-08-03", 总单量: 2, 总数量: 3, 店铺销售额: 30 },
  { 商品: "店铺汇总", 日期: "2026-08-04", 总单量: 3, 总数量: 4, 店铺销售额: 40 },
]);
const storeB = runtime("store-b", "星河店", "USD", [
  { 商品: "水枪喷头", 日期: "2026-08-03", 单量: 5, 数量: 6, 销售额: 60 },
  { 商品: "水枪喷头", 日期: "2026-08-04", 单量: 6, 数量: 7, 销售额: 70 },
  { 商品: "水枪喷头", 日期: "2026-08-05", 单量: 100, 数量: 100, 销售额: 1_000 },
]);

describe("cross tenant private query", () => {
  it("routes a named store without silently selecting the default store", () => {
    const plan = localCrossTenantPlan("查一下星河店最近7天销量", [storeA, storeB], emptyCrossTenantContext());
    expect(plan.intent).toBe("single_store_query");
    expect(plan.tenantIds).toEqual(["store-b"]);
    expect(plan.metric).toBe("quantity");
  });

  it("uses the common latest date and never double-counts the store aggregate row", async () => {
    const service = new CrossTenantQueryService([storeA, storeB], new MockModelProvider());
    const result = await service.resolve("最近2天哪家店销售额最高", emptyCrossTenantContext());
    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") return;
    expect(result.text).toContain("星河店 的销售额最高");
    expect(result.text).toContain("2026-08-03 至 2026-08-04");
    expect(result.text).toContain("星河店：130 USD");
    expect(result.text).toContain("晨光店：70 USD");
    expect(result.text).not.toContain("110 USD");
  });

  it("returns the winning product together with its store", async () => {
    const service = new CrossTenantQueryService([storeA, storeB], new MockModelProvider());
    const result = await service.resolve("最近2天销量最高的产品来自哪个店", emptyCrossTenantContext());
    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") return;
    expect(result.text).toContain("星河店 的“水枪喷头”排第一");
    expect(result.text).toContain("水枪喷头：13件");
  });

  it("refuses to rank sales amounts across different currencies", async () => {
    const eur = runtime("store-c", "欧元店", "EUR", [
      { 商品: "收纳箱", 日期: "2026-08-04", 单量: 1, 数量: 1, 销售额: 100 },
    ]);
    const service = new CrossTenantQueryService([storeA, eur], new MockModelProvider());
    const result = await service.resolve("最近1天哪家店销售额最高", emptyCrossTenantContext());
    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") return;
    expect(result.text).toContain("币种不同");
    expect(result.text).toContain("不能直接排名");
  });

  it("returns a controlled no-comparison answer when one store read fails", async () => {
    const unavailable = {
      ...storeB,
      dataSource: {
        async getTable() {
          throw new Error("socket hang up ECONNRESET");
        },
      },
    } satisfies CrossTenantRuntime;
    const service = new CrossTenantQueryService([storeA, unavailable], new MockModelProvider());
    const result = await service.resolve("最近2天哪家店销售额最高", emptyCrossTenantContext());
    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") return;
    expect(result.text).toContain("没有完成跨店比较");
    expect(result.text).toContain("瞬时读取失败：星河店");
    expect(result.text).toContain("不用改写问题");
    expect(result.text).not.toContain("晨光店 的销售额最高");
  });

  it("keeps cross-store follow-up context separate and carries the requested range", async () => {
    const service = new CrossTenantQueryService([storeA, storeB], new MockModelProvider());
    const first = await service.resolve("最近2天哪家店销售额最高", emptyCrossTenantContext());
    const second = await service.resolve("那销量呢", first.context);
    expect(second.kind).toBe("answer");
    if (second.kind !== "answer") return;
    expect(second.text).toContain("销量最高");
    expect(second.text).toContain("2026-08-03 至 2026-08-04");
    expect(second.context.lastDays).toBe(2);
  });

  it("does not pretend that a shortened common window is the requested 10 or 15 days", async () => {
    const service = new CrossTenantQueryService([storeA, storeB], new MockModelProvider());
    for (const days of [10, 15]) {
      const result = await service.resolve(`最近${days}天哪家店销售额最高`, emptyCrossTenantContext());
      expect(result.kind).toBe("answer");
      if (result.kind !== "answer") continue;
      expect(result.text).toContain(`你要求：`);
      expect(result.text).toContain(`（${days}日）`);
      expect(result.text).toContain("实际可比：2026-08-03 至 2026-08-04（2日）");
      expect(result.text).toContain(`不冒充完整 ${days} 日`);
    }
  });

  it("preserves an explicit dotted date range instead of letting the model replace it", () => {
    const plan = localCrossTenantPlan("从2026.8.3到2026.8.4比较两家店销量", [storeA, storeB], emptyCrossTenantContext());
    expect(plan.startDate).toBe("2026-08-03");
    expect(plan.endDate).toBe("2026-08-04");
  });

  it("reports a tie instead of choosing a winner alphabetically", async () => {
    const zeroA = runtime("zero-a", "甲店", "USD", [
      { 商品: "A", 日期: "2026-08-04", 单量: 0, 数量: 0, 销售额: 0 },
    ]);
    const zeroB = runtime("zero-b", "乙店", "USD", [
      { 商品: "B", 日期: "2026-08-04", 单量: 0, 数量: 0, 销售额: 0 },
    ]);
    const service = new CrossTenantQueryService([zeroA, zeroB], new MockModelProvider());
    const result = await service.resolve("最近1天哪家店销售额最高", emptyCrossTenantContext());
    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") return;
    expect(result.text).toContain("并列最高");
    expect(result.text).toContain("没有唯一赢家");
  });
});
