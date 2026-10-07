import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { TenantRegistry, type ResolvedTenant } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

const apply = process.argv.includes("--apply");
const registry = new TenantRegistry(getEnv());
const runId = new Date().toISOString().replaceAll(":", "-");
const backupRoot = path.resolve("backups", `order-attribution-roi-${runId}`);

const PRODUCT_FIELDS = [
  "联盟达人视频出单量", "联盟达人视频出单数量",
  "联盟达人直播出单量", "联盟达人直播出单数量",
  "自营达人视频出单量", "自营达人视频出单数量",
  "自营达人直播出单量", "自营达人直播出单数量",
] as const;

const STORE_FIELDS = [
  "店铺联盟达人视频出单量", "店铺联盟达人视频出单数量",
  "店铺联盟达人直播出单量", "店铺联盟达人直播出单数量",
  "店铺自营达人视频出单量", "店铺自营达人视频出单数量",
  "店铺自营达人直播出单量", "店铺自营达人直播出单数量",
  "店铺商品卡出单量(API)", "店铺商品卡出单数量",
] as const;

type Field = {
  field_id?: string;
  field_name?: string;
  type?: number;
  property?: { formula_expression?: string; formatter?: string };
};
type RecordItem = { record_id?: string; fields?: Record<string, unknown> };

for (const tenant of registry.all()) await migrateTenant(tenant);

async function migrateTenant(tenant: ResolvedTenant): Promise<void> {
  const client = createFeishuClient(tenant.env) as any;
  const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
  const tables = await listAll((pageToken) => client.bitable.appTable.list({
    path: { app_token: appToken },
    params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
  }), `${tenant.binding.id} 读取表清单`);
  const matches = tables.filter((table) => table.name === tenant.profile.tables.roi && table.table_id);
  if (matches.length !== 1) throw new Error(`${tenant.binding.id} 投产比表数量=${matches.length}`);
  const tableId = String(matches[0].table_id);
  const beforeFields = await listFields(client, appToken, tableId);
  const beforeRecords = await listRecords(client, appToken, tableId);
  const beforeNames = beforeFields.map((field) => String(field.field_name ?? "")).filter(Boolean).sort();
  const beforeHash = recordHash(beforeRecords, beforeNames);
  const migrationFieldNames = new Set<string>([...PRODUCT_FIELDS, ...STORE_FIELDS]);
  const protectedLegacyNames = beforeNames.filter((name) => !migrationFieldNames.has(name));
  const protectedLegacyHash = recordHash(beforeRecords, protectedLegacyNames);
  const byName = new Map(beforeFields.map((field) => [String(field.field_name ?? ""), field]));
  for (const required of ["商品", "日期", "商品卡出单量", "商品卡出单数量"]) {
    if (!byName.get(required)?.field_id) throw new Error(`${tenant.binding.id} 缺少字段“${required}”`);
  }
  const missingProductFields = PRODUCT_FIELDS.filter((name) => !byName.has(name));
  const missingStoreFields = STORE_FIELDS.filter((name) => !byName.has(name));
  const wrongTypes = [...PRODUCT_FIELDS, ...STORE_FIELDS]
    .filter((name) => byName.has(name) && Number(byName.get(name)?.type) !== 2);
  if (wrongTypes.length) throw new Error(`${tenant.binding.id} 同名字段类型不符：${wrongTypes.join("、")}`);
  const plan = {
    tenant: tenant.binding.id,
    mode: apply ? "apply" : "dry-run",
    tableId,
    addNumberFields: missingProductFields,
    addStoreNumberFields: missingStoreFields,
    protectedExistingRecords: beforeRecords.length,
    protectedExistingFields: beforeNames.length,
    protectedDataSha256: beforeHash,
    protectedLegacyDataSha256: protectedLegacyHash,
  };
  if (!apply) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  mkdirSync(backupRoot, { recursive: true });
  writeFileSync(
    path.join(backupRoot, `${tenant.binding.id}.before.json`),
    `${JSON.stringify({ plan, fields: beforeFields, records: beforeRecords }, null, 2)}\n`,
    "utf8",
  );
  for (const fieldName of [...missingProductFields, ...missingStoreFields]) {
    const response = await client.bitable.appTableField.create({
      path: { app_token: appToken, table_id: tableId },
      data: { field_name: fieldName, type: 2, ui_type: "Number", property: { formatter: "0" } },
    });
    assertFeishuResponse(response, `${tenant.binding.id} 创建字段“${fieldName}”`);
  }

  const afterFields = await listFields(client, appToken, tableId);
  const afterRecords = await listRecords(client, appToken, tableId);
  const afterHash = recordHash(afterRecords, beforeNames);
  const afterLegacyHash = recordHash(afterRecords, protectedLegacyNames);
  if (afterHash !== beforeHash) throw new Error(`${tenant.binding.id} 迁移改变了既有字段数据`);
  if (afterLegacyHash !== protectedLegacyHash) throw new Error(`${tenant.binding.id} 迁移改变了迁移前业务字段数据`);
  const afterByName = new Map(afterFields.map((field) => [String(field.field_name ?? ""), field]));
  for (const name of [...PRODUCT_FIELDS, ...STORE_FIELDS]) {
    if (!afterByName.has(name)) throw new Error(`${tenant.binding.id} 写后缺少字段“${name}”`);
  }
  const result = {
    ...plan,
    verified: true,
    protectedExistingDataUnchanged: true,
    afterDataSha256: afterHash,
    afterLegacyDataSha256: afterLegacyHash,
  };
  writeFileSync(path.join(backupRoot, `${tenant.binding.id}.after.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
}

async function listFields(client: any, appToken: string, tableId: string): Promise<Field[]> {
  return listAll((pageToken) => client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
  }), "读取字段");
}

async function listRecords(client: any, appToken: string, tableId: string): Promise<RecordItem[]> {
  return listAll((pageToken) => client.bitable.appTableRecord.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: 500, automatic_fields: false, ...(pageToken ? { page_token: pageToken } : {}) },
  }), "读取记录");
}

async function listAll(fetchPage: (pageToken?: string) => Promise<any>, label: string): Promise<any[]> {
  const items: any[] = [];
  let pageToken: string | undefined;
  do {
    const response = await withDataReadyRetry(() => fetchPage(pageToken), label);
    assertFeishuResponse(response, label);
    items.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return items;
}

async function withDataReadyRetry<T>(action: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      const code = Number((error as any)?.response?.data?.code ?? (error as any)?.data?.code);
      if (code !== 1254607 || attempt === 6) throw error;
      console.warn(`${label}：飞书表结构正在刷新，第 ${attempt} 次等待后重试`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  throw lastError;
}

function recordHash(records: RecordItem[], fieldNames: string[]): string {
  const selected = records
    .map((record) => ({
      recordId: String(record.record_id ?? ""),
      fields: Object.fromEntries(fieldNames.map((name) => [name, record.fields?.[name] ?? null])),
    }))
    .sort((left, right) => left.recordId.localeCompare(right.recordId));
  return createHash("sha256").update(stable(selected)).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
