import { createHash } from "node:crypto";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import { DuplicateCellFlagService, duplicateTargetsForProfile } from "../feishu/duplicate-cell-flags.js";

type RecordItem = { record_id?: string; fields?: Record<string, unknown> };

const apply = process.argv.includes("--apply");
const registry = new TenantRegistry(getEnv());

for (const tenant of registry.all()) {
  const client = createFeishuClient(tenant.env) as any;
  const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
  const tablesResponse = await client.bitable.appTable.list({
    path: { app_token: appToken },
    params: { page_size: 100 },
  });
  assertFeishuResponse(tablesResponse, `${tenant.binding.id} 读取表清单`);
  const tableByName = new Map<string, string>(
    (tablesResponse.data?.items ?? []).map((item: any) => [String(item.name ?? ""), String(item.table_id ?? "")]),
  );
  const targetsByTable = new Map<string, Set<string>>();
  for (const target of duplicateTargetsForProfile(tenant.profile)) {
    const flags = targetsByTable.get(target.tableName) ?? new Set<string>();
    flags.add(target.flagFieldName);
    targetsByTable.set(target.tableName, flags);
  }
  const beforeBusiness = new Map<string, string>();
  const changes: Array<{ tableName: string; tableId: string; fieldId: string; fieldName: string }> = [];

  for (const [tableName, flagNames] of targetsByTable) {
    const tableId = tableByName.get(tableName);
    if (!tableId) throw new Error(`${tenant.binding.id} 未找到 ${tableName}`);
    const fieldResponse = await client.bitable.appTableField.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100 },
    });
    assertFeishuResponse(fieldResponse, `${tenant.binding.id} 读取 ${tableName} 字段`);
    const fields = fieldResponse.data?.items ?? [];
    const businessNames = fields
      .map((field: any) => String(field.field_name ?? ""))
      .filter((name: string) => name && !name.startsWith("__重复_"));
    const records = await listRecords(client, appToken, tableId, businessNames);
    for (const record of records) {
      const recordId = String(record.record_id ?? "");
      beforeBusiness.set(`${tableId}:${recordId}`, digest(select(record.fields ?? {}, businessNames)));
    }
    for (const flagName of flagNames) {
      const field = fields.find((item: any) => String(item.field_name ?? "") === flagName);
      if (!field?.field_id) throw new Error(`${tenant.binding.id} ${tableName} 缺少 ${flagName}`);
      if (Number(field.type) !== 1 || String(field.ui_type ?? "") !== "Text") {
        changes.push({ tableName, tableId, fieldId: String(field.field_id), fieldName: flagName });
      }
    }
  }

  console.log(JSON.stringify({
    tenant: tenant.binding.id,
    mode: apply ? "apply" : "dry-run",
    convertInternalFlags: changes.map(({ tableName, fieldName }) => `${tableName}.${fieldName}`),
    protectedBusinessRecords: beforeBusiness.size,
  }));
  if (!apply) continue;

  for (const change of changes) {
    const response = await client.bitable.appTableField.update({
      path: { app_token: appToken, table_id: change.tableId, field_id: change.fieldId },
      data: { field_name: change.fieldName, type: 1, ui_type: "Text" },
    });
    assertFeishuResponse(response, `${tenant.binding.id} 转换 ${change.tableName}.${change.fieldName}`);
  }
  const duplicateService = new DuplicateCellFlagService(
    tenant.env,
    client,
    duplicateTargetsForProfile(tenant.profile),
  );
  const duplicateSummary = await duplicateService.start();

  for (const [tableName] of targetsByTable) {
    const tableId = tableByName.get(tableName)!;
    const fieldResponse = await client.bitable.appTableField.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100 },
    });
    assertFeishuResponse(fieldResponse, `${tenant.binding.id} 回读 ${tableName} 字段`);
    const fields = fieldResponse.data?.items ?? [];
    const businessNames = fields
      .map((field: any) => String(field.field_name ?? ""))
      .filter((name: string) => name && !name.startsWith("__重复_"));
    const records = await listRecords(client, appToken, tableId, businessNames);
    for (const record of records) {
      const recordId = String(record.record_id ?? "");
      const key = `${tableId}:${recordId}`;
      if (digest(select(record.fields ?? {}, businessNames)) !== beforeBusiness.get(key)) {
        throw new Error(`${tenant.binding.id} 业务数据保护校验失败：${tableName}/${recordId}`);
      }
    }
  }
  console.log(JSON.stringify({
    tenant: tenant.binding.id,
    applied: true,
    converted: changes.length,
    protectedBusinessRecords: beforeBusiness.size,
    duplicateSummary,
    businessDataUnchanged: true,
  }));
}

async function listRecords(
  client: any,
  appToken: string,
  tableId: string,
  fieldNames: string[],
): Promise<RecordItem[]> {
  const items: RecordItem[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 500, page_token: pageToken, field_names: JSON.stringify(fieldNames) },
    });
    assertFeishuResponse(response, `读取 ${tableId} 业务记录`);
    items.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return items;
}

function select(fields: Record<string, unknown>, names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.map((name) => [name, fields[name]]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
