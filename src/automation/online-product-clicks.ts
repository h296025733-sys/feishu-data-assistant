import { randomUUID } from "node:crypto";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { BusinessProfile } from "../config/business-profile.js";
import type { AppEnv } from "../config/env.js";
import type { StorefourDemoGateway, VideoSource } from "../feishu/storefour-demo-gateway.js";
import { assertFeishuResponse } from "../feishu/client.js";
import { businessDateRangeToShopDateRange, dateKeyInTimeZone, shiftIsoDate } from "../realtime/business-time.js";
import { fetchTikTokAnalytics, tikTokRuntimeFromProfile } from "../realtime/tiktok-cli.js";
import type { TikTokMachineContract } from "../realtime/types.js";

const FIELD = "商品点击量";
const DATASET = "shop_video_performance_detail";
const MAX_DAYS = 180;

export interface VideoClickCandidate {
  video: Pick<VideoSource, "id" | "date">;
  endExclusive: string;
}

export interface VideoClickSyncResult {
  queried: number;
  updated: number;
  unchanged: number;
  skippedTooOld: number;
  skippedMissing: number;
  requestIds: string[];
}

export function parseVideoProductClicksDetail(
  contract: TikTokMachineContract,
  videoId: string,
  start: string,
  endExclusive: string,
): number {
  if (!contract.ok || contract.dataset !== DATASET || contract.pagination_truncated
    || contract.errors.length || contract.rows.length !== 1 || !contract.request_ids.length) {
    throw new Error(`视频 ${videoId} 商品点击量详情不完整`);
  }
  const targetDate = shiftIsoDate(endExclusive, -1);
  if (!contract.latest_available_date || contract.latest_available_date < targetDate) {
    throw new Error(`视频 ${videoId} 详情只完整到${contract.latest_available_date ?? "未知"}，未覆盖${targetDate}`);
  }
  const performance = contract.rows[0]?.performance as {
    intervals?: Array<{ start_date?: unknown; end_date?: unknown; sales?: { overall?: { product_clicks?: unknown } } }>;
  } | undefined;
  const intervals = performance?.intervals;
  if (!Array.isArray(intervals) || intervals.length !== 1
    || intervals[0]?.start_date !== start || intervals[0]?.end_date !== endExclusive) {
    throw new Error(`视频 ${videoId} 商品点击量日期区间不匹配`);
  }
  const raw = intervals[0].sales?.overall?.product_clicks;
  if (raw === null || raw === undefined || (typeof raw === "string" && !raw.trim())) throw new Error(`视频 ${videoId} 商品点击量缺失，不能当0`);
  const count = numeric(raw);
  if (count === null || !Number.isSafeInteger(count) || count < 0) throw new Error(`视频 ${videoId} 商品点击量非有效整数`);
  return count;
}

export function parseVideoDetailMetrics(contract: TikTokMachineContract, id: string, start: string, end: string): Record<string, number> {
  const clicks = parseVideoProductClicksDetail(contract, id, start, end);
  const interval = (contract.rows[0].performance as { intervals: Array<{
    traffic?: { views?: unknown };
    sales?: { overall?: { items_sold?: unknown; gmv?: { amount?: unknown; currency?: unknown } } };
  }> }).intervals[0];
  const views = numeric(interval.traffic?.views);
  const items = numeric(interval.sales?.overall?.items_sold);
  const sales = numeric(interval.sales?.overall?.gmv?.amount);
  if (views === null || !Number.isSafeInteger(views) || views < 0
    || items === null || !Number.isSafeInteger(items) || items < 0
    || sales === null || sales < 0 || interval.sales?.overall?.gmv?.currency !== "USD") {
    throw new Error(`视频 ${id} 详情曝光/成交字段不完整或币种不符，保留原值`);
  }
  return { [FIELD]: clicks, 视频曝光K: Math.round(views) / 1000, 售出数量: items, 销售额: sales };
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function videoId(value: unknown): string | null {
  const link = typeof value === "string" ? value
    : value && typeof value === "object" && "link" in value ? String(value.link ?? "") : "";
  return link.match(/\/video\/(\d{10,})(?:[/?#]|$)/)?.[1] ?? null;
}

function daysBetween(start: string, endExclusive: string): number {
  return Math.round((Date.parse(`${endExclusive}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

/** Read only the current store's existing online table to select the same
 * 14-day publish cohort used by the exposure refresh. This still works when
 * TikTok's video-list endpoint fails but product analytics has a complete day. */
export async function listRecentOnlineProductClickCandidates(input: {
  latestCompleteShopDate: string;
  probeDays: number;
  profile: BusinessProfile;
  env: AppEnv;
  client: Client;
}): Promise<VideoClickCandidate[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.latestCompleteShopDate)
    || !Number.isInteger(input.probeDays) || input.probeDays < 1 || input.probeDays > 180) {
    throw new Error("商品点击量日更日期或回看天数无效");
  }
  const tables = await input.client.bitable.appTable.list({
    path: { app_token: input.env.FEISHU_BITABLE_APP_TOKEN }, params: { page_size: 100 },
  });
  assertFeishuResponse(tables, "商品点击量读取店铺表");
  if (tables.data?.has_more) throw new Error("商品点击量店铺表分页未完整");
  const tableId = tables.data?.items?.find((item) => item.name === input.profile.tables.online)?.table_id;
  if (!tableId) throw new Error("商品点击量找不到红人上线表");
  const path = { app_token: input.env.FEISHU_BITABLE_APP_TOKEN, table_id: tableId };
  const startBusinessDate = shiftIsoDate(input.latestCompleteShopDate, -(input.probeDays - 1));
  const endExclusive = shiftIsoDate(input.latestCompleteShopDate, 1);
  const candidates: VideoClickCandidate[] = [];
  const seen = new Set<string>();
  const seenPages = new Set<string>();
  let next: string | undefined;
  do {
    const response = await input.client.bitable.appTableRecord.list({ path,
      params: { page_size: 500, page_token: next, field_names: JSON.stringify(["视频上线地址", "实上线日期(Ct)"]) } });
    assertFeishuResponse(response, "商品点击量读取上线视频");
    for (const row of response.data?.items ?? []) {
      const id = videoId(row.fields?.视频上线地址);
      if (!id) continue;
      if (seen.has(id)) throw new Error(`上线表重复视频ID：${id}`);
      seen.add(id);
      const stamp = Number(row.fields?.["实上线日期(Ct)"]);
      if (!Number.isFinite(stamp) || stamp <= 0) continue;
      const date = dateKeyInTimeZone(new Date(stamp), input.profile.businessTimeZone);
      if (date < startBusinessDate || date > endExclusive) continue;
      candidates.push({ video: { id, date }, endExclusive });
    }
    if (!response.data?.has_more) break;
    next = response.data.page_token;
    if (!next || seenPages.has(next)) throw new Error("商品点击量上线表分页重复或缺失");
    seenPages.add(next);
  } while (next);
  return candidates;
}

/**
 * Called from each store's existing staggered online phase and old-video-sale refresh.
 * Only plan video IDs are queried. The details API is distinct from the video
 * list API and gives a per-video integer, never a product-wide aggregate.
 */
export async function syncOnlineVideoProductClicks(input: {
  candidates: readonly VideoClickCandidate[];
  profile: BusinessProfile;
  env: AppEnv;
  client: Client;
  gateway: StorefourDemoGateway;
  /** Existing-video metrics fallback only; never creates videos or claims discovery succeeded. */
  refreshMetrics?: boolean;
}): Promise<VideoClickSyncResult> {
  const ids = new Map<string, VideoClickCandidate>();
  for (const candidate of input.candidates) {
    if (!/^\d{10,}$/.test(candidate.video.id)) throw new Error(`商品点击量候选视频ID无效：${candidate.video.id}`);
    const prior = ids.get(candidate.video.id);
    if (prior && prior.video.date !== candidate.video.date) {
      throw new Error(`商品点击量视频 ${candidate.video.id} 的发布时间来源冲突`);
    }
    if (!prior || candidate.endExclusive > prior.endExclusive) ids.set(candidate.video.id, candidate);
  }
  const eligible: Array<{ id: string; start: string; endExclusive: string }> = [];
  let skippedTooOld = 0;
  for (const { video, endExclusive } of ids.values()) {
    const start = businessDateRangeToShopDateRange(
      video.date, video.date, input.profile.businessTimeZone, input.profile.tiktok.shopTimeZone,
    ).startDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(endExclusive)) {
      throw new Error(`视频 ${video.id} 日期无效`);
    }
    const span = daysBetween(start, endExclusive);
    if (span < 1) throw new Error(`视频 ${video.id} 发布日晚于指标结束日`);
    if (span > MAX_DAYS) { skippedTooOld++; continue; }
    eligible.push({ id: video.id, start, endExclusive });
  }
  if (!eligible.length) return { queried: 0, updated: 0, unchanged: 0, skippedTooOld, skippedMissing: 0, requestIds: [] };

  const before = await input.gateway.snapshotOnlineByVideoIds(eligible.map((item) => item.id));
  const found = eligible.filter((item) => before.get(item.id));
  const skippedMissing = eligible.length - found.length;
  if (!found.length) return { queried: 0, updated: 0, unchanged: 0, skippedTooOld, skippedMissing, requestIds: [] };

  const snapshots = new Map<string, { fields: Record<string, number>; requestIds: string[] }>();
  const failures: string[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < found.length) {
      const item = found[cursor++]!;
      try {
        const contract = await fetchTikTokAnalytics(
          DATASET, item.start, item.endExclusive, item.id, 180_000, tikTokRuntimeFromProfile(input.profile),
        );
        if (input.profile.tiktok.shopId && contract.shop?.id !== input.profile.tiktok.shopId) {
          throw new Error(`视频 ${item.id} 店铺ID不符`);
        }
        snapshots.set(item.id, {
          fields: input.refreshMetrics
            ? parseVideoDetailMetrics(contract, item.id, item.start, item.endExclusive)
            : { [FIELD]: parseVideoProductClicksDetail(contract, item.id, item.start, item.endExclusive) },
          requestIds: contract.request_ids,
        });
      } catch (error) {
        failures.push(`${item.id}: ${String(error).slice(0, 220)}`);
        // This phase is all-or-nothing. Once it cannot commit, stop launching
        // more detail requests (the other in-flight worker is still awaited).
        cursor = found.length;
      }
    }
  }
  // Two detail workers per store; retain the existing staggered daily schedule.
  await Promise.all(Array.from({ length: Math.min(2, found.length) }, () => worker()));
  if (failures.length) {
    throw new Error(`逐视频商品点击量 ${snapshots.size}/${found.length} 成功，失败 ${failures.length}：${failures.slice(0, 3).join("；")}`);
  }

  const first = [...before.values()].find((row) => row !== null) ?? null;
  if (!first) throw new Error("商品点击量候选没有正式上线表记录");
  const tablePath = { app_token: input.env.FEISHU_BITABLE_APP_TOKEN, table_id: first.tableId };
  const fieldResponse = await input.client.bitable.appTableField.list({ path: tablePath, params: { page_size: 100 } });
  assertFeishuResponse(fieldResponse, "商品点击量字段只读校验");
  if (fieldResponse.data?.has_more) throw new Error("商品点击量字段分页未完整");
  const field = fieldResponse.data?.items?.find((item) => item.field_name === FIELD);
  if (!field || field.type !== 2 || field.property?.formatter !== "0") throw new Error("商品点击量字段缺失或不是整数列");
  const fieldTypes = new Map(fieldResponse.data?.items?.map(item => [item.field_name, item.type]));
  if (input.refreshMetrics && ["视频曝光K", "售出数量", "销售额"].some((name) => (
    fieldTypes.get(name) !== 2 && !(name === "视频曝光K" && fieldTypes.get(name) === 1)
  ))) throw new Error("视频详情回更的数值字段类型不符，保留原值");
  const changes: Array<{ id: string; recordId: string; fields: Record<string, number | string> }> = [];
  let unchanged = 0;
  for (const { id } of found) {
    const row = before.get(id);
    if (!row || row.tableId !== first.tableId || videoId(row.fields.视频上线地址) !== id) {
      throw new Error(`视频 ${id} 正式表业务键不唯一或缺失`);
    }
    const published = numeric(row.fields["实上线日期(Ct)"]);
    if (published !== null && dateKeyInTimeZone(new Date(published), input.profile.businessTimeZone) !== ids.get(id)!.video.date) {
      throw new Error(`视频 ${id} 上线日期在候选生成后变化，拒绝覆盖累计指标`);
    }
    const fields = snapshots.get(id)!.fields;
    if (Object.entries(fields).every(([name, value]) => numeric(row.fields[name]) === value)) unchanged++;
    else changes.push({ id, recordId: row.recordId, fields: Object.fromEntries(
      Object.entries(fields).map(([name, value]) => [name, fieldTypes.get(name) === 1 ? String(value) : value]),
    ) });
  }
  for (let offset = 0; offset < changes.length; offset += 50) {
    const batch = changes.slice(offset, offset + 50);
    const current = await input.gateway.snapshotOnlineByVideoIds(batch.map((item) => item.id));
    for (const item of batch) {
      const previous = before.get(item.id);
      const live = current.get(item.id);
      if (!previous || !live || live.recordId !== item.recordId || videoId(live.fields.视频上线地址) !== item.id
        || numeric(live.fields["实上线日期(Ct)"]) !== numeric(previous.fields["实上线日期(Ct)"])
        || Object.keys(item.fields).some((name) => numeric(live.fields[name]) !== numeric(previous.fields[name]))) {
        throw new Error(`视频 ${item.id} 商品点击量写前并发变化`);
      }
    }
    const result = await input.client.bitable.appTableRecord.batchUpdate({ path: tablePath,
      params: { client_token: randomUUID() },
      data: { records: batch.map((item) => ({ record_id: item.recordId, fields: item.fields })) } });
    assertFeishuResponse(result, "商品点击量日更批量写入");
    if (result.data?.records?.length !== batch.length) throw new Error("商品点击量日更回执数不足");
    const verified = await input.gateway.snapshotOnlineByVideoIds(batch.map((item) => item.id));
    for (const item of batch) {
      const after = verified.get(item.id);
      if (!after || after.recordId !== item.recordId || videoId(after.fields.视频上线地址) !== item.id
        || Object.entries(item.fields).some(([name, value]) => numeric(after.fields[name]) !== numeric(value))) {
        throw new Error(`视频 ${item.id} 商品点击量写后回读不符`);
      }
    }
  }
  return { queried: found.length, updated: changes.length, unchanged, skippedTooOld, skippedMissing,
    requestIds: found.flatMap((item) => snapshots.get(item.id)?.requestIds ?? []) };
}
