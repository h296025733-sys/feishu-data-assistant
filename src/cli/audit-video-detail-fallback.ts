import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";
import { StorefourDemoGateway } from "../feishu/storefour-demo-gateway.js";
import { listRecentOnlineProductClickCandidates, parseVideoDetailMetrics } from "../automation/online-product-clicks.js";
import { fetchTikTokAnalytics, tikTokRuntimeFromProfile } from "../realtime/tiktok-cli.js";
import { businessDateRangeToShopDateRange, dateKeyInTimeZone, shiftIsoDate } from "../realtime/business-time.js";
import { assertFeishuResponse } from "../feishu/client.js";

const registry = new TenantRegistry(getEnv());
const output = [];
for (const id of ["storetwo-formal", "storeone-formal", "storetwo-botanical-care-formal"]) {
  const tenant = registry.byId(id)!;
  const { env, profile } = tenant;
  const client = createFeishuClient(env);
  const runtime = tikTokRuntimeFromProfile(profile);
  const today = dateKeyInTimeZone(new Date(), profile.businessTimeZone);
  const product = await fetchTikTokAnalytics("shop_product_performance", shiftIsoDate(today, -3), today, "", 180_000, runtime);
  if (!product.latest_available_date) throw new Error("No source completeness date");
  const candidates = await listRecentOnlineProductClickCandidates({ env, profile, client,
    latestCompleteShopDate: product.latest_available_date, probeDays: profile.dailyAutomation!.probeDays });
  const first = candidates[0];
  if (!first) { output.push({ id, candidates: 0, tested: false }); continue; }
  const start = businessDateRangeToShopDateRange(first.video.date, first.video.date, profile.businessTimeZone, profile.tiktok.shopTimeZone).startDate;
  const detail = await fetchTikTokAnalytics("shop_video_performance_detail", start, first.endExclusive, first.video.id, 180_000, runtime);
  if (detail.shop?.id !== profile.tiktok.shopId) throw new Error("Shop isolation mismatch");
  const fields = parseVideoDetailMetrics(detail, first.video.id, start, first.endExclusive);
  const gateway = new StorefourDemoGateway(env, client, profile);
  await gateway.initializeOnlineReadOnly();
  const record = (await gateway.snapshotOnlineByVideoIds([first.video.id])).get(first.video.id);
  if (!record) throw new Error("Missing unique existing record");
  const schema = await client.bitable.appTableField.list({ path: { app_token: env.FEISHU_BITABLE_APP_TOKEN, table_id: record.tableId }, params: { page_size: 100 } });
  assertFeishuResponse(schema, "Read-only fallback schema check");
  for (const name of Object.keys(fields)) {
    if (schema.data?.items?.find((f) => f.field_name === name)?.type !== 2) throw new Error(`${id}: ${name} not numeric`);
  }
  output.push({ id, candidates: candidates.length, tested: true, writes: 0,
    videoId: first.video.id, start, endExclusive: first.endExclusive, sourceDate: detail.latest_available_date,
    fields, previous: Object.fromEntries(Object.keys(fields).map((name) => [name, record.fields[name]])), requestIds: detail.request_ids });
}
const root = path.resolve(".runtime/schedule-repair-2026-09-28");
await mkdir(root, { recursive: true });
const result = { checkedAt: new Date().toISOString(), evidence: "Live TikTok + formal Feishu read-only; no writes or IM", output };
await writeFile(path.join(root, "detail-fallback-readonly.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
