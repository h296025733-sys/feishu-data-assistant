import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DailyReportHighlightCandidate, ModelProvider } from "../ai/types.js";
import type { DailyAutomationRun } from "../automation/daily-sync.js";
import type { BusinessProfile } from "../config/business-profile.js";
import { isFeishuQuotaOrRateLimitError } from "../feishu/client.js";
import { shiftIsoDate } from "../realtime/business-time.js";
import type { DataSource, TableData } from "../types/index.js";
import type {
  DailyGroupReportDelivery,
  DailyReportPaidProductSnapshot,
} from "./daily-group-report.js";

const INITIAL_REPLAY_WINDOW_MS = 2 * 60 * 60_000;
const MAX_HANDLED_REPORTS = 36;

export type PeriodicGroupReportKind = "weekly" | "monthly";

export type PeriodicReportPaidSnapshotLoader = (
  startDate: string,
  endDateInclusive: string,
) => Promise<readonly DailyReportPaidProductSnapshot[]>;

export interface PeriodicReportPeriod {
  kind: PeriodicGroupReportKind;
  startDate: string;
  endDate: string;
  previousStartDate: string;
  previousEndDate: string;
}

export interface PeriodicGroupReport {
  tenantId: string;
  runId: string;
  reportKey: string;
  kind: PeriodicGroupReportKind;
  sendDate: string;
  startDate: string;
  endDate: string;
  previousStartDate: string;
  previousEndDate: string;
  selectedHighlightIds: string[];
  usedDeepSeekSelection: boolean;
  dataReadOk: boolean;
  dataComplete: boolean;
  dataReadError: string | null;
  card: Record<string, unknown>;
  text: string;
}

export interface PeriodicGroupReportDelivery extends DailyGroupReportDelivery {
  reportKey: string;
  kind: PeriodicGroupReportKind;
}

export interface PeriodicGroupReportResult {
  skipped: boolean;
  reason: string | null;
  reports: PeriodicGroupReport[];
  deliveries: PeriodicGroupReportDelivery[];
}

interface PeriodicGroupReportState {
  version: 1;
  installedAt: string;
  baselineRunId: string | null;
  pendingRuns: DailyAutomationRun[];
  deliveries: Record<string, Record<string, DailyGroupReportDelivery>>;
  handledReportKeys: string[];
  updatedAt: string;
}

interface ProductDayMetric {
  date: string;
  name: string;
  rowCount: number;
  orders: number | null;
  items: number | null;
  sales: number | null;
  cooperation: number | null;
  online: number | null;
  coreFallback: boolean;
}

interface ProductPeriodMetric {
  name: string;
  orders: number | null;
  items: number | null;
  sales: number | null;
  cooperation: number | null;
  online: number | null;
}

export class PeriodicGroupReportService {
  private readonly statePath: string;

  public constructor(private readonly input: {
    tenantId: string;
    profile: BusinessProfile;
    dataSource: DataSource;
    provider: ModelProvider;
    groupChatIds: readonly string[] | (() => readonly string[]);
    sendCard: (chatId: string, card: Record<string, unknown>, idempotencyKey: string) => Promise<string>;
    loadPaidSnapshot?: PeriodicReportPaidSnapshotLoader;
    statePath?: string;
    now?: () => Date;
  }) {
    this.statePath = input.statePath
      ?? path.resolve(".runtime", "tenants", input.tenantId, "periodic-group-report", "state.json");
  }

  public async start(lastAutomaticRun: DailyAutomationRun | null): Promise<PeriodicGroupReportResult> {
    const existing = await this.readState();
    if (!existing) {
      const now = this.now();
      const recent = lastAutomaticRun?.trigger === "scheduled"
        && isPrimaryScheduledRun(lastAutomaticRun, this.input.profile)
        && duePeriodsForRun(lastAutomaticRun, this.input.profile).length > 0
        && now.getTime() - Date.parse(lastAutomaticRun.completedAt) >= 0
        && now.getTime() - Date.parse(lastAutomaticRun.completedAt) <= INITIAL_REPLAY_WINDOW_MS;
      await this.writeState(this.emptyState(recent ? null : lastAutomaticRun?.runId ?? null));
      return recent
        ? this.handleRun(lastAutomaticRun)
        : skipped("首次启用时已把历史运行设为基线，不补发旧周报或月报");
    }
    if (existing.pendingRuns.length > 0) return this.processPendingRuns(existing);
    if (
      lastAutomaticRun?.trigger === "scheduled"
      && lastAutomaticRun.runId !== existing.baselineRunId
      && duePeriodsForRun(lastAutomaticRun, this.input.profile).some((period) => (
        !existing.handledReportKeys.includes(periodReportKey(period))
      ))
    ) {
      return this.handleRun(lastAutomaticRun);
    }
    return skipped("没有待补发的周报或月报");
  }

  public async previewPeriod(
    run: DailyAutomationRun,
    period: PeriodicReportPeriod,
  ): Promise<PeriodicGroupReport> {
    return buildPeriodicGroupReport({
      tenantId: this.input.tenantId,
      profile: this.input.profile,
      dataSource: this.input.dataSource,
      provider: this.input.provider,
      run,
      period,
      loadPaidSnapshot: this.input.loadPaidSnapshot,
    });
  }

  public async handleRun(run: DailyAutomationRun): Promise<PeriodicGroupReportResult> {
    if (run.trigger !== "scheduled") return skipped("只为17:55首轮定时同步发送周报或月报");
    if (isCatchUpScheduledRun(run, this.input.profile)) {
      return skipped("20:00补跑只同步数据，不发送周报或月报");
    }
    if (!isPrimaryScheduledRun(run, this.input.profile)) {
      return skipped("该轮不是当前配置的17:55首轮，避免旧时刻误发周期报告");
    }
    const periods = duePeriodsForRun(run, this.input.profile);
    let state = await this.readState() ?? this.emptyState(null);
    if (periods.length > 0 && !state.pendingRuns.some((pending) => pending.runId === run.runId)) {
      state = {
        ...state,
        pendingRuns: [...state.pendingRuns, run],
        updatedAt: this.now().toISOString(),
      };
    }
    state = { ...state, baselineRunId: run.runId, updatedAt: this.now().toISOString() };
    await this.writeState(state);
    if (state.pendingRuns.length === 0) return skipped("今天不是周报或月报发送日");
    return this.processPendingRuns(state);
  }

  private async processPendingRuns(
    initialState: PeriodicGroupReportState,
  ): Promise<PeriodicGroupReportResult> {
    const groupChatIds = [...new Set((typeof this.input.groupChatIds === "function"
      ? this.input.groupChatIds()
      : this.input.groupChatIds).map((value) => value.trim()).filter(Boolean))];
    if (groupChatIds.length === 0) {
      throw new Error(`${this.input.tenantId} 没有绑定专属群，周报/月报拒绝回退到其他群`);
    }
    let state = initialState;
    const reports: PeriodicGroupReport[] = [];
    const allDeliveries: PeriodicGroupReportDelivery[] = [];
    const periodErrors: string[] = [];
    const remainingRuns: DailyAutomationRun[] = [];
    const pendingRuns = [...state.pendingRuns].sort((left, right) => (
      Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.runId.localeCompare(right.runId)
    ));
    for (const pendingRun of pendingRuns) {
      let runFailed = false;
      for (const period of duePeriodsForRun(pendingRun, this.input.profile)) {
        try {
          const reportKey = periodReportKey(period);
          const existingDeliveries = state.deliveries[reportKey] ?? {};
          const allDelivered = groupChatIds.every((chatId) => Boolean(existingDeliveries[chatId]));
          if (state.handledReportKeys.includes(reportKey) && allDelivered) {
            allDeliveries.push(...Object.values(existingDeliveries).map((delivery) => ({
              ...delivery,
              reportKey,
              kind: period.kind,
            })));
            continue;
          }

          const report = await buildPeriodicGroupReport({
            tenantId: this.input.tenantId,
            profile: this.input.profile,
            dataSource: this.input.dataSource,
            provider: this.input.provider,
            run: pendingRun,
            period,
            loadPaidSnapshot: this.input.loadPaidSnapshot,
          });
          reports.push(report);
          const deliveries = { ...existingDeliveries };
          for (const chatId of groupChatIds) {
            if (deliveries[chatId]) continue;
            const messageId = await this.input.sendCard(
              chatId,
              report.card,
              `periodic-report:${this.input.tenantId}:${reportKey}:${chatId}`,
            );
            deliveries[chatId] = {
              chatId,
              messageId,
              deliveredAt: this.now().toISOString(),
            };
            state = {
              ...state,
              deliveries: { ...state.deliveries, [reportKey]: { ...deliveries } },
              updatedAt: this.now().toISOString(),
            };
            await this.writeState(state);
          }
          const handledReportKeys = [
            ...state.handledReportKeys.filter((key) => key !== reportKey),
            reportKey,
          ].slice(-MAX_HANDLED_REPORTS);
          state = {
            ...state,
            baselineRunId: pendingRun.runId,
            handledReportKeys,
            deliveries: pruneDeliveries(
              state.deliveries,
              [...new Set([...handledReportKeys, ...pendingReportKeys(state.pendingRuns, this.input.profile)])],
            ),
            updatedAt: this.now().toISOString(),
          };
          await this.writeState(state);
          allDeliveries.push(...Object.values(deliveries).map((delivery) => ({
            ...delivery,
            reportKey,
            kind: period.kind,
          })));
        } catch (error) {
          runFailed = true;
          periodErrors.push(
            `${pendingRun.runId}/${period.kind}：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (runFailed) remainingRuns.push(pendingRun);
    }
    state = {
      ...state,
      pendingRuns: remainingRuns,
      deliveries: pruneDeliveries(
        state.deliveries,
        [...new Set([...state.handledReportKeys, ...pendingReportKeys(remainingRuns, this.input.profile)])],
      ),
      updatedAt: this.now().toISOString(),
    };
    await this.writeState(state);
    if (periodErrors.length > 0) throw new Error(periodErrors.join("；"));
    return {
      skipped: reports.length === 0,
      reason: reports.length === 0 ? "本轮周报/月报均已投递，幂等跳过" : null,
      reports,
      deliveries: allDeliveries,
    };
  }

  private now(): Date {
    return this.input.now?.() ?? new Date();
  }

  private emptyState(baselineRunId: string | null): PeriodicGroupReportState {
    const now = this.now().toISOString();
    return {
      version: 1,
      installedAt: now,
      baselineRunId,
      pendingRuns: [],
      deliveries: {},
      handledReportKeys: [],
      updatedAt: now,
    };
  }

  private async readState(): Promise<PeriodicGroupReportState | null> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as (
        PeriodicGroupReportState & { pendingRun?: DailyAutomationRun | null }
      );
      if (parsed?.version !== 1) return null;
      return {
        ...parsed,
        pendingRuns: Array.isArray(parsed.pendingRuns)
          ? parsed.pendingRuns
          : parsed.pendingRun ? [parsed.pendingRun] : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeState(state: PeriodicGroupReportState): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.statePath);
  }
}

export function duePeriodicReportPeriods(sendDate: string): PeriodicReportPeriod[] {
  assertIsoDate(sendDate);
  const periods: PeriodicReportPeriod[] = [];
  // 用户按周日 17:55 收本周周报；周一触发会让周日完全收不到。
  if (isoWeekday(sendDate) === 0) periods.push(periodForKind("weekly", sendDate));
  if (sendDate.endsWith("-01")) periods.push(periodForKind("monthly", sendDate));
  return periods;
}

export function periodForKind(
  kind: PeriodicGroupReportKind,
  sendDate: string,
): PeriodicReportPeriod {
  assertIsoDate(sendDate);
  if (kind === "weekly") {
    const endDate = sendDate;
    const startDate = shiftIsoDate(endDate, -6);
    return {
      kind,
      startDate,
      endDate,
      previousStartDate: shiftIsoDate(startDate, -7),
      previousEndDate: shiftIsoDate(endDate, -7),
    };
  }
  const endDate = shiftIsoDate(firstOfMonth(sendDate), -1);
  const startDate = firstOfMonth(endDate);
  const previousEndDate = shiftIsoDate(startDate, -1);
  return {
    kind,
    startDate,
    endDate,
    previousStartDate: firstOfMonth(previousEndDate),
    previousEndDate,
  };
}

export async function buildPeriodicGroupReport(input: {
  tenantId: string;
  profile: BusinessProfile;
  dataSource: DataSource;
  provider: ModelProvider;
  run: DailyAutomationRun;
  period: PeriodicReportPeriod;
  loadPaidSnapshot?: PeriodicReportPaidSnapshotLoader;
}): Promise<PeriodicGroupReport> {
  const sendDate = dateKey(new Date(input.run.startedAt), input.profile.businessTimeZone);
  const expected = periodForKind(input.period.kind, sendDate);
  if (JSON.stringify(expected) !== JSON.stringify(input.period)) {
    throw new Error(`${input.period.kind}报告周期与17:55发送日期不一致`);
  }
  let table: TableData | null = null;
  let tableError: string | null = null;
  try {
    table = await readReportTable(input.dataSource);
  } catch (error) {
    tableError = error instanceof Error ? error.message : String(error);
  }
  const rows = table?.rows ?? [];
  const scopeProducts = scopedProductNames(input.profile, rows);
  const effectivePeriod = effectiveReportPeriod(
    input.period,
    rows,
    scopeProducts,
    input.profile,
  );
  // 周期标题和合作量使用用户看到的北京时间日期；订单、销售额、上线量
  // 与日报一致，读取每个展示日的前一行来源日期。
  const currentDates = isoDateRange(effectivePeriod.startDate, effectivePeriod.endDate);
  const currentPerformanceDates = currentDates.map((date) => shiftIsoDate(date, -1));
  const previousDates = isoDateRange(effectivePeriod.previousStartDate, effectivePeriod.previousEndDate);
  const previousPerformanceDates = previousDates.map((date) => shiftIsoDate(date, -1));
  let currentDays = mergeDisplayDateCooperation(
    buildProductDays(rows, currentPerformanceDates, scopeProducts, input.profile),
    buildProductDays(rows, currentDates, scopeProducts, input.profile),
  );
  const previousDays = buildProductDays(rows, previousPerformanceDates, scopeProducts, input.profile);
  let paidSnapshotError: string | null = null;
  if (input.loadPaidSnapshot && periodSnapshotNeeded(currentDays)) {
    try {
      currentDays = mergePaidSnapshot(
        currentDays,
        await input.loadPaidSnapshot(currentPerformanceDates[0]!, currentPerformanceDates.at(-1)!),
      );
    } catch (error) {
      paidSnapshotError = error instanceof Error ? error.message : String(error);
    }
  }
  const products = aggregateProducts(currentDays, scopeProducts);
  const previousProducts = aggregateProducts(previousDays, scopeProducts);
  const orders = completeMetricTotal(products, "orders");
  const items = completeMetricTotal(products, "items");
  const sales = completeMetricTotal(products, "sales");
  const previousOrders = completeMetricTotal(previousProducts, "orders");
  const previousSales = completeMetricTotal(previousProducts, "sales");
  const cooperation = aggregateStoreMetric(rows, currentDates, input.profile, "合作量");
  const online = aggregateStoreMetric(rows, currentPerformanceDates, input.profile, "上线量");
  const adSpend = aggregateStoreMetric(rows, currentPerformanceDates, input.profile, "总广告花费");
  const adOrders = aggregateStoreMetric(rows, currentPerformanceDates, input.profile, "总广告出单量");
  const topProduct = [...products]
    .filter((product) => product.orders != null && product.items != null && product.sales != null)
    .sort(compareProducts)[0] ?? null;
  const candidates: DailyReportHighlightCandidate[] = [];
  const comparisonLabel = input.period.kind === "weekly" ? "上周" : "上月";
  addDeltaCandidate(candidates, "orders_delta", "总单量", orders, previousOrders, comparisonLabel, 75, "单");
  addDeltaCandidate(
    candidates,
    "sales_delta",
    "销售额",
    sales,
    previousSales,
    comparisonLabel,
    85,
    input.profile.tiktok.currencyCode ?? "",
  );
  if (topProduct && ((topProduct.sales ?? 0) > 0 || (topProduct.orders ?? 0) > 0 || (topProduct.items ?? 0) > 0)) {
    candidates.push({
      id: "top_product",
      text: `${topProduct.name}为本期表现最高商品：${formatMetricPair(topProduct.orders, topProduct.items)}，销售额 ${formatMoney(topProduct.sales ?? 0, input.profile.tiktok.currencyCode)}。`,
      priority: 90,
    });
  }
  if (online != null && online > 0 && orders === 0) {
    candidates.push({
      id: "online_without_orders",
      text: `本期新增上线 ${formatNumber(online)} 个，尚未形成付款成交，建议继续观察后续转化。`,
      priority: 100,
    });
  }
  if (cooperation != null && cooperation > 0 && online === 0) {
    candidates.push({
      id: "cooperation_without_online",
      text: `本期新增合作 ${formatNumber(cooperation)} 个、上线 0 个，当前重点仍是推动内容上线。`,
      priority: 88,
    });
  }
  if (orders === 0) {
    candidates.push({ id: "no_orders", text: "本期暂无有效付款成交。", priority: 95 });
  }
  let selectedByModel: string[] | null = null;
  try {
    selectedByModel = input.provider.selectDailyReportHighlights
      ? await input.provider.selectDailyReportHighlights({
          storeName: input.profile.businessDisplayName,
          runLabel: input.period.kind === "weekly" ? "经营周报" : "经营月报",
          reportType: input.period.kind,
          periodLabel: formatPeriod(input.period),
          analyticsDate: input.period.endDate,
          orderDate: shiftIsoDate(input.period.endDate, -1),
          candidates,
        })
      : null;
  } catch {
    selectedByModel = null;
  }
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const selectedIds = (selectedByModel ?? [])
    .filter((id) => candidateById.has(id))
    .slice(0, 2);
  const fallbackIds = [...candidates]
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
    .slice(0, 2)
    .map((candidate) => candidate.id);
  const finalIds = selectedIds.length > 0 ? selectedIds : fallbackIds;
  const highlights = finalIds.map((id) => candidateById.get(id)!.text);
  const reportName = input.period.kind === "weekly" ? "经营周报" : "经营月报";
  const metricName = input.period.kind === "weekly" ? "周单量 / 销量" : "月单量 / 销量";
  const salesName = input.period.kind === "weekly" ? "周销售额" : "月销售额";
  const commentName = input.period.kind === "weekly" ? "本周简评" : "本月简评";
  const periodLabel = formatPeriod(effectivePeriod);
  const overviewLines = [
    `• ${metricName}：**${formatMetricPair(orders, items)}**`,
    `• ${salesName}：**${sales == null ? "—" : formatMoney(sales, input.profile.tiktok.currencyCode)}**`,
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
    `📊 ${input.profile.businessDisplayName} ${reportName}｜${periodLabel}`,
    "",
    `**统计周期：${periodLabel}**`,
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
    ...(highlights.length > 0 ? [`【${commentName}】`, ...highlights.map((item) => `• ${item}`)] : []),
  ].join("\n");
  const card: Record<string, unknown> = {
    config: { wide_screen_mode: true, enable_forward: false },
    header: {
      template: input.period.kind === "weekly" ? "green" : "purple",
      title: {
        tag: "plain_text",
        content: `${input.profile.businessDisplayName} ${reportName}｜${periodLabel}`,
      },
    },
    elements: [
      markdown("📣 <at id=all></at>"),
      markdown(`🗓️ **统计周期：${periodLabel}**`),
      markdown(`🏪 **店铺情况**\n${overviewLines.join("\n")}`),
      markdown(`🤝 **达人合作情况**\n${cooperationLines.join("\n")}`),
      markdown(`🛍️ **商品及达人合作表现**\n${productLines.join("\n")}`),
      ...(highlights.length > 0
        ? [markdown(`💡 **${commentName}**\n${highlights.map((item) => `• ${item}`).join("\n")}`)]
        : []),
    ],
  };
  const dataComplete = [orders, items, sales, cooperation, online].every((value) => value != null)
    && products.every((product) => (
      product.orders != null
      && product.items != null
      && product.sales != null
      && product.cooperation != null
      && product.online != null
    ));
  return {
    tenantId: input.tenantId,
    runId: input.run.runId,
    reportKey: periodReportKey(input.period),
    kind: input.period.kind,
    sendDate,
    startDate: effectivePeriod.startDate,
    endDate: effectivePeriod.endDate,
    previousStartDate: effectivePeriod.previousStartDate,
    previousEndDate: effectivePeriod.previousEndDate,
    selectedHighlightIds: finalIds,
    usedDeepSeekSelection: selectedIds.length > 0,
    dataReadOk: table !== null && paidSnapshotError === null,
    dataComplete,
    dataReadError: tableError ?? paidSnapshotError ?? (dataComplete
      ? null
      : `${input.period.kind === "weekly" ? "周报" : "月报"}可用周期仍缺少唯一日期行或关键字段`),
    card,
    text,
  };
}

function duePeriodsForRun(run: DailyAutomationRun, profile: BusinessProfile): PeriodicReportPeriod[] {
  if (run.trigger !== "scheduled" || !isPrimaryScheduledRun(run, profile)) return [];
  return duePeriodicReportPeriods(dateKey(new Date(run.startedAt), profile.businessTimeZone));
}

function periodReportKey(period: PeriodicReportPeriod): string {
  return `${period.kind}:${period.startDate}:${period.endDate}`;
}

function pendingReportKeys(
  runs: readonly DailyAutomationRun[],
  profile: BusinessProfile,
): string[] {
  return runs.flatMap((run) => duePeriodsForRun(run, profile).map(periodReportKey));
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

function scopedProductNames(profile: BusinessProfile, rows: Record<string, unknown>[]): string[] {
  const configured = [...new Set(
    (profile.tiktok.autoEnrollNewProducts ? [] : profile.tiktok.includedCanonicalProducts ?? [])
      .map((name) => name.trim()).filter(Boolean),
  )];
  if (configured.length > 0) return configured;
  return [...new Set(rows
    .filter((row) => !isStoreRow(row, profile))
    .map((row) => cellText(row.商品))
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function buildProductDays(
  rows: Record<string, unknown>[],
  dates: string[],
  productNames: string[],
  profile: BusinessProfile,
): ProductDayMetric[] {
  return dates.flatMap((date) => productNames.map((name) => {
    const matches = rows.filter((row) => (
      !isStoreRow(row, profile)
      && rowDate(row, profile.businessTimeZone) === date
      && cellText(row.商品) === name
    ));
    const source = matches.length === 1 ? matches[0] : null;
    return {
      date,
      name,
      rowCount: matches.length,
      orders: metric(source, ["单量"]),
      items: metric(source, ["数量"]),
      sales: metric(source, ["销售额"]),
      cooperation: metric(source, ["合作量"]),
      online: metric(source, ["上线量"]),
      coreFallback: false,
    };
  }));
}

/**
 * A newly connected store cannot truthfully have rows from before its Base was
 * integrated. Account-side periodic reports already clip to their first and
 * latest complete rows; store-side monthly reports must follow the same rule
 * instead of suppressing the whole month. We select the latest contiguous
 * structurally complete window inside the requested calendar month. Core paid
 * metrics may still use the existing read-only Order API fallback later, but
 * cooperation/online rows must already be unique and explicit in Base.
 */
function effectiveReportPeriod(
  requested: PeriodicReportPeriod,
  rows: Record<string, unknown>[],
  productNames: string[],
  profile: BusinessProfile,
): PeriodicReportPeriod {
  if (requested.kind !== "monthly" || productNames.length === 0) return requested;
  const requestedDates = isoDateRange(requested.startDate, requested.endDate);
  const reportable = new Set(requestedDates.filter((date) => (
    structurallyCompleteDisplayDate(rows, date, productNames, profile)
  )));
  const endDate = [...reportable].sort().at(-1);
  if (!endDate) return requested;
  let startDate = endDate;
  for (
    let prior = shiftIsoDate(startDate, -1);
    prior >= requested.startDate && reportable.has(prior);
    prior = shiftIsoDate(prior, -1)
  ) startDate = prior;
  const days = isoDateRange(startDate, endDate).length;
  const previousEndDate = shiftIsoDate(startDate, -1);
  const previousStartDate = shiftIsoDate(previousEndDate, -(days - 1));
  return {
    kind: requested.kind,
    startDate,
    endDate,
    previousStartDate,
    previousEndDate,
  };
}

function structurallyCompleteDisplayDate(
  rows: Record<string, unknown>[],
  displayDate: string,
  productNames: string[],
  profile: BusinessProfile,
): boolean {
  const performanceDate = shiftIsoDate(displayDate, -1);
  const displayProducts = buildProductDays(rows, [displayDate], productNames, profile);
  const performanceProducts = buildProductDays(rows, [performanceDate], productNames, profile);
  const merged = mergeDisplayDateCooperation(performanceProducts, displayProducts);
  const displayStoreRows = rows.filter((row) => (
    isStoreRow(row, profile) && rowDate(row, profile.businessTimeZone) === displayDate
  ));
  const performanceStoreRows = rows.filter((row) => (
    isStoreRow(row, profile) && rowDate(row, profile.businessTimeZone) === performanceDate
  ));
  return displayStoreRows.length === 1
    && performanceStoreRows.length === 1
    && metric(displayStoreRows[0] ?? null, ["合作量"]) != null
    && metric(performanceStoreRows[0] ?? null, ["上线量"]) != null
    && merged.every((day) => (
      day.rowCount === 1 && day.cooperation != null && day.online != null
    ));
}

function mergeDisplayDateCooperation(
  performanceDays: ProductDayMetric[],
  displayDays: ProductDayMetric[],
): ProductDayMetric[] {
  const liveByKey = new Map(displayDays.map((day) => [`${day.date}\u0000${day.name}`, day]));
  return performanceDays.map((day) => {
    const live = liveByKey.get(`${shiftIsoDate(day.date, 1)}\u0000${day.name}`);
    return {
      ...day,
      cooperation: live?.rowCount === 1 ? live.cooperation : null,
    };
  });
}

function periodSnapshotNeeded(days: ProductDayMetric[]): boolean {
  return days.length > 0 && days.some((day) => (
    day.rowCount !== 1 || day.orders == null || day.items == null || day.sales == null
  ));
}

function mergePaidSnapshot(
  days: ProductDayMetric[],
  snapshots: readonly DailyReportPaidProductSnapshot[],
): ProductDayMetric[] {
  const counts = new Map<string, number>();
  for (const snapshot of snapshots) {
    const key = `${snapshot.date}\u0000${snapshot.name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const byKey = new Map(snapshots.map((snapshot) => [
    `${snapshot.date}\u0000${snapshot.name}`,
    snapshot,
  ]));
  return days.map((day) => {
    const key = `${day.date}\u0000${day.name}`;
    const snapshot = counts.get(key) === 1 ? byKey.get(key) : null;
    if (!snapshot || day.rowCount > 1) return day;
    return {
      ...day,
      orders: day.orders ?? snapshot.orders,
      items: day.items ?? snapshot.items,
      sales: day.sales ?? snapshot.sales,
      coreFallback: day.rowCount === 0,
    };
  });
}

function aggregateProducts(days: ProductDayMetric[], names: string[]): ProductPeriodMetric[] {
  return names.map((name) => {
    const matches = days.filter((day) => day.name === name);
    return {
      name,
      orders: sumCompleteDays(matches, "orders"),
      items: sumCompleteDays(matches, "items"),
      sales: sumCompleteDays(matches, "sales"),
      cooperation: sumCompleteDays(matches, "cooperation"),
      online: sumCompleteDays(matches, "online"),
    };
  });
}

function sumCompleteDays(
  days: ProductDayMetric[],
  field: "orders" | "items" | "sales" | "cooperation" | "online",
): number | null {
  if (days.length === 0) return null;
  const isCore = field === "orders" || field === "items" || field === "sales";
  if (days.some((day) => (
    day[field] == null
    || (day.rowCount !== 1 && !(isCore && day.rowCount === 0 && day.coreFallback))
  ))) return null;
  return roundMetric(days.reduce((sum, day) => sum + (day[field] ?? 0), 0));
}

function completeMetricTotal(
  products: ProductPeriodMetric[],
  field: "orders" | "items" | "sales",
): number | null {
  if (products.length === 0 || products.some((product) => product[field] == null)) return null;
  return roundMetric(products.reduce((sum, product) => sum + (product[field] ?? 0), 0));
}

function aggregateStoreMetric(
  rows: Record<string, unknown>[],
  dates: string[],
  profile: BusinessProfile,
  field: "合作量" | "上线量" | "总广告花费" | "总广告出单量",
): number | null {
  const values = dates.map((date) => {
    const matches = rows.filter((row) => (
      isStoreRow(row, profile) && rowDate(row, profile.businessTimeZone) === date
    ));
    return matches.length === 1 ? metric(matches[0], [field]) : null;
  });
  if (values.some((value) => value == null)) return null;
  if (values.some((value) => value! < 0)) throw new Error(`${field}不是可靠的非负数`);
  if (field === "总广告出单量" && values.some((value) => value != null && !Number.isInteger(value))) {
    throw new Error(`${field}不是可靠的非负整数`);
  }
  return roundMetric(values.reduce<number>((sum, value) => sum + (value ?? 0), 0));
}

function addDeltaCandidate(
  candidates: DailyReportHighlightCandidate[],
  id: string,
  label: string,
  current: number | null,
  previous: number | null,
  comparisonLabel: string,
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
      ? `${label}较${comparisonLabel}持平（${formatNumber(current)}${unit}）。`
      : `${label}较${comparisonLabel}${direction} ${formatNumber(amount)}${unit}${rate == null ? "" : `（${delta > 0 ? "+" : ""}${rate.toFixed(1)}%）`}。`,
    priority: delta === 0 ? Math.max(20, priority - 45) : priority,
  });
}

function compareProducts(left: ProductPeriodMetric, right: ProductPeriodMetric): number {
  return (right.sales ?? Number.NEGATIVE_INFINITY) - (left.sales ?? Number.NEGATIVE_INFINITY)
    || (right.items ?? Number.NEGATIVE_INFINITY) - (left.items ?? Number.NEGATIVE_INFINITY)
    || (right.orders ?? Number.NEGATIVE_INFINITY) - (left.orders ?? Number.NEGATIVE_INFINITY)
    || left.name.localeCompare(right.name, "zh-CN");
}

function formatProductLine(product: ProductPeriodMetric, currencyCode?: string | null): string {
  return `• ${product.name}｜${formatMetricPair(product.orders, product.items)}｜${product.sales == null ? "销售额 —" : formatMoney(product.sales, currencyCode)}｜合作 ${formatCount(product.cooperation)}｜上线 ${formatCount(product.online)}`;
}

function formatMetricPair(orders: number | null, items: number | null): string {
  if (orders == null || items == null) return "—";
  return `${formatNumber(orders)}单 / ${formatNumber(items)}件`;
}

function formatCount(value: number | null): string {
  return value == null ? "—" : formatNumber(value);
}

function formatPeriod(period: PeriodicReportPeriod): string {
  if (period.kind === "monthly") {
    const [year, month] = period.startDate.split("-").map(Number);
    const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    if (period.startDate.endsWith("-01") && period.endDate === monthEnd) return `${year}年${month}月`;
  }
  const [startYear, startMonth, startDay] = period.startDate.split("-").map(Number);
  const [endYear, endMonth, endDay] = period.endDate.split("-").map(Number);
  if (startYear === endYear && startMonth === endMonth) {
    return `${startMonth}月${startDay}日–${endMonth}月${endDay}日`;
  }
  if (startYear === endYear) return `${startMonth}月${startDay}日–${endMonth}月${endDay}日`;
  return `${startYear}年${startMonth}月${startDay}日–${endYear}年${endMonth}月${endDay}日`;
}

function isStoreRow(row: Record<string, unknown>, profile: BusinessProfile): boolean {
  const product = cellText(row.商品);
  const type = cellText(row.记录类型);
  return product === profile.storeAggregateLabel || product === "店铺汇总" || /店铺|汇总/.test(type);
}

function metric(row: Record<string, unknown> | null, fields: string[]): number | null {
  if (!row) return null;
  for (const field of fields) {
    const value = numberValue(row[field]);
    if (value != null) return value;
  }
  return null;
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
  return cellText(value).match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}

function firstOfMonth(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

function isoWeekday(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function isoDateRange(startDate: string, endDate: string): string[] {
  assertIsoDate(startDate);
  assertIsoDate(endDate);
  if (startDate > endDate) throw new Error(`报告周期倒置：${startDate} > ${endDate}`);
  const values: string[] = [];
  for (let cursor = startDate; cursor <= endDate; cursor = shiftIsoDate(cursor, 1)) {
    values.push(cursor);
  }
  return values;
}

function assertIsoDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || dateKey(new Date(`${value}T00:00:00Z`), "UTC") !== value) {
    throw new Error(`日期无效：${value}`);
  }
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

function roundMetric(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
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
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_200));
    }
  }
  throw firstError;
}

function pruneDeliveries(
  deliveries: PeriodicGroupReportState["deliveries"],
  handledReportKeys: string[],
): PeriodicGroupReportState["deliveries"] {
  return Object.fromEntries(
    Object.entries(deliveries).filter(([reportKey]) => handledReportKeys.includes(reportKey)),
  );
}

function skipped(reason: string): PeriodicGroupReportResult {
  return { skipped: true, reason, reports: [], deliveries: [] };
}
