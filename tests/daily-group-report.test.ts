import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProvider } from "../src/ai/types.js";
import type { DailyAutomationRun, DailyPhaseResult } from "../src/automation/daily-sync.js";
import {
  buildDailyGroupReport,
  DailyGroupReportService,
} from "../src/bot/daily-group-report.js";
import type { BusinessProfile } from "../src/config/business-profile.js";
import type { DataSource, TableData } from "../src/types/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("daily group report", () => {
  it("reports the Beijing calendar day shown in ROI at the Beijing 17:55 run", async () => {
    const report = await buildDailyGroupReport({
      tenantId: "storetwo-formal",
      profile,
      dataSource: source(),
      provider: provider(["top_product", "orders_delta"]),
      run: scheduledRun(),
    });

    expect(report.runLabel).toBe("17:55 首轮");
    expect(report.reportDate).toBe("2026-08-11");
    expect(report.analyticsDate).toBeNull();
    expect(report.orderDate).toBe("2026-08-10");
    expect(report.analyticsLagDays).toBeNull();
    expect(report.usedDeepSeekSelection).toBe(true);
    expect(report.selectedHighlightIds).toEqual(["top_product", "orders_delta"]);
    expect(report.text).toContain("日报日期：8月11日");
    expect(report.text).not.toContain("发送：");
    expect(report.text).not.toContain("美国");
    expect(report.text).toContain("单日单量 / 销量：**3单 / 4件**");
    expect(report.text).toContain("销售额：**$38.88**");
    expect(report.text).toContain("总广告花费：**$12.50**");
    expect(report.text).toContain("总广告出单量：**2**");
    expect(report.text).toContain("合作量：**2**");
    expect(report.text).toContain("上线量：**1**");
    expect(report.text).not.toContain("已排除商品");
    expect(JSON.stringify(report.card)).toContain("<at id=all></at>");
  });

  it("fills a missing same-day sales value from the live paid snapshot without technical caveats", async () => {
    const requestedDates: string[] = [];
    const report = await buildDailyGroupReport({
      tenantId: "storetwo-formal",
      profile,
      dataSource: sourceWithMissingCurrentSales(),
      provider: provider(["no_orders", "cooperation_activity"]),
      run: scheduledRun(),
      presentation: "template_test",
      loadPaidSnapshot: async (reportDate) => {
        requestedDates.push(reportDate);
        return [{
          date: reportDate,
          name: "水杨酸沐浴露",
          orders: 0,
          items: 0,
          sales: 0,
        }];
      },
    });

    expect(requestedDates).toEqual(["2026-08-10"]);
    expect(report.reportDate).toBe("2026-08-11");
    expect(report.orderDate).toBe("2026-08-10");
    expect(report.text).toContain("单日单量 / 销量：**0单 / 0件**");
    expect(report.text).toContain("销售额：**$0.00**");
    expect(report.text).not.toContain("待可靠数据");
    expect(report.text).not.toContain("以下日报数据暂不作推测");
    expect(JSON.stringify(report.card)).not.toContain("仅统计当前配置商品");
  });

  it("uses only locally validated candidate ids returned by the model", async () => {
    const report = await buildDailyGroupReport({
      tenantId: "storetwo-formal",
      profile,
      dataSource: source(),
      provider: provider(["invented", "top_product"]),
      run: scheduledRun(),
    });
    expect(report.selectedHighlightIds).toEqual(["top_product"]);
    expect(report.text).toContain("水杨酸沐浴露 当日表现居首");
    expect(report.text).not.toContain("invented");
  });

  it("keeps blank store advertising totals pending instead of pretending they are zero", async () => {
    const table = await source().getTable("投产比");
    const report = await buildDailyGroupReport({
      tenantId: "storetwo-formal",
      profile,
      dataSource: {
        getTable: async () => ({
          ...table,
          rows: table.rows.map((row) => row.日期 === "2026-08-10" && row.商品 === "店铺汇总"
            ? { ...row, 总广告花费: null, 总广告出单量: null }
            : row),
        }),
      },
      provider: provider(null),
      run: scheduledRun(),
    });
    expect(report.text).toContain("总广告花费：**待录入**");
    expect(report.text).toContain("总广告出单量：**待录入**");
    expect(report.dataComplete).toBe(true);
  });

  it("keeps the 20:00 catch-up data sync silent and sends no second daily report", async () => {
    const run = {
      ...scheduledRun(),
      runId: "daily-20260811120000-test",
      startedAt: "2026-08-11T12:00:00.000Z",
      completedAt: "2026-08-11T12:02:00.000Z",
    };
    let sent = 0;
    const service = new DailyGroupReportService({
      tenantId: "storetwo-formal",
      profile,
      dataSource: source(),
      provider: provider(["boundary_progress"]),
      groupChatIds: ["oc_storetwo"],
      sendCard: async () => { sent += 1; return "om_unexpected"; },
    });
    const result = await service.handleRun(run);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("20:00补跑只同步数据，不发送第二份日报");
    expect(result.report).toBeNull();
    expect(result.deliveries).toEqual([]);
    expect(sent).toBe(0);
  });

  it("persists delivery and never sends the same tenant/run/chat twice", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "daily-group-report-"));
    temporaryDirectories.push(directory);
    const sent: Array<[string, Record<string, unknown>, string]> = [];
    const sendCard = async (chatId: string, card: Record<string, unknown>, key: string) => {
      sent.push([chatId, card, key]);
      return "om_test_message";
    };
    const service = new DailyGroupReportService({
      tenantId: "storetwo-formal",
      profile,
      dataSource: source(),
      provider: provider(null),
      groupChatIds: ["oc_storetwo"],
      sendCard,
      statePath: path.join(directory, "state.json"),
      now: () => new Date("2026-08-11T10:05:00Z"),
    });
    const first = await service.handleRun(scheduledRun());
    const second = await service.handleRun(scheduledRun());
    expect(first.skipped).toBe(false);
    expect(first.deliveries[0].messageId).toBe("om_test_message");
    expect(second.skipped).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0][2]).toContain("storetwo-formal");
  });

  it("replays a just-finished 17:55 run on first deployment but baselines an old run", async () => {
    const recentDirectory = await mkdtemp(path.join(os.tmpdir(), "daily-group-report-recent-"));
    const oldDirectory = await mkdtemp(path.join(os.tmpdir(), "daily-group-report-old-"));
    const formerScheduleDirectory = await mkdtemp(path.join(os.tmpdir(), "daily-group-report-former-schedule-"));
    temporaryDirectories.push(recentDirectory, oldDirectory, formerScheduleDirectory);
    let recentSent = 0;
    let oldSent = 0;
    let formerScheduleSent = 0;
    const recentSend = async () => { recentSent += 1; return "om_recent"; };
    const oldSend = async () => { oldSent += 1; return "om_old"; };
    const recent = new DailyGroupReportService({
      tenantId: "storetwo-formal", profile, dataSource: source(), provider: provider(null),
      groupChatIds: ["oc_storetwo"], sendCard: recentSend,
      statePath: path.join(recentDirectory, "state.json"),
      now: () => new Date("2026-08-11T10:05:00Z"),
    });
    const old = new DailyGroupReportService({
      tenantId: "storetwo-formal", profile, dataSource: source(), provider: provider(null),
      groupChatIds: ["oc_storetwo"], sendCard: oldSend,
      statePath: path.join(oldDirectory, "state.json"),
      now: () => new Date("2026-08-12T10:05:00Z"),
    });
    const formerSchedule = new DailyGroupReportService({
      tenantId: "storetwo-formal", profile, dataSource: source(), provider: provider(null),
      groupChatIds: ["oc_storetwo"],
      sendCard: async () => { formerScheduleSent += 1; return "om_former_schedule"; },
      statePath: path.join(formerScheduleDirectory, "state.json"),
      now: () => new Date("2026-08-11T08:05:00Z"),
    });
    const formerScheduleRun = {
      ...scheduledRun(),
      runId: "daily-20260811075500-former",
      startedAt: "2026-08-11T07:55:00.000Z",
      completedAt: "2026-08-11T07:56:00.000Z",
    };
    expect((await recent.start(scheduledRun())).skipped).toBe(false);
    expect((await old.start(scheduledRun())).skipped).toBe(true);
    expect((await formerSchedule.start(formerScheduleRun)).skipped).toBe(true);
    expect(recentSent).toBe(1);
    expect(oldSent).toBe(0);
    expect(formerScheduleSent).toBe(0);
  });
});

const profile: BusinessProfile = {
  schemaVersion: 1,
  templateMode: false,
  businessDisplayName: "Storetwo",
  businessTimeZone: "Asia/Shanghai",
  storeAggregateLabel: "店铺汇总",
  tables: { development: "红人开发表", cooperation: "红人合作表", online: "红人上线表", roi: "投产比" },
  tiktok: {
    shopAlias: "Storetwo",
    shopId: "7494597420548654082",
    credentialProfile: "formal-pilot-store",
    shopTimeZone: "America/Los_Angeles",
    currencyCode: "USD",
    productMapFile: "config/tenants/storetwo-formal.products.json",
    includedCanonicalProducts: ["水杨酸沐浴露"],
    roiDateBasis: "shop_registered",
    orderAttribution: { enabled: true, affiliateNonLiveAsVideo: true, reconciliationDays: 3 },
  },
  dailyAutomation: {
    enabled: true,
    localTime: "17:55",
    catchUpLocalTime: "20:00",
    integrationStartDate: "2026-08-06",
    reconciliationDays: 1,
    probeDays: 14,
    runOnStartup: false,
  },
};

function source(): DataSource {
  const table: TableData = {
    sourceName: "飞书多维表格",
    sheetName: "投产比",
    headers: ["日期", "记录类型", "商品", "店铺浏览量", "总单量", "总数量", "店铺销售额", "单量", "数量", "销售额"],
    updatedAt: new Date("2026-08-11T08:01:00Z"),
    rows: [
      { 日期: "2026-08-08", 记录类型: "店铺", 商品: "店铺汇总", 店铺浏览量: 3, 总单量: 1, 总数量: 1, 店铺销售额: 10 },
      { 日期: "2026-08-09", 记录类型: "商品", 商品: "水杨酸沐浴露", 单量: 1, 数量: 1, 销售额: 10 },
      { 日期: "2026-08-10", 记录类型: "店铺", 商品: "店铺汇总", 店铺浏览量: 5, 总单量: 3, 总数量: 4, 店铺销售额: 38.88, 合作量: 9, 上线量: 1, 总广告花费: 12.5, 总广告出单量: 2 },
      { 日期: "2026-08-10", 记录类型: "商品", 商品: "水杨酸沐浴露", 单量: 3, 数量: 4, 销售额: 38.88, 合作量: 9, 上线量: 1 },
      { 日期: "2026-08-11", 记录类型: "店铺", 商品: "店铺汇总", 合作量: 2, 上线量: 0 },
      { 日期: "2026-08-11", 记录类型: "商品", 商品: "水杨酸沐浴露", 合作量: 2, 上线量: 0 },
      { 日期: "2026-08-11", 记录类型: "商品", 商品: "已排除商品", 单量: 99, 数量: 99, 销售额: 999 },
    ],
  };
  return { getTable: async () => table };
}

function sourceWithMissingCurrentSales(): DataSource {
  return {
    getTable: async (question = "") => {
      const table = await source().getTable(question);
      return {
        ...table,
        rows: table.rows.map((row) => (
          row.日期 === "2026-08-10" && row.商品 === "水杨酸沐浴露"
            ? { ...row, 销售额: null }
            : row
        )),
      };
    },
  };
}

function provider(selectedIds: string[] | null): ModelProvider {
  return {
    name: "deepseek",
    parseIntent: async (_question, _context, fallback) => ({
      intent: fallback,
      trace: { source: "local", model: null, durationMs: 0, fallbackReason: null },
    }),
    selectDailyReportHighlights: async () => selectedIds,
  };
}

function scheduledRun(): DailyAutomationRun {
  return {
    runId: "daily-20260811095500-test",
    trigger: "scheduled",
    startedAt: "2026-08-11T09:55:00.000Z",
    completedAt: "2026-08-11T10:01:00.000Z",
    latestCompleteDate: "2026-08-09",
    orderAttributionTargetDate: "2026-08-10",
    windowStart: "2026-08-09",
    windowEnd: "2026-08-09",
    catalog: phase({ matched: 1, unchanged: 2 }),
    online: phase({ matched: 0, unchanged: 0 }),
    roi: phase({ matched: 3, updated: 2, unchanged: 2 }),
    ok: true,
  };
}

function phase(patch: Partial<DailyPhaseResult>): DailyPhaseResult {
  return {
    ok: true,
    matched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    conflicts: 0,
    missingItems: [],
    error: null,
    ...patch,
  };
}
