import { onlineDiscoveryWindow } from "../automation/daily-sync.js";
import { getEnv } from "../config/env.js";
import { TenantRegistry, type ResolvedTenant } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";
import { StorefourDemoGateway } from "../feishu/storefour-demo-gateway.js";
import { prepareOlderSoldVideoRefreshPlan } from "../realtime/online-import.js";

const tenantId = argument("--tenant");
const latestCompleteDate = argument("--latest-complete-date");
if (!tenantId || !latestCompleteDate) {
  throw new Error("Required: --tenant ID --latest-complete-date YYYY-MM-DD");
}

const registry = new TenantRegistry(getEnv());
const tenant = registry.byId(tenantId) as ResolvedTenant | null;
if (!tenant) throw new Error(`Unknown tenant: ${tenantId}`);
const gateway = new StorefourDemoGateway(
  tenant.env,
  createFeishuClient(tenant.env),
  tenant.profile,
);
const discovery = onlineDiscoveryWindow(
  latestCompleteDate,
  latestCompleteDate,
  tenant.profile.dailyAutomation?.probeDays ?? 14,
  tenant.profile.tiktok.shopTimeZone,
  tenant.profile.businessTimeZone,
);
const preparation = await prepareOlderSoldVideoRefreshPlan({
  jobId: `rt-${new Date().toISOString().replaceAll(/[-:TZ.]/g, "").slice(0, 14)}-00000000`,
  latestCompleteShopDate: latestCompleteDate,
  recentPublishStartDate: discovery.startDate,
  gateway,
  profile: tenant.profile,
});

console.log(JSON.stringify({
  tenantId,
  shop: tenant.profile.businessDisplayName,
  mode: "read-only-plan",
  latestCompleteDate,
  recentPublishStartDate: discovery.startDate,
  detected: preparation.detected,
  eligible: preparation.eligible,
  existing: preparation.existing,
  missingFromOnlineTable: preparation.missingFromOnlineTable,
  outsideCumulativeWindow: preparation.outsideCumulativeWindow,
  detectionLatestAvailableDate: preparation.detectionLatestAvailableDate,
  plan: preparation.plan ? {
    metricWindowStart: preparation.plan.metricWindowStart,
    metricWindowEndExclusive: preparation.plan.metricWindowEndExclusive,
    matched: preparation.plan.videos.length,
    skipped: preparation.plan.skipped,
    conflicts: preparation.plan.conflicts,
    missingItems: preparation.plan.missingItems,
    videos: preparation.plan.videos.map(({ video, before }) => ({
      id: video.id,
      publishBusinessDate: video.date,
      creator: video.creator,
      products: video.products,
      beforeViewsK: before?.fields.视频曝光K ?? null,
      latestViewsK: video.viewsK,
      itemsSold: video.itemsSold,
      gmv: video.gmv,
    })),
  } : null,
}, null, 2));

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : "";
}
