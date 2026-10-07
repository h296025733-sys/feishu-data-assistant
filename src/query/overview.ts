import type { DataRow, QueryIntent, TableData } from "../types/index.js";
import { normalizeText, parseNumber, toDateKey } from "../utils/value.js";

export interface MonthlyOnlineMetric {
  month: string;
  records: number;
  creators: number;
  quantity: number;
  sales: number;
  exposure: number;
}

export interface OnlineOverviewValue {
  [key: string]: unknown;
  __kind: "online_overview";
  entity: string;
  entityKind: "product" | "creator";
  records: number;
  distinctCreators: number;
  distinctProducts: number;
  quantity: number;
  sales: number;
  exposure: number;
  datedRows: number;
  missingDateRows: number;
  startDate: string | null;
  endDate: string | null;
  peakSalesMonth: MonthlyOnlineMetric | null;
  peakRecordMonth: MonthlyOnlineMetric | null;
  latestMonth: MonthlyOnlineMetric | null;
  previousMonth: MonthlyOnlineMetric | null;
  trendSummary: string;
  monthly: MonthlyOnlineMetric[];
}

export function isProductField(field: string | null): boolean {
  return Boolean(field && /产品|商品|sku|品类/i.test(field));
}

export function entityValueMatches(field: string, rowValue: unknown, queryValue: string): boolean {
  if (!isProductField(field)) return normalizeText(rowValue) === normalizeText(queryValue);
  return canonicalProduct(rowValue) === canonicalProduct(queryValue);
}

export function canonicalProduct(value: unknown): string {
  const raw = String(value ?? "").trim();
  const normalized = normalizeText(raw);
  if (!normalized) return "";

  // 组合商品默认不并入单一产品，避免“香水”把“尾插充电宝,香水”一起算入。
  if (/[，,、+＋/&]/.test(raw)) return normalized;

  const aliases: Array<[RegExp, string]> = [
    [/^尾插充电宝(?:2个装|2件装)?$/, "尾插充电宝"],
    [/^(?:电动)?修脚器$/, "修脚器"],
    [/^(?:liveonly)?挂腰风扇$/, "挂腰风扇"],
    [/^(?:汽车)?油膜清洁剂$/, "油膜清洁剂"],
    [/^旋转缝隙(?:清洁)?刷$/, "旋转缝隙刷"],
    [/^(?:汽车)?迎宾灯.*$/, "迎宾灯"],
  ];
  for (const [pattern, canonical] of aliases) {
    if (pattern.test(normalized)) return canonical;
  }
  return normalized;
}

export function isOnlineOverviewValue(value: unknown): value is OnlineOverviewValue {
  return Boolean(value && typeof value === "object" && (value as { __kind?: string }).__kind === "online_overview");
}

export function buildOnlineOverview(table: TableData, rows: DataRow[], intent: QueryIntent): OnlineOverviewValue {
  const dateField = intent.dateField ?? firstExisting(table.headers, ["实上线日期(Ct)", "实上线日期(CT)", "实上线日期", "登记日期"]);
  const creatorField = firstExisting(table.headers, ["达人姓名", "红人姓名"]);
  const productField = firstExisting(table.headers, ["挂车产品", "寄样产品", "产品", "商品"]);
  const quantityField = firstExisting(table.headers, ["售出数量", "销量", "销售数量", "数量"]);
  const salesField = firstExisting(table.headers, ["销售额", "成交额", "实付金额", "金额"]);
  const exposureField = firstExisting(table.headers, ["视频曝光K", "曝光", "播放量", "浏览量"]);

  const creators = new Set<string>();
  const products = new Set<string>();
  let quantity = 0;
  let sales = 0;
  let exposure = 0;
  const dates: string[] = [];
  const months = new Map<string, {
    records: number;
    creators: Set<string>;
    quantity: number;
    sales: number;
    exposure: number;
  }>();

  for (const row of rows) {
    const creator = creatorField ? String(row[creatorField] ?? "").trim() : "";
    const product = productField ? String(row[productField] ?? "").trim() : "";
    if (creator) creators.add(creator);
    if (product) products.add(product);

    quantity += numeric(row, quantityField);
    sales += numeric(row, salesField);
    exposure += numeric(row, exposureField);

    const date = dateField ? toDateKey(row[dateField]) : null;
    if (!date) continue;
    dates.push(date);
    const month = date.slice(0, 7);
    const bucket = months.get(month) ?? {
      records: 0,
      creators: new Set<string>(),
      quantity: 0,
      sales: 0,
      exposure: 0,
    };
    bucket.records += 1;
    if (creator) bucket.creators.add(creator);
    bucket.quantity += numeric(row, quantityField);
    bucket.sales += numeric(row, salesField);
    bucket.exposure += numeric(row, exposureField);
    months.set(month, bucket);
  }

  const monthly: MonthlyOnlineMetric[] = [...months.entries()]
    .map(([month, item]) => ({
      month,
      records: item.records,
      creators: item.creators.size,
      quantity: item.quantity,
      sales: item.sales,
      exposure: item.exposure,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const peakSalesMonth = maxMonth(monthly, "sales");
  const peakRecordMonth = maxMonth(monthly, "records");
  const latestMonth = monthly.at(-1) ?? null;
  const previousMonth = monthly.at(-2) ?? null;

  return {
    __kind: "online_overview",
    entity: intent.entityValue ?? "全部上线视频",
    entityKind: isProductField(intent.entityField) ? "product" : "creator",
    records: rows.length,
    distinctCreators: creators.size,
    distinctProducts: products.size,
    quantity,
    sales,
    exposure,
    datedRows: dates.length,
    missingDateRows: rows.length - dates.length,
    startDate: dates.length ? dates.sort()[0] : null,
    endDate: dates.length ? dates.sort().at(-1) ?? null : null,
    peakSalesMonth,
    peakRecordMonth,
    latestMonth,
    previousMonth,
    trendSummary: trendConclusion(monthly, peakSalesMonth, peakRecordMonth, latestMonth),
    monthly,
  };
}

function firstExisting(headers: string[], names: string[]): string | null {
  return names.find((name) => headers.includes(name)) ?? null;
}

function numeric(row: DataRow, field: string | null): number {
  if (!field) return 0;
  return parseNumber(row[field]) ?? 0;
}

function maxMonth(monthly: MonthlyOnlineMetric[], field: "sales" | "records"): MonthlyOnlineMetric | null {
  if (monthly.length === 0) return null;
  return [...monthly].sort((a, b) => b[field] - a[field] || a.month.localeCompare(b.month))[0];
}

function trendConclusion(
  monthly: MonthlyOnlineMetric[],
  peakSales: MonthlyOnlineMetric | null,
  peakRecords: MonthlyOnlineMetric | null,
  latest: MonthlyOnlineMetric | null,
): string {
  if (monthly.length < 2 || !peakSales || !latest) return "可用月份较少，暂不足以判断长期趋势";
  if (monthly.every((item) => item.sales === 0)) return "当前上线记录暂无销售额，暂无法判断销售趋势";

  const latestRatio = peakSales.sales > 0 ? latest.sales / peakSales.sales : 1;
  let conclusion = latestRatio >= 0.8
    ? "近期销售表现仍接近历史高位"
    : latestRatio <= 0.3
      ? "销售高峰后已明显回落"
      : "销售高峰后有所回落";

  if (
    peakRecords
    && peakRecords.month !== peakSales.month
    && peakRecords.records > peakSales.records
    && peakRecords.sales < peakSales.sales * 0.8
  ) {
    conclusion += "，且上线量最高月份没有带来同步的销售增长";
  }
  return conclusion;
}
