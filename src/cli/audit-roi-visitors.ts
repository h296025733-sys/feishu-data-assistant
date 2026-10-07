import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";
import { FeishuBitableDataSource } from "../feishu/data-source.js";
import { prepareRoiBulkUpdatePlan } from "../realtime/roi-sync.js";

const tenantId = argument("--tenant");
const startDate = argument("--start-date");
const endDateInclusive = argument("--end-date-inclusive");
const registry = new TenantRegistry(getEnv());
const tenant = registry.byId(tenantId);
if (!tenant) throw new Error(`店铺租户不存在或未启用：${tenantId}`);

const client = createFeishuClient(tenant.env);
const source = new FeishuBitableDataSource(tenant.env, client, tenant.profile);
const table = await source.getTable(tenant.profile.tables.roi);

const apiByDate = new Map<string, Set<number>>();
const unavailableByDate = new Map<string, { error: string; latestAvailableDate: string | null; skippedReasons: string[] }>();
const dates = enumerateDates(startDate, endDateInclusive);
for (const date of dates) {
  try {
    const plan = await prepareRoiBulkUpdatePlan({
      jobId: `audit-roi-visitors-read-only-${date}`,
      startDate: date,
      endDateInclusive: date,
      rowFilter: "all",
      profile: tenant.profile,
    });
    for (const entry of plan.entries) {
      for (const item of entry.sources) {
        const values = apiByDate.get(item.date) ?? new Set<number>();
        values.add(item.visitors);
        apiByDate.set(item.date, values);
      }
    }
    const skipped = plan.skippedDetails.filter((item) => item.date === date);
    if (skipped.length > 0 && !apiByDate.has(date)) {
      unavailableByDate.set(date, {
        error: "TikTok 当日完整数据不可用",
        latestAvailableDate: skipped.map((item) => item.latestAvailableDate).find(Boolean) ?? null,
        skippedReasons: [...new Set(skipped.map((item) => item.reason))],
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    unavailableByDate.set(date, {
      error: message,
      latestAvailableDate: message.match(/最新可用日期为\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? null,
      skippedReasons: ["source_not_ready"],
    });
  }
}
const baseByDate = new Map<string, Array<{ visitors: number | null; row: Record<string, unknown> }>>();
for (const row of table.rows) {
  if (!isStoreRow(row, tenant.profile.storeAggregateLabel)) continue;
  const date = rowDate(row, tenant.profile.businessTimeZone);
  if (date < startDate || date > endDateInclusive) continue;
  const values = baseByDate.get(date) ?? [];
  values.push({ visitors: numberValue(row.店铺浏览量), row });
  baseByDate.set(date, values);
}

const comparisons = dates.map((date) => {
  const baseRows = baseByDate.get(date) ?? [];
  const apiValues = [...(apiByDate.get(date) ?? [])];
  const baseValue = baseRows.length === 1 ? baseRows[0]!.visitors : null;
  const apiValue = apiValues.length === 1 ? apiValues[0]! : null;
  const unavailable = unavailableByDate.get(date);
  return {
    date,
    baseRowCount: baseRows.length,
    baseVisitors: baseValue,
    apiVisitors: apiValue,
    exactMatch: baseRows.length === 1 && apiValues.length === 1 && baseValue === apiValue,
    apiValueCount: apiValues.length,
    apiUnavailable: Boolean(unavailable),
    latestAvailableDate: unavailable?.latestAvailableDate ?? null,
    skippedReasons: unavailable?.skippedReasons ?? [],
    sourceError: unavailable?.error ?? null,
  };
});

console.log(JSON.stringify({
  readOnly: true,
  tenantId,
  shop: tenant.profile.businessDisplayName,
  datePolicy: tenant.profile.tiktok.roiDateBasis,
  shopTimeZone: tenant.profile.tiktok.shopTimeZone,
  visibleTimeZone: tenant.profile.businessTimeZone,
  range: { startDate, endDateInclusive },
  comparisons,
}, null, 2));

function isStoreRow(row: Record<string, unknown>, aggregateLabel: string): boolean {
  const product = cellText(row.商品);
  const type = cellText(row.记录类型);
  return product === aggregateLabel || product === "店铺汇总" || /店铺|汇总/.test(type);
}

function rowDate(row: Record<string, unknown>, timeZone: string): string {
  const value = row.日期;
  if (typeof value === "number") return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(value));
  return cellText(value).match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
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

function enumerateDates(start: string, endInclusive: string): string[] {
  const dates: string[] = [];
  for (let date = start; date <= endInclusive; date = shiftDate(date, 1)) dates.push(date);
  return dates;
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) && name !== "--tenant") {
    throw new Error(`${name} 必须是 YYYY-MM-DD`);
  }
  if (!value) throw new Error(`缺少参数 ${name}`);
  return value;
}
