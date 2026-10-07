import { describe, expect, it } from "vitest";
import { isManualWriteRequest } from "../src/bot/query-only-policy.js";

describe("query-only bot policy", () => {
  it.each([
    "把近七天有单量的数据填入投产比",
    "根据合作表补全上线表",
    "删除投产比商品 电动磨脚器",
    "继续刚才的更新",
  ])("blocks manual write command: %s", (text: string) => {
    expect(isManualWriteRequest(text)).toBe(true);
  });

  it.each([
    "近七天投产比怎么样",
    "graceguitron 的开发、合作和上线情况",
    "自动同步状态",
    "你最新更新的数据发给我",
    "把刚同步的经营结果给我看看",
  ])("keeps read-only query/status available: %s", (text: string) => {
    expect(isManualWriteRequest(text)).toBe(false);
  });
});
