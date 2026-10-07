import { describe, expect, it } from "vitest";
import { formatReadableBotReply } from "../src/bot/reply-layout.js";

describe("Feishu reply layout", () => {
  it("breaks a dense long paragraph into readable short paragraphs", () => {
    const reply = formatReadableBotReply("近七天店铺整体经营平稳，总销售额380.25，总单量53单，日均销售额约76.05，日均单量约10.6单。商品卡出单量占总单量的96%以上，是主要出单渠道。广告相关字段为0，暂时无法判断广告效果。重点：1）样本只有5天；2）店铺汇总和商品明细口径不同。数据依据：投产比，25条匹配记录；更新于 2026/8/5 16:09:22");
    expect(reply).toContain("\n\n");
    expect(reply).toContain("1） 样本只有5天");
    expect(reply).not.toContain("数据依据");
    expect(reply).not.toContain("匹配记录");
  });

  it("does not alter a short answer", () => {
    expect(formatReadableBotReply("电动磨脚器最近上线1次。"))
      .toBe("电动磨脚器最近上线1次。");
  });

  it("puts ranking items and the caveat on separate lines", () => {
    const reply = formatReadableBotReply("目前能确认的是：电动磨脚器357.26排第一，水杨酸沐浴露22.99排第二。不过只返回4个商品。");
    expect(reply).toContain("：\n\n电动磨脚器357.26排第一\n水杨酸沐浴露22.99排第二");
    expect(reply).toContain("\n\n不过：只返回4个商品");
  });
});
