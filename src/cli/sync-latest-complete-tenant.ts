import { randomUUID } from "node:crypto";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";
import { StorefourDemoGateway } from "../feishu/storefour-demo-gateway.js";
import {
  onlineDiscoveryWindow,
  resolveLatestCompleteDate,
} from "../automation/daily-sync.js";
import { loadProductCatalogMap } from "../automation/product-catalog.js";
import {
  dateKeyInTimeZone,
  shiftIsoDate,
} from "../realtime/business-time.js";
import {
  executeOnlineImportPlan,
  prepareOnlineImportPlan,
  type OnlineImportPlan,
} from "../realtime/online-import.js";
import {
  executeOrderAttributionUpdatePlan,
  executeRoiBulkUpdatePlan,
  prepareOrderAttributionUpdatePlan,
  prepareRoiBulkUpdatePlan,
  type OrderAttributionUpdatePlan,
} from "../realtime/roi-sync.js";
import {
  fetchTikTokAnalytics,
  fetchTikTokVideoDay,
  tikTokRuntimeFromProfile,
} from "../realtime/tiktok-cli.js";
import type { RealtimeResultSummary } from "../realtime/types.js";

const tenantId = argument("--tenant");
const apply = process.argv.includes("--apply");
const registry = new TenantRegistry(getEnv());
const tenant = registry.byId(tenantId);
if (!tenant) throw new Error(`店铺租户不存在或未启用：${tenantId}`);

const profile = tenant.profile;
const runtime = tikTokRuntimeFromProfile(profile);
const today = dateKeyInTimeZone(new Date(), profile.businessTimeZone);
const probeDays = profile.dailyAutomation?.probeDays ?? 14;
const probeStart = shiftIsoDate(today, -probeDays);
const [productContract, shopContract, videoContract] = await Promise.all([
  fetchTikTokAnalytics("shop_product_performance", probeStart, today, "", 180_000, runtime),
  fetchTikTokAnalytics("shop_performance_hourly", probeStart, today, "", 180_000, runtime),
  fetchTikTokVideoDay(probeStart, today, 180_000, runtime),
]);
const analyticsLatestDate = resolveLatestCompleteDate(
  [productContract, shopContract, videoContract],
  today,
);

// A "latest complete" verification requires both Analytics and deterministic
// order attribution to be write-ready for the same shop day. Probe once for a
// bounded seven-day window, then choose the newest common day without guessing.
const attributionProbeStart = shiftIsoDate(analyticsLatestDate, -6);
const attributionProbe = await prepareOrderAttributionUpdatePlan({
  startDate: attributionProbeStart,
  endDateInclusive: analyticsLatestDate,
  profile,
});
const attributionReadyDates = new Set(
  attributionProbe.entries.flatMap((entry) => entry.sources.map((source) => source.date)),
);
const targetDate = newestReadyDate(analyticsLatestDate, attributionProbeStart, attributionReadyDates);
if (!targetDate) {
  throw new Error(
    `Analytics最新完整日为 ${analyticsLatestDate}，但最近7天没有同日可写的订单归因；本次拒绝写入。`,
  );
}

const orderPlan: OrderAttributionUpdatePlan = {
  ...attributionProbe,
  startDate: targetDate,
  endDateInclusive: targetDate,
  entries: attributionProbe.entries
    .map((entry) => ({
      ...entry,
      sources: entry.sources.filter((source) => source.date === targetDate),
    }))
    .filter((entry) => entry.sources.length > 0),
  paidSnapshotEntries: attributionProbe.paidSnapshotEntries
    .map((entry) => ({
      ...entry,
      sources: entry.sources.filter((source) => source.date === targetDate),
    }))
    .filter((entry) => entry.sources.length > 0),
  pendingDates: [],
};
const gateway = new StorefourDemoGateway(
  tenant.env,
  createFeishuClient(tenant.env),
  profile,
);
const discovery = onlineDiscoveryWindow(
  targetDate,
  targetDate,
  probeDays,
  profile.tiktok.shopTimeZone,
  profile.businessTimeZone,
);
const [onlinePlan, roiPlan] = await Promise.all([
  prepareOnlineImportPlan({
    jobId: jobId(),
    intent: {
      action: "import_online_videos",
      target: "online",
      startDate: discovery.startDate,
      endDateInclusive: discovery.endDateInclusive,
    },
    gateway,
    metricEndDateInclusive: targetDate,
    profile,
  }),
  prepareRoiBulkUpdatePlan({
    jobId: jobId(),
    startDate: targetDate,
    endDateInclusive: targetDate,
    rowFilter: "all",
    profile,
  }),
]);

const blockers = [
  ...(roiPlan.entries.length === 0 ? ["投产比计划没有可写入的白名单商品记录"] : []),
  ...roiPlan.unmappedPositiveProducts.map((item) => `投产比存在有单但未映射商品：${item.name}(${item.id})`),
  ...onlinePlan.conflicts.map((item) => `上线表冲突 ${item.key}：${item.reason}`),
  ...onlinePlan.missingItems.map((item) => `上线表待处理：${item}`),
  ...orderPlan.unmappedPositiveProductIds.map((id) => `订单归因存在未映射正数商品：${id}`),
  ...(orderPlan.entries.length === 0 ? ["订单归因计划没有同日可写记录"] : []),
];

const preview = {
  tenantId,
  shop: profile.businessDisplayName,
  mode: apply ? "apply" : "dry-run",
  today,
  analyticsLatestDate,
  targetDate,
  targetFallbackDays: dateDistance(targetDate, analyticsLatestDate),
  analytics: {
    product: contractDigest(productContract),
    shop: contractDigest(shopContract),
    video: contractDigest(videoContract),
  },
  roi: {
    entries: roiPlan.entries.map((entry) => ({
      product: entry.product.name,
      sources: entry.sources.map((source) => ({
        date: source.date,
        orders: source.orders,
        items: source.items,
        gmv: source.gmv,
        currency: profile.tiktok.currencyCode,
        cardOrders: source.cardOrders,
        cardItems: source.cardItems,
        visitors: source.visitors,
        orderingVideos: source.orderingVideos,
        storeOrderingVideos: source.storeOrderingVideos,
      })),
    })),
    skippedRows: roiPlan.skippedRows,
    unmappedPositiveProducts: roiPlan.unmappedPositiveProducts,
  },
  online: {
    discovery,
    matched: onlinePlan.videos.length,
    newRecords: onlinePlan.videos.filter((item) => item.before === null).length,
    existingRecords: onlinePlan.videos.filter((item) => item.before !== null).length,
    skipped: onlinePlan.skipped,
    videos: onlinePlan.videos.map(({ video, before }) => ({
      id: video.id,
      date: video.date,
      creator: video.creator,
      products: video.products,
      viewsK: video.viewsK,
      itemsSold: video.itemsSold,
      gmv: video.gmv,
      currency: video.gmvCurrency,
      alreadyInBase: before !== null,
    })),
  },
  orderAttribution: {
    probedRange: `${attributionProbeStart}..${analyticsLatestDate}`,
    pendingDates: attributionProbe.pendingDates,
    products: orderPlan.entries.map((entry) => ({
      product: entry.product.name,
      sources: entry.sources,
    })),
  },
  blockers,
};

if (!apply) {
  console.log(JSON.stringify(preview, null, 2));
  process.exit(blockers.length === 0 ? 0 : 2);
}
if (blockers.length > 0) {
  throw new Error(`预检存在阻断项，拒绝写入：${blockers.join("；")}`);
}

const onlineResults: RealtimeResultSummary[] = [];
for (const chunk of chunkOnlinePlan(onlinePlan, 50)) {
  onlineResults.push(await executeOnlineImportPlan(chunk, gateway));
}
const roiResult = await executeRoiBulkUpdatePlan(roiPlan, gateway);
// Run order attribution last: its order/count/channel fields are newer and
// deterministic, while the Analytics stage remains the source of GMV,
// visitors and ordering-video counts.
const attributionResult = await executeOrderAttributionUpdatePlan(orderPlan, gateway);

const productReadback = [];
const mappedCatalog = await loadProductCatalogMap(profile);
const readbackProducts = profile.tiktok.autoEnrollNewProducts
  ? [...new Set(Object.values(mappedCatalog.products))]
  : profile.tiktok.includedCanonicalProducts ?? [];
for (const product of readbackProducts) {
  const record = (await gateway.snapshotRoiProductRecords(product))
    .find((item) => item.dateKey === targetDate);
  productReadback.push({
    product,
    found: Boolean(record),
    recordId: record?.recordId ?? null,
    fields: record?.fields ?? null,
  });
}
const onlineReadback = [];
for (const item of onlinePlan.videos) {
  const record = await gateway.snapshotOnlineByVideoId(item.video.id);
  onlineReadback.push({ videoId: item.video.id, found: Boolean(record), fields: record?.fields ?? null });
}

console.log(JSON.stringify({
  ...preview,
  result: {
    online: combineResults(onlineResults, targetDate),
    roi: roiResult,
    orderAttribution: attributionResult,
  },
  readback: {
    roiProducts: productReadback,
    onlineVideos: onlineReadback,
  },
}, null, 2));

function contractDigest(contract: {
  dataset: string;
  ok: boolean;
  latest_available_date?: string | null;
  row_count: number;
  errors: string[];
  request_ids: string[];
}) {
  return {
    dataset: contract.dataset,
    ok: contract.ok,
    latestAvailableDate: contract.latest_available_date ?? null,
    rowCount: contract.row_count,
    errors: contract.errors,
    requestCount: contract.request_ids.length,
  };
}

function newestReadyDate(latest: string, earliest: string, ready: Set<string>): string | null {
  for (let date = latest; date >= earliest; date = shiftIsoDate(date, -1)) {
    if (ready.has(date)) return date;
  }
  return null;
}

function dateDistance(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

function chunkOnlinePlan(plan: OnlineImportPlan, size: number): OnlineImportPlan[] {
  if (plan.videos.length === 0) return [];
  const chunks: OnlineImportPlan[] = [];
  for (let index = 0; index < plan.videos.length; index += size) {
    chunks.push({ ...plan, jobId: jobId(), videos: plan.videos.slice(index, index + size) });
  }
  return chunks;
}

function combineResults(results: RealtimeResultSummary[], targetDate: string): RealtimeResultSummary {
  return {
    windowStart: targetDate,
    windowEndExclusive: shiftIsoDate(targetDate, 1),
    sources: [...new Set(results.flatMap((item) => item.sources))],
    matched: results.reduce((sum, item) => sum + item.matched, 0),
    created: results.reduce((sum, item) => sum + item.created, 0),
    updated: results.reduce((sum, item) => sum + item.updated, 0),
    unchanged: results.reduce((sum, item) => sum + item.unchanged, 0),
    skipped: results.reduce((sum, item) => sum + item.skipped, 0),
    conflicts: results.reduce((sum, item) => sum + item.conflicts, 0),
    missingItems: [...new Set(results.flatMap((item) => item.missingItems))],
    backupPath: results.map((item) => item.backupPath).find(Boolean) ?? null,
    rollbackCommand: results.map((item) => item.rollbackCommand).find(Boolean) ?? null,
  };
}

function jobId(): string {
  return `rt-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
  if (!value) throw new Error(`缺少参数 ${name}`);
  return value;
}
