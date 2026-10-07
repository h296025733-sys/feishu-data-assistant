import { describe, expect, it } from "vitest";
import { normalizeFeishuMessageText } from "../src/bot/message-text.js";

describe("normalizeFeishuMessageText", () => {
  it("removes Feishu mention placeholders before a group command", () => {
    expect(normalizeFeishuMessageText("@_user_1 绑定当前群")).toBe("绑定当前群");
  });

  it("removes the displayed bot name supplied by the mention payload", () => {
    expect(normalizeFeishuMessageText("@小机器人 绑定当前群", [
      { key: "@_user_1", name: "小机器人" },
    ])).toBe("绑定当前群");
  });

  it("leaves private-message text unchanged", () => {
    expect(normalizeFeishuMessageText("最近7天哪个产品卖得最好？")).toBe("最近7天哪个产品卖得最好？");
  });
});
