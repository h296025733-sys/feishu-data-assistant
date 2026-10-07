import { describe, expect, it } from "vitest";
import { emptyConversationContext } from "../src/bot/service.js";
import {
  clarificationDomain,
  mergeClarificationReply,
  sessionIsFresh,
  type PendingClarificationState,
} from "../src/bot/conversation.js";

describe("追问状态机", () => {
  it("首次查询尚未写入上下文时，pending仍能维持会话", () => {
    const now = Date.now();
    const pending: PendingClarificationState = {
      question: "dailydigitalstore上线了几次？",
      options: ["开发", "合作", "上线"],
      createdAt: now - 1_000,
      attempts: 1,
    };
    expect(sessionIsFresh(emptyConversationContext(), pending, now)).toBe(true);
  });

  it("过期pending不会永久占用会话", () => {
    const now = Date.now();
    const pending: PendingClarificationState = {
      question: "旧问题",
      options: ["开发", "合作", "上线"],
      createdAt: now - 3 * 60 * 60_000,
      attempts: 1,
    };
    expect(sessionIsFresh(emptyConversationContext(), pending, now)).toBe(false);
  });

  it("上线类短回复会补充明确数据域", () => {
    for (const reply of ["上线", "上线数据", "上线表现"]) {
      const merged = mergeClarificationReply("dailydigitalstore上线了几次？", reply, ["开发", "合作", "上线"]);
      expect(merged).toContain("dailydigitalstore上线了几次？");
      expect(merged).toContain("上下文数据域：上线");
      expect(clarificationDomain(reply, ["开发", "合作", "上线"])).toBe("online");
    }
  });

  it("‘都可以/都看’会被理解为同时查看，而不是继续追问", () => {
    for (const reply of ["都可以", "都看", "全部", "一起看"]) {
      expect(clarificationDomain(reply, ["合作情况", "上线表现"])).toBe("all");
      expect(mergeClarificationReply("帮我看看香水", reply, ["合作情况", "上线表现"]))
        .toContain("上下文数据域：合作和上线");
    }
  });

  it("合作和开发短回复也能正确归类", () => {
    expect(clarificationDomain("合作情况", ["合作情况", "上线表现"])).toBe("cooperation");
    expect(clarificationDomain("开发", ["开发", "合作", "上线"])).toBe("development");
  });
});
