import { readFileSync } from "node:fs";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

const tenantId = argument("--tenant");
const beforePath = argument("--before");
const restoreKeys = process.argv.includes("--restore-keys");
const registry = new TenantRegistry(getEnv());
const tenant = registry.byId(tenantId);
if (!tenant) throw new Error(`店铺租户不存在或未启用：${tenantId}`);
const snapshot = JSON.parse(readFileSync(beforePath, "utf8")) as {
  fields: Array<{ field_name?: string }>;
  records: Array<{ record_id?: string; fields?: Record<string, unknown> }>;
};
const protectedFields = snapshot.fields.map((field) => String(field.field_name ?? "")).filter(Boolean);
const client = createFeishuClient(tenant.env) as any;
const tables = await listAll((pageToken) => client.bitable.appTable.list({
  path: { app_token: tenant.env.FEISHU_BITABLE_APP_TOKEN },
  params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
}), "读取表清单");
const tableIds = tables.filter((table) => table.name === tenant.profile.tables.roi).map((table) => table.table_id);
if (tableIds.length !== 1) throw new Error(`${tenantId} 投产比表数量=${tableIds.length}`);
const currentRecords = await listAll((pageToken) => client.bitable.appTableRecord.list({
  path: { app_token: tenant.env.FEISHU_BITABLE_APP_TOKEN, table_id: String(tableIds[0]) },
  params: { page_size: 500, automatic_fields: false, ...(pageToken ? { page_token: pageToken } : {}) },
}), "读取当前记录");
const currentById = new Map(currentRecords.map((record) => [String(record.record_id ?? ""), record]));
const differences: Array<{ recordId: string; field: string; before: unknown; after: unknown }> = [];
const missingRecordIds: string[] = [];
for (const before of snapshot.records) {
  const recordId = String(before.record_id ?? "");
  const current = currentById.get(recordId);
  if (!current) {
    missingRecordIds.push(recordId);
    continue;
  }
  for (const field of protectedFields) {
    const oldValue = before.fields?.[field] ?? null;
    const newValue = current.fields?.[field] ?? null;
    if (stable(oldValue) !== stable(newValue)) {
      differences.push({ recordId, field, before: oldValue, after: newValue });
    }
  }
}
if (restoreKeys && differences.length > 0) {
  const unsafe = differences.filter((difference) => difference.field !== "商品" && difference.field !== "日期");
  if (unsafe.length > 0) {
    throw new Error(`发现非键字段差异，拒绝自动恢复：${unsafe.map((item) => `${item.recordId}.${item.field}`).join("、")}`);
  }
  const byRecord = new Map<string, Record<string, unknown>>();
  for (const difference of differences) {
    const fields = byRecord.get(difference.recordId) ?? {};
    fields[difference.field] = difference.before;
    byRecord.set(difference.recordId, fields);
  }
  for (const [recordId, fields] of byRecord) {
    const response = await withDataReadyRetry<any>(() => client.bitable.appTableRecord.update({
      path: {
        app_token: tenant.env.FEISHU_BITABLE_APP_TOKEN,
        table_id: String(tableIds[0]),
        record_id: recordId,
      },
      data: { fields },
    }), `恢复既有记录键 ${recordId}`);
    assertFeishuResponse(response, `恢复既有记录键 ${recordId}`);
  }
  console.log(JSON.stringify({ tenant: tenantId, restoredKeys: [...byRecord.keys()] }, null, 2));
  process.exit(0);
}
console.log(JSON.stringify({
  tenant: tenantId,
  protectedOriginalRecords: snapshot.records.length,
  protectedOriginalFields: protectedFields.length,
  missingRecordIds,
  differences,
  unchanged: missingRecordIds.length === 0 && differences.length === 0,
  newRecordCount: currentRecords.length - snapshot.records.length,
}, null, 2));
if (missingRecordIds.length > 0 || differences.length > 0) process.exitCode = 1;

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
      console.warn(`${label}：飞书数据刷新中，第 ${attempt} 次等待后重试`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  throw lastError;
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

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
  if (!value) throw new Error(`缺少参数 ${name}`);
  return value;
}
