import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { BusinessProfile } from "../config/business-profile.js";
import {
  dateKeyInTimeZone,
  shiftIsoDate,
  shopTimestampToBusinessDate,
} from "../realtime/business-time.js";
import {
  fetchTikTokAnalytics,
  fetchTikTokVideoDay,
  tikTokRuntimeFromProfile,
} from "../realtime/tiktok-cli.js";
import type { TikTokMachineContract, TikTokVideoRow } from "../realtime/types.js";

const ACCOUNT_TYPES = ["OFFICIAL_ACCOUNTS", "MARKETING_ACCOUNTS"] as const;
const PRODUCT_MAP_SCHEMA = z.object({
  shop: z.string().min(1),
  products: z.record(z.string(), z.string().min(1)),
});

export type OwnedAccountType = typeof ACCOUNT_TYPES[number];

export interface AccountSideAccount {
  key: string;
  store: string;
  owner: string;
  accountName: string;
  uid: string;
  handle: string;
  accountType: OwnedAccountType;
  accountTypeLabel: string;
  status: string;
  notes: string;
}

export interface AccountSideVideo {
  key: string;
  store: string;
  accountNickName: string;
  accountName: string;
  accountUid: string;
  accountType: OwnedAccountType;
  accountTypeLabel: string;
  videoId: string;
  videoUrl: string;
  publishedAtMs: number;
  publishedBusinessDate: string;
  productName: string;
  productId: string;
  views: number;
  orders: number | null;
  items: number;
  gmv: number;
  metricStartDate: string;
  metricEndDate: string;
  fetchedAtMs: number;
  status: string;
}

export interface AccountSideRoiRow {
  key: string;
  store: string;
  dimension: string;
  dimensionId: string;
  accountTypeLabel: string;
  date: string;
  publishedVideos: number;
  orderingVideos: number;
  orders: number | null;
  items: number;
  views: number;
  gmv: number;
  /** Store-overview rows only; copied from the store-side ROI source during Feishu sync. */
  adSpend?: number | null;
  /** Store-overview rows only; copied from the store-side ROI source during Feishu sync. */
  adOrders?: number | null;
  status: string;
}

export interface AccountSidePlan {
  version: 1;
  generatedAt: string;
  shop: { id: string; name: string };
  sourceContext?: {
    roiTableName: string;
    storeAggregateLabel: string;
    businessTimeZone: string;
  };
  latestAvailableDate: string;
  startDate: string;
  endDateInclusive: string;
  dates: string[];
  accounts: AccountSideAccount[];
  videos: AccountSideVideo[];
  productRows: AccountSideRoiRow[];
  accountRows: AccountSideRoiRow[];
  requestIds: string[];
  sourceFiles: string[];
  warnings: string[];
}

interface ProductMap {
  shop: string;
  products: Record<string, string>;
}

interface ParsedVideo {
  sourceDate: string;
  accountType: OwnedAccountType;
  videoId: string;
  accountName: string;
  accountUid: string;
  accountNickName: string;
  postTime: string;
  publishedBusinessDate: string | null;
  productIds: string[];
  views: number;
  orders: number;
  items: number;
  gmv: number;
  currency: string;
}

interface MutableMetrics {
  publishedVideoIds: Set<string>;
  orderingVideoIds: Set<string>;
  orders: number | null;
  items: number;
  views: number;
  gmv: number;
  statuses: Set<string>;
}

export async function prepareLatestAccountSidePlan(input: {
  profile: BusinessProfile;
  days?: number;
  now?: Date;
}): Promise<AccountSidePlan> {
  const days = Math.max(1, Math.min(31, Math.trunc(input.days ?? 7)));
  const profile = input.profile;
  const shopId = String(profile.tiktok.shopId ?? "").trim();
  const currencyCode = String(profile.tiktok.currencyCode ?? "").trim().toUpperCase();
  if (!shopId) throw new Error("账号端同步要求业务配置包含TikTok Shop ID");
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw new Error("账号端同步要求业务配置包含三位ISO货币代码");
  const runtime = tikTokRuntimeFromProfile(profile);
  const sourceToday = dateKeyInTimeZone(input.now ?? new Date(), profile.tiktok.shopTimeZone);
  const probeStart = shiftIsoDate(sourceToday, -Math.max(14, days + 2));
  const probeEnd = shiftIsoDate(sourceToday, 1);
  const probes = await Promise.all(ACCOUNT_TYPES.map((accountType) => fetchTikTokVideoDay(
    probeStart,
    probeEnd,
    180_000,
    runtime,
    accountType,
  )));
  const latestDates = probes.map((contract) => contract.latest_available_date ?? "").filter(Boolean).sort();
  if (latestDates.length !== ACCOUNT_TYPES.length) {
    throw new Error("账号端视频表现接口没有同时返回官方账号与营销账号的完整日边界");
  }
  const latestAvailableDate = latestDates[0]!;
  const startDate = shiftIsoDate(latestAvailableDate, 1 - days);
  const dates = enumerateDates(startDate, latestAvailableDate);
  const productMap = await loadProductMap(profile);
  assertShop(profile, productMap.shop);

  const dailyContracts = await mapWithConcurrency(
    dates.flatMap((date) => ACCOUNT_TYPES.map((accountType) => ({ date, accountType }))),
    2,
    async ({ date, accountType }) => ({
      date,
      accountType,
      contract: await fetchTikTokVideoDay(
        date,
        shiftIsoDate(date, 1),
        180_000,
        runtime,
        accountType,
      ),
    }),
  );
  for (const item of dailyContracts) {
    assertContract(item.contract, profile, item.date);
  }

  const broadContracts = await Promise.all(ACCOUNT_TYPES.map(async (accountType) => ({
    accountType,
    contract: await fetchTikTokVideoDay(
      startDate,
      shiftIsoDate(latestAvailableDate, 1),
      180_000,
      runtime,
      accountType,
    ),
  })));
  broadContracts.forEach((item) => assertContract(item.contract, profile, latestAvailableDate));

  const warnings = new Set<string>();
  const requestIds = new Set<string>();
  const sourceFiles = new Set<string>();
  for (const contract of [...probes, ...dailyContracts.map((item) => item.contract), ...broadContracts.map((item) => item.contract)]) {
    contract.request_ids.forEach((value) => requestIds.add(value));
    contract.raw_source_paths.forEach((value) => sourceFiles.add(value));
  }

  const parsedDailyRaw = dailyContracts.flatMap(({ date, accountType, contract }) => contract.rows.map((row) => (
    parseVideo(row, date, accountType, profile, productMap, warnings)
  )).filter((row): row is ParsedVideo => row !== null));
  const parsedBroadRaw = broadContracts.flatMap(({ accountType, contract }) => contract.rows.map((row) => (
    parseVideo(row, startDate, accountType, profile, productMap, warnings)
  )).filter((row): row is ParsedVideo => row !== null));
  const identityEvidence = [...parsedDailyRaw, ...parsedBroadRaw];
  const parsedDaily = reconcileMissingAccountIdentities(parsedDailyRaw, identityEvidence, warnings);
  const parsedBroad = reconcileMissingAccountIdentities(parsedBroadRaw, identityEvidence, warnings);
  const productRows = await buildProductRows(parsedDaily, dates, productMap, profile, warnings, requestIds, sourceFiles);
  const accountRows = buildAccountRows(parsedDaily, dates, profile, warnings);
  const videos = await buildVideoRows(
    parsedBroad,
    startDate,
    latestAvailableDate,
    productMap,
    profile,
    warnings,
    requestIds,
    sourceFiles,
  );
  const accounts = buildAccounts(parsedBroad, profile);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    shop: { id: shopId, name: profile.businessDisplayName },
    sourceContext: {
      roiTableName: profile.tables.roi,
      storeAggregateLabel: profile.storeAggregateLabel,
      businessTimeZone: profile.businessTimeZone,
    },
    latestAvailableDate,
    startDate,
    endDateInclusive: latestAvailableDate,
    dates,
    accounts,
    videos,
    productRows,
    accountRows,
    requestIds: [...requestIds],
    sourceFiles: [...sourceFiles],
    warnings: [...warnings].sort((left, right) => left.localeCompare(right, "zh-CN")),
  };
}

function parseVideo(
  row: TikTokVideoRow,
  sourceDate: string,
  accountType: OwnedAccountType,
  profile: BusinessProfile,
  productMap: ProductMap,
  warnings: Set<string>,
): ParsedVideo | null {
  const videoId = String(row.id ?? "").trim();
  if (!/^\d{10,}$/.test(videoId)) {
    warnings.add("Video Analytics返回了缺少有效视频ID的账号端记录，已跳过");
    return null;
  }
  const productIds = parseProducts(row.products).filter((id) => productMap.products[id]);
  if (productIds.length === 0) return null;
  const accountName = normalizeHandle(row.creator_user_name ?? row.username);
  const accountUid = String(row.creator_open_id ?? "").trim();
  const postTime = String(row.video_post_time ?? "").trim();
  let publishedBusinessDate: string | null = null;
  if (postTime) {
    try {
      publishedBusinessDate = shopTimestampToBusinessDate(
        postTime,
        profile.tiktok.shopTimeZone,
        profile.businessTimeZone,
      );
    } catch {
      warnings.add(`视频${videoId}发布时间无法换算为北京时间，未用于上线量`);
    }
  }
  const configuredCurrency = String(profile.tiktok.currencyCode ?? "").trim().toUpperCase();
  const currency = String(row.gmv_currency ?? "").trim().toUpperCase();
  if (!configuredCurrency) throw new Error("账号端同步缺少店铺货币配置");
  if (currency && currency !== configuredCurrency) {
    throw new Error(`视频${videoId}币种为${currency}，与店铺配置${configuredCurrency}不一致`);
  }
  return {
    sourceDate,
    accountType,
    videoId,
    accountName: accountName || `未识别账号-${accountType}`,
    accountUid,
    accountNickName: String(row.creator_nick_name ?? "").trim(),
    postTime,
    publishedBusinessDate,
    productIds,
    views: nonNegativeInteger(row.views, `${videoId}.views`),
    orders: nonNegativeInteger(row.sku_orders, `${videoId}.sku_orders`),
    items: nonNegativeInteger(row.items_sold, `${videoId}.items_sold`),
    gmv: money(row.gmv_amount, `${videoId}.gmv_amount`),
    currency: currency || configuredCurrency,
  };
}

export async function buildProductRows(
  videos: ParsedVideo[],
  dates: string[],
  productMap: ProductMap,
  profile: BusinessProfile,
  warnings: Set<string>,
  requestIds: Set<string>,
  sourceFiles: Set<string>,
): Promise<AccountSideRoiRow[]> {
  const byKey = new Map<string, MutableMetrics>();
  const storeByDate = new Map<string, MutableMetrics>();
  // Several TikTok IDs can deliberately map to one business product. The
  // persisted/UI key is store + product NAME + date, so aggregate at that
  // same grain instead of creating duplicate business keys per listing ID.
  const productNames = [...new Set(Object.values(productMap.products))];
  for (const date of dates) {
    storeByDate.set(date, emptyMetrics());
    for (const productName of productNames) {
      byKey.set(`${date}\u0000${productName}`, emptyMetrics());
    }
  }

  for (const video of videos) {
    const store = storeByDate.get(video.sourceDate)!;
    mergeWholeVideo(store, video, video.postTime.slice(0, 10) === video.sourceDate);
    const videoProductNames = [...new Set(video.productIds.map((id) => productMap.products[id]))];
    if (videoProductNames.length === 1) {
      const target = byKey.get(`${video.sourceDate}\u0000${videoProductNames[0]}`)!;
      mergeWholeVideo(target, video, video.postTime.slice(0, 10) === video.sourceDate);
      continue;
    }

    const detail = await fetchTikTokAnalytics(
      "shop_video_product_performance",
      video.sourceDate,
      shiftIsoDate(video.sourceDate, 1),
      video.videoId,
      180_000,
      tikTokRuntimeFromProfile(profile),
    );
    detail.request_ids.forEach((value) => requestIds.add(value));
    detail.raw_source_paths.forEach((value) => sourceFiles.add(value));
    const countedViews = new Set<string>();
    for (const productId of video.productIds) {
      const productName = productMap.products[productId]!;
      const target = byKey.get(`${video.sourceDate}\u0000${productName}`)!;
      const product = detail.rows.find((row) => String(row.id ?? "") === productId);
      if (!product) {
        target.orders = null;
        target.statuses.add("多商品视频缺少商品明细");
        continue;
      }
      if (!countedViews.has(productName)) target.views += video.views;
      countedViews.add(productName);
      if (video.postTime.slice(0, 10) === video.sourceDate) target.publishedVideoIds.add(video.videoId);
      const units = nonNegativeInteger(product.units_sold, `${video.videoId}.${productId}.units_sold`);
      const productGmv = money(objectValue(product.gmv).amount, `${video.videoId}.${productId}.gmv`);
      target.items += units;
      target.gmv = roundMoney(target.gmv + productGmv);
      if (units > 0 || productGmv > 0) target.orderingVideoIds.add(video.videoId);
      target.orders = null;
      target.statuses.add("多商品视频订单数无法由当前API精确拆分");
      warnings.add(`视频${video.videoId}挂载多个店铺商品；商品销量和GMV按明细接口拆分，商品订单数留空`);
    }
  }

  const rows: AccountSideRoiRow[] = [];
  for (const date of dates) {
    rows.push(toRoiRow(profile.businessDisplayName, profile.businessDisplayName, "", "", date, storeByDate.get(date)!));
    for (const productName of productNames) {
      const productId = Object.keys(productMap.products).find((id) => productMap.products[id] === productName)!;
      rows.push(toRoiRow(profile.businessDisplayName, productName, productId, "", date, byKey.get(`${date}\u0000${productName}`)!));
    }
  }
  return rows;
}

function buildAccountRows(
  videos: ParsedVideo[],
  dates: string[],
  profile: BusinessProfile,
  warnings: Set<string>,
): AccountSideRoiRow[] {
  const identities = new Map<string, { name: string; uid: string; type: OwnedAccountType }>();
  for (const video of videos) {
    const key = accountIdentityKey(video);
    identities.set(key, { name: video.accountName, uid: video.accountUid, type: video.accountType });
  }
  const byKey = new Map<string, MutableMetrics>();
  const storeByDate = new Map<string, MutableMetrics>();
  for (const date of dates) {
    storeByDate.set(date, emptyMetrics());
    for (const key of identities.keys()) byKey.set(`${date}\u0000${key}`, emptyMetrics());
  }
  for (const video of videos) {
    const published = video.postTime.slice(0, 10) === video.sourceDate;
    mergeWholeVideo(storeByDate.get(video.sourceDate)!, video, published);
    mergeWholeVideo(byKey.get(`${video.sourceDate}\u0000${accountIdentityKey(video)}`)!, video, published);
    if (video.accountName.startsWith("未识别账号-")) {
      warnings.add(`${video.sourceDate}存在API未返回账号名的自营视频，已单列为未识别账号而未丢弃经营数据`);
    }
  }
  const rows: AccountSideRoiRow[] = [];
  for (const date of dates) {
    rows.push(toRoiRow(profile.businessDisplayName, profile.businessDisplayName, "", "", date, storeByDate.get(date)!));
    for (const [identity, account] of [...identities].sort((left, right) => left[1].name.localeCompare(right[1].name))) {
      rows.push(toRoiRow(
        profile.businessDisplayName,
        account.name,
        account.uid,
        accountTypeLabel(account.type),
        date,
        byKey.get(`${date}\u0000${identity}`)!,
      ));
    }
  }
  return rows;
}

async function buildVideoRows(
  broadRows: ParsedVideo[],
  startDate: string,
  endDateInclusive: string,
  productMap: ProductMap,
  profile: BusinessProfile,
  warnings: Set<string>,
  requestIds: Set<string>,
  sourceFiles: Set<string>,
): Promise<AccountSideVideo[]> {
  const parsed = broadRows.filter((video) => {
    const sourcePublishDate = video.postTime.slice(0, 10);
    return sourcePublishDate >= startDate && sourcePublishDate <= endDateInclusive;
  });
  const result: AccountSideVideo[] = [];
  for (const video of parsed) {
    if (!video.postTime || !video.publishedBusinessDate) continue;
    const productMetrics = new Map<string, { orders: number | null; items: number; gmv: number; status: string }>();
    if (new Set(video.productIds.map((id) => productMap.products[id])).size === 1) {
      productMetrics.set(video.productIds[0], { orders: video.orders, items: video.items, gmv: video.gmv, status: "完整" });
    } else {
      const detail = await fetchTikTokAnalytics(
        "shop_video_product_performance",
        startDate,
        shiftIsoDate(endDateInclusive, 1),
        video.videoId,
        180_000,
        tikTokRuntimeFromProfile(profile),
      );
      detail.request_ids.forEach((value) => requestIds.add(value));
      detail.raw_source_paths.forEach((value) => sourceFiles.add(value));
      for (const productId of video.productIds) {
        const row = detail.rows.find((item) => String(item.id ?? "") === productId);
        if (!row) continue;
        productMetrics.set(productId, {
          orders: null,
          items: nonNegativeInteger(row.units_sold, `${video.videoId}.${productId}.units_sold`),
          gmv: money(objectValue(row.gmv).amount, `${video.videoId}.${productId}.gmv`),
          status: "多商品视频：订单数不可精确拆分",
        });
      }
    }
    const byName = new Map<string, { productId: string; orders: number | null; items: number; gmv: number; status: string }>();
    for (const [productId, metrics] of productMetrics) {
      const name = productMap.products[productId]!;
      const prior = byName.get(name);
      byName.set(name, prior ? {
        productId: prior.productId,
        orders: prior.orders === null || metrics.orders === null ? null : prior.orders + metrics.orders,
        items: prior.items + metrics.items,
        gmv: roundMoney(prior.gmv + metrics.gmv),
        status: prior.status === metrics.status ? prior.status : `${prior.status}；${metrics.status}`,
      } : { productId, ...metrics });
    }
    for (const [productName, metrics] of byName) {
      const productId = metrics.productId;
      result.push({
        key: `${profile.businessDisplayName}|${video.videoId}|${productId}`,
        store: profile.businessDisplayName,
        accountNickName: video.accountNickName,
        accountName: video.accountName,
        accountUid: video.accountUid,
        accountType: video.accountType,
        accountTypeLabel: accountTypeLabel(video.accountType),
        videoId: video.videoId,
        videoUrl: video.accountName.startsWith("未识别账号-")
          ? `https://www.tiktok.com/video/${video.videoId}`
          : `https://www.tiktok.com/@${video.accountName}/video/${video.videoId}`,
        publishedAtMs: zonedTimestampToMs(video.postTime, profile.tiktok.shopTimeZone),
        publishedBusinessDate: video.publishedBusinessDate,
        productName,
        productId,
        views: video.views,
        orders: metrics.orders,
        items: metrics.items,
        gmv: metrics.gmv,
        metricStartDate: startDate,
        metricEndDate: endDateInclusive,
        fetchedAtMs: Date.now(),
        status: metrics.status,
      });
    }
  }
  return result.sort((left, right) => (
    left.publishedAtMs - right.publishedAtMs
    || left.videoId.localeCompare(right.videoId)
    || left.productId.localeCompare(right.productId)
  ));
}

function reconcileMissingAccountIdentities(
  rows: ParsedVideo[],
  evidence: ParsedVideo[],
  warnings: Set<string>,
): ParsedVideo[] {
  const candidates = new Map<OwnedAccountType, Map<string, ParsedVideo>>();
  for (const row of evidence) {
    if (row.accountName.startsWith("未识别账号-")) continue;
    const identity = accountIdentityKey(row);
    const byIdentity = candidates.get(row.accountType) ?? new Map<string, ParsedVideo>();
    byIdentity.set(identity, row);
    candidates.set(row.accountType, byIdentity);
  }
  return rows.map((row) => {
    if (!row.accountName.startsWith("未识别账号-")) return row;
    const matches = [...(candidates.get(row.accountType)?.values() ?? [])];
    if (matches.length !== 1) return row;
    const match = matches[0]!;
    warnings.add(`视频${row.videoId}未返回${accountTypeLabel(row.accountType)}账号标识；因该类型在窗口内只有唯一账号，已确定性归入@${match.accountName}`);
    return {
      ...row,
      accountName: match.accountName,
      accountUid: match.accountUid,
      accountNickName: match.accountNickName,
    };
  });
}

function buildAccounts(videos: ParsedVideo[], profile: BusinessProfile): AccountSideAccount[] {
  const byKey = new Map<string, AccountSideAccount>();
  for (const video of videos) {
    if (video.accountName.startsWith("未识别账号-")) continue;
    const identity = accountIdentityKey(video);
    byKey.set(identity, {
      key: `${profile.businessDisplayName}|${identity}`,
      store: profile.businessDisplayName,
      owner: profile.businessDisplayName,
      accountName: video.accountNickName || video.accountName,
      uid: video.accountUid,
      handle: video.accountName,
      accountType: video.accountType,
      accountTypeLabel: accountTypeLabel(video.accountType),
      status: "启用",
      notes: "由TikTok Shop Analytics自动识别；登录凭证不存入飞书",
    });
  }
  return [...byKey.values()].sort((left, right) => left.handle.localeCompare(right.handle));
}

function mergeWholeVideo(target: MutableMetrics, video: ParsedVideo, published: boolean): void {
  target.views += video.views;
  if (target.orders !== null) target.orders += video.orders;
  target.items += video.items;
  target.gmv = roundMoney(target.gmv + video.gmv);
  if (published) target.publishedVideoIds.add(video.videoId);
  if (video.orders > 0 || video.items > 0 || video.gmv > 0) target.orderingVideoIds.add(video.videoId);
}

function toRoiRow(
  store: string,
  dimension: string,
  dimensionId: string,
  accountTypeLabelValue: string,
  date: string,
  metrics: MutableMetrics,
): AccountSideRoiRow {
  return {
    key: `${store}|${dimension}|${date}`,
    store,
    dimension,
    dimensionId,
    accountTypeLabel: accountTypeLabelValue,
    date,
    publishedVideos: metrics.publishedVideoIds.size,
    orderingVideos: metrics.orderingVideoIds.size,
    orders: metrics.orders,
    items: metrics.items,
    views: metrics.views,
    gmv: roundMoney(metrics.gmv),
    status: metrics.statuses.size ? [...metrics.statuses].join("；") : "完整",
  };
}

function emptyMetrics(): MutableMetrics {
  return {
    publishedVideoIds: new Set(),
    orderingVideoIds: new Set(),
    orders: 0,
    items: 0,
    views: 0,
    gmv: 0,
    statuses: new Set(),
  };
}

function accountIdentityKey(video: ParsedVideo): string {
  return video.accountUid || `${video.accountType}:${video.accountName}`;
}

function accountTypeLabel(type: OwnedAccountType): string {
  return type === "OFFICIAL_ACCOUNTS" ? "官方账号" : "营销账号";
}

function parseProducts(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.flatMap((item) => {
    const id = String(objectValue(item).id ?? "").trim();
    return /^\d+$/.test(id) ? [id] : [];
  }))];
}

async function loadProductMap(profile: BusinessProfile): Promise<ProductMap> {
  const resolved = path.resolve(process.cwd(), profile.tiktok.productMapFile);
  const parsed = PRODUCT_MAP_SCHEMA.safeParse(JSON.parse(await readFile(resolved, "utf8")));
  if (!parsed.success) throw new Error(`账号端商品映射文件无效：${z.prettifyError(parsed.error)}`);
  const included = profile.tiktok.autoEnrollNewProducts
    ? null
    : new Set(profile.tiktok.includedCanonicalProducts ?? []);
  const products = Object.fromEntries(Object.entries(parsed.data.products).filter(([, name]) => (
    !included || included.size === 0 || included.has(name)
  )));
  if (Object.keys(products).length === 0) throw new Error("账号端没有可用的正式商品映射");
  return { shop: parsed.data.shop, products };
}

function assertContract(contract: TikTokMachineContract, profile: BusinessProfile, requestedDate: string): void {
  if (!contract.ok) throw new Error(`账号端视频表现查询失败：${contract.errors.join("；")}`);
  if (contract.pagination_truncated) throw new Error("账号端视频表现分页不完整，拒绝生成投产比");
  if (contract.conflicting_duplicate_ids.length) {
    throw new Error(`账号端视频表现存在冲突视频ID：${contract.conflicting_duplicate_ids.join("、")}`);
  }
  assertShop(profile, contract.shop?.name ?? "");
  if ((contract.latest_available_date ?? "") < requestedDate) {
    throw new Error(`${requestedDate}尚未成为TikTok完整经营日，拒绝写0或部分值`);
  }
}

function assertShop(profile: BusinessProfile, actual: string): void {
  const expected = normalizeCore(profile.tiktok.shopAlias);
  if (!expected || normalizeCore(actual) !== expected) {
    throw new Error(`账号端数据源店铺不匹配：期望${profile.tiktok.shopAlias}，实际${actual || "空"}`);
  }
}

function normalizeCore(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizeHandle(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim().replace(/^@+/, "").toLocaleLowerCase("en-US");
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function nonNegativeInteger(value: unknown, label: string): number {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label}不是非负整数`);
  return number;
}

function money(value: unknown, label: string): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label}不是非负金额`);
  return roundMoney(number);
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function enumerateDates(start: string, endInclusive: string): string[] {
  const result: string[] = [];
  for (let current = start; current <= endInclusive; current = shiftIsoDate(current, 1)) result.push(current);
  return result;
}

function zonedTimestampToMs(value: string, timeZone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`视频发布时间格式无效：${value}`);
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = targetAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    const actualAsUtc = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
    const correction = targetAsUtc - actualAsUtc;
    if (correction === 0) break;
    instant += correction;
  }
  return instant;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      result[index] = await mapper(values[index], index);
    }
  }));
  return result;
}
