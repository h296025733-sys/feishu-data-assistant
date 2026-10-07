import { describe, expect, it } from "vitest";
import { isBasicConversationCandidate, resolveBasicConversationReply } from "../src/bot/basic-conversation.js";

describe("basic conversation fallback", () => {
  it("uses the DeepSeek chitchat reply when available", () => {
    const reply = resolveBasicConversationReply("你好", {
      rewrittenQuestion: "你好",
      intentHint: "chitchat",
      contextualFollowUp: false,
      directReply: "嗨，我在呢。",
      confidence: 0.99,
    }, "group", ["Storetwo", "STOREONE"]);
    expect(reply).toBe("嗨，我在呢。");
  });

  it("does not turn a greeting into a Base query when DeepSeek is temporarily unavailable", () => {
    expect(isBasicConversationCandidate("在吗？")).toBe(true);
    expect(resolveBasicConversationReply("在吗？", null, "private", ["Storetwo", "STOREONE"]))
      .toContain("Storetwo / STOREONE");
    expect(resolveBasicConversationReply("谢谢", null, "group", ["Storetwo", "STOREONE"]))
      .toContain("不客气");
    expect(resolveBasicConversationReply("最近销量怎么样", null, "group", ["Storetwo", "STOREONE"]))
      .toBeNull();
  });
});
