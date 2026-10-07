import { z } from "zod";

const nonNegative = z.number().finite().nonnegative();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const productMetricSchema = z.object({
  name: z.string().trim().min(1),
  orders: nonNegative,
  items: nonNegative,
  sales: nonNegative,
  cooperation: nonNegative,
  online: nonNegative,
});

const storeMetricSchema = z.object({
  orders: nonNegative,
  items: nonNegative,
  sales: nonNegative,
  cooperation: nonNegative,
  online: nonNegative,
  adSpend: nonNegative.nullable(),
  adOrders: nonNegative.int().nullable(),
  products: z.array(productMetricSchema).min(1),
});

const accountMetricSchema = z.object({
  online: nonNegative,
  orders: nonNegative,
  sales: nonNegative,
  adSpend: nonNegative.nullable(),
  adOrders: nonNegative.int().nullable(),
});

const periodicSchema = z.object({
  kind: z.enum(["weekly", "monthly"]),
  startDate: isoDate,
  endDate: isoDate,
  accountStartDate: isoDate.optional(),
  accountEndDate: isoDate.optional(),
  store: storeMetricSchema,
  account: accountMetricSchema,
});

const tenantSchema = z.object({
  store: storeMetricSchema.extend({ sourceDate: isoDate }),
  account: accountMetricSchema.extend({ sourceDate: isoDate }),
  periodic: z.array(periodicSchema).default([]),
});

export const quotaTakeoverPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  sendDate: isoDate,
  generatedAt: z.string().datetime({ offset: true }),
  tenants: z.record(z.string().trim().min(1), tenantSchema),
});

export type QuotaTakeoverPayload = z.infer<typeof quotaTakeoverPayloadSchema>;
export type QuotaTakeoverTenant = z.infer<typeof tenantSchema>;
export type QuotaTakeoverPeriod = z.infer<typeof periodicSchema>;

export interface TakeoverReport {
  reportKey: string;
  kind: "daily" | "weekly" | "monthly";
  scope: "store" | "account";
  card: Record<string, unknown>;
  text: string;
}

export function validateQuotaTakeoverPayload(
  value: unknown,
  expectedTenantIds: readonly string[],
): QuotaTakeoverPayload {
  const payload = quotaTakeoverPayloadSchema.parse(value);
  const expected = [...new Set(expectedTenantIds)].sort();
  const actual = Object.keys(payload.tenants).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`接管报告租户集合不匹配：expected=${expected.join(",")} actual=${actual.join(",")}`);
  }
  const weekday = utcCalendarWeekday(payload.sendDate);
  const monthDay = Number(payload.sendDate.slice(-2));
  for (const [tenantId, tenant] of Object.entries(payload.tenants)) {
    if (tenant.store.sourceDate > payload.sendDate || tenant.account.sourceDate > payload.sendDate) {
      throw new Error(`${tenantId} 的真实数据日期晚于发送日期`);
    }
    const periodicKinds = tenant.periodic.map((period) => period.kind);
    if (new Set(periodicKinds).size !== periodicKinds.length) {
      throw new Error(`${tenantId} 存在重复的周报或月报`);
    }
    if (weekday === 0 && !periodicKinds.includes("weekly")) {
      throw new Error(`${tenantId} 的周日接管载荷缺少周报`);
    }
    if (weekday !== 0 && periodicKinds.includes("weekly")) {
      throw new Error(`${tenantId} 非周日却包含周报`);
    }
    if (monthDay === 1 && !periodicKinds.includes("monthly")) {
      throw new Error(`${tenantId} 的每月1日接管载荷缺少月报`);
    }
    if (monthDay !== 1 && periodicKinds.includes("monthly")) {
      throw new Error(`${tenantId} 非每月1日却包含月报`);
    }
    for (const period of tenant.periodic) {
      if (period.startDate > period.endDate || period.endDate > payload.sendDate) {
        throw new Error(`${tenantId} ${period.kind} 日期范围无效`);
      }
      if (Boolean(period.accountStartDate) !== Boolean(period.accountEndDate)) {
        throw new Error(`${tenantId} ${period.kind} 账号端真实周期必须同时提供起止日期`);
      }
      if (period.accountStartDate && period.accountEndDate
        && (period.accountStartDate > period.accountEndDate || period.accountEndDate > period.endDate)) {
        throw new Error(`${tenantId} ${period.kind} 账号端真实周期无效`);
      }
    }
  }
  return payload;
}

export function buildQuotaTakeoverReports(input: {
  tenantId: string;
  storeName: string;
  currencyCode?: string | null;
  sendDate: string;
  tenant: QuotaTakeoverTenant;
}): TakeoverReport[] {
  const reports: TakeoverReport[] = [
    buildStoreDaily(input),
    buildAccountDaily(input),
  ];
  for (const period of [...input.tenant.periodic].sort(periodOrder)) {
    reports.push(buildStorePeriodic(input, period));
    reports.push(buildAccountPeriodic(input, period));
  }
  return reports;
}

function buildStoreDaily(input: {
  tenantId: string;
  storeName: string;
  currencyCode?: string | null;
  sendDate: string;
  tenant: QuotaTakeoverTenant;
}): TakeoverReport {
  const metrics = input.tenant.store;
  const title = `${input.storeName} 经营日报｜${friendlyDate(input.sendDate)}`;
  const overview = storeLines(metrics, input.currencyCode);
  const products = productLines(metrics.products, input.currencyCode);
  const highlights = localHighlights(metrics);
  const text = [
    `📊 ${title}`,
    "",
    `🗓️ 日报日期：${friendlyDate(input.sendDate)}`,
    "",
    "【店铺情况】",
    ...overview.slice(0, 4),
    "",
    "【达人合作情况】",
    ...overview.slice(4),
    "",
    "【商品及达人合作表现】",
    ...products,
    "",
    "【今日简评】",
    ...highlights,
  ].join("\n");
  return {
    reportKey: `takeover:store:daily:${input.sendDate}`,
    kind: "daily",
    scope: "store",
    text,
    card: card(
      "blue",
      title,
      markdown("📣 <at id=all></at>"),
      markdown(`🗓️ **日报日期：${friendlyDate(input.sendDate)}**`),
      markdown(`🏪 **店铺情况**\n${overview.slice(0, 4).join("\n")}`),
      markdown(`🤝 **达人合作情况**\n${overview.slice(4).join("\n")}`),
      markdown(`🛍️ **商品及达人合作表现**\n${products.join("\n")}`),
      markdown(`💡 **今日简评**\n${highlights.join("\n")}`),
    ),
  };
}

function buildAccountDaily(input: {
  tenantId: string;
  storeName: string;
  currencyCode?: string | null;
  sendDate: string;
  tenant: QuotaTakeoverTenant;
}): TakeoverReport {
  const title = `${input.storeName} 账号端日报｜${friendlyDate(input.tenant.account.sourceDate)}`;
  const lines = accountLines(input.tenant.account, input.currencyCode);
  const text = [
    `📱 ${title}`,
    "",
    `🗓️ 真实数据日期：${friendlyDate(input.tenant.account.sourceDate)}`,
    "",
    "【账号端表现】",
    ...lines,
  ].join("\n");
  return {
    reportKey: `takeover:account:daily:${input.sendDate}:${input.tenant.account.sourceDate}`,
    kind: "daily",
    scope: "account",
    text,
    card: card(
      "turquoise",
      title,
      markdown("📣 <at id=all></at>"),
      markdown(`🗓️ 真实数据日期：**${friendlyDate(input.tenant.account.sourceDate)}**`),
      markdown(`📱 **账号端表现**\n${lines.join("\n")}`),
    ),
  };
}

function buildStorePeriodic(
  input: {
    tenantId: string;
    storeName: string;
    currencyCode?: string | null;
    sendDate: string;
    tenant: QuotaTakeoverTenant;
  },
  period: QuotaTakeoverPeriod,
): TakeoverReport {
  const reportName = period.kind === "weekly" ? "经营周报" : "经营月报";
  const label = periodLabel(period);
  const title = `${input.storeName} ${reportName}｜${label}`;
  const overview = storeLines(period.store, input.currencyCode, true);
  const products = productLines(period.store.products, input.currencyCode);
  return {
    reportKey: `takeover:store:${period.kind}:${period.startDate}:${period.endDate}`,
    kind: period.kind,
    scope: "store",
    text: [
      `📊 ${title}`,
      "",
      `🗓️ 统计周期：${label}`,
      "",
      "【店铺情况】",
      ...overview.slice(0, 4),
      "",
      "【达人合作情况】",
      ...overview.slice(4),
      "",
      "【商品及达人合作表现】",
      ...products,
    ].join("\n"),
    card: card(
      period.kind === "weekly" ? "green" : "purple",
      title,
      markdown("📣 <at id=all></at>"),
      markdown(`🗓️ 统计周期：**${label}**`),
      markdown(`🏪 **店铺情况**\n${overview.slice(0, 4).join("\n")}`),
      markdown(`🤝 **达人合作情况**\n${overview.slice(4).join("\n")}`),
      markdown(`🛍️ **商品及达人合作表现**\n${products.join("\n")}`),
    ),
  };
}

function buildAccountPeriodic(
  input: {
    tenantId: string;
    storeName: string;
    currencyCode?: string | null;
    sendDate: string;
    tenant: QuotaTakeoverTenant;
  },
  period: QuotaTakeoverPeriod,
): TakeoverReport {
  const reportName = period.kind === "weekly" ? "账号端周报" : "账号端月报";
  const accountPeriod = {
    ...period,
    startDate: period.accountStartDate ?? period.startDate,
    endDate: period.accountEndDate ?? period.endDate,
  };
  const label = periodLabel(accountPeriod);
  const title = `${input.storeName} ${reportName}｜${label}`;
  const lines = accountLines(period.account, input.currencyCode);
  return {
    reportKey: `takeover:account:${period.kind}:${accountPeriod.startDate}:${accountPeriod.endDate}`,
    kind: period.kind,
    scope: "account",
    text: [
      `📱 ${title}`,
      "",
      `🗓️ 真实数据周期：${label}`,
      "",
      "【账号端表现】",
      ...lines,
    ].join("\n"),
    card: card(
      period.kind === "weekly" ? "green" : "purple",
      title,
      markdown("📣 <at id=all></at>"),
      markdown(`🗓️ 真实数据周期：**${label}**`),
      markdown(`📱 **账号端表现**\n${lines.join("\n")}`),
    ),
  };
}

function storeLines(
  metrics: z.infer<typeof storeMetricSchema>,
  currencyCode?: string | null,
  periodic = false,
): string[] {
  return [
    `• ${periodic ? "本期" : "单日"}单量 / 销量：**${formatNumber(metrics.orders)}单 / ${formatNumber(metrics.items)}件**`,
    `• 销售额：**${formatMoney(metrics.sales, currencyCode)}**`,
    `• 总广告花费：**${metrics.adSpend == null ? "待录入" : formatMoney(metrics.adSpend, currencyCode)}**`,
    `• 总广告出单量：**${metrics.adOrders == null ? "待录入" : formatNumber(metrics.adOrders)}**`,
    `• 合作量：**${formatNumber(metrics.cooperation)}**`,
    `• 上线量：**${formatNumber(metrics.online)}**`,
  ];
}

function productLines(
  products: readonly z.infer<typeof productMetricSchema>[],
  currencyCode?: string | null,
): string[] {
  const active = products.filter((product) => (
    product.orders > 0 || product.items > 0 || product.sales > 0 || product.cooperation > 0 || product.online > 0
  ));
  if (active.length === 0) return ["• 暂无有效商品表现。"];
  return active.map((product) => (
    `• ${product.name}｜${formatNumber(product.orders)}单 / ${formatNumber(product.items)}件`
    + `｜${formatMoney(product.sales, currencyCode)}｜合作 ${formatNumber(product.cooperation)}`
    + `｜上线 ${formatNumber(product.online)}`
  ));
}

function accountLines(
  metrics: z.infer<typeof accountMetricSchema>,
  currencyCode?: string | null,
): string[] {
  return [
    `• 上线量：**${formatNumber(metrics.online)}**`,
    `• 单量：**${formatNumber(metrics.orders)}**`,
    `• 销售额：**${formatMoney(metrics.sales, currencyCode)}**`,
    `• 广告花费：**${metrics.adSpend == null ? "待录入" : formatMoney(metrics.adSpend, currencyCode)}**`,
    `• 广告出单量：**${metrics.adOrders == null ? "待录入" : formatNumber(metrics.adOrders)}**`,
  ];
}

function localHighlights(metrics: z.infer<typeof storeMetricSchema>): string[] {
  if (metrics.orders > 0) {
    const top = [...metrics.products].sort((left, right) => (
      right.orders - left.orders || right.sales - left.sales || left.name.localeCompare(right.name, "zh-CN")
    ))[0];
    return top
      ? [`• 今日形成 ${formatNumber(metrics.orders)} 单付款成交，${top.name}表现居首。`]
      : [`• 今日形成 ${formatNumber(metrics.orders)} 单付款成交。`];
  }
  if (metrics.online > 0) {
    return [`• 今日新增上线 ${formatNumber(metrics.online)} 个，尚未形成付款成交。`];
  }
  if (metrics.cooperation > 0) {
    return [`• 今日新增合作 ${formatNumber(metrics.cooperation)} 个，暂无新增上线及付款成交。`];
  }
  return ["• 今日暂无新增上线或有效付款成交。"]; 
}

function card(template: string, title: string, ...elements: Record<string, unknown>[]): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: { template, title: { tag: "plain_text", content: title } },
    elements,
  };
}

function markdown(content: string): Record<string, unknown> {
  return { tag: "markdown", content };
}

function periodLabel(period: Pick<QuotaTakeoverPeriod, "kind" | "startDate" | "endDate">): string {
  if (period.kind === "monthly" && period.startDate.slice(0, 7) === period.endDate.slice(0, 7)) {
    const [year, month] = period.startDate.split("-").map(Number);
    return `${year}年${month}月`;
  }
  return `${friendlyDate(period.startDate)}–${friendlyDate(period.endDate)}`;
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

function utcCalendarWeekday(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function periodOrder(left: QuotaTakeoverPeriod, right: QuotaTakeoverPeriod): number {
  return (left.kind === "weekly" ? 0 : 1) - (right.kind === "weekly" ? 0 : 1);
}
