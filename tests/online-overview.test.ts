import { describe, expect, it } from "vitest";
import { buildOnlineOverview } from "../src/query/overview.js";
import type { QueryIntent, TableData } from "../src/types/index.js";

const summaryIntent: QueryIntent = {
  intent: "summary",
  metricField: null,
  entityField: null,
  entityValue: null,
  dateField: "实上线日期(Ct)",
  startDate: null,
  endDate: null,
  sortDirection: null,
  sortField: null,
  limit: 10,
  selectFields: [],
  responseStyle: "concise",
  outputMode: "answer",
};

describe("online overview", () => {
  it("does not describe all-zero sales as being near a historical high", () => {
    const table: TableData = {
      sourceName: "test",
      sheetName: "红人上线表",
      headers: ["实上线日期(Ct)", "达人姓名", "挂车产品", "销售额"],
      updatedAt: new Date(),
      rows: [
        { "实上线日期(Ct)": "2026-07-30", 达人姓名: "a", 挂车产品: "商品A", 销售额: 0 },
        { "实上线日期(Ct)": "2026-08-01", 达人姓名: "a", 挂车产品: "商品A", 销售额: 0 },
      ],
    };
    const overview = buildOnlineOverview(table, table.rows, summaryIntent);
    expect(overview.trendSummary).toBe("当前上线记录暂无销售额，暂无法判断销售趋势");
    expect(overview.trendSummary).not.toContain("高位");
  });
});
