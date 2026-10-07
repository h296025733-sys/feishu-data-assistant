import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import {
  ACCOUNT_SIDE_TABLES,
  listFields,
  listRecords,
  listTables,
} from "../feishu/account-side-test.js";
import { assertFeishuResponse, createFeishuClient, withFeishuRetry } from "../feishu/client.js";

const PROJECT_ROOT = String.raw`D:\workspace\feishu-data-assistant-poc`;
const TENANT_ID = "storetwo-botanical-care-formal";
const TABLE_NAME = "产品投产比";
const FIELD_NAME = "日期";
const CONFIRMATION = "REPAIR-STORETWO-BOTANICAL-PRODUCT-ROI-DATE-20260901";
const args = process.argv.slice(2).filter((value) => value !== "--");
const apply = args.includes("--apply");

const registry = new TenantRegistry(getEnv());
const tenant = registry.byId(TENANT_ID);
if (!tenant) throw new Error(`${TENANT_ID}不存在`);
if (tenant.profile.businessDisplayName !== "Storetwo Botanical Care") {
  throw new Error(`目标店铺身份不一致：${tenant.profile.businessDisplayName}`);
}
if (apply) {
  const confirmation = argument("--confirm");
  if (confirmation !== CONFIRMATION) throw new Error(`正式修复必须提供 --confirm ${CONFIRMATION}`);
  await assertEveryDailyJobIdle(registry);
}

const client = createFeishuClient(tenant.env);
const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
const tables = await listTables(client, appToken);
const tableMatches = tables.filter((item) => item.name === TABLE_NAME);
if (tableMatches.length !== 1) throw new Error(`${TABLE_NAME}数量=${tableMatches.length}`);
const table = tableMatches[0]!;
const [fields, records] = await Promise.all([
  listFields(client, appToken, table.tableId),
  listRecords(client, appToken, table.tableId),
]);
const fieldMatches = fields.filter((item) => item.fieldName === FIELD_NAME);
if (fieldMatches.length !== 1) throw new Error(`${TABLE_NAME}.${FIELD_NAME}字段数量=${fieldMatches.length}`);
const dateField = fieldMatches[0]!;
if (![1, 5].includes(dateField.type)) throw new Error(`${TABLE_NAME}.${FIELD_NAME}类型${dateField.type}不可安全迁移`);

const expectedDates = new Map<string, string>();
const keys = new Set<string>();
for (const record of records) {
  const key = textValue(record.fields.检查);
  if (!key) {
    if (Object.values(record.fields).some(meaningful)) throw new Error(`${record.recordId}有内容但缺少检查业务键`);
    continue;
  }
  if (keys.has(key)) throw new Error(`${TABLE_NAME}存在重复业务键：${key}`);
  keys.add(key);
  const expectedDate = key.match(/\|(\d{4}-\d{2}-\d{2})$/)?.[1];
  if (!expectedDate) throw new Error(`${record.recordId}业务键日期无效：${key}`);
  const currentDate = semanticDate(record.fields.日期, tenant.profile.businessTimeZone);
  if (currentDate && currentDate !== expectedDate) {
    throw new Error(`${record.recordId}日期与业务键冲突：${currentDate} != ${expectedDate}`);
  }
  expectedDates.set(record.recordId, expectedDate);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDirectory = path.join(PROJECT_ROOT, ".runtime", "fifth-store-account-date-repair", stamp);
const before = {
  capturedAt: new Date().toISOString(),
  tenantId: TENANT_ID,
  store: tenant.profile.businessDisplayName,
  appToken,
  table,
  fields,
  records,
};
await writeJsonAtomic(path.join(runDirectory, "before.json"), before);

if (!apply) {
  const result = {
    action: "audit",
    evidence: "real-formal-feishu-api-read-only",
    runDirectory,
    tableId: table.tableId,
    dateFieldType: dateField.type,
    records: records.length,
    keyedRecords: expectedDates.size,
    duplicateKeys: 0,
    conflictingDates: 0,
  };
  await writeJsonAtomic(path.join(runDirectory, "result.json"), result);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

let fieldUpdated = false;
if (dateField.type !== 5) {
  const target = ACCOUNT_SIDE_TABLES
    .find((definition) => definition.name === TABLE_NAME)!
    .fields.find((definition) => definition.field_name === FIELD_NAME)!;
  const response = await withFeishuRetry(async () => {
    const current = await client.bitable.appTableField.update({
      path: { app_token: appToken, table_id: table.tableId, field_id: dateField.fieldId },
      data: target as never,
    });
    assertFeishuResponse(current, `修复${tenant.profile.businessDisplayName}${TABLE_NAME}.${FIELD_NAME}字段类型`);
    return current;
  });
  void response;
  fieldUpdated = true;
}

const latest = await listRecords(client, appToken, table.tableId);
const byId = new Map(latest.map((record) => [record.recordId, record]));
const updates = [...expectedDates].flatMap(([recordId, expectedDate]) => {
  const current = byId.get(recordId);
  if (!current) throw new Error(`字段转换后记录丢失：${recordId}`);
  const expectedTimestamp = dateTimestamp(expectedDate);
  return semanticDate(current.fields.日期, tenant.profile.businessTimeZone) === expectedDate
    && typeof current.fields.日期 === "number"
    ? []
    : [{ record_id: recordId, fields: { 日期: expectedTimestamp } }];
});
for (const batch of chunks(updates, 500)) {
  const token = randomUUID();
  const response = await withFeishuRetry(async () => {
    const current = await client.bitable.appTableRecord.batchUpdate({
      path: { app_token: appToken, table_id: table.tableId },
      params: { client_token: token },
      data: { records: batch as never },
    });
    assertFeishuResponse(current, `回填${tenant.profile.businessDisplayName}${TABLE_NAME}.${FIELD_NAME}`);
    return current;
  });
  if ((response.data?.records?.length ?? 0) !== batch.length) throw new Error("日期回填返回数量不一致");
}

const [afterFields, afterRecords] = await Promise.all([
  listFields(client, appToken, table.tableId),
  listRecords(client, appToken, table.tableId),
]);
const afterDateField = afterFields.find((item) => item.fieldName === FIELD_NAME);
if (afterDateField?.type !== 5) throw new Error(`写后回读日期字段类型仍为${afterDateField?.type ?? "缺失"}`);
if (afterRecords.length !== records.length) throw new Error(`记录数变化：${records.length} -> ${afterRecords.length}`);
const beforeById = new Map(records.map((record) => [record.recordId, record]));
for (const record of afterRecords) {
  const prior = beforeById.get(record.recordId);
  if (!prior) throw new Error(`出现计划外记录：${record.recordId}`);
  const expectedDate = expectedDates.get(record.recordId);
  if (expectedDate && semanticDate(record.fields.日期, tenant.profile.businessTimeZone) !== expectedDate) {
    throw new Error(`${record.recordId}日期写后回读不一致`);
  }
  if (stableFields(prior.fields, new Set([FIELD_NAME])) !== stableFields(record.fields, new Set([FIELD_NAME]))) {
    throw new Error(`${record.recordId}日期以外字段发生变化`);
  }
}

const after = { capturedAt: new Date().toISOString(), fields: afterFields, records: afterRecords };
await writeJsonAtomic(path.join(runDirectory, "after.json"), after);
const result = {
  action: "apply",
  evidence: "real-formal-feishu-write-plus-readback",
  completedAt: new Date().toISOString(),
  runDirectory,
  tableId: table.tableId,
  fieldUpdated,
  recordsUpdated: updates.length,
  recordsVerified: afterRecords.length,
  duplicateKeys: 0,
  nonDateFieldChanges: 0,
  ok: true,
};
await writeJsonAtomic(path.join(runDirectory, "result.json"), result);
console.log(JSON.stringify(result, null, 2));

async function assertEveryDailyJobIdle(values: TenantRegistry): Promise<void> {
  for (const item of values.all()) {
    const statusPath = path.join(PROJECT_ROOT, ".runtime", "tenants", item.binding.id, "daily-automation", "status.json");
    const status = JSON.parse(await readFile(statusPath, "utf8")) as { running?: boolean };
    if (status.running !== false) throw new Error(`${item.binding.id}日更仍在运行`);
  }
}

function semanticDate(value: unknown, timeZone: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(value));
  }
  const text = textValue(value);
  const match = /^(\d{4})[-/](\d{2})[-/](\d{2})/.exec(text);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

function dateTimestamp(date: string): number {
  const value = new Date(`${date}T00:00:00+08:00`).getTime();
  if (!Number.isFinite(value)) throw new Error(`日期无效：${date}`);
  return value;
}

function textValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(textValue).join("").trim();
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return textValue(object.text ?? object.name ?? object.value ?? object.content ?? "");
  }
  return String(value ?? "").trim();
}

function meaningful(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(meaningful);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some(meaningful);
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function stableFields(fields: Record<string, unknown>, ignored: Set<string>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(fields)
      .filter(([name]) => !ignored.has(name))
      .sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

function argument(name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] ?? "").trim() : "";
}
