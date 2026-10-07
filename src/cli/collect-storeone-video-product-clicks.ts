import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import { fetchTikTokAnalytics, tikTokRuntimeFromProfile } from "../realtime/tiktok-cli.js";

const START = "2026-08-01";
const END_EXCLUSIVE = "2026-09-27";
const TENANT_ID = "storeone-formal";
const TABLE_ID = "demo_2388c86c";
const DIR = path.resolve(`.runtime/storeone-video-product-clicks/${START}_${END_EXCLUSIVE}`);
const tenant = new TenantRegistry(getEnv()).byId(TENANT_ID);
if (!tenant || tenant.env.FEISHU_BITABLE_APP_TOKEN !== "demo_1e0a6606") {
  throw new Error("STOREONE 正式 Base 绑定变化");
}
const client = createFeishuClient(tenant.env);
const tablePath = { app_token: tenant.env.FEISHU_BITABLE_APP_TOKEN, table_id: TABLE_ID };

async function rows() {
  const result = [];
  let next: string | undefined;
  const seen = new Set<string>();
  do {
    const response = await client.bitable.appTableRecord.list({ path: tablePath, params: { page_size: 500, page_token: next } });
    assertFeishuResponse(response, "STOREONE 红人上线表只读");
    result.push(...response.data?.items ?? []);
    next = response.data?.has_more ? response.data.page_token : undefined;
    if (next && seen.has(next)) throw new Error("飞书分页重复");
    if (next) seen.add(next);
  } while (next);
  return result;
}
function videoId(value: unknown): string | null {
  const link = value && typeof value === "object" && "link" in value ? String(value.link ?? "") : "";
  return link.match(/\/video\/(\d{10,})(?:[/?#]|$)/)?.[1] ?? null;
}
function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("TikTok 对象结构异常");
  return value as Record<string, unknown>;
}
function checkedCount(value: unknown, label: string): number {
  if (value === null || value === undefined || value === "") throw new Error(`${label}缺失`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label}不是非负整数`);
  return parsed;
}
type Snapshot = {
  videoId: string;
  start: string;
  endExclusive: string;
  productClicks: number;
  productImpressions: number;
  ctr: number | null;
  requestIds: string[];
  fetchedAt: string;
};
function validateSnapshot(snapshot: Snapshot, expectedId: string): Snapshot {
  if (snapshot.videoId !== expectedId || snapshot.start !== START || snapshot.endExclusive !== END_EXCLUSIVE) {
    throw new Error(`视频 ${expectedId} 的本地快照范围不匹配`);
  }
  checkedCount(snapshot.productClicks, "商品点击量");
  checkedCount(snapshot.productImpressions, "商品曝光量");
  if (snapshot.ctr !== null && (!Number.isFinite(snapshot.ctr) || snapshot.ctr < 0 || snapshot.ctr > 1)) {
    throw new Error(`视频 ${expectedId} 的点击率异常`);
  }
  return snapshot;
}
async function collectOne(id: string): Promise<Snapshot> {
  const file = path.join(DIR, `${id}.json`);
  try {
    return validateSnapshot(JSON.parse(await readFile(file, "utf8")) as Snapshot, id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const contract = await fetchTikTokAnalytics(
    "shop_video_performance_detail", START, END_EXCLUSIVE, id, 180_000,
    tikTokRuntimeFromProfile(tenant!.profile),
  );
  if (!contract.ok || contract.rows?.length !== 1 || contract.pagination_truncated) {
    throw new Error(`视频 ${id} 的详情合同不完整`);
  }
  const performance = toRecord(toRecord(contract.rows[0]).performance);
  const intervals = performance.intervals;
  if (!Array.isArray(intervals) || intervals.length !== 1) throw new Error(`视频 ${id} 的区间数不是1`);
  const interval = toRecord(intervals[0]);
  if (interval.start_date !== START || interval.end_date !== END_EXCLUSIVE) {
    throw new Error(`视频 ${id} 的返回区间不匹配`);
  }
  const overall = toRecord(toRecord(interval.sales).overall);
  const rawCtr = overall.ctr;
  const ctr = rawCtr === null || rawCtr === undefined || rawCtr === "" ? null : Number(rawCtr);
  const snapshot = validateSnapshot({
    videoId: id,
    start: START,
    endExclusive: END_EXCLUSIVE,
    productClicks: checkedCount(overall.product_clicks, "商品点击量"),
    productImpressions: checkedCount(overall.product_impressions, "商品曝光量"),
    ctr,
    requestIds: contract.request_ids ?? [],
    fetchedAt: contract.fetched_at,
  }, id);
  await writeFile(file, JSON.stringify(snapshot, null, 2), { flag: "wx" });
  return snapshot;
}

await mkdir(DIR, { recursive: true });
const records = await rows();
const ids = records.map((record) => videoId(record.fields?.视频上线地址)).filter((id): id is string => id !== null);
if (new Set(ids).size !== ids.length) throw new Error("飞书表视频ID有重复，拒绝采集");
const summary = { at: new Date().toISOString(), rowCount: records.length, validIds: ids.length,
  missingIds: records.length - ids.length, start: START, endExclusive: END_EXCLUSIVE };
await writeFile(path.join(DIR, "roster.json"), JSON.stringify({ summary, ids }, null, 2));
console.log(JSON.stringify({ stage: "start", ...summary }));
let cursor = 0;
let succeeded = 0;
const failures: Array<{ videoId: string; error: string }> = [];
async function worker() {
  while (cursor < ids.length) {
    const id = ids[cursor++]!;
    try {
      await collectOne(id);
      succeeded++;
    } catch (error) {
      failures.push({ videoId: id, error: String(error).slice(0, 300) });
    }
    if ((succeeded + failures.length) % 25 === 0) {
      console.log(JSON.stringify({ stage: "progress", done: succeeded + failures.length, succeeded, failed: failures.length }));
    }
  }
}
await Promise.all(Array.from({ length: 3 }, () => worker()));
await writeFile(path.join(DIR, "last-run.json"), JSON.stringify({ ...summary, succeeded, failures }, null, 2));
console.log(JSON.stringify({ stage: "complete", ...summary, succeeded, failed: failures.length, failures: failures.slice(0, 10) }));
if (failures.length) process.exitCode = 1;
