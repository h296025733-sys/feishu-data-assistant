import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BusinessProfile } from "../config/business-profile.js";
import { dateKeyInTimeZone } from "../realtime/business-time.js";
import type {
  ProductSpikeProductSnapshot,
  ProductSpikeSnapshot,
  ProductSpikeVideoSnapshot,
} from "./product-spike-snapshot.js";

export const PRODUCT_SPIKE_WINDOW_MINUTES = 30;
export const PRODUCT_SPIKE_QUIET_RESET_MINUTES = 60;
export const PRODUCT_SPIKE_MAX_TRUSTED_GAP_MINUTES = 15;
export const VIDEO_SPIKE_TRIGGER_ORDERS = 3;

export type ProductSpikeTier = 0 | 1 | 2 | 3 | 4;

export interface ProductSpikeAlertItem {
  productName: string;
  tier: Exclude<ProductSpikeTier, 0>;
  windowOrders: number;
  todayOrders: number;
  todayItems: number;
  todaySales: number | null;
  salesCurrency: string | null;
  episodeId: string;
}

interface ProductMonitorState {
  seenOrderKeys: Record<string, number | null>;
  activeTier: ProductSpikeTier;
  lastAboveThresholdAt: string | null;
  episodeId: string | null;
}

interface VideoMonitorState {
  seenOrderKeys: Record<string, number | null>;
  active: boolean;
  lastAboveThresholdAt: string | null;
  episodeId: string | null;
}

interface PendingAlert {
  id: string;
  businessDate: string;
  createdAt: string;
  items: ProductSpikeAlertItem[];
  deliveries: Record<string, { messageId: string; deliveredAt: string }>;
}

interface ProductSpikeMonitorState {
  version: 1;
  installedAt: string;
  businessDate: string;
  lastPollAt: string;
  videoAttributionAvailable: boolean;
  videoAttributionErrors: string[];
  products: Record<string, ProductMonitorState>;
  videos: Record<string, VideoMonitorState>;
  pendingAlert: PendingAlert | null;
  updatedAt: string;
}

export interface ProductSpikeMonitorRunResult {
  businessDate: string;
  initializedBaseline: boolean;
  trustedObservation: boolean;
  productAlertsDelivered: number;
  videoRefreshes: number;
  videoAttributionAvailable: boolean;
  sourcePath: string | null;
}

export class ProductSpikeMonitorService {
  private readonly statePath: string;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<ProductSpikeMonitorRunResult> | null = null;
  private started = false;

  public constructor(private readonly input: {
    tenantId: string;
    profile: BusinessProfile;
    pollMinutes?: number;
    groupChatIds: readonly string[] | (() => readonly string[]);
    loadSnapshot: (businessDate: string) => Promise<ProductSpikeSnapshot>;
    sendCard: (chatId: string, card: Record<string, unknown>, idempotencyKey: string) => Promise<string>;
    refreshVideoExposure?: (videoId: string) => Promise<void>;
    statePath?: string;
    now?: () => Date;
  }) {
    this.statePath = input.statePath
      ?? path.resolve(".runtime", "tenants", input.tenantId, "product-spike-monitor", "state.json");
  }

  public async start(): Promise<ProductSpikeMonitorRunResult> {
    if (this.started) {
      const state = await this.readState();
      return {
        businessDate: state?.businessDate ?? dateKeyInTimeZone(this.now(), this.input.profile.businessTimeZone),
        initializedBaseline: false,
        trustedObservation: false,
        productAlertsDelivered: 0,
        videoRefreshes: 0,
        videoAttributionAvailable: state?.videoAttributionAvailable ?? false,
        sourcePath: null,
      };
    }
    this.started = true;
    try {
      // Deployment/restart is deliberately silent. Existing same-day orders become
      // a baseline, and a fresh persisted state can alert on the next scheduled poll.
      return await this.runOnce({ allowActions: false });
    } finally {
      this.scheduleNext();
    }
  }

  public stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  public runOnce(options: { allowActions?: boolean } = {}): Promise<ProductSpikeMonitorRunResult> {
    if (this.running) return this.running;
    const promise = this.executeOnce(options.allowActions !== false).finally(() => {
      if (this.running === promise) this.running = null;
    });
    this.running = promise;
    return promise;
  }

  private async executeOnce(allowActions: boolean): Promise<ProductSpikeMonitorRunResult> {
    const now = this.now();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();
    const businessDate = dateKeyInTimeZone(now, this.input.profile.businessTimeZone);
    const snapshot = await this.input.loadSnapshot(businessDate);
    if (snapshot.businessDate !== businessDate) {
      throw new Error(`爆量监测快照日期${snapshot.businessDate}与当前业务日期${businessDate}不一致`);
    }
    const existing = await this.readState();
    const initializedBaseline = existing === null;
    const trustedObservation = isTrustedObservation(existing?.lastPollAt ?? null, nowMs);
    let state = existing
      ? { ...existing, businessDate, updatedAt: nowIso }
      : this.emptyState(businessDate, nowIso);

    state = mergeSnapshotIntoState(
      state,
      snapshot,
      nowMs,
      trustedObservation,
      initializedBaseline,
      nowIso,
    );
    await this.writeState(state);

    let productAlertsDelivered = 0;
    let videoRefreshes = 0;
    if (allowActions && state.pendingAlert) {
      state = await this.deliverPending(state);
      productAlertsDelivered += 1;
    }

    const productByName = new Map(snapshot.products.map((product) => [product.name, product]));
    const candidates: ProductSpikeAlertItem[] = [];
    for (const [productName, productState] of Object.entries(state.products)) {
      const product = productByName.get(productName);
      const currentKeys = new Set(product?.orderKeys ?? []);
      const windowOrders = countRecentCurrentKeys(
        productState.seenOrderKeys,
        currentKeys,
        nowMs,
        PRODUCT_SPIKE_WINDOW_MINUTES * 60_000,
      );
      const tier = productSpikeTier(windowOrders);
      if (tier === 0) {
        resetProductEpisodeAfterQuiet(productState, nowMs);
        continue;
      }
      productState.lastAboveThresholdAt = nowIso;
      if (!allowActions || tier <= productState.activeTier || !product) continue;
      const episodeId = productState.episodeId ?? stableEpisodeId(
        businessDate,
        productName,
        earliestRecentTimestamp(productState.seenOrderKeys, currentKeys, nowMs),
      );
      candidates.push({
        productName,
        tier,
        windowOrders,
        todayOrders: product.orders,
        todayItems: product.items,
        todaySales: product.sales,
        salesCurrency: product.salesCurrency,
        episodeId,
      });
    }

    if (allowActions && candidates.length > 0 && !state.pendingAlert) {
      state.pendingAlert = {
        id: pendingAlertId(this.input.tenantId, businessDate, candidates),
        businessDate,
        createdAt: nowIso,
        items: candidates.sort((left, right) => (
          right.tier - left.tier || right.windowOrders - left.windowOrders
          || left.productName.localeCompare(right.productName, "zh-CN")
        )),
        deliveries: {},
      };
      state.updatedAt = nowIso;
      await this.writeState(state);
      state = await this.deliverPending(state);
      productAlertsDelivered += 1;
    }

    const videoById = new Map(snapshot.videos.map((video) => [video.videoId, video]));
    for (const [videoId, videoState] of Object.entries(state.videos)) {
      const video = videoById.get(videoId);
      const currentKeys = new Set(video?.orderKeys ?? []);
      const windowOrders = countRecentCurrentKeys(
        videoState.seenOrderKeys,
        currentKeys,
        nowMs,
        PRODUCT_SPIKE_WINDOW_MINUTES * 60_000,
      );
      if (windowOrders < VIDEO_SPIKE_TRIGGER_ORDERS) {
        resetVideoEpisodeAfterQuiet(videoState, nowMs);
        continue;
      }
      videoState.lastAboveThresholdAt = nowIso;
      if (
        !allowActions
        || videoState.active
        || !video
        || !snapshot.videoAttributionAvailable
        || !this.input.refreshVideoExposure
      ) continue;
      await this.input.refreshVideoExposure(videoId);
      videoState.active = true;
      videoState.episodeId = videoState.episodeId ?? stableEpisodeId(
        businessDate,
        `video:${videoId}`,
        earliestRecentTimestamp(videoState.seenOrderKeys, currentKeys, nowMs),
      );
      videoRefreshes += 1;
    }
    state.updatedAt = nowIso;
    await this.writeState(state);
    return {
      businessDate,
      initializedBaseline,
      trustedObservation,
      productAlertsDelivered,
      videoRefreshes,
      videoAttributionAvailable: snapshot.videoAttributionAvailable,
      sourcePath: snapshot.sourcePath,
    };
  }

  private async deliverPending(state: ProductSpikeMonitorState): Promise<ProductSpikeMonitorState> {
    const pending = state.pendingAlert;
    if (!pending) return state;
    const groupChatIds = typeof this.input.groupChatIds === "function"
      ? this.input.groupChatIds()
      : this.input.groupChatIds;
    const uniqueGroups = [...new Set(groupChatIds.map((value) => value.trim()).filter(Boolean))];
    if (uniqueGroups.length === 0) {
      throw new Error(`${this.input.tenantId}没有绑定专属群，商品热度提醒拒绝回退到其他群`);
    }
    const card = buildProductSpikeCard({
      storeName: this.input.profile.businessDisplayName,
      businessDate: pending.businessDate,
      createdAt: new Date(pending.createdAt),
      timeZone: this.input.profile.businessTimeZone,
      items: pending.items,
    });
    for (const chatId of uniqueGroups) {
      if (pending.deliveries[chatId]) continue;
      const messageId = await this.input.sendCard(
        chatId,
        card,
        `product-spike:${this.input.tenantId}:${pending.id}:${chatId}`,
      );
      pending.deliveries[chatId] = { messageId, deliveredAt: this.now().toISOString() };
      state.updatedAt = this.now().toISOString();
      await this.writeState(state);
    }
    for (const item of pending.items) {
      const product = state.products[item.productName];
      if (!product) continue;
      product.activeTier = Math.max(product.activeTier, item.tier) as ProductSpikeTier;
      product.episodeId = item.episodeId;
    }
    state.pendingAlert = null;
    state.updatedAt = this.now().toISOString();
    await this.writeState(state);
    return state;
  }

  private scheduleNext(): void {
    if (!this.started) return;
    const minutes = this.input.pollMinutes ?? 5;
    const delay = Math.max(60_000, Math.round(minutes * 60_000));
    this.timer = setTimeout(() => {
      void this.runOnce().then((result) => {
        console.log(`[product-spike-monitor:${this.input.tenantId}] ${JSON.stringify(result)}`);
      }).catch((error) => {
        console.error(
          `[product-spike-monitor:${this.input.tenantId}] 轮询失败，将在下一轮重试：`
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }).finally(() => this.scheduleNext());
    }, delay);
    this.timer.unref();
  }

  private now(): Date {
    return this.input.now?.() ?? new Date();
  }

  private emptyState(
    businessDate: string,
    nowIso: string,
    installedAt = nowIso,
  ): ProductSpikeMonitorState {
    return {
      version: 1,
      installedAt,
      businessDate,
      lastPollAt: nowIso,
      videoAttributionAvailable: false,
      videoAttributionErrors: [],
      products: {},
      videos: {},
      pendingAlert: null,
      updatedAt: nowIso,
    };
  }

  private async readState(): Promise<ProductSpikeMonitorState | null> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as ProductSpikeMonitorState;
      return parsed?.version === 1 ? parsed : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeState(state: ProductSpikeMonitorState): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.statePath);
  }
}

export function productSpikeTier(orderCount: number): ProductSpikeTier {
  if (!Number.isSafeInteger(orderCount) || orderCount < 0) {
    throw new Error("近30分钟付款订单数必须是非负整数");
  }
  if (orderCount >= 24) return 4;
  if (orderCount >= 12) return 3;
  if (orderCount >= 6) return 2;
  if (orderCount >= 3) return 1;
  return 0;
}

export function buildProductSpikeCard(input: {
  storeName: string;
  businessDate: string;
  createdAt: Date;
  timeZone: string;
  items: readonly ProductSpikeAlertItem[];
}): Record<string, unknown> {
  if (input.items.length === 0) throw new Error("商品热度提醒至少需要一个商品");
  const maxTier = Math.max(...input.items.map((item) => item.tier)) as Exclude<ProductSpikeTier, 0>;
  const style = tierStyle(maxTier);
  const itemText = input.items.map((item) => {
    const current = tierStyle(item.tier);
    const cumulative = [
      `${item.todayOrders}单 / ${item.todayItems}件`,
      ...(item.todaySales == null ? [] : [formatMoney(item.todaySales, item.salesCurrency)]),
    ].join("｜");
    return [
      `${current.emoji} **${item.productName}｜${current.label}**`,
      `• 近30分钟：**${item.windowOrders}个付款订单**`,
      `• 今日累计：**${cumulative}**`,
    ].join("\n");
  }).join("\n\n");
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: input.timeZone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(input.createdAt);
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: {
      template: style.template,
      title: {
        tag: "plain_text",
        content: `${input.storeName} 商品热度提醒｜${style.label}`,
      },
    },
    elements: [
      markdown("📣 <at id=all></at>"),
      markdown(itemText),
      markdown(`💡 **建议**\n${style.suggestion}`),
      markdown(`🕒 北京时间 ${time}　｜　口径：已付款、当前未取消`),
    ],
  };
}

function mergeSnapshotIntoState(
  state: ProductSpikeMonitorState,
  snapshot: ProductSpikeSnapshot,
  nowMs: number,
  trustedObservation: boolean,
  initializedBaseline: boolean,
  nowIso: string,
): ProductSpikeMonitorState {
  const products: Record<string, ProductMonitorState> = {};
  for (const product of snapshot.products) {
    const prior = state.products[product.name] ?? emptyProductState();
    products[product.name] = {
      ...prior,
      seenOrderKeys: mergeSeenKeys(
        prior.seenOrderKeys,
        product.orderKeys,
        product.paidAtByOrderKey,
        nowMs,
        trustedObservation,
        initializedBaseline,
      ),
    };
  }
  const currentVideos = new Map(snapshot.videos.map((video) => [video.videoId, video]));
  const videoIds = new Set([...Object.keys(state.videos), ...currentVideos.keys()]);
  const videos: Record<string, VideoMonitorState> = {};
  for (const videoId of videoIds) {
    const prior = state.videos[videoId] ?? emptyVideoState();
    const current = currentVideos.get(videoId);
    videos[videoId] = {
      ...prior,
      seenOrderKeys: mergeSeenKeys(
        prior.seenOrderKeys,
        current?.orderKeys ?? [],
        current?.paidAtByOrderKey ?? {},
        nowMs,
        trustedObservation,
        initializedBaseline,
      ),
    };
  }
  return {
    ...state,
    businessDate: snapshot.businessDate,
    lastPollAt: nowIso,
    videoAttributionAvailable: snapshot.videoAttributionAvailable,
    videoAttributionErrors: snapshot.videoAttributionErrors.slice(0, 5),
    products,
    videos,
    updatedAt: nowIso,
  };
}

function mergeSeenKeys(
  prior: Record<string, number | null>,
  currentKeys: readonly string[],
  paidAtByOrderKey: Readonly<Record<string, number>>,
  nowMs: number,
  trustedObservation: boolean,
  initializedBaseline: boolean,
): Record<string, number | null> {
  const merged: Record<string, number | null> = {};
  for (const key of currentKeys) {
    if (key in prior) {
      merged[key] = prior[key];
      continue;
    }
    if (initializedBaseline) {
      merged[key] = null;
      continue;
    }
    const paidAt = paidAtByOrderKey[key];
    if (paidAt !== undefined) {
      if (!Number.isSafeInteger(paidAt) || paidAt <= 0 || paidAt > nowMs + 5 * 60_000) {
        throw new Error("付款快照返回异常paid_time，爆量监测已拒绝使用");
      }
      merged[key] = paidAt;
      continue;
    }
    merged[key] = trustedObservation ? nowMs : null;
  }
  return merged;
}

function countRecentCurrentKeys(
  seen: Record<string, number | null>,
  currentKeys: ReadonlySet<string>,
  nowMs: number,
  windowMs: number,
): number {
  const cutoff = nowMs - windowMs;
  return [...currentKeys].filter((key) => {
    const observedAt = seen[key];
    return typeof observedAt === "number" && observedAt >= cutoff && observedAt <= nowMs;
  }).length;
}

function earliestRecentTimestamp(
  seen: Record<string, number | null>,
  currentKeys: ReadonlySet<string>,
  nowMs: number,
): number {
  const cutoff = nowMs - PRODUCT_SPIKE_WINDOW_MINUTES * 60_000;
  const values = [...currentKeys].map((key) => seen[key]).filter(
    (value): value is number => typeof value === "number" && value >= cutoff && value <= nowMs,
  );
  return values.length > 0 ? Math.min(...values) : nowMs;
}

function resetProductEpisodeAfterQuiet(state: ProductMonitorState, nowMs: number): void {
  if (!state.lastAboveThresholdAt) return;
  if (nowMs - Date.parse(state.lastAboveThresholdAt) < PRODUCT_SPIKE_QUIET_RESET_MINUTES * 60_000) return;
  state.activeTier = 0;
  state.lastAboveThresholdAt = null;
  state.episodeId = null;
}

function resetVideoEpisodeAfterQuiet(state: VideoMonitorState, nowMs: number): void {
  if (!state.lastAboveThresholdAt) return;
  if (nowMs - Date.parse(state.lastAboveThresholdAt) < PRODUCT_SPIKE_QUIET_RESET_MINUTES * 60_000) return;
  state.active = false;
  state.lastAboveThresholdAt = null;
  state.episodeId = null;
}

function emptyProductState(): ProductMonitorState {
  return { seenOrderKeys: {}, activeTier: 0, lastAboveThresholdAt: null, episodeId: null };
}

function emptyVideoState(): VideoMonitorState {
  return { seenOrderKeys: {}, active: false, lastAboveThresholdAt: null, episodeId: null };
}

function isTrustedObservation(lastPollAt: string | null, nowMs: number): boolean {
  if (!lastPollAt) return false;
  const gap = nowMs - Date.parse(lastPollAt);
  return Number.isFinite(gap) && gap >= 0 && gap <= PRODUCT_SPIKE_MAX_TRUSTED_GAP_MINUTES * 60_000;
}

function stableEpisodeId(businessDate: string, identity: string, observedAt: number): string {
  return createHash("sha256")
    .update(`${businessDate}:${identity}:${observedAt}`)
    .digest("hex")
    .slice(0, 20);
}

function pendingAlertId(
  tenantId: string,
  businessDate: string,
  items: readonly ProductSpikeAlertItem[],
): string {
  return createHash("sha256")
    .update(`${tenantId}:${businessDate}:${items.map((item) => (
      `${item.productName}:${item.tier}:${item.episodeId}`
    )).sort().join("|")}`)
    .digest("hex")
    .slice(0, 24);
}

function tierStyle(tier: Exclude<ProductSpikeTier, 0>): {
  label: string;
  emoji: string;
  template: string;
  suggestion: string;
} {
  if (tier === 1) return {
    label: "热度上升",
    emoji: "🔥",
    template: "yellow",
    suggestion: "热度刚起来，先观察库存与承接情况。",
  };
  if (tier === 2) return {
    label: "明显起量",
    emoji: "🚀",
    template: "orange",
    suggestion: "建议尽快检查库存、价格和履约余量。",
  };
  if (tier === 3) return {
    label: "爆单",
    emoji: "⚡",
    template: "red",
    suggestion: "建议立即确认库存与履约，并放大有效流量。",
  };
  return {
    label: "强爆发",
    emoji: "🚨",
    template: "carmine",
    suggestion: "强爆发，优先处理库存、客服与发货承载。",
  };
}

function formatMoney(value: number, currency: string | null): string {
  const prefix = currency === "USD" ? "$" : currency ? `${currency} ` : "";
  return `${prefix}${value.toFixed(2)}`;
}

function markdown(content: string): Record<string, unknown> {
  return { tag: "div", text: { tag: "lark_md", content } };
}
