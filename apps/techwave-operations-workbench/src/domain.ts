import type { IFieldMeta, IOpenCellValue, IRecord } from "@lark-opdev/block-bitable-api";
import { STORE_AGGREGATE_LABEL } from "./runtime-config";

export let SHOP_NAME = STORE_AGGREGATE_LABEL;

export function setRuntimeStoreAggregateLabel(value: string): void {
  const normalized = value.trim();
  if (!normalized) throw new Error("店铺汇总名称不能为空");
  SHOP_NAME = normalized;
}
export const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

export const FIELD_IDS = {
  检查: "fld2ROgWfu",
  日期: "flddeVVFDk",
  月份: "fldLX8JF15",
  周: "fldJhZDLEJ",
  星期: "fldm43gFfW",
  合作量: "fldkUl92sH",
  上线量: "fld53i0p1M",
  单量: "fld3Ub6NCi",
  数量: "fld8LU3dwA",
  达人出单量: "fldhy6Zs8U",
  达人出单数量: "fld2tpNazv",
  联盟达人视频出单量: "fldAvVidOrd",
  联盟达人视频出单数量: "fldAvVidQty",
  联盟达人直播出单量: "fldAvLivOrd",
  联盟达人直播出单数量: "fldAvLivQty",
  自营达人视频出单量: "fldSvVidOrd",
  自营达人视频出单数量: "fldSvVidQty",
  自营达人直播出单量: "fldSvLivOrd",
  自营达人直播出单数量: "fldSvLivQty",
  商品卡出单量: "fldfP7Tyj2",
  商品卡出单数量: "fldE8cGcQy",
  销售额: "flddC6Xytq",
  出单视频: "fldXcd6h6F",
  自孵化出单量: "fldOzPHvdd",
  自孵化上线量: "fldK7D9AMU",
  店铺浏览量: "fldKJoXHCi",
  总单量: "fldyDvXnX6",
  总数量: "fldo52Msy7",
  店铺商品卡出单量: "fldK1e8su7",
  "店铺商品卡出单量(API)": "fldShpCardO",
  店铺商品卡出单数量: "fldShpCardQ",
  店铺联盟达人视频出单量: "fldSAvVOrd",
  店铺联盟达人视频出单数量: "fldSAvVQty",
  店铺联盟达人直播出单量: "fldSAvLOrd",
  店铺联盟达人直播出单数量: "fldSAvLQty",
  店铺自营达人视频出单量: "fldSSvVOrd",
  店铺自营达人视频出单数量: "fldSSvVQty",
  店铺自营达人直播出单量: "fldSSvLOrd",
  店铺自营达人直播出单数量: "fldSSvLQty",
  店铺销售额: "fldFAUavkY",
  转化率: "fldkqWEEqy",
  总广告出单量: "fldyzqfd1H",
  总广告花费: "flde1ijDaR",
  广告花费: "fldbJeK2L1",
  广告出单量: "fldYa1V62d",
  退货量: "fldakStYcN",
  备注: "fldtjpyRcH",
  商品: "fldU1pcF5j",
} as const;

export type FieldName = keyof typeof FIELD_IDS;
export type ValueSource = "formula" | "api" | "manual";

export interface AdvertisingAccount {
  id: string;
  name: string;
  spendFieldId: string;
  spendFieldName: string;
  orderFieldId: string;
  orderFieldName: string;
  active: boolean;
}

export interface AdvertisingMetricMeta {
  kind: "summary" | "account";
  measure: "spend" | "orders";
  accountId?: string;
  accountName?: string;
}

export interface MetricDefinition {
  name: string;
  fieldName: string;
  source: ValueSource;
  editable: boolean;
  description: string;
  format?: "count" | "money" | "percent";
  aggregate?: boolean;
  /** Month and all-time presentation rule. Blank daily values are excluded. */
  aggregation?: "sum" | "average";
  visible?: boolean;
  hierarchy?: {
    group: "联盟达人出单" | "自营达人出单" | "商品卡出单";
    channel?: "视频出单" | "直播出单";
    measure: "出单量" | "出单数量";
  };
  advertising?: AdvertisingMetricMeta;
}

/** Only business-manual facts are writable from the workbench. */
export function isMetricManuallyEditable(metric: MetricDefinition): boolean {
  return metric.source === "manual" && metric.editable;
}

const channelMetric = (
  fieldName: FieldName,
  group: NonNullable<MetricDefinition["hierarchy"]>["group"],
  channel: NonNullable<MetricDefinition["hierarchy"]>["channel"],
  measure: NonNullable<MetricDefinition["hierarchy"]>["measure"],
  source: ValueSource,
  editable: boolean,
): MetricDefinition => ({
  name: `${group}${channel ?? ""}${measure}`,
  fieldName,
  source,
  editable,
  description: `${[group, channel, measure].filter(Boolean).join(" · ")}；订单口径与售出件数口径严格分开`,
  format: "count",
  aggregate: true,
  hierarchy: { group, ...(channel ? { channel } : {}), measure },
});

export const PRODUCT_METRICS: MetricDefinition[] = [
  { name: "合作量", fieldName: "合作量", source: "formula", editable: false, description: "合作表保存后立即按商品与合作日期计数，不等待每日店铺同步", format: "count", aggregate: true },
  { name: "上线量", fieldName: "上线量", source: "formula", editable: false, description: "上线表保存后立即按商品与实上线日期计数，不等待每日店铺同步", format: "count", aggregate: true },
  { name: "单量", fieldName: "单量", source: "api", editable: true, description: "TikTok Shop 商品当日总订单；空白表示未知，0 表示确认无订单", format: "count", aggregate: true },
  { name: "数量", fieldName: "数量", source: "api", editable: true, description: "TikTok Shop 商品当日售出件数", format: "count", aggregate: true },
  channelMetric("联盟达人视频出单量", "联盟达人出单", "视频出单", "出单量", "api", true),
  channelMetric("联盟达人视频出单数量", "联盟达人出单", "视频出单", "出单数量", "api", true),
  channelMetric("联盟达人直播出单量", "联盟达人出单", "直播出单", "出单量", "api", true),
  channelMetric("联盟达人直播出单数量", "联盟达人出单", "直播出单", "出单数量", "api", true),
  channelMetric("自营达人视频出单量", "自营达人出单", "视频出单", "出单量", "api", true),
  channelMetric("自营达人视频出单数量", "自营达人出单", "视频出单", "出单数量", "api", true),
  channelMetric("自营达人直播出单量", "自营达人出单", "直播出单", "出单量", "api", true),
  channelMetric("自营达人直播出单数量", "自营达人出单", "直播出单", "出单数量", "api", true),
  channelMetric("商品卡出单量", "商品卡出单", undefined, "出单量", "api", true),
  channelMetric("商品卡出单数量", "商品卡出单", undefined, "出单数量", "api", true),
  { name: "销售额", fieldName: "销售额", source: "api", editable: true, description: "TikTok Shop 商品当日 GMV；单位沿用原表口径", format: "money", aggregate: true },
  { name: "出单视频", fieldName: "出单视频", source: "api", editable: true, description: "TikTok 联盟数据中当日卖出本商品的去重视频数；月度与全部按有值日平均", format: "count", aggregate: true, aggregation: "average" },
  { name: "达人出单量（兼容）", fieldName: "达人出单量", source: "formula", editable: false, description: "兼容旧查询的达人渠道订单总数，不在新版工作台展示", format: "count", aggregate: true, visible: false },
  { name: "达人出单数量（兼容）", fieldName: "达人出单数量", source: "formula", editable: false, description: "兼容旧查询的达人渠道售出件数，不在新版工作台展示", format: "count", aggregate: true, visible: false },
  { name: "自孵化出单量（旧口径）", fieldName: "自孵化出单量", source: "manual", editable: true, description: "保留旧数据但不在新版工作台展示", format: "count", aggregate: false, visible: false },
  { name: "自孵化上线量（旧口径）", fieldName: "自孵化上线量", source: "manual", editable: true, description: "保留旧数据但不在新版工作台展示", format: "count", aggregate: false, visible: false },
];

export const SHOP_METRICS: MetricDefinition[] = [
  { name: "合作量", fieldName: "合作量", source: "formula", editable: false, description: "同日合作记录数；同一条多产品合作只计 1 次", format: "count", aggregate: true },
  { name: "上线量", fieldName: "上线量", source: "formula", editable: false, description: "同日上线视频记录数；同一条多产品视频只计 1 次", format: "count", aggregate: true },
  { name: "店铺浏览量", fieldName: "店铺浏览量", source: "api", editable: true, description: "TikTok 店铺小时表现按自然日汇总；月度与全部按有值日平均，空白与0严格区分", format: "count", aggregate: true, aggregation: "average" },
  { name: "总单量", fieldName: "总单量", source: "formula", editable: false, description: "同日全部商品单量之和", format: "count", aggregate: true },
  { name: "总数量", fieldName: "总数量", source: "formula", editable: false, description: "同日全部商品数量之和", format: "count", aggregate: true },
  { name: "转化率", fieldName: "转化率", source: "formula", editable: false, description: "飞书公式：总单量÷店铺浏览量；月度与全部按有值日平均", format: "percent", aggregate: true, aggregation: "average" },
  channelMetric("店铺联盟达人视频出单量", "联盟达人出单", "视频出单", "出单量", "api", true),
  channelMetric("店铺联盟达人视频出单数量", "联盟达人出单", "视频出单", "出单数量", "api", true),
  channelMetric("店铺联盟达人直播出单量", "联盟达人出单", "直播出单", "出单量", "api", true),
  channelMetric("店铺联盟达人直播出单数量", "联盟达人出单", "直播出单", "出单数量", "api", true),
  channelMetric("店铺自营达人视频出单量", "自营达人出单", "视频出单", "出单量", "api", true),
  channelMetric("店铺自营达人视频出单数量", "自营达人出单", "视频出单", "出单数量", "api", true),
  channelMetric("店铺自营达人直播出单量", "自营达人出单", "直播出单", "出单量", "api", true),
  channelMetric("店铺自营达人直播出单数量", "自营达人出单", "直播出单", "出单数量", "api", true),
  channelMetric("店铺商品卡出单量(API)", "商品卡出单", undefined, "出单量", "api", true),
  channelMetric("店铺商品卡出单数量", "商品卡出单", undefined, "出单数量", "api", true),
  { name: "达人出单量（兼容）", fieldName: "达人出单量", source: "formula", editable: false, description: "兼容旧查询的达人渠道订单总数，不在新版工作台展示", format: "count", aggregate: true, visible: false },
  { name: "销售额", fieldName: "店铺销售额", source: "formula", editable: false, description: "同日全部商品销售额之和", format: "money", aggregate: true },
  { name: "出单视频", fieldName: "出单视频", source: "api", editable: true, description: "TikTok 联盟数据中当日卖出店铺商品的去重视频数；月度与全部按有值日平均", format: "count", aggregate: true, aggregation: "average" },
  { name: "总广告花费", fieldName: "总广告花费", source: "formula", editable: false, description: "全部广告账户当日花费之和；账户增删改名后由插件重建原生公式", format: "money", aggregate: true, advertising: { kind: "summary", measure: "spend" } },
  { name: "总广告出单量", fieldName: "总广告出单量", source: "formula", editable: false, description: "全部广告账户当日广告出单量之和；账户增删改名后由插件重建原生公式", format: "count", aggregate: true, advertising: { kind: "summary", measure: "orders" } },
  { name: "退货量", fieldName: "退货量", source: "manual", editable: true, description: "退货业务口径尚未与 API refunded_items 校准，当前人工维护", format: "count", aggregate: true },
];

/** 店铺自有账号/视频的日经营指标。确定性API字段全部只读。 */
export const ACCOUNT_SIDE_METRICS: MetricDefinition[] = [
  { name: "上线量", fieldName: "上线量", source: "api", editable: false, description: "该经营日发布的视频数", format: "count", aggregate: true },
  { name: "出单视频", fieldName: "出单视频", source: "api", editable: false, description: "该经营日产生归因成交的去重视频数；月度与全部按有值日平均", format: "count", aggregate: true, aggregation: "average" },
  { name: "单量", fieldName: "单量", source: "api", editable: false, description: "该经营日视频归因订单数；空白与0严格区分", format: "count", aggregate: true },
  { name: "数量", fieldName: "数量", source: "api", editable: false, description: "该经营日视频归因售出件数", format: "count", aggregate: true },
  { name: "视频曝光", fieldName: "视频曝光", source: "api", editable: false, description: "该经营日视频曝光；月度与全部按有值日平均", format: "count", aggregate: true, aggregation: "average" },
  { name: "销售额", fieldName: "销售额", source: "api", editable: false, description: "该经营日视频归因GMV（USD）", format: "money", aggregate: true },
];

/** 账号端店铺总览比产品/账号明细多展示两项独立人工维护的广告总计。 */
export const ACCOUNT_SIDE_AGGREGATE_METRICS: MetricDefinition[] = [
  ...ACCOUNT_SIDE_METRICS,
  { name: "广告花费", fieldName: "广告花费", source: "manual", editable: true, description: "人工维护的店铺总览当日广告花费；自动日更不会覆盖，产品/账号明细不填写", format: "money", aggregate: true },
  { name: "广告出单量", fieldName: "广告出单量", source: "manual", editable: true, description: "人工维护的店铺总览当日广告转化量；自动日更不会覆盖，产品/账号明细不填写", format: "count", aggregate: true },
];

export const ORDER_ATTRIBUTION_NUMBER_FIELDS = [...new Set(
  [...PRODUCT_METRICS, ...SHOP_METRICS]
    .filter((metric) => Boolean(metric.hierarchy))
    .map((metric) => metric.fieldName),
)];

export function orderAttributionSchemaIssues(metas: IFieldMeta[]): { missing: string[]; wrongType: string[] } {
  const byName = new Map(metas.map((meta) => [meta.name, meta]));
  const missing: string[] = [];
  const wrongType: string[] = [];
  for (const name of ORDER_ATTRIBUTION_NUMBER_FIELDS) {
    const meta = byName.get(name);
    if (!meta) missing.push(name);
    else if (meta.type !== 2) wrongType.push(name);
  }
  return { missing, wrongType };
}

export function buildShopMetrics(accounts: AdvertisingAccount[]): MetricDefinition[] {
  const accountMetrics = accounts.filter((account) => account.active).flatMap<MetricDefinition>((account) => ([
    {
      name: `${account.name}广告花费`,
      fieldName: account.spendFieldName,
      source: "manual",
      editable: true,
      description: `${account.name}当日广告花费；人工录入，保存前检查并发修改`,
      format: "money",
      aggregate: true,
      advertising: { kind: "account", measure: "spend", accountId: account.id, accountName: account.name },
    },
    {
      name: `${account.name}广告出单量`,
      fieldName: account.orderFieldName,
      source: "manual",
      editable: true,
      description: `${account.name}当日广告出单量；人工录入，保存前检查并发修改`,
      format: "count",
      aggregate: true,
      advertising: { kind: "account", measure: "orders", accountId: account.id, accountName: account.name },
    },
  ]));
  const returnIndex = SHOP_METRICS.findIndex((metric) => metric.fieldName === "退货量");
  return [
    ...SHOP_METRICS.slice(0, returnIndex),
    ...accountMetrics,
    ...SHOP_METRICS.slice(returnIndex),
  ];
}

export function discoverAdvertisingAccounts(
  metas: IFieldMeta[],
  archivedSpendFieldIds: ReadonlySet<string> = new Set(),
): AdvertisingAccount[] {
  const spendByAccount = new Map<string, IFieldMeta>();
  const orderByAccount = new Map<string, IFieldMeta>();
  for (const meta of metas) {
    if (meta.type !== 2) continue;
    const spend = meta.name.match(/^(.+?)广告花费$/);
    const orders = meta.name.match(/^(.+?)广告出单量$/);
    if (spend && spend[1] !== "总") spendByAccount.set(spend[1].trim(), meta);
    if (orders && orders[1] !== "总") orderByAccount.set(orders[1].trim(), meta);
  }
  return [...spendByAccount].flatMap(([name, spend]) => {
    const orders = orderByAccount.get(name);
    if (!orders) return [];
    return [{
      id: `${spend.id}:${orders.id}`,
      name,
      spendFieldId: spend.id,
      spendFieldName: spend.name,
      orderFieldId: orders.id,
      orderFieldName: orders.name,
      active: !archivedSpendFieldIds.has(spend.id),
    }];
  }).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export interface AdvertisingFieldRepairItem {
  accountName: string;
  missing: "spend" | "orders";
}

export function advertisingFieldRepairPlan(metas: IFieldMeta[]): AdvertisingFieldRepairItem[] {
  const spendNames = new Set<string>();
  const orderNames = new Set<string>();
  for (const meta of metas) {
    if (meta.type !== 2) continue;
    const spend = meta.name.match(/^(.+?)广告花费$/);
    const orders = meta.name.match(/^(.+?)广告出单量$/);
    if (spend && spend[1] !== "总") spendNames.add(spend[1].trim());
    if (orders && orders[1] !== "总") orderNames.add(orders[1].trim());
  }
  return [
    ...[...spendNames].filter((name) => !orderNames.has(name)).map((accountName) => ({ accountName, missing: "orders" as const })),
    ...[...orderNames].filter((name) => !spendNames.has(name)).map((accountName) => ({ accountName, missing: "spend" as const })),
  ].sort((a, b) => a.accountName.localeCompare(b.accountName, "zh-CN"));
}

export interface NormalizedRecord {
  recordId: string;
  product: string;
  dateKey: string;
  timestamp: number;
  status: string;
  values: Partial<Record<string, number | string | null>>;
}

export interface NormalizedDataset {
  mode: "store" | "account-product" | "account-account";
  tableId: string;
  tableName: string;
  dimensionLabel: "产品" | "账号";
  aggregateLabel: string;
  aggregateMetrics: MetricDefinition[];
  dimensionMetrics: MetricDefinition[];
  showProductLinks: boolean;
  validateStoreFormulas: boolean;
  fieldsByName: Map<string, IFieldMeta>;
  advertisingAccounts: AdvertisingAccount[];
  advertisingWarnings: string[];
  records: NormalizedRecord[];
  loadedAt: Date;
  editable: boolean;
  canDeleteProducts: boolean;
  canManageAdvertising: boolean;
  isDemo: boolean;
}

export function normalizeAccountSideRecords(
  records: IRecord[],
  fieldsByName: ReadonlyMap<string, IFieldMeta>,
  dimensionField: "商品" | "账号",
): NormalizedRecord[] {
  const id = (name: string) => fieldsByName.get(name)?.id;
  const dimensionId = id(dimensionField);
  const dateId = id("日期");
  if (!dimensionId || !dateId) throw new Error(`${dimensionField}投产比缺少主体或日期字段`);
  return records.flatMap((record) => {
    const product = toText(record.fields[dimensionId]).trim();
    const timestamp = toNumber(record.fields[dateId]);
    if (!product || timestamp === null) return [];
    const values: NormalizedRecord["values"] = {};
    for (const metric of ACCOUNT_SIDE_AGGREGATE_METRICS) {
      const fieldId = id(metric.fieldName);
      if (fieldId) values[metric.fieldName] = toNumber(record.fields[fieldId]);
    }
    const statusId = id("数据状态");
    return [{
      recordId: record.recordId,
      product,
      dateKey: formatDateKey(timestamp),
      timestamp,
      status: statusId ? toText(record.fields[statusId]) || "完整" : "完整",
      values,
    }];
  });
}

export interface RecordIndex {
  byKey: Map<string, NormalizedRecord[]>;
  products: string[];
  dates: string[];
  duplicateKeys: Set<string>;
}

export function recordKey(product: string, dateKey: string): string {
  return `${product}\u0000${dateKey}`;
}

export function toText(value: IOpenCellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item === null || item === undefined) return "";
      if (typeof item === "string" || typeof item === "number") return String(item);
      if (typeof item === "object") {
        const candidate = item as Record<string, unknown>;
        return String(candidate.text ?? candidate.name ?? candidate.value ?? "");
      }
      return "";
    }).filter(Boolean).join("");
  }
  if (typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    return String(candidate.text ?? candidate.name ?? candidate.value ?? "");
  }
  return "";
}

export function toNumber(value: IOpenCellValue | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "number") return value[0];
  const text = toText(value).trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatDateKey(timestamp: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(timestamp);
}

export function dateKeyToTimestamp(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00+08:00`).getTime();
}

export function normalizeRecords(records: IRecord[], fieldsByName: ReadonlyMap<string, IFieldMeta>): NormalizedRecord[] {
  const id = (name: string) => fieldsByName.get(name)?.id;
  const numericFieldNames = new Set<string>([
    "日期",
    ...PRODUCT_METRICS.map((metric) => metric.fieldName),
    ...SHOP_METRICS.map((metric) => metric.fieldName),
    ...[...fieldsByName.keys()].filter((name) => /^(.+?)广告(?:花费|出单量)$/.test(name)),
  ]);
  return records.flatMap((record) => {
    const productId = id("商品");
    const dateId = id("日期");
    if (!productId || !dateId) return [];
    const product = toText(record.fields[productId]).trim();
    const timestamp = toNumber(record.fields[dateId]);
    if (!product || timestamp === null) return [];
    const values: NormalizedRecord["values"] = {};
    const names = new Set<string>([
      ...Object.keys(FIELD_IDS),
      ...[...fieldsByName.keys()].filter((name) => /^(.+?)广告(?:花费|出单量)$/.test(name)),
    ]);
    names.forEach((name) => {
      const fieldId = id(name);
      if (!fieldId) return;
      const raw = record.fields[fieldId];
      // 公式数字在数据表视图 SDK 中可能是 number、number[]、数字文本分段，
      // 或带 value/status 的自计算对象。必须按字段业务类型归一化，不能只认 number。
      values[name] = numericFieldNames.has(name) ? toNumber(raw) : toText(raw);
    });
    return [{
      recordId: record.recordId,
      product,
      dateKey: formatDateKey(timestamp),
      timestamp,
      status: toText(id("检查") ? record.fields[id("检查")!] : null) || "✓",
      values,
    }];
  });
}

export function indexRecords(records: NormalizedRecord[]): RecordIndex {
  const byKey = new Map<string, NormalizedRecord[]>();
  const products = new Set<string>();
  const dates = new Set<string>();
  for (const record of records) {
    const key = recordKey(record.product, record.dateKey);
    const list = byKey.get(key) ?? [];
    list.push(record);
    byKey.set(key, list);
    if (record.product !== SHOP_NAME) products.add(record.product);
    dates.add(record.dateKey);
  }
  const duplicateKeys = new Set([...byKey].filter(([, rows]) => rows.length > 1).map(([key]) => key));
  return {
    byKey,
    products: [...products].sort((a, b) => a.localeCompare(b, "zh-CN")),
    dates: [...dates].sort(),
    duplicateKeys,
  };
}

export function getRecord(index: RecordIndex, product: string, dateKey: string): NormalizedRecord | undefined {
  return index.byKey.get(recordKey(product, dateKey))?.[0];
}

export function enumerateDateKeys(startKey: string, endKey: string): string[] {
  const start = dateKeyToTimestamp(startKey);
  const end = dateKeyToTimestamp(endKey);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return [];
  const result: string[] = [];
  for (let current = start; current <= end; current += 86_400_000) result.push(formatDateKey(current));
  return result;
}

export function monthBounds(monthKey: string): { start: string; end: string } {
  const [year, month] = monthKey.split("-").map(Number);
  const start = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-01`;
  const endDate = new Date(Date.UTC(year, month, 0));
  const end = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${endDate.getUTCDate().toString().padStart(2, "0")}`;
  return { start, end };
}

export function rollingDateBounds(endKey: string, days: number): { start: string; end: string } {
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error(`滚动日期天数无效：${days}`);
  const end = dateKeyToTimestamp(endKey);
  if (!Number.isFinite(end)) throw new Error(`滚动日期结束日无效：${endKey}`);
  return { start: formatDateKey(end - (days - 1) * 86_400_000), end: endKey };
}

export function currentShanghaiDateKey(now = Date.now()): string {
  return formatDateKey(now);
}

export function getLatestMonth(records: NormalizedRecord[], fallback = currentShanghaiDateKey()): string {
  return (records.map((record) => record.dateKey).sort().at(-1) ?? fallback).slice(0, 7);
}

export function getWeekInfo(dateKey: string): { key: string; label: string; weekday: string; weekend: boolean } {
  const date = new Date(`${dateKey}T12:00:00+08:00`);
  const weekdayCode = new Intl.DateTimeFormat("en-US", { timeZone: SHANGHAI_TIME_ZONE, weekday: "short" }).format(date);
  const weekdayIndexByCode: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const jsDay = weekdayIndexByCode[weekdayCode] ?? 0;
  const labels = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const offsetToMonday = (jsDay + 6) % 7;
  const monday = new Date(date.getTime() - offsetToMonday * 86_400_000);
  const mondayKey = formatDateKey(monday.getTime());
  return { key: mondayKey, label: `${mondayKey.slice(5)} 起`, weekday: labels[jsDay], weekend: jsDay === 0 || jsDay === 6 };
}

export function aggregateMetric(
  records: NormalizedRecord[],
  product: string,
  metric: MetricDefinition,
  monthKey?: string,
): number | null {
  if (metric.aggregate === false) return null;
  const relevant = records.filter((record) => record.product === product && (!monthKey || record.dateKey.startsWith(monthKey)));
  const values = relevant.map((record) => record.values[metric.fieldName]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return metric.aggregation === "average" ? total / values.length : total;
}

export function formatMetricValue(value: number | null, metric: MetricDefinition): string {
  if (value === null) return "";
  if (metric.format === "percent") return `${(value * 100).toFixed(2)}%`;
  if (metric.format === "money") return value.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

export function hasAnomaly(record: NormalizedRecord | undefined, duplicate: boolean): boolean {
  if (!record) return false;
  return duplicate || record.status.trim().startsWith("⚠");
}

export function needsManualInput(record: NormalizedRecord | undefined, product: string): boolean {
  if (!record) return false;
  const status = record.status.trim();
  if (status === "待录入" || status === "待补数据") return true;
  if (product === SHOP_NAME) return false;

  // 兼容“检查”公式暂未出值的短暂窗口：只有五个核心经营字段全部为空时才算待补。
  // 出单视频、自孵化等低频可选字段为空，不能把已完成的商品日记录误判为待补。
  const coreFields: FieldName[] = ["单量", "数量", "商品卡出单量", "商品卡出单数量", "销售额"];
  return status === "" && coreFields.every((name) => {
    const value = record.values[name];
    return value === null || value === "" || value === undefined;
  });
}

function numericValue(record: NormalizedRecord, fieldName: FieldName): number | null {
  const value = record.values[fieldName];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sameMetricValue(actual: number | null, expected: number | null): boolean {
  if (actual === null || expected === null) return actual === expected;
  return Math.abs(actual - expected) < 1e-9;
}

function subtractWithBlankSemantics(total: number | null, part: number | null): number | null {
  if (total === null && part === null) return null;
  return (total ?? 0) - (part ?? 0);
}

function sumWithBlankSemantics(records: NormalizedRecord[], fieldName: FieldName): number | null {
  const values = records
    .map((record) => numericValue(record, fieldName))
    .filter((value): value is number => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function setFormulaFallback(record: NormalizedRecord, fieldName: FieldName, value: number | null): void {
  if (numericValue(record, fieldName) === null && value !== null) record.values[fieldName] = value;
}

/**
 * 飞书数据表视图宿主有时会在批量读取中暂不返回公式值。此处只为界面补齐插件已经
 * 掌握全部依赖的原表公式，不写回表格；SDK 一旦返回原生公式值，始终优先使用原值。
 */
export function applyFormulaFallbacks(records: NormalizedRecord[]): NormalizedRecord[] {
  for (const record of records) {
    if (record.product === SHOP_NAME) continue;
    setFormulaFallback(
      record,
      "达人出单量",
      subtractWithBlankSemantics(numericValue(record, "单量"), numericValue(record, "商品卡出单量")),
    );
    setFormulaFallback(
      record,
      "达人出单数量",
      subtractWithBlankSemantics(numericValue(record, "数量"), numericValue(record, "商品卡出单数量")),
    );
  }

  for (const store of records.filter((record) => record.product === SHOP_NAME)) {
    const products = records.filter((record) => record.product !== SHOP_NAME && record.dateKey === store.dateKey);
    if (!products.length) continue;
    setFormulaFallback(store, "总单量", sumWithBlankSemantics(products, "单量"));
    setFormulaFallback(store, "总数量", sumWithBlankSemantics(products, "数量"));
    setFormulaFallback(store, "达人出单量", sumWithBlankSemantics(products, "达人出单量"));
    setFormulaFallback(store, "店铺商品卡出单量", sumWithBlankSemantics(products, "商品卡出单量"));
    setFormulaFallback(store, "店铺销售额", sumWithBlankSemantics(products, "销售额"));

    const visits = numericValue(store, "店铺浏览量");
    const totalOrders = numericValue(store, "总单量");
    setFormulaFallback(store, "转化率", visits && totalOrders !== null ? totalOrders / visits : null);

    setFormulaFallback(store, "总广告出单量", advertisingTotalFromRecord(store, "广告出单量"));
    setFormulaFallback(store, "总广告花费", advertisingTotalFromRecord(store, "广告花费"));
  }
  return records;
}

/**
 * 只校验插件当前已经掌握全部依赖的原生公式；不替代飞书公式，也不写回计算结果。
 */
export function getFormulaIssues(records: NormalizedRecord[], record: NormalizedRecord): string[] {
  const expected = new Map<FieldName, number | null>();
  const expectIfKnown = (fieldName: FieldName, value: number | null): void => {
    if (value !== null) expected.set(fieldName, value);
  };
  if (record.product !== SHOP_NAME) {
    expectIfKnown(
      "达人出单量",
      subtractWithBlankSemantics(numericValue(record, "单量"), numericValue(record, "商品卡出单量")),
    );
    expectIfKnown(
      "达人出单数量",
      subtractWithBlankSemantics(numericValue(record, "数量"), numericValue(record, "商品卡出单数量")),
    );
  } else {
    const products = records.filter((item) => item.product !== SHOP_NAME && item.dateKey === record.dateKey);
    expectIfKnown("总单量", sumWithBlankSemantics(products, "单量"));
    expectIfKnown("总数量", sumWithBlankSemantics(products, "数量"));
    expectIfKnown("达人出单量", sumWithBlankSemantics(products, "达人出单量"));
    expectIfKnown("店铺商品卡出单量", sumWithBlankSemantics(products, "商品卡出单量"));
    expectIfKnown("店铺销售额", sumWithBlankSemantics(products, "销售额"));
    const visits = numericValue(record, "店铺浏览量");
    const totalOrders = sumWithBlankSemantics(products, "单量");
    expectIfKnown("转化率", visits === null || visits === 0 || totalOrders === null ? null : totalOrders / visits);
    expectIfKnown("总广告出单量", advertisingTotalFromRecord(record, "广告出单量"));
    expectIfKnown("总广告花费", advertisingTotalFromRecord(record, "广告花费"));
  }

  return [...expected].flatMap(([fieldName, expectedValue]) => {
    const actual = numericValue(record, fieldName);
    if (sameMetricValue(actual, expectedValue)) return [];
    return [`${fieldName}应为${expectedValue === null ? "空白" : expectedValue}，当前为${actual === null ? "空白" : actual}`];
  });
}

export function validateFieldMap(metas: IFieldMeta[]): Map<FieldName, IFieldMeta> {
  const byId = new Map(metas.map((meta) => [meta.id, meta]));
  const byName = new Map(metas.map((meta) => [meta.name, meta]));
  const result = new Map<FieldName, IFieldMeta>();
  const missing: string[] = [];
  for (const [name, stableId] of Object.entries(FIELD_IDS) as [FieldName, string][]) {
    const stable = byId.get(stableId);
    const named = byName.get(name);
    const runtimeNamed = name === "广告花费" || name === "广告出单量";
    const matched = runtimeNamed ? stable : stable?.name === name ? stable : named;
    if (matched) result.set(name, matched);
    else missing.push(name);
  }
  const required = ["检查", "商品", "日期", ...new Set([...PRODUCT_METRICS, ...SHOP_METRICS].map((metric) => metric.fieldName))];
  const missingRequired = missing.filter((name) => required.includes(name as FieldName));
  if (missingRequired.length) throw new Error(`投产比缺少必需字段：${missingRequired.join("、")}`);
  return result;
}

export function resolveFieldMap(metas: IFieldMeta[]): Map<string, IFieldMeta> {
  const resolved = new Map<string, IFieldMeta>(metas.map((meta) => [meta.name, meta]));
  for (const [name, meta] of validateFieldMap(metas)) resolved.set(name, meta);
  return resolved;
}

export function advertisingFieldWarnings(metas: IFieldMeta[]): string[] {
  return advertisingFieldRepairPlan(metas).map((item) => (
    `${item.accountName}缺少“${item.missing === "spend" ? "广告花费" : "广告出单量"}”字段`
  ));
}

function advertisingTotalFromRecord(record: NormalizedRecord, suffix: "广告花费" | "广告出单量"): number | null {
  const actualAccountValues = Object.entries(record.values)
    .filter(([name, value]) => (
      name.endsWith(suffix)
      && name !== `总${suffix}`
      && name !== suffix
      && typeof value === "number"
      && Number.isFinite(value)
    ))
    .map(([, value]) => value as number);
  if (actualAccountValues.length) return actualAccountValues.reduce((sum, value) => sum + value, 0);
  return numericValue(record, suffix === "广告花费" ? "广告花费" : "广告出单量");
}
