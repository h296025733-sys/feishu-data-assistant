import { describe, expect, it } from "vitest";
import { formatAnswer } from "../src/query/answer.js";
import type { QueryIntent, TableData } from "../src/types/index.js";
import type { QueryResult } from "../src/query/engine.js";

const table: TableData = {
  sourceName: "飞书多维表格",
  sheetName: "红人合作表",
  headers: [],
  rows: [],
  updatedAt: new Date("2026-08-05T00:00:00.000Z"),
};

const intent: QueryIntent = {
  intent: "records",
  metricField: null,
  entityField: "红人姓名",
  entityValue: "graceguitron",
  dateField: "合作时间",
  startDate: null,
  endDate: null,
  sortDirection: null,
  sortField: null,
  limit: 10,
  selectFields: [],
  responseStyle: "table",
};

const trace = { source: "deepseek" as const, model: "deepseek-chat", durationMs: 1234, fallbackReason: null };

describe("机器人自然回复", () => {
  it("把飞书时间戳和链接对象转换成人能看的记录", () => {
    const result: QueryResult = {
      value: [{
        红人姓名: "graceguitron",
        合作时间: 1_784_995_200_000,
        开发人: "李",
        主页: { text: "[https://www.tiktok.com/@graceguitron](https://www.tiktok.com/@graceguitron)", type: "text" },
        备注: null,
      }],
      matchedRows: 1,
      displayedRows: 1,
      matchedByTable: { 红人合作表: 1 },
      invalidNumericRows: 0,
      duplicateRowsDetected: 0,
      metricField: "记录明细",
      entityValue: "graceguitron",
      dateRange: "全部日期",
    };
    const answer = formatAnswer(table, result, intent, trace);
    expect(answer).toContain("1. graceguitron");
    expect(answer).toContain("合作时间：2026-07-26");
    expect(answer).toContain("主页：https://www.tiktok.com/@graceguitron");
    expect(answer).not.toContain("1,784,995,200,000");
    expect(answer).not.toContain('{\"text\"');
    expect(answer).not.toContain("--- | ---");
    expect(answer).not.toContain("备注：");
  });

  it("详细回复不再暴露模型、内部来源和耗时", () => {
    const detailed = { ...intent, responseStyle: "detailed" as const };
    const result: QueryResult = {
      value: [{ 红人姓名: "graceguitron" }],
      matchedRows: 1,
      displayedRows: 1,
      matchedByTable: { 红人合作表: 1 },
      invalidNumericRows: 0,
      duplicateRowsDetected: 0,
      metricField: "记录明细",
      entityValue: "graceguitron",
      dateRange: "全部日期",
    };
    const answer = formatAnswer(table, result, detailed, trace);
    expect(answer).toContain("找到了 1 条");
    expect(answer).not.toContain("DeepSeek");
    expect(answer).not.toContain("数据来源");
    expect(answer).not.toContain("问题解析");
  });
});
