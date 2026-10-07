import { describe, expect, it } from "vitest";
import type { ModelProvider } from "../src/ai/types.js";
import type { TableData } from "../src/types/index.js";
import { answerQuestionWithContext, emptyConversationContext } from "../src/bot/service.js";

const cooperation: TableData = {
  sourceName: "飞书",
  sheetName: "Tech-wave红人合作表",
  headers: ["合作时间", "红人姓名", "寄样产品"],
  updatedAt: new Date(),
  rows: [
    { 合作时间: "2026-05-01", 红人姓名: "creator1", 寄样产品: "香水" },
    { 合作时间: "2026-05-02", 红人姓名: "creator2", 寄样产品: "香水" },
  ],
};

const online: TableData = {
  sourceName: "飞书",
  sheetName: "Tech-wave红人上线表_1 + Tech-wave红人上线表_2",
  headers: ["实上线日期(Ct)", "达人姓名", "挂车产品", "售出数量", "销售额"],
  updatedAt: new Date(),
  rows: [
    { 实上线日期: "2026-06-01", "实上线日期(Ct)": "2026-06-01", 达人姓名: "creator1", 挂车产品: "香水", 售出数量: 3, 销售额: 30 },
  ],
};

const dataSource = {
  async getTable(question = "") {
    return question.includes("合作") && !question.includes("上线") ? cooperation : online;
  },
};

const provider: ModelProvider = {
  name: "mock",
  async parseIntent(_q, _c, fallback) {
    return { intent: fallback, trace: { source: "local", model: null, durationMs: 0, fallbackReason: null } };
  },
};

describe("综合查看", () => {
  it("用户回复都可以时同时给出合作与上线结果，不再次追问", async () => {
    const answer = await answerQuestionWithContext(
      dataSource,
      provider,
      "帮我看看香水\n用户补充：都可以\n上下文数据域：合作和上线",
      emptyConversationContext(),
    );
    expect(answer.text).toContain("香水综合情况");
    expect(answer.text).toContain("合作：2条记录");
    expect(answer.text).toContain("上线：1条记录");
  });
});
