import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";
import { FeishuBitableDataSource } from "../feishu/data-source.js";

const registry = new TenantRegistry(getEnv());
const requestedDates = new Set(
  (argument("--dates") ?? "2026-08-10,2026-08-11")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function average(rows: Record<string, unknown>[], field: string): { value: number | null; count: number } {
  const values = rows.map((row) => finiteNumber(row[field])).filter((value): value is number => value !== null);
  if (values.length === 0) return { value: null, count: 0 };
  return { value: values.reduce((sum, value) => sum + value, 0) / values.length, count: values.length };
}

for (const tenant of registry.all()) {
  const source = new FeishuBitableDataSource(
    tenant.env,
    createFeishuClient(tenant.env),
    tenant.profile,
  );
  const table = await source.getTable(tenant.profile.tables.roi);
  const rows = table.rows.flatMap((row) => {
    const rawDate = row.日期;
    const date = typeof rawDate === "number"
      ? new Intl.DateTimeFormat("en-CA", { timeZone: tenant.profile.businessTimeZone }).format(new Date(rawDate))
      : String(rawDate ?? "").slice(0, 10);
    if (!requestedDates.has(date)) return [];
    return [{
      rawDate,
      date,
      product: row.商品,
      recordType: row.记录类型,
      orders: row.单量,
      items: row.数量,
      sales: row.销售额,
      cooperation: row.合作量,
      online: row.上线量,
      visitors: row.店铺浏览量,
    }];
  });
  const normalized = table.rows.map((row) => {
    const rawDate = row.日期;
    const date = typeof rawDate === "number"
      ? new Intl.DateTimeFormat("en-CA", { timeZone: tenant.profile.businessTimeZone }).format(new Date(rawDate))
      : String(rawDate ?? "").slice(0, 10);
    return { ...row, __date: date, __product: String(row.商品 ?? "") } as Record<string, unknown>;
  });
  const august = normalized.filter((row) => String(row.__date).startsWith("2026-08"));
  const products = [...new Set(august.map((row) => String(row.__product)).filter(Boolean))].sort();
  const augustDisplayAverages = products.map((product) => {
    const productRows = august.filter((row) => row.__product === product);
    return product === "店铺汇总"
      ? {
        product,
        店铺浏览量: average(productRows, "店铺浏览量"),
        转化率: average(productRows, "转化率"),
        出单视频: average(productRows, "出单视频"),
      }
      : {
        product,
        出单视频: average(productRows, "出单视频"),
      };
  });
  console.log(JSON.stringify({
    readOnly: true,
    tenantId: tenant.binding.id,
    businessTimeZone: tenant.profile.businessTimeZone,
    rows,
    augustDisplayAverages,
  }, null, 2));
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
  return value || null;
}
