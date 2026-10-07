import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import { ANALYSIS_FIELDS } from "../video-analysis/storeone-inventory.js";
import { videoAnalysisConfig, type VideoAnalysisTenantId } from "../video-analysis/storeone-source.js";

const tenantFlag = process.argv.indexOf("--tenant");
const selectedTenant = tenantFlag < 0 ? "storetwo-formal" : process.argv[tenantFlag + 1];
if (selectedTenant !== "storetwo-formal" && selectedTenant !== "storetwo-botanical-care-formal") {
  throw new Error("Schema migration supports Storetwo or Storetwo Botanical Care");
}
const tenantId: VideoAnalysisTenantId = selectedTenant;
const config = videoAnalysisConfig(tenantId);
const displayName = tenantId === "storetwo-formal" ? "Storetwo" : "Storetwo Botanical Care";
const apply = process.argv.includes("--apply");
const confirmation = tenantId === "storetwo-formal" ? "--confirm=STORETWO-VIDEO-ANALYSIS-FIELDS"
  : "--confirm=STORETWO-BOTANICAL-CARE-VIDEO-ANALYSIS-FIELDS";
if (apply && !process.argv.includes(confirmation)) {
  throw new Error(`Apply requires ${confirmation}`);
}
const tenant = new TenantRegistry(getEnv()).byId(tenantId);
if (!tenant || tenant.env.FEISHU_BITABLE_APP_TOKEN !== config.appToken) {
  throw new Error(`${displayName} formal binding changed`);
}
const client = createFeishuClient(tenant.env);
const targetIds = Object.values(config.tables);
const fieldSpecs = [
  { field_name: "视频内容分析", type: 1, ui_type: "Text" },
  { field_name: "投广建议", type: 3, ui_type: "SingleSelect", property: { options: [
    { name: "推荐投广", color: 2 }, { name: "待选投广", color: 1 },
    { name: "不建议投广", color: 0 },
  ] } },
  { field_name: "视频修改建议", type: 1, ui_type: "Text" },
] as const;

async function readFields(tableId: string) {
  const fields = [];
  let token: string | undefined;
  do {
    const response = await client.bitable.appTableField.list({
      path: { app_token: config.appToken, table_id: tableId },
      params: { page_size: 100, page_token: token },
    });
    assertFeishuResponse(response, `Read Storetwo fields ${tableId}`);
    fields.push(...response.data?.items ?? []);
    token = response.data?.has_more ? response.data.page_token : undefined;
  } while (token);
  return fields;
}

async function readRecords(tableId: string) {
  const records = [];
  let token: string | undefined;
  do {
    const response = await client.bitable.appTableRecord.list({
      path: { app_token: config.appToken, table_id: tableId },
      params: { page_size: 500, page_token: token },
    });
    assertFeishuResponse(response, `Read Storetwo records ${tableId}`);
    records.push(...response.data?.items ?? []);
    token = response.data?.has_more ? response.data.page_token : undefined;
  } while (token);
  return records;
}

const before = await Promise.all(targetIds.map(async (tableId) => ({
  tableId, fields: await readFields(tableId), records: await readRecords(tableId),
})));
for (const table of before) {
  const names = new Set(table.fields.map((field) => field.field_name));
  const present = ANALYSIS_FIELDS.filter((name) => names.has(name));
  if (present.length !== 0 && present.length !== ANALYSIS_FIELDS.length) {
    throw new Error(`${table.tableId} partial analysis schema, review before apply`);
  }
  for (const spec of fieldSpecs) {
    const current = table.fields.find((field) => field.field_name === spec.field_name);
    if (current && (current.type !== spec.type || current.ui_type !== spec.ui_type)) {
      throw new Error(`${table.tableId} field type mismatch: ${spec.field_name}`);
    }
  }
  if (table.records.some((row) => ANALYSIS_FIELDS.some((name) =>
    row.fields?.[name] !== undefined && row.fields?.[name] !== null && row.fields?.[name] !== ""))) {
    throw new Error(`${table.tableId} existing analysis values need review`);
  }
}
const backupDir = path.resolve(`.runtime/video-analysis-schema/${tenantId}`);
if (apply) {
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, `before-${Date.now()}.json`), JSON.stringify(before, null, 2));
  for (const table of before) {
    const names = new Set(table.fields.map((field) => field.field_name));
    for (const spec of fieldSpecs) {
      if (names.has(spec.field_name)) continue;
      const response = await client.bitable.appTableField.create({
        path: { app_token: config.appToken, table_id: table.tableId },
        data: spec as never,
      });
      assertFeishuResponse(response, `Create Storetwo ${spec.field_name}`);
      names.add(spec.field_name);
    }
  }
}
const after = await Promise.all(targetIds.map(async (tableId) => ({
  tableId, fields: await readFields(tableId), records: await readRecords(tableId),
})));
const checks = before.map((original, index) => {
  const current = after[index]!;
  const oldFields = Object.fromEntries(original.fields.map((field) => [field.field_name, field]));
  const oldRecords = new Map(original.records.map((row) => [row.record_id, row]));
  const recordsUnchanged = current.records.length === original.records.length
    && current.records.every((row) => {
      const old = oldRecords.get(row.record_id);
      return old && Object.keys(old.fields ?? {}).every((name) =>
        JSON.stringify(old.fields?.[name]) === JSON.stringify(row.fields?.[name]));
    });
  const oldSchemaUnchanged = original.fields.every((field) => {
    const now = current.fields.find((item) => item.field_name === field.field_name);
    return now?.field_id === oldFields[field.field_name]?.field_id && now?.type === field.type;
  });
  const targetFields = fieldSpecs.map((spec) => {
    const now = current.fields.find((item) => item.field_name === spec.field_name);
    return { name: spec.field_name, id: now?.field_id, type: now?.type, uiType: now?.ui_type,
      options: spec.field_name === "投广建议" ? now?.property?.options?.map((item) => item.name) : undefined };
  });
  const targetValid = targetFields.every((field, position) => field.id
    && field.type === fieldSpecs[position]?.type && field.uiType === fieldSpecs[position]?.ui_type)
    && JSON.stringify(targetFields[1]?.options) === JSON.stringify(["推荐投广", "待选投广", "不建议投广"]);
  return { tableId: original.tableId, recordCount: current.records.length,
    recordsUnchanged: Boolean(recordsUnchanged), oldSchemaUnchanged,
    targetValid, targetFields };
});
const report = { at: new Date().toISOString(), mode: apply ? "formal-apply-readback" : "formal-read-only",
  tenantId, checks,
  ok: checks.every((check) => check.recordsUnchanged && check.oldSchemaUnchanged && (!apply || check.targetValid)) };
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
