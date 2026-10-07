import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { ModelProvider } from "../ai/types.js";
import type { AppEnv } from "../config/env.js";
import { loadBusinessProfile, type BusinessProfile } from "../config/business-profile.js";
import { prepareLatestAccountSidePlan } from "../account-side/plan.js";
import {
  readTenantRuntimeSettings,
  writeTenantRuntimeSettings,
} from "../config/tenant-runtime-settings.js";
import { StorefourDemoGateway } from "../feishu/storefour-demo-gateway.js";
import {
  syncAccountSidePlanWithClient,
  type AccountSideBase,
} from "../feishu/account-side-test.js";
import {
  loadProductCatalogMap,
  syncProductCatalog,
  type UnmappedCatalogProduct,
} from "./product-catalog.js";
import {
  ProductApprovalService,
  type ConfirmProductApprovalResult,
  type PendingProductApproval,
} from "./product-approval.js";
import {
  dateKeyInTimeZone,
  shiftIsoDate,
  shopTimestampToBusinessDate,
  zonedWallTimeToInstant,
} from "../realtime/business-time.js";
import {
  executeOnlineImportPlan,
  prepareAttributedVideoExposureRefreshPlan,
  prepareOlderSoldVideoRefreshPlan,
  prepareOnlineImportPlan,
  type OnlineImportPlan,
} from "../realtime/online-import.js";
import {
  executeOrderAttributionUpdatePlan,
  executeRoiBulkUpdatePlan,
  prepareOrderAttributionUpdatePlan,
  prepareRoiBulkUpdatePlan,
  type RoiBulkUpdatePlan,
} from "../realtime/roi-sync.js";
import {
  fetchTikTokAnalytics,
  fetchTikTokProductDetail,
  fetchTikTokProductCatalog,
  fetchTikTokVideoDay,
  tikTokRuntimeFromProfile,
  type TikTokRuntimeContext,
} from "../realtime/tiktok-cli.js";
import type { RealtimeResultSummary, TikTokMachineContract } from "../realtime/types.js";
import { KeyedSerialQueue } from "./keyed-serial-queue.js";
import { listRecentOnlineProductClickCandidates, syncOnlineVideoProductClicks, type VideoClickCandidate } from "./online-product-clicks.js";

const STARTUP_DELAY_MS = 3_000;

export interface DailyAutomationConfig {
  enabled: boolean;
  localTime: string;
  catchUpLocalTime?: string;
  integrationStartDate: string;
  reconciliationDays: number;
  probeDays: number;
  runOnStartup: boolean;
}

export interface DailyPhaseResult {
  ok: boolean;
  matched: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  conflicts: number;
  missingItems: string[];
  error: string | null;
  sourceDate?: string;
  productClicks?: { queried: number; updated: number; unchanged: number; skippedTooOld: number; skippedMissing: number };
}

export interface DailyAutomationRun {
  runId: string;
  trigger: "startup" | "scheduled" | "manual_test" | "manual_initialization" | "manual_backfill";
  startedAt: string;
  completedAt: string;
  latestCompleteDate: string | null;
  /** Previous complete shop day requested from the Order API, independent of analytics lag. */
  orderAttributionTargetDate?: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  catalog: DailyPhaseResult;
  online: DailyPhaseResult;
  roi: DailyPhaseResult;
  /** Optional account-owned video/product/account ROI refresh in the same existing Base. */
  accountSide?: DailyPhaseResult;
  /** Per-video product clicks, independently refreshed from the details API. */
  onlineClicks?: DailyPhaseResult;
  ok: boolean;
}

export type DailyAutomationRunCompleted = (run: DailyAutomationRun) => Promise<void> | void;

function isAutomaticTrigger(trigger: DailyAutomationRun["trigger"] | null | undefined): boolean {
  return trigger === "scheduled" || trigger === "startup";
}

export function shouldRecoverPrimaryRun(
  now: Date, timeZone: string, primaryTime: string, catchUpTime: string | undefined,
  lastRun: DailyAutomationRun | null | undefined,
): boolean {
  const date = dateKeyInTimeZone(now, timeZone);
  const primary = zonedWallTimeToInstant(`${date} ${primaryTime}:00`, timeZone).getTime();
  const catchUp = zonedWallTimeToInstant(`${date} ${catchUpTime ?? "23:59"}:00`, timeZone).getTime();
  if (now.getTime() < primary || now.getTime() >= catchUp) return false;
  return !lastRun || Date.parse(lastRun.startedAt) < primary;
}

export interface StoreInitializationStatus {
  version: 1;
  completed: boolean;
  windowStart: string | null;
  windowEnd: string | null;
  completedAt: string | null;
  lastAttemptAt: string;
  lastRun: DailyAutomationRun | null;
  state?: "running" | "waiting_product_confirmation" | "ready_to_resume" | "failed" | "completed";
  requestedDays?: number | null;
  force?: boolean;
  pendingProductIds?: string[];
  lastError?: string | null;
  progress?: StoreInitializationProgress | null;
}

export interface StoreInitializationProgress {
  phase: "preparing" | "catalog" | "online" | "roi_collecting" | "roi_writing" | "roi_verifying";
  currentDate: string | null;
  completedDays: number;
  totalDays: number;
  updatedAt: string;
}

export interface StoreInitializationResult {
  alreadyInitialized: boolean;
  status: StoreInitializationStatus;
  run: DailyAutomationRun | null;
}

export interface ProductConfirmationWorkflowResult extends ConfirmProductApprovalResult {
  remainingPending: number;
  shouldResumeInitialization: boolean;
  initializationDays: number | null;
}

export interface DailyAutomationStatus {
  version: 1;
  enabled: boolean;
  timeZone: string;
  localTime: string;
  catchUpLocalTime?: string;
  integrationStartDate: string;
  reconciliationDays: number;
  nextRunAt: string | null;
  running: boolean;
  lastRun: DailyAutomationRun | null;
  /** Last scheduled/startup run. Manual history backfills must never overwrite this view. */
  lastAutomaticRun?: DailyAutomationRun | null;
  updatedAt: string;
}

export class DailyAutomationService {
  private readonly profile: BusinessProfile;
  private readonly appEnv: AppEnv;
  private readonly tenantId: string;
  private readonly statusRoot: string;
  private readonly statusPath: string;
  private readonly initializationPath: string;
  private config: DailyAutomationConfig;
  private readonly gateway: StorefourDemoGateway;
  private readonly productApprovals: ProductApprovalService;
  private readonly accountSideClient: Client;
  private readonly accountSideBase: AccountSideBase;
  private pendingClickCandidates: VideoClickCandidate[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<DailyAutomationRun> | null = null;
  private attributedVideoRefreshRunning: Promise<void> | null = null;
  private readonly initializationQueue = new KeyedSerialQueue();
  private readonly productConfirmationQueue = new KeyedSerialQueue();
  private initializationInFlight: {
    days: number;
    force: boolean;
    promise: Promise<StoreInitializationResult>;
  } | null = null;

  public constructor(
    env: AppEnv,
    client: Client,
    profile = loadBusinessProfile(),
    tenantId = "default",
    provider?: ModelProvider,
    private readonly onRunCompleted?: DailyAutomationRunCompleted,
  ) {
    this.appEnv = env;
    this.profile = profile;
    this.tenantId = tenantId;
    this.statusRoot = path.resolve(".runtime", "tenants", tenantId, "daily-automation");
    this.statusPath = path.join(this.statusRoot, "status.json");
    this.initializationPath = path.join(this.statusRoot, "initialization.json");
    this.config = resolveDailyAutomationConfig(profile);
    this.gateway = new StorefourDemoGateway(env, client, profile);
    this.productApprovals = new ProductApprovalService(profile, tenantId, provider);
    this.accountSideClient = client;
    this.accountSideBase = {
      storeKey: tenantId,
      storeName: profile.businessDisplayName,
      appToken: env.FEISHU_BITABLE_APP_TOKEN,
      name: profile.businessDisplayName,
      url: env.FEISHU_BITABLE_URL,
      createdAt: "existing-formal-base",
    };
  }

  public isBusy(): boolean {
    return this.running !== null
      || this.initializationInFlight !== null
      || this.attributedVideoRefreshRunning !== null;
  }

  public async latestAutomaticRun(): Promise<DailyAutomationRun | null> {
    const status = await this.readStatus();
    return status?.lastAutomaticRun ?? null;
  }

  public refreshAttributedVideoExposure(videoId: string): Promise<void> {
    if (this.attributedVideoRefreshRunning) return this.attributedVideoRefreshRunning;
    if (this.running || this.initializationInFlight) {
      throw new Error("店铺日更或初始化正在运行，视频曝光回更延后到下一轮监测");
    }
    const promise = this.executeAttributedVideoExposureRefresh(videoId).finally(() => {
      if (this.attributedVideoRefreshRunning === promise) this.attributedVideoRefreshRunning = null;
    });
    this.attributedVideoRefreshRunning = promise;
    return promise;
  }

  public async start(): Promise<DailyAutomationStatus> {
    const runtimeSettings = await readTenantRuntimeSettings(this.tenantId);
    if (runtimeSettings) {
      this.config.enabled = runtimeSettings.dailyAutomation.enabled;
      this.config.localTime = runtimeSettings.dailyAutomation.localTime;
    }
    if (this.profile.templateMode) this.config.enabled = false;
    let initialization = await this.readInitializationStatus();
    if (initialization?.state === "running") {
      initialization = {
        ...initialization,
        state: "failed",
        completed: false,
        completedAt: null,
        lastAttemptAt: new Date().toISOString(),
        lastError: "上次任务在机器人重启前没有正常结束",
      };
      await this.writeInitializationStatus(initialization);
    }
    const needsInitialization = storeNeedsInitialization(
      Boolean(this.profile.templateMode),
      initialization,
    );
    if (initialization?.completed && initialization.windowStart) {
      this.config.integrationStartDate = earlierDate(
        this.config.integrationStartDate,
        initialization.windowStart,
      );
    }
    const nextRun = this.config.enabled
      ? nextAutomationRunAt(
          new Date(),
          this.config.localTime,
          this.profile.businessTimeZone,
          this.config.catchUpLocalTime,
        )
      : null;
    const prior = await this.readStatus();
    const status: DailyAutomationStatus = {
      version: 1,
      enabled: this.config.enabled,
      timeZone: this.profile.businessTimeZone,
      localTime: this.config.localTime,
      catchUpLocalTime: this.config.catchUpLocalTime,
      integrationStartDate: this.config.integrationStartDate,
      reconciliationDays: this.config.reconciliationDays,
      nextRunAt: nextRun?.toISOString() ?? null,
      running: false,
      lastRun: prior?.lastRun ?? null,
      lastAutomaticRun: prior?.lastAutomaticRun
        ?? (isAutomaticTrigger(prior?.lastRun?.trigger) ? prior?.lastRun ?? null : null),
      updatedAt: new Date().toISOString(),
    };
    await this.writeStatus(status);
    if (needsInitialization) {
      console.log("[daily-automation] 店铺尚未初始化；等待群成员选择首次补齐范围");
    }
    if (!this.config.enabled) return status;
    this.scheduleNext();
    const missedPrimary = shouldRecoverPrimaryRun(new Date(), this.profile.businessTimeZone,
      this.config.localTime, this.config.catchUpLocalTime, status.lastAutomaticRun);
    if ((this.config.runOnStartup || missedPrimary) && !needsInitialization) {
      setTimeout(() => {
        void this.run(missedPrimary ? "scheduled" : "startup").catch((error) => {
          console.error(`[daily-automation] 启动补偿失败：${safeError(error)}`);
        });
      }, STARTUP_DELAY_MS);
    }
    return status;
  }

  public async run(trigger: DailyAutomationRun["trigger"]): Promise<DailyAutomationRun> {
    if (this.profile.templateMode) {
      throw new Error("这还是空白模板，先接入 TikTok 店铺，再开启自动更新。🙂");
    }
    if (this.attributedVideoRefreshRunning) await this.attributedVideoRefreshRunning;
    if (this.running) return this.running;
    this.running = this.execute(trigger).finally(() => { this.running = null; });
    return this.running;
  }

  public async initializeRecentDays(
    days = 7,
    force = false,
  ): Promise<StoreInitializationResult> {
    if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error("一次最多补齐31天，请使用1至31天的范围");
    if (this.profile.templateMode) throw new Error("这还是空白模板，请先接入 TikTok 店铺再初始化。");
    if (this.initializationInFlight) {
      if (this.initializationInFlight.days === days && this.initializationInFlight.force === force) {
        return this.initializationInFlight.promise;
      }
      throw new Error(`这家店正在补齐最近${this.initializationInFlight.days}天，请等当前任务结束后再换范围。`);
    }
    const promise = this.initializationQueue.run("store-initialization", () => (
      this.performRecentDaysInitialization(days, force)
    ));
    this.initializationInFlight = { days, force, promise };
    try {
      return await promise;
    } finally {
      if (this.initializationInFlight?.promise === promise) this.initializationInFlight = null;
    }
  }

  private async performRecentDaysInitialization(
    days: number,
    force: boolean,
  ): Promise<StoreInitializationResult> {
    const prior = await this.readInitializationStatus();
    if (!force && prior?.completed) {
      return { alreadyInitialized: true, status: prior, run: prior.lastRun };
    }
    if (this.running) {
      await this.running;
      const completedByPriorRun = await this.readInitializationStatus();
      if (!force && completedByPriorRun?.completed) {
        return { alreadyInitialized: true, status: completedByPriorRun, run: completedByPriorRun.lastRun };
      }
    }
    await this.writeInitializationStatus({
      version: 1,
      completed: false,
      windowStart: prior?.windowStart ?? null,
      windowEnd: prior?.windowEnd ?? null,
      completedAt: null,
      lastAttemptAt: new Date().toISOString(),
      lastRun: prior?.lastRun ?? null,
      state: "running",
      requestedDays: days,
      force,
      pendingProductIds: [],
      lastError: null,
      progress: {
        phase: "preparing",
        currentDate: null,
        completedDays: 0,
        totalDays: days,
        updatedAt: new Date().toISOString(),
      },
    });
    const originalStart = this.config.integrationStartDate;
    const originalDays = this.config.reconciliationDays;
    let completedWindowStart: string | null = null;
    this.config.integrationStartDate = "1970-01-01";
    this.config.reconciliationDays = days;
    const trigger: DailyAutomationRun["trigger"] = force ? "manual_backfill" : "manual_initialization";
    try {
      this.running = this.execute(trigger).finally(() => { this.running = null; });
      const run = await this.running;
      const pendingProducts = await this.productApprovals.listPending();
      const completed = initializationRunComplete(run);
      const status = initializationStatusFromRun(run, completed, {
        days,
        force,
        pendingProductIds: pendingProducts.map((item) => item.productId),
      });
      await this.writeInitializationStatus(status);
      if (completed && run.windowStart) {
        completedWindowStart = run.windowStart;
        this.config.integrationStartDate = earlierDate(originalStart, run.windowStart);
        await this.patchStatus({ integrationStartDate: this.config.integrationStartDate });
      }
      return { alreadyInitialized: false, status, run };
    } catch (error) {
      const current = await this.readInitializationStatus();
      const failed: StoreInitializationStatus = {
        version: 1,
        completed: false,
        windowStart: current?.windowStart ?? prior?.windowStart ?? null,
        windowEnd: current?.windowEnd ?? prior?.windowEnd ?? null,
        completedAt: null,
        lastAttemptAt: new Date().toISOString(),
        lastRun: current?.lastRun ?? prior?.lastRun ?? null,
        state: "failed",
        requestedDays: days,
        force,
        pendingProductIds: current?.pendingProductIds ?? [],
        lastError: safeError(error),
        progress: current?.progress ?? null,
      };
      await this.writeInitializationStatus(failed);
      throw error;
    } finally {
      this.config.integrationStartDate = completedWindowStart
        ? earlierDate(originalStart, completedWindowStart)
        : originalStart;
      this.config.reconciliationDays = originalDays;
    }
  }

  public async initializationStatus(): Promise<StoreInitializationStatus | null> {
    return this.readInitializationStatus();
  }

  public async resumeIncompleteInitialization(): Promise<StoreInitializationResult> {
    const status = await this.readInitializationStatus();
    if (!status) throw new Error("还没有可继续的补齐任务，请先选择最近7天、15天、30天或自定义天数。");
    if (status.completed) return { alreadyInitialized: true, status, run: status.lastRun };
    const pending = await this.productApprovals.listPending();
    if (pending.length > 0) {
      throw new Error(`还有${pending.length}个新商品没确认名称，先处理完“待确认商品”，我就会自动继续。`);
    }
    const days = requestedInitializationDays(status);
    if (!days) throw new Error("上次任务没有保存完整的日期范围，请重新选择补齐天数。");
    return this.initializeRecentDays(days, true);
  }

  public async statusText(focus: "automation" | "task" = "automation"): Promise<string> {
    const status = await this.readStatus();
    if (this.profile.templateMode) {
      return [
        "这份还是空白店铺模板，自动更新先替你关着。🙂",
        "接好 TikTok 店铺后，再设置每天几点更新就行。",
      ].join("\n");
    }
    if (!status) return "自动更新还没准备好，稍后再问我一次吧。";
    const initialization = await this.readInitializationStatus();
    const initializationText = describeInitializationStatus(initialization);
    if (initializationText) return initializationText;
    if (focus === "task" && initialization?.completed && initialization.lastRun) {
      const run = initialization.lastRun;
      const pending = summarizePendingItems([
        ...run.catalog.missingItems,
        ...run.online.missingItems,
        ...run.roi.missingItems,
      ]);
      return [
        "✅ 当前没有正在运行的补齐任务；上一轮已经完成。",
        "",
        initialization.requestedDays ? `📅 批次：最近 ${initialization.requestedDays} 个完整日` : null,
        run.windowStart && run.windowEnd ? `范围：${run.windowStart} 至 ${run.windowEnd}` : null,
        `🎬 上线表：核对 ${run.online.matched} 条，新增 ${run.online.created}，更新 ${run.online.updated}`,
        `📊 投产比：核对 ${run.roi.matched} 条，新增 ${run.roi.created}，更新 ${run.roi.updated}`,
        "",
        pending.manualFields.length > 0 ? `✍️ 仍需人工补录：${pending.manualFields.join("、")}` : null,
        pending.warningDates.length > 0 ? `⚠️ 接口归属差异日期：${pending.warningDates.join("、")}` : null,
        "🎯 总结：自动数据已补齐，当前不是30/30卡住状态。",
      ].filter((line): line is string => line !== null).join("\n");
    }
    const last = status.lastAutomaticRun ?? status.lastRun;
    const lines: Array<string | null> = [
      status.enabled
        ? status.catchUpLocalTime
          ? this.profile.dailyAutomation?.reportLocalTime
            ? `⏰ ${this.profile.businessDisplayName} 每天 ${status.localTime} 预处理数据，${this.profile.dailyAutomation.reportLocalTime} 准点发报告，${status.catchUpLocalTime} 静默补跑。`
            : `⏰ ${this.profile.businessDisplayName} 每天 ${status.localTime} 先更新，${status.catchUpLocalTime} 再补跑一次。`
          : `⏰ ${this.profile.businessDisplayName} 的自动更新开着呢，每天 ${status.localTime} 跑一次。`
        : `⏸️ ${this.profile.businessDisplayName} 的自动更新现在暂停着。`,
      status.running
        ? "我正在更新数据，跑完就会记好结果。"
        : status.enabled
          ? `下一次：${friendlyScheduleTime(status.nextRunAt, status.timeZone)}。`
          : "需要时发“开启自动同步”就能继续。",
    ];
    if (!last) {
      lines.push("目前还没有执行记录。第一次跑完后，我会在这里告诉你结果。");
      return lines.filter(Boolean).join("\n");
    }
    lines.push(
      last.ok
        ? `上次同步时，TikTok 接口共同完整到 ${friendlyDate(last.latestCompleteDate)}。`
        : "上次没有全部更新成功，我没有拿不准的数据硬写进表里。",
    );
    if (last.orderAttributionTargetDate) {
      lines.push(`订单明细已独立尝试核对到店铺前一日 ${friendlyDate(last.orderAttributionTargetDate)}。`);
    }
    const onlineChanged = last.online.created + last.online.updated;
    const roiChanged = last.roi.created + last.roi.updated;
    if (onlineChanged === 0 && roiChanged === 0 && last.catalog.created === 0) {
      lines.push("这次没有发现需要新增或修改的数据。很安静，挺好。🙂");
    } else {
      lines.push([
        last.catalog.created > 0 ? `商品选项补了 ${last.catalog.created} 个` : null,
        onlineChanged > 0 ? `上线表新增 ${last.online.created} 条、更新 ${last.online.updated} 条` : null,
        roiChanged > 0 ? `投产比新增 ${last.roi.created} 条、更新 ${last.roi.updated} 条` : null,
      ].filter(Boolean).join("；") + "。");
    }
    const pending = summarizePendingItems([
      ...(last.catalog.missingItems ?? []),
      ...(last.online.missingItems ?? []),
      ...(last.roi.missingItems ?? []),
    ]);
    const pendingParts = [
      pending.manualFields.length > 0 ? `${pending.manualFields.length} 类人工字段` : null,
      pending.warningDates.length > 0 ? `${pending.warningDates.length} 个接口归因日期` : null,
      pending.otherItems.length > 0 ? `${pending.otherItems.length} 项其他提醒` : null,
    ].filter(Boolean);
    if (pendingParts.length > 0) lines.push(`另外有${pendingParts.join("、")}需要留意。发“待确认事项”就能看明白。`);
    const errors = [last.catalog.error, last.online.error, last.roi.error].filter(Boolean);
    if (errors.length > 0) lines.push(`有 ${errors.length} 处没跑通，发“待确认事项”我再说清楚。`);
    return lines.filter(Boolean).join("\n");
  }

  /** Report the scheduled sync itself, never the old initialization/backfill batch. */
  public async automaticSyncResultText(): Promise<string> {
    if (this.profile.templateMode) return "这家店还没有接入 TikTok，暂时没有自动同步记录。";
    const status = await this.readStatus();
    if (!status) return "我还没有读到自动同步状态，暂时不能可靠回答。";
    if (status.running) {
      return [
        "⏳ 这一轮自动同步正在执行。",
        "完成后我会保存本轮结果；现在先不拿上一轮或历史补齐任务冒充。",
      ].join("\n");
    }
    const run = status.lastAutomaticRun
      ?? (isAutomaticTrigger(status.lastRun?.trigger) ? status.lastRun : null);
    if (!run) return "目前还没有定时自动同步的完成记录。历史补齐记录不会算作自动同步。";
    const pending = summarizePendingItems([
      ...(run.catalog.missingItems ?? []),
      ...(run.online.missingItems ?? []),
      ...(run.onlineClicks?.missingItems ?? []),
      ...(run.roi.missingItems ?? []),
    ]);
    const completed = new Date(run.completedAt).toLocaleString("zh-CN", {
      timeZone: this.profile.businessTimeZone,
      hour12: false,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    return [
      run.ok ? `✅ 上次自动同步成功（${completed} 完成）` : `⚠️ 上次自动同步没有全部跑通（${completed} 结束）`,
      "",
      `📅 数据最新完整到：${friendlyDate(run.latestCompleteDate)}`,
      run.orderAttributionTargetDate ? `🧾 订单明细尝试到：${friendlyDate(run.orderAttributionTargetDate)}（店铺前一日）` : null,
      run.windowStart && run.windowEnd ? `🔄 本轮核对：${run.windowStart} 至 ${run.windowEnd}` : null,
      "",
      `🛍️ 商品目录：新增 ${run.catalog.created}，复核 ${run.catalog.matched}`,
      `🎬 上线表：新增 ${run.online.created}，更新 ${run.online.updated}，复核 ${run.online.matched}`,
      run.onlineClicks
        ? (run.onlineClicks.ok
          ? `🛒 商品点击量：更新 ${run.onlineClicks.updated}，复核 ${run.onlineClicks.matched}（数据截至 ${friendlyDate(run.onlineClicks.sourceDate ?? null)}）`
          : `⚠️ 商品点击量未更新：${run.onlineClicks.error ?? "未取得完整数据"}`)
        : null,
      `📊 投产比：新增 ${run.roi.created}，更新 ${run.roi.updated}，复核 ${run.roi.matched}`,
      "",
      pending.manualFields.length > 0 ? `✍️ 仍需人工补录：${pending.manualFields.join("、")}` : null,
      pending.warningDates.length > 0 ? `⚠️ 接口归属提醒：${pending.warningDates.join("、")}` : null,
      run.ok ? "🎯 总结：这是定时自动同步的结果，不是之前30天补齐任务的状态。" : "发送“待确认事项”可以看本轮具体失败原因。",
    ].filter((line): line is string => line !== null).join("\n");
  }

  public async scheduleExpectationText(): Promise<string> {
    if (this.profile.templateMode) {
      return "这还是空白店铺模板，接好 TikTok 店铺后我才能判断更新时间和可写日期。";
    }
    const status = await this.readStatus();
    if (!status) return "自动更新状态还没准备好，我现在无法可靠判断时间。";
    if (!status.enabled) {
      return [
        "⏸️ 自动更新目前是暂停的。",
        "",
        `📅 上次同步时，TikTok 接口共同完整到 ${friendlyDate((status.lastAutomaticRun ?? status.lastRun)?.latestCompleteDate ?? null)}。`,
        "需要继续时，发“开启自动同步”即可。",
      ].join("\n");
    }
    const latest = (status.lastAutomaticRun ?? status.lastRun)?.latestCompleteDate ?? null;
    const nextCandidate = latest ? shiftIsoDate(latest, 1) : null;
    const countdown = friendlyScheduleCountdown(status.nextRunAt);
    return [
      status.running
        ? "⏳ 今天这轮更新已经在执行。"
        : `⏰ 下一次自动更新：${friendlyScheduleTime(status.nextRunAt, status.timeZone)}（北京时间）${countdown ? `，${countdown}` : ""}。`,
      "",
      `📅 上次同步时，三个必需接口共同完整到：${friendlyDate(latest)}。`,
      nextCandidate
        ? `这轮会先检查 ${friendlyDate(nextCandidate)}，再继续写到 TikTok 当时共同确认的最新完整日。`
        : "这轮会先现场读取 TikTok 的最新完整日，再决定写入范围。",
      "",
      "🎯 当天或尚未完整的数据不会抢跑写入，所以最终写到几号要以执行时的接口返回为准，我不会提前编一个日期。",
    ].join("\n");
  }

  public async pendingItemsText(): Promise<string> {
    if (this.profile.templateMode) return "现在还是空白模板，先接入 TikTok 店铺，就没有待确认数据啦。";
    const last = (await this.readStatus())?.lastRun;
    if (!last) return "目前还没有执行记录，也就没有待确认事项。";
    const rawPending = [...last.catalog.missingItems, ...last.online.missingItems, ...last.roi.missingItems];
    const pending = rawPending.map(friendlyPendingItem).filter(Boolean);
    const errors = [last.catalog.error, last.online.error, last.roi.error]
      .filter((item): item is string => Boolean(item))
      .map((item) => `更新遇到问题：${summarizeAutomationError(item)}`);
    const summary = summarizePendingItems(rawPending);
    const other = [...new Set([...summary.otherItems, ...errors])];
    if (summary.manualFields.length === 0 && summary.warningDates.length === 0 && other.length === 0) {
      return "✅ 没有待确认事项，目前能自动处理的数据都已完成。";
    }
    return [
      "📌 这些不是同一种“漏填”，要分开看：",
      "",
      summary.manualFields.length > 0 ? `✍️ 人工补录（不是同步失败）：${summary.manualFields.join("、")}` : null,
      summary.warningDates.length > 0
        ? `🔎 接口归因提醒（自动数据已写入）：${summary.warningDates.join("、")}，共 ${summary.warningDates.length} 天。店铺层能确认有出单视频，但 TikTok 没把成交件数归到具体商品；机器人保留店铺总数，不乱分给商品。`
        : null,
      ...other.slice(0, 4).map((item) => `🔎 ${item}`),
      "",
      "🎯 总结：能自动确认的数据已经写入；人工字段由同事补，接口归因差异只是核对提醒，不代表整次补齐失败。",
    ].filter((line): line is string => line !== null).join("\n");
  }

  public async pendingProductApprovals(): Promise<PendingProductApproval[]> {
    return this.productApprovals.listPending();
  }

  public async confirmProductName(
    productId: string,
    name: string,
    updatedBy: string,
  ): Promise<ProductConfirmationWorkflowResult> {
    return this.productConfirmationQueue.run(`product-confirmation:${productId}`, async () => {
      const result = await this.productApprovals.confirm(productId, name, updatedBy);
      await this.gateway.ensureBusinessProductOptions([result.canonicalName]);
      const pending = await this.productApprovals.listPending();
      const initialization = await this.readInitializationStatus();
      const initializationDays = requestedInitializationDays(initialization);
      const partOfInitialization = Boolean(
        initialization
        && !initialization.completed
        && initializationDays
        && initialization.state !== "running",
      );
      const shouldResumeInitialization = Boolean(
        partOfInitialization
        && !result.alreadyConfirmed
        && pending.length === 0,
      );
      if (partOfInitialization && initialization) {
        await this.writeInitializationStatus({
          ...initialization,
          state: pending.length === 0 ? "ready_to_resume" : "waiting_product_confirmation",
          pendingProductIds: pending.map((item) => item.productId),
          lastAttemptAt: new Date().toISOString(),
        });
      }
      return {
        ...result,
        remainingPending: pending.length,
        shouldResumeInitialization,
        initializationDays: partOfInitialization ? initializationDays : null,
      };
    });
  }

  public async updateSchedule(
    patch: { enabled?: boolean; localTime?: string },
    updatedBy: string,
  ): Promise<DailyAutomationStatus> {
    if (this.profile.templateMode && patch.enabled !== false) {
      throw new Error("这还是空白模板，先接入 TikTok 店铺，再开启自动更新。🙂");
    }
    const localTime = patch.localTime ?? this.config.localTime;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) {
      throw new Error("时间格式应为 HH:mm，例如 10:00 或 14:30");
    }
    this.config.enabled = patch.enabled ?? this.config.enabled;
    this.config.localTime = localTime;
    await writeTenantRuntimeSettings(this.tenantId, {
      enabled: this.config.enabled,
      localTime: this.config.localTime,
      updatedBy,
    });
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const prior = await this.readStatus();
    const nextRun = this.config.enabled
      ? nextAutomationRunAt(
          new Date(),
          this.config.localTime,
          this.profile.businessTimeZone,
          this.config.catchUpLocalTime,
        )
      : null;
    const status: DailyAutomationStatus = {
      version: 1,
      enabled: this.config.enabled,
      timeZone: this.profile.businessTimeZone,
      localTime: this.config.localTime,
      catchUpLocalTime: this.config.catchUpLocalTime,
      integrationStartDate: this.config.integrationStartDate,
      reconciliationDays: this.config.reconciliationDays,
      nextRunAt: nextRun?.toISOString() ?? null,
      running: Boolean(this.running),
      lastRun: prior?.lastRun ?? null,
      updatedAt: new Date().toISOString(),
    };
    await this.writeStatus(status);
    if (this.config.enabled) this.scheduleNext();
    return status;
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.config.enabled) return;
    const next = nextAutomationRunAt(
      new Date(),
      this.config.localTime,
      this.profile.businessTimeZone,
      this.config.catchUpLocalTime,
    );
    const delay = Math.max(1_000, next.getTime() - Date.now());
    this.timer = setTimeout(() => {
      void this.run("scheduled").catch((error) => {
        console.error(`[daily-automation] 定时同步失败：${safeError(error)}`);
      }).finally(() => this.scheduleNext());
    }, delay);
    void this.patchStatus({ nextRunAt: next.toISOString() });
  }

  private async execute(trigger: DailyAutomationRun["trigger"]): Promise<DailyAutomationRun> {
    const startedAt = new Date().toISOString();
    await this.patchStatus({ running: true });
    await this.markInitializationProgress("preparing", null, 0, this.config.reconciliationDays);
    const empty = emptyPhase();
    let latestCompleteDate: string | null = null;
    let orderAttributionTargetDate: string | null = null;
    let windowStart: string | null = null;
    let catalog = { ...empty };
    let online = { ...empty };
    let roi = { ...empty };
    let accountSide: DailyPhaseResult | undefined;
    let onlineClicks: DailyPhaseResult | undefined;
    let clickLatestCompleteDate: string | null = null;
    this.pendingClickCandidates = [];
    try {
      const contracts = await discoverAutomationContracts(
        new Date(),
        this.profile.businessTimeZone,
        this.config.probeDays,
        tikTokRuntimeFromProfile(this.profile),
      );
      if (contracts.product.ok && /^\d{4}-\d{2}-\d{2}$/.test(contracts.product.latest_available_date ?? "")) {
        clickLatestCompleteDate = contracts.product.latest_available_date!;
      }
      await this.markInitializationProgress("catalog", null, 0, this.config.reconciliationDays);
      try {
        const inventory = await fetchTikTokProductCatalog(
          180_000,
          tikTokRuntimeFromProfile(this.profile),
        );
        const observedDate = contracts.product.latest_available_date
          ?? shiftIsoDate(contracts.today, -1);
        const enrollment = await this.productApprovals.autoEnrollCatalog(
          inventory.rows,
          observedDate,
        );
        const productDetails = await discoverProductDetailContract(
          contracts.product,
          this.profile,
          tikTokRuntimeFromProfile(this.profile),
        );
        const result = await syncProductCatalog({
          contract: contracts.product,
          titleContract: productDetails,
          profile: this.profile,
          gateway: this.gateway,
        });
        const approvals = await this.productApprovals.stage(result.unmappedProducts, observedDate);
        const enrolled = [...enrollment.autoConfirmed, ...approvals.autoConfirmed];
        const autoOptions = enrolled.length > 0
          ? await this.gateway.ensureBusinessProductOptions(
              enrolled.map((item) => item.canonicalName),
            )
          : { cooperationOptionsAdded: 0, onlineOptionsAdded: 0 };
        catalog = {
          ...emptyPhase(),
          matched: result.canonicalNames.length + enrolled.length,
          created: result.cooperationOptionsAdded + result.onlineOptionsAdded
            + autoOptions.cooperationOptionsAdded + autoOptions.onlineOptionsAdded,
          unchanged: Math.max(0, result.canonicalNames.length * 2 - result.cooperationOptionsAdded - result.onlineOptionsAdded),
          missingItems: approvals.pending.map((item) => (
            `待确认商品名称：${item.sourceTitle}${item.suggestedName ? `；建议 ${item.suggestedName}` : ""}（TikTok商品ID ${item.productId}）`
          )),
        };
      } catch (error) {
        catalog = { ...emptyPhase(), ok: false, error: safeError(error) };
      }

      latestCompleteDate = resolveAutomationPlanningDate(contracts, contracts.today);
      const pendingProductCount = catalog.missingItems.filter((item) => item.includes("待确认商品名称")).length;
      if (pendingProductCount > 0) {
        const waiting = `等待确认 ${pendingProductCount} 个新商品名称；确认完成后继续原范围`;
        online = { ...emptyPhase(), missingItems: [waiting] };
        roi = { ...emptyPhase(), missingItems: [waiting] };
      } else if (latestCompleteDate < this.config.integrationStartDate) {
        const waiting = `TikTok接口最新完整日 ${latestCompleteDate} 尚未到自动写入起点 ${this.config.integrationStartDate}，本次只同步商品目录`;
        online = { ...emptyPhase(), missingItems: [waiting] };
        roi = { ...emptyPhase(), missingItems: [waiting] };
      } else {
        windowStart = laterDate(
          earlierDate(
            reconciliationWindow(latestCompleteDate, this.config.reconciliationDays).startDate,
            await this.productApprovals.requiredBackfillStartDate()
              ?? reconciliationWindow(latestCompleteDate, this.config.reconciliationDays).startDate,
          ),
          this.config.integrationStartDate,
        );
        try {
          online = await this.syncOnline(windowStart, latestCompleteDate);
        } catch (error) {
          online = { ...emptyPhase(), ok: false, error: safeError(error) };
        }
        if (this.profile.tiktok.roiDateBasis === "business") {
          roi = {
            ...emptyPhase(),
            missingItems: ["投产比使用北京时间自然日；已禁止把美国店铺日Analytics写入同名日期行"],
          };
        } else {
          try {
            roi = await this.syncRoi(windowStart, latestCompleteDate);
          } catch (error) {
            roi = { ...emptyPhase(), ok: false, error: safeError(error) };
          }
        }
        if (online.ok && roi.ok) {
          await this.productApprovals.markBackfillCompletedThrough(latestCompleteDate);
        }
      }
    } catch (error) {
      const message = safeError(error);
      if (catalog.ok && catalog.matched === 0) catalog = { ...emptyPhase(), ok: false, error: message };
      online = { ...emptyPhase(), ok: false, error: message };
      roi = { ...emptyPhase(), ok: false, error: message };
    }
    // The Order API is a separate source and must not inherit the 2–3 day lag
    // of Analytics. The current 投产比 date label owns the registered US shop
    // calendar, so the previous complete shop day is the write target.
    if (this.profile.tiktok.orderAttribution?.enabled) {
      console.log(`[daily-phase:${this.tenantId}] ${JSON.stringify({ phase: "order_attribution", at: new Date().toISOString() })}`);
      const attributionWindow = orderAttributionWindow(
        new Date(),
        this.profile.tiktok.shopTimeZone,
        this.profile.tiktok.orderAttribution.reconciliationDays ?? 3,
        this.config.integrationStartDate,
      );
      orderAttributionTargetDate = attributionWindow.endDate;
      if (attributionWindow.startDate <= attributionWindow.endDate) {
        try {
          const reportDate = dateKeyInTimeZone(new Date(), this.profile.businessTimeZone);
          const skeletonDates = [reportDate];
          for (
            let date = attributionWindow.startDate;
            date <= reportDate;
            date = shiftIsoDate(date, 1)
          ) skeletonDates.push(date);
          const currentMap = await loadProductCatalogMap(this.profile);
          const skeletonProducts = this.profile.tiktok.autoEnrollNewProducts
            ? [...new Set(Object.values(currentMap.products))]
            : this.profile.tiktok.includedCanonicalProducts ?? [];
          const skeleton = await this.gateway.ensureRoiDateSkeleton(
            skeletonDates,
            skeletonProducts,
          );
          roi.created += skeleton.created;
          roi.updated += skeleton.updated;
          roi.unchanged += skeleton.unchanged;
          addSummary(roi, await this.syncOrderAttribution(attributionWindow.startDate, attributionWindow.endDate));
        } catch (error) {
          const attributionError = safeError(error);
          roi = {
            ...roi,
            ok: false,
            error: [roi.error, attributionError].filter(Boolean).join("；") || attributionError,
          };
        }
      }
    }
    if (this.profile.accountSideAutomation?.enabled) {
      console.log(`[daily-phase:${this.tenantId}] ${JSON.stringify({ phase: "account_side", at: new Date().toISOString() })}`);
      try {
        const plan = await prepareLatestAccountSidePlan({
          profile: this.profile,
          days: this.profile.accountSideAutomation.reconciliationDays,
        });
        const result = await syncAccountSidePlanWithClient(
          this.accountSideClient,
          this.accountSideBase,
          plan,
          { preserveAccountManualFields: true },
        );
        accountSide = accountSidePhaseFromSync(result, plan.warnings);
      } catch (error) {
        accountSide = { ...emptyPhase(), ok: false, error: safeError(error) };
      }
    }
    const run: DailyAutomationRun = {
      runId: `daily-${startedAt.replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
      trigger,
      startedAt,
      completedAt: new Date().toISOString(),
      latestCompleteDate,
      orderAttributionTargetDate,
      windowStart,
      windowEnd: latestCompleteDate,
      catalog,
      online,
      roi,
      ...(accountSide ? { accountSide } : {}),
      ...(onlineClicks ? { onlineClicks } : {}),
      ok: catalog.ok && online.ok && roi.ok && (accountSide?.ok ?? true) && (onlineClicks?.ok ?? true),
    };
    // Report-critical phases are ready. Click enrichment does not contribute
    // any report metric and must not delay preparation/delivery of these cards.
    if (trigger === "scheduled" && this.onRunCompleted) {
      try {
        await this.onRunCompleted(run);
      } catch (error) {
        // 报告预处理是同步后的旁路任务。失败不得篡改已经完成并写后验证的
        // 数据同步结果；报告服务会保留待准备状态并在发送时刻前后重试。
        console.error(`[prepared-group-report:${this.tenantId}] 预处理失败：${safeError(error)}`);
      }
    }
    onlineClicks = await this.refreshOnlineProductClicks(clickLatestCompleteDate, startedAt, !online.ok);
    if (onlineClicks) run.onlineClicks = onlineClicks;
    run.ok = run.ok && (onlineClicks?.ok ?? true);
    run.completedAt = new Date().toISOString();
    await this.patchStatus({
      running: false,
      lastRun: run,
      ...(isAutomaticTrigger(trigger) ? { lastAutomaticRun: run } : {}),
    });
    console.log(`[daily-automation] ${JSON.stringify(run)}`);
    return run;
  }

  private async refreshOnlineProductClicks(latestDate: string | null, startedAt: string, refreshMetrics: boolean): Promise<DailyPhaseResult | undefined> {
    if (!["storetwo-formal", "storeone-formal", "storetwo-botanical-care-formal", "storethree-formal", "storetwo-llc-formal"].includes(this.tenantId)) return undefined;
    console.log(`[daily-phase:${this.tenantId}] ${JSON.stringify({ phase: "online_product_clicks", at: new Date().toISOString() })}`);
    try {
      if (!latestDate) throw new Error("商品分析未提供最新完整美国店铺日，商品点击量不猜日期");
      await this.gateway.initializeOnlineReadOnly();
      const recent = await listRecentOnlineProductClickCandidates({
        latestCompleteShopDate: latestDate, probeDays: this.config.probeDays,
        profile: this.profile, env: this.appEnv, client: this.accountSideClient,
      });
      const result = await syncOnlineVideoProductClicks({
        candidates: [...recent, ...this.pendingClickCandidates], profile: this.profile,
        env: this.appEnv, client: this.accountSideClient, gateway: this.gateway,
        refreshMetrics,
      });
      const phase = { ...emptyPhase(), sourceDate: latestDate,
        matched: result.queried, updated: result.updated, unchanged: result.unchanged,
        skipped: result.skippedTooOld + result.skippedMissing,
        missingItems: [
          ...(refreshMetrics ? ["视频列表失败：已对现有近14天视频复用详情刷新曝光、成交和点击量；新增视频发现仍未完成"] : []),
          ...(result.skippedTooOld ? [`${result.skippedTooOld}条视频超过180天详情查询范围，商品点击量保留原值`] : []),
          ...(result.skippedMissing ? [`${result.skippedMissing}条视频不在正式上线表，商品点击量未写入`] : []),
        ],
      };
      await mkdir(this.statusRoot, { recursive: true });
      await writeFile(path.join(this.statusRoot, `product-clicks-${latestDate}-${startedAt.replace(/[:.]/g, "-")}.json`),
        JSON.stringify({ tenantId: this.tenantId, sourceDate: latestDate, startedAt, refreshMetrics,
          completedAt: new Date().toISOString(), ...result }, null, 2));
      console.log(`[daily-product-clicks:${this.tenantId}] ${JSON.stringify(phase)}`);
      return phase;
    } catch (error) {
      return { ...emptyPhase(), ok: false, error: safeError(error) };
    }
  }

  private async syncOnline(startDate: string, endDate: string): Promise<DailyPhaseResult> {
    const total = emptyPhase();
    const clickCandidates: VideoClickCandidate[] = [];
    const executePlan = async (plan: OnlineImportPlan): Promise<void> => {
      total.matched += plan.videos.length;
      total.skipped += plan.skipped;
      total.conflicts += plan.conflicts.length;
      total.missingItems.push(
        ...plan.missingItems,
        ...plan.conflicts.map((item) => `${item.key}：${item.reason}`),
      );
      for (const chunk of chunkOnlinePlan(plan, 50)) {
        addSummary(total, await executeOnlineImportPlan(chunk, this.gateway));
      }
      clickCandidates.push(...plan.videos.map(({ video }) => ({
        video: { id: video.id, date: video.date }, endExclusive: plan.metricWindowEndExclusive,
      })));
    };
    const discovery = onlineDiscoveryWindow(
      startDate,
      endDate,
      this.config.probeDays,
      this.profile.tiktok.shopTimeZone,
      this.profile.businessTimeZone,
    );
    await this.markInitializationProgress("online", discovery.endDateInclusive, 0, 1);
    const plan = await prepareOnlineImportPlan({
      jobId: realtimeJobId(),
      intent: {
        action: "import_online_videos",
        target: "online",
        startDate: discovery.startDate,
        endDateInclusive: discovery.endDateInclusive,
      },
      gateway: this.gateway,
      metricEndDateInclusive: endDate,
      profile: this.profile,
    });
    await executePlan(plan);

    const olderSold = await prepareOlderSoldVideoRefreshPlan({
      jobId: realtimeJobId(),
      latestCompleteShopDate: endDate,
      recentPublishStartDate: discovery.startDate,
      gateway: this.gateway,
      profile: this.profile,
    });
    total.skipped += olderSold.outsideCumulativeWindow;
    if (olderSold.outsideCumulativeWindow > 0 && !olderSold.plan) {
      total.missingItems.push(
        `${olderSold.outsideCumulativeWindow}条老视频超过安全累计查询范围，未覆盖现值`,
      );
    }
    if (olderSold.plan) {
      await executePlan(olderSold.plan);
    }
    this.pendingClickCandidates = clickCandidates;
    total.missingItems = [...new Set(total.missingItems)];
    return total;
  }

  private async executeAttributedVideoExposureRefresh(videoId: string): Promise<void> {
    const prepared = await prepareAttributedVideoExposureRefreshPlan({
      jobId: realtimeJobId(),
      videoId,
      gateway: this.gateway,
      profile: this.profile,
    });
    if (!prepared.plan) {
      console.warn(
        `[video-spike-refresh:${this.tenantId}] video=${videoId} skipped=${prepared.reason ?? "无安全写入计划"}`,
      );
      return;
    }
    const summary = await executeOnlineImportPlan(prepared.plan, this.gateway);
    if (["storetwo-formal", "storeone-formal", "storetwo-botanical-care-formal", "storethree-formal", "storetwo-llc-formal"].includes(this.tenantId)) {
      const clicks = await syncOnlineVideoProductClicks({
        candidates: prepared.plan.videos.map(({ video }) => ({
          video: { id: video.id, date: video.date }, endExclusive: prepared.plan!.metricWindowEndExclusive,
        })),
        profile: this.profile,
        env: this.appEnv,
        client: this.accountSideClient,
        gateway: this.gateway,
      });
      console.log(`[video-spike-product-clicks:${this.tenantId}] ${JSON.stringify({
        videoId, queried: clicks.queried, updated: clicks.updated, unchanged: clicks.unchanged,
      })}`);
    }
    console.log(`[video-spike-refresh:${this.tenantId}] ${JSON.stringify({
      videoId,
      latestAvailableDate: prepared.plan.latestAvailableDate,
      updated: summary.updated,
      unchanged: summary.unchanged,
      skipped: summary.skipped,
      conflicts: summary.conflicts,
    })}`);
  }

  private async syncRoi(startDate: string, endDate: string): Promise<DailyPhaseResult> {
    let plan = await prepareRoiBulkUpdatePlan({
      jobId: realtimeJobId(),
      startDate,
      endDateInclusive: endDate,
      rowFilter: "all",
      profile: this.profile,
      onProgress: ({ date, completedDays, totalDays }) => (
        this.markInitializationProgress("roi_collecting", date, completedDays, totalDays)
      ),
    });
    if (plan.unmappedPositiveProducts.length > 0) {
      const products = await resolveHistoricalApprovalProducts(
        plan,
        tikTokRuntimeFromProfile(this.profile),
      );
      const approvals = await this.productApprovals.stage(products, startDate);
      if (approvals.autoConfirmed.length > 0) {
        await this.gateway.ensureBusinessProductOptions(
          approvals.autoConfirmed.map((item) => item.canonicalName),
        );
        plan = await prepareRoiBulkUpdatePlan({
          jobId: realtimeJobId(),
          startDate,
          endDateInclusive: endDate,
          rowFilter: "all",
          profile: this.profile,
          onProgress: ({ date, completedDays, totalDays }) => (
            this.markInitializationProgress("roi_collecting", date, completedDays, totalDays)
          ),
        });
      }
    }
    if (plan.entries.length === 0) {
      return {
        ...emptyPhase(),
        skipped: plan.skippedRows,
        missingItems: [
          ...plan.missingItems,
          ...plan.unmappedPositiveProducts.map((item) => `有单但未映射商品：${item.name}(${item.id})`),
        ],
      };
    }
    return phaseFromSummary(await executeRoiBulkUpdatePlan(plan, this.gateway, async (stage) => {
      await this.markInitializationProgress(
        stage === "writing" ? "roi_writing" : "roi_verifying",
        null,
        plan.entries.length,
        plan.entries.length,
      );
    }));
  }

  private async syncOrderAttribution(startDate: string, endDate: string): Promise<RealtimeResultSummary> {
    const plan = await prepareOrderAttributionUpdatePlan({
      startDate,
      endDateInclusive: endDate,
      profile: this.profile,
    });
    return executeOrderAttributionUpdatePlan(plan, this.gateway);
  }

  private async patchStatus(
    patch: Partial<Pick<DailyAutomationStatus, "nextRunAt" | "running" | "lastRun" | "lastAutomaticRun" | "integrationStartDate">>,
  ): Promise<void> {
    const current = await this.readStatus();
    if (!current) return;
    await this.writeStatus({ ...current, ...patch, updatedAt: new Date().toISOString() });
  }

  private async readStatus(): Promise<DailyAutomationStatus | null> {
    try {
      return JSON.parse(await readFile(this.statusPath, "utf8")) as DailyAutomationStatus;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeStatus(status: DailyAutomationStatus): Promise<void> {
    await mkdir(this.statusRoot, { recursive: true });
    const temporary = `${this.statusPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.statusPath);
  }

  private async readInitializationStatus(): Promise<StoreInitializationStatus | null> {
    try {
      const value = JSON.parse(await readFile(this.initializationPath, "utf8")) as StoreInitializationStatus;
      return value?.version === 1 ? value : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeInitializationStatus(status: StoreInitializationStatus): Promise<void> {
    await mkdir(this.statusRoot, { recursive: true });
    const temporary = `${this.initializationPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.initializationPath);
  }

  private async markInitializationProgress(
    phase: StoreInitializationProgress["phase"],
    currentDate: string | null,
    completedDays: number,
    totalDays: number,
  ): Promise<void> {
    console.log(`[daily-phase:${this.tenantId}] ${JSON.stringify({ phase, currentDate, completedDays, totalDays, at: new Date().toISOString() })}`);
    const current = await this.readInitializationStatus();
    if (!current || current.state !== "running") return;
    const updatedAt = new Date().toISOString();
    await this.writeInitializationStatus({
      ...current,
      lastAttemptAt: updatedAt,
      progress: { phase, currentDate, completedDays, totalDays, updatedAt },
    });
  }
}

async function resolveHistoricalApprovalProducts(
  plan: Pick<RoiBulkUpdatePlan, "unmappedPositiveProducts">,
  runtime: TikTokRuntimeContext,
): Promise<UnmappedCatalogProduct[]> {
  const products = new Array<UnmappedCatalogProduct>(plan.unmappedPositiveProducts.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(3, Math.max(1, products.length)) },
    async () => {
      while (cursor < products.length) {
        const index = cursor++;
        const fallback = plan.unmappedPositiveProducts[index];
        let sourceTitle = fallback.name;
        try {
          const detail = await fetchTikTokProductDetail(fallback.id, 60_000, runtime);
          const row = detail.rows.find((value) => (
            String(value.id ?? value.product_id ?? "").trim() === fallback.id
          )) ?? detail.rows[0];
          sourceTitle = String(row?.title ?? row?.name ?? row?.product_name ?? sourceTitle).trim();
        } catch {
          // The analytics title is still safe for a human confirmation card when detail lookup fails.
        }
        products[index] = { id: fallback.id, sourceTitle };
      }
    },
  );
  await Promise.all(workers);
  return products;
}

export function resolveDailyAutomationConfig(profile: BusinessProfile): DailyAutomationConfig {
  return profile.dailyAutomation ?? {
    enabled: false,
    localTime: "10:00",
    integrationStartDate: "1970-01-01",
    reconciliationDays: 3,
    probeDays: 14,
    runOnStartup: false,
  };
}

export function nextDailyRunAt(now: Date, localTime: string, timeZone: string): Date {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) throw new Error(`每日执行时间无效：${localTime}`);
  const today = dateKeyInTimeZone(now, timeZone);
  let candidate = zonedWallTimeToInstant(`${today} ${localTime}:00`, timeZone);
  if (candidate.getTime() <= now.getTime()) {
    candidate = zonedWallTimeToInstant(`${shiftIsoDate(today, 1)} ${localTime}:00`, timeZone);
  }
  return candidate;
}

export function nextAutomationRunAt(
  now: Date,
  localTime: string,
  timeZone: string,
  catchUpLocalTime?: string,
): Date {
  const candidates = [localTime, catchUpLocalTime]
    .filter((value): value is string => Boolean(value))
    .map((value) => nextDailyRunAt(now, value, timeZone))
    .sort((left, right) => left.getTime() - right.getTime());
  if (candidates.length === 0) throw new Error("自动更新时间不能为空");
  return candidates[0];
}

export function reconciliationWindow(latestDate: string, days: number): { startDate: string; endDate: string } {
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error(`补偿天数无效：${days}；允许1至31天`);
  return { startDate: shiftIsoDate(latestDate, -(days - 1)), endDate: latestDate };
}

export function orderAttributionWindow(
  now: Date,
  businessTimeZone: string,
  days: number,
  integrationStartDate: string,
): { startDate: string; endDate: string } {
  const safeDays = Math.max(1, Math.min(7, Math.trunc(days)));
  const endDate = shiftIsoDate(dateKeyInTimeZone(now, businessTimeZone), -1);
  return {
    startDate: laterDate(shiftIsoDate(endDate, -(safeDays - 1)), integrationStartDate),
    endDate,
  };
}

/**
 * Video analytics can expose a creator video after its original publish day,
 * and a US shop day can end on the following Beijing calendar day. Re-scan a
 * bounded publish window on every run; video_id upserts keep this idempotent.
 */
export function onlineDiscoveryWindow(
  requestedStartDate: string,
  latestCompleteShopDate: string,
  probeDays: number,
  shopTimeZone: string,
  businessTimeZone: string,
): { startDate: string; endDateInclusive: string } {
  if (!Number.isInteger(probeDays) || probeDays < 1 || probeDays > 31) {
    throw new Error(`视频回看天数无效：${probeDays}`);
  }
  const rollingStart = shiftIsoDate(latestCompleteShopDate, -(probeDays - 1));
  const businessEnd = shopTimestampToBusinessDate(
    `${latestCompleteShopDate} 23:59:59`,
    shopTimeZone,
    businessTimeZone,
  );
  return {
    startDate: earlierDate(requestedStartDate, rollingStart),
    endDateInclusive: laterDate(latestCompleteShopDate, businessEnd),
  };
}

export function storeNeedsInitialization(
  templateMode: boolean,
  status: Pick<StoreInitializationStatus, "completed"> | null,
): boolean {
  return !templateMode && status?.completed !== true;
}

export function resolveLatestCompleteDate(contracts: TikTokMachineContract[], today: string): string {
  if (contracts.some((contract) => !contract.ok || contract.errors.length > 0)) {
    throw new Error(`TikTok自动同步数据集返回错误，本次不写入：${contracts
      .filter((contract) => !contract.ok || contract.errors.length)
      .map((contract) => `${contract.dataset}: ${contract.errors.join("；")}`).join("；")}`);
  }
  const dates: string[] = [];
  for (const contract of contracts) {
    const date = String(contract.latest_available_date ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      dates.push(date);
      continue;
    }
    // shop_performance_hourly is an aggregate endpoint and does not expose a
    // latest_available_date. It may only ride on the slower, explicit date
    // boundary from product/video datasets when its requested window is
    // covered and the endpoint returned a usable aggregate row.
    const coveredAggregate = contract.dataset === "shop_performance_hourly"
      && contract.row_count > 0
      && contract.window_end_exclusive >= today;
    if (coveredAggregate) continue;
    throw new Error("TikTok接口没有为全部自动同步数据集返回最新完整日期，本次不写入");
  }
  if (dates.length < 2) {
    throw new Error("TikTok接口缺少足够的日期完整性证据，本次不写入");
  }
  const latest = [...dates].sort()[0];
  if (latest >= today) return shiftIsoDate(today, -1);
  return latest;
}

/** This is only a planning boundary. Every phase still validates its own
 * complete source before writing; a failed list probe is not proof of 0 videos. */
export function resolveAutomationPlanningDate(
  contracts: { product: TikTokMachineContract; shop: TikTokMachineContract; video: TikTokMachineContract },
  today: string,
): string {
  if (contracts.video.ok && !contracts.video.errors.length) {
    return resolveLatestCompleteDate([contracts.product, contracts.shop, contracts.video], today);
  }
  const product = contracts.product;
  if (!product.ok || product.errors.length || product.pagination_truncated
    || !/^\d{4}-\d{2}-\d{2}$/.test(product.latest_available_date ?? "")) {
    throw new Error("商品接口也缺少完整日期，不能为失败的视频列表猜测目标日期");
  }
  return product.latest_available_date! < today ? product.latest_available_date! : shiftIsoDate(today, -1);
}

function failedAutomationProbe(dataset: string, start: string, end: string, error: unknown): TikTokMachineContract {
  return {
    ok: false, dataset, shop: null, window_start: start, window_end_exclusive: end,
    fetched_at: new Date().toISOString(), rows: [], row_count: 0, exact_duplicate_count: 0,
    conflicting_duplicate_ids: [], request_ids: [], raw_source_paths: [], normalized_source_path: null,
    required_scope: [], granted_scope: [], missing_capabilities: [], errors: [safeError(error)], latest_available_date: null,
  };
}

async function discoverAutomationContracts(
  now: Date,
  timeZone: string,
  probeDays: number,
  runtime: TikTokRuntimeContext = {},
): Promise<{
  today: string;
  product: TikTokMachineContract;
  shop: TikTokMachineContract;
  video: TikTokMachineContract;
}> {
  const today = dateKeyInTimeZone(now, timeZone);
  const start = shiftIsoDate(today, -probeDays);
  const [product, shop, video] = await Promise.all([
    fetchTikTokAnalytics("shop_product_performance", start, today, "", 180_000, runtime)
      .catch((error) => failedAutomationProbe("shop_product_performance", start, today, error)),
    fetchTikTokAnalytics("shop_performance_hourly", start, today, "", 180_000, runtime)
      .catch((error) => failedAutomationProbe("shop_performance_hourly", start, today, error)),
    fetchTikTokVideoDay(start, today, 180_000, runtime)
      .catch((error) => failedAutomationProbe("shop_video_performance", start, today, error)),
  ]);
  return { today, product, shop, video };
}

async function discoverProductDetailContract(
  performance: TikTokMachineContract,
  profile: BusinessProfile,
  runtime: TikTokRuntimeContext,
): Promise<TikTokMachineContract> {
  const productMap = await loadProductCatalogMap(profile);
  const ids = profile.tiktok.includedCanonicalProducts?.length
    ? []
    : [...new Set(performance.rows
    .map((row) => String(row.id ?? row.product_id ?? "").trim())
    .filter((id) => id && !productMap.products[id]))];
  const details = new Array<TikTokMachineContract>(ids.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, Math.max(1, ids.length)) }, async () => {
    while (cursor < ids.length) {
      const index = cursor++;
      details[index] = await fetchTikTokProductDetail(ids[index], 60_000, runtime);
    }
  });
  await Promise.all(workers);
  return {
    ok: true,
    dataset: "product_detail",
    shop: performance.shop,
    window_start: performance.window_start,
    window_end_exclusive: performance.window_end_exclusive,
    fetched_at: new Date().toISOString(),
    rows: details.flatMap((contract) => contract.rows),
    row_count: details.length,
    exact_duplicate_count: 0,
    conflicting_duplicate_ids: [],
    request_ids: [],
    raw_source_paths: details.flatMap((contract) => contract.raw_source_paths),
    normalized_source_path: null,
    required_scope: ["seller.product.basic"],
    granted_scope: [...new Set(details.flatMap((contract) => contract.granted_scope))],
    missing_capabilities: [],
    errors: [],
    latest_available_date: null,
  };
}

function laterDate(left: string, right: string): string {
  return left >= right ? left : right;
}

function earlierDate(left: string, right: string): string {
  return left <= right ? left : right;
}

function initializationRunComplete(run: DailyAutomationRun): boolean {
  const pendingProduct = run.catalog.missingItems.some((item) => item.includes("待确认商品名称"));
  const unmappedPositive = run.roi.missingItems.some((item) => item.includes("未映射商品"));
  return run.ok && !pendingProduct && !unmappedPositive && Boolean(run.windowStart && run.windowEnd);
}

function initializationStatusFromRun(
  run: DailyAutomationRun,
  completed: boolean,
  request: { days: number; force: boolean; pendingProductIds: string[] },
): StoreInitializationStatus {
  const lastError = [run.catalog.error, run.online.error, run.roi.error]
    .filter((item): item is string => Boolean(item))[0] ?? null;
  const state: NonNullable<StoreInitializationStatus["state"]> = completed
    ? "completed"
    : request.pendingProductIds.length > 0
      ? "waiting_product_confirmation"
      : "failed";
  return {
    version: 1,
    completed,
    windowStart: run.windowStart,
    windowEnd: run.windowEnd,
    completedAt: completed ? run.completedAt : null,
    lastAttemptAt: run.completedAt,
    lastRun: run,
    state,
    requestedDays: request.days,
    force: request.force,
    pendingProductIds: request.pendingProductIds,
    lastError,
    progress: null,
  };
}

function requestedInitializationDays(status: StoreInitializationStatus | null): number | null {
  if (!status) return null;
  if (Number.isInteger(status.requestedDays) && Number(status.requestedDays) >= 1 && Number(status.requestedDays) <= 31) {
    return Number(status.requestedDays);
  }
  const start = status.windowStart ?? status.lastRun?.windowStart;
  const end = status.windowEnd ?? status.lastRun?.windowEnd;
  if (!start || !end) return null;
  const days = enumerateIsoDates(start, end).length;
  return days >= 1 && days <= 31 ? days : null;
}

export function describeInitializationStatus(
  status: StoreInitializationStatus | null,
  now = new Date(),
): string | null {
  if (!status || status.completed || status.state === "completed") return null;
  const days = requestedInitializationDays(status);
  const range = status.lastRun?.windowStart && status.lastRun?.windowEnd
    ? `${status.lastRun.windowStart} 至 ${status.lastRun.windowEnd}`
    : null;
  if (status.state === "running") {
    const heartbeatAt = Date.parse(status.progress?.updatedAt ?? status.lastAttemptAt);
    const heartbeatStale = Number.isFinite(heartbeatAt) && now.getTime() - heartbeatAt > 5 * 60_000;
    if (heartbeatStale) {
      return [
        "⚠️ 这次补齐任务已经超过5分钟没有新进度。",
        "",
        "我不能确认它仍在正常工作，所以不会继续显示“运行中”。",
        `请发送“重新补齐最近${days ?? 30}天”发起一轮新任务；已有记录只复核，不会重复创建。`,
      ].join("\n");
    }
    const progress = describeInitializationProgress(status.progress);
    return [
      `⏳ 正在核对并补齐${days ? `最近${days}个完整日` : "店铺历史范围"}。`,
      "",
      progress,
      "已有记录只复核，不会重复创建。",
      "",
      "任务结束后我会主动回复结果。",
    ].join("\n");
  }
  if (status.state === "waiting_product_confirmation") {
    const remaining = status.pendingProductIds?.length ?? 0;
    return [
      `⏸️ 最近${days ?? "这批"}天的补齐任务正在等商品命名。`,
      `还有 ${remaining} 个新商品待确认；最后一个确认后会自动继续原任务。`,
      "发送“待确认商品”可以继续处理。",
    ].join("\n");
  }
  if (status.state === "ready_to_resume") {
    return [
      `商品已经全部确认，最近${days ?? "这批"}天的补齐任务正在准备续跑。`,
      "如果一分钟后仍没有结果，发送“继续补齐”即可接回同一任务。",
    ].join("\n");
  }
  if (status.state === "failed" || status.lastRun?.ok === false) {
    return [
      `⛔ 最近${days ?? "这批"}天的补齐任务已经停止，不是在后台继续运行。`,
      "",
      range ? `处理范围：${range}。` : null,
      status.lastError ? `原因：${summarizeAutomationError(status.lastError)}。` : "原因已记录，我没有继续写入拿不准的数据。",
      "",
      "发送“继续补齐”会按原范围重试；已有记录仍会原地复核。",
    ].filter((line): line is string => line !== null).join("\n");
  }
  return null;
}

function describeInitializationProgress(progress: StoreInitializationProgress | null | undefined): string {
  if (!progress) return "进度：正在准备接口数据。";
  if (progress.phase === "preparing") return "进度：正在读取 TikTok 完整数据范围。";
  if (progress.phase === "catalog") return "进度：正在核对商品目录。";
  if (progress.phase === "roi_writing") return "进度：接口数据已读取完成，正在写入投产比并刷新公式。";
  if (progress.phase === "roi_verifying") return "进度：写入已经完成，正在做最后的逐项回读校验。";
  const phase = progress.phase === "online" ? "红人上线表" : "投产比接口数据";
  const position = progress.totalDays > 0
    ? `${Math.min(progress.completedDays + 1, progress.totalDays)}/${progress.totalDays}`
    : "处理中";
  return `进度：正在处理${phase}（${position}${progress.currentDate ? `，${progress.currentDate}` : ""}）。`;
}

function chunkOnlinePlan(plan: OnlineImportPlan, size: number): OnlineImportPlan[] {
  const chunks: OnlineImportPlan[] = [];
  for (let index = 0; index < plan.videos.length; index += size) {
    chunks.push({ ...plan, jobId: realtimeJobId(), videos: plan.videos.slice(index, index + size) });
  }
  return chunks;
}

function realtimeJobId(): string {
  return `rt-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function enumerateIsoDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let value = startDate; value <= endDate; value = shiftIsoDate(value, 1)) dates.push(value);
  return dates;
}

function emptyPhase(): DailyPhaseResult {
  return { ok: true, matched: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, conflicts: 0, missingItems: [], error: null };
}

function phaseFromSummary(summary: RealtimeResultSummary): DailyPhaseResult {
  return {
    ok: true,
    matched: summary.matched,
    created: summary.created,
    updated: summary.updated,
    unchanged: summary.unchanged,
    skipped: summary.skipped,
    conflicts: summary.conflicts,
    missingItems: summary.missingItems,
    error: null,
  };
}

function accountSidePhaseFromSync(result: Record<string, unknown>, warnings: readonly string[]): DailyPhaseResult {
  const phase = emptyPhase();
  for (const sectionName of ["accounts", "videos", "product", "account"]) {
    const section = objectValue(result[sectionName]);
    phase.matched += safeCount(section.planned);
    phase.created += safeCount(section.created);
    phase.updated += safeCount(section.updated);
    phase.unchanged += safeCount(section.unchanged);
  }
  phase.missingItems.push(...warnings);
  return phase;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function addSummary(target: DailyPhaseResult, summary: RealtimeResultSummary): void {
  target.created += summary.created;
  target.updated += summary.updated;
  target.unchanged += summary.unchanged;
  target.skipped += summary.skipped;
  target.conflicts += summary.conflicts;
  target.missingItems.push(...summary.missingItems);
}

function formatInTimeZone(value: string | null, timeZone: string): string {
  if (!value) return "未安排";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function friendlyScheduleTime(value: string | null, timeZone: string): string {
  if (!value) return "暂时还没安排";
  const target = new Date(value);
  const today = dateKeyInTimeZone(new Date(), timeZone);
  const targetDay = dateKeyInTimeZone(target, timeZone);
  const day = targetDay === today ? "今天" : targetDay === shiftIsoDate(today, 1) ? "明天" : friendlyDate(targetDay);
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(target);
  return `${day} ${time}`;
}

function friendlyScheduleCountdown(value: string | null, now = new Date()): string | null {
  if (!value) return null;
  const milliseconds = new Date(value).getTime() - now.getTime();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  if (minutes < 60) return `还有约 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `还有约 ${hours} 小时` : `还有约 ${hours} 小时 ${remainder} 分钟`;
}

function friendlyDate(value: string | null): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "暂时未知";
  const [, month, day] = value.split("-");
  return `${Number(month)} 月 ${Number(day)} 日`;
}

function friendlyPendingItem(value: string): string {
  const text = stripTechnicalDetails(value);
  const product = text.match(/^待确认商品名称：(.+)$/);
  if (product) {
    if (/TikTok未返回商品标题/.test(product[1])) return "有个新商品还没拿到标题，暂时没法命名";
    return `新商品还没确认中文简称：${product[1].slice(0, 80)}${product[1].length > 80 ? "…" : ""}`;
  }
  return text;
}

export interface PendingItemsSummary {
  manualFields: string[];
  warningDates: string[];
  otherItems: string[];
}

export function summarizePendingItems(values: string[]): PendingItemsSummary {
  const manualFields = new Set<string>();
  const warningDates = new Set<string>();
  const otherItems = new Set<string>();
  for (const raw of values) {
    const value = friendlyPendingItem(raw);
    if (!value) continue;
    if (/广告(?:渠道)?花费|广告出单量/.test(value)) {
      manualFields.add("广告花费与广告出单");
      continue;
    }
    if (/退货量/.test(value)) {
      manualFields.add("退货量");
      continue;
    }
    if (/自孵化/.test(value)) {
      manualFields.add("自孵化出单与上线");
      continue;
    }
    if (/^(20\d{2}-\d{2}-\d{2}).*出单视频/.test(value)) {
      // Historical attribution discrepancies are internal diagnostics. They are
      // not user-actionable and must not keep resurfacing as pending work.
      continue;
    }
    otherItems.add(value);
  }
  return {
    manualFields: [...manualFields],
    warningDates: [...warningDates].sort(),
    otherItems: [...otherItems],
  };
}

function stripTechnicalDetails(value: string): string {
  return value
    .replace(/（?TikTok商品ID\s*\d+）?/gi, "")
    .replace(/\b\d{15,25}\b/g, "")
    .replace(/[A-Z]:\\[^；\n]+/gi, "本地数据文件")
    .replace(/\s+/g, " ")
    .trim();
}

export function summarizeAutomationError(value: string): string {
  const text = stripTechnicalDetails(value);
  if (!/写后验证失败|写后复核/.test(text)) return text.slice(0, 300);
  const separator = text.indexOf("：");
  const title = separator >= 0 ? text.slice(0, separator) : "写后复核没有通过";
  const details = (separator >= 0 ? text.slice(separator + 1) : text)
    .split("；")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 2);
  return `${title}，发现多项差异${details.length > 0 ? `。示例：${details.join("；")}` : ""}。详细清单已收起`;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}
