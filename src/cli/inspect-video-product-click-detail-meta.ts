import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { fetchTikTokAnalytics, tikTokRuntimeFromProfile } from "../realtime/tiktok-cli.js";

const tenant = new TenantRegistry(getEnv()).byId("storeone-formal");
if (!tenant) throw new Error("STOREONE绑定不存在");
const contract = await fetchTikTokAnalytics("shop_video_performance_detail", "2026-09-20", "2026-09-27",
  "7677315660694687007", 180_000, tikTokRuntimeFromProfile(tenant.profile));
const row = contract.rows[0] ?? {};
const performance = row.performance as Record<string, unknown> | undefined;
const first = Array.isArray(performance?.intervals) ? performance.intervals[0] as Record<string, unknown> : null;
console.log(JSON.stringify({ ok: contract.ok, latestAvailableDate: contract.latest_available_date ?? null,
  windowStart: contract.window_start, windowEndExclusive: contract.window_end_exclusive,
  rowKeys: Object.keys(row), performanceKeys: performance ? Object.keys(performance) : [],
  intervalKeys: first ? Object.keys(first) : [], sourceDateKeys: Object.keys(contract).filter((key) => /date|latest|complete/i.test(key)),
  requestId: contract.request_ids[0] ?? null }, null, 2));
