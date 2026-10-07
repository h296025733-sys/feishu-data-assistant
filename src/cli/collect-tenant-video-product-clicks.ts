import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import { fetchTikTokAnalytics, tikTokRuntimeFromProfile } from "../realtime/tiktok-cli.js";

const tenantId = process.argv.find((arg) => arg.startsWith("--tenant="))?.slice(9);
if (!tenantId || !["storetwo-formal", "storetwo-botanical-care-formal"].includes(tenantId)) {
  throw new Error("只允许 --tenant=storetwo-formal 或 storetwo-botanical-care-formal");
}
const START = "2026-08-01";
const END_EXCLUSIVE = "2026-09-27";
const DIR = path.resolve(`.runtime/online-video-product-clicks/${tenantId}/${START}_${END_EXCLUSIVE}`);
const tenant = new TenantRegistry(getEnv()).byId(tenantId);
if (!tenant) throw new Error("店铺绑定不存在");
const client = createFeishuClient(tenant.env);
const tables = await client.bitable.appTable.list({ path: { app_token: tenant.env.FEISHU_BITABLE_APP_TOKEN }, params: { page_size: 100 } });
assertFeishuResponse(tables, `${tenantId} 表`);
if (tables.data?.has_more) throw new Error("表分页未完整");
const tableId = tables.data?.items?.find((item) => item.name === tenant.profile.tables.online)?.table_id;
if (!tableId) throw new Error("红人上线表未找到");
const tablePath = { app_token: tenant.env.FEISHU_BITABLE_APP_TOKEN, table_id: tableId };
const rows = [];
let next: string | undefined;
do {
  const response = await client.bitable.appTableRecord.list({ path: tablePath, params: { page_size: 500, page_token: next } });
  assertFeishuResponse(response, `${tenantId} 红人上线表`);
  rows.push(...response.data?.items ?? []);
  next = response.data?.has_more ? response.data.page_token : undefined;
} while (next);
function idFromLink(value: unknown): string | null {
  const link = value && typeof value === "object" && "link" in value ? String(value.link ?? "") : "";
  return link.match(/\/video\/(\d{10,})(?:[/?#]|$)/)?.[1] ?? null;
}
const ids = rows.map((row) => idFromLink(row.fields?.视频上线地址)).filter((id): id is string => id !== null);
if (new Set(ids).size !== ids.length) throw new Error("正式表有重复视频ID，拒绝采集");
await mkdir(DIR, { recursive: true });
const summary = { tenantId, tableId, base: tenant.env.FEISHU_BITABLE_APP_TOKEN, start: START, endExclusive: END_EXCLUSIVE,
  rowCount: rows.length, videoCount: ids.length, blankVideoRows: rows.length - ids.length, at: new Date().toISOString() };
await writeFile(path.join(DIR, "roster.json"), JSON.stringify({ summary, ids }, null, 2));
console.log(JSON.stringify({ stage: "start", ...summary }));
let cursor = 0;
let succeeded = 0;
const failures: Array<{ videoId: string; error: string }> = [];
async function worker() {
  while (cursor < ids.length) {
    const id = ids[cursor++]!;
    try {
      const file = path.join(DIR, `${id}.json`);
      try {
        const cached = JSON.parse(await readFile(file, "utf8")) as { videoId: string; start: string; endExclusive: string; productClicks: number };
        if (cached.videoId !== id || cached.start !== START || cached.endExclusive !== END_EXCLUSIVE
          || !Number.isSafeInteger(cached.productClicks) || cached.productClicks < 0) throw new Error(`缓存 ${id} 不合法`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const contract = await fetchTikTokAnalytics("shop_video_performance_detail", START, END_EXCLUSIVE, id, 180_000,
          tikTokRuntimeFromProfile(tenant!.profile));
        if (!contract.ok || contract.rows.length !== 1 || contract.pagination_truncated) throw new Error(`视频 ${id} 详情不完整`);
        const performance = contract.rows[0]?.performance as { intervals?: Array<{ start_date?: string; end_date?: string; sales?: { overall?: { product_clicks?: unknown } } }> } | undefined;
        const interval = performance?.intervals?.[0];
        if (performance?.intervals?.length !== 1 || interval?.start_date !== START || interval.end_date !== END_EXCLUSIVE) {
          throw new Error(`视频 ${id} 返回日期区间不符`);
        }
        const raw = interval.sales?.overall?.product_clicks;
        if (raw === null || raw === undefined || raw === "") throw new Error(`视频 ${id} 无商品点击量`);
        const productClicks = Number(raw);
        if (!Number.isSafeInteger(productClicks) || productClicks < 0 || !contract.request_ids?.length) {
          throw new Error(`视频 ${id} 商品点击量或原生请求编号异常`);
        }
        await writeFile(file, JSON.stringify({ videoId: id, start: START, endExclusive: END_EXCLUSIVE,
          productClicks, requestIds: contract.request_ids, fetchedAt: contract.fetched_at }, null, 2), { flag: "wx" });
      }
      succeeded++;
    } catch (error) {
      failures.push({ videoId: id, error: String(error).slice(0, 400) });
    }
    if ((succeeded + failures.length) % 25 === 0) {
      console.log(JSON.stringify({ stage: "progress", done: succeeded + failures.length, succeeded, failed: failures.length }));
    }
  }
}
await Promise.all(Array.from({ length: 4 }, () => worker()));
await writeFile(path.join(DIR, "last-run.json"), JSON.stringify({ ...summary, succeeded, failures }, null, 2));
console.log(JSON.stringify({ stage: "complete", tenantId, succeeded, failed: failures.length, failures: failures.slice(0, 5) }));
if (failures.length) process.exitCode = 1;
