import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareLatestAccountSidePlan } from "../account-side/plan.js";
import { loadProductCatalogMap } from "../automation/product-catalog.js";
import { onlineDiscoveryWindow, resolveLatestCompleteDate } from "../automation/daily-sync.js";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { businessDateRangeToShopDateRange, dateKeyInTimeZone, shiftIsoDate } from "../realtime/business-time.js";
import { buildOnlineImportPlan } from "../realtime/online-import.js";
import {
  prepareOrderAttributionUpdatePlan,
  prepareRoiBulkUpdatePlan,
} from "../realtime/roi-sync.js";
import {
  fetchTikTokAnalytics,
  fetchTikTokVideoDay,
  tikTokRuntimeFromProfile,
} from "../realtime/tiktok-cli.js";
import {
  ACCOUNT_ROI_COLUMNS,
  PRODUCT_ROI_COLUMNS,
  storeRoiColumns,
  toBrowserTsv,
} from "./browser-tenant-initialization-schema.js";

const ACCOUNT_INFO_COLUMNS = [
  "负责人", "账号名", "UID", "账号", "密码", "账号主页", "账号类型", "备注",
] as const;

const SHORT_VIDEO_COLUMNS = [
  "达人昵称", "达人ID", "视频ID网址", "发布时间", "商品", "视频vv", "视频商品成交件数", "商品交易总额（视频） ($)",
] as const;

const ONLINE_COLUMNS = [
  "登记日期", "实上线日期(Ct)", "达人姓名", "挂车产品", "视频上线地址", "视频曝光K", "售出数量", "销售额",
] as const;

const tenantId = argument("--tenant");
const registry = new TenantRegistry(getEnv());
const tenant = registry.byId(tenantId);
if (!tenant) throw new Error(`店铺租户不存在或未启用：${tenantId}`);

const { profile } = tenant;
const roiColumns = storeRoiColumns(profile.advertising);
const runtime = tikTokRuntimeFromProfile(profile);
const today = dateKeyInTimeZone(new Date(), profile.businessTimeZone);
const probeStart = shiftIsoDate(today, -14);
const [productContract, shopContract, videoContract] = await Promise.all([
  fetchTikTokAnalytics("shop_product_performance", probeStart, today, "", 180_000, runtime),
  fetchTikTokAnalytics("shop_performance_hourly", probeStart, today, "", 180_000, runtime),
  fetchTikTokVideoDay(probeStart, today, 180_000, runtime),
]);
const latestCompleteDate = resolveLatestCompleteDate(
  [productContract, shopContract, videoContract],
  today,
);
const startDate = shiftIsoDate(latestCompleteDate, -6);
const dates = enumerateDates(startDate, latestCompleteDate);
const [catalog, roiPlan, attributionPlan, accountPlan] = await Promise.all([
  loadProductCatalogMap(profile),
  prepareRoiBulkUpdatePlan({
    jobId: `browser-init-${tenantId}-${Date.now()}`,
    startDate,
    endDateInclusive: latestCompleteDate,
    rowFilter: "all",
    profile,
  }),
  prepareOrderAttributionUpdatePlan({ startDate, endDateInclusive: latestCompleteDate, profile }),
  prepareLatestAccountSidePlan({ profile, days: 7 }),
]);

const canonicalProducts = [...new Set(Object.values(catalog.products))];
const onlineDiscovery = onlineDiscoveryWindow(
  latestCompleteDate,
  latestCompleteDate,
  profile.dailyAutomation?.probeDays ?? 14,
  profile.tiktok.shopTimeZone,
  profile.businessTimeZone,
);
const onlineSourceRange = businessDateRangeToShopDateRange(
  onlineDiscovery.startDate,
  onlineDiscovery.endDateInclusive,
  profile.businessTimeZone,
  profile.tiktok.shopTimeZone,
);
const onlineContract = await fetchTikTokVideoDay(
  onlineSourceRange.startDate,
  onlineSourceRange.endDateExclusive,
  180_000,
  runtime,
);
const onlinePlan = await buildOnlineImportPlan(
  `browser-init-online-${tenantId}-${Date.now()}`,
  {
    action: "import_online_videos",
    target: "online",
    startDate: onlineDiscovery.startDate,
    endDateInclusive: onlineDiscovery.endDateInclusive,
  },
  onlineContract,
  catalog.products,
  { snapshotOnlineByVideoId: async () => null },
  profile,
);
const roiRows = buildRoiRows();
const onlineRows = onlinePlan.videos.map(({ video }) => compactRow({
  登记日期: today,
  "实上线日期(Ct)": video.date,
  达人姓名: video.creator,
  挂车产品: video.products.join(", "),
  视频上线地址: video.url,
  视频曝光K: video.viewsK,
  售出数量: video.itemsSold,
  销售额: video.gmv,
}));
const accountInfoRows = accountPlan.accounts.map((account) => compactRow({
  账号名: account.accountName,
  账号主页: account.handle ? `https://www.tiktok.com/@${account.handle}` : undefined,
  账号类型: account.accountTypeLabel,
}));
const shortVideoRows = accountPlan.videos.map((video) => compactRow({
  达人昵称: video.accountNickName || video.accountName,
  达人ID: video.accountName.startsWith("未识别账号-") ? undefined : `@${video.accountName}`,
  视频ID网址: video.videoUrl,
  发布时间: formatBusinessDateTime(video.publishedAtMs, profile.businessTimeZone),
  商品: video.productName,
  视频vv: Math.round((video.views / 1_000) * 1_000) / 1_000,
  视频商品成交件数: video.items,
  "商品交易总额（视频） ($)": video.gmv,
}));
const productRows = accountPlan.productRows.map((row) => accountRoiRecord(row, "商品", "TikTok商品ID"));
const accountRows = accountPlan.accountRows.map((row) => ({
  ...accountRoiRecord(row, "账号", "账号UID"),
  账号类型: row.accountTypeLabel,
}));
const payload = {
  version: 1,
  generatedAt: new Date().toISOString(),
  tenantId,
  shop: profile.businessDisplayName,
  sourceShop: catalog.shop,
  latestCompleteDate,
  startDate,
  dates,
  canonicalProducts,
  sourceEvidence: {
    roiRequestIds: roiPlan.requestIds,
    orderRequestIds: attributionPlan.requestIds,
    accountRequestIds: accountPlan.requestIds,
    onlineRequestIds: onlinePlan.requestIds,
    roiUnmappedPositiveProducts: roiPlan.unmappedPositiveProducts,
    orderUnmappedPositiveProductIds: attributionPlan.unmappedPositiveProductIds,
    orderPendingDates: attributionPlan.pendingDates,
    accountWarnings: accountPlan.warnings,
    onlineSkipped: onlinePlan.skipped,
    onlineConflicts: onlinePlan.conflicts,
    onlineMissingItems: onlinePlan.missingItems,
  },
  roi: {
    columns: roiColumns,
    rows: roiRows,
    tsv: toBrowserTsv(roiColumns, roiRows),
  },
  online: {
    columns: ONLINE_COLUMNS,
    rows: onlineRows,
    tsv: toBrowserTsv(ONLINE_COLUMNS, onlineRows),
  },
  accountInfo: {
    columns: ACCOUNT_INFO_COLUMNS,
    rows: accountInfoRows,
    tsv: toBrowserTsv(ACCOUNT_INFO_COLUMNS, accountInfoRows),
  },
  shortVideos: {
    columns: SHORT_VIDEO_COLUMNS,
    rows: shortVideoRows,
    tsv: toBrowserTsv(SHORT_VIDEO_COLUMNS, shortVideoRows),
  },
  productRoi: {
    columns: PRODUCT_ROI_COLUMNS,
    rows: productRows,
    tsv: toBrowserTsv(PRODUCT_ROI_COLUMNS, productRows),
  },
  accountRoi: {
    columns: ACCOUNT_ROI_COLUMNS,
    rows: accountRows,
    tsv: toBrowserTsv(ACCOUNT_ROI_COLUMNS, accountRows),
  },
};

const outputDir = path.resolve(".runtime", "browser-tenant-initialization");
await mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, `${tenantId}-${latestCompleteDate}.json`);
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  outputPath,
  tenantId,
  shop: payload.shop,
  latestCompleteDate,
  products: canonicalProducts.length,
  roiRows: roiRows.length,
  onlineRows: onlineRows.length,
  accountInfoRows: accountInfoRows.length,
  shortVideoRows: shortVideoRows.length,
  productRoiRows: productRows.length,
  accountRoiRows: accountRows.length,
  roiUnmappedPositiveProducts: roiPlan.unmappedPositiveProducts,
  orderUnmappedPositiveProductIds: attributionPlan.unmappedPositiveProductIds,
  orderPendingDates: attributionPlan.pendingDates,
  accountWarnings: accountPlan.warnings,
  onlineSkipped: onlinePlan.skipped,
  onlineConflicts: onlinePlan.conflicts,
  onlineMissingItems: onlinePlan.missingItems,
}, null, 2));

function buildRoiRows(): Array<Record<string, string | number>> {
  const analytics = new Map<string, Record<string, any>>();
  for (const entry of roiPlan.entries) {
    for (const source of entry.sources) analytics.set(key(entry.product.name, source.date), source);
  }
  const attribution = new Map<string, Record<string, any>>();
  for (const entry of attributionPlan.entries) {
    for (const source of entry.sources) attribution.set(key(entry.product.name, source.date), source);
  }
  const snapshots = new Map<string, Record<string, any>>();
  for (const entry of attributionPlan.paidSnapshotEntries) {
    for (const source of entry.sources) snapshots.set(key(entry.product.name, source.date), source);
  }
  const rows: Array<Record<string, string | number>> = [];
  for (const date of dates) {
    const sameDateAnalytics = [...analytics.entries()]
      .filter(([entryKey]) => entryKey.endsWith(`\u0000${date}`))
      .map(([, source]) => source);
    const sameDateAttribution = [...attribution.entries()]
      .filter(([entryKey]) => entryKey.endsWith(`\u0000${date}`))
      .map(([, source]) => source);
    rows.push(compactRow({
      商品: profile.storeAggregateLabel,
      日期: date,
      出单视频: firstDefined(sameDateAnalytics.map((source) => source.storeOrderingVideos)),
      店铺浏览量: firstDefined(sameDateAnalytics.map((source) => source.visitors)),
      店铺联盟达人视频出单量: firstDefined(sameDateAttribution.map((source) => source.storeAllianceVideoOrders)),
      店铺联盟达人视频出单数量: firstDefined(sameDateAttribution.map((source) => source.storeAllianceVideoItems)),
      店铺联盟达人直播出单量: firstDefined(sameDateAttribution.map((source) => source.storeAllianceLiveOrders)),
      店铺联盟达人直播出单数量: firstDefined(sameDateAttribution.map((source) => source.storeAllianceLiveItems)),
      店铺自营达人视频出单量: firstDefined(sameDateAttribution.map((source) => source.storeSelfOperatedVideoOrders)),
      店铺自营达人视频出单数量: firstDefined(sameDateAttribution.map((source) => source.storeSelfOperatedVideoItems)),
      店铺自营达人直播出单量: firstDefined(sameDateAttribution.map((source) => source.storeSelfOperatedLiveOrders)),
      店铺自营达人直播出单数量: firstDefined(sameDateAttribution.map((source) => source.storeSelfOperatedLiveItems)),
      "店铺商品卡出单量(API)": firstDefined(sameDateAttribution.map((source) => source.storeCardOrders)),
      店铺商品卡出单数量: firstDefined(sameDateAttribution.map((source) => source.storeCardItems)),
    }));
    for (const product of canonicalProducts) {
      const analyticsSource = analytics.get(key(product, date));
      const attributionSource = attribution.get(key(product, date));
      const snapshot = snapshots.get(key(product, date));
      rows.push(compactRow({
        商品: product,
        日期: date,
        单量: snapshot?.orders ?? attributionSource?.orders ?? analyticsSource?.orders,
        数量: snapshot?.items ?? attributionSource?.items ?? analyticsSource?.items,
        商品卡出单量: attributionSource?.cardOrders ?? analyticsSource?.cardOrders,
        商品卡出单数量: attributionSource?.cardItems ?? analyticsSource?.cardItems,
        销售额: snapshot?.sales ?? analyticsSource?.gmv,
        出单视频: analyticsSource?.orderingVideos,
        联盟达人视频出单量: attributionSource?.allianceVideoOrders,
        联盟达人视频出单数量: attributionSource?.allianceVideoItems,
        联盟达人直播出单量: attributionSource?.allianceLiveOrders,
        联盟达人直播出单数量: attributionSource?.allianceLiveItems,
        自营达人视频出单量: attributionSource?.selfOperatedVideoOrders,
        自营达人视频出单数量: attributionSource?.selfOperatedVideoItems,
        自营达人直播出单量: attributionSource?.selfOperatedLiveOrders,
        自营达人直播出单数量: attributionSource?.selfOperatedLiveItems,
      }));
    }
  }
  return rows;
}

function accountRoiRecord(
  row: (typeof accountPlan.productRows)[number],
  dimensionField: string,
  dimensionIdField: string,
): Record<string, string | number> {
  return compactRow({
    检查: row.key,
    店铺: row.store,
    [dimensionField]: row.dimension,
    [dimensionIdField]: row.dimensionId,
    日期: row.date,
    上线量: row.publishedVideos,
    出单视频: row.orderingVideos,
    单量: row.orders ?? undefined,
    数量: row.items,
    视频曝光: row.views,
    销售额: row.gmv,
    数据状态: row.status,
  });
}

function compactRow(input: Record<string, unknown>): Record<string, string | number> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => (
    value !== undefined && value !== null && (typeof value === "string" || typeof value === "number")
  ))) as Record<string, string | number>;
}

function firstDefined(values: unknown[]): string | number | undefined {
  const defined = values.find((value) => value !== undefined && value !== null);
  return typeof defined === "string" || typeof defined === "number" ? defined : undefined;
}

function formatBusinessDateTime(timestampMs: number, timeZone: string): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) throw new Error(`账号端视频发布时间无效：${String(timestampMs)}`);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(new Date(timestampMs));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}`;
}

function key(product: string, date: string): string {
  return `${product}\u0000${date}`;
}

function enumerateDates(start: string, endInclusive: string): string[] {
  const result: string[] = [];
  for (let current = start; current <= endInclusive; current = shiftIsoDate(current, 1)) result.push(current);
  return result;
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : "";
  if (!value) throw new Error(`缺少参数 ${name}`);
  return value;
}
