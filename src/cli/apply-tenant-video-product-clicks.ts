import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

const tenantId = process.argv.find((arg) => arg.startsWith("--tenant="))?.slice(9);
if (!tenantId || !["storetwo-formal", "storetwo-botanical-care-formal"].includes(tenantId)) {
  throw new Error("只允许 Storetwo / Storetwo Botanical Care 两家新增字段");
}
const apply = process.argv.includes("--apply");
if (apply && !process.argv.includes("--confirm=VIDEO-PRODUCT-CLICKS")) throw new Error("缺少精确确认参数");
const START = "2026-08-01";
const END_EXCLUSIVE = "2026-09-27";
const DIR = path.resolve(`.runtime/online-video-product-clicks/${tenantId}/${START}_${END_EXCLUSIVE}`);
const FIELD = "商品点击量";
const DESCRIPTION = "TikTok Shop逐视频挂车商品点击次数（非点击率）。自动更新与红人上线表视频曝光K同属每日上线视频同步；真实0记0，缺视频ID或API无确定值留空。";
const tenant = new TenantRegistry(getEnv()).byId(tenantId);
if (!tenant) throw new Error("店铺绑定不存在");
const client = createFeishuClient(tenant.env);
const tables = await client.bitable.appTable.list({ path: { app_token: tenant.env.FEISHU_BITABLE_APP_TOKEN }, params: { page_size: 100 } });
assertFeishuResponse(tables, `${tenantId} 表`);
if (tables.data?.has_more) throw new Error("表分页未完整");
const tableId = tables.data?.items?.find((item) => item.name === tenant.profile.tables.online)?.table_id;
if (!tableId) throw new Error("红人上线表不存在");
const tablePath = { app_token: tenant.env.FEISHU_BITABLE_APP_TOKEN, table_id: tableId };
async function fields() {
  const result = await client.bitable.appTableField.list({ path: tablePath, params: { page_size: 100 } });
  assertFeishuResponse(result, "读取字段");
  if (result.data?.has_more) throw new Error("字段分页未完整");
  return result.data?.items ?? [];
}
async function records() {
  const rows = [];
  let next: string | undefined;
  do {
    const result = await client.bitable.appTableRecord.list({ path: tablePath, params: { page_size: 500, page_token: next } });
    assertFeishuResponse(result, "读取记录");
    rows.push(...result.data?.items ?? []);
    next = result.data?.has_more ? result.data.page_token : undefined;
  } while (next);
  return rows;
}
function videoId(value: unknown): string | null {
  const link = value && typeof value === "object" && "link" in value ? String(value.link ?? "") : "";
  return link.match(/\/video\/(\d{10,})(?:[/?#]|$)/)?.[1] ?? null;
}
function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
const roster = JSON.parse(await readFile(path.join(DIR, "roster.json"), "utf8")) as {
  summary: { tenantId: string; tableId: string; base: string; rowCount: number }; ids: string[];
};
if (roster.summary.tenantId !== tenantId || roster.summary.tableId !== tableId
  || roster.summary.base !== tenant.env.FEISHU_BITABLE_APP_TOKEN
  || new Set(roster.ids).size !== roster.ids.length) throw new Error("采集清单绑定或唯一性异常");
const counts = new Map<string, number>();
for (const id of roster.ids) {
  const snapshot = JSON.parse(await readFile(path.join(DIR, `${id}.json`), "utf8")) as {
    videoId: string; start: string; endExclusive: string; productClicks: number; requestIds: string[];
  };
  if (snapshot.videoId !== id || snapshot.start !== START || snapshot.endExclusive !== END_EXCLUSIVE
    || !Number.isSafeInteger(snapshot.productClicks) || snapshot.productClicks < 0 || !snapshot.requestIds?.length) {
    throw new Error(`视频 ${id} 采集快照无效`);
  }
  counts.set(id, snapshot.productClicks);
}
const beforeFields = await fields();
const beforeRecords = await records();
const existing = beforeFields.find((field) => field.field_name === FIELD);
if (existing && (existing.type !== 2 || existing.property?.formatter !== "0")) throw new Error("已有同名字段不是整数，拒绝覆盖");
if (beforeRecords.length !== roster.summary.rowCount) throw new Error("正式表行数在采集后变化，需重新采集");
const byId = new Map<string, { recordId: string; value: number }>();
for (const row of beforeRecords) {
  const id = videoId(row.fields?.视频上线地址);
  if (!id) {
    if (numberOrNull(row.fields?.[FIELD]) !== null) throw new Error(`无视频ID行有点击量：${row.record_id}`);
    continue;
  }
  if (!counts.has(id) || byId.has(id) || !row.record_id) throw new Error(`视频ID集合或唯一性变化：${id}`);
  byId.set(id, { recordId: row.record_id, value: counts.get(id)! });
}
if (byId.size !== counts.size) throw new Error("采集视频与正式表不一致");
const summary = { tenantId, tableId, rowCount: beforeRecords.length, videos: counts.size,
  blankVideoRows: beforeRecords.length - counts.size,
  zeroClicks: [...counts.values()].filter((value) => value === 0).length,
  fieldExists: Boolean(existing), start: START, endExclusive: END_EXCLUSIVE };
if (!apply) { console.log(JSON.stringify(summary, null, 2)); process.exit(0); }
await mkdir(DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(path.join(DIR, `${stamp}-before.json`), JSON.stringify({ fields: beforeFields, records: beforeRecords, summary }, null, 2));
if (!existing) {
  const created = await client.bitable.appTableField.create({ path: tablePath,
    data: { field_name: FIELD, type: 2, ui_type: "Number", property: { formatter: "0" }, description: { text: DESCRIPTION } } });
  assertFeishuResponse(created, `${tenantId} 新建商品点击量`);
}
const liveField = (await fields()).find((field) => field.field_name === FIELD);
if (!liveField?.field_id || liveField.type !== 2 || liveField.property?.formatter !== "0") throw new Error("字段创建回读失败");
const targets = [...byId.entries()].map(([id, row]) => ({ id, ...row }));
for (let offset = 0; offset < targets.length; offset += 50) {
  const batch = targets.slice(offset, offset + 50);
  const current = new Map((await records()).map((row) => [row.record_id, row]));
  const changes = batch.filter(({ id, recordId, value }) => {
    const row = current.get(recordId);
    if (!row || videoId(row.fields?.视频上线地址) !== id) throw new Error(`业务键并发变化：${recordId}`);
    return numberOrNull(row.fields?.[FIELD]) !== value;
  }).map(({ recordId, value }) => ({ record_id: recordId, fields: { [FIELD]: value } }));
  if (changes.length) {
    const updated = await client.bitable.appTableRecord.batchUpdate({ path: tablePath,
      params: { client_token: randomUUID() }, data: { records: changes } });
    assertFeishuResponse(updated, `${tenantId} 点击量批量写入`);
    if (updated.data?.records?.length !== changes.length) throw new Error("批量写回执数不足");
  }
  const check = new Map((await records()).map((row) => [row.record_id, row]));
  for (const { recordId, value } of batch) {
    if (numberOrNull(check.get(recordId)?.fields?.[FIELD]) !== value) throw new Error(`批次回读不符：${recordId}`);
  }
  console.log(JSON.stringify({ stage: "batch", tenantId, processed: Math.min(offset + 50, targets.length), total: targets.length }));
}
const afterFields = await fields();
const afterRecords = await records();
const errors: string[] = [];
if (afterRecords.length !== beforeRecords.length) errors.push("行数变化");
const finalField = afterFields.find((field) => field.field_id === liveField.field_id);
if (!finalField || finalField.field_name !== FIELD || finalField.type !== 2 || finalField.property?.formatter !== "0") errors.push("字段变化");
const afterById = new Map(afterRecords.map((row) => [row.record_id, row]));
for (const before of beforeRecords) {
  const after = afterById.get(before.record_id);
  if (!after) { errors.push(`缺行${before.record_id}`); continue; }
  const id = videoId(before.fields?.视频上线地址);
  if (numberOrNull(after.fields?.[FIELD]) !== (id ? counts.get(id) : null)) errors.push(`点击量${before.record_id}`);
  const protectedBefore = { ...before.fields };
  const protectedAfter = { ...after.fields };
  delete protectedBefore[FIELD];
  delete protectedAfter[FIELD];
  if (JSON.stringify(protectedBefore) !== JSON.stringify(protectedAfter)) errors.push(`其他字段${before.record_id}`);
}
const result = { ...summary, finalFieldId: liveField.field_id, finalRows: afterRecords.length, errors };
await writeFile(path.join(DIR, `${stamp}-after.json`), JSON.stringify({ fields: afterFields, records: afterRecords, result }, null, 2));
console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exitCode = 1;
