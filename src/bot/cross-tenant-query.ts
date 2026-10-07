import type {
  CrossTenantIntent,
  CrossTenantMetric,
  CrossTenantQuestionPlan,
  ModelProvider,
} from "../ai/types.js";
import type { BusinessProfile } from "../config/business-profile.js";
import type { DataSource, DataRow, TableData } from "../types/index.js";
import { normalizeText, parseNumber, toDateKey } from "../utils/value.js";

export interface CrossTenantRuntime {
  id: string;
  displayName: string;
  aliases: string[];
  profile: BusinessProfile;
  dataSource: DataSource;
  queryConcurrency: number;
}

export interface CrossTenantConversationContext {
  lastQuestion: string | null;
  lastIntent: CrossTenantIntent | null;
  lastMetric: CrossTenantMetric | null;
  lastDays: number | null;
  lastStartDate: string | null;
  lastEndDate: string | null;
  lastTenantIds: string[];
  recentUserMessages: string[];
  recentAssistantMessages: string[];
  updatedAt: number;
}

export type CrossTenantResolution =
  | { kind: "single"; tenantId: string; question: string; context: CrossTenantConversationContext }
  | { kind: "answer"; text: string; context: CrossTenantConversationContext };

interface StoreSnapshot {
  runtime: CrossTenantRuntime;
  table: TableData;
  productRows: DataRow[];
  aggregateRows: DataRow[];
  coverageRows: DataRow[];
  latestDate: string | null;
  earliestDate: string | null;
  productField: string;
  dateField: string;
  productMetricField: string;
  storeMetricField: string;
  currencyCode: string | null;
}

export function emptyCrossTenantContext(): CrossTenantConversationContext {
  return {
    lastQuestion: null,
    lastIntent: null,
    lastMetric: null,
    lastDays: null,
    lastStartDate: null,
    lastEndDate: null,
    lastTenantIds: [],
    recentUserMessages: [],
    recentAssistantMessages: [],
    updatedAt: 0,
  };
}

export class CrossTenantQueryService {
  public constructor(
    private readonly runtimes: CrossTenantRuntime[],
    private readonly provider: ModelProvider,
    private readonly executeTenant: <T>(tenantId: string, limit: number, operation: () => Promise<T>) => Promise<T> = async (_tenantId, _limit, operation) => operation(),
  ) {}

  public async resolve(
    question: string,
    context: CrossTenantConversationContext,
  ): Promise<CrossTenantResolution> {
    const local = localCrossTenantPlan(question, this.runtimes, context);
    const model = this.provider.understandCrossTenantQuestion
      ? await this.provider.understandCrossTenantQuestion(question, {
          stores: this.runtimes.map((runtime) => ({
            id: runtime.id,
            name: runtime.displayName,
            aliases: runtime.aliases,
          })),
          recentUserMessages: context.recentUserMessages,
          recentAssistantMessages: context.recentAssistantMessages,
          lastQuestion: context.lastQuestion,
          lastIntent: context.lastIntent,
          lastMetric: context.lastMetric,
          lastDays: context.lastDays,
          lastStartDate: context.lastStartDate,
          lastEndDate: context.lastEndDate,
          lastTenantIds: context.lastTenantIds,
        })
      : null;
    const plan = chooseSafePlan(question, this.runtimes, context, local, model);
    const next = updateContext(context, question, plan);

    if (plan.intent === "single_store_query" && plan.tenantIds.length === 1) {
      return {
        kind: "single",
        tenantId: plan.tenantIds[0],
        question: plan.delegatedQuestion || question,
        context: next,
      };
    }
    if (plan.intent === "store_list") {
      const text = [
        `🏪 私聊工作区已接入 ${this.runtimes.length} 家店：`,
        "",
        ...this.runtimes.map((runtime, index) => `${index + 1}. ${runtime.displayName}`),
        "",
        "可以直接问“最近7天哪家店销售额最高”，或带上店名查询某一家。店铺设置类命令也必须写明店名。",
      ].join("\n");
      return { kind: "answer", text, context: rememberAnswer(next, text) };
    }
    if (plan.intent === "unknown") {
      const text = [
        "我没有替你猜默认店铺，免得查串。🙂",
        "",
        `请在问题里带上店名（${this.runtimes.map((runtime) => runtime.displayName).join(" / ")}），`,
        "或直接说“比较所有店最近7天销售额/销量”。",
      ].join("\n");
      return { kind: "answer", text, context: rememberAnswer(next, text) };
    }
    const text = await this.answerCrossStore(plan);
    return { kind: "answer", text, context: rememberAnswer(next, text) };
  }

  private async answerCrossStore(plan: CrossTenantQuestionPlan): Promise<string> {
    const selected = plan.tenantIds.length > 0
      ? this.runtimes.filter((runtime) => plan.tenantIds.includes(runtime.id))
      : this.runtimes;
    if (selected.length < 2) {
      return "⚠️ 跨店比较至少需要两家已启用店铺；当前选择范围不足两家，所以我没有强行给出排名。";
    }
    const loaded = await Promise.allSettled(selected.map((runtime) => this.executeTenant(
      runtime.id,
      runtime.queryConcurrency,
      () => loadSnapshot(runtime, plan.metric),
    )));
    const snapshots = loaded
      .filter((item): item is PromiseFulfilledResult<StoreSnapshot> => item.status === "fulfilled")
      .map((item) => item.value)
      .filter((snapshot) => snapshot.latestDate);
    const failures = loaded
      .map((item, index) => item.status === "rejected" ? selected[index].displayName : null)
      .filter((name): name is string => Boolean(name));
    const emptyStores = loaded
      .map((item, index) => item.status === "fulfilled" && !item.value.latestDate ? selected[index].displayName : null)
      .filter((name): name is string => Boolean(name));
    if (snapshots.length < 2) {
      return [
        "⚠️ 这次没有完成跨店比较，我没有拿单店数据冒充两店结果。",
        "",
        `✅ 本次可读：${snapshots.length > 0 ? snapshots.map((snapshot) => snapshot.runtime.displayName).join("、") : "无"}`,
        failures.length > 0 ? `🔄 瞬时读取失败：${failures.join("、")}` : null,
        emptyStores.length > 0 ? `📭 暂无可比较日报：${emptyStores.join("、")}` : null,
        "",
        "请稍后原样重试即可；不用改写问题。",
      ].filter((line): line is string => line !== null).join("\n");
    }
    const commonLatest = snapshots.map((snapshot) => snapshot.latestDate!).sort()[0];
    const requestedEnd = plan.endDate && plan.endDate < commonLatest ? plan.endDate : commonLatest;
    const requestedStart = plan.startDate ?? shiftDateKey(requestedEnd, -(plan.days - 1));
    const commonEarliest = snapshots.map((snapshot) => snapshot.earliestDate!).sort().at(-1)!;
    const start = requestedStart > commonEarliest ? requestedStart : commonEarliest;
    const end = requestedEnd;
    if (start > end) {
      return [
        "⚠️ 这个日期范围目前还没有两家店都覆盖的数据。",
        "",
        `📅 你要求：${requestedStart} 至 ${requestedEnd}`,
        `📚 两家店共同有数据的起点：${commonEarliest}`,
        "",
        "请先补齐相同日期的数据，再做跨店比较。",
      ].join("\n");
    }
    const expectedDates = calendarDates(start, end);
    const requestedDates = calendarDates(requestedStart, requestedEnd);
    const truncatedDays = requestedDates.length - expectedDates.length;
    const coverageGaps = snapshots.map((snapshot) => {
      const present = new Set(snapshot.coverageRows.map((row) => toDateKey(row[snapshot.dateField])).filter(Boolean));
      return { snapshot, missing: expectedDates.filter((date) => !present.has(date)) };
    }).filter((item) => item.missing.length > 0);
    if (coverageGaps.length > 0) {
      return [
        "⚠️ 我先不排高低：各店在同一日期范围内的数据覆盖不一致。",
        "",
        `📅 你要求：${requestedStart} 至 ${requestedEnd}（${requestedDates.length}日）`,
        `📚 当前共同可比：${start} 至 ${end}（${expectedDates.length}日）`,
        ...coverageGaps.map((item) => `• ${item.snapshot.runtime.displayName} 缺少：${item.missing.slice(0, 8).join("、")}${item.missing.length > 8 ? ` 等${item.missing.length}天` : ""}`),
        "",
        "🎯 先把缺失日期补齐再比较，避免把少记的数据误判成经营较差。",
      ].join("\n");
    }
    const values = snapshots.map((snapshot) => aggregateStore(snapshot, start, end));
    const metricLabel = metricDisplay(plan.metric);
    const unit = metricUnit(plan.metric);
    const currencyCodes = [...new Set(values.map((value) => value.currencyCode).filter(Boolean))];
    const comparableMoney = plan.metric !== "sales" || currencyCodes.length === 1;

    if (plan.intent === "product_ranking") {
      const products = snapshots.flatMap((snapshot) => aggregateProducts(snapshot, start, end));
      if (products.length === 0) {
        return [
          "📭 两家店在共同日期范围内还没有可比较的商品经营数据。",
          "",
          rangeNotice(requestedStart, requestedEnd, start, end, truncatedDays),
          "我没有为了凑排名而把空值当成真实销量或销售额。",
        ].join("\n");
      }
      if (!comparableMoney) return mixedCurrencyText(values, start, end, failures);
      products.sort((left, right) => right.value - left.value || left.product.localeCompare(right.product, "zh-CN"));
      const top = products.slice(0, 5);
      const leaders = top.filter((item) => item.value === top[0].value);
      const conclusion = leaders.length > 1
        ? `📌 结论：最高值并列，共有 ${leaders.length} 个商品；没有唯一第一。`
        : `📌 结论：${top[0].runtime.displayName} 的“${top[0].product}”排第一。`;
      return [
        conclusion,
        "",
        rangeNotice(requestedStart, requestedEnd, start, end, truncatedDays),
        `📊 指标：${metricLabel}`,
        "",
        ...top.map((item, index) => `${medal(index)} ${item.runtime.displayName}｜${item.product}：${formatMetric(item.value, plan.metric, item.currencyCode, unit)}`),
        failures.length > 0 ? `\n⚠️ 未纳入：${failures.join("、")}（本次读取失败）` : null,
        "",
        leaders.length > 1
          ? "🎯 总结：这些商品当前数值相同，不按店名或商品名强行分胜负。"
          : `🎯 总结：冠军商品来自 ${top[0].runtime.displayName}，不是把不同店铺的同名商品混在一起计算。`,
      ].filter((line): line is string => line !== null).join("\n");
    }

    if (!comparableMoney) return mixedCurrencyText(values, start, end, failures);
    values.sort((left, right) => right.value - left.value || left.runtime.displayName.localeCompare(right.runtime.displayName, "zh-CN"));
    const leaders = values.filter((item) => item.value === values[0].value);
    const title = plan.intent === "cross_summary"
      ? leaders.length > 1
        ? `📌 ${expectedDates.length}日跨店概览：${leaders.length} 家店并列，没有唯一第一。`
        : `📌 ${expectedDates.length}日跨店概览：${values[0].runtime.displayName} 暂居第一。`
      : leaders.length > 1
        ? `📌 结论：${leaders.length} 家店的${metricLabel}并列最高，没有唯一赢家。`
        : `📌 结论：${values[0].runtime.displayName} 的${metricLabel}最高。`;
    return [
      title,
      "",
      rangeNotice(requestedStart, requestedEnd, start, end, truncatedDays),
      `📊 指标：${metricLabel}`,
      "",
      ...values.map((item, index) => `${medal(index)} ${item.runtime.displayName}：${formatMetric(item.value, plan.metric, item.currencyCode, unit)}`),
      failures.length > 0 ? `\n⚠️ 未纳入：${failures.join("、")}（本次读取失败）` : null,
      "",
      `🎯 总结：本次只比较共同日期范围，避免数据更新较快的店铺天然占便宜。`,
    ].filter((line): line is string => line !== null).join("\n");
  }
}

export function localCrossTenantPlan(
  question: string,
  runtimes: CrossTenantRuntime[],
  context: CrossTenantConversationContext,
): CrossTenantQuestionPlan {
  const text = normalizeText(question);
  const mentioned = runtimes.filter((runtime) => (
    [runtime.id, runtime.displayName, ...runtime.aliases]
      .map(normalizeText)
      .filter(Boolean)
      .some((alias) => text.includes(alias))
  )).map((runtime) => runtime.id);
  const explicitRange = parseExplicitRange(question);
  const days = parseDays(question) ?? (isFollowUp(question) ? context.lastDays : null) ?? 7;
  const metric: CrossTenantMetric = /销量|售出|数量|多少件/.test(question)
    ? "quantity"
    : /单量|订单|多少单/.test(question)
      ? "orders"
      : /销售额|成交额|gmv|金额|卖得|卖的|最好/.test(question)
        ? "sales"
        : (isFollowUp(question) ? context.lastMetric : null) ?? "sales";
  const list = /^(?:菜单|帮助|有哪些店|店铺列表|列出店铺|接了哪些店|现在有几家店|店铺配置)$/.test(text);
  const product = /商品|产品|货品|哪个货|哪款/.test(question);
  const cross = /跨店|所有店|全部店|各店|每家店|店铺对比|哪家店|哪个店铺|来自.*店|分别/.test(question);
  const ranking = /最高|最多|最好|第一|排名|排行|对比|比较/.test(question);
  let intent: CrossTenantIntent = "unknown";
  let tenantIds = mentioned;
  if (list) intent = "store_list";
  else if (cross || (ranking && /店铺|店/.test(question))) intent = product ? "product_ranking" : "store_ranking";
  else if (mentioned.length === 1) intent = "single_store_query";
  else if (isFollowUp(question) && context.lastIntent && context.lastIntent !== "unknown") {
    intent = context.lastIntent;
    tenantIds = context.lastTenantIds;
  }
  return {
    intent,
    metric,
    days,
    startDate: explicitRange?.startDate ?? (isFollowUp(question) ? context.lastStartDate : null),
    endDate: explicitRange?.endDate ?? (isFollowUp(question) ? context.lastEndDate : null),
    tenantIds,
    delegatedQuestion: question,
    confidence: intent === "unknown" ? 0.2 : 0.85,
  };
}

function chooseSafePlan(
  question: string,
  runtimes: CrossTenantRuntime[],
  context: CrossTenantConversationContext,
  local: CrossTenantQuestionPlan,
  model: CrossTenantQuestionPlan | null,
): CrossTenantQuestionPlan {
  if (!model || model.confidence < 0.55) return normalizePlan(local, runtimes);
  const mentioned = local.tenantIds;
  const selected = { ...model, tenantIds: [...model.tenantIds] };
  if (local.startDate) {
    selected.startDate = local.startDate;
    selected.endDate = local.endDate;
  }
  if (mentioned.length > 0) selected.tenantIds = mentioned;
  if (selected.intent === "single_store_query" && selected.tenantIds.length !== 1) {
    return normalizePlan(local, runtimes);
  }
  if (selected.intent !== "single_store_query" && selected.intent !== "unknown" && selected.intent !== "store_list") {
    if (selected.tenantIds.length === 0) selected.tenantIds = runtimes.map((runtime) => runtime.id);
  }
  if (selected.intent === "unknown" && local.intent !== "unknown") return normalizePlan(local, runtimes);
  if (selected.intent === "single_store_query" && mentioned.length === 0 && context.lastTenantIds.length !== 1) {
    return normalizePlan(local, runtimes);
  }
  selected.delegatedQuestion ||= question;
  return normalizePlan(selected, runtimes);
}

function normalizePlan(plan: CrossTenantQuestionPlan, runtimes: CrossTenantRuntime[]): CrossTenantQuestionPlan {
  const allowed = new Set(runtimes.map((runtime) => runtime.id));
  const tenantIds = [...new Set(plan.tenantIds.filter((id) => allowed.has(id)))];
  return {
    ...plan,
    days: Math.max(1, Math.min(365, Math.trunc(plan.days || 7))),
    startDate: isDateKey(plan.startDate) ? plan.startDate : null,
    endDate: isDateKey(plan.endDate) ? plan.endDate : null,
    tenantIds: plan.intent !== "single_store_query" && tenantIds.length === 0
      ? runtimes.map((runtime) => runtime.id)
      : tenantIds,
  };
}

async function loadSnapshot(runtime: CrossTenantRuntime, metric: CrossTenantMetric): Promise<StoreSnapshot> {
  const table = await runtime.dataSource.getTable(`${runtime.profile.tables.roi} 商品 日期 销售额 数量 单量`);
  const productField = firstAvailable(table.headers, ["商品", "产品"]);
  const dateField = firstAvailable(table.headers, ["日期"]);
  const productMetricField = firstAvailable(table.headers, metric === "sales"
    ? ["销售额", "成交额", "GMV"]
    : metric === "quantity"
      ? ["数量"]
      : ["单量"]);
  const storeMetricField = firstAvailable(table.headers, metric === "sales"
    ? ["店铺销售额", "总销售额", "销售额", "成交额", "GMV"]
    : metric === "quantity"
      ? ["总数量", "数量"]
      : ["总单量", "单量"]);
  if (!productField || !dateField || !productMetricField || !storeMetricField) {
    throw new Error(`${runtime.displayName}投产比缺少商品、日期或${metricDisplay(metric)}字段`);
  }
  const aggregateNames = new Set([
    normalizeText(runtime.profile.storeAggregateLabel),
    normalizeText("店铺汇总"),
  ]);
  const datedRows = table.rows.filter((row) => Boolean(toDateKey(row[dateField])));
  const aggregateRows = datedRows.filter((row) => {
    const product = cellText(row[productField]);
    return product && aggregateNames.has(normalizeText(product));
  });
  const productRows = datedRows.filter((row) => {
    const product = cellText(row[productField]);
    return product && !aggregateNames.has(normalizeText(product));
  });
  const coverageRows = aggregateRows.length > 0 ? aggregateRows : productRows;
  const coverageDates = coverageRows
    .map((row) => toDateKey(row[dateField]))
    .filter((date): date is string => Boolean(date))
    .sort();
  return {
    runtime,
    table,
    productRows,
    aggregateRows,
    coverageRows,
    latestDate: coverageDates.at(-1) ?? null,
    earliestDate: coverageDates[0] ?? null,
    productField,
    dateField,
    productMetricField,
    storeMetricField,
    currencyCode: runtime.profile.tiktok.currencyCode ?? null,
  };
}

function aggregateStore(snapshot: StoreSnapshot, start: string, end: string) {
  const sourceRows = snapshot.aggregateRows.length > 0 ? snapshot.aggregateRows : snapshot.productRows;
  const metricField = snapshot.aggregateRows.length > 0 ? snapshot.storeMetricField : snapshot.productMetricField;
  const value = sourceRows.reduce((sum, row) => {
    const date = toDateKey(row[snapshot.dateField]);
    return date && date >= start && date <= end ? sum + (parseNumber(row[metricField]) ?? 0) : sum;
  }, 0);
  return { runtime: snapshot.runtime, value, currencyCode: snapshot.currencyCode };
}

function aggregateProducts(snapshot: StoreSnapshot, start: string, end: string) {
  const sums = new Map<string, number>();
  for (const row of snapshot.productRows) {
    const date = toDateKey(row[snapshot.dateField]);
    if (!date || date < start || date > end) continue;
    const product = cellText(row[snapshot.productField]);
    if (!product) continue;
    sums.set(product, (sums.get(product) ?? 0) + (parseNumber(row[snapshot.productMetricField]) ?? 0));
  }
  return [...sums.entries()].map(([product, value]) => ({
    runtime: snapshot.runtime,
    product,
    value,
    currencyCode: snapshot.currencyCode,
  }));
}

function updateContext(
  context: CrossTenantConversationContext,
  question: string,
  plan: CrossTenantQuestionPlan,
): CrossTenantConversationContext {
  return {
    ...context,
    lastQuestion: question,
    lastIntent: plan.intent,
    lastMetric: plan.metric,
    lastDays: plan.days,
    lastStartDate: plan.startDate,
    lastEndDate: plan.endDate,
    lastTenantIds: [...plan.tenantIds],
    recentUserMessages: [...context.recentUserMessages, question].slice(-8),
    updatedAt: Date.now(),
  };
}

function rememberAnswer(context: CrossTenantConversationContext, answer: string): CrossTenantConversationContext {
  return {
    ...context,
    recentAssistantMessages: [...context.recentAssistantMessages, answer.slice(0, 2_000)].slice(-4),
    updatedAt: Date.now(),
  };
}

function parseDays(question: string): number | null {
  const matched = question.match(/(?:最近|近|过去|前)\s*(\d{1,3})\s*(?:天|日)/);
  if (matched) return Math.max(1, Math.min(365, Number(matched[1])));
  const chinese: Record<string, number> = { 七: 7, 十: 10, 十五: 15, 二十: 20, 三十: 30, 三十一: 31 };
  const natural = question.match(/(?:最近|近|过去|前)\s*([七十十五二三一]+)\s*(?:天|日)/);
  return natural ? chinese[natural[1]] ?? null : null;
}

function parseExplicitRange(question: string): { startDate: string; endDate: string | null } | null {
  const matches = [...question.matchAll(/(20\d{2})\s*(?:年|[./-])\s*(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})\s*(?:日|号)?/g)]
    .map((match) => validDateKey(match[1], match[2], match[3]))
    .filter((value): value is string => Boolean(value));
  if (matches.length >= 2) return { startDate: matches[0], endDate: matches[1] };
  if (matches.length === 1 && /(?:至|到|截至)\s*(?:今|今天|现在)/.test(question)) {
    return { startDate: matches[0], endDate: null };
  }
  return null;
}

function validDateKey(year: string, month: string, day: string): string | null {
  const value = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function isDateKey(value: string | null | undefined): value is string {
  return Boolean(value && /^20\d{2}-\d{2}-\d{2}$/.test(value));
}

function isFollowUp(question: string): boolean {
  return /^(?:那|那么|再|然后|销量呢|销售额呢|单量呢|这个月呢|最近呢|同样范围)/.test(question.trim());
}

function firstAvailable(headers: string[], candidates: string[]): string | null {
  return candidates.find((candidate) => headers.includes(candidate)) ?? null;
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join("、");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return cellText(record.text ?? record.name ?? record.value ?? "");
  }
  return String(value).trim();
}

function shiftDateKey(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function calendarDates(start: string, end: string): string[] {
  const dates: string[] = [];
  let current = start;
  while (current <= end && dates.length <= 366) {
    dates.push(current);
    current = shiftDateKey(current, 1);
  }
  return dates;
}

function metricDisplay(metric: CrossTenantMetric): string {
  if (metric === "sales") return "销售额";
  if (metric === "quantity") return "销量";
  return "单量";
}

function metricUnit(metric: CrossTenantMetric): string {
  return metric === "quantity" ? "件" : metric === "orders" ? "单" : "";
}

function formatMetric(value: number, metric: CrossTenantMetric, currencyCode: string | null, unit: string): string {
  if (metric === "sales") return `${formatNumber(value)} ${currencyCode ?? "（币种未配置）"}`;
  return `${formatNumber(value)}${unit}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

function medal(index: number): string {
  return ["🥇", "🥈", "🥉"][index] ?? `${index + 1}.`;
}

function rangeNotice(
  requestedStart: string,
  requestedEnd: string,
  actualStart: string,
  actualEnd: string,
  truncatedDays: number,
): string {
  const requestedDays = calendarDates(requestedStart, requestedEnd).length;
  const actualDays = calendarDates(actualStart, actualEnd).length;
  if (truncatedDays <= 0) {
    return `📅 公平口径：${actualStart} 至 ${actualEnd}（完整${actualDays}日）`;
  }
  return [
    `📅 你要求：${requestedStart} 至 ${requestedEnd}（${requestedDays}日）`,
    `📚 实际可比：${actualStart} 至 ${actualEnd}（${actualDays}日）`,
    `⚠️ 前面缺 ${truncatedDays} 日共同数据；以下只代表已有的 ${actualDays} 日，不冒充完整 ${requestedDays} 日。`,
  ].join("\n");
}

function mixedCurrencyText(
  values: Array<{ runtime: CrossTenantRuntime; value: number; currencyCode: string | null }>,
  start: string,
  end: string,
  failures: string[],
): string {
  return [
    "⚠️ 这几家店使用的币种不同，我没有硬排销售额高低。",
    "",
    `📅 共同范围：${start} 至 ${end}`,
    ...values.map((item) => `• ${item.runtime.displayName}：${formatNumber(item.value)} ${item.currencyCode ?? "币种未配置"}`),
    failures.length > 0 ? `• 本次读取失败：${failures.join("、")}` : null,
    "",
    "🎯 如需跨币种比较，请先确定统一汇率和换算日期；否则原币金额不能直接排名。",
  ].filter((line): line is string => line !== null).join("\n");
}
