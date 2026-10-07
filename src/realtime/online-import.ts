import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadBusinessProfile, type BusinessProfile } from "../config/business-profile.js";
import { requireCanonicalProductName } from "../business/product-naming.js";
import { includedProductNameSet } from "../business/product-scope.js";
import type {
  CooperationSeed,
  StorefourDemoGateway,
  OnlineRecordSnapshot,
  VideoSource,
} from "../feishu/storefour-demo-gateway.js";
import { dateKey } from "../feishu/storefour-demo-gateway.js";
import { nextDate } from "./intent.js";
import {
  businessDateRangeToShopDateRange,
  dateKeyInTimeZone,
  shopTimestampToBusinessDate,
} from "./business-time.js";
import { fetchTikTokVideoDay, tikTokRuntimeFromProfile } from "./tiktok-cli.js";
import { requireTikTokHandleFromVideoRow } from "./tiktok-identity.js";
import { isStoreOwnedVideo } from "./video-owner.js";
import type { RealtimeIntent, RealtimeResultSummary, TikTokMachineContract } from "./types.js";

const PROJECT_ROOT = process.cwd();
const BACKUP_ROOT = path.join(PROJECT_ROOT, "backups", "realtime-sync");
const MAX_CUMULATIVE_VIDEO_METRIC_DAYS = 180;
const MANAGED_FIELDS = [
  "登记日期", "实上线日期(Ct)", "达人姓名", "挂车产品", "视频上线地址", "视频曝光K",
  "售出数量", "销售额",
] as const;

type OnlineSnapshotReader = Pick<StorefourDemoGateway, "snapshotOnlineByVideoId">
  & Partial<Pick<StorefourDemoGateway, "snapshotOnlineByVideoIds">>;

async function readOnlineSnapshots(gateway: OnlineSnapshotReader, ids: string[]): Promise<Map<string, OnlineRecordSnapshot | null>> {
  if (gateway.snapshotOnlineByVideoIds) return gateway.snapshotOnlineByVideoIds(ids);
  const snapshots = new Map<string, OnlineRecordSnapshot | null>();
  for (const id of ids) snapshots.set(id, await gateway.snapshotOnlineByVideoId(id));
  return snapshots;
}

export interface PlannedOnlineVideo {
  video: VideoSource;
  before: OnlineRecordSnapshot | null;
}

export interface OnlineImportPlan {
  version: 1;
  jobId: string;
  generatedAt: string;
  startDate: string;
  endDateInclusive: string;
  endDateExclusive: string;
  metricWindowStart: string;
  metricWindowEndExclusive: string;
  latestAvailableDate: string | null;
  businessTimeZone?: string;
  shopTimeZone?: string;
  creatorHandle: string | null;
  videoId: string | null;
  sourceFiles: string[];
  requestIds: string[];
  videos: PlannedOnlineVideo[];
  skipped: number;
  conflicts: Array<{ key: string; reason: string }>;
  missingItems: string[];
  cooperationSources?: CooperationSeed[];
  tableName?: string;
}

export interface OlderSoldVideoCandidate {
  videoId: string;
  publishBusinessDate: string;
}

export interface OlderSoldVideoRefreshPreparation {
  plan: OnlineImportPlan | null;
  detected: number;
  eligible: number;
  existing: number;
  missingFromOnlineTable: number;
  outsideCumulativeWindow: number;
  detectionLatestAvailableDate: string | null;
  detectionSourceFiles: string[];
  detectionRequestIds: string[];
}

export interface AttributedVideoExposureRefreshPreparation {
  plan: OnlineImportPlan | null;
  reason: string | null;
  videoId: string;
  publishBusinessDate: string | null;
  metricEndBusinessDate: string;
}

export class OnlineImportInputRequiredError extends Error {
  public constructor(
    message: string,
    public readonly missingItems: string[],
  ) {
    super(message);
    this.name = "OnlineImportInputRequiredError";
  }
}

export async function prepareOnlineImportPlan(input: {
  jobId: string;
  intent: Extract<RealtimeIntent, { action: "import_online_videos" }>;
  gateway: StorefourDemoGateway;
  metricEndDateInclusive?: string;
  allowedVideoIds?: readonly string[];
  profile?: BusinessProfile;
}): Promise<OnlineImportPlan> {
  const profile = input.profile ?? loadBusinessProfile();
  const yesterday = shiftIsoDate(shanghaiDateKey(new Date()), -1);
  const metricEndDateInclusive = input.metricEndDateInclusive ?? (input.intent.startDate === input.intent.endDateInclusive
    && input.intent.endDateInclusive < yesterday
    ? yesterday
    : input.intent.endDateInclusive);
  const sourceRange = businessDateRangeToShopDateRange(
    input.intent.startDate,
    metricEndDateInclusive,
    profile.businessTimeZone,
    profile.tiktok.shopTimeZone,
  );
  const contract = await fetchTikTokVideoDay(
    sourceRange.startDate,
    sourceRange.endDateExclusive,
    180_000,
    tikTokRuntimeFromProfile(profile),
  );
  const productMap = await loadProductMap(profile);
  await input.gateway.initializeOnlineReadOnly();
  return buildOnlineImportPlan(
    input.jobId,
    input.intent,
    contract,
    productMap,
    input.gateway,
    profile,
    input.allowedVideoIds,
  );
}

/**
 * Refresh an older video only after a complete shop day reports a sale. The
 * one-day contract is only the trigger: its `views` value is a daily-window
 * metric and must never overwrite the cumulative exposure stored in Feishu.
 * Triggered videos are therefore queried again from their publish date through
 * the latest complete date before any write plan is produced.
 */
export async function prepareOlderSoldVideoRefreshPlan(input: {
  jobId: string;
  latestCompleteShopDate: string;
  recentPublishStartDate: string;
  gateway: StorefourDemoGateway;
  profile?: BusinessProfile;
}): Promise<OlderSoldVideoRefreshPreparation> {
  const profile = input.profile ?? loadBusinessProfile();
  const detectionContract = await fetchTikTokVideoDay(
    input.latestCompleteShopDate,
    nextDate(input.latestCompleteShopDate),
    180_000,
    tikTokRuntimeFromProfile(profile),
  );
  assertUsableVideoContract(detectionContract);
  if (
    detectionContract.latest_available_date
    && detectionContract.latest_available_date < input.latestCompleteShopDate
  ) {
    throw new Error(
      `老视频出单检测只完整到${detectionContract.latest_available_date}，`
      + `尚未覆盖${input.latestCompleteShopDate}`,
    );
  }

  const detectedCandidates = selectOlderSoldVideoCandidates(
    detectionContract,
    input.recentPublishStartDate,
    profile.tiktok.shopTimeZone,
    profile.businessTimeZone,
  );
  const eligibleCandidates: OlderSoldVideoCandidate[] = [];
  let outsideCumulativeWindow = 0;
  for (const candidate of detectedCandidates) {
    const metricRange = businessDateRangeToShopDateRange(
      candidate.publishBusinessDate,
      input.latestCompleteShopDate,
      profile.businessTimeZone,
      profile.tiktok.shopTimeZone,
    );
    if (dateDistance(metricRange.startDate, metricRange.endDateExclusive) > MAX_CUMULATIVE_VIDEO_METRIC_DAYS) {
      outsideCumulativeWindow += 1;
      continue;
    }
    eligibleCandidates.push(candidate);
  }

  const base = {
    detected: detectedCandidates.length,
    eligible: eligibleCandidates.length,
    outsideCumulativeWindow,
    detectionLatestAvailableDate: detectionContract.latest_available_date ?? null,
    detectionSourceFiles: detectionContract.raw_source_paths,
    detectionRequestIds: detectionContract.request_ids,
  };
  if (eligibleCandidates.length === 0) {
    return {
      ...base,
      plan: null,
      existing: 0,
      missingFromOnlineTable: 0,
    };
  }

  const publishDates = eligibleCandidates.map((candidate) => candidate.publishBusinessDate).sort();
  const plan = await prepareOnlineImportPlan({
    jobId: input.jobId,
    intent: {
      action: "import_online_videos",
      target: "online",
      startDate: publishDates[0],
      endDateInclusive: publishDates.at(-1)!,
    },
    gateway: input.gateway,
    metricEndDateInclusive: input.latestCompleteShopDate,
    allowedVideoIds: eligibleCandidates.map((candidate) => candidate.videoId),
    profile,
  });
  const existingVideos = plan.videos.filter((item) => item.before !== null);
  const missingFromOnlineTable = plan.videos.length - existingVideos.length;
  return {
    ...base,
    plan: {
      ...plan,
      videos: existingVideos,
      skipped: plan.skipped + missingFromOnlineTable,
      missingItems: [
        ...plan.missingItems,
        ...(outsideCumulativeWindow > 0
          ? [`${outsideCumulativeWindow}条老视频超过安全累计查询范围，未覆盖现值`]
          : []),
        ...(missingFromOnlineTable > 0
          ? [`${missingFromOnlineTable}条老视频有新成交但上线表无对应记录，本轮未自动新增`]
          : []),
      ],
    },
    existing: existingVideos.length,
    missingFromOnlineTable,
  };
}

/**
 * Prepare a cumulative exposure refresh for one exactly attributed video.
 * The order event itself can be near-real-time, while the exposure value is the
 * newest complete value currently exposed by Video Analytics (normally T-1).
 */
export async function prepareAttributedVideoExposureRefreshPlan(input: {
  jobId: string;
  videoId: string;
  gateway: StorefourDemoGateway;
  profile?: BusinessProfile;
  now?: Date;
}): Promise<AttributedVideoExposureRefreshPreparation> {
  const profile = input.profile ?? loadBusinessProfile();
  const metricEndBusinessDate = dateKeyInTimeZone(
    input.now ?? new Date(),
    profile.businessTimeZone,
  );
  if (!/^\d{10,}$/.test(input.videoId)) {
    throw new Error(`精确视频归因返回无效video_id：${input.videoId || "空"}`);
  }
  await input.gateway.initializeOnlineReadOnly();
  const snapshot = await input.gateway.snapshotOnlineByVideoId(input.videoId);
  if (!snapshot) {
    return {
      plan: null,
      reason: "该视频尚未登记在红人上线表，本轮不自动新增",
      videoId: input.videoId,
      publishBusinessDate: null,
      metricEndBusinessDate,
    };
  }
  const publishBusinessDate = dateKey(snapshot.fields["实上线日期(Ct)"]);
  if (!publishBusinessDate) {
    return {
      plan: null,
      reason: "红人上线表缺少有效实上线日期，无法证明累计曝光查询起点",
      videoId: input.videoId,
      publishBusinessDate: null,
      metricEndBusinessDate,
    };
  }
  const metricRange = businessDateRangeToShopDateRange(
    publishBusinessDate,
    metricEndBusinessDate,
    profile.businessTimeZone,
    profile.tiktok.shopTimeZone,
  );
  if (dateDistance(metricRange.startDate, metricRange.endDateExclusive) > MAX_CUMULATIVE_VIDEO_METRIC_DAYS) {
    return {
      plan: null,
      reason: `累计曝光查询跨度超过${MAX_CUMULATIVE_VIDEO_METRIC_DAYS}天安全上限`,
      videoId: input.videoId,
      publishBusinessDate,
      metricEndBusinessDate,
    };
  }
  const plan = await prepareOnlineImportPlan({
    jobId: input.jobId,
    intent: {
      action: "import_online_videos",
      target: "online",
      startDate: publishBusinessDate,
      endDateInclusive: publishBusinessDate,
      videoId: input.videoId,
    },
    gateway: input.gateway,
    metricEndDateInclusive: metricEndBusinessDate,
    allowedVideoIds: [input.videoId],
    profile,
  });
  const existing = plan.videos.filter((item) => (
    item.video.id === input.videoId && item.before !== null
  ));
  if (existing.length !== 1) {
    return {
      plan: null,
      reason: plan.conflicts.find((item) => item.key === input.videoId)?.reason
        ?? "Video Analytics当前没有返回可安全回更的对应视频",
      videoId: input.videoId,
      publishBusinessDate,
      metricEndBusinessDate,
    };
  }
  return {
    plan: { ...plan, videos: existing },
    reason: null,
    videoId: input.videoId,
    publishBusinessDate,
    metricEndBusinessDate,
  };
}

export function selectOlderSoldVideoCandidates(
  contract: TikTokMachineContract,
  recentPublishStartDate: string,
  shopTimeZone: string,
  businessTimeZone: string,
): OlderSoldVideoCandidate[] {
  assertUsableVideoContract(contract);
  const candidates = new Map<string, OlderSoldVideoCandidate>();
  const conflictedVideoIds = new Set<string>();
  for (const row of contract.rows) {
    if (isStoreOwnedVideo(row, contract.shop?.name)) continue;
    const videoId = String(row.id ?? "").trim();
    if (!/^\d{10,}$/.test(videoId)) continue;
    if (conflictedVideoIds.has(videoId)) continue;
    const itemsSold = Number(row.items_sold);
    if (!Number.isSafeInteger(itemsSold) || itemsSold <= 0) continue;
    let publishBusinessDate = "";
    try {
      publishBusinessDate = shopTimestampToBusinessDate(
        row.video_post_time,
        shopTimeZone,
        businessTimeZone,
      );
    } catch {
      continue;
    }
    if (publishBusinessDate >= recentPublishStartDate) continue;
    const prior = candidates.get(videoId);
    if (prior && prior.publishBusinessDate !== publishBusinessDate) {
      candidates.delete(videoId);
      conflictedVideoIds.add(videoId);
      continue;
    }
    candidates.set(videoId, { videoId, publishBusinessDate });
  }
  return [...candidates.values()].sort((left, right) => (
    left.publishBusinessDate.localeCompare(right.publishBusinessDate)
    || left.videoId.localeCompare(right.videoId)
  ));
}

export async function prepareCooperationDrivenOnlineImportPlan(input: {
  jobId: string;
  intent: Extract<RealtimeIntent, { action: "import_online_from_cooperations" }>;
  gateway: StorefourDemoGateway;
  profile?: BusinessProfile;
}): Promise<OnlineImportPlan> {
  const profile = input.profile ?? loadBusinessProfile();
  const allSeeds = await input.gateway.listCooperationSeeds();
  const selectedSeeds = input.intent.scope === "latest" ? allSeeds.slice(0, 1) : allSeeds;
  if (selectedSeeds.length === 0) {
    throw new OnlineImportInputRequiredError(
      "合作表目前没有记录，所以还不知道要查哪个达人、从哪天开始、匹配哪个寄样商品。请先人工填写合作表。",
      ["合作表记录"],
    );
  }
  const completeSeeds = selectedSeeds.filter((seed) => seed.missingItems.length === 0);
  if (completeSeeds.length === 0) {
    const missingItems = [...new Set(selectedSeeds.flatMap((seed) => seed.missingItems))];
    throw new OnlineImportInputRequiredError(
      `最新合作记录还不能用于查视频，缺少：${missingItems.join("、")}。补好后重新点“补最新合作的上线视频”。`,
      missingItems,
    );
  }
  const startDate = completeSeeds.map((seed) => seed.cooperationDate).sort()[0];
  const endDateInclusive = shiftIsoDate(shanghaiDateKey(new Date()), -1);
  if (startDate > endDateInclusive) {
    throw new OnlineImportInputRequiredError(
      `合作时间是 ${startDate}，但TikTok当前最新完整数据只到 ${endDateInclusive}。这通常是当天数据尚未生成，请稍后再试。`,
      ["合作时间之后的完整TikTok视频数据"],
    );
  }
  const sourceRange = businessDateRangeToShopDateRange(
    startDate,
    endDateInclusive,
    profile.businessTimeZone,
    profile.tiktok.shopTimeZone,
  );
  const contract = await fetchTikTokVideoDay(
    sourceRange.startDate,
    sourceRange.endDateExclusive,
    180_000,
    tikTokRuntimeFromProfile(profile),
  );
  const productMap = await loadProductMap(profile);
  await input.gateway.initializeOnlineReadOnly();
  return buildCooperationDrivenOnlineImportPlan(
    input.jobId,
    completeSeeds,
    contract,
    productMap,
    input.gateway,
    endDateInclusive,
    profile,
  );
}

export async function buildCooperationDrivenOnlineImportPlan(
  jobId: string,
  cooperationSources: CooperationSeed[],
  contract: TikTokMachineContract,
  productMap: Record<string, string>,
  gateway: OnlineSnapshotReader,
  businessEndDateInclusive?: string,
  profile: BusinessProfile = loadBusinessProfile(),
): Promise<OnlineImportPlan> {
  assertUsableVideoContract(contract);
  if (cooperationSources.length === 0) throw new Error("没有可用于匹配的合作记录");

  const conflicts: Array<{ key: string; reason: string }> = [];
  const missingItems: string[] = [];
  const mappedProductNames = new Set(Object.values(productMap));
  for (const seed of cooperationSources) {
    for (const product of seed.products) {
      if (!mappedProductNames.has(product)) {
        missingItems.push(`${seed.creatorHandle} 的寄样产品“${product}”尚未配置TikTok商品映射`);
      }
    }
  }

  const selected = new Map<string, VideoSource>();
  let skipped = 0;
  for (const row of contract.rows) {
    if (isStoreOwnedVideo(row, contract.shop?.name)) continue;
    const videoId = String(row.id ?? "").trim();
    if (!/^\d{10,}$/.test(videoId)) continue;
    let creator: string;
    try {
      creator = requireTikTokHandleFromVideoRow(row);
    } catch {
      continue;
    }
    let date = "";
    try {
      date = shopTimestampToBusinessDate(
        row.video_post_time,
        profile.tiktok.shopTimeZone,
        profile.businessTimeZone,
      );
    } catch {
      continue;
    }
    const candidateSeeds = cooperationSources.filter((seed) => (
      seed.creatorHandle === creator && /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= seed.cooperationDate
    ));
    if (candidateSeeds.length === 0) continue;

    const productIds = parseProducts(row.products).map((product) => String(product.id ?? "").trim()).filter(Boolean);
    const products = [...new Set(productIds.map((id) => productMap[id]).filter(Boolean))];
    const matchedSeeds = candidateSeeds.filter((seed) => seed.products.some((product) => products.includes(product)));
    if (matchedSeeds.length === 0) continue;
    if (products.length === 0) {
      skipped += 1;
      conflicts.push({ key: videoId, reason: "视频挂车商品未映射，无法证明与寄样商品相同" });
      continue;
    }
    const views = Number(row.views);
    if (!Number.isFinite(views) || views < 0) {
      skipped += 1;
      conflicts.push({ key: videoId, reason: "views不是非负数" });
      continue;
    }
    const sales = parseVideoSales(row, videoId, conflicts);
    if (!sales) {
      skipped += 1;
      continue;
    }
    const video: VideoSource = {
      id: videoId,
      date,
      creator,
      products,
      url: `https://www.tiktok.com/@${creator}/video/${videoId}`,
      viewsK: views / 1000,
      ...sales,
      metricWindowStart: contract.window_start,
      metricWindowEndExclusive: contract.window_end_exclusive,
    };
    const prior = selected.get(videoId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(video)) {
      selected.delete(videoId);
      conflicts.push({ key: videoId, reason: "TikTok API 同一video_id返回冲突内容" });
      skipped += 1;
      continue;
    }
    selected.set(videoId, video);
  }

  const videos: PlannedOnlineVideo[] = [];
  const snapshots = await readOnlineSnapshots(gateway, [...selected.keys()]);
  for (const video of selected.values()) {
    videos.push({ video, before: snapshots.get(video.id) ?? null });
  }
  videos.sort((a, b) => a.video.date.localeCompare(b.video.date) || a.video.id.localeCompare(b.video.id));
  if (videos.length === 0) {
    missingItems.push("未找到同时满足TK号、合作时间当天或之后、寄样商品相同的挂车视频");
  }
  const startDate = cooperationSources.map((seed) => seed.cooperationDate).sort()[0];
  const endDateInclusive = businessEndDateInclusive
    ?? videos.at(-1)?.video.date
    ?? startDate;
  return {
    version: 1,
    jobId,
    generatedAt: new Date().toISOString(),
    startDate,
    endDateInclusive,
    endDateExclusive: nextDate(endDateInclusive),
    metricWindowStart: contract.window_start,
    metricWindowEndExclusive: contract.window_end_exclusive,
    latestAvailableDate: contract.latest_available_date ?? null,
    businessTimeZone: profile.businessTimeZone,
    shopTimeZone: profile.tiktok.shopTimeZone,
    creatorHandle: null,
    videoId: null,
    sourceFiles: contract.raw_source_paths,
    requestIds: contract.request_ids,
    videos,
    skipped,
    conflicts,
    missingItems: [...new Set(missingItems)],
    cooperationSources,
    tableName: profile.tables.online,
  };
}

export async function buildOnlineImportPlan(
  jobId: string,
  intent: Extract<RealtimeIntent, { action: "import_online_videos" }>,
  contract: TikTokMachineContract,
  productMap: Record<string, string>,
  gateway: OnlineSnapshotReader,
  profile: BusinessProfile = loadBusinessProfile(),
  allowedVideoIds?: readonly string[],
): Promise<OnlineImportPlan> {
  assertUsableVideoContract(contract);

  const creatorFilter = intent.creatorHandle?.toLowerCase() ?? null;
  const videoFilter = intent.videoId ?? null;
  const conflicts: Array<{ key: string; reason: string }> = [];
  const missingItems: string[] = [];
  const selected = new Map<string, VideoSource>();
  const strictProductScope = includedProductNameSet(profile) !== null;
  const allowedVideoIdSet = allowedVideoIds ? new Set(allowedVideoIds) : null;
  let skipped = 0;

  for (const row of contract.rows) {
    if (isStoreOwnedVideo(row, contract.shop?.name)) continue;
    const videoId = String(row.id ?? "").trim();
    if (allowedVideoIdSet && !allowedVideoIdSet.has(videoId)) continue;
    if (!/^\d{10,}$/.test(videoId)) {
      if (!creatorFilter && !videoFilter) skipped += 1;
      continue;
    }
    if (videoFilter && videoId !== videoFilter) continue;
    let creator: string;
    try {
      creator = requireTikTokHandleFromVideoRow(row);
    } catch (error) {
      if (videoFilter === videoId) {
        conflicts.push({ key: videoId, reason: String((error as Error).message) });
        skipped += 1;
      }
      continue;
    }
    if (creatorFilter && creator !== creatorFilter) continue;
    let date = "";
    try {
      date = shopTimestampToBusinessDate(
        row.video_post_time,
        profile.tiktok.shopTimeZone,
        profile.businessTimeZone,
      );
    } catch (error) {
      if (videoFilter === videoId) {
        conflicts.push({ key: videoId, reason: `视频发布时间无法换算：${String((error as Error).message)}` });
        skipped += 1;
      }
      continue;
    }
    if (date < intent.startDate || date > intent.endDateInclusive) {
      continue;
    }
    const productIds = parseProducts(row.products).map((product) => String(product.id ?? "").trim()).filter(Boolean);
    const products = [...new Set(productIds.map((id) => productMap[id]).filter(Boolean))];
    if (products.length === 0) {
      skipped += 1;
      // A configured allow-list means this product was intentionally retired
      // or excluded. During an automatic store scan it is not a mapping error
      // and must not create recurring operator warnings.
      if (strictProductScope && !videoFilter && !creatorFilter) continue;
      // Bulk discovery only imports product-linked creator videos. A video
      // with no linked products simply does not qualify and is not an error.
      // Keep an explicit explanation when the user targeted one creator/video,
      // or when TikTok returned a product ID that still needs mapping.
      if (productIds.length > 0 || videoFilter === videoId || creatorFilter) {
        conflicts.push({
          key: videoId,
          reason: productIds.length === 0 ? "视频未返回挂车商品" : `挂车商品尚未映射：${productIds.join("、")}`,
        });
      }
      continue;
    }
    const views = Number(row.views);
    if (!Number.isFinite(views) || views < 0) {
      skipped += 1;
      conflicts.push({ key: videoId, reason: "views不是非负数" });
      continue;
    }
    const sales = parseVideoSales(row, videoId, conflicts);
    if (!sales) {
      skipped += 1;
      continue;
    }
    const video: VideoSource = {
      id: videoId,
      date,
      creator,
      products,
      url: `https://www.tiktok.com/@${creator}/video/${videoId}`,
      viewsK: views / 1000,
      ...sales,
      metricWindowStart: contract.window_start,
      metricWindowEndExclusive: contract.window_end_exclusive,
    };
    const prior = selected.get(videoId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(video)) {
      selected.delete(videoId);
      conflicts.push({ key: videoId, reason: "TikTok API 同一video_id返回冲突内容" });
      skipped += 1;
      continue;
    }
    selected.set(videoId, video);
  }

  if (selected.size === 0 && creatorFilter) {
    missingItems.push(`${creatorFilter}在指定发布日期范围内没有可安全导入的已映射挂车视频`);
  }
  const videos: PlannedOnlineVideo[] = [];
  const snapshots = await readOnlineSnapshots(gateway, [...selected.keys()]);
  for (const video of selected.values()) {
    videos.push({ video, before: snapshots.get(video.id) ?? null });
  }
  videos.sort((a, b) => a.video.date.localeCompare(b.video.date) || a.video.id.localeCompare(b.video.id));
  return {
    version: 1,
    jobId,
    generatedAt: new Date().toISOString(),
    startDate: intent.startDate,
    endDateInclusive: intent.endDateInclusive,
    endDateExclusive: nextDate(intent.endDateInclusive),
    metricWindowStart: contract.window_start,
    metricWindowEndExclusive: contract.window_end_exclusive,
    latestAvailableDate: contract.latest_available_date ?? null,
    businessTimeZone: profile.businessTimeZone,
    shopTimeZone: profile.tiktok.shopTimeZone,
    creatorHandle: creatorFilter,
    videoId: videoFilter,
    sourceFiles: contract.raw_source_paths,
    requestIds: contract.request_ids,
    videos,
    skipped,
    conflicts,
    missingItems,
    tableName: profile.tables.online,
  };
}

export function formatOnlineImportPreview(plan: OnlineImportPlan): string {
  const create = plan.videos.filter((item) => item.before === null).length;
  const existing = plan.videos.length - create;
  const lines = [
    `我找到了 ${plan.videos.length} 条符合条件的视频，先给你过目：`,
    ...(plan.cooperationSources?.map((seed) => (
      `${seed.creatorHandle}｜合作日期 ${seed.cooperationDate}｜${seed.products.join("+")}`
    )) ?? []),
    `发布时间：${plan.startDate} 至 ${plan.endDateInclusive}（北京时间）`,
    `准备新增 ${create} 条，表里已有 ${existing} 条${plan.skipped > 0 ? `，另有 ${plan.skipped} 条没采用` : ""}。`,
    ...plan.videos.map((item, index) => (
      `${index + 1}. ${item.video.date}｜${item.video.creator}｜${item.video.products.join("+")}｜VV ${Math.round(item.video.viewsK * 1000)}`
      + `｜售出 ${item.video.itemsSold}｜销售额 $${item.video.gmv.toFixed(2)}`
    )),
    ...plan.missingItems.slice(0, 5).map((item) => `还缺：${item}`),
    ...plan.conflicts.slice(0, 5).map((item) => `这条先没动：${item.reason}`),
  ];
  if (plan.videos.length > 0) lines.push("看着没问题，就回复“继续刚才的更新”。");
  return lines.join("\n");
}

function assertUsableVideoContract(contract: TikTokMachineContract): void {
  if (!contract.ok) throw new Error(contract.errors[0] ?? "TikTok 视频数据获取失败");
  if (contract.dataset !== "shop_video_performance") {
    throw new Error(`不支持的数据集：${contract.dataset}`);
  }
  if (contract.pagination_truncated) throw new Error("TikTok 视频分页不完整，拒绝生成写入计划");
}

export async function executeOnlineImportPlan(
  plan: OnlineImportPlan,
  gateway: StorefourDemoGateway,
): Promise<RealtimeResultSummary> {
  if (plan.version !== 1 || !/^rt-\d{14}-[a-f0-9]{8}$/.test(plan.jobId)) {
    throw new Error("上线导入计划格式无效");
  }
  if (plan.videos.length > 50) throw new Error("单次上线视频导入不能超过50条");
  const allProducts = [...new Set(plan.videos.flatMap((item) => item.video.products))];
  await gateway.initializeOnlineProducts(allProducts);

  const ready: PlannedOnlineVideo[] = [];
  const concurrencyConflicts: Array<{ key: string; reason: string }> = [];
  const currentSnapshots = await readOnlineSnapshots(gateway, plan.videos.map((item) => item.video.id));
  for (const item of plan.videos) {
    const current = currentSnapshots.get(item.video.id) ?? null;
    if (!sameSnapshot(current, item.before)) {
      concurrencyConflicts.push({ key: item.video.id, reason: "预览后上线记录发生变化，已跳过" });
      continue;
    }
    ready.push(item);
  }

  const backupDirectory = path.join(BACKUP_ROOT, plan.jobId);
  await mkdir(backupDirectory, { recursive: true });
  const before = {
    version: 1,
    jobId: plan.jobId,
    generatedAt: new Date().toISOString(),
    records: ready.map((item) => item.before ?? ({
      tableName: plan.tableName ?? loadBusinessProfile().tables.online,
      recordId: null,
      uniqueKey: `tiktok_video_id:${item.video.id}`,
      fields: null,
    })),
  };
  const beforeText = `${JSON.stringify(before, null, 2)}\n`;
  await writeFile(path.join(backupDirectory, "before.json"), beforeText, { encoding: "utf8", mode: 0o600 });
  await writeFile(
    path.join(backupDirectory, "before.sha256"),
    `${createHash("sha256").update(beforeText).digest("hex")}  before.json\n`,
    "ascii",
  );
  await writeJson(path.join(backupDirectory, "plan.json"), { ...plan, videos: ready });

  const rollbackOperations: any[] = [];
  const rollbackCommand = `pnpm exec tsx src/cli/realtime-rollback.ts --job-id ${plan.jobId} --confirm ROLLBACK-${plan.jobId}`;
  const persistRollback = async (): Promise<void> => {
    await writeJson(path.join(backupDirectory, "rollback.json"), {
      version: 1,
      jobId: plan.jobId,
      confirmation: `ROLLBACK-${plan.jobId}`,
      operations: rollbackOperations,
    });
    await writeFile(
      path.join(backupDirectory, "ROLLBACK.cmd"),
      `@echo off\r\ncd /d "${PROJECT_ROOT}"\r\ncall ${rollbackCommand}\r\n`,
      "ascii",
    );
  };
  await persistRollback();
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const writtenIds = new Map<string, string>();
  const existingItems = ready.filter((item): item is PlannedOnlineVideo & { before: OnlineRecordSnapshot } => item.before !== null);
  await gateway.syncExistingOnlineBatch(existingItems);
  const batchAfter = await readOnlineSnapshots(gateway, existingItems.map((item) => item.video.id));
  for (const item of ready) {
    const result = item.before ? { recordId: item.before.recordId } : await gateway.syncOnline(item.video, null);
    const postWrite = item.before ? batchAfter.get(item.video.id) : await gateway.getOnlineRecordSnapshot(result.recordId);
    if (!postWrite || postWrite.recordId !== result.recordId) {
      throw new Error(`视频${item.video.id}写入后无法建立回滚快照`);
    }
    const changed = item.before === null || managedChanged(item.before.fields, postWrite.fields);
    if (changed) {
      rollbackOperations.push(item.before === null
        ? {
            action: "delete_created",
            tableId: postWrite.tableId,
            tableName: postWrite.tableName,
            recordId: postWrite.recordId,
            expectedAfter: pickManagedFields(postWrite.fields),
            restoreFields: {},
          }
        : {
            action: "restore",
            tableId: postWrite.tableId,
            tableName: postWrite.tableName,
            recordId: postWrite.recordId,
            expectedAfter: pickManagedFields(postWrite.fields),
            restoreFields: Object.fromEntries(
              MANAGED_FIELDS.map((field) => [field, item.before!.fields[field] ?? null]),
            ),
          });
      await persistRollback();
    }
    let verification = await gateway.verifyOnline(item.video, result.recordId, postWrite);
    // Retry a read only when eventual consistency actually occurs, rather
    // than sleeping unconditionally for every already-correct record.
    if (!verification.ok) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      verification = await gateway.verifyOnline(item.video, result.recordId);
    }
    if (!verification.ok) throw new Error(`视频${item.video.id}写后验证失败：${verification.errors.join("；")}`);
    writtenIds.set(item.video.id, result.recordId);
    if (item.before === null) created += 1;
    else if (managedChanged(item.before.fields, verification.record.fields)) updated += 1;
    else unchanged += 1;
  }

  const afterSnapshots = await readOnlineSnapshots(gateway, [...writtenIds.keys()]);
  for (const [videoId, recordId] of writtenIds) {
    if (afterSnapshots.get(videoId)?.recordId !== recordId) {
      throw new Error(`视频${videoId}批次回读记录身份不匹配`);
    }
  }

  await persistRollback();
  await writeJson(path.join(backupDirectory, "result.json"), {
    version: 1,
    jobId: plan.jobId,
    completedAt: new Date().toISOString(),
    created,
    updated,
    unchanged,
    concurrencyConflicts,
  });
  return {
    windowStart: plan.startDate,
    windowEndExclusive: plan.endDateExclusive,
    sources: plan.sourceFiles,
    matched: plan.videos.length,
    created,
    updated,
    unchanged,
    skipped: plan.skipped + concurrencyConflicts.length,
    conflicts: plan.conflicts.length + concurrencyConflicts.length,
    missingItems: plan.missingItems,
    backupPath: backupDirectory,
    rollbackCommand,
  };
}

async function loadProductMap(profile: BusinessProfile = loadBusinessProfile()): Promise<Record<string, string>> {
  const productMapPath = path.resolve(PROJECT_ROOT, profile.tiktok.productMapFile);
  const parsed = JSON.parse(await readFile(productMapPath, "utf8")) as { products?: Record<string, unknown> };
  const included = includedProductNameSet(profile);
  return Object.fromEntries(
    Object.entries(parsed.products ?? {})
      .map(([id, name]) => [id, requireCanonicalProductName(String(name))])
      .filter(([, name]) => Boolean(name) && (!included || included.has(name))),
  );
}

function parseProducts(value: unknown): Array<Record<string, unknown>> {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
}

function parseVideoSales(
  row: Record<string, unknown>,
  videoId: string,
  conflicts: Array<{ key: string; reason: string }>,
): Pick<VideoSource, "itemsSold" | "gmv" | "gmvCurrency"> | null {
  const itemsSold = Number(row.items_sold);
  const gmv = Number(row.gmv_amount);
  const currency = String(row.gmv_currency ?? "").trim().toUpperCase();
  if (!Number.isSafeInteger(itemsSold) || itemsSold < 0) {
    conflicts.push({ key: videoId, reason: "items_sold不是非负整数" });
    return null;
  }
  if (!Number.isFinite(gmv) || gmv < 0) {
    conflicts.push({ key: videoId, reason: "gmv不是非负金额" });
    return null;
  }
  if (currency !== "USD") {
    conflicts.push({ key: videoId, reason: `GMV币种不是USD：${currency || "空"}` });
    return null;
  }
  return { itemsSold, gmv, gmvCurrency: "USD" };
}

function sameSnapshot(left: OnlineRecordSnapshot | null, right: OnlineRecordSnapshot | null): boolean {
  if (!left || !right) return left === right;
  return left.recordId === right.recordId
    && left.lastModifiedTime === right.lastModifiedTime
    && JSON.stringify(left.fields) === JSON.stringify(right.fields);
}

function managedChanged(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return JSON.stringify(pickManagedFields(before)) !== JSON.stringify(pickManagedFields(after));
}

function pickManagedFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(MANAGED_FIELDS.map((field) => [field, fields[field] ?? null]));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function shanghaiDateKey(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function shiftIsoDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateDistance(startDate: string, endDateExclusive: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDateExclusive}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error(`视频累计指标日期范围无效：${startDate} 至 ${endDateExclusive}`);
  }
  return Math.round((end - start) / 86_400_000);
}
