import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildVideoUpdatePlan,
  executeRollback,
  extractVideoId,
  inspectRollback,
} from "../src/realtime/feishu-video-sync.js";
import { enumerateDates, nextDate, parseRealtimeMessage } from "../src/realtime/intent.js";
import {
  isNaturalWriteCandidate,
  parseKnownNaturalRoiIntent,
} from "../src/realtime/natural-write-intent.js";
import { RealtimeJobStore } from "../src/realtime/job-store.js";
import { isolatedChildEnvironment } from "../src/realtime/tiktok-cli.js";
import {
  formatRoiBulkPreview,
  summarizeOrderingVideoCounts,
  type RoiBulkUpdatePlan,
} from "../src/realtime/roi-sync.js";
import {
  buildCooperationDrivenOnlineImportPlan,
  buildOnlineImportPlan,
  formatOnlineImportPreview,
  selectOlderSoldVideoCandidates,
} from "../src/realtime/online-import.js";
import {
  executeRoiProductDeletePlan,
  formatRoiProductDeletePreview,
  prepareRoiProductDeletePlan,
} from "../src/realtime/roi-product-delete.js";
import type { FeishuRecordSnapshot, FeishuTableMeta, TikTokMachineContract } from "../src/realtime/types.js";
import { sameManagedValue } from "../src/feishu/storefour-demo-gateway.js";

describe("realtime update intent", () => {
  it("does not mistake a blank API metric for a confirmed zero", () => {
    expect(sameManagedValue(undefined, 0)).toBe(false);
    expect(sameManagedValue("", 0)).toBe(false);
    expect(sameManagedValue("0", 0)).toBe(true);
  });

  it("does not rewrite a creator handle only because duplicate highlighting added its marker", () => {
    expect(sameManagedValue("\u2063graceguitron", "graceguitron")).toBe(true);
  });

  it("recognizes the latest cooperation-driven online completion request", () => {
    expect(parseRealtimeMessage(
      "根据我刚填写的合作表寄样数据，补全红人表",
    ).intent).toEqual({
      action: "import_online_from_cooperations",
      target: "online",
      scope: "latest",
    });
  });

  it("allows flexible cooperation-driven wording without guessing matching fields", () => {
    expect(parseRealtimeMessage(
      "根据合作表把符合寄样商品的视频都补到上线表",
    ).intent).toEqual({
      action: "import_online_from_cooperations",
      target: "online",
      scope: "all",
    });
  });

  it("recognizes a controlled creator video import request", () => {
    expect(parseRealtimeMessage(
      "把 graceguitron 在 2026-07-27 发布且挂了我们商品的视频写入红人上线表",
    ).intent).toEqual({
      action: "import_online_videos",
      startDate: "2026-07-27",
      endDateInclusive: "2026-07-27",
      target: "online",
      creatorHandle: "graceguitron",
    });
  });

  it("normalizes an @handle for online imports", () => {
    expect(parseRealtimeMessage(
      "把达人：@GraceGuitron 2026-07-27 的挂车视频导入上线表",
    ).intent).toMatchObject({
      action: "import_online_videos",
      creatorHandle: "graceguitron",
    });
  });

  it("understands a short creator plus rolling-date command", () => {
    expect(parseRealtimeMessage(
      "graceguitron近七天写入表格",
      new Date("2026-08-04T02:00:00Z"),
    ).intent).toEqual({
      action: "import_online_videos",
      startDate: "2026-07-28",
      endDateInclusive: "2026-08-03",
      target: "online",
      creatorHandle: "graceguitron",
    });
  });

  it("understands a short month-day command", () => {
    expect(parseRealtimeMessage(
      "graceguitron 7月27日写入表格",
      new Date("2026-08-04T02:00:00Z"),
    ).intent).toMatchObject({
      action: "import_online_videos",
      startDate: "2026-07-27",
      endDateInclusive: "2026-07-27",
      creatorHandle: "graceguitron",
    });
  });

  it("asks for a date instead of silently assuming yesterday", () => {
    expect(parseRealtimeMessage("graceguitron写入表格").intent).toEqual({
      action: "clarify_online_import",
      target: "online",
      creatorHandle: "graceguitron",
      reason: "missing_date",
    });
  });

  it("recognizes single-day and range video updates", () => {
    const single = parseRealtimeMessage("更新 2026-07-26 的上线表");
    expect(single.intent).toEqual({
      action: "update_video",
      startDate: "2026-07-26",
      endDateInclusive: "2026-07-26",
      target: "online",
    });
    const range = parseRealtimeMessage("更新 2026-07-25 至 2026-07-26 的视频数据");
    expect(range.intent?.action).toBe("update_video");
    expect(enumerateDates("2026-07-25", "2026-07-26")).toEqual(["2026-07-25", "2026-07-26"]);
    expect(nextDate("2026-07-26")).toBe("2026-07-27");
  });

  it("recognizes persistent job controls", () => {
    expect(parseRealtimeMessage("更新状态").control).toBe("status");
    expect(parseRealtimeMessage("取消更新").control).toBe("cancel");
    expect(parseRealtimeMessage("继续刚才的更新").control).toBe("continue");
    expect(parseRealtimeMessage("继续刚才的删除").control).toBe("continue");
    expect(parseRealtimeMessage("回滚任务 rt-20260728000000-abcdef12")).toMatchObject({
      control: "rollback_preview",
      jobId: "rt-20260728000000-abcdef12",
    });
    expect(parseRealtimeMessage("确认回滚 rt-20260728000000-abcdef12")).toMatchObject({
      control: "rollback_confirm",
      jobId: "rt-20260728000000-abcdef12",
    });
    expect(parseRealtimeMessage("确认回滚").jobId).toBeNull();
  });

  it("parses an exact ROI product deletion without treating it as a normal write", () => {
    expect(parseRealtimeMessage("删除投产比商品 电动磨脚器").intent).toEqual({
      action: "delete_roi_product",
      target: "roi",
      productName: "电动磨脚器",
    });
    expect(parseRealtimeMessage("删除商品").intent).toEqual({
      action: "delete_roi_product",
      target: "roi",
    });
  });

  it("parses an ROI product name separately from the date", () => {
    expect(parseRealtimeMessage("更新投产比 2026-07-23 电动磨脚器").intent).toEqual({
      action: "update_roi",
      startDate: "2026-07-23",
      endDateInclusive: "2026-07-23",
      target: "roi",
      productName: "电动磨脚器",
    });
  });

  it("translates an abstract recent-week order command into a controlled ROI plan", () => {
    const now = new Date("2026-08-03T08:00:00+08:00");
    expect(parseKnownNaturalRoiIntent("把近一周有单量的数据填入", now)).toEqual({
      action: "update_roi",
      startDate: "2026-07-27",
      endDateInclusive: "2026-08-02",
      target: "roi",
      productScope: "all_mapped",
      rowFilter: "orders_positive",
    });
    expect(parseKnownNaturalRoiIntent("同步最近7天有订单的数据", now)).toMatchObject({
      startDate: "2026-07-27",
      endDateInclusive: "2026-08-02",
      rowFilter: "orders_positive",
    });
  });

  it("parses rolling month windows and honors an explicit include-today request", () => {
    const now = new Date("2026-08-03T17:30:00+08:00");
    expect(parseKnownNaturalRoiIntent("把近一个月（含今天）有单量的数据填入", now)).toMatchObject({
      startDate: "2026-07-05",
      endDateInclusive: "2026-08-03",
      productScope: "all_mapped",
      rowFilter: "orders_positive",
    });
    expect(parseKnownNaturalRoiIntent("把近一个月有单量的数据填入", now)).toMatchObject({
      startDate: "2026-07-04",
      endDateInclusive: "2026-08-02",
    });
    expect(parseKnownNaturalRoiIntent("把近二十天有订单的数据填入", now)).toMatchObject({
      startDate: "2026-07-14",
      endDateInclusive: "2026-08-02",
    });
  });

  it("deterministically parses exact dates, ranges, relative days, and mapped products", () => {
    const now = new Date("2026-08-03T17:30:00+08:00");
    expect(parseKnownNaturalRoiIntent("把2026-06-11有单量的数据填入", now)).toEqual({
      action: "update_roi",
      startDate: "2026-06-11",
      endDateInclusive: "2026-06-11",
      target: "roi",
      productScope: "all_mapped",
      rowFilter: "orders_positive",
    });
    expect(parseKnownNaturalRoiIntent("把2026-06-10到2026-06-14有订单的数据填入投产比", now)).toMatchObject({
      startDate: "2026-06-10",
      endDateInclusive: "2026-06-14",
      productScope: "all_mapped",
      rowFilter: "orders_positive",
    });
    expect(parseKnownNaturalRoiIntent("把6月11日有单量的数据填入", now)).toMatchObject({
      startDate: "2026-06-11",
      endDateInclusive: "2026-06-11",
    });
    expect(parseKnownNaturalRoiIntent("把昨天有单量的数据填入", now)).toMatchObject({
      startDate: "2026-08-02",
      endDateInclusive: "2026-08-02",
    });
    expect(parseKnownNaturalRoiIntent(
      "把2026-06-11电动磨脚器数据填入投产比",
      now,
      ["电动磨脚器"],
    )).toMatchObject({
      productScope: "single",
      productName: "电动磨脚器",
      rowFilter: "all",
    });
  });

  it("does not turn a read-only question into a write intent", () => {
    expect(isNaturalWriteCandidate("近一周有单量的数据有哪些？")).toBe(false);
    expect(parseKnownNaturalRoiIntent("近一周有单量的数据有哪些？")).toBeNull();
  });
});

describe("ROI product deletion", () => {
  it("previews exact records, requires confirmation externally, then verifies the delegated deletion", async () => {
    let records = [
      { recordId: "r1", productName: "电动磨脚器", dateKey: "2026-07-23", fields: { 商品: "电动磨脚器" }, lastModifiedTime: 1 },
      { recordId: "r2", productName: "电动磨脚器", dateKey: "2026-07-24", fields: { 商品: "电动磨脚器" }, lastModifiedTime: 2 },
    ];
    const gateway = {
      listRoiProductNames: async () => ["电动磨脚器", "电动磨脚器（2PCS）"],
      snapshotRoiProductRecords: async (name: string) => records.filter((record) => record.productName === name),
      deleteRoiProductRecords: async (input: { productName: string; expected: readonly { recordId: string; lastModifiedTime: number }[]; operationId: string }) => {
        expect(input.productName).toBe("电动磨脚器");
        expect(input.expected.map((record) => record.recordId)).toEqual(["r1", "r2"]);
        records = [];
        return 2;
      },
    };
    const plan = await prepareRoiProductDeletePlan({
      jobId: "rt-20260804000000-abcdef12",
      productName: "电动磨脚器",
      gateway,
    });
    const preview = formatRoiProductDeletePreview(plan);
    expect(preview).toContain("尚未删除");
    expect(preview).toContain("投产比日记录：2 条");
    expect(preview).toContain("继续刚才的删除");
    const summary = await executeRoiProductDeletePlan(plan, gateway);
    expect(summary).toMatchObject({ matched: 2, deleted: 2, updated: 0 });
    expect(records).toHaveLength(0);
  });
});

describe("ROI bulk preview evidence", () => {
  it("counts distinct ordering videos independently for each product-day", () => {
    const contract = (date: string, ids: string[]): TikTokMachineContract => ({
      ok: true,
      dataset: "shop_video_performance",
      shop: { id: "shop", name: "Storefour" },
      window_start: date,
      window_end_exclusive: nextDate(date),
      fetched_at: `${date}T12:00:00Z`,
      rows: ids.map((id) => ({ id, items_sold: 1 })),
      row_count: ids.length,
      exact_duplicate_count: 0,
      conflicting_duplicate_ids: [],
      request_ids: [],
      raw_source_paths: [],
      normalized_source_path: null,
      required_scope: [],
      granted_scope: [],
      missing_capabilities: [],
      errors: [],
    });
    const details = (date: string, ids: string[]) => new Map(ids.map((id) => [id, {
      ...contract(date, []),
      dataset: "shop_video_product_performance",
      rows: [{ id: "1732482160735195549", units_sold: 1 }],
      row_count: 1,
    }]));
    const firstIds = ["10000000001", "10000000002", "10000000003"];
    const secondIds = ["10000000001", "10000000004", "10000000005", "10000000006", "10000000007"];
    const first = summarizeOrderingVideoCounts(contract("2026-08-01", firstIds), details("2026-08-01", firstIds), "2026-08-01");
    const second = summarizeOrderingVideoCounts(contract("2026-08-02", secondIds), details("2026-08-02", secondIds), "2026-08-02");
    expect(first.byProductId.get("1732482160735195549")?.size).toBe(3);
    expect(first.storeVideoIds.size).toBe(3);
    expect(second.byProductId.get("1732482160735195549")?.size).toBe(5);
    expect(second.storeVideoIds.size).toBe(5);
  });

  it("attributes a positive video to its sole attached product when TikTok product attribution lags", () => {
    const video: TikTokMachineContract = {
      ok: true,
      dataset: "shop_video_performance",
      shop: { id: "shop", name: "Demo" },
      window_start: "2026-08-02",
      window_end_exclusive: "2026-08-03",
      fetched_at: "2026-08-05T00:00:00Z",
      rows: [{ id: "7663505421881167117", items_sold: 1 }],
      row_count: 1,
      exact_duplicate_count: 0,
      conflicting_duplicate_ids: [],
      request_ids: [],
      raw_source_paths: [],
      normalized_source_path: null,
      required_scope: [],
      granted_scope: [],
      missing_capabilities: [],
      errors: [],
    };
    const detail: TikTokMachineContract = {
      ...video,
      dataset: "shop_video_product_performance",
      rows: [{ id: "1732482023431639042", units_sold: 0 }],
    };
    const result = summarizeOrderingVideoCounts(
      video,
      new Map([["7663505421881167117", detail]]),
      "2026-08-02",
    );
    expect(result.storeVideoIds.size).toBe(1);
    expect(result.byProductId.get("1732482023431639042")?.size).toBe(1);
    expect(result.warnings).toHaveLength(0);
  });

  it("does not guess a product when a positive video has several attached products and no attribution", () => {
    const video: TikTokMachineContract = {
      ok: true,
      dataset: "shop_video_performance",
      shop: { id: "shop", name: "Demo" },
      window_start: "2026-08-02",
      window_end_exclusive: "2026-08-03",
      fetched_at: "2026-08-05T00:00:00Z",
      rows: [{
        id: "7663505421881167117",
        items_sold: 1,
        products: [{ id: "1001" }, { id: "1002" }],
      }],
      row_count: 1,
      exact_duplicate_count: 0,
      conflicting_duplicate_ids: [],
      request_ids: [],
      raw_source_paths: [],
      normalized_source_path: null,
      required_scope: [],
      granted_scope: [],
      missing_capabilities: [],
      errors: [],
    };
    const detail: TikTokMachineContract = {
      ...video,
      dataset: "shop_video_product_performance",
      rows: [{ id: "1001", units_sold: 0 }, { id: "1002", units_sold: 0 }],
    };
    const result = summarizeOrderingVideoCounts(
      video,
      new Map([["7663505421881167117", detail]]),
      "2026-08-02",
    );
    expect(result.storeVideoIds.size).toBe(1);
    expect(result.byProductId.size).toBe(0);
    expect(result.warnings).toHaveLength(1);
  });

  it("separates confirmed zero orders from dates the API has not generated", () => {
    const product = { id: "product-1", name: "电动磨脚器" };
    const zeroDates = [
      "2026-07-25", "2026-07-26", "2026-07-27", "2026-07-28",
      "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01",
    ];
    const unavailableDates = ["2026-08-02", "2026-08-03"];
    const plan: RoiBulkUpdatePlan = {
      version: 1,
      mode: "bulk",
      jobId: "rt-test",
      generatedAt: "2026-08-03T09:46:53.131Z",
      sourceShop: "Storefour",
      startDate: "2026-07-25",
      endDateInclusive: "2026-08-03",
      endDateExclusive: "2026-08-04",
      rowFilter: "orders_positive",
      scannedMappedProducts: 1,
      skippedRows: 10,
      skipSummary: { zeroOrders: 8, productMissing: 0, dateUnavailable: 2 },
      skippedDetails: [
        ...zeroDates.map((date) => ({
          date,
          product,
          reason: "zero_orders" as const,
          latestAvailableDate: "2026-08-01",
        })),
        ...unavailableDates.map((date) => ({
          date,
          product,
          reason: "date_unavailable" as const,
          latestAvailableDate: "2026-08-01",
        })),
      ],
      unmappedPositiveProducts: [],
      entries: [],
      sourceFiles: [],
      requestIds: [],
      missingItems: [],
    };

    const preview = formatRoiBulkPreview(plan);
    expect(preview).toContain("接口明确返回 0 单：8 个日期商品组合");
    expect(preview).toContain("数据尚未生成：2 个日期商品组合");
    expect(preview).toContain("接口最新可用日期为 2026-08-01");
    expect(preview).toContain("不能按 0 单处理");
    expect(preview).not.toContain("无单量或接口未返回");
  });
});

describe("isolated TikTok child environment", () => {
  it("does not inherit Feishu secrets and uses explicit UTF-8 output", () => {
    const previous = process.env.FEISHU_APP_SECRET;
    process.env.FEISHU_APP_SECRET = "test-only-secret";
    try {
      const isolated: NodeJS.ProcessEnv = {
        ...isolatedChildEnvironment(),
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      };
      expect(isolated.FEISHU_APP_SECRET).toBeUndefined();
      expect(isolated.PYTHONUTF8).toBe("1");
      expect(isolated.PYTHONIOENCODING).toBe("utf-8");
    } finally {
      if (previous == null) delete process.env.FEISHU_APP_SECRET;
      else process.env.FEISHU_APP_SECRET = previous;
    }
  });
});

describe("realtime job ownership", () => {
  it("does not reuse another user's completed task", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "techwave-jobs-"));
    const store = new RealtimeJobStore(root);
    const intent = {
      action: "update_roi" as const,
      startDate: "2026-07-23",
      endDateInclusive: "2026-07-23",
      target: "roi" as const,
      productName: "电动磨脚器",
    };
    const first = await store.createOrReuse({
      userId: "user-a",
      messageId: "message-a",
      intent,
    });
    await store.setResult(first.job, {
      windowStart: "2026-07-23",
      windowEndExclusive: "2026-07-24",
      sources: [],
      matched: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      conflicts: 0,
      missingItems: [],
      backupPath: null,
      rollbackCommand: null,
    });
    const second = await store.createOrReuse({
      userId: "user-b",
      messageId: "message-b",
      intent,
    });
    expect(second.reused).toBe(false);
    expect(second.job.userIdHash).not.toBe(first.job.userIdHash);
  });

  it("does not reuse a successful deletion from an older message", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "techwave-delete-jobs-"));
    const store = new RealtimeJobStore(root);
    const intent = { action: "delete_roi_product" as const, target: "roi" as const, productName: "电动磨脚器" };
    const first = await store.createOrReuse({ userId: "admin", messageId: "delete-1", intent });
    await store.setResult(first.job, {
      windowStart: null, windowEndExclusive: null, sources: ["飞书"], matched: 1,
      created: 0, updated: 0, deleted: 1, unchanged: 0, skipped: 0, conflicts: 0,
      missingItems: [], backupPath: null, rollbackCommand: null,
    });
    const second = await store.createOrReuse({ userId: "admin", messageId: "delete-2", intent });
    expect(second.reused).toBe(false);
    expect(second.job.jobId).not.toBe(first.job.jobId);
  });
});

describe("protected rollback", () => {
  it("verifies backup hash, restores owned values, and becomes idempotent", async () => {
    const backupRoot = await mkdtemp(path.join(tmpdir(), "techwave-rollback-"));
    const jobId = "rt-20260728000000-abcdef12";
    const directory = path.join(backupRoot, jobId);
    await mkdir(directory, { recursive: true });
    const beforeText = `${JSON.stringify({
      version: 1,
      jobId,
      records: [{ tableId: "t1", tableName: "Tech-wave红人上线表_1", recordId: "r1", fields: { 视频曝光K: "10" } }],
    }, null, 2)}\n`;
    await writeFile(path.join(directory, "before.json"), beforeText, "utf8");
    await writeFile(
      path.join(directory, "before.sha256"),
      `${createHash("sha256").update(beforeText).digest("hex")}  before.json\n`,
      "ascii",
    );
    await writeFile(path.join(directory, "rollback.json"), `${JSON.stringify({
      version: 1,
      jobId,
      operations: [{
        tableId: "t1",
        tableName: "Tech-wave红人上线表_1",
        recordId: "r1",
        expectedAfter: { 视频曝光K: "20" },
        restoreFields: { 视频曝光K: "10" },
      }],
    }, null, 2)}\n`, "utf8");

    let current = "20";
    const gateway = {
      getRecord: async () => ({
        tableId: "t1",
        tableName: "Tech-wave红人上线表_1",
        recordId: "r1",
        fields: { 视频曝光K: current },
        lastModifiedTime: 1,
      }),
      batchUpdate: async (_tableId: string, updates: Array<{ fields: Record<string, unknown> }>) => {
        current = String(updates[0].fields.视频曝光K);
      },
    };
    const preview = await inspectRollback(jobId, backupRoot);
    expect(preview).toMatchObject({
      operationCount: 1,
      fieldNames: ["视频曝光K"],
      backupHashVerified: true,
      completedResult: null,
    });
    const first = await executeRollback(jobId, `ROLLBACK-${jobId}`, gateway as never, backupRoot);
    expect(first).toMatchObject({ restored: 1, skipped: 0 });
    expect(current).toBe("10");
    const second = await executeRollback(jobId, `ROLLBACK-${jobId}`, gateway as never, backupRoot);
    expect(second).toMatchObject({ restored: 1, skipped: 0, alreadyCompleted: true });
    expect(current).toBe("10");
  });

  it("deletes a record created by an online import when it is still task-owned", async () => {
    const backupRoot = await mkdtemp(path.join(tmpdir(), "techwave-created-rollback-"));
    const jobId = "rt-20260804000000-acde1234";
    const directory = path.join(backupRoot, jobId);
    await mkdir(directory, { recursive: true });
    const beforeText = `${JSON.stringify({ version: 1, jobId, records: [] }, null, 2)}\n`;
    await writeFile(path.join(directory, "before.json"), beforeText, "utf8");
    await writeFile(
      path.join(directory, "before.sha256"),
      `${createHash("sha256").update(beforeText).digest("hex")}  before.json\n`,
      "ascii",
    );
    await writeFile(path.join(directory, "rollback.json"), `${JSON.stringify({
      version: 1,
      jobId,
      operations: [{
        action: "delete_created",
        tableId: "online",
        tableName: "Tech-wave红人上线表",
        recordId: "new-record",
        expectedAfter: { 达人姓名: "graceguitron" },
        restoreFields: {},
      }],
    }, null, 2)}\n`, "utf8");

    let exists = true;
    const gateway = {
      recordExists: async () => exists,
      getRecord: async () => ({
        tableId: "online",
        tableName: "Tech-wave红人上线表",
        recordId: "new-record",
        fields: { 达人姓名: "graceguitron" },
        lastModifiedTime: 1,
      }),
      batchDelete: async () => { exists = false; },
      batchUpdate: async () => { throw new Error("不应更新记录"); },
    };
    const preview = await inspectRollback(jobId, backupRoot);
    expect(preview.fieldNames).toEqual(["（删除本任务新增记录）"]);
    const result = await executeRollback(jobId, `ROLLBACK-${jobId}`, gateway as never, backupRoot);
    expect(result).toMatchObject({ restored: 1, skipped: 0 });
    expect(exists).toBe(false);
  });
});

describe("realtime idempotency", () => {
  it("reuses the same Feishu message and successful semantic task", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "techwave-jobs-"));
    const store = new RealtimeJobStore(root);
    const intent = {
      action: "update_video" as const,
      startDate: "2026-07-26",
      endDateInclusive: "2026-07-26",
      target: "online" as const,
    };
    const first = await store.createOrReuse({ userId: "u1", messageId: "m1", intent });
    expect(first.reused).toBe(false);
    const duplicateMessage = await store.createOrReuse({ userId: "u1", messageId: "m1", intent });
    expect(duplicateMessage.reused).toBe(true);
    await store.setResult(first.job, {
      windowStart: "2026-07-26",
      windowEndExclusive: "2026-07-27",
      sources: [],
      matched: 1,
      created: 0,
      updated: 1,
      unchanged: 0,
      skipped: 0,
      conflicts: 0,
      missingItems: [],
      backupPath: "backup",
      rollbackCommand: "rollback",
    });
    const semanticDuplicate = await store.createOrReuse({ userId: "u1", messageId: "m2", intent });
    expect(semanticDuplicate.reused).toBe(true);
    expect(semanticDuplicate.job.jobId).toBe(first.job.jobId);
  });
});

describe("deterministic video plan", () => {
  it("selects only older non-store videos with a positive complete-day sale", () => {
    const contract: TikTokMachineContract = {
      ok: true,
      dataset: "shop_video_performance",
      shop: { id: "shop", name: "STOREONE" },
      window_start: "2026-08-10",
      window_end_exclusive: "2026-08-11",
      fetched_at: "2026-08-12T00:00:00Z",
      rows: [
        { id: "7000000000000000001", creator_author_type: "AFFILIATE_ACCOUNTS", video_post_time: "2026-07-10 10:00:00", items_sold: 2 },
        { id: "7000000000000000002", creator_author_type: "AFFILIATE_ACCOUNTS", video_post_time: "2026-07-11 10:00:00", items_sold: 0 },
        { id: "7000000000000000003", creator_author_type: "AFFILIATE_ACCOUNTS", video_post_time: "2026-08-05 10:00:00", items_sold: 1 },
        { id: "7000000000000000004", creator_author_type: "MARKETING_ACCOUNTS", video_post_time: "2026-07-09 10:00:00", items_sold: 1 },
        { id: "bad", creator_author_type: "AFFILIATE_ACCOUNTS", video_post_time: "2026-07-09 10:00:00", items_sold: 1 },
      ],
      row_count: 5,
      exact_duplicate_count: 0,
      conflicting_duplicate_ids: [],
      request_ids: [],
      raw_source_paths: [],
      normalized_source_path: null,
      required_scope: [],
      granted_scope: [],
      missing_capabilities: [],
      errors: [],
      latest_available_date: "2026-08-10",
    };
    expect(selectOlderSoldVideoCandidates(
      contract,
      "2026-07-29",
      "America/Los_Angeles",
      "Asia/Shanghai",
    )).toEqual([{
      videoId: "7000000000000000001",
      publishBusinessDate: "2026-07-11",
    }]);
  });

  it("filters a cumulative refresh contract before reading Feishu snapshots", async () => {
    const contract: TikTokMachineContract = {
      ok: true,
      dataset: "shop_video_performance",
      shop: { id: "shop", name: "STOREONE" },
      window_start: "2026-07-01",
      window_end_exclusive: "2026-08-11",
      fetched_at: "2026-08-12T00:00:00Z",
      rows: [
        { id: "7000000000000000001", creator_user_name: "creator1", creator_author_type: "AFFILIATE_ACCOUNTS", video_post_time: "2026-07-10 10:00:00", products: JSON.stringify([{ id: "speaker" }]), views: 1000, items_sold: 2, gmv_amount: "20.00", gmv_currency: "USD" },
        { id: "7000000000000000002", creator_user_name: "creator2", creator_author_type: "AFFILIATE_ACCOUNTS", video_post_time: "2026-07-11 10:00:00", products: JSON.stringify([{ id: "speaker" }]), views: 2000, items_sold: 3, gmv_amount: "30.00", gmv_currency: "USD" },
      ],
      row_count: 2,
      exact_duplicate_count: 0,
      conflicting_duplicate_ids: [],
      request_ids: [],
      raw_source_paths: [],
      normalized_source_path: null,
      required_scope: [],
      granted_scope: [],
      missing_capabilities: [],
      errors: [],
      latest_available_date: "2026-08-10",
    };
    const snapshots: string[] = [];
    const plan = await buildOnlineImportPlan(
      "rt-20260812000000-abcdef12",
      { action: "import_online_videos", target: "online", startDate: "2026-07-01", endDateInclusive: "2026-07-31" },
      contract,
      { speaker: "便携蓝牙音箱" },
      { snapshotOnlineByVideoId: async (videoId) => { snapshots.push(videoId); return null; } },
      undefined,
      ["7000000000000000002"],
    );
    expect(plan.videos.map((item) => item.video.id)).toEqual(["7000000000000000002"]);
    expect(snapshots).toEqual(["7000000000000000002"]);
  });

  it("matches cooperation date, canonical handle, and sampled product together", async () => {
    const contract: TikTokMachineContract = {
      ok: true,
      dataset: "shop_video_performance",
      shop: { id: "shop", name: "Storefour" },
      window_start: "2026-07-25",
      window_end_exclusive: "2026-08-04",
      fetched_at: "2026-08-04T00:00:00Z",
      rows: [
        { id: "7666914177910328590", creator_user_name: "graceguitron", video_post_time: "2026-07-26 11:03:06", products: JSON.stringify([{ id: "foot" }]), views: 776, items_sold: 0, gmv_amount: "0.00", gmv_currency: "USD" },
        { id: "7667272841808710926", creator_user_name: "GraceGuitron", video_post_time: "2026-07-27 10:15:05", products: JSON.stringify([{ id: "foot" }]), views: 283, items_sold: 0, gmv_amount: "0.00", gmv_currency: "USD" },
        { id: "7666000000000000000", creator_user_name: "graceguitron", video_post_time: "2026-07-25 10:15:05", products: JSON.stringify([{ id: "foot" }]), views: 100, items_sold: 0, gmv_amount: "0.00", gmv_currency: "USD" },
        { id: "7667000000000000000", creator_user_name: "someoneelse", video_post_time: "2026-07-27 10:15:05", products: JSON.stringify([{ id: "foot" }]), views: 100 },
        { id: "7667000000000000001", creator_user_name: "graceguitron", video_post_time: "2026-07-27 10:15:05", products: JSON.stringify([{ id: "other" }]), views: 100 },
      ],
      row_count: 5,
      exact_duplicate_count: 0,
      conflicting_duplicate_ids: [],
      request_ids: ["req"],
      raw_source_paths: ["raw.json"],
      normalized_source_path: null,
      required_scope: [],
      granted_scope: [],
      missing_capabilities: [],
      errors: [],
      latest_available_date: "2026-08-03",
    };
    const plan = await buildCooperationDrivenOnlineImportPlan(
      "rt-20260804000000-abcdef12",
      [{
        recordId: "rec1",
        creatorHandle: "graceguitron",
        cooperationDate: "2026-07-26",
        products: ["电动磨脚器"],
        lastModifiedTime: 2,
        createdTime: 1,
        missingItems: [],
      }],
      contract,
      { foot: "电动磨脚器", other: "其他商品" },
      { snapshotOnlineByVideoId: async () => null },
    );
    expect(plan.videos.map((item) => item.video.id)).toEqual([
      "7666000000000000000",
      "7666914177910328590",
      "7667272841808710926",
    ]);
    expect(formatOnlineImportPreview(plan)).toContain("graceguitron｜合作日期 2026-07-26｜电动磨脚器");
    expect(formatOnlineImportPreview(plan)).toContain("准备新增 3 条");
    expect(formatOnlineImportPreview(plan)).toContain("发布时间：2026-07-26 至 2026-07-28（北京时间）");
  });

  it("builds a mapped creator-video create preview from JSON product data", async () => {
    const contract: TikTokMachineContract = {
      ok: true,
      dataset: "shop_video_performance",
      shop: { id: "shop", name: "Storefour" },
      window_start: "2026-07-27",
      window_end_exclusive: "2026-07-28",
      fetched_at: "2026-08-04T00:00:00Z",
      rows: [{
        id: "7667272841808710926",
        creator_user_name: "GraceGuitron",
        creator_nick_name: "Grace Güitrón",
        creator_author_type: "AFFILIATE_ACCOUNTS",
        video_post_time: "2026-07-27 10:15:05",
        products: JSON.stringify([{ id: "1732482160735195549", name: "Foot grinder" }]),
        views: 283,
        items_sold: 0,
        gmv_amount: "0.00",
        gmv_currency: "USD",
      }],
      row_count: 1,
      exact_duplicate_count: 0,
      conflicting_duplicate_ids: [],
      request_ids: ["req"],
      raw_source_paths: ["raw.json"],
      normalized_source_path: null,
      required_scope: [],
      granted_scope: [],
      missing_capabilities: [],
      errors: [],
    };
    const plan = await buildOnlineImportPlan(
      "rt-20260804000000-abcdef12",
      {
        action: "import_online_videos",
        startDate: "2026-07-28",
        endDateInclusive: "2026-07-28",
        target: "online",
        creatorHandle: "graceguitron",
      },
      contract,
      { "1732482160735195549": "电动磨脚器" },
      { snapshotOnlineByVideoId: async () => null },
    );
    expect(plan.videos).toHaveLength(1);
    expect(plan.videos[0].video).toMatchObject({
      id: "7667272841808710926",
      creator: "graceguitron",
      date: "2026-07-28",
      products: ["电动磨脚器"],
      viewsK: 0.283,
      itemsSold: 0,
      gmv: 0,
    });
    expect(formatOnlineImportPreview(plan)).toContain("准备新增 1 条");
    expect(formatOnlineImportPreview(plan)).toContain("继续刚才的更新");
  });

  it("refuses nickname-only rows and unmapped products", async () => {
    const contract: TikTokMachineContract = {
      ok: true,
      dataset: "shop_video_performance",
      shop: { id: "shop", name: "Storefour" },
      window_start: "2026-07-27",
      window_end_exclusive: "2026-07-28",
      fetched_at: "2026-08-04T00:00:00Z",
      rows: [
        {
          id: "7667272841808710926",
          creator_nick_name: "Grace Güitrón",
          video_post_time: "2026-07-27 10:15:05",
          products: "[]",
          views: 283,
        },
        {
          id: "7667272841808710927",
          creator_user_name: "graceguitron",
          video_post_time: "2026-07-27 11:15:05",
          products: JSON.stringify([{ id: "unmapped" }]),
          views: 10,
        },
      ],
      row_count: 2,
      exact_duplicate_count: 0,
      conflicting_duplicate_ids: [],
      request_ids: [],
      raw_source_paths: [],
      normalized_source_path: null,
      required_scope: [],
      granted_scope: [],
      missing_capabilities: [],
      errors: [],
    };
    const plan = await buildOnlineImportPlan(
      "rt-20260804000000-abcdef12",
      {
        action: "import_online_videos",
        startDate: "2026-07-28",
        endDateInclusive: "2026-07-28",
        target: "online",
        creatorHandle: "graceguitron",
      },
      contract,
      { "1732482160735195549": "电动磨脚器" },
      { snapshotOnlineByVideoId: async () => null },
    );
    expect(plan.videos).toHaveLength(0);
    expect(plan.conflicts.some((item) => item.reason.includes("尚未映射"))).toBe(true);
  });

  it("silently skips productless videos during a bulk store scan", async () => {
    const contract: TikTokMachineContract = {
      ok: true,
      dataset: "shop_video_performance",
      shop: { id: "shop", name: "Storetwo" },
      window_start: "2026-07-27",
      window_end_exclusive: "2026-07-28",
      fetched_at: "2026-08-04T00:00:00Z",
      rows: [{
        id: "7667272841808710999",
        creator_user_name: "ordinarycreator",
        creator_author_type: "AFFILIATE_ACCOUNTS",
        video_post_time: "2026-07-27 10:15:05",
        products: "[]",
        views: 10,
        items_sold: 0,
        gmv_amount: "0.00",
        gmv_currency: "USD",
      }],
      row_count: 1,
      exact_duplicate_count: 0,
      conflicting_duplicate_ids: [],
      request_ids: [],
      raw_source_paths: [],
      normalized_source_path: null,
      required_scope: [],
      granted_scope: [],
      missing_capabilities: [],
      errors: [],
    };
    const plan = await buildOnlineImportPlan(
      "rt-20260804000000-abcdef12",
      { action: "import_online_videos", startDate: "2026-07-28", endDateInclusive: "2026-07-28", target: "online" },
      contract,
      {},
      { snapshotOnlineByVideoId: async () => null },
    );
    expect(plan.videos).toHaveLength(0);
    expect(plan.skipped).toBe(1);
    expect(plan.conflicts).toEqual([]);
  });

  it("matches by video ID, writes raw views, and never guesses duplicates", async () => {
    const tables: FeishuTableMeta[] = [
      {
        tableId: "t1",
        name: "Tech-wave红人上线表_1",
        fields: [
          { fieldId: "f1", fieldName: "视频上线地址", type: 15, uiType: "Url" },
          { fieldId: "f2", fieldName: "视频曝光K", type: 1, uiType: "Text" },
        ],
      },
      {
        tableId: "t2",
        name: "Tech-wave红人上线表_2",
        fields: [
          { fieldId: "f3", fieldName: "视频上线地址", type: 15, uiType: "Url" },
          { fieldId: "f4", fieldName: "视频曝光K", type: 2, uiType: "Number" },
        ],
      },
    ];
    const records = new Map<string, FeishuRecordSnapshot[]>([
      ["t1", [{
        tableId: "t1",
        tableName: tables[0].name,
        recordId: "r1",
        fields: { 视频上线地址: { text: "v", link: "https://www.tiktok.com/@a/video/12345678901" }, 视频曝光K: "5" },
        lastModifiedTime: 1,
      }]],
      ["t2", [{
        tableId: "t2",
        tableName: tables[1].name,
        recordId: "r2",
        fields: { 视频上线地址: "https://www.tiktok.com/@b/video/12345678902", 视频曝光K: 7 },
        lastModifiedTime: 2,
      }]],
    ]);
    const gateway = {
      discoverOnlineTables: async () => tables,
      searchVideoRecords: async (table: FeishuTableMeta) => records.get(table.tableId) ?? [],
    };
    const contract: TikTokMachineContract = {
      ok: true,
      dataset: "shop_video_performance",
      shop: { id: "s1", name: "Storefour" },
      window_start: "2026-07-26",
      window_end_exclusive: "2026-07-27",
      fetched_at: "2026-07-27T00:00:00Z",
      rows: [
        { id: "12345678901", views: 101829, items_sold: 0, gmv_amount: "0.00" },
        { id: "12345678902", views: 7, items_sold: 0, gmv_amount: "0.00" },
        { id: "12345678903", views: 9 },
      ],
      row_count: 3,
      exact_duplicate_count: 2,
      conflicting_duplicate_ids: [],
      request_ids: ["req"],
      raw_source_paths: ["raw.json"],
      normalized_source_path: "normalized.csv",
      required_scope: ["data.shop_analytics.public.read"],
      granted_scope: ["data.shop_analytics.public.read"],
      missing_capabilities: [],
      errors: [],
    };
    const plan = await buildVideoUpdatePlan("rt-20260727000000-abcdef12", contract, gateway as never);
    expect(plan.matched).toBe(2);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].afterFields).toEqual({ 视频曝光K: "101829" });
    expect(plan.unchanged).toBe(1);
    expect(plan.skipped).toBe(1);
    expect(plan.exactDuplicateCount).toBe(2);
  });

  it("extracts IDs from Feishu URL values", () => {
    expect(extractVideoId({ text: "video", link: "https://www.tiktok.com/@x/video/12345678901?lang=en" }))
      .toBe("12345678901");
  });
});
