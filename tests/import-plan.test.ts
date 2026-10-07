import { describe, expect, it } from "vitest";
import { convertRowForFeishu, createImportPlan } from "../src/importer/plan.js";
import type { TableData } from "../src/types/index.js";

describe("导入预演", () => {
  it("确定类型才创建数字/日期字段，混合值保守使用文本", () => {
    const table: TableData = {
      sourceName: "fixture.csv", sheetName: "Sheet1", headers: ["日期", "金额", "混合"], updatedAt: new Date(),
      rows: [
        { 日期: "2026-07-21", 金额: "10.5", 混合: "1" },
        { 日期: "2026-07-22", 金额: 20, 混合: "备注" },
      ],
    };
    const plan = createImportPlan(table);
    expect(plan.fields.map((field) => field.type)).toEqual(["日期", "数字", "文本"]);
    expect(convertRowForFeishu(table.rows[0], plan.fields)).toMatchObject({ 金额: 10.5, 混合: "1" });
  });
});
