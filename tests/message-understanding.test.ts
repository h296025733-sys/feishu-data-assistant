import { describe, expect, it } from "vitest";
import type { MessageUnderstanding } from "../src/ai/types.js";
import {
  protectedMessageLiterals,
  redactMessageForModel,
  validateMessageUnderstanding,
} from "../src/bot/message-understanding.js";

function understood(rewrittenQuestion: string): MessageUnderstanding {
  return {
    rewrittenQuestion,
    intentHint: "business_query",
    contextualFollowUp: false,
    directReply: null,
    confidence: 0.9,
  };
}

describe("自由文字统一语义入口", () => {
  it("在发送给模型前遮住授权码、密钥、邮箱和手机号", () => {
    const safe = redactMessageForModel(
      "授权码：ROW_0bS9hQAAAACOznYlg3tGLfLCJEU0gdg98dlBVYA3，token=sk-abcdefghijklmnop，联系 a@b.com 或 13812345678",
    );
    expect(safe).not.toContain("ROW_0bS9");
    expect(safe).not.toContain("sk-abcdef");
    expect(safe).not.toContain("a@b.com");
    expect(safe).not.toContain("13812345678");
    expect(safe).toContain("[敏感信息]");
    expect(safe).toContain("[邮箱]");
    expect(safe).toContain("[手机号]");
  });

  it("保护日期、阈值、时间和相对范围不被模型改写错", () => {
    const source = "近30天店铺浏览量大于200的数据，在14:30之后告诉我";
    expect(protectedMessageLiterals(source)).toEqual(expect.arrayContaining(["近30天", "大于", "200", "14:30"]));
    expect(validateMessageUnderstanding(
      source,
      understood("查询近30天店铺浏览量大于200的数据，并在14:30之后告知"),
    )).not.toBeNull();
    expect(validateMessageUnderstanding(
      source,
      understood("查询近7天店铺浏览量大于100的数据，并在10:00之后告知"),
    )).toBeNull();
    expect(protectedMessageLiterals("拉长到二十天再看")).toContain("二十天");
    expect(validateMessageUnderstanding(
      "拉长到二十天再看",
      understood("把上一问拉长到最近30天再看"),
    )).toBeNull();
  });

  it("允许模型把连续追问补成完整问题", () => {
    const result = validateMessageUnderstanding(
      "那最近一个月呢",
      {
        ...understood("最近一个月商品卡和达人出单量谁更多？"),
        contextualFollowUp: true,
      },
    );
    expect(result?.rewrittenQuestion).toContain("最近一个月");
    expect(result?.contextualFollowUp).toBe(true);
  });

  it("允许把8.3号规范成8月3号，但不能丢掉这一天的日期", () => {
    const result = validateMessageUnderstanding(
      "我说的是8.3号这一天啊",
      {
        ...understood("8月3号哪个商品卖得最好"),
        contextualFollowUp: true,
      },
    );
    expect(result?.rewrittenQuestion).toContain("8月3号");
    expect(protectedMessageLiterals("我说的是8.3号这一天啊")).not.toContain("一天");
  });

  it("低置信度或空改写会安全回退", () => {
    expect(validateMessageUnderstanding("销量怎么样", {
      ...understood("销量怎么样"),
      confidence: 0.2,
    })).toBeNull();
    expect(validateMessageUnderstanding("销量怎么样", understood("  "))).toBeNull();
  });

  it("不允许模型替含糊的卖得最好擅自选择销量口径", () => {
    expect(validateMessageUnderstanding(
      "8月3号哪个卖得最好",
      understood("8月3号哪个商品按销量排名第一"),
    )).toBeNull();
    expect(validateMessageUnderstanding(
      "8月3号哪个销量最高",
      understood("8月3号哪个商品销量最高"),
    )).not.toBeNull();
  });
});
