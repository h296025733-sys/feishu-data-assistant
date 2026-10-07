import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";
import {
  StorefourDemoGateway,
  type DailySource,
  type VideoSource,
} from "../feishu/storefour-demo-gateway.js";
import {
  fetchTikTokAnalytics,
  fetchTikTokVideoDay,
} from "../realtime/tiktok-cli.js";
import { requireTikTokHandleFromVideoRow } from "../realtime/tiktok-identity.js";
import { shopTimestampToBusinessDate } from "../realtime/business-time.js";
import { fetchOrderingVideoCounts } from "../realtime/roi-sync.js";
import { loadBusinessProfile } from "../config/business-profile.js";

process.on("uncaughtException", failSafely);
process.on("unhandledRejection", failSafely);

const PRODUCT_ID = "1732482160735195549";
const VIDEO_ID = "7665612776009780494";
const SOURCE_SHOP = "Storefour";
const DATES = ["2026-07-23", "2026-07-24"] as const;
const PRODUCT_MAP_PATH = resolve("config", "tiktok-product-map.json");
const BUSINESS_PROFILE = loadBusinessProfile();

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env);
const productMap = JSON.parse(await readFile(PRODUCT_MAP_PATH, "utf8")) as {
  shop?: string;
  products?: Record<string, string>;
};
const productName = String(productMap.products?.[PRODUCT_ID] ?? "").trim();
if (!productName) throw new Error(`商品映射缺失：${PRODUCT_ID}`);
if (productMap.shop !== SOURCE_SHOP) throw new Error(`商品映射店铺不是 ${SOURCE_SHOP}`);

const sources: DailySource[] = [];
for (const date of DATES) {
  const next = nextDate(date);
  const productContract = await fetchTikTokAnalytics(
    "shop_product_performance",
    date,
    next,
  );
  const shopContract = await fetchTikTokAnalytics(
    "shop_performance_hourly",
    date,
    next,
  );
  const orderingVideos = await fetchOrderingVideoCounts(date, next);
  assertSourceShop(productContract.shop?.name);
  assertSourceShop(shopContract.shop?.name);
  const product = productContract.rows.find((row) => String(row.id ?? "") === PRODUCT_ID);
  if (!product) throw new Error(`${date} 未找到商品 ${PRODUCT_ID}`);
  const total = objectValue(product.total_performance);
  const card = objectValue(product.seller_product_card_performance);
  const overall = objectValue(objectValue(shopContract.rows[0]?.performance).overall);
  sources.push({
    date,
    orders: finiteNumber(total.orders, `${date}.orders`),
    items: finiteNumber(total.items_sold, `${date}.items_sold`),
    gmv: moneyValue(total.gmv, `${date}.gmv`),
    cardOrders: finiteNumber(card.attributed_orders, `${date}.card_orders`),
    cardItems: finiteNumber(card.attributed_sold_items, `${date}.card_items`),
    visitors: finiteNumber(overall.visitors, `${date}.visitors`),
    orderingVideos: orderingVideos.byProductId.get(PRODUCT_ID)?.size ?? 0,
    storeOrderingVideos: orderingVideos.storeVideoIds.size,
    sourceFiles: [
      ...(productContract.raw_source_paths ?? []),
      ...(shopContract.raw_source_paths ?? []),
      ...orderingVideos.sourceFiles,
    ],
    requestIds: [
      ...(productContract.request_ids ?? []),
      ...(shopContract.request_ids ?? []),
      ...orderingVideos.requestIds,
    ],
  });
}

const videoContract = await fetchTikTokVideoDay(DATES[0], nextDate(DATES.at(-1)!));
assertSourceShop(videoContract.shop?.name);
const videoRow = videoContract.rows.find((row) => String(row.id ?? "") === VIDEO_ID);
if (!videoRow) throw new Error(`未找到视频 ${VIDEO_ID}`);
const videoProducts = arrayValue(videoRow.products);
if (!videoProducts.some((item) => String(objectValue(item).id ?? "") === PRODUCT_ID)) {
  throw new Error(`视频 ${VIDEO_ID} 没有关联商品 ${PRODUCT_ID}`);
}
const videoDate = shopTimestampToBusinessDate(
  videoRow.video_post_time,
  BUSINESS_PROFILE.tiktok.shopTimeZone,
  BUSINESS_PROFILE.businessTimeZone,
);
const creatorHandle = requireTikTokHandleFromVideoRow(videoRow);
const video: VideoSource = {
  id: VIDEO_ID,
  date: videoDate,
  creator: creatorHandle,
  products: [productName],
  url: `https://www.tiktok.com/@${creatorHandle}/video/${VIDEO_ID}`,
  viewsK: finiteNumber(videoRow.views, "video.views") / 1000,
  itemsSold: finiteNumber(videoRow.items_sold, "video.items_sold"),
  gmv: finiteNumber(videoRow.gmv_amount, "video.gmv_amount"),
  gmvCurrency: "USD",
  metricWindowStart: videoContract.window_start,
  metricWindowEndExclusive: videoContract.window_end_exclusive,
};
if (String(videoRow.gmv_currency ?? "").toUpperCase() !== "USD") {
  throw new Error(`视频GMV币种不是USD：${String(videoRow.gmv_currency ?? "空")}`);
}

const gateway = new StorefourDemoGateway(env, client);
await gateway.initialize(productName);
const roiChanges = await gateway.syncRoi(sources, productName);
const onlineChanges = await gateway.syncOnline(video);
const verification = await gateway.verify(
  sources,
  productName,
  video,
  onlineChanges.recordId,
);
if (!verification.ok) {
  throw new Error(`写后验证失败：${verification.errors.join("；")}`);
}

const report = {
  ok: true,
  mode: "live_tiktok_read_and_feishu_write",
  sourceShop: SOURCE_SHOP,
  product: { id: PRODUCT_ID, name: productName },
  video,
  dates: sources,
  changes: { roi: roiChanges, online: onlineChanges },
  verification,
  untouched: [
    "飞书公式字段",
    "合作表",
    "广告字段",
    "退货量",
    "自孵化字段",
    "人工分类与备注",
  ],
  generatedAt: new Date().toISOString(),
};
await mkdir(resolve("reports"), { recursive: true });
const reportPath = resolve(
  "reports",
  `storefour-real-demo-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}.json`,
);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...report, reportPath }, null, 2));

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function arrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function finiteNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} 不是有效数字`);
  return parsed;
}

function moneyValue(value: unknown, label: string): number {
  return finiteNumber(objectValue(value).amount, label);
}

function assertSourceShop(value: unknown): void {
  if (String(value ?? "").toLocaleLowerCase("en-US") !== SOURCE_SHOP.toLowerCase()) {
    throw new Error(`TikTok API 当前店铺不是 ${SOURCE_SHOP}：${String(value ?? "")}`);
  }
}

function nextDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function failSafely(error: unknown): void {
  const value = error as {
    message?: unknown;
    response?: { data?: unknown; status?: unknown };
  };
  const details = value.response?.data
    ? `；HTTP ${String(value.response.status ?? "")} ${JSON.stringify(value.response.data)}`
    : "";
  const message = `${String(value.message ?? error)}${details}`
    .replace(
      /(?i:authorization|app[_ -]?secret|access[_ -]?token|refresh[_ -]?token|shop_cipher|sign)(\s*[:=]\s*)[^\s,;&"]+/g,
      "$1$2****",
    )
    .slice(0, 2_000);
  console.error(message);
  process.exit(1);
}
