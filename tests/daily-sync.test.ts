import { describe, expect, it } from "vitest";
import {
  describeInitializationStatus,
  summarizeAutomationError,
  summarizePendingItems,
  nextAutomationRunAt,
  nextDailyRunAt,
  onlineDiscoveryWindow,
  orderAttributionWindow,
  reconciliationWindow,
  resolveLatestCompleteDate,
  resolveAutomationPlanningDate,
  storeNeedsInitialization,
} from "../src/automation/daily-sync.js";
import type { TikTokMachineContract } from "../src/realtime/types.js";

function contract(latest: string | null, dataset = "test"): TikTokMachineContract {
  return {
    ok: true,
    dataset,
    shop: null,
    window_start: "2026-07-20",
    window_end_exclusive: "2026-08-04",
    fetched_at: "2026-08-04T00:00:00Z",
    rows: [],
    row_count: 0,
    exact_duplicate_count: 0,
    conflicting_duplicate_ids: [],
    request_ids: [],
    raw_source_paths: [],
    normalized_source_path: null,
    required_scope: [],
    granted_scope: [],
    missing_capabilities: [],
    errors: [],
    latest_available_date: latest,
  };
}

describe("daily automation", () => {
  it("runs at the next configured Shanghai wall time", () => {
    expect(nextDailyRunAt(new Date("2026-08-04T01:00:00Z"), "10:00", "Asia/Shanghai").toISOString())
      .toBe("2026-08-04T02:00:00.000Z");
    expect(nextDailyRunAt(new Date("2026-08-04T03:00:00Z"), "10:00", "Asia/Shanghai").toISOString())
      .toBe("2026-08-05T02:00:00.000Z");
  });

  it("runs the primary pass and the evening catch-up as independent daily slots", () => {
    expect(nextAutomationRunAt(
      new Date("2026-08-04T07:00:00Z"),
      "15:55",
      "Asia/Shanghai",
      "20:00",
    ).toISOString()).toBe("2026-08-04T07:55:00.000Z");
    expect(nextAutomationRunAt(
      new Date("2026-08-04T08:00:00Z"),
      "15:55",
      "Asia/Shanghai",
      "20:00",
    ).toISOString()).toBe("2026-08-04T12:00:00.000Z");
    expect(nextAutomationRunAt(
      new Date("2026-08-04T13:00:00Z"),
      "15:55",
      "Asia/Shanghai",
      "20:00",
    ).toISOString()).toBe("2026-08-05T07:55:00.000Z");
  });

  it("reconciles the latest three complete dates", () => {
    expect(reconciliationWindow("2026-08-02", 3)).toEqual({
      startDate: "2026-07-31",
      endDate: "2026-08-02",
    });
  });

  it("updates order attribution through the previous Beijing day without inheriting shop calendar or analytics lag", () => {
    expect(orderAttributionWindow(
      new Date("2026-08-10T07:55:00.000Z"),
      "Asia/Shanghai",
      3,
      "2026-07-01",
    )).toEqual({ startDate: "2026-08-07", endDate: "2026-08-09" });
    expect(orderAttributionWindow(
      new Date("2026-08-10T07:55:00.000Z"),
      "Asia/Shanghai",
      9,
      "2026-08-06",
    )).toEqual({ startDate: "2026-08-06", endDate: "2026-08-09" });
    expect(orderAttributionWindow(
      new Date("2026-08-10T01:00:00.000Z"),
      "Asia/Shanghai",
      1,
      "2026-08-06",
    )).toEqual({ startDate: "2026-08-09", endDate: "2026-08-09" });
  });

  it("rescans late-arriving videos and includes the Beijing day reached by a US shop day", () => {
    expect(onlineDiscoveryWindow(
      "2026-08-08",
      "2026-08-08",
      14,
      "America/Los_Angeles",
      "Asia/Shanghai",
    )).toEqual({
      startDate: "2026-07-26",
      endDateInclusive: "2026-08-09",
    });
    expect(onlineDiscoveryWindow(
      "2026-07-04",
      "2026-08-02",
      14,
      "America/Los_Angeles",
      "Asia/Shanghai",
    ).startDate).toBe("2026-07-04");
  });

  it("uses the slowest required endpoint and never treats today as complete", () => {
    expect(resolveLatestCompleteDate([
      contract("2026-08-03"),
      contract("2026-08-02"),
      contract("2026-08-03"),
    ], "2026-08-04")).toBe("2026-08-02");
    expect(resolveLatestCompleteDate([
      contract("2026-08-04"),
      contract("2026-08-04"),
      contract("2026-08-04"),
    ], "2026-08-04")).toBe("2026-08-03");
  });

  it("does not let a failed video-list probe prevent separately validated phases from planning", () => {
    const video = { ...contract(null, "shop_video_performance"), ok: false, errors: ["500/36009003"] };
    const product = contract("2026-09-26", "shop_product_performance");
    const shop = contract(null, "shop_performance_hourly");
    expect(resolveAutomationPlanningDate({ product, shop, video }, "2026-09-28")).toBe("2026-09-26");
    expect(() => resolveAutomationPlanningDate({ product: { ...product, pagination_truncated: true }, shop, video }, "2026-09-28"))
      .toThrow("不能");
    expect(() => resolveAutomationPlanningDate({ product: contract(null), shop, video }, "2026-09-28"))
      .toThrow("不能");
  });

  it("fails closed when any endpoint omits completeness evidence", () => {
    expect(() => resolveLatestCompleteDate([
      contract("2026-08-03"),
      contract(null),
      contract("2026-08-03"),
    ], "2026-08-04")).toThrow("不写入");
  });

  it("accepts the aggregate shop endpoint only behind two explicit dated endpoints", () => {
    const aggregate = contract(null, "shop_performance_hourly");
    aggregate.row_count = 1;
    aggregate.window_end_exclusive = "2026-08-04";
    expect(resolveLatestCompleteDate([
      contract("2026-08-02", "shop_product_performance"),
      aggregate,
      contract("2026-08-03", "shop_video_performance"),
    ], "2026-08-04")).toBe("2026-08-02");
  });

  it("recognizes when a configured store still needs a user-chosen initialization range", () => {
    expect(storeNeedsInitialization(false, null)).toBe(true);
    expect(storeNeedsInitialization(false, { completed: false })).toBe(true);
    expect(storeNeedsInitialization(false, { completed: true })).toBe(false);
    expect(storeNeedsInitialization(true, null)).toBe(false);
  });

  it("reports whether initialization is running, waiting for names, or stopped", () => {
    const base = {
      version: 1 as const,
      completed: false,
      windowStart: "2026-07-04",
      windowEnd: "2026-08-02",
      completedAt: null,
      lastAttemptAt: "2026-08-05T07:39:18.756Z",
      lastRun: null,
      requestedDays: 30,
      force: true,
    };
    expect(describeInitializationStatus(
      { ...base, state: "running" },
      new Date("2026-08-05T07:40:00.000Z"),
    )).toContain("正在核对并补齐最近30个完整日");
    expect(describeInitializationStatus({
      ...base,
      state: "running",
      progress: {
        phase: "roi_collecting",
        currentDate: "2026-07-20",
        completedDays: 16,
        totalDays: 30,
        updatedAt: "2026-08-05T08:00:00.000Z",
      },
    }, new Date("2026-08-05T08:01:00.000Z"))).toContain("投产比接口数据（17/30，2026-07-20）");
    expect(describeInitializationStatus({
      ...base,
      state: "running",
      progress: {
        phase: "roi_verifying",
        currentDate: null,
        completedDays: 30,
        totalDays: 30,
        updatedAt: "2026-08-05T08:00:00.000Z",
      },
    }, new Date("2026-08-05T08:01:00.000Z"))).toContain("正在做最后的逐项回读校验");
    expect(describeInitializationStatus({
      ...base,
      state: "running",
      lastAttemptAt: "2026-08-05T08:00:00.000Z",
    }, new Date("2026-08-05T08:06:00.000Z"))).toContain("超过5分钟没有新进度");
    expect(describeInitializationStatus({
      ...base,
      state: "waiting_product_confirmation",
      pendingProductIds: ["1", "2"],
    })).toContain("还有 2 个新商品待确认");
    expect(describeInitializationStatus({
      ...base,
      state: "failed",
      lastError: "card_orders 不是有效数字",
    })).toContain("已经停止，不是在后台继续运行");
  });

  it("collapses long write-verification failures into two examples", () => {
    const summary = summarizeAutomationError("投产比批量写后验证失败：第一项=0，应为1；第二项=0，应为2；第三项=0，应为3");
    expect(summary).toContain("发现多项差异");
    expect(summary).toContain("第一项");
    expect(summary).toContain("第二项");
    expect(summary).not.toContain("第三项");
  });

  it("separates manual fields from dated API attribution warnings", () => {
    const summary = summarizePendingItems([
      "广告渠道花费与广告出单量",
      "退货量",
      "自孵化出单量与自孵化上线量",
      "2026-07-07 有1个出单视频的总成交件数为2，但逐商品明细合计为0",
      "2026-07-08 有1个出单视频的总成交件数为2，但逐商品明细合计为0",
    ]);
    expect(summary.manualFields).toEqual(["广告花费与广告出单", "退货量", "自孵化出单与上线"]);
    expect(summary.warningDates).toEqual([]);
    expect(summary.otherItems).toEqual([]);
  });
});
