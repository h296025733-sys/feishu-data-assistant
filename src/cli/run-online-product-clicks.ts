import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";
import { StorefourDemoGateway } from "../feishu/storefour-demo-gateway.js";
import { dateKeyInTimeZone, shiftIsoDate } from "../realtime/business-time.js";
import { fetchTikTokAnalytics, tikTokRuntimeFromProfile } from "../realtime/tiktok-cli.js";
import { listRecentOnlineProductClickCandidates, syncOnlineVideoProductClicks } from "../automation/online-product-clicks.js";
import { mkdir, writeFile } from "node:fs/promises";

const tenantId = process.argv.find((arg) => arg.startsWith("--tenant="))?.slice(9);
if (!tenantId || !["storetwo-formal", "storeone-formal", "storetwo-botanical-care-formal", "storethree-formal", "storetwo-llc-formal"].includes(tenantId)) {
  throw new Error("商品点击量只允许五个已启用店铺");
}
if (!process.argv.includes("--confirm=RUN-ONLINE-PRODUCT-CLICKS")) {
  throw new Error("正式数据同步需要 --confirm=RUN-ONLINE-PRODUCT-CLICKS");
}
const tenant = new TenantRegistry(getEnv()).byId(tenantId);
if (!tenant) throw new Error("店铺绑定不存在");
const today = dateKeyInTimeZone(new Date(), tenant.profile.businessTimeZone);
const probeDays = tenant.profile.dailyAutomation?.probeDays ?? 14;
const contract = await fetchTikTokAnalytics("shop_product_performance", shiftIsoDate(today, -probeDays), today,
  "", 180_000, tikTokRuntimeFromProfile(tenant.profile));
const latest = contract.latest_available_date;
if (!contract.ok || !latest || !/^\d{4}-\d{2}-\d{2}$/.test(latest)) {
  throw new Error("商品分析缺少最新完整店铺日，拒绝猜日期");
}
const client = createFeishuClient(tenant.env);
const gateway = new StorefourDemoGateway(tenant.env, client, tenant.profile);
await gateway.initializeOnlineReadOnly();
const candidates = await listRecentOnlineProductClickCandidates({ latestCompleteShopDate: latest,
  probeDays: process.argv.includes("--backfill-all") ? 180 : probeDays, profile: tenant.profile, env: tenant.env, client });
const evidenceRoot = ".runtime/video-feature-parity-2026-09-29";
await mkdir(evidenceRoot, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const before = [...(await gateway.snapshotOnlineByVideoIds(candidates.map(c => c.video.id))).entries()];
await writeFile(`${evidenceRoot}/${tenantId}-${stamp}-clicks-before.json`, JSON.stringify({ latest, candidates, before }, null, 2));
const result = await syncOnlineVideoProductClicks({ candidates, profile: tenant.profile,
  env: tenant.env, client, gateway });
const after = [...(await gateway.snapshotOnlineByVideoIds(candidates.map(c => c.video.id))).entries()];
const previous = new Map(before);
const manualChanges = after.flatMap(([id, row]) => {
  const old = previous.get(id);
  if (!old || !row) return [{ id, field: "missing record" }];
  return Object.keys(old.fields).filter(f => f !== "商品点击量" && JSON.stringify(old.fields[f]) !== JSON.stringify(row.fields[f]))
    .map(field => ({ id, field }));
});
await writeFile(`${evidenceRoot}/${tenantId}-${stamp}-clicks-result.json`, JSON.stringify({ latest, candidates, result, after, manualChanges }, null, 2));
if (manualChanges.length) throw new Error("点击量写后发现其它字段变化，证据已保存，不自动回滚用户修改");
console.log(JSON.stringify({ tenantId, latestCompleteShopDate: latest, candidateCount: candidates.length,
  result, completedAt: new Date().toISOString() }, null, 2));
