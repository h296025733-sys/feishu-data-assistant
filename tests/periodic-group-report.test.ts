import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProvider } from "../src/ai/types.js";
import type { DailyAutomationRun, DailyPhaseResult } from "../src/automation/daily-sync.js";
import {
  buildPeriodicGroupReport,
  duePeriodicReportPeriods,
  PeriodicGroupReportService,
  periodForKind,
} from "../src/bot/periodic-group-report.js";
import type { BusinessProfile } from "../src/config/business-profile.js";
import { shiftIsoDate } from "../src/realtime/business-time.js";
import type { DataSource, TableData } from "../src/types/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("periodic group report", () => {
  it("uses complete prior periods and emits weekly before monthly when both are due", () => {
    expect(duePeriodicReportPeriods("2026-02-01")).toEqual([
      {
        kind: "weekly",
        startDate: "2026-01-26",
        endDate: "2026-02-01",
        previousStartDate: "2026-01-19",
        previousEndDate: "2026-01-25",
      },
      {
        kind: "monthly",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        previousStartDate: "2025-12-01",
        previousEndDate: "2025-12-31",
      },
    ]);
    expect(duePeriodicReportPeriods("2026-08-12")).toEqual([]);
  });

  it("builds a concise Beijing-date weekly report from only the formal product scope", async () => {
    const report = await buildPeriodicGroupReport({
      tenantId: "storetwo-formal",
      profile,
      dataSource: weeklySource(),
      provider: provider(["top_product", "sales_delta"]),
      run: scheduledRun("2026-08-09"),
      period: periodForKind("weekly", "2026-08-09"),
    });

    expect(report.kind).toBe("weekly");
    expect(report.startDate).toBe("2026-08-03");
    expect(report.endDate).toBe("2026-08-09");
    expect(report.dataReadOk).toBe(true);
    expect(report.dataComplete).toBe(true);
    expect(report.text).toContain("经营周报｜8月3日–8月9日");
    expect(report.text).toContain("周单量 / 销量：**14单 / 21件**");
    expect(report.text).toContain("周销售额：**$140.00**");
    expect(report.text).toContain("总广告花费：**$14.00**");
    expect(report.text).toContain("总广告出单量：**14**");
    expect(report.text).toContain("合作量：**7**");
    expect(report.text).toContain("上线量：**7**");
    expect(report.text).toContain("水杨酸沐浴露｜14单 / 21件｜$140.00");
    expect(report.text).not.toContain("已排除商品");
    expect(report.text).not.toContain("美国");
    expect(JSON.stringify(report.card)).toContain("<at id=all></at>");
    expect(report.selectedHighlightIds).toEqual(["top_product", "sales_delta"]);
  });

  it("uses one paid snapshot fallback for a missing period-end product row", async () => {
    const table = await weeklySource().getTable("投产比");
    const withoutEndProduct: DataSource = {
      getTable: async () => ({
        ...table,
        rows: table.rows.filter((row) => !(
          row.日期 === "2026-08-08" && row.商品 === "水杨酸沐浴露"
        )),
      }),
    };
    const requested: string[] = [];
    const report = await buildPeriodicGroupReport({
      tenantId: "storetwo-formal",
      profile,
      dataSource: withoutEndProduct,
      provider: provider(null),
      run: scheduledRun("2026-08-09"),
      period: periodForKind("weekly", "2026-08-09"),
      loadPaidSnapshot: async (startDate, endDate) => {
        requested.push(`${startDate}..${endDate}`);
        return [{ date: endDate, name: "水杨酸沐浴露", orders: 2, items: 3, sales: 20 }];
      },
    });

    expect(requested).toEqual(["2026-08-02..2026-08-08"]);
    expect(report.text).toContain("周单量 / 销量：**14单 / 21件**");
    expect(report.text).toContain("周销售额：**$140.00**");
    expect(report.dataReadOk).toBe(true);
    expect(report.dataComplete).toBe(false);
  });

  it("clips a new store monthly report to its latest contiguous real Base period", async () => {
    const report = await buildPeriodicGroupReport({
      tenantId: "new-store-formal",
      profile: {
        ...profile,
        businessDisplayName: "New Store",
        dailyAutomation: {
          ...profile.dailyAutomation!,
          integrationStartDate: "2026-08-13",
        },
      },
      dataSource: sourceForRanges([
        { startDate: "2026-08-12", endDate: "2026-08-31", orders: 1, items: 1, sales: 10 },
      ]),
      provider: provider(null),
      run: scheduledRun("2026-09-01"),
      period: periodForKind("monthly", "2026-09-01"),
    });

    expect(report.startDate).toBe("2026-08-13");
    expect(report.endDate).toBe("2026-08-31");
    expect(report.dataReadOk).toBe(true);
    expect(report.dataComplete).toBe(true);
    expect(report.text).toContain("经营月报｜8月13日–8月31日");
    expect(report.text).toContain("月单量 / 销量：**19单 / 19件**");
  });

  it("sends weekly then monthly sequentially and never duplicates the same periods", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "periodic-group-report-"));
    temporaryDirectories.push(directory);
    const sentTitles: string[] = [];
    const service = new PeriodicGroupReportService({
      tenantId: "storetwo-formal",
      profile,
      dataSource: longRangeSource(),
      provider: provider(null),
      groupChatIds: ["oc_storetwo"],
      sendCard: async (_chatId, card) => {
        sentTitles.push(cardTitle(card));
        return `om_${sentTitles.length}`;
      },
      statePath: path.join(directory, "state.json"),
      now: () => new Date("2026-02-01T10:05:00.000Z"),
    });
    const run = scheduledRun("2026-02-01");
    const first = await service.handleRun(run);
    const second = await service.handleRun(run);

    expect(first.reports.map((report) => report.kind)).toEqual(["weekly", "monthly"]);
    expect(sentTitles).toEqual([
      "Storetwo 经营周报｜1月26日–2月1日",
      "Storetwo 经营月报｜2026年1月",
    ]);
    expect(first.reports.every((report) => JSON.stringify(report.card).includes("<at id=all></at>"))).toBe(true);
    expect(second.skipped).toBe(true);
    expect(sentTitles).toHaveLength(2);
  });

  it("keeps a failed monthly report pending without resending the successful weekly report", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "periodic-group-report-retry-"));
    temporaryDirectories.push(directory);
    const attempts: string[] = [];
    let failMonthly = true;
    const service = new PeriodicGroupReportService({
      tenantId: "storetwo-formal",
      profile,
      dataSource: longRangeSource(),
      provider: provider(null),
      groupChatIds: ["oc_storetwo"],
      sendCard: async (_chatId, card) => {
        const title = cardTitle(card);
        attempts.push(title);
        if (title.includes("月报") && failMonthly) {
          failMonthly = false;
          throw new Error("temporary send failure");
        }
        return `om_${attempts.length}`;
      },
      statePath: path.join(directory, "state.json"),
      now: () => new Date("2026-02-01T10:05:00.000Z"),
    });
    const run = scheduledRun("2026-02-01");
    await expect(service.handleRun(run)).rejects.toThrow("temporary send failure");
    const recovered = await service.handleRun(run);

    expect(recovered.reports.map((report) => report.kind)).toEqual(["monthly"]);
    expect(attempts.filter((title) => title.includes("周报"))).toHaveLength(1);
    expect(attempts.filter((title) => title.includes("月报"))).toHaveLength(2);
  });

  it("still sends the monthly report when the weekly send fails, then retries only weekly", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "periodic-group-report-independent-"));
    temporaryDirectories.push(directory);
    const attempts: string[] = [];
    let failWeekly = true;
    const service = new PeriodicGroupReportService({
      tenantId: "storetwo-formal",
      profile,
      dataSource: longRangeSource(),
      provider: provider(null),
      groupChatIds: ["oc_storetwo"],
      sendCard: async (_chatId, card) => {
        const title = cardTitle(card);
        attempts.push(title);
        if (title.includes("周报") && failWeekly) {
          failWeekly = false;
          throw new Error("weekly temporary failure");
        }
        return `om_${attempts.length}`;
      },
      statePath: path.join(directory, "state.json"),
      now: () => new Date("2026-02-01T10:05:00.000Z"),
    });
    const run = scheduledRun("2026-02-01");
    await expect(service.handleRun(run)).rejects.toThrow("weekly temporary failure");
    expect(attempts).toEqual([
      "Storetwo 经营周报｜1月26日–2月1日",
      "Storetwo 经营月报｜2026年1月",
    ]);
    await service.handleRun(run);
    expect(attempts.filter((title) => title.includes("周报"))).toHaveLength(2);
    expect(attempts.filter((title) => title.includes("月报"))).toHaveLength(1);
  });

  it("keeps non-due days and the 20:00 catch-up silent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "periodic-group-report-silent-"));
    temporaryDirectories.push(directory);
    let sent = 0;
    const service = new PeriodicGroupReportService({
      tenantId: "storetwo-formal",
      profile,
      dataSource: weeklySource(),
      provider: provider(null),
      groupChatIds: ["oc_storetwo"],
      sendCard: async () => { sent += 1; return "om_unexpected"; },
      statePath: path.join(directory, "state.json"),
    });
    const ordinary = await service.handleRun(scheduledRun("2026-08-12"));
    const catchUp = await service.handleRun({
      ...scheduledRun("2026-08-10"),
      runId: "daily-catch-up",
      startedAt: "2026-08-10T12:00:00.000Z",
      completedAt: "2026-08-10T12:03:00.000Z",
    });
    expect(ordinary.reason).toBe("今天不是周报或月报发送日");
    expect(catchUp.reason).toBe("20:00补跑只同步数据，不发送周报或月报");
    expect(sent).toBe(0);
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
    integrationStartDate: "2026-07-28",
    reconciliationDays: 1,
    probeDays: 14,
    runOnStartup: false,
  },
};

function weeklySource(): DataSource {
  return sourceForRanges([
    { startDate: "2026-07-26", endDate: "2026-08-01", orders: 1, items: 1, sales: 10 },
    { startDate: "2026-08-02", endDate: "2026-08-09", orders: 2, items: 3, sales: 20 },
  ]);
}

function longRangeSource(): DataSource {
  return sourceForRanges([
    { startDate: "2025-11-30", endDate: "2026-01-24", orders: 1, items: 1, sales: 10 },
    { startDate: "2026-01-25", endDate: "2026-02-01", orders: 2, items: 3, sales: 20 },
  ]);
}

function sourceForRanges(ranges: Array<{
  startDate: string;
  endDate: string;
  orders: number;
  items: number;
  sales: number;
}>): DataSource {
  const rows: Record<string, unknown>[] = [];
  for (const range of ranges) {
    for (let date = range.startDate; date <= range.endDate; date = shiftIsoDate(date, 1)) {
      rows.push({
        日期: date,
        记录类型: "店铺",
        商品: "店铺汇总",
        合作量: 1,
        上线量: 1,
        总广告花费: range.sales / 10,
        总广告出单量: range.orders,
      });
      rows.push({
        日期: date,
        记录类型: "商品",
        商品: "水杨酸沐浴露",
        单量: range.orders,
        数量: range.items,
        销售额: range.sales,
        合作量: 1,
        上线量: 1,
      });
      rows.push({
        日期: date,
        记录类型: "商品",
        商品: "已排除商品",
        单量: 99,
        数量: 99,
        销售额: 999,
        合作量: 99,
        上线量: 99,
      });
    }
  }
  const table: TableData = {
    sourceName: "飞书多维表格",
    sheetName: "投产比",
    headers: ["日期", "记录类型", "商品", "单量", "数量", "销售额", "合作量", "上线量"],
    updatedAt: new Date("2026-08-10T10:01:00.000Z"),
    rows,
  };
  return { getTable: async () => table };
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

function scheduledRun(sendDate: string): DailyAutomationRun {
  return {
    runId: `daily-${sendDate}-test`,
    trigger: "scheduled",
    startedAt: `${sendDate}T09:55:00.000Z`,
    completedAt: `${sendDate}T10:01:00.000Z`,
    latestCompleteDate: shiftIsoDate(sendDate, -2),
    orderAttributionTargetDate: shiftIsoDate(sendDate, -1),
    windowStart: shiftIsoDate(sendDate, -2),
    windowEnd: shiftIsoDate(sendDate, -2),
    catalog: phase({ matched: 1 }),
    online: phase({ matched: 1 }),
    roi: phase({ matched: 1 }),
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

function cardTitle(card: Record<string, unknown>): string {
  const header = card.header as Record<string, unknown>;
  const title = header.title as Record<string, unknown>;
  return String(title.content ?? "");
}
