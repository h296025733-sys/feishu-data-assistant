import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

const APPLY = process.argv.includes("--apply");
if (APPLY && !process.argv.includes("--confirm=STOREONE-VIDEO-CLICKS")) {
  throw new Error("正式点击量迁移需要 --confirm=STOREONE-VIDEO-CLICKS");
}
const START = "2026-08-01";
const END_EXCLUSIVE = "2026-09-27";
const DIR = path.resolve(`.runtime/storeone-video-product-clicks/${START}_${END_EXCLUSIVE}`);
const TABLE_ID = "demo_2388c86c";
const TARGET_ID = "fldNkRoIkw";
const BACKUP_ID = "fldPjUqSZZ";
const IN_PROGRESS = "商品点击量（更新中）";
const FINAL = "商品点击量";
const DESCRIPTION = "TikTok Shop单条视频带货商品点击次数之和；来源：视频表现详情performance.intervals[].sales.overall.product_clicks。统计窗口为美国店铺日期2026-08-01至2026-09-26。真实0填写0，无有效视频ID留空；非点击率百分比。";
const tenant = new TenantRegistry(getEnv()).byId("storeone-formal");
if (!tenant || tenant.env.FEISHU_BITABLE_APP_TOKEN !== "demo_1e0a6606") {
  throw new Error("STOREONE 正式 Base 绑定变化");
}
const client = createFeishuClient(tenant.env);
const tablePath = { app_token: tenant.env.FEISHU_BITABLE_APP_TOKEN, table_id: TABLE_ID };

async function fields() {
  const response = await client.bitable.appTableField.list({ path: tablePath, params: { page_size: 100 } });
  assertFeishuResponse(response, "STOREONE字段读取");
  if (response.data?.has_more) throw new Error("字段分页未完整");
  return response.data?.items ?? [];
}
async function records() {
  const result = [];
  let next: string | undefined;
  const seen = new Set<string>();
  do {
    const response = await client.bitable.appTableRecord.list({ path: tablePath, params: { page_size: 500, page_token: next } });
    assertFeishuResponse(response, "STOREONE记录读取");
    result.push(...response.data?.items ?? []);
    next = response.data?.has_more ? response.data.page_token : undefined;
    if (next && seen.has(next)) throw new Error("记录分页循环");
    if (next) seen.add(next);
  } while (next);
  return result;
}
function videoId(value: unknown): string | null {
  const link = value && typeof value === "object" && "link" in value ? String(value.link ?? "") : "";
  return link.match(/\/video\/(\d{10,})(?:[/?#]|$)/)?.[1] ?? null;
}
function metric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
type Cached = { videoId: string; start: string; endExclusive: string; productClicks: number; productImpressions: number; requestIds: string[] };
const roster = JSON.parse(await readFile(path.join(DIR, "roster.json"), "utf8")) as { summary: { rowCount: number }; ids: string[] };
if (new Set(roster.ids).size !== roster.ids.length) throw new Error("采集清单存在重复视频ID");
const counts = new Map<string, number>();
for (const id of roster.ids) {
  const snapshot = JSON.parse(await readFile(path.join(DIR, `${id}.json`), "utf8")) as Cached;
  if (snapshot.videoId !== id || snapshot.start !== START || snapshot.endExclusive !== END_EXCLUSIVE
    || !Number.isSafeInteger(snapshot.productClicks) || snapshot.productClicks < 0
    || !Number.isSafeInteger(snapshot.productImpressions) || snapshot.productImpressions < 0
    || !snapshot.requestIds?.length) {
    throw new Error(`视频 ${id} 采集快照无效`);
  }
  counts.set(id, snapshot.productClicks);
}
const beforeFields = await fields();
const beforeRecords = await records();
const target = beforeFields.find((field) => field.field_id === TARGET_ID);
const backup = beforeFields.find((field) => field.field_id === BACKUP_ID);
const names = beforeFields.map((field) => field.field_name);
const k = names.indexOf("视频曝光K");
if (!target || !backup || k < 0 || beforeFields[k + 1]?.field_id !== TARGET_ID || names[k + 2] !== "售出数量") {
  throw new Error("目标字段ID或位置变化，拒绝迁移");
}
if (target.type !== 2 || backup.type !== 2 || backup.field_name !== "点击率_备份（2026-09-28）") {
  throw new Error("目标或旧率备份字段结构变化");
}
if (!["点击率", IN_PROGRESS, FINAL].includes(target.field_name)) throw new Error("可见目标字段名称变化");
if (target.field_name === "点击率" && target.property?.formatter !== "0.00%") throw new Error("原点击率格式变化");
if (target.field_name !== "点击率" && target.property?.formatter !== "0") throw new Error("商品点击量格式变化");
if (beforeRecords.length !== roster.summary.rowCount) throw new Error("采集后正式表行数变化，需重新采集");
const liveById = new Map<string, { recordId: string; value: number }>();
for (const row of beforeRecords) {
  const id = videoId(row.fields?.视频上线地址);
  if (!id) {
    if (metric(row.fields?.[target.field_name]) !== null) throw new Error(`无视频ID行却已有指标 ${row.record_id}`);
    continue;
  }
  if (!counts.has(id) || liveById.has(id) || !row.record_id) throw new Error(`视频ID集合或唯一性变化 ${id}`);
  liveById.set(id, { recordId: row.record_id, value: counts.get(id)! });
  if (target.field_name === "点击率") {
    const previous = metric(row.fields?.[target.field_name]);
    const saved = metric(row.fields?.[backup.field_name]);
    if (previous !== saved || (previous !== null && (previous < 0 || previous > 1))) {
      throw new Error(`原点击率与隐藏备份不符 ${row.record_id}`);
    }
  }
}
if (liveById.size !== counts.size) throw new Error("采集视频与当前正式表不一致");
const report = { at: new Date().toISOString(), rowCount: beforeRecords.length, videoCount: counts.size,
  blankVideoRows: beforeRecords.length - counts.size, sourceStart: START, sourceEndExclusive: END_EXCLUSIVE,
  fieldBefore: target.field_name, zeroClicks: [...counts.values()].filter((value) => value === 0).length };
if (!APPLY) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
await mkdir(DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(path.join(DIR, `${stamp}-apply-before.json`), JSON.stringify({ fields: beforeFields, records: beforeRecords, report }, null, 2));

if (target.field_name === "点击率") {
  const updated = await client.bitable.appTableField.update({ path: { ...tablePath, field_id: TARGET_ID },
    data: { field_name: IN_PROGRESS, type: 2, ui_type: "Number", property: { formatter: "0" }, description: { text: DESCRIPTION } } });
  assertFeishuResponse(updated, "点击率列转换为商品点击量（更新中）");
}
const liveField = (await fields()).find((field) => field.field_id === TARGET_ID);
if (!liveField || ![IN_PROGRESS, FINAL].includes(liveField.field_name) || liveField.property?.formatter !== "0") {
  throw new Error("商品点击量字段类型转换回读失败");
}
const targets = [...liveById.entries()].map(([id, row]) => ({ videoId: id, ...row }));
for (let offset = 0; offset < targets.length; offset += 50) {
  const batch = targets.slice(offset, offset + 50);
  const current = new Map((await records()).map((row) => [row.record_id, row]));
  const changes = batch.filter(({ videoId, recordId, value }) => {
    const row = current.get(recordId);
    if (!row || videoId !== videoIdFromRow(row)) throw new Error(`视频业务键被并发改动 ${recordId}`);
    return metric(row.fields?.[liveField.field_name]) !== value;
  }).map(({ recordId, value }) => ({ record_id: recordId, fields: { [liveField.field_name]: value } }));
  if (changes.length) {
    const response = await client.bitable.appTableRecord.batchUpdate({ path: tablePath,
      params: { client_token: randomUUID() }, data: { records: changes } });
    assertFeishuResponse(response, `商品点击量批量写入 ${offset}`);
    if (response.data?.records?.length !== changes.length) throw new Error(`批次 ${offset} 回执数不足`);
  }
  const afterBatch = new Map((await records()).map((row) => [row.record_id, row]));
  for (const { recordId, value } of batch) {
    if (metric(afterBatch.get(recordId)?.fields?.[liveField.field_name]) !== value) {
      throw new Error(`批次 ${offset} 回读不符 ${recordId}`);
    }
  }
  console.log(JSON.stringify({ stage: "batch", processed: Math.min(offset + 50, targets.length), total: targets.length }));
}
if (liveField.field_name !== FINAL) {
  const renamed = await client.bitable.appTableField.update({ path: { ...tablePath, field_id: TARGET_ID },
    data: { field_name: FINAL, type: 2, ui_type: "Number", property: { formatter: "0" }, description: { text: DESCRIPTION } } });
  assertFeishuResponse(renamed, "商品点击量最终字段命名");
}
const afterFields = await fields();
const afterRecords = await records();
const finalField = afterFields.find((field) => field.field_id === TARGET_ID);
const afterByRecord = new Map(afterRecords.map((row) => [row.record_id, row]));
const errors: string[] = [];
if (!finalField || finalField.field_name !== FINAL || finalField.property?.formatter !== "0") errors.push("字段类型/名称");
if (afterRecords.length !== beforeRecords.length) errors.push("记录数");
for (const before of beforeRecords) {
  const after = afterByRecord.get(before.record_id);
  if (!after) { errors.push(`缺行 ${before.record_id}`); continue; }
  const id = videoId(before.fields?.视频上线地址);
  const expected = id ? counts.get(id) : null;
  if (metric(after.fields?.[FINAL]) !== expected) errors.push(`点击量 ${before.record_id}`);
  const protectedBefore = { ...before.fields };
  const protectedAfter = { ...after.fields };
  delete protectedBefore[target.field_name];
  delete protectedAfter[FINAL];
  if (JSON.stringify(protectedBefore) !== JSON.stringify(protectedAfter)) errors.push(`其他字段 ${before.record_id}`);
}
function videoIdFromRow(row: { fields?: Record<string, unknown> }): string | null {
  return videoId(row.fields?.视频上线地址);
}
const result = { ...report, finalFieldId: TARGET_ID, finalName: finalField?.field_name,
  afterRows: afterRecords.length, errors };
await writeFile(path.join(DIR, `${stamp}-apply-after.json`), JSON.stringify({ fields: afterFields, records: afterRecords, result }, null, 2));
console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exitCode = 1;
