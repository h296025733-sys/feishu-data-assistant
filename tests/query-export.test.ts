import { describe, expect, it } from "vitest";
import { buildCsvExport } from "../src/query/export.js";
import { assertExecutableQueryIntent } from "../src/bot/service.js";
import { executeQuery } from "../src/query/engine.js";
import { parseQuestion } from "../src/query/parser.js";
import type { FieldRoles, TableData } from "../src/types/index.js";

const table: TableData = {
  sourceName: "test",
  sheetName: "投产比",
  headers: ["商品", "日期", "店铺浏览量", "单量"],
  rows: [
    { 商品: "TechWave", 日期: "2026-08-03", 店铺浏览量: 101, 单量: 2 },
    { 商品: "TechWave", 日期: "2026-08-03", 店铺浏览量: 100, 单量: 1 },
    { 商品: "TechWave", 日期: "2026-07-31", 店铺浏览量: 250, 单量: 3 },
  ],
  updatedAt: new Date("2026-08-03T00:00:00Z"),
};

const roles: FieldRoles = {
  dateField: "日期",
  entityField: "商品",
  amountField: null,
  quantityField: "单量",
  ambiguous: {},
};

describe("natural-language filtered export", () => {
  it("recognizes calendar week, numeric comparison, and export mode", () => {
    const parsed = parseQuestion(
      "这一周店铺浏览量大于100的数据都导出",
      table,
      roles,
      new Date("2026-08-03T16:00:00+08:00"),
    );
    expect(parsed.intent).toMatchObject({
      intent: "records",
      dateField: "日期",
      startDate: "2026-08-03",
      endDate: "2026-08-03",
      outputMode: "export",
      responseStyle: "table",
      entityField: "商品",
      entityValue: "TechWave",
      numericFilters: [{ field: "店铺浏览量", operator: "gt", value: 100 }],
    });
    expect(parsed.intent.selectFields).toEqual(expect.arrayContaining(["商品", "日期", "店铺浏览量"]));
  });

  it("keeps common week expressions deterministic", () => {
    const now = new Date("2026-08-03T16:00:00+08:00");
    expect(parseQuestion("近一周店铺浏览量大于100的数据导出", table, roles, now).intent)
      .toMatchObject({ startDate: "2026-07-27", endDate: "2026-08-02" });
    expect(parseQuestion("近七天店铺浏览量小于50的数据导出", table, roles, now).intent)
      .toMatchObject({ startDate: "2026-07-27", endDate: "2026-08-02", entityValue: "TechWave" });
    expect(parseQuestion("上星期店铺浏览量大于100的数据导出", table, roles, now).intent)
      .toMatchObject({ startDate: "2026-07-27", endDate: "2026-08-02" });
  });

  it("treats thresholds as arbitrary values instead of hard-coding 100", () => {
    const now = new Date("2026-08-03T16:00:00+08:00");
    expect(parseQuestion("这一周店铺浏览量大于200的数据导出", table, roles, now).intent.numericFilters)
      .toEqual([{ field: "店铺浏览量", operator: "gt", value: 200 }]);
    expect(parseQuestion("这一周店铺浏览量小于50的数据导出", table, roles, now).intent.numericFilters)
      .toEqual([{ field: "店铺浏览量", operator: "lt", value: 50 }]);
    expect(parseQuestion("这一周店铺浏览量大于等于100.5的数据导出", table, roles, now).intent.numericFilters)
      .toEqual([{ field: "店铺浏览量", operator: "gte", value: 100.5 }]);
  });

  it("applies the filter before exporting and keeps strict > semantics", () => {
    const intent = parseQuestion(
      "这一周店铺浏览量大于100的数据都导出",
      table,
      roles,
      new Date("2026-08-03T16:00:00+08:00"),
    ).intent;
    expect(intent.entityValue).toBe("TechWave");
    const result = executeQuery(table, intent);
    expect(result.matchedRows).toBe(1);
    expect(result.value).toEqual([expect.objectContaining({ 商品: "TechWave", 店铺浏览量: 101 })]);
  });

  it("generates Excel-friendly UTF-8 CSV and neutralizes spreadsheet formulas", () => {
    const exported = buildCsvExport([{ 商品: "=1+1", 店铺浏览量: 101 }], new Date("2026-08-03T16:00:00+08:00"));
    const text = exported.content.toString("utf8");
    expect(text.startsWith("\uFEFF")).toBe(true);
    expect(text).toContain("\"'=1+1\"");
    expect(exported.fileName).toMatch(/^TechWave数据导出-\d{14}\.csv$/);
  });

  it("refuses ambiguous or unit-dependent thresholds instead of exporting everything", () => {
    const baseIntent = parseQuestion(
      "这一周的数据导出",
      table,
      roles,
      new Date("2026-08-03T16:00:00+08:00"),
    ).intent;
    expect(() => assertExecutableQueryIntent("这一周店铺浏览量明显偏高的数据导出", baseIntent))
      .toThrow(/无法可靠确定具体数字/);
    expect(() => assertExecutableQueryIntent("这一周转化率大于5%的数据导出", {
      ...baseIntent,
      numericFilters: [{ field: "店铺浏览量", operator: "gt", value: 5 }],
    })).toThrow(/百分比阈值需要先明确/);
  });

  it("rejects applying a store-only metric to a single product", () => {
    expect(() => parseQuestion(
      "近七天电动磨脚器店铺浏览量小于50的数据导出",
      {
        ...table,
        rows: [...table.rows, { 商品: "电动磨脚器", 日期: "2026-08-01", 店铺浏览量: null, 单量: 2 }],
      },
      roles,
      new Date("2026-08-03T16:00:00+08:00"),
    )).toThrow(/全店指标/);
  });

  it("returns an empty record result for a valid export window instead of dropping the date filter", () => {
    const intent = parseQuestion(
      "近七天店铺浏览量小于50的数据导出",
      table,
      roles,
      new Date("2026-08-03T16:00:00+08:00"),
    ).intent;
    const result = executeQuery(table, intent);
    expect(result.matchedRows).toBe(0);
    expect(result.value).toEqual([]);
    expect(result.dateRange).toBe("2026-07-27 至 2026-08-02");
  });
});
