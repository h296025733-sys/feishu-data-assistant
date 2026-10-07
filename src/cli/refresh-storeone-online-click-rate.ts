import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import { fetchTikTokVideoDay, tikTokRuntimeFromProfile } from "../realtime/tiktok-cli.js";

const TENANT_ID = "storeone-formal";
const TABLE_ID = "demo_2388c86c";
const FIELD = "点击率";
const FIELD_DESCRIPTION = "TikTok Shop 逐视频挂车商品点击率（click_through_rate），是百分比，不是点击次数。仅在完整查询区间可核验时回填；接口异常时留空，不把单日指标冒充累计指标。";
const APPLY = process.argv.includes("--apply");
const PREFLIGHT = process.argv.includes("--preflight");
const SCHEMA_ONLY = process.argv.includes("--schema-only");
const CLICK_ONLY = process.argv.includes("--click-only");
if (SCHEMA_ONLY && (APPLY || PREFLIGHT)) throw new Error("--schema-only 不可与 --apply/--preflight 同用");
if (APPLY && !process.argv.includes("--confirm=STOREONE-ONLINE-CTR")) {
  throw new Error("正式写入需要明确 --confirm=STOREONE-ONLINE-CTR");
}
const tenant = new TenantRegistry(getEnv()).byId(TENANT_ID);
if (!tenant || tenant.profile.tables.online !== "红人上线表") throw new Error("STOREONE 表绑定变化");
const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
if (appToken !== "demo_1e0a6606") throw new Error("STOREONE Base 绑定变化");
const client = createFeishuClient(tenant.env);
const tablePath = { app_token: appToken, table_id: TABLE_ID };

async function fields() {
  const result = [];
  let next: string | undefined;
  do {
    const response = await client.bitable.appTableField.list({ path: tablePath, params: { page_size: 100, page_token: next } });
    assertFeishuResponse(response, "STOREONE 上线字段读取");
    result.push(...response.data?.items ?? []);
    next = response.data?.has_more ? response.data.page_token : undefined;
  } while (next);
  return result;
}
async function records() {
  const result = [];
  let next: string | undefined;
  const seen = new Set<string>();
  do {
    const response = await client.bitable.appTableRecord.list({ path: tablePath, params: { page_size: 500, page_token: next } });
    assertFeishuResponse(response, "STOREONE 上线记录读取");
    result.push(...response.data?.items ?? []);
    next = response.data?.has_more ? response.data.page_token : undefined;
    if (next && seen.has(next)) throw new Error("记录分页循环");
    if (next) seen.add(next);
  } while (next);
  return result;
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return text(object.link ?? object.text ?? "");
  }
  return String(value ?? "");
}
function id(value: unknown): string | null { return text(value).match(/\/video\/(\d{10,})(?:[/?#]|$)/)?.[1] ?? null; }
function isoDate(value: unknown): string | null {
  if (typeof value === "number") return new Date(value).toISOString().slice(0, 10);
  const raw = text(value);
  return raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}
function number(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function nextDay(value: string): string { const d = new Date(`${value}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
function argument(name: string): string | null { const index = process.argv.indexOf(name); return index < 0 ? null : String(process.argv[index + 1] ?? ""); }
const beforeFields = await fields();
const beforeRecords = await records();
const fieldByName = new Map(beforeFields.map((field) => [field.field_name, field]));
for (const name of ["视频上线地址", "视频曝光K", "售出数量"]) if (!fieldByName.has(name)) throw new Error(`缺少字段 ${name}`);
const existing = fieldByName.get(FIELD);
if (existing && (existing.type !== 2 || existing.property?.formatter !== "0.00%")) {
  throw new Error("现有点击率字段类型或格式不同，拒绝覆盖");
}
const byId = new Map<string, typeof beforeRecords>();
const dates: string[] = [];
for (const record of beforeRecords) {
  const videoId = id(record.fields?.视频上线地址);
  if (!videoId) continue;
  byId.set(videoId, [...(byId.get(videoId) ?? []), record]);
  const date = isoDate(record.fields?.["实上线日期(Ct)"]);
  if (date) dates.push(date);
}
const duplicates = [...byId].filter(([, rows]) => rows.length !== 1).map(([videoId]) => videoId);
if (duplicates.length) throw new Error(`上线表存在重复视频 ID：${duplicates.slice(0, 5).join(",")}`);
const currentDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const startDate = dates.sort()[0] ?? null;
const preflight = { at: new Date().toISOString(), tableId: TABLE_ID, recordCount: beforeRecords.length,
  validVideoIds: byId.size, missingVideoIds: beforeRecords.length - byId.size, firstPublishBusinessDate: startDate,
  queryStartDate: startDate, queryEndExclusive: nextDay(currentDate), clickFieldExists: Boolean(existing),
  fieldOrder: beforeFields.map((field) => field.field_name), viewFieldType: fieldByName.get("视频曝光K")?.type };
if (PREFLIGHT) { console.log(JSON.stringify(preflight, null, 2)); process.exit(0); }
if (SCHEMA_ONLY) {
  const artifactDir = path.resolve(".runtime/storeone-online-click-rate");
  await mkdir(artifactDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await writeFile(path.join(artifactDir, `${stamp}-schema-before.json`), JSON.stringify({ fields: beforeFields, records: beforeRecords, preflight }, null, 2));
  if (!existing) {
    const created = await client.bitable.appTableField.create({ path: tablePath,
      data: { field_name: FIELD, type: 2, ui_type: "Number", property: { formatter: "0.00%" }, description: { text: FIELD_DESCRIPTION } } });
    assertFeishuResponse(created, "新建 STOREONE 视频点击率");
  } else if (!existing.description) {
    if (!existing.field_id) throw new Error("点击率字段缺少 field_id");
    const updated = await client.bitable.appTableField.update({ path: { ...tablePath, field_id: existing.field_id },
      data: { field_name: FIELD, type: 2, ui_type: "Number", property: { formatter: "0.00%" }, description: { text: FIELD_DESCRIPTION } } });
    assertFeishuResponse(updated, "更新 STOREONE 视频点击率说明");
  }
  const afterFields = await fields();
  const afterRecords = await records();
  const actual = afterFields.find((field) => field.field_name === FIELD);
  if (!actual || actual.type !== 2 || actual.property?.formatter !== "0.00%") throw new Error("点击率建字段回读失败");
  if (afterRecords.length !== beforeRecords.length) throw new Error("建字段后记录数变化");
  for (const [index, record] of beforeRecords.entries()) {
    const after = afterRecords.find((item) => item.record_id === record.record_id);
    if (!after || JSON.stringify(after.fields) !== JSON.stringify(record.fields)) {
      throw new Error(`建字段后原有记录变化: ${index}`);
    }
  }
  const result = { ...preflight, clickFieldId: actual.field_id, fieldOrderAfter: afterFields.map((field) => field.field_name), recordsUnchanged: true };
  await writeFile(path.join(artifactDir, `${stamp}-schema-after.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
if (!startDate) throw new Error("没有可核验的视频发布日期");
const queryStartDate = argument("--start-date") ?? startDate;
const queryEndExclusive = argument("--end-date-exclusive") ?? nextDay(currentDate);
if (queryStartDate < startDate || queryEndExclusive > nextDay(currentDate) || queryStartDate >= queryEndExclusive) {
  throw new Error("查询日期超出已登记视频至当前店铺日期范围");
}
if (APPLY && !CLICK_ONLY && (queryStartDate !== startDate || queryEndExclusive !== nextDay(currentDate))) {
  throw new Error("缩短的查询区间只能预览，不能覆盖累计视频曝光K");
}
const apiVersion = argument("--api-version") === "202509" ? "202509" : "202605";
const requestedAccountType = argument("--account-type");
const accountType = requestedAccountType === "AFFILIATE_ACCOUNTS" ? "AFFILIATE_ACCOUNTS" : "ALL";
if (APPLY && CLICK_ONLY && accountType !== "AFFILIATE_ACCOUNTS") {
  throw new Error("仅点击率回填必须限定 AFFILIATE_ACCOUNTS");
}
const pageSize = Number(argument("--page-size") ?? 100);
const contract = await fetchTikTokVideoDay(queryStartDate, queryEndExclusive, 240_000, tikTokRuntimeFromProfile(tenant.profile), accountType, apiVersion, pageSize);
if (!contract.ok || contract.errors.length || contract.pagination_truncated || contract.conflicting_duplicate_ids.length) {
  throw new Error(`TikTok 分页或查询不完整：${JSON.stringify({ ok: contract.ok, errors: contract.errors, conflicts: contract.conflicting_duplicate_ids.length })}`);
}
const latest = contract.latest_available_date;
if (!latest) throw new Error("TikTok 未声明最新完整数据日，拒绝写入");
const sourceLastDate = new Date(`${queryEndExclusive}T00:00:00Z`);
sourceLastDate.setUTCDate(sourceLastDate.getUTCDate() - 1);
if (latest < sourceLastDate.toISOString().slice(0, 10)) throw new Error("TikTok 尚未完成所选点击率时间窗");
const source = new Map<string, { viewsK: number; ctr: number | null }>();
for (const row of contract.rows) {
  const videoId = String(row.id ?? "").trim();
  if (!byId.has(videoId)) continue;
  const views = number(row.views);
  if (views === null || views < 0 || !Number.isSafeInteger(views)) throw new Error(`视频 ${videoId} 的 views 无效`);
  const ctr = number(row.click_through_rate);
  if (ctr !== null && (ctr < 0 || ctr > 1)) throw new Error(`视频 ${videoId} 的 click_through_rate 超出 0–1`);
  if (source.has(videoId)) throw new Error(`TikTok 返回重复视频 ${videoId}`);
  source.set(videoId, { viewsK: views / 1000, ctr });
}
const targets = [...source].map(([videoId, metric]) => {
  const record = byId.get(videoId)![0]!;
  const previousViews = number(record.fields?.视频曝光K);
  const previousCtr = number(record.fields?.[FIELD]);
  const fields: Record<string, number> = {};
  if (!CLICK_ONLY && (previousViews === null || Math.abs(previousViews - metric.viewsK) > 0.000001)) fields.视频曝光K = metric.viewsK;
  if (metric.ctr !== null && (previousCtr === null || Math.abs(previousCtr - metric.ctr) > 0.000001)) fields[FIELD] = metric.ctr;
  return { videoId, recordId: record.record_id, previousFields: record.fields, fields, metric };
}).filter((item) => Object.keys(item.fields).length > 0);
const report = { ...preflight, apiVersion, accountType, pageSize, actualQueryStartDate: queryStartDate, actualQueryEndExclusive: queryEndExclusive,
  metricMode: CLICK_ONLY ? "click_rate_only" : "cumulative_views_and_click_rate",
  latestCompleteShopDate: latest, sourceRows: contract.rows.length, matchedVideos: source.size,
  missingFromApi: byId.size - source.size, ctrAvailable: [...source.values()].filter((value) => value.ctr !== null).length,
  ctrUnavailable: [...source.values()].filter((value) => value.ctr === null).length,
  updateCount: targets.length, ctrUpdates: targets.filter((item) => FIELD in item.fields).length,
  viewsUpdates: targets.filter((item) => "视频曝光K" in item.fields).length,
  requestIds: contract.request_ids, preview: targets.slice(0, 5).map(({ videoId, fields }) => ({ videoId, fields })) };
if (!APPLY) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
if (CLICK_ONLY) {
  const staleUnmatched = [...byId].filter(([videoId, rows]) => !source.has(videoId) && number(rows[0]?.fields?.[FIELD]) !== null);
  if (staleUnmatched.length) throw new Error(`API未返回${staleUnmatched.length}条已有点击率的视频，拒绝混合不同日期窗口`);
  if (targets.some((item) => "视频曝光K" in item.fields)) throw new Error("点击率模式意外包含视频曝光K");
}
const artifactDir = path.resolve(".runtime/storeone-online-click-rate");
await mkdir(artifactDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(path.join(artifactDir, `${stamp}-before.json`), JSON.stringify({ fields: beforeFields, records: beforeRecords, report }, null, 2));
if (!existing) {
  const created = await client.bitable.appTableField.create({ path: tablePath,
    data: { field_name: FIELD, type: 2, ui_type: "Number", property: { formatter: "0.00%" }, description: { text: FIELD_DESCRIPTION } } });
  assertFeishuResponse(created, "新建 STOREONE 视频点击率");
}
const currentFields = await fields();
const actual = currentFields.find((field) => field.field_name === FIELD);
if (!actual || actual.type !== 2 || actual.property?.formatter !== "0.00%") throw new Error("点击率建字段回读失败");
// Read back identity and all protected fields immediately before each bounded batch.
for (let offset = 0; offset < targets.length; offset += 50) {
  const slice = targets.slice(offset, offset + 50);
  const live = new Map((await records()).map((record) => [record.record_id, record]));
  const changes = slice.map((item) => {
    const row = live.get(item.recordId);
    if (!row || id(row.fields?.视频上线地址) !== item.videoId) throw new Error(`视频 ${item.videoId} 写前身份变化`);
    for (const [key, value] of Object.entries(item.previousFields ?? {})) {
      if (key === "视频曝光K" || key === FIELD) continue;
      if (JSON.stringify(row.fields?.[key]) !== JSON.stringify(value)) throw new Error(`视频 ${item.videoId} 字段 ${key} 被并发编辑`);
    }
    const next: Record<string, number> = {};
    for (const [key, value] of Object.entries(item.fields)) {
      const current = number(row.fields?.[key]);
      if (current === null || Math.abs(current - value) > 0.000001) next[key] = value;
    }
    return { record_id: item.recordId, fields: next };
  }).filter((item) => Object.keys(item.fields).length);
  if (changes.length) {
    const response = await client.bitable.appTableRecord.batchUpdate({ path: tablePath,
      params: { client_token: randomUUID() }, data: { records: changes } });
    assertFeishuResponse(response, `STOREONE 视频指标批量回填 ${offset}`);
    if (response.data?.records?.length !== changes.length) throw new Error("批量回执数量不一致");
  }
}
const afterFields = await fields();
const afterRecords = await records();
const after = new Map(afterRecords.map((record) => [record.record_id, record]));
const mismatches = [];
for (const target of targets) {
  const row = after.get(target.recordId);
  if (!row || id(row.fields?.视频上线地址) !== target.videoId) { mismatches.push(`${target.videoId}:身份`); continue; }
  for (const [key, value] of Object.entries(target.fields)) {
    if (Math.abs((number(row.fields?.[key]) ?? NaN) - value) > 0.000001) mismatches.push(`${target.videoId}:${key}`);
  }
  for (const [key, value] of Object.entries(target.previousFields ?? {})) {
    if (key === FIELD || key === "视频曝光K") continue;
    if (JSON.stringify(row.fields?.[key]) !== JSON.stringify(value)) mismatches.push(`${target.videoId}:保护:${key}`);
  }
}
const result = { ...report, afterRecordCount: afterRecords.length, clickFieldId: afterFields.find((field) => field.field_name === FIELD)?.field_id,
  mismatches, recordCountUnchanged: beforeRecords.length === afterRecords.length };
if (CLICK_ONLY && mismatches.length === 0 && result.recordCountUnchanged) {
  const field = afterFields.find((item) => item.field_name === FIELD);
  if (!field?.field_id) throw new Error("点击率字段ID丢失");
  const description = `TikTok Shop逐视频挂车商品点击率，不是点击次数；统计窗口：美国店铺日期${queryStartDate}至${sourceLastDate.toISOString().slice(0, 10)}。未返回视频留空，真实0%显示0.00%。`;
  const updated = await client.bitable.appTableField.update({ path: { ...tablePath, field_id: field.field_id },
    data: { field_name: FIELD, type: 2, ui_type: "Number", property: { formatter: "0.00%" }, description: { text: description } } });
  assertFeishuResponse(updated, "更新 STOREONE 点击率统计日期说明");
  const confirmed = (await fields()).find((item) => item.field_id === field.field_id);
  if (confirmed?.description !== description) throw new Error("点击率日期说明回读失败");
}
await writeFile(path.join(artifactDir, `${stamp}-after.json`), JSON.stringify({ records: afterRecords, result }, null, 2));
console.log(JSON.stringify(result, null, 2));
if (mismatches.length || !result.recordCountUnchanged) process.exitCode = 1;
