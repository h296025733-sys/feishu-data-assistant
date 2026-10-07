import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelProvider, DailyReportHighlightCandidate } from "../ai/types.js";
import type { DailyAutomationRun } from "../automation/daily-sync.js";
import type { BusinessProfile } from "../config/business-profile.js";
import { isFeishuQuotaOrRateLimitError } from "../feishu/client.js";
import { shiftIsoDate } from "../realtime/business-time.js";
import type { DataSource, TableData } from "../types/index.js";

const INITIAL_REPLAY_WINDOW_MS = 2 * 60 * 60_000;
const MAX_HANDLED_RUNS = 30;

export interface DailyGroupReport {
  tenantId: string;
  runId: string;
  runLabel: string;
  reportDate: string;
  analyticsDate: string | null;
  orderDate: string | null;
  sendDate: string;
  analyticsLagDays: number | null;
  selectedHighlightIds: string[];
  usedDeepSeekSelection: boolean;
  dataReadOk: boolean;
  dataComplete: boolean;
  dataReadError: string | null;
  card: Record<string, unknown>;
  text: string;
}

export interface DailyGroupReportDelivery {
  chatId: string;
  messageId: string;
  deliveredAt: string;
}

export interface DailyGroupReportResult {
  skipped: boolean;
  reason: string | null;
  report: DailyGroupReport | null;
  deliveries: DailyGroupReportDelivery[];
}

export interface DailyReportPaidProductSnapshot {
  date: string;
  name: string;
  orders: number;
  items: number;
  sales: number | null;
}

export type DailyReportPaidSnapshotLoader = (
  reportDate: string,
) => Promise<readonly DailyReportPaidProductSnapshot[]>;

interface DailyGroupReportState {
  version: 1;
  installedAt: string;
  baselineRunId: string | null;
  pendingRun: DailyAutomationRun | null;
  deliveries: Record<string, Record<string, DailyGroupReportDelivery>>;
  handledRunIds: string[];
  lastReport: {
    runId: string;
    runLabel: string;
    reportDate?: string | null;
    analyticsDate: string | null;
    orderDate: string | null;
    completedAt: string;
  } | null;
  updatedAt: string;
}

export class DailyGroupReportService {
  private readonly statePath: string;

  public constructor(private readonly input: {
    tenantId: string;
    profile: BusinessProfile;
    dataSource: DataSource;
    provider: ModelProvider;
    groupChatIds: readonly string[] | (() => readonly string[]);
    sendCard: (chatId: string, card: Record<string, unknown>, idempotencyKey: string) => Promise<string>;
    loadPaidSnapshot?: DailyReportPaidSnapshotLoader;
    statePath?: string;
    now?: () => Date;
  }) {
    this.statePath = input.statePath
      ?? path.resolve(".runtime", "tenants", input.tenantId, "daily-group-report", "state.json");
  }

  /**
   * Resume only a genuinely pending/new scheduled report. On the first install,
   * an old production run becomes the baseline; a run from the last two hours is
   * replayed so deploying just after the primary daily run does not silently miss that report.
   */
  public async start(lastAutomaticRun: DailyAutomationRun | null): Promise<DailyGroupReportResult> {
    const existing = await this.readState();
    if (!existing) {
      const now = this.now();
      const recent = lastAutomaticRun?.trigger === "scheduled"
        && isPrimaryScheduledRun(lastAutomaticRun, this.input.profile)
        && now.getTime() - Date.parse(lastAutomaticRun.completedAt) >= 0
        && now.getTime() - Date.parse(lastAutomaticRun.completedAt) <= INITIAL_REPLAY_WINDOW_MS;
      await this.writeState(this.emptyState(recent ? null : lastAutomaticRun?.runId ?? null));
      return recent
        ? this.handleRun(lastAutomaticRun)
        : skipped("首次启用时已把历史运行设为基线，不补发旧日报");
    }
    if (existing.pendingRun) return this.handleRun(existing.pendingRun);
    if (
      lastAutomaticRun?.trigger === "scheduled"
      && lastAutomaticRun.runId !== existing.baselineRunId
      && !existing.handledRunIds.includes(lastAutomaticRun.runId)
    ) {
      return this.handleRun(lastAutomaticRun);
    }
    return skipped("没有待补发的定时日报");
  }

  public async previewRun(run: DailyAutomationRun): Promise<DailyGroupReport> {
    const state = await this.readState();
    return buildDailyGroupReport({
      tenantId: this.input.tenantId,
      profile: this.input.profile,
      dataSource: this.input.dataSource,
      provider: this.input.provider,
      run,
      previousReport: state?.lastReport ?? null,
      loadPaidSnapshot: this.input.loadPaidSnapshot,
    });
  }

  public async handleRun(run: DailyAutomationRun): Promise<DailyGroupReportResult> {
    if (run.trigger !== "scheduled") return skipped("只为每日首轮定时同步发送日报");
    if (isCatchUpScheduledRun(run, this.input.profile)) {
      return skipped("20:00补跑只同步数据，不发送第二份日报");
    }
    if (!isPrimaryScheduledRun(run, this.input.profile)) {
      return skipped("该轮不是当前配置的17:55首轮，避免把旧时刻运行误发成日报");
    }
    const groupChatIds = typeof this.input.groupChatIds === "function"
      ? this.input.groupChatIds()
      : this.input.groupChatIds;
    if (groupChatIds.length === 0) {
      throw new Error(`${this.input.tenantId} 没有绑定专属群，日报拒绝回退到其他群`);
    }
    let state = await this.readState() ?? this.emptyState(null);
    const alreadyDelivered = state.deliveries[run.runId] ?? {};
    const allDelivered = groupChatIds.every((chatId) => Boolean(alreadyDelivered[chatId]));
    if (state.handledRunIds.includes(run.runId) && allDelivered) {
      return {
        skipped: true,
        reason: "该店该轮日报已经投递，幂等跳过",
        report: null,
        deliveries: Object.values(alreadyDelivered),
      };
    }

    state = { ...state, pendingRun: run, updatedAt: this.now().toISOString() };
    await this.writeState(state);
    const report = await buildDailyGroupReport({
      tenantId: this.input.tenantId,
      profile: this.input.profile,
      dataSource: this.input.dataSource,
      provider: this.input.provider,
      run,
      previousReport: state.lastReport,
      loadPaidSnapshot: this.input.loadPaidSnapshot,
    });

    const deliveries = { ...(state.deliveries[run.runId] ?? {}) };
    for (const chatId of [...new Set(groupChatIds)]) {
      if (deliveries[chatId]) continue;
      const messageId = await this.input.sendCard(
        chatId,
        report.card,
        `daily-report:${this.input.tenantId}:${run.runId}:${chatId}`,
      );
      const delivery: DailyGroupReportDelivery = {
        chatId,
        messageId,
        deliveredAt: this.now().toISOString(),
      };
      deliveries[chatId] = delivery;
      state = {
        ...state,
        deliveries: { ...state.deliveries, [run.runId]: { ...deliveries } },
        updatedAt: this.now().toISOString(),
      };
      await this.writeState(state);
    }

    const handledRunIds = [...state.handledRunIds.filter((id) => id !== run.runId), run.runId]
      .slice(-MAX_HANDLED_RUNS);
    state = {
      ...state,
      baselineRunId: state.baselineRunId ?? run.runId,
      pendingRun: null,
      handledRunIds,
      lastReport: {
        runId: run.runId,
        runLabel: report.runLabel,
        reportDate: report.reportDate,
        analyticsDate: report.analyticsDate,
        orderDate: report.orderDate,
        completedAt: run.completedAt,
      },
      deliveries: pruneDeliveries(state.deliveries, handledRunIds),
      updatedAt: this.now().toISOString(),
    };
    await this.writeState(state);
    return {
      skipped: false,
      reason: null,
      report,
      deliveries: Object.values(deliveries),
    };
  }

  private now(): Date {
    return this.input.now?.() ?? new Date();
  }

  private emptyState(baselineRunId: string | null): DailyGroupReportState {
    const now = this.now().toISOString();
    return {
      version: 1,
      installedAt: now,
      baselineRunId,
      pendingRun: null,
      deliveries: {},
      handledRunIds: [],
      lastReport: null,
      updatedAt: now,
    };
  }

  private async readState(): Promise<DailyGroupReportState | null> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as DailyGroupReportState;
      return parsed?.version === 1 ? parsed : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeState(state: DailyGroupReportState): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.statePath);
  }
}

export async function buildDailyGroupReport(input: {
  tenantId: string;
  profile: BusinessProfile;
  dataSource: DataSource;
  provider: ModelProvider;
  run: DailyAutomationRun;
  previousReport?: DailyGroupReportState["lastReport"];
  presentation?: "formal" | "template_test";
  loadPaidSnapshot?: DailyReportPaidSnapshotLoader;
}): Promise<DailyGroupReport> {
  const sendDate = dateKey(new Date(input.run.completedAt), input.profile.businessTimeZone);
  // 用户看到的投产比日期与群日报日期统一按北京时间当天。
  // TikTok 的已付款订单兜底仍读取刚走完的店铺源数据日，但该源日期不对群展示。
  const reportDate = sendDate;
  const paidOrderSourceDate = input.run.orderAttributionTargetDate ?? shiftIsoDate(
    dateKey(new Date(input.run.completedAt), input.profile.tiktok.shopTimeZone),
    -1,
  );
  const runLabel = scheduledRunLabel(input.run, input.profile);
  let table: TableData | null = null;
  let tableError: string | null = null;
  try {
    table = await readReportTable(input.dataSource);
  } catch (error) {
    tableError = error instanceof Error ? error.message : String(error);
  }

  const rows = table?.rows ?? [];
  const reportRows = rowsForDate(rows, reportDate, input.profile);
  const performanceRows = rowsForDate(rows, paidOrderSourceDate, input.profile);
  const previousRows = rowsForDate(rows, shiftIsoDate(paidOrderSourceDate, -1), input.profile);
  const liveStoreMatches = reportRows.filter((row) => isStoreRow(row, input.profile));
  const liveStoreRow = liveStoreMatches.length === 1 ? liveStoreMatches[0] : null;
  const performanceStoreMatches = performanceRows.filter((row) => isStoreRow(row, input.profile));
  const performanceStoreRow = performanceStoreMatches.length === 1 ? performanceStoreMatches[0] : null;
  const scopeProducts = scopedProductNames(input.profile, [...reportRows, ...performanceRows]);
  let products = mergeLiveCooperation(
    buildScopedProductMetrics(performanceRows, scopeProducts, input.profile),
    buildScopedProductMetrics(reportRows, scopeProducts, input.profile),
  );
  let paidSnapshotError: string | null = null;
  if (input.loadPaidSnapshot && currentSalesSnapshotNeeded(products)) {
    try {
      products = mergePaidSnapshot(
        products,
        await input.loadPaidSnapshot(paidOrderSourceDate),
        paidOrderSourceDate,
      );
    } catch (error) {
      paidSnapshotError = error instanceof Error ? error.message : String(error);
    }
  }
  const previousProducts = buildScopedProductMetrics(previousRows, scopeProducts, input.profile);
  const orders = completeMetricTotal(products, "orders");
  const items = completeMetricTotal(products, "items");
  const sales = completeMetricTotal(products, "sales");
  const previousOrders = completeMetricTotal(previousProducts, "orders");
  const previousSales = completeMetricTotal(previousProducts, "sales");
  const cooperation = metric(liveStoreRow, ["合作量"]);
  const online = metric(performanceStoreRow, ["上线量"]);
  // 广告与订单、销售额使用同一店铺经营日；原始账户字段由人工填写，
  // 此处只读取店铺汇总公式，空白与明确 0 严格区分。
  const adSpend = optionalNonNegativeMetric(performanceStoreRow, ["总广告花费"], "总广告花费");
  const adOrders = optionalNonNegativeMetric(performanceStoreRow, ["总广告出单量"], "总广告出单量", true);
  const topProduct = [...products]
    .filter((product) => product.rowCount === 1)
    .sort(compareReportProducts)[0] ?? null;

  const candidates: DailyReportHighlightCandidate[] = [];
  addDeltaCandidate(candidates, "orders_delta", "总单量", orders, previousOrders, 70, "单");
  addDeltaCandidate(candidates, "sales_delta", "销售额", sales, previousSales, 80, input.profile.tiktok.currencyCode ?? "");
  if (topProduct && ((topProduct.sales ?? 0) > 0 || (topProduct.orders ?? 0) > 0 || (topProduct.items ?? 0) > 0)) {
    candidates.push({
      id: "top_product",
      text: `${topProduct.name} 当日表现居首：${formatMetricPair(topProduct.orders, topProduct.items)}${topProduct.sales == null ? "" : `，销售额 ${formatMoney(topProduct.sales, input.profile.tiktok.currencyCode)}`}。`,
      priority: 85,
    });
  }
  if (cooperation != null && cooperation > 0) {
    candidates.push({ id: "cooperation_activity", text: `当日新增合作 ${formatNumber(cooperation)} 个。`, priority: 65 });
  }
  if (online != null && online > 0) {
    candidates.push({ id: "online_activity", text: `当日新增上线 ${formatNumber(online)} 个。`, priority: 75 });
  }
  if (online != null && online > 0 && orders === 0) {
    candidates.push({
      id: "online_without_orders",
      text: `今日新增上线 ${formatNumber(online)} 个，尚未形成付款成交，建议继续观察后续转化。`,
      priority: 100,
    });
  }
  if (cooperation != null && cooperation > 0 && online === 0) {
    candidates.push({
      id: "cooperation_without_online",
      text: `当日新增合作 ${formatNumber(cooperation)} 个、上线 0 个，目前主要处于合作推进阶段。`,
      priority: 80,
    });
  }
  if (orders === 0) {
    candidates.push({ id: "no_orders", text: "今日暂无有效付款成交。", priority: 95 });
  }
  let chosenByModel: string[] | null = null;
  try {
    chosenByModel = input.provider.selectDailyReportHighlights
      ? await input.provider.selectDailyReportHighlights({
          storeName: input.profile.businessDisplayName,
          runLabel,
          reportType: "daily",
          periodLabel: friendlyDate(reportDate),
          analyticsDate: reportDate,
          orderDate: paidOrderSourceDate,
          candidates,
        })
      : null;
  } catch {
    // 日报的数值和安全边界必须由本地确定性代码裁决。DeepSeek 暂时不可用
    // 时只退回本地优先级，不能阻断已经完成的数据同步与群内投递。
    chosenByModel = null;
  }
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const selectedIds = (chosenByModel ?? [])
    .filter((id) => candidateById.has(id))
    .slice(0, 2);
  const fallbackIds = [...candidates]
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
    .slice(0, 2)
    .map((candidate) => candidate.id);
  const finalIds = selectedIds.length > 0 ? selectedIds : fallbackIds;
  const highlights = finalIds.map((id) => candidateById.get(id)!.text);
  const isTemplateTest = input.presentation === "template_test";
  const titleSuffix = isTemplateTest ? "（模板测试）" : "";

  const dateLine = `**日报日期：${friendlyDate(reportDate)}**`;
  const overviewLines = [
    `• 单日单量 / 销量：**${formatMetricPair(orders, items)}**`,
    `• 销售额：**${sales == null ? "—" : formatMoney(sales, input.profile.tiktok.currencyCode)}**`,
    `• 总广告花费：**${adSpend == null ? "待录入" : formatMoney(adSpend, input.profile.tiktok.currencyCode)}**`,
    `• 总广告出单量：**${adOrders == null ? "待录入" : formatNumber(adOrders)}**`,
  ];
  const cooperationLines = [
    `• 合作量：**${formatCount(cooperation)}**`,
    `• 上线量：**${formatCount(online)}**`,
  ];
  const productLines = products.length > 0
    ? products.map((product) => formatProductLine(product, input.profile.tiktok.currencyCode))
    : ["• 暂无在售商品数据"];
  const text = [
    `📊 ${input.profile.businessDisplayName} 经营日报${titleSuffix}｜${friendlyDate(reportDate)}`,
    ...(isTemplateTest ? ["🧪 新版模板测试"] : []),
    "",
    dateLine,
    "",
    "【店铺情况】",
    ...overviewLines,
    "",
    "【达人合作情况】",
    ...cooperationLines,
    "",
    "【商品及达人合作表现】",
    ...productLines,
    "",
    ...(highlights.length > 0 ? ["【今日简评】", ...highlights.map((item) => `• ${item}`)] : []),
  ].join("\n");
  const card: Record<string, unknown> = {
    config: { wide_screen_mode: true, enable_forward: false },
    header: {
      template: isTemplateTest ? "turquoise" : "blue",
      title: { tag: "plain_text", content: `${input.profile.businessDisplayName} 经营日报${titleSuffix}｜${friendlyDate(reportDate)}` },
    },
    elements: [
      markdown("📣 <at id=all></at>"),
      ...(isTemplateTest ? [markdown("🧪 **新版模板测试**")] : []),
      markdown(`🗓️ ${dateLine}`),
      markdown(`🏪 **店铺情况**\n${overviewLines.join("\n")}`),
      markdown(`🤝 **达人合作情况**\n${cooperationLines.join("\n")}`),
      markdown(`🛍️ **商品及达人合作表现**\n${productLines.join("\n")}`),
      ...(highlights.length > 0
        ? [markdown(`💡 **今日简评**\n${highlights.map((item) => `• ${item}`).join("\n")}`)]
        : []),
    ],
  };
  const dataComplete = table !== null
    && paidSnapshotError === null
    && liveStoreMatches.length === 1
    && performanceStoreMatches.length === 1
    && [orders, items, sales, cooperation, online].every((value) => value != null)
    && products.length > 0
    && products.every((product) => (
      product.rowCount === 1
      && product.orders != null
      && product.items != null
      && product.sales != null
      && product.cooperation != null
      && product.online != null
    ));
  return {
    tenantId: input.tenantId,
    runId: input.run.runId,
    runLabel,
    reportDate,
    analyticsDate: null,
    orderDate: paidOrderSourceDate,
    sendDate,
    analyticsLagDays: null,
    selectedHighlightIds: finalIds,
    usedDeepSeekSelection: selectedIds.length > 0,
    dataReadOk: table !== null && paidSnapshotError === null,
    dataComplete,
    dataReadError: tableError ?? paidSnapshotError,
    card,
    text,
  };
}

function scheduledRunLabel(run: DailyAutomationRun, profile: BusinessProfile): string {
  const time = localTime(new Date(run.startedAt), profile.businessTimeZone);
  const catchUp = profile.dailyAutomation?.catchUpLocalTime;
  if (catchUp && time === catchUp) return `${catchUp} 补跑`;
  if (catchUp && time >= catchUp) return `${catchUp} 补跑`;
  // 首轮时间可以由每店运行设置覆盖 profile，run.startedAt 才是本轮真实时间。
  return `${time} 首轮`;
}

function isCatchUpScheduledRun(run: DailyAutomationRun, profile: BusinessProfile): boolean {
  const catchUp = profile.dailyAutomation?.catchUpLocalTime;
  if (!catchUp) return false;
  return localTime(new Date(run.startedAt), profile.businessTimeZone) >= catchUp;
}

function isPrimaryScheduledRun(run: DailyAutomationRun, profile: BusinessProfile): boolean {
  const configured = profile.dailyAutomation?.localTime;
  return !configured || localTime(new Date(run.startedAt), profile.businessTimeZone) === configured;
}

function addDeltaCandidate(
  candidates: DailyReportHighlightCandidate[],
  id: string,
  label: string,
  current: number | null,
  previous: number | null,
  priority: number,
  unit = "",
): void {
  if (current == null || previous == null) return;
  const delta = current - previous;
  const direction = delta > 0 ? "增加" : delta < 0 ? "减少" : "持平";
  const amount = Math.abs(delta);
  const rate = previous === 0 ? null : (delta / previous) * 100;
  candidates.push({
    id,
    text: delta === 0
      ? `${label}较前一完整日持平（${formatNumber(current)}${unit}）。`
      : `${label}较前一完整日${direction} ${formatNumber(amount)}${unit}${rate == null ? "" : `（${delta > 0 ? "+" : ""}${rate.toFixed(1)}%）`}。`,
    priority: delta === 0 ? Math.max(20, priority - 45) : priority,
  });
}

function isStoreRow(row: Record<string, unknown>, profile: BusinessProfile): boolean {
  const product = cellText(row.商品);
  const type = cellText(row.记录类型);
  return product === profile.storeAggregateLabel || product === "店铺汇总" || /店铺|汇总/.test(type);
}

interface ReportProductMetric {
  name: string;
  rowCount: number;
  orders: number | null;
  items: number | null;
  sales: number | null;
  cooperation: number | null;
  online: number | null;
}

function rowsForDate(
  rows: Record<string, unknown>[],
  targetDate: string,
  profile: BusinessProfile,
): Record<string, unknown>[] {
  return rows.filter((row) => rowDate(row, profile.businessTimeZone) === targetDate);
}

function scopedProductNames(
  profile: BusinessProfile,
  reportRows: Record<string, unknown>[],
): string[] {
  const configured = [...new Set(
    (profile.tiktok.autoEnrollNewProducts ? [] : profile.tiktok.includedCanonicalProducts ?? [])
      .map((name) => name.trim()).filter(Boolean),
  )];
  if (configured.length > 0) return configured;
  return [...new Set(reportRows
    .filter((row) => !isStoreRow(row, profile))
    .map((row) => cellText(row.商品))
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function buildScopedProductMetrics(
  rows: Record<string, unknown>[],
  productNames: string[],
  profile: BusinessProfile,
): ReportProductMetric[] {
  return productNames.map((name) => {
    const matches = rows.filter((row) => !isStoreRow(row, profile) && cellText(row.商品) === name);
    const source = matches.length === 1 ? matches[0] : null;
    return {
      name,
      rowCount: matches.length,
      orders: metric(source, ["单量"]),
      items: metric(source, ["数量"]),
      sales: metric(source, ["销售额"]),
      cooperation: metric(source, ["合作量"]),
      online: metric(source, ["上线量"]),
    };
  });
}

function currentSalesSnapshotNeeded(products: ReportProductMetric[]): boolean {
  return products.length > 0 && products.some((product) => (
    product.orders == null || product.items == null || product.sales == null
  ));
}

function mergeLiveCooperation(
  performanceProducts: ReportProductMetric[],
  liveProducts: ReportProductMetric[],
): ReportProductMetric[] {
  const liveByName = new Map(liveProducts.map((product) => [product.name, product]));
  return performanceProducts.map((product) => {
    const live = liveByName.get(product.name);
    return {
      ...product,
      cooperation: live?.rowCount === 1 ? live.cooperation : null,
    };
  });
}

function mergePaidSnapshot(
  products: ReportProductMetric[],
  snapshots: readonly DailyReportPaidProductSnapshot[],
  reportDate: string,
): ReportProductMetric[] {
  const matching = snapshots.filter((snapshot) => snapshot.date === reportDate);
  const counts = new Map<string, number>();
  for (const snapshot of matching) counts.set(snapshot.name, (counts.get(snapshot.name) ?? 0) + 1);
  const byName = new Map(matching.map((snapshot) => [snapshot.name, snapshot]));
  return products.map((product) => {
    const snapshot = counts.get(product.name) === 1 ? byName.get(product.name) : null;
    if (!snapshot) return product;
    return {
      ...product,
      orders: snapshot.orders,
      items: snapshot.items,
      sales: snapshot.sales ?? product.sales,
    };
  });
}

function completeMetricTotal(
  products: ReportProductMetric[],
  field: "orders" | "items" | "sales",
): number | null {
  if (products.length === 0) return null;
  if (products.some((product) => product.rowCount !== 1 || product[field] == null)) return null;
  return products.reduce((total, product) => total + (product[field] ?? 0), 0);
}

function compareReportProducts(left: ReportProductMetric, right: ReportProductMetric): number {
  return (right.sales ?? Number.NEGATIVE_INFINITY) - (left.sales ?? Number.NEGATIVE_INFINITY)
    || (right.items ?? Number.NEGATIVE_INFINITY) - (left.items ?? Number.NEGATIVE_INFINITY)
    || (right.orders ?? Number.NEGATIVE_INFINITY) - (left.orders ?? Number.NEGATIVE_INFINITY)
    || left.name.localeCompare(right.name, "zh-CN");
}

function formatProductLine(product: ReportProductMetric, currencyCode?: string | null): string {
  if (product.rowCount === 0) return `• ${product.name}｜当日数据尚未同步`;
  if (product.rowCount > 1) return `• ${product.name}｜当日数据校验中`;
  return `• ${product.name}｜${formatMetricPair(product.orders, product.items)}｜${product.sales == null ? "销售额 —" : formatMoney(product.sales, currencyCode)}｜合作 ${formatCount(product.cooperation)}｜上线 ${formatCount(product.online)}`;
}

function formatMetricPair(orders: number | null, items: number | null): string {
  if (orders == null || items == null) return "—";
  return `${formatNumber(orders)}单 / ${formatNumber(items)}件`;
}

function formatCount(value: number | null): string {
  return value == null ? "—" : formatNumber(value);
}

function metric(row: Record<string, unknown> | null, fields: string[]): number | null {
  if (!row) return null;
  for (const field of fields) {
    const value = numberValue(row[field]);
    if (value != null) return value;
  }
  return null;
}

function optionalNonNegativeMetric(
  row: Record<string, unknown> | null,
  fields: string[],
  label: string,
  integer = false,
): number | null {
  const value = metric(row, fields);
  if (value == null) return null;
  if (value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${label}不是可靠的${integer ? "非负整数" : "非负数"}`);
  }
  return value;
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (Array.isArray(value)) return numberValue(value[0]);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return numberValue(object.value ?? object.text ?? object.content);
  }
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function cellText(value: unknown): string {
  if (Array.isArray(value)) return value.map(cellText).join("").trim();
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return cellText(object.text ?? object.value ?? object.content ?? "");
  }
  return String(value ?? "").trim();
}

function rowDate(row: Record<string, unknown>, timeZone: string): string {
  const value = row.日期;
  if (typeof value === "number") return dateKey(new Date(value), timeZone);
  const text = cellText(value);
  return text.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

function formatMoney(value: number, currencyCode?: string | null): string {
  const currency = currencyCode?.trim().toUpperCase();
  if (!currency) return formatNumber(value);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${formatNumber(value)}`;
  }
}

function friendlyDate(value: string): string {
  const matched = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return matched ? `${Number(matched[2])}月${Number(matched[3])}日` : value;
}

function localTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(value);
}

function dateKey(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(value);
}

function markdown(content: string): Record<string, unknown> {
  return { tag: "markdown", content };
}

async function readReportTable(dataSource: DataSource): Promise<TableData> {
  let firstError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await dataSource.getTable("投产比");
    } catch (error) {
      firstError ??= error;
      if (attempt === 2 || isFeishuQuotaOrRateLimitError(error)) throw firstError;
      // 整份日报读取是纯只读操作。底层每个飞书请求已经只重试已知瞬时
      // 错误，这一层仅对“多请求组成的一次整表读取”做一次完整重放。
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_200));
    }
  }
  throw firstError;
}

function pruneDeliveries(
  deliveries: DailyGroupReportState["deliveries"],
  handledRunIds: string[],
): DailyGroupReportState["deliveries"] {
  return Object.fromEntries(Object.entries(deliveries).filter(([runId]) => handledRunIds.includes(runId)));
}

function skipped(reason: string): DailyGroupReportResult {
  return { skipped: true, reason, report: null, deliveries: [] };
}
