import { getEnv } from "../config/env.js";
import { TenantRegistry, type ResolvedTenant } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

type Field = {
  field_id?: string;
  field_name?: string;
  type?: number;
  ui_type?: string;
  property?: { formula_expression?: string; formatter?: string };
};

type RecordItem = { record_id?: string; fields?: Record<string, unknown> };

const requestedTenantIds = argumentValues("--tenant");
const registry = new TenantRegistry(getEnv());
const tenants = requestedTenantIds.length
  ? requestedTenantIds.map((id) => requireTenant(registry, id))
  : registry.all();

for (const tenant of tenants) {
  console.log(JSON.stringify(await auditTenant(tenant), null, 2));
}

async function auditTenant(tenant: ResolvedTenant) {
  const client = createFeishuClient(tenant.env) as any;
  const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
  const tables = await listAll(async (pageToken) => {
    const response: any = await retry(() => client.bitable.appTable.list({
      path: { app_token: appToken },
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    }));
    assertFeishuResponse(response, `${tenant.binding.id} 读取表清单`);
    return response;
  });

  const cooperation = requireTable(tables, tenant.profile.tables.cooperation);
  const online = requireTable(tables, tenant.profile.tables.online);
  const [cooperationFields, onlineFields, cooperationRecords, onlineRecords] = await Promise.all([
    listFields(client, appToken, cooperation.table_id),
    listFields(client, appToken, online.table_id),
    listRecords(client, appToken, cooperation.table_id),
    listRecords(client, appToken, online.table_id),
  ]);

  const cooperationByHandle = new Map<string, RecordItem[]>();
  for (const record of cooperationRecords) {
    const handle = normalizeHandle(cellText(record.fields?.["红人姓名"]));
    if (!handle) continue;
    const rows = cooperationByHandle.get(handle) ?? [];
    rows.push(record);
    cooperationByHandle.set(handle, rows);
  }

  const linkedRows = onlineRecords.map((record) => {
    const fields = record.fields ?? {};
    const onlineHandleRaw = rawCellText(fields["达人姓名"]);
    const handle = normalizeHandle(onlineHandleRaw);
    const matches = cooperationByHandle.get(handle) ?? [];
    return {
      onlineRecordId: String(record.record_id ?? ""),
      handle,
      onlineHandleRaw,
      onlineDate: fields["实上线日期(Ct)"],
      product: compactValue(fields["挂车产品"]),
      actual: {
        cooperationDate: findValueByName(fields, /合作时间/),
        followersK: fields["粉丝量(K)"],
        remark: fields["备注"],
        developer: fields["开发人"],
      },
      cooperationMatches: matches.map((match) => ({
        cooperationRecordId: String(match.record_id ?? ""),
        cooperationHandleRaw: rawCellText(match.fields?.["红人姓名"]),
        cooperationDate: match.fields?.["合作时间"],
        followersK: match.fields?.["粉丝数(K)"],
        remark: match.fields?.["备注"],
      })),
    };
  });

  const expectedMatches = linkedRows.filter((row) => row.handle && row.cooperationMatches.length > 0);
  const diagnostics = expectedMatches
    .filter((row) => isBlank(row.actual.cooperationDate) || isBlank(row.actual.followersK))
    .map((row) => ({
      onlineRecordId: row.onlineRecordId,
      normalizedHandle: row.handle,
      onlineHandleRaw: row.onlineHandleRaw,
      onlineHandleCodePoints: codePoints(row.onlineHandleRaw),
      actualCooperationDate: compactValue(row.actual.cooperationDate),
      actualFollowersK: compactValue(row.actual.followersK),
      matches: row.cooperationMatches.map((match) => ({
        cooperationRecordId: match.cooperationRecordId,
        cooperationHandleRaw: match.cooperationHandleRaw,
        cooperationHandleCodePoints: codePoints(match.cooperationHandleRaw),
        cooperationDate: compactValue(match.cooperationDate),
        followersK: compactValue(match.followersK),
      })),
    }));

  const fieldPattern = /达人姓名|红人姓名|合作时间|粉丝|备注|开发人/;
  const onlineFormulaText = onlineFields
    .map((field) => String(field.property?.formula_expression ?? ""))
    .join("\n");
  return {
    checkedAt: new Date().toISOString(),
    tenantId: tenant.binding.id,
    shop: tenant.profile.businessDisplayName,
    tableIds: { cooperation: cooperation.table_id, online: online.table_id },
    recordCounts: { cooperation: cooperationRecords.length, online: onlineRecords.length },
    relevantFields: {
      cooperation: cooperationFields.filter((field) => fieldPattern.test(String(field.field_name ?? ""))).map(summarizeField),
      online: onlineFields.filter((field) => fieldPattern.test(String(field.field_name ?? ""))).map(summarizeField),
    },
    cooperationFieldsReferencedByOnlineFormulas: cooperationFields
      .filter((field) => onlineFormulaText.includes(String(field.field_id ?? "__missing__")))
      .map(summarizeField),
    linkageSummary: {
      onlineRowsWithHandle: linkedRows.filter((row) => row.handle).length,
      onlineRowsWithCooperationMatch: expectedMatches.length,
      matchedRowsMissingCooperationDate: expectedMatches.filter((row) => isBlank(row.actual.cooperationDate)).length,
      matchedRowsMissingFollowersK: expectedMatches.filter((row) => isBlank(row.actual.followersK)).length,
      onlineRowsWithMultipleCooperationMatches: linkedRows.filter((row) => row.cooperationMatches.length > 1).length,
    },
    onlineDateRows: linkedRows.map((row) => ({
      onlineRecordId: row.onlineRecordId,
      handle: row.handle,
      product: row.product,
      onlineDate: compactValue(row.onlineDate),
    })),
    diagnostics,
  };
}

function summarizeField(field: Field) {
  return {
    name: String(field.field_name ?? ""),
    fieldId: String(field.field_id ?? ""),
    type: field.type ?? null,
    uiType: field.ui_type ?? null,
    formatter: field.property?.formatter ?? null,
    formula: field.property?.formula_expression ?? null,
  };
}

async function listFields(client: any, appToken: string, tableId: string): Promise<Field[]> {
  return listAll(async (pageToken) => {
    const response: any = await retry(() => client.bitable.appTableField.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    }));
    assertFeishuResponse(response, `读取字段 ${tableId}`);
    return response;
  });
}

async function listRecords(client: any, appToken: string, tableId: string): Promise<RecordItem[]> {
  return listAll(async (pageToken) => {
    const response: any = await retry(() => client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 500, automatic_fields: true, ...(pageToken ? { page_token: pageToken } : {}) },
    }));
    assertFeishuResponse(response, `读取记录 ${tableId}`);
    return response;
  });
}

async function listAll(fetchPage: (pageToken?: string) => Promise<any>): Promise<any[]> {
  const items: any[] = [];
  let pageToken: string | undefined;
  do {
    const response = await fetchPage(pageToken);
    items.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return items;
}

function requireTable(tables: any[], name: string): { table_id: string; name: string } {
  const matches = tables.filter((table) => table.name === name && table.table_id);
  if (matches.length !== 1) throw new Error(`应恰好有一张“${name}”，实际 ${matches.length} 张`);
  return { table_id: String(matches[0].table_id), name: String(matches[0].name) };
}

function requireTenant(registry: TenantRegistry, id: string): ResolvedTenant {
  const tenant = registry.byId(id);
  if (!tenant) throw new Error(`租户不存在或未启用：${id}`);
  return tenant;
}

function argumentValues(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

function normalizeHandle(value: string): string {
  return value
    .normalize("NFKC")
    .replaceAll("\u2063", "")
    .replace(/^@+/, "")
    .replace(/\s+/g, "")
    .toLocaleLowerCase("en-US");
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    return cellText(item.text ?? item.name ?? item.value ?? item.link ?? item.url ?? "");
  }
  return String(value).trim();
}

function rawCellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(rawCellText).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    return rawCellText(item.text ?? item.name ?? item.value ?? item.link ?? item.url ?? "");
  }
  return String(value);
}

function findValueByName(fields: Record<string, unknown>, pattern: RegExp): unknown {
  const key = Object.keys(fields).find((name) => pattern.test(name));
  return key ? fields[key] : undefined;
}

function compactValue(value: unknown): unknown {
  if (value == null || value === "") return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return cellText(value) || value;
}

function isBlank(value: unknown): boolean {
  return value == null || value === "" || (Array.isArray(value) && value.length === 0);
}

function codePoints(value: string): string[] {
  return [...value].map((character) => `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`);
}

async function retry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const payload = (error as { response?: { data?: unknown; status?: number } })?.response;
      const diagnostic = `${message} ${JSON.stringify(payload?.data ?? "")} ${payload?.status ?? ""}`;
      if (!/1254607|429|5\d\d|Data not ready|ECONNRESET|socket hang up|ETIMEDOUT/i.test(diagnostic) || attempt === 5) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw lastError;
}
