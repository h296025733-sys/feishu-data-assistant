import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelProvider } from "../ai/types.js";
import { nextDailyRunAt, type DailyAutomationRun } from "../automation/daily-sync.js";
import type { BusinessProfile } from "../config/business-profile.js";
import { zonedWallTimeToInstant } from "../realtime/business-time.js";
import type { DataSource } from "../types/index.js";
import {
  buildAccountGroupReports,
  type AccountGroupReport,
} from "./account-group-report.js";
import {
  buildDailyGroupReport,
  type DailyGroupReport,
  type DailyReportPaidSnapshotLoader,
} from "./daily-group-report.js";
import {
  buildPeriodicGroupReport,
  duePeriodicReportPeriods,
  type PeriodicGroupReport,
  type PeriodicReportPaidSnapshotLoader,
} from "./periodic-group-report.js";

const MAX_DELIVERY_KEYS = 120;
const RECOVERY_WINDOW_MS = 4 * 60 * 60_000;
const FAST_RETRY_DELAY_MS = 60_000;
const SLOW_RETRY_DELAY_MS = 5 * 60_000;
const FAST_RETRY_COUNT = 3;
const MAX_DELIVERY_RETRIES = 27;

export type PreparedReportAudience = "store" | "account";
export type PreparedReportKind = "daily" | "weekly" | "monthly";

export interface PreparedGroupReport {
  reportKey: string;
  audience: PreparedReportAudience;
  kind: PreparedReportKind;
  sendDate: string;
  sourceStartDate: string;
  sourceEndDate: string;
  dataReadOk: boolean;
  dataComplete: boolean;
  card: Record<string, unknown>;
  text: string;
}

interface PreparedBundle {
  run: DailyAutomationRun;
  sendDate: string;
  preparedAt: string;
  reports: PreparedGroupReport[];
  errors: string[];
}

interface DeliveryRecord {
  chatId: string;
  messageId: string;
  deliveredAt: string;
}

interface PreparedGroupReportState {
  version: 1;
  installedAt: string;
  pendingRun: DailyAutomationRun | null;
  bundles: Record<string, PreparedBundle>;
  deliveries: Record<string, Record<string, DeliveryRecord>>;
  handledReportKeys: string[];
  updatedAt: string;
}

export interface PreparedGroupReportPreparationResult {
  skipped: boolean;
  reason: string | null;
  sendDate: string | null;
  reports: PreparedGroupReport[];
  errors: string[];
}

export interface PreparedGroupReportDeliveryResult {
  skipped: boolean;
  reason: string | null;
  sendDate: string;
  delivered: Array<DeliveryRecord & { reportKey: string }>;
  pendingReportKeys: string[];
  preparationErrors: string[];
}

/**
 * Builds every due report immediately after the early data pass and stores the
 * fully rendered cards on disk. A separate Beijing-time timer only performs
 * idempotent Feishu delivery at 17:55, so report generation and API reads are
 * off the critical send-time path.
 */
export class PreparedGroupReportService {
  private readonly statePath: string;
  private deliveryTimer: NodeJS.Timeout | null = null;
  private preparationTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly preparations = new Map<string, Promise<PreparedGroupReportPreparationResult>>();
  private retryCount = 0;
  private retryDate: string | null = null;

  public constructor(private readonly input: {
    tenantId: string;
    profile: BusinessProfile;
    dataSource: DataSource;
    provider: ModelProvider;
    groupChatIds: readonly string[] | (() => readonly string[]);
    sendCard: (chatId: string, card: Record<string, unknown>, idempotencyKey: string) => Promise<string>;
    loadDailyPaidSnapshot?: DailyReportPaidSnapshotLoader;
    loadPeriodicPaidSnapshot?: PeriodicReportPaidSnapshotLoader;
    statePath?: string;
    now?: () => Date;
    deliverySpacingMs?: number;
    loadLatestRun?: () => Promise<DailyAutomationRun | null>;
  }) {
    this.statePath = input.statePath
      ?? path.resolve(".runtime", "tenants", input.tenantId, "prepared-group-reports", "state.json");
  }

  public async start(lastAutomaticRun: DailyAutomationRun | null): Promise<Record<string, unknown>> {
    // A startup recovery failure must not prevent tomorrow's timer from
    // ever being registered. Retrying IM never changes stored report keys.
    this.scheduleNextDelivery();
    this.scheduleNextPreparation();
    let state = await this.readState();
    if (!state) {
      state = this.emptyState();
      await this.writeState(state);
    }
    if (state.pendingRun) await this.prepareRun(state.pendingRun);
    const now = this.now();
    const today = dateKey(now, this.input.profile.businessTimeZone);
    state = await this.readState() ?? state;
    if (
      lastAutomaticRun
      && isPreparationRun(lastAutomaticRun, this.input.profile)
      && dateKey(new Date(lastAutomaticRun.startedAt), this.input.profile.businessTimeZone) === today
      && !state.bundles[today]
    ) {
      await this.prepareRun(lastAutomaticRun);
      state = await this.readState() ?? state;
    }
    const reportTime = this.reportLocalTime();
    const todayReportAt = wallTimeInstant(today, reportTime, this.input.profile.businessTimeZone);
    const recoverable = now.getTime() >= todayReportAt.getTime()
      && now.getTime() - todayReportAt.getTime() <= RECOVERY_WINDOW_MS;
    if (recoverable && (await this.readState())?.bundles[today]) {
      try {
        await this.deliverDate(today);
      } catch (error) {
        this.scheduleRetry(today);
        throw error;
      }
    }
    this.scheduleNextDelivery();
    return {
      reportLocalTime: reportTime,
      nextDeliveryAt: nextDailyRunAt(now, reportTime, this.input.profile.businessTimeZone).toISOString(),
      nextPreparationAt: this.input.profile.dailyAutomation?.reportPreparationLocalTime
        ? nextDailyRunAt(now, this.input.profile.dailyAutomation.reportPreparationLocalTime, this.input.profile.businessTimeZone).toISOString()
        : null,
      recoveredToday: recoverable,
      lastAutomaticRunId: lastAutomaticRun?.runId ?? null,
    };
  }

  public prepareRun(run: DailyAutomationRun): Promise<PreparedGroupReportPreparationResult> {
    if (!isPreparationRun(run, this.input.profile)) return this.serial(() => this.prepareRunInternal(run, true));
    const date = dateKey(new Date(run.startedAt), this.input.profile.businessTimeZone);
    const existing = this.preparations.get(date);
    if (existing) return existing;
    const work = (async () => {
      await this.serial(async () => {
        const state = await this.readState() ?? this.emptyState();
        await this.writeState({ ...state, pendingRun: run, updatedAt: this.now().toISOString() });
      });
      // Network reads and text generation must never hold the IM/state queue.
      const bundle = await this.buildBundle(run);
      return this.serial(() => this.prepareRunInternal(run, true, bundle));
    })().finally(() => { this.preparations.delete(date); });
    this.preparations.set(date, work);
    return work;
  }

  public previewRun(run: DailyAutomationRun): Promise<PreparedGroupReportPreparationResult> {
    return this.buildBundle(run).then((bundle) => ({
      skipped: false,
      reason: null,
      sendDate: bundle.sendDate,
      reports: bundle.reports,
      errors: bundle.errors,
    }));
  }

  public deliverDate(sendDate: string): Promise<PreparedGroupReportDeliveryResult> {
    return this.serial(() => this.deliverDateInternal(sendDate));
  }

  /** Refresh one shared bundle before delivery, never sends a message. */
  public async preflight(): Promise<PreparedGroupReportPreparationResult | null> {
    const today = dateKey(this.now(), this.input.profile.businessTimeZone);
    const state = await this.readState();
    const latest = await this.input.loadLatestRun?.();
    const run = [latest, state?.pendingRun, state?.bundles[today]?.run].find((value) => (
      value && isPreparationRun(value, this.input.profile)
      && dateKey(new Date(value.startedAt), this.input.profile.businessTimeZone) === today
    ));
    if (!run) {
      console.warn(`[prepared-group-report-preflight:${this.input.tenantId}] 当天同步尚未产出报告快照，等待同步回调`);
      return null;
    }
    return this.prepareRun(run);
  }

  /**
   * A primary 17:35 sync can occasionally finish after the 17:55 delivery
   * timer. Deliver its newly prepared bundle immediately inside the recovery
   * window; deterministic message UUIDs and persisted report keys keep this
   * safe when the timer already sent some cards.
   */
  public deliverRunIfDue(run: DailyAutomationRun): Promise<PreparedGroupReportDeliveryResult | null> {
    if (!isPreparationRun(run, this.input.profile)) return Promise.resolve(null);
    const sendDate = dateKey(new Date(run.startedAt), this.input.profile.businessTimeZone);
    const now = this.now();
    const reportAt = wallTimeInstant(sendDate, this.reportLocalTime(), this.input.profile.businessTimeZone);
    if (now.getTime() < reportAt.getTime() || now.getTime() - reportAt.getTime() > RECOVERY_WINDOW_MS) {
      return Promise.resolve(null);
    }
    return this.deliverDate(sendDate);
  }

  private async prepareRunInternal(
    run: DailyAutomationRun,
    persist: boolean,
    prepared?: PreparedBundle,
  ): Promise<PreparedGroupReportPreparationResult> {
    if (!isPreparationRun(run, this.input.profile)) {
      return {
        skipped: true,
        reason: isCatchUpRun(run, this.input.profile)
          ? `${this.input.profile.dailyAutomation?.catchUpLocalTime ?? "20:00"}补跑只刷新数据，不重复准备报告`
          : "这不是日报预处理定时轮次",
        sendDate: null,
        reports: [],
        errors: [],
      };
    }
    if (persist && !prepared) {
      const state = await this.readState() ?? this.emptyState();
      await this.writeState({ ...state, pendingRun: run, updatedAt: this.now().toISOString() });
    }
    const bundle = prepared ?? await this.buildBundle(run);
    let resultReports = bundle.reports;
    let resultErrors = bundle.errors;
    if (persist) {
      const state = await this.readState() ?? this.emptyState();
      const existing = state.bundles[bundle.sendDate];
      const reports = mergeReports(existing?.reports ?? [], bundle.reports, state.deliveries);
      const complete = preparedReportsCoverDueReports(bundle.sendDate, reports);
      const merged: PreparedBundle = {
        ...bundle,
        reports,
        // A transient rebuild failure must not keep a recovered, complete
        // bundle pending forever. Existing cards are immutable snapshots and
        // remain safe because delivery is keyed by reportKey + chatId.
        errors: complete ? [] : bundle.errors,
      };
      resultReports = merged.reports;
      resultErrors = merged.errors;
      await this.writeState({
        ...state,
        pendingRun: merged.errors.length === 0 ? null : run,
        bundles: pruneBundles({ ...state.bundles, [bundle.sendDate]: merged }),
        updatedAt: this.now().toISOString(),
      });
    }
    return {
      skipped: false,
      reason: null,
      sendDate: bundle.sendDate,
      reports: resultReports,
      errors: resultErrors,
    };
  }

  private async buildBundle(run: DailyAutomationRun): Promise<PreparedBundle> {
    const sendDate = dateKey(new Date(run.startedAt), this.input.profile.businessTimeZone);
    const periods = duePeriodicReportPeriods(sendDate);
    const reports: PreparedGroupReport[] = [];
    const errors: string[] = [];
    const dataSource = memoizeDataSourceForReportBundle(this.input.dataSource);

    try {
      const daily = await buildDailyGroupReport({
        tenantId: this.input.tenantId,
        profile: this.input.profile,
        dataSource,
        provider: this.input.provider,
        run,
        loadPaidSnapshot: this.input.loadDailyPaidSnapshot,
      });
      if (!daily.dataReadOk || !daily.dataComplete) {
        throw new Error(daily.dataReadError ?? "日报关键字段或唯一日期行不完整");
      }
      reports.push(preparedStoreDaily(daily, sendDate));
    } catch (error) {
      errors.push(`店铺端日报：${safeError(error)}`);
    }

    try {
      const accountReports = await buildAccountGroupReports({
        tenantId: this.input.tenantId,
        profile: this.input.profile,
        dataSource,
        sendDate,
        periodicPeriods: periods,
      });
      reports.push(...accountReports.map((report) => preparedAccount(report, sendDate)));
    } catch (error) {
      errors.push(`账号端报告：${safeError(error)}`);
    }

    for (const period of periods) {
      try {
        const report = await buildPeriodicGroupReport({
          tenantId: this.input.tenantId,
          profile: this.input.profile,
          dataSource,
          provider: this.input.provider,
          run,
          period,
          loadPaidSnapshot: this.input.loadPeriodicPaidSnapshot,
        });
        if (!report.dataReadOk || !report.dataComplete) {
          throw new Error(report.dataReadError ?? `${period.kind}报告关键字段或唯一日期行不完整`);
        }
        reports.push(preparedStorePeriodic(report, sendDate));
      } catch (error) {
        errors.push(`店铺端${period.kind === "weekly" ? "周报" : "月报"}：${safeError(error)}`);
      }
    }

    return {
      run,
      sendDate,
      preparedAt: this.now().toISOString(),
      reports: reports.sort(reportOrder),
      errors,
    };
  }

  private async deliverDateInternal(sendDate: string): Promise<PreparedGroupReportDeliveryResult> {
    let state = await this.readState() ?? this.emptyState();
    // At send time, a missing card must not delay cards already validated and
    // persisted. Only rebuild synchronously when there is no usable bundle.
    if (!state.bundles[sendDate]?.reports.length && !this.preparations.has(sendDate) && state.pendingRun
      && dateKey(new Date(state.pendingRun.startedAt), this.input.profile.businessTimeZone) === sendDate) {
      await this.prepareRunInternal(state.pendingRun, true);
      state = await this.readState() ?? state;
    }
    const bundle = state.bundles[sendDate];
    if (!bundle) {
      this.scheduleRetry(sendDate);
      return {
        skipped: true,
        reason: "预处理结果尚未就绪，已安排短间隔重试",
        sendDate,
        delivered: [],
        pendingReportKeys: duePreparedReportKeys(sendDate),
        preparationErrors: [],
      };
    }
    const chatIds = [...new Set((typeof this.input.groupChatIds === "function"
      ? this.input.groupChatIds()
      : this.input.groupChatIds).map((value) => value.trim()).filter(Boolean))];
    if (chatIds.length === 0) throw new Error(`${this.input.tenantId}没有绑定专属群，报告拒绝回退到其他群`);

    const delivered: Array<DeliveryRecord & { reportKey: string }> = [];
    const pendingReportKeys: string[] = duePreparedReportKeys(sendDate)
      .filter((key) => !bundle.reports.some((report) => report.reportKey === key));
    const deliveryErrors: string[] = [];
    for (const report of bundle.reports.sort(reportOrder)) {
      if (!report.dataReadOk || !report.dataComplete) {
        pendingReportKeys.push(report.reportKey);
        continue;
      }
      const prior = state.deliveries[report.reportKey] ?? {};
      const current = { ...prior };
      for (const chatId of chatIds) {
        if (current[chatId]) {
          delivered.push({ ...current[chatId]!, reportKey: report.reportKey });
          continue;
        }
        let messageId: string;
        try {
          messageId = await this.input.sendCard(
            chatId, report.card,
            `prepared-report:${this.input.tenantId}:${report.reportKey}:${chatId}`,
          );
          if (!messageId?.trim()) throw new Error("飞书没有返回 message_id");
        } catch (error) {
          deliveryErrors.push(`${report.reportKey}：${safeError(error)}`);
          // Isolate this target; later due reports still get their own attempt.
          continue;
        }
        const record: DeliveryRecord = {
          chatId,
          messageId,
          deliveredAt: this.now().toISOString(),
        };
        current[chatId] = record;
        delivered.push({ ...record, reportKey: report.reportKey });
        state = {
          ...state,
          deliveries: { ...state.deliveries, [report.reportKey]: { ...current } },
          updatedAt: this.now().toISOString(),
        };
        await this.writeState(state);
        const spacing = this.input.deliverySpacingMs ?? 500;
        if (spacing > 0) await sleep(spacing);
      }
      const allDelivered = chatIds.every((chatId) => Boolean(current[chatId]));
      if (!allDelivered) pendingReportKeys.push(report.reportKey);
      else if (!state.handledReportKeys.includes(report.reportKey)) {
        state = {
          ...state,
          handledReportKeys: [...state.handledReportKeys, report.reportKey].slice(-MAX_DELIVERY_KEYS),
          updatedAt: this.now().toISOString(),
        };
        await this.writeState(state);
      }
    }
    const allExpectedDelivered = duePreparedReportKeys(sendDate).every((key) => (
      chatIds.every((chatId) => Boolean(state.deliveries[key]?.[chatId]))
    ));
    if (!allExpectedDelivered || bundle.errors.length > 0) this.scheduleRetry(sendDate);
    else this.retryCount = 0;
    return {
      skipped: delivered.length === 0,
      reason: delivered.length === 0 ? "本次报告均已幂等投递" : null,
      sendDate,
      delivered,
      pendingReportKeys: [...new Set(pendingReportKeys)],
      preparationErrors: [...bundle.errors, ...deliveryErrors],
    };
  }

  private scheduleNextPreparation(): void {
    const time = this.input.profile.dailyAutomation?.reportPreparationLocalTime;
    if (!time) return;
    if (this.preparationTimer) clearTimeout(this.preparationTimer);
    const next = nextDailyRunAt(this.now(), time, this.input.profile.businessTimeZone);
    this.preparationTimer = setTimeout(() => {
      this.preparationTimer = null;
      this.scheduleNextPreparation();
      void this.preflight().then((result) => {
        console.log(`[prepared-group-report-preflight:${this.input.tenantId}] ${JSON.stringify({
          sendDate: result?.sendDate, reports: result?.reports.map((r) => r.reportKey), errors: result?.errors,
        })}`);
      }).catch((error) => console.error(`[prepared-group-report-preflight:${this.input.tenantId}] ${safeError(error)}`));
    }, Math.max(1_000, next.getTime() - this.now().getTime()));
    this.preparationTimer.unref();
  }

  private scheduleNextDelivery(): void {
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
    const next = nextDailyRunAt(this.now(), this.reportLocalTime(), this.input.profile.businessTimeZone);
    this.deliveryTimer = setTimeout(() => {
      this.deliveryTimer = null;
      const sendDate = dateKey(this.now(), this.input.profile.businessTimeZone);
      this.scheduleNextDelivery();
      void this.deliverDate(sendDate).then((result) => {
        console.log(`[prepared-group-report-delivery:${this.input.tenantId}] ${JSON.stringify({
          sendDate,
          skipped: result.skipped,
          reason: result.reason,
          delivered: result.delivered.map((item) => ({ reportKey: item.reportKey, chatSuffix: item.chatId.slice(-6), messageId: item.messageId })),
          pendingReportKeys: result.pendingReportKeys,
          preparationErrors: result.preparationErrors,
        })}`);
      }).catch((error) => {
        console.error(`[prepared-group-report-delivery:${this.input.tenantId}] ${safeError(error)}`);
        this.scheduleRetry(sendDate);
      });
    }, Math.max(1_000, next.getTime() - this.now().getTime()));
    this.deliveryTimer.unref();
  }

  private scheduleRetry(sendDate: string): void {
    if (this.retryDate !== sendDate) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.retryDate = sendDate;
      this.retryCount = 0;
    }
    if (this.retryTimer || this.retryCount >= MAX_DELIVERY_RETRIES) return;
    if (dateKey(this.now(), this.input.profile.businessTimeZone) !== sendDate) return;
    this.retryCount += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // The first delivery used cached cards. Repair only incomplete preparation
      // on the later retry, then deliver only keys without receipts.
      void this.serial(async () => {
        const state = await this.readState();
        if (!this.preparations.has(sendDate) && state?.pendingRun && dateKey(new Date(state.pendingRun.startedAt), this.input.profile.businessTimeZone) === sendDate) {
          await this.prepareRunInternal(state.pendingRun, true);
        }
        return this.deliverDateInternal(sendDate);
      }).catch((error) => {
        console.error(`[prepared-group-report-retry:${this.input.tenantId}] ${safeError(error)}`);
        this.scheduleRetry(sendDate);
      });
    }, this.retryCount <= FAST_RETRY_COUNT ? FAST_RETRY_DELAY_MS : SLOW_RETRY_DELAY_MS);
    this.retryTimer.unref();
  }

  private reportLocalTime(): string {
    return this.input.profile.dailyAutomation?.reportLocalTime ?? "17:55";
  }

  private now(): Date {
    return this.input.now?.() ?? new Date();
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private emptyState(): PreparedGroupReportState {
    const now = this.now().toISOString();
    return {
      version: 1,
      installedAt: now,
      pendingRun: null,
      bundles: {},
      deliveries: {},
      handledReportKeys: [],
      updatedAt: now,
    };
  }

  private async readState(): Promise<PreparedGroupReportState | null> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as PreparedGroupReportState;
      return parsed?.version === 1 ? parsed : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeState(state: PreparedGroupReportState): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.statePath);
  }
}

function preparedStoreDaily(report: DailyGroupReport, sendDate: string): PreparedGroupReport {
  return {
    reportKey: `store:daily:${sendDate}`,
    audience: "store",
    kind: "daily",
    sendDate,
    sourceStartDate: report.orderDate ?? report.reportDate,
    sourceEndDate: report.orderDate ?? report.reportDate,
    dataReadOk: report.dataReadOk,
    dataComplete: report.dataComplete,
    card: report.card,
    text: report.text,
  };
}

function preparedStorePeriodic(report: PeriodicGroupReport, sendDate: string): PreparedGroupReport {
  return {
    reportKey: `store:${report.kind}:${sendDate}`,
    audience: "store",
    kind: report.kind,
    sendDate,
    sourceStartDate: shiftDate(report.startDate, -1),
    sourceEndDate: shiftDate(report.endDate, -1),
    dataReadOk: report.dataReadOk,
    dataComplete: report.dataComplete,
    card: report.card,
    text: report.text,
  };
}

export function memoizeDataSourceForReportBundle(source: DataSource): DataSource {
  const reads = new Map<string, ReturnType<DataSource["getTable"]>>();
  return {
    getTable(question = "") {
      const prior = reads.get(question);
      if (prior) return prior;
      const current = source.getTable(question);
      reads.set(question, current);
      return current;
    },
  };
}

function preparedAccount(report: AccountGroupReport, sendDate: string): PreparedGroupReport {
  return {
    reportKey: `account:${report.kind}:${sendDate}`,
    audience: "account",
    kind: report.kind,
    sendDate,
    sourceStartDate: report.startDate,
    sourceEndDate: report.endDate,
    dataReadOk: report.dataReadOk,
    dataComplete: report.dataComplete,
    card: report.card,
    text: report.text,
  };
}

function reportOrder(left: PreparedGroupReport, right: PreparedGroupReport): number {
  const kindOrder: Record<PreparedReportKind, number> = { daily: 0, weekly: 1, monthly: 2 };
  const audienceOrder: Record<PreparedReportAudience, number> = { store: 0, account: 1 };
  return kindOrder[left.kind] - kindOrder[right.kind]
    || audienceOrder[left.audience] - audienceOrder[right.audience]
    || left.reportKey.localeCompare(right.reportKey);
}

function mergeReports(
  existing: PreparedGroupReport[],
  incoming: PreparedGroupReport[],
  deliveries: PreparedGroupReportState["deliveries"],
): PreparedGroupReport[] {
  const byKey = new Map(existing.map((report) => [report.reportKey, report]));
  for (const report of incoming) {
    // A delivered card is an immutable historical snapshot. A later recovery
    // may discover fresher account data, but must not rewrite the stored card
    // for a message that was already sent under this report key.
    if (byKey.has(report.reportKey) && Object.keys(deliveries[report.reportKey] ?? {}).length > 0) continue;
    byKey.set(report.reportKey, report);
  }
  return [...byKey.values()].sort(reportOrder);
}

export function preparedReportsCoverDueReports(
  sendDate: string,
  reports: readonly PreparedGroupReport[],
): boolean {
  const expected = duePreparedReportKeys(sendDate);
  const byKey = new Map(reports.map((report) => [report.reportKey, report]));
  return expected.every((reportKey) => {
    const report = byKey.get(reportKey);
    return Boolean(report?.dataReadOk && report.dataComplete);
  });
}

function duePreparedReportKeys(sendDate: string): string[] {
  return [
    `store:daily:${sendDate}`,
    `account:daily:${sendDate}`,
    ...duePeriodicReportPeriods(sendDate).flatMap((period) => [
      `store:${period.kind}:${sendDate}`,
      `account:${period.kind}:${sendDate}`,
    ]),
  ];
}

function pruneBundles(bundles: Record<string, PreparedBundle>): Record<string, PreparedBundle> {
  return Object.fromEntries(Object.entries(bundles).sort(([left], [right]) => left.localeCompare(right)).slice(-8));
}

function isPreparationRun(run: DailyAutomationRun, profile: BusinessProfile): boolean {
  return run.trigger === "scheduled" && !isCatchUpRun(run, profile);
}

function isCatchUpRun(run: DailyAutomationRun, profile: BusinessProfile): boolean {
  const catchUp = profile.dailyAutomation?.catchUpLocalTime;
  return Boolean(catchUp && localTime(new Date(run.startedAt), profile.businessTimeZone) >= catchUp!);
}

function dateKey(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(value);
}

function localTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(value);
}

function wallTimeInstant(date: string, time: string, timeZone: string): Date {
  return zonedWallTimeToInstant(`${date} ${time}:00`, timeZone);
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
