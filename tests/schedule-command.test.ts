import { describe, expect, it } from "vitest";
import { parseScheduleCommand } from "../src/bot/schedule-command.js";

describe("parseScheduleCommand", () => {
  const cases: Array<[string, { enabled?: boolean; localTime?: string }]> = [
    ["设置自动同步时间 14:30", { localTime: "14:30" }],
    ["自动填表改成每天下午2点30分", { localTime: "14:30" }],
    ["暂停自动同步", { enabled: false }],
    ["恢复定时任务", { enabled: true }],
  ];
  it.each(cases)("parses %s", (
    text: string,
    expected: { enabled?: boolean; localTime?: string },
  ) => {
    expect(parseScheduleCommand(text)).toEqual(expected);
  });

  it("does not treat ordinary business questions as schedule changes", () => {
    expect(parseScheduleCommand("最近7天什么商品卖得最好")).toBeNull();
  });
});
