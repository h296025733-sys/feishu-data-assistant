import { getEnv } from "../config/env.js";
import { TenantRegistry, type ResolvedTenant } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";
import { StorefourDemoGateway } from "../feishu/storefour-demo-gateway.js";
import { onlineDiscoveryWindow } from "../automation/daily-sync.js";
import { executeOnlineImportPlan, prepareOnlineImportPlan } from "../realtime/online-import.js";

const tenantId = argument("--tenant");
const requestedStart = argument("--start-date");
const latestCompleteDate = argument("--latest-complete-date");
if (!tenantId || !requestedStart || !latestCompleteDate) {
  throw new Error("Required: --tenant ID --start-date YYYY-MM-DD --latest-complete-date YYYY-MM-DD");
}

const registry = new TenantRegistry(getEnv());
const tenant = registry.byId(tenantId) as ResolvedTenant | null;
if (!tenant) throw new Error(`Unknown tenant: ${tenantId}`);
const client = createFeishuClient(tenant.env);
const gateway = new StorefourDemoGateway(tenant.env, client, tenant.profile);
const discovery = onlineDiscoveryWindow(
  requestedStart,
  latestCompleteDate,
  tenant.profile.dailyAutomation?.probeDays ?? 14,
  tenant.profile.tiktok.shopTimeZone,
  tenant.profile.businessTimeZone,
);
const plan = await prepareOnlineImportPlan({
  jobId: `rt-${new Date().toISOString().replaceAll(/[-:TZ.]/g, "").slice(0, 14)}-00000000`,
  intent: {
    action: "import_online_videos",
    target: "online",
    startDate: discovery.startDate,
    endDateInclusive: discovery.endDateInclusive,
  },
  gateway,
  metricEndDateInclusive: latestCompleteDate,
  profile: tenant.profile,
});
const createMissing = process.argv.includes("--create-missing");
const newOnlyPlan = {
  ...plan,
  videos: plan.videos.filter((item) => item.before === null),
};
const writeResult = createMissing && newOnlyPlan.videos.length > 0
  ? await executeOnlineImportPlan(newOnlyPlan, gateway)
  : null;

console.log(JSON.stringify({
  tenantId,
  shop: tenant.profile.businessDisplayName,
  mode: createMissing ? "create-missing-only" : "read-only-plan",
  latestCompleteDate,
  apiLatestAvailableDate: plan.latestAvailableDate,
  metricWindow: {
    startDate: plan.metricWindowStart,
    endDateExclusive: plan.metricWindowEndExclusive,
  },
  discovery,
  matched: plan.videos.length,
  newRecords: plan.videos.filter((item) => item.before === null).length,
  existingRecords: plan.videos.filter((item) => item.before !== null).length,
  skipped: plan.skipped,
  conflicts: plan.conflicts,
  writeResult,
  videos: plan.videos.map(({ video, before }) => ({
    id: video.id,
    date: video.date,
    creator: video.creator,
    products: video.products,
    viewsK: video.viewsK,
    itemsSold: video.itemsSold,
    gmv: video.gmv,
    alreadyInBase: before !== null,
    before: before ? {
      viewsK: before.fields.视频曝光K ?? null,
      itemsSold: before.fields.售出数量 ?? null,
      gmv: before.fields.销售额 ?? null,
    } : null,
    metricChanged: before === null
      || Math.abs(Number(before.fields.视频曝光K ?? 0) - video.viewsK) > 0.000001
      || Math.abs(Number(before.fields.售出数量 ?? 0) - video.itemsSold) > 0.000001
      || Math.abs(Number(before.fields.销售额 ?? 0) - video.gmv) > 0.000001,
  })),
}, null, 2));

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : "";
}
