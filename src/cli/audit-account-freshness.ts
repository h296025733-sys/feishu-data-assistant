import { readFileSync } from "node:fs";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { dateKeyInTimeZone, shiftIsoDate } from "../realtime/business-time.js";
import {
  fetchTikTokPaidOrderSnapshot,
  fetchTikTokVideoDay,
  tikTokRuntimeFromProfile,
} from "../realtime/tiktok-cli.js";
import type { TikTokMachineContract, TikTokVideoRow } from "../realtime/types.js";

const registry = new TenantRegistry(getEnv());
const reportDate = argument("--report-date")
  || dateKeyInTimeZone(new Date(), "Asia/Shanghai");
const sourceDate = shiftIsoDate(reportDate, -1);
const endDateExclusive = shiftIsoDate(reportDate, 1);
const results: Record<string, unknown>[] = [];

for (const tenant of registry.all()) {
  const runtime = tikTokRuntimeFromProfile(tenant.profile);
  const [official, marketing, paid] = await Promise.all([
    fetchTikTokVideoDay(sourceDate, reportDate, 180_000, runtime, "OFFICIAL_ACCOUNTS"),
    fetchTikTokVideoDay(sourceDate, reportDate, 180_000, runtime, "MARKETING_ACCOUNTS"),
    fetchTikTokPaidOrderSnapshot(sourceDate, endDateExclusive, "Asia/Shanghai", 120_000, runtime),
  ]);
  const productMap = JSON.parse(readFileSync(
    path.resolve(process.cwd(), tenant.profile.tiktok.productMapFile),
    "utf8",
  )) as { products?: Record<string, string> };
  const productIds = new Set(Object.keys(productMap.products ?? {}));
  const paidRows = paid.paid_snapshot_rows.filter((row) => (
    productIds.has(String(row.product_id ?? ""))
  ));
  const exactFormalProductOrders = sum(paidRows, "total_orders");
  const exactFormalProductSales = sum(paidRows, "sales_amount");
  results.push({
    tenantId: tenant.binding.id,
    store: tenant.profile.businessDisplayName,
    reportDate,
    storeSourceDate: sourceDate,
    officialVideo: summarizeVideo(official, productIds),
    marketingVideo: summarizeVideo(marketing, productIds),
    paidFormalProducts: {
      dates: paid.paid_snapshot_dates,
      rowCount: paidRows.length,
      orders: exactFormalProductOrders,
      items: sum(paidRows, "total_items"),
      sales: exactFormalProductSales,
      salesReady: paidRows.every((row) => row.sales_ready === true),
    },
    accountOrderAttribution: {
      ready: paid.video_attribution_ready,
      rowCount: paid.video_order_rows.length,
      errors: paid.video_attribution_errors,
      missingCapabilities: paid.missing_capabilities,
    },
    safeFreshness: {
      freshOwnedVideoMetricsAvailable: (
        official.latest_available_date === sourceDate
        && marketing.latest_available_date === sourceDate
      ),
      positiveOrdersCanBeAssignedToOwnedAccounts: paid.video_attribution_ready,
      exactZeroCanBeProvenWhenFormalProductOrdersAreZero: exactFormalProductOrders === 0,
    },
  });
}

console.log(JSON.stringify({
  ok: true,
  evidence: "真实TikTok只读；未调用飞书、未写Base、未发送消息",
  checkedAt: new Date().toISOString(),
  results,
}, null, 2));

function summarizeVideo(
  contract: TikTokMachineContract,
  productIds: Set<string>,
): Record<string, unknown> {
  const rows = contract.rows.filter((row) => intersectsProduct(row, productIds));
  return {
    latestAvailableDate: contract.latest_available_date ?? null,
    requestedWindow: `${contract.window_start}..${contract.window_end_exclusive}`,
    allRows: contract.row_count,
    formalProductRows: rows.length,
    creatorIdentityRows: rows.filter(hasCreatorIdentity).length,
    skuOrders: sum(rows, "sku_orders"),
    items: sum(rows, "items_sold"),
    gmv: sum(rows, "gmv_amount"),
    paginationTruncated: contract.pagination_truncated ?? false,
    errors: contract.errors,
  };
}

function intersectsProduct(row: TikTokVideoRow, productIds: Set<string>): boolean {
  const value = row.products;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return false;
    }
  }
  if (!Array.isArray(parsed)) return false;
  return parsed.some((item) => (
    item && typeof item === "object"
    && productIds.has(String((item as Record<string, unknown>).id ?? ""))
  ));
}

function hasCreatorIdentity(row: TikTokVideoRow): boolean {
  return Boolean(String(row.creator_open_id ?? row.creator_user_name ?? "").trim());
}

function sum(rows: readonly Record<string, unknown>[], field: string): number {
  return Math.round(rows.reduce((total, row) => total + Number(row[field] ?? 0), 0) * 100) / 100;
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
}
