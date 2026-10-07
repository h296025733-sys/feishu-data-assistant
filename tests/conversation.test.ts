import { describe, expect, it } from "vitest";
import type { TableData } from "../src/types/index.js";
import type { ModelProvider } from "../src/ai/types.js";
import { answerQuestionWithContext, emptyConversationContext } from "../src/bot/service.js";

const online: TableData = {
  sourceName: "飞书多维表格",
  sheetName: "Tech-wave红人上线表_1 + Tech-wave红人上线表_2",
  headers: ["实上线日期(Ct)", "达人姓名", "挂车产品", "视频上线地址", "售出数量", "销售额"],
  updatedAt: new Date("2026-07-24T00:00:00Z"),
  rows: [
    { __sourceTable: "Tech-wave红人上线表_1", "实上线日期(Ct)": "2026-07-01", 达人姓名: "dailydigitalstore", 挂车产品: "浴室音响", 视频上线地址: "v1", 售出数量: 2, 销售额: 20 },
    { __sourceTable: "Tech-wave红人上线表_2", "实上线日期(Ct)": "2026-07-23", 达人姓名: "dailydigitalstore", 挂车产品: "浴室音响", 视频上线地址: "v2", 售出数量: 4, 销售额: 40 },
  ],
};

const provider: ModelProvider = {
  name: "mock",
  async parseIntent(_question, _context, fallback) {
    return { intent: fallback, trace: { source: "local", model: null, durationMs: 0, fallbackReason: null } };
  },
};

const dataSource = { async getTable() { return online; } };

describe("对话上下文", () => {
  it("下一句可以用‘他’继承上一位达人", async () => {
    const first = await answerQuestionWithContext(dataSource, provider, "dailydigitalstore上线了几次？", emptyConversationContext());
    expect(first.text).toContain("dailydigitalstore 共上线 2 次");
    const follow = await answerQuestionWithContext(dataSource, provider, "他最近1条视频", first.context);
    expect(follow.text).toContain("v2");
  });

  it("没有上下文时不会无脑猜‘他’是谁", async () => {
    await expect(answerQuestionWithContext(dataSource, provider, "他最近上线了吗？", emptyConversationContext())).rejects.toThrow("哪个达人或产品");
  });
});
