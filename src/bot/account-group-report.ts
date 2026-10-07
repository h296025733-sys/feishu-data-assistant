import type { BusinessProfile } from "../config/business-profile.js";
import { isFeishuQuotaOrRateLimitError } from "../feishu/client.js";
import { shiftIsoDate } from "../realtime/business-time.js";
import type { DataSource, TableData } from "../types/index.js";
import type { PeriodicReportPeriod } from "./periodic-group-report.js";

export type AccountGroupReportKind = "daily" | "weekly" | "monthly";

export interface AccountGroupReport {
  tenantId: string;
  reportKey: string;
  kind: AccountGroupReportKind;
  sendDate: string;
  startDate: string;
  endDate: string;
  latestAvailableDate: string;
  dataReadOk: boolean;
  dataComplete: boolean;
  dataReadError: string | null;
  card: Record<string, unknown>;
  text: string;
}

export async function buildAccountGroupReports(input: {
  tenantId: string;
  profile: BusinessProfile;
  dataSource: DataSource;
  sendDate: string;
  periodicPeriods?: readonly PeriodicReportPeriod[];
}): Promise<AccountGroupReport[]> {
  let table: TableData;
  try {
    table = await readAccountTable(input.dataSource);
  } catch (error) {
    throw new Error(`账号端报告读取失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const storeRows = table.rows.filter((row) => isStoreAccountRow(row, input.profile));
  const rowsByDate = new Map<string, Record<string, unknown>[]>();
  for (const row of storeRows) {
    const date = rowDate(row, input.profile.businessTimeZone);
    if (!date || date > input.sendDate) continue;
    const values = rowsByDate.get(date) ?? [];
    values.push(row);
    rowsByDate.set(date, values);
  }
  const availableDates = [...rowsByDate]
    .filter(([, rows]) => rows.length === 1 && rowIsComplete(rows[0]!))
    .map(([date]) => date)
    .sort();
  const latestAvailableDate = availableDates.at(-1);
  if (!latestAvailableDate) throw new Error("账号投产比没有可用于报告的完整店铺汇总日");

  const reports: AccountGroupReport[] = [];
  reports.push(buildOne({
    ...input,
    table,
    rowsByDate,
    latestAvailableDate,
    kind: "daily",
    startDate: latestAvailableDate,
    endDate: latestAvailableDate,
  }));

  const earliestAvailableDate = availableDates[0]!;
  for (const period of input.periodicPeriods ?? []) {
    const startDate = laterDate(period.startDate, earliestAvailableDate);
    const endDate = earlierDate(period.endDate, latestAvailableDate);
    if (startDate > endDate) {
      throw new Error(
        `账号端${period.kind === "weekly" ? "周报" : "月报"}尚无该周期完整数据：`
        + `${period.startDate}..${period.endDate}，最新仅到${latestAvailableDate}`,
      );
    }
    reports.push(buildOne({
      ...input,
      table,
      rowsByDate,
      latestAvailableDate,
      kind: period.kind,
      startDate,
      endDate,
    }));
  }
  return reports;
}

function buildOne(input: {
  tenantId: string;
  profile: BusinessProfile;
  table: TableData;
  rowsByDate: Map<string, Record<string, unknown>[]>;
  sendDate: string;
  latestAvailableDate: string;
  kind: AccountGroupReportKind;
  startDate: string;
  endDate: string;
}): AccountGroupReport {
  const dates = isoDateRange(input.startDate, input.endDate);
  const rows = dates.map((date) => {
    const matches = input.rowsByDate.get(date) ?? [];
    if (matches.length !== 1) throw new Error(`账号投产比 ${date} 店铺汇总记录数=${matches.length}`);
    const row = matches[0]!;
    if (!rowIsComplete(row)) throw new Error(`账号投产比 ${date} 店铺汇总数据状态不完整`);
    return row;
  });
  const values = rows.map((row, index) => ({
    date: dates[index]!,
    online: requiredNumber(row.上线量, `${dates[index]}.上线量`),
    orders: requiredNumber(row.单量, `${dates[index]}.单量`),
    sales: requiredNumber(row.销售额, `${dates[index]}.销售额`),
    adSpend: optionalNonNegativeNumber(row.广告花费, `${dates[index]}.广告花费`),
    adOrders: optionalNonNegativeInteger(row.广告出单量, `${dates[index]}.广告出单量`),
  }));
  const online = sum(values.map((value) => value.online));
  const orders = sum(values.map((value) => value.orders));
  const sales = roundMoney(sum(values.map((value) => value.sales)));
  // 广告数据来自人工录入。空白与 0 必须严格区分：0 是已确认零花费/零转化，
  // 任意一天空白则对应指标显示“待录入”，不能把缺失值伪装成 0，
  // 也不能因此阻断订单、销售额等已经完整的数据报告。
  const adSpend = values.every((value) => value.adSpend != null)
    ? roundMoney(sum(values.map((value) => value.adSpend!)))
    : null;
  const adOrders = values.every((value) => value.adOrders != null)
    ? sum(values.map((value) => value.adOrders!))
    : null;
  const reportName = input.kind === "daily" ? "账号端日报" : input.kind === "weekly" ? "账号端周报" : "账号端月报";
  const periodLabel = input.kind === "daily"
    ? friendlyDate(input.endDate)
    : formatPeriod(input.startDate, input.endDate, input.kind);
  const dateLabel = input.kind === "daily"
    ? `真实数据日期：**${friendlyDate(input.endDate)}**`
    : `真实数据周期：**${periodLabel}**`;
  const metricLines = [
    `• 上线量：**${formatNumber(online)}**`,
    `• 单量：**${formatNumber(orders)}**`,
    `• 销售额：**${formatMoney(sales, input.profile.tiktok.currencyCode)}**`,
    `• 广告花费：**${adSpend == null ? "待录入" : formatMoney(adSpend, input.profile.tiktok.currencyCode)}**`,
    `• 广告出单量：**${adOrders == null ? "待录入" : formatNumber(adOrders)}**`,
  ];
  const title = `${input.profile.businessDisplayName} ${reportName}｜${periodLabel}`;
  const text = [
    `📱 ${title}`,
    "",
    `🗓️ ${dateLabel.replaceAll("**", "")}`,
    "",
    "【账号端表现】",
    ...metricLines,
  ].join("\n");
  const card: Record<string, unknown> = {
    config: { wide_screen_mode: true, enable_forward: false },
    header: {
      template: input.kind === "daily" ? "turquoise" : input.kind === "weekly" ? "green" : "purple",
      title: { tag: "plain_text", content: title },
    },
    elements: [
      markdown("📣 <at id=all></at>"),
      markdown(`🗓️ ${dateLabel}`),
      markdown(`📱 **账号端表现**\n${metricLines.join("\n")}`),
    ],
  };
  const reportKey = input.kind === "daily"
    ? `account:daily:${input.sendDate}`
    : `account:${input.kind}:${input.startDate}:${input.endDate}`;
  return {
    tenantId: input.tenantId,
    reportKey,
    kind: input.kind,
    sendDate: input.sendDate,
    startDate: input.startDate,
    endDate: input.endDate,
    latestAvailableDate: input.latestAvailableDate,
    dataReadOk: true,
    dataComplete: true,
    dataReadError: null,
    card,
    text,
  };
}

function isStoreAccountRow(row: Record<string, unknown>, profile: BusinessProfile): boolean {
  const account = cellText(row.账号);
  const uid = cellText(row.账号UID);
  const key = cellText(row.检查);
  return (account === profile.businessDisplayName && !uid)
    || key.startsWith(`${profile.businessDisplayName}|${profile.businessDisplayName}|`);
}

function rowIsComplete(row: Record<string, unknown>): boolean {
  const status = cellText(row.数据状态);
  return status === "完整";
}

function rowDate(row: Record<string, unknown>, timeZone: string): string {
  const value = row.日期;
  if (typeof value === "number") {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(value));
  }
  return cellText(value).match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}

function requiredNumber(value: unknown, label: string): number {
  const parsed = numberValue(value);
  if (parsed == null || parsed < 0) throw new Error(`${label}不是可靠的非负数`);
  return parsed;
}

function optionalNonNegativeNumber(value: unknown, label: string): number | null {
  const parsed = numberValue(value);
  if (parsed == null) return null;
  if (parsed < 0) throw new Error(`${label}不是可靠的非负数`);
  return parsed;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | null {
  const parsed = optionalNonNegativeNumber(value, label);
  if (parsed == null) return null;
  if (!Number.isInteger(parsed)) throw new Error(`${label}不是可靠的非负整数`);
  return parsed;
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
    return cellText(object.text ?? object.name ?? object.value ?? object.content ?? "");
  }
  return String(value ?? "").trim();
}

function isoDateRange(startDate: string, endDate: string): string[] {
  if (startDate > endDate) throw new Error(`账号端报告日期倒置：${startDate} > ${endDate}`);
  const values: string[] = [];
  for (let date = startDate; date <= endDate; date = shiftIsoDate(date, 1)) values.push(date);
  return values;
}

function formatPeriod(startDate: string, endDate: string, kind: AccountGroupReportKind): string {
  if (kind === "monthly" && startDate.slice(0, 7) === endDate.slice(0, 7)) {
    const [year, month] = startDate.split("-").map(Number);
    const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    if (startDate.endsWith("-01") && endDate === monthEnd) return `${year}年${month}月`;
    if (startDate.endsWith("-01")) return `${year}年${month}月（截至${friendlyDate(endDate)}）`;
  }
  return `${friendlyDate(startDate)}–${friendlyDate(endDate)}`;
}

function friendlyDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${Number(match[2])}月${Number(match[3])}日` : value;
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

function laterDate(left: string, right: string): string {
  return left >= right ? left : right;
}

function earlierDate(left: string, right: string): string {
  return left <= right ? left : right;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function markdown(content: string): Record<string, unknown> {
  return { tag: "markdown", content };
}

async function readAccountTable(dataSource: DataSource): Promise<TableData> {
  let firstError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await dataSource.getTable("账号投产比");
    } catch (error) {
      firstError ??= error;
      if (attempt === 2 || isFeishuQuotaOrRateLimitError(error)) throw firstError;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_200));
    }
  }
  throw firstError;
}
