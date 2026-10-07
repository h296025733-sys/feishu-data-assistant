import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProvider } from "../src/ai/types.js";
import type { DailyAutomationRun, DailyPhaseResult } from "../src/automation/daily-sync.js";
import {
  PreparedGroupReportService,
  memoizeDataSourceForReportBundle,
  preparedReportsCoverDueReports,
} from "../src/bot/prepared-group-reports.js";
import type { BusinessProfile } from "../src/config/business-profile.js";
import type { DataSource, TableData } from "../src/types/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("prepared group report scheduler", () => {
  it("keeps future scheduling and a retry alive if startup recovery sending fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "prepared-startup-failure-"));
    temporaryDirectories.push(directory);
    const service = new PreparedGroupReportService({
      tenantId: "test", profile, dataSource: source(), provider, groupChatIds: ["oc_test"],
      sendCard: async () => { throw new Error("temporary IM failure"); },
      statePath: path.join(directory, "state.json"), now: () => new Date("2026-08-17T09:56:00Z"), deliverySpacingMs: 0,
    });
    await service.prepareRun(run());
    await service.start(null);
    const failed = await service.deliverDate("2026-08-17");
    expect(failed.pendingReportKeys).toHaveLength(2);
    expect(failed.preparationErrors.join(" ")).toContain("temporary IM failure");
    const timers = service as unknown as { deliveryTimer: NodeJS.Timeout; retryTimer: NodeJS.Timeout };
    expect(timers.deliveryTimer).not.toBeNull();
    expect(timers.retryTimer).not.toBeNull();
    clearTimeout(timers.deliveryTimer);
    clearTimeout(timers.retryTimer);
  });
  it("does not let one failed IM target block other cards, and only retries the missing receipt", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "prepared-isolate-send-"));
    temporaryDirectories.push(directory);
    let failStore = true;
    const titles: string[] = [];
    const service = new PreparedGroupReportService({
      tenantId: "test", profile, dataSource: source(), provider, groupChatIds: ["oc_test"],
      sendCard: async (_chat, card) => {
        const title = cardTitle(card);
        if (failStore && title.includes("经营日报")) throw new Error("temporary store-card failure");
        titles.push(title); return `om_${titles.length}`;
      },
      statePath: path.join(directory, "state.json"), now: () => new Date("2026-08-17T09:55:00Z"), deliverySpacingMs: 0,
    });
    await service.prepareRun(run());
    const first = await service.deliverDate("2026-08-17");
    expect(first.pendingReportKeys).toEqual(["store:daily:2026-08-17"]);
    expect(titles).toEqual(["Storetwo 账号端日报｜8月15日"]);
    failStore = false;
    await service.deliverDate("2026-08-17");
    await service.deliverDate("2026-08-17");
    expect(titles).toHaveLength(2);
    clearTimeout((service as any).retryTimer);
  });

  it("sends a cached valid card without rebuilding a missing card on the delivery path", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "prepared-partial-cache-"));
    temporaryDirectories.push(directory);
    const statePath = path.join(directory, "state.json");
    let prohibitReads = false;
    const base = source();
    const service = new PreparedGroupReportService({
      tenantId: "test", profile, provider, groupChatIds: ["oc_test"],
      dataSource: { getTable: (name) => { if (prohibitReads) throw new Error("unexpected reread"); return base.getTable(name); } },
      sendCard: async () => "om_cached", statePath, now: () => new Date("2026-08-17T09:55:00Z"), deliverySpacingMs: 0,
    });
    await service.prepareRun(run());
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.bundles["2026-08-17"].reports = state.bundles["2026-08-17"].reports.slice(0, 1);
    state.bundles["2026-08-17"].errors = ["missing account"];
    state.pendingRun = run();
    await writeFile(statePath, JSON.stringify(state));
    prohibitReads = true;
    const delivered = await service.deliverDate("2026-08-17");
    expect(delivered.delivered).toHaveLength(1);
    expect(delivered.pendingReportKeys).toEqual(["account:daily:2026-08-17"]);
    clearTimeout((service as any).retryTimer);
  });

  it("refreshes before send time without sending, and registers an independent preflight timer", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "prepared-preflight-"));
    temporaryDirectories.push(directory);
    let sent = 0;
    const service = new PreparedGroupReportService({
      tenantId: "test", profile: { ...profile, dailyAutomation: { ...profile.dailyAutomation!, reportPreparationLocalTime: "17:25" } },
      provider, dataSource: source(), groupChatIds: ["oc_test"], loadLatestRun: async () => run(),
      sendCard: async () => { sent++; return "om_no"; }, statePath: path.join(directory, "state.json"),
      now: () => new Date("2026-08-17T09:24:00Z"), deliverySpacingMs: 0,
    });
    const status = await service.start(null);
    expect(status.nextPreparationAt).toBe("2026-08-17T09:25:00.000Z");
    const prepared = await service.preflight();
    expect(prepared?.reports).toHaveLength(2);
    expect(sent).toBe(0);
    clearTimeout((service as any).preparationTimer);
    clearTimeout((service as any).deliveryTimer);
  });
  it("prepares store/account cards early, sends them separately in order, and stays idempotent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "prepared-group-report-"));
    temporaryDirectories.push(directory);
    const sends: string[] = [];
    const service = new PreparedGroupReportService({
      tenantId: "storetwo-formal",
      profile,
      dataSource: source(),
      provider,
      groupChatIds: ["oc_storetwo"],
      sendCard: async (_chatId, card) => {
        sends.push(cardTitle(card));
        return `om_${sends.length}`;
      },
      statePath: path.join(directory, "state.json"),
      now: () => new Date("2026-08-17T09:45:00Z"),
      deliverySpacingMs: 0,
    });

    const prepared = await service.prepareRun(run());
    expect(prepared.errors).toEqual([]);
    expect(prepared.reports.map((report) => `${report.audience}:${report.kind}`)).toEqual([
      "store:daily",
      "account:daily",
    ]);
    expect(prepared.reports[0]?.text).toContain("总广告花费：**$4.50**");
    expect(prepared.reports[0]?.text).toContain("总广告出单量：**2**");
    expect(prepared.reports[1]?.text).toContain("广告花费：**$3.50**");
    expect(prepared.reports[1]?.text).toContain("广告出单量：**1**");
    expect(sends).toEqual([]);

    await service.deliverDate("2026-08-17");
    await service.deliverDate("2026-08-17");
    expect(sends).toEqual([
      "Storetwo 经营日报｜8月17日",
      "Storetwo 账号端日报｜8月15日",
    ]);
  });

  it("keeps an already delivered card immutable when a later recovery sees fresher data", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "prepared-delivered-snapshot-"));
    temporaryDirectories.push(directory);
    const statePath = path.join(directory, "state.json");
    const base = source();
    let includeNewerAccountDay = false;
    const dataSource: DataSource = {
      getTable: async (name) => {
        const table = await base.getTable(name);
        if (name !== "账号投产比" || !includeNewerAccountDay) return table;
        return {
          ...table,
          rows: [...table.rows, { ...table.rows[0]!, 日期: "2026-08-16", 上线量: 9 }],
        };
      },
    };
    const sends: string[] = [];
    const service = new PreparedGroupReportService({
      tenantId: "storetwo-formal", profile, dataSource, provider, groupChatIds: ["oc_storetwo"],
      sendCard: async (_chatId, card) => { sends.push(cardTitle(card)); return `om_${sends.length}`; },
      statePath, now: () => new Date("2026-08-17T09:45:00Z"), deliverySpacingMs: 0,
    });
    await service.prepareRun(run());
    await service.deliverDate("2026-08-17");
    includeNewerAccountDay = true;
    await service.prepareRun(run());
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const account = state.bundles["2026-08-17"].reports.find((item: any) => item.reportKey === "account:daily:2026-08-17");
    expect(account.sourceEndDate).toBe("2026-08-15");
    expect(cardTitle(account.card)).toBe("Storetwo 账号端日报｜8月15日");
    expect(state.deliveries["account:daily:2026-08-17"].oc_storetwo.messageId).toBe("om_2");
    expect(sends).toHaveLength(2);
  });

  it("does not block cached IM delivery behind a slow preflight network read", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "prepared-nonblocking-"));
    temporaryDirectories.push(directory);
    const base = source();
    let hold = false;
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const unblock = new Promise<void>((resolve) => { release = resolve; });
    let sends = 0;
    const service = new PreparedGroupReportService({
      tenantId: "test", profile, provider, groupChatIds: ["oc_test"],
      dataSource: { getTable: async (name) => { if (hold) { entered(); await unblock; } return base.getTable(name); } },
      sendCard: async () => `om_${++sends}`, statePath: path.join(directory, "state.json"),
      now: () => new Date("2026-08-17T09:55:00Z"), deliverySpacingMs: 0,
    });
    await service.prepareRun(run());
    hold = true;
    const pending = service.prepareRun(run());
    await reading;
    try {
      const delivered = await service.deliverDate("2026-08-17");
      expect(delivered.delivered).toHaveLength(2);
      expect(sends).toBe(2);
    } finally { release(); await pending; clearTimeout((service as any).retryTimer); }
    await service.deliverDate("2026-08-17");
    expect(sends).toBe(2);
  });

  it("keeps the 20:00 catch-up silent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "prepared-group-report-catchup-"));
    temporaryDirectories.push(directory);
    let sent = 0;
    const service = new PreparedGroupReportService({
      tenantId: "storetwo-formal",
      profile,
      dataSource: source(),
      provider,
      groupChatIds: ["oc_storetwo"],
      sendCard: async () => { sent += 1; return "om_unexpected"; },
      statePath: path.join(directory, "state.json"),
      now: () => new Date("2026-08-17T12:05:00Z"),
      deliverySpacingMs: 0,
    });
    const result = await service.prepareRun({
      ...run(),
      runId: "daily-20260817120000-catchup",
      startedAt: "2026-08-17T12:00:00.000Z",
      completedAt: "2026-08-17T12:04:00.000Z",
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("20:00");
    expect(sent).toBe(0);
  });

  it("delivers a primary bundle immediately when its sync finishes after 17:55", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "prepared-group-report-late-"));
    temporaryDirectories.push(directory);
    const sends: string[] = [];
    const service = new PreparedGroupReportService({
      tenantId: "storetwo-formal",
      profile,
      dataSource: source(),
      provider,
      groupChatIds: ["oc_storetwo"],
      sendCard: async (_chatId, card) => {
        sends.push(cardTitle(card));
        return `om_${sends.length}`;
      },
      statePath: path.join(directory, "state.json"),
      now: () => new Date("2026-08-17T10:05:00Z"),
      deliverySpacingMs: 0,
    });

    await service.prepareRun(run());
    const delivered = await service.deliverRunIfDue(run());
    await service.deliverRunIfDue(run());
    expect(delivered?.delivered.map((item) => item.reportKey)).toEqual([
      "store:daily:2026-08-17",
      "account:daily:2026-08-17",
    ]);
    expect(sends).toEqual([
      "Storetwo 经营日报｜8月17日",
      "Storetwo 账号端日报｜8月15日",
    ]);
  });

  it("reuses each table read once within one report bundle", async () => {
    const counts = new Map<string, number>();
    const base = source();
    const memoized = memoizeDataSourceForReportBundle({
      getTable: async (name = "") => {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        return base.getTable(name);
      },
    });
    const [first, second, account] = await Promise.all([
      memoized.getTable("投产比"),
      memoized.getTable("投产比"),
      memoized.getTable("账号投产比"),
    ]);
    expect(first).toBe(second);
    expect(account.sheetName).toBe("账号投产比");
    expect(Object.fromEntries(counts)).toEqual({ 投产比: 1, 账号投产比: 1 });
  });

  it("recognizes a complete monthly bundle even when a later rebuild is transiently partial", () => {
    const report = (reportKey: string) => ({
      reportKey,
      audience: reportKey.startsWith("store:") ? "store" as const : "account" as const,
      kind: reportKey.includes(":monthly:") ? "monthly" as const : "daily" as const,
      sendDate: "2026-09-01",
      sourceStartDate: "2026-08-01",
      sourceEndDate: "2026-08-31",
      dataReadOk: true,
      dataComplete: true,
      card: {},
      text: reportKey,
    });
    expect(preparedReportsCoverDueReports("2026-09-01", [
      report("store:daily:2026-09-01"),
      report("account:daily:2026-09-01"),
      report("store:monthly:2026-09-01"),
      report("account:monthly:2026-09-01"),
    ])).toBe(true);
    expect(preparedReportsCoverDueReports("2026-09-01", [
      report("store:daily:2026-09-01"),
      report("account:daily:2026-09-01"),
      report("account:monthly:2026-09-01"),
    ])).toBe(false);
  });

  it("sends all six due cards once when Sunday and month-start coincide", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "prepared-six-due-"));
    temporaryDirectories.push(directory);
    const statePath = path.join(directory, "state.json");
    const keys: string[] = [];
    const service = new PreparedGroupReportService({
      tenantId: "test", profile, provider, dataSource: source(), groupChatIds: ["oc_test"],
      sendCard: async (_chat, _card, key) => { keys.push(key); return `om_${keys.length}`; },
      statePath, now: () => new Date("2026-11-01T09:55:00Z"), deliverySpacingMs: 0,
    });
    await service.prepareRun(run());
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const template = state.bundles["2026-08-17"];
    const reports = ["daily", "weekly", "monthly"].flatMap((kind) => ["store", "account"].map((audience) => ({
      ...template.reports[0], audience, kind, sendDate: "2026-11-01", reportKey: `${audience}:${kind}:2026-11-01`,
    })));
    state.bundles["2026-11-01"] = { ...template, reports, sendDate: "2026-11-01", errors: [] };
    await writeFile(statePath, JSON.stringify(state));
    const delivered = await service.deliverDate("2026-11-01");
    await service.deliverDate("2026-11-01");
    expect(delivered.pendingReportKeys).toEqual([]);
    expect(keys).toEqual(reports.map((r) => `prepared-report:test:${r.reportKey}:oc_test`));
    expect(new Set(keys).size).toBe(6);
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
    localTime: "17:35",
    reportLocalTime: "17:55",
    catchUpLocalTime: "20:00",
    integrationStartDate: "2026-08-06",
    reconciliationDays: 1,
    probeDays: 14,
    runOnStartup: false,
  },
};

const provider: ModelProvider = {
  name: "deepseek",
  parseIntent: async (_question, _context, fallback) => ({
    intent: fallback,
    trace: { source: "local", model: null, durationMs: 0, fallbackReason: null },
  }),
  selectDailyReportHighlights: async () => ["top_product"],
};

function source(): DataSource {
  const roi: TableData = {
    sourceName: "飞书多维表格",
    sheetName: "投产比",
    headers: ["日期", "记录类型", "商品", "合作量", "上线量", "单量", "数量", "销售额"],
    updatedAt: new Date("2026-08-17T09:42:00Z"),
    rows: [
      { 日期: "2026-08-15", 记录类型: "商品", 商品: "水杨酸沐浴露", 单量: 1, 数量: 1, 销售额: 10, 上线量: 0, 合作量: 0 },
      { 日期: "2026-08-16", 记录类型: "店铺", 商品: "店铺汇总", 上线量: 1, 合作量: 0, 总广告花费: 4.5, 总广告出单量: 2 },
      { 日期: "2026-08-16", 记录类型: "商品", 商品: "水杨酸沐浴露", 单量: 2, 数量: 3, 销售额: 25, 上线量: 1, 合作量: 0 },
      { 日期: "2026-08-17", 记录类型: "店铺", 商品: "店铺汇总", 上线量: 0, 合作量: 2 },
      { 日期: "2026-08-17", 记录类型: "商品", 商品: "水杨酸沐浴露", 上线量: 0, 合作量: 2 },
    ],
  };
  const account: TableData = {
    sourceName: "飞书多维表格",
    sheetName: "账号投产比",
    headers: ["检查", "账号", "账号UID", "日期", "上线量", "单量", "销售额", "数据状态"],
    updatedAt: new Date("2026-08-17T09:42:00Z"),
    rows: [{
      检查: "Storetwo|Storetwo|2026-08-15",
      账号: "Storetwo",
      账号UID: "",
      日期: "2026-08-15",
      上线量: 1,
      单量: 2,
      销售额: 25,
      广告花费: 3.5,
      广告出单量: 1,
      数据状态: "完整",
    }],
  };
  return {
    getTable: async (name) => name === "账号投产比" ? account : roi,
  };
}

function run(): DailyAutomationRun {
  return {
    runId: "daily-20260817093500-prepared",
    trigger: "scheduled",
    startedAt: "2026-08-17T09:35:00.000Z",
    completedAt: "2026-08-17T09:42:00.000Z",
    latestCompleteDate: "2026-08-15",
    orderAttributionTargetDate: "2026-08-16",
    windowStart: "2026-08-15",
    windowEnd: "2026-08-15",
    catalog: phase(),
    online: phase(),
    roi: phase(),
    accountSide: phase(),
    ok: true,
  };
}

function phase(): DailyPhaseResult {
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
  };
}

function cardTitle(card: Record<string, unknown>): string {
  return String(((card.header as Record<string, unknown>).title as Record<string, unknown>).content ?? "");
}
