import { getEnv } from "../config/env.js";
import { TenantRegistry, type ResolvedTenant } from "../config/tenant-registry.js";
import { dateKeyInTimeZone, shiftIsoDate } from "../realtime/business-time.js";
import {
  fetchTikTokAnalytics,
  fetchTikTokVideoDay,
  tikTokRuntimeFromProfile,
} from "../realtime/tiktok-cli.js";

const tenantId = argument("--tenant");
if (!tenantId) throw new Error("Required: --tenant ID");

const registry = new TenantRegistry(getEnv());
const tenant = registry.byId(tenantId) as ResolvedTenant | null;
if (!tenant) throw new Error(`Unknown tenant: ${tenantId}`);

const today = dateKeyInTimeZone(new Date(), tenant.profile.businessTimeZone);
const probeDays = tenant.profile.dailyAutomation?.probeDays ?? 14;
const startDate = shiftIsoDate(today, -probeDays);
const runtime = tikTokRuntimeFromProfile(tenant.profile);
const [product, shop, video] = await Promise.all([
  fetchTikTokAnalytics("shop_product_performance", startDate, today, "", 180_000, runtime),
  fetchTikTokAnalytics("shop_performance_hourly", startDate, today, "", 180_000, runtime),
  fetchTikTokVideoDay(startDate, today, 180_000, runtime),
]);

console.log(JSON.stringify({
  tenantId,
  shop: tenant.profile.businessDisplayName,
  fetchedAt: new Date().toISOString(),
  today,
  requestedWindow: { startDate, endDateExclusive: today },
  contracts: [product, shop, video].map((contract) => ({
    dataset: contract.dataset,
    ok: contract.ok,
    rowCount: contract.row_count,
    latestAvailableDate: contract.latest_available_date ?? null,
    windowStart: contract.window_start,
    windowEndExclusive: contract.window_end_exclusive,
    paginationTruncated: contract.pagination_truncated ?? false,
    grantedScopes: contract.granted_scope,
    missingCapabilities: contract.missing_capabilities,
    errors: contract.errors,
  })),
}, null, 2));

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : "";
}
