import type { Client } from "@larksuiteoapi/node-sdk";
import type { AppEnv } from "../config/env.js";
import type { BitableRecordChangeEvent } from "./contact-duplicate-index.js";
import { RoiPivotApi } from "./roi-pivot-api.js";
import {
  ROI_ALL_METRICS,
  buildRoiPivotPlan,
  type RoiPivotPlan,
} from "./roi-pivot-plan.js";

const EVENT_DEBOUNCE_MS = 800;
const HOURLY_RECONCILIATION_MS = 60 * 60_000;
const FAILED_RETRY_MS = 5_000;

export interface RoiPivotSyncResult {
  reason: string;
  recordsBefore: number;
  recordsAfter: number;
  deleted: number;
  updated: number;
  created: number;
  stats: RoiPivotPlan["stats"];
  verified: true;
  durationMs: number;
}

export interface RoiPivotSyncOptions {
  api?: RoiPivotApi;
  now?: () => number;
  eventDebounceMs?: number;
  hourlyReconciliationMs?: number;
  failedRetryMs?: number;
}

/**
 * Serializes all ROI-derived-row work into one idempotent reconciliation queue.
 * The pure plan owns business rules; this class only filters events, schedules
 * work, applies mutations in a stable order, and verifies the resulting state.
 */
export class RoiPivotSyncService {
  private readonly api: RoiPivotApi;
  private readonly now: () => number;
  private readonly eventDebounceMs: number;
  private readonly hourlyReconciliationMs: number;
  private readonly failedRetryMs: number;
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private startPromise: Promise<RoiPivotSyncResult> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private periodicTimer: NodeJS.Timeout | null = null;
  private processing = false;
  private pending = false;
  private pendingReasons = new Set<string>();
  private lastResult: RoiPivotSyncResult | null = null;

  public constructor(
    private readonly env: AppEnv,
    client: Client,
    options: RoiPivotSyncOptions = {},
  ) {
    this.api = options.api ?? new RoiPivotApi(env, client);
    this.now = options.now ?? Date.now;
    this.eventDebounceMs = options.eventDebounceMs ?? EVENT_DEBOUNCE_MS;
    this.hourlyReconciliationMs = options.hourlyReconciliationMs
      ?? HOURLY_RECONCILIATION_MS;
    this.failedRetryMs = options.failedRetryMs ?? FAILED_RETRY_MS;
  }

  public async start(): Promise<RoiPivotSyncResult> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      await this.initialize();
      if (!this.periodicTimer) {
        this.periodicTimer = setInterval(() => {
          void this.syncNow("hourly_reconciliation").catch((error) => {
            console.error(`[roi-pivot] 每小时校验失败：${safeError(error)}`);
          });
        }, this.hourlyReconciliationMs);
        this.periodicTimer.unref();
      }
      return this.syncNow("bot_startup");
    })();
    try {
      return await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      throw error;
    }
  }

  public handleRecordChanged(event: BitableRecordChangeEvent): void {
    if (event.file_token !== this.env.FEISHU_BITABLE_APP_TOKEN) return;
    if (!this.initialized) {
      this.pending = true;
      this.pendingReasons.add("event_before_initialization");
      return;
    }
    if (!this.api.isRelevantTableId(String(event.table_id ?? ""))) return;
    this.enqueue("record_changed_event", this.eventDebounceMs);
  }

  public async syncNow(reason = "manual"): Promise<RoiPivotSyncResult> {
    await this.initialize();
    this.pending = true;
    this.pendingReasons.add(reason);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.processing) await this.drain();
    await this.waitForIdle();
    if (!this.lastResult) throw new Error("投产比同步完成但没有生成结果");
    return this.lastResult;
  }

  public async waitForIdle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.processing || this.timer !== null || this.pending) {
      if (Date.now() >= deadline) throw new Error("等待投产比同步队列空闲超时");
      await sleep(10);
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initializePromise) {
      this.initializePromise = this.api.initialize().then(() => {
        if (!this.api.tableId) throw new Error("投产比 API 初始化后没有 tableId");
        this.initialized = true;
      });
    }
    try {
      await this.initializePromise;
    } catch (error) {
      this.initializePromise = null;
      throw error;
    }
  }

  private enqueue(reason: string, delayMs: number): void {
    this.pending = true;
    this.pendingReasons.add(reason);
    if (this.processing) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain().catch((error) => {
        console.error(`[roi-pivot] 同步失败，已保留队列等待重试：${safeError(error)}`);
      });
    }, delayMs);
    this.timer.unref();
  }

  private async drain(): Promise<void> {
    if (this.processing || !this.initialized) return;
    this.processing = true;
    let failed = false;
    const reasons = [...this.pendingReasons];
    this.pending = false;
    this.pendingReasons.clear();
    try {
      this.lastResult = await this.reconcile(reasons.join("+") || "queued");
      console.log(`[roi-pivot] ${JSON.stringify(this.lastResult)}`);
    } catch (error) {
      failed = true;
      this.pending = true;
      for (const reason of reasons) this.pendingReasons.add(reason);
      throw error;
    } finally {
      this.processing = false;
      if (this.pending && this.timer === null) {
        this.enqueue(
          failed ? "retry" : "queued_during_sync",
          failed ? this.failedRetryMs : this.eventDebounceMs,
        );
      }
    }
  }

  private async reconcile(reason: string): Promise<RoiPivotSyncResult> {
    const startedAt = this.now();
    const recordsBefore = await this.api.readRecords();
    const formulaInputsBefore = await this.api.readFormulaInputs();
    const plan = buildRoiPivotPlan(recordsBefore, startedAt, formulaInputsBefore);

    await this.api.ensurePivotOptions(plan.optionNames);
    await this.api.ensureMetricOptions(ROI_ALL_METRICS);
    if (plan.updates.length > 0) {
      await this.api.batchUpdate(plan.updates);
    }
    if (plan.creates.length > 0) {
      await this.api.batchCreate(plan.creates);
    }

    // Destructive work is deliberately last. A second read protects records
    // that a user may have completed while the non-destructive writes ran.
    const recordsBeforeDelete = await this.api.readRecords();
    const formulaInputsBeforeDelete = await this.api.readFormulaInputs();
    const deleteVerification = buildRoiPivotPlan(
      recordsBeforeDelete,
      startedAt,
      formulaInputsBeforeDelete,
    );
    if (deleteVerification.updates.length > 0 || deleteVerification.creates.length > 0) {
      throw new Error(
        `投产比写入尚未收敛：仍需更新 ${deleteVerification.updates.length}、`
        + `新增 ${deleteVerification.creates.length} 条；为保护数据，本轮未执行删除`,
      );
    }
    const confirmedDeleteRecordIds = confirmedDeletions(
      plan.deleteRecordIds,
      deleteVerification.deleteRecordIds,
    );
    const unexpectedDeleteRecordIds = deleteVerification.deleteRecordIds
      .filter((recordId) => !plan.deleteRecordIds.includes(recordId));
    if (unexpectedDeleteRecordIds.length > 0) {
      throw new Error(
        `投产比重读后新发现 ${unexpectedDeleteRecordIds.length} 条待删除记录；`
        + "为保护并发编辑，本轮未执行删除",
      );
    }
    if (confirmedDeleteRecordIds.length > 0) {
      await this.api.batchDelete(confirmedDeleteRecordIds);
    }

    const recordsAfter = await this.api.readRecords();
    const formulaInputsAfter = await this.api.readFormulaInputs();
    const verification = buildRoiPivotPlan(recordsAfter, startedAt, formulaInputsAfter);
    const remaining = changeCount(verification);
    if (remaining > 0) {
      throw new Error(
        `投产比写后验证失败：仍需删除 ${verification.deleteRecordIds.length}、`
        + `更新 ${verification.updates.length}、新增 ${verification.creates.length} 条`,
      );
    }
    this.api.completeMutationCycle();

    return {
      reason,
      recordsBefore: recordsBefore.length,
      recordsAfter: recordsAfter.length,
      deleted: confirmedDeleteRecordIds.length,
      updated: plan.updates.length,
      created: plan.creates.length,
      stats: verification.stats,
      verified: true,
      durationMs: this.now() - startedAt,
    };
  }
}

function changeCount(plan: RoiPivotPlan): number {
  return plan.deleteRecordIds.length + plan.updates.length + plan.creates.length;
}

function confirmedDeletions(
  initiallyPlanned: readonly string[],
  stillPlannedAfterUpserts: readonly string[],
): string[] {
  const stillPlanned = new Set(stillPlannedAfterUpserts);
  return initiallyPlanned.filter((recordId) => stillPlanned.has(recordId));
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
