import { describe, expect, it } from "vitest";
import { buildAnalysisEvidence } from "../src/ai/analysis-evidence.js";
import type { TableData } from "../src/types/index.js";

describe("安全分析证据", () => {
  it("只输出聚合业务证据，不输出姓名、联系方式或账号", () => {
    const table: TableData = {
      sourceName: "飞书",
      sheetName: "Tech-wave红人合作表",
      headers: ["合作时间", "红人姓名", "开发人", "联系方式", "寄样产品", "合作方式", "粉丝数(K)", "付款账号"],
      updatedAt: new Date("2026-07-31T00:00:00Z"),
      rows: [
        { 合作时间: "2026-07-30", 红人姓名: "达人甲", 开发人: "员工甲", 联系方式: "a@example.com", 寄样产品: ["杯子", "牙刷"], 合作方式: "佣金", "粉丝数(K)": 10, 付款账号: "secret-1" },
        { 合作时间: "2026-07-31", 红人姓名: "达人乙", 开发人: "员工乙", 联系方式: "+123456789", 寄样产品: ["杯子"], 合作方式: "佣金", "粉丝数(K)": 20, 付款账号: "secret-2" },
      ],
    };

    const evidence = buildAnalysisEvidence(table);
    const serialized = JSON.stringify(evidence);

    expect(evidence.recordCount).toBe(2);
    expect(evidence.categoryBreakdowns.find((item) => item.field === "寄样产品")?.topValues)
      .toEqual([{ value: "杯子", count: 2 }, { value: "牙刷", count: 1 }]);
    expect(evidence.numericSummaries.find((item) => item.field === "粉丝数(K)"))
      .toMatchObject({ sum: 30, average: 15 });
    expect(evidence.aggregationNotes).toHaveLength(2);
    expect(serialized).not.toContain("达人甲");
    expect(serialized).not.toContain("员工甲");
    expect(serialized).not.toContain("a@example.com");
    expect(serialized).not.toContain("secret-1");
  });

  it("正确识别飞书毫秒时间戳日期", () => {
    const table: TableData = {
      sourceName: "飞书",
      sheetName: "测试表",
      headers: ["合作时间", "寄样产品"],
      updatedAt: new Date(),
      rows: [
        { 合作时间: 1785427200000, 寄样产品: "杯子" },
        { 合作时间: 1784736000000, 寄样产品: "牙刷" },
      ],
    };

    expect(buildAnalysisEvidence(table).dateRanges[0]).toMatchObject({
      earliest: "2026-07-23",
      latest: "2026-07-31",
      validCount: 2,
      missingCount: 0,
    });
  });

  it("投产比混合商品行与店铺行时不把结构空白误报成缺失", () => {
    const table: TableData = {
      sourceName: "飞书",
      sheetName: "投产比",
      headers: ["日期", "记录类型", "商品", "销售额", "店铺浏览量", "广告花费"],
      updatedAt: new Date(),
      rows: [
        { 日期: "2026-08-01", 记录类型: "商品", 商品: "电动磨脚器", 销售额: 100, 店铺浏览量: null, 广告花费: 0 },
        { 日期: "2026-08-01", 记录类型: "店铺", 商品: "店铺汇总", 销售额: null, 店铺浏览量: 300, 广告花费: 0 },
      ],
    };

    const evidence = buildAnalysisEvidence(table);
    expect(evidence.missingFields).toEqual([]);
    expect(evidence.aggregationNotes.join("\n")).toContain("不能说成天数");
    expect(evidence.aggregationNotes.join("\n")).toContain("不能直接断言没有投放");
  });
});
