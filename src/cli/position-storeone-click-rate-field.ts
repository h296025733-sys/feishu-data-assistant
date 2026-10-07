import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

const APPLY = process.argv.includes("--apply");
if (APPLY && !process.argv.includes("--confirm=STOREONE-CLICK-FIELD-POSITION")) throw new Error("正式列迁移需要明确确认参数");
const tenant = new TenantRegistry(getEnv()).byId("storeone-formal");
if (!tenant || tenant.env.FEISHU_BITABLE_APP_TOKEN !== "demo_1e0a6606") throw new Error("STOREONE绑定变化");
const client = createFeishuClient(tenant.env);
const pathIds = { app_token: tenant.env.FEISHU_BITABLE_APP_TOKEN, table_id: "demo_2388c86c" };
const oldFieldId = "fldPjUqSZZ";
const newFieldId = "fldNkRoIkw";
const viewId = "vewyGw8utu";
const backupName = "点击率_备份（2026-09-28）";
const sourceDateDescription = "TikTok Shop逐视频挂车商品点击率，不是点击次数；统计窗口：美国店铺日期2026-09-22至2026-09-25。未返回视频留空，真实0%显示0.00%。";

async function readFields() {
  const response = await client.bitable.appTableField.list({ path: pathIds, params: { page_size: 100 } });
  assertFeishuResponse(response, "STOREONE字段读取");
  if (response.data?.has_more) throw new Error("字段分页未完整");
  return response.data?.items ?? [];
}
async function readRecords() {
  const result = [];
  let page: string | undefined;
  const seen = new Set<string>();
  do {
    const response = await client.bitable.appTableRecord.list({ path: pathIds, params: { page_size: 500, page_token: page } });
    assertFeishuResponse(response, "STOREONE记录读取");
    result.push(...response.data?.items ?? []);
    page = response.data?.has_more ? response.data.page_token : undefined;
    if (page && seen.has(page)) throw new Error("记录分页重复");
    if (page) seen.add(page);
  } while (page);
  return result;
}
async function readView() {
  const response = await client.bitable.appTableView.get({ path: { ...pathIds, view_id: viewId } });
  assertFeishuResponse(response, "STOREONE视图读取");
  if (!response.data?.view || response.data.view.view_type !== "grid") throw new Error("目标视图不是表格视图");
  return response.data.view;
}
function metric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
const fieldsBefore = await readFields();
const rowsBefore = await readRecords();
const viewBefore = await readView();
const old = fieldsBefore.find((field) => field.field_id === oldFieldId);
const inserted = fieldsBefore.find((field) => field.field_id === newFieldId);
const names = fieldsBefore.map((field) => field.field_name);
const kIndex = names.indexOf("视频曝光K");
if (!old || !inserted || kIndex < 0 || fieldsBefore[kIndex + 1]?.field_id !== newFieldId || names[kIndex + 2] !== "售出数量") {
  throw new Error("正式字段位置或ID变化，拒绝迁移");
}
if (old.field_name !== "点击率" || old.type !== 2 || old.property?.formatter !== "0.00%") throw new Error("原点击率字段口径变化");
if (inserted.field_name !== "文本 10" || inserted.type !== 1) throw new Error("新插入列不是预期空文本列");
const copy = rowsBefore.map((row) => ({ recordId: row.record_id, value: metric(row.fields?.[old.field_name]) }))
  .filter((item): item is { recordId: string; value: number } => item.value !== null);
if (copy.some((item) => item.value < 0 || item.value > 1)) throw new Error("点击率超出0至1");
if (rowsBefore.some((row) => metric(row.fields?.[inserted.field_name]) !== null)) throw new Error("新插入列已有人工值");
const report = { at: new Date().toISOString(), rowCount: rowsBefore.length, copyCount: copy.length,
  oldFieldId, newFieldId, beforeOrder: names.slice(kIndex, kIndex + 3), viewHiddenFields: viewBefore.property?.hidden_fields ?? [] };
if (!APPLY) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
const artifactDir = path.resolve(".runtime/storeone-online-click-rate");
await mkdir(artifactDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(path.join(artifactDir, `${stamp}-position-before.json`), JSON.stringify({ fields: fieldsBefore, records: rowsBefore, view: viewBefore, report }, null, 2));

const converted = await client.bitable.appTableField.update({ path: { ...pathIds, field_id: newFieldId },
  data: { field_name: "点击率（位置调整中）", type: 2, ui_type: "Number", property: { formatter: "0.00%" }, description: { text: sourceDateDescription } } });
assertFeishuResponse(converted, "转换新列为点击率百分比");
const convertedField = (await readFields()).find((field) => field.field_id === newFieldId);
if (convertedField?.type !== 2 || convertedField.property?.formatter !== "0.00%" || convertedField.field_name !== "点击率（位置调整中）") {
  throw new Error("新列类型转换回读失败");
}
for (let offset = 0; offset < copy.length; offset += 50) {
  const live = new Map((await readRecords()).map((row) => [row.record_id, row]));
  const changes = copy.slice(offset, offset + 50).map(({ recordId, value }) => {
    const row = live.get(recordId);
    if (!row || metric(row.fields?.[old.field_name]) !== value) throw new Error(`原率已变化 ${recordId}`);
    if (metric(row.fields?.[convertedField.field_name]) !== null) throw new Error(`新列并发录入 ${recordId}`);
    return { record_id: recordId, fields: { [convertedField.field_name]: value } };
  });
  const response = await client.bitable.appTableRecord.batchUpdate({ path: pathIds,
    params: { client_token: randomUUID() }, data: { records: changes } });
  assertFeishuResponse(response, `点击率列迁移 ${offset}`);
  if (response.data?.records?.length !== changes.length) throw new Error("迁移回执数不足");
}
const copiedRows = await readRecords();
const copied = new Map(copiedRows.map((row) => [row.record_id, row]));
for (const { recordId, value } of copy) {
  const row = copied.get(recordId);
  if (!row || metric(row.fields?.[old.field_name]) !== value || metric(row.fields?.[convertedField.field_name]) !== value) {
    throw new Error(`迁移值回读不符 ${recordId}`);
  }
}
const renamedOld = await client.bitable.appTableField.update({ path: { ...pathIds, field_id: oldFieldId },
  data: { field_name: backupName, type: 2, ui_type: "Number", property: { formatter: "0.00%" }, description: { text: sourceDateDescription } } });
assertFeishuResponse(renamedOld, "旧点击率列改为备份名");
const renamedNew = await client.bitable.appTableField.update({ path: { ...pathIds, field_id: newFieldId },
  data: { field_name: "点击率", type: 2, ui_type: "Number", property: { formatter: "0.00%" }, description: { text: sourceDateDescription } } });
assertFeishuResponse(renamedNew, "新位置列改为点击率");
const hidden = [...new Set([...(viewBefore.property?.hidden_fields ?? []), oldFieldId])];
const patched = await client.bitable.appTableView.patch({ path: { ...pathIds, view_id: viewId }, data: { property: { hidden_fields: hidden } } });
assertFeishuResponse(patched, "隐藏旧点击率备份列");
const fieldsAfter = await readFields();
const rowsAfter = await readRecords();
const viewAfter = await readView();
const finalNames = fieldsAfter.map((field) => field.field_name);
const finalK = finalNames.indexOf("视频曝光K");
const errors: string[] = [];
if (finalNames[finalK + 1] !== "点击率" || finalNames[finalK + 2] !== "售出数量") errors.push("字段顺序");
if (!viewAfter.property?.hidden_fields?.includes(oldFieldId)) errors.push("备份字段未隐藏");
if (rowsAfter.length !== rowsBefore.length) errors.push("总行数");
const afterById = new Map(rowsAfter.map((row) => [row.record_id, row]));
for (const before of rowsBefore) {
  const after = afterById.get(before.record_id);
  if (!after) { errors.push(`${before.record_id}:缺行`); continue; }
  const beforeProtected = { ...before.fields };
  const afterProtected = { ...after.fields };
  delete beforeProtected["点击率"];
  delete beforeProtected["文本 10"];
  delete afterProtected[backupName];
  delete afterProtected["点击率"];
  if (JSON.stringify(beforeProtected) !== JSON.stringify(afterProtected)) errors.push(`${before.record_id}:保护字段`);
  const expected = metric(before.fields?.点击率);
  if (metric(after.fields?.点击率) !== expected || metric(after.fields?.[backupName]) !== expected) errors.push(`${before.record_id}:率`);
}
const result = { ...report, afterOrder: finalNames.slice(finalK, finalK + 3), copied: copy.length,
  hiddenBackup: viewAfter.property?.hidden_fields?.includes(oldFieldId) ?? false, afterRowCount: rowsAfter.length, errors };
await writeFile(path.join(artifactDir, `${stamp}-position-after.json`), JSON.stringify({ fields: fieldsAfter, records: rowsAfter, view: viewAfter, result }, null, 2));
console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exitCode = 1;
