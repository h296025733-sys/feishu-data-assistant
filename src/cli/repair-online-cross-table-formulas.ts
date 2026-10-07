import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { TenantRegistry, type ResolvedTenant } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import {
  buildOnlineCooperationLookupFormula,
} from "../feishu/handle-formula.js";
import { buildOnlineDeveloperFormula } from "../feishu/online-developer-formula.js";

type Field = {
  field_id?: string;
  field_name?: string;
  type?: number;
  ui_type?: string;
  property?: { formula_expression?: string; formatter?: string };
};

type RecordItem = { record_id?: string; fields?: Record<string, unknown> };

type FormulaTarget = {
  field: Field;
  expression: string;
  purpose: "cooperationDate" | "followers" | "remark" | "developer";
};

const apply = process.argv.includes("--apply");
const requestedTenantIds = argumentValues("--tenant");
const registry = new TenantRegistry(getEnv());
const tenants = requestedTenantIds.length
  ? requestedTenantIds.map((id) => requireTenant(registry, id))
  : registry.all();

const reports: unknown[] = [];
for (const tenant of tenants) reports.push(await repairTenant(tenant));
console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", reports }, null, 2));

async function repairTenant(tenant: ResolvedTenant) {
  const client = createFeishuClient(tenant.env) as any;
  const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
  const tables = await listTables(client, appToken, tenant.binding.id);
  const cooperation = requireTable(tables, tenant.profile.tables.cooperation);
  const development = requireTable(tables, tenant.profile.tables.development);
  const online = requireTable(tables, tenant.profile.tables.online);

  const [cooperationFields, developmentFields, onlineFields, cooperationRecords, developmentRecords, beforeOnlineRecords] = await Promise.all([
    listFields(client, appToken, cooperation.table_id),
    listFields(client, appToken, development.table_id),
    listFields(client, appToken, online.table_id),
    listRecords(client, appToken, cooperation.table_id),
    listRecords(client, appToken, development.table_id),
    listRecords(client, appToken, online.table_id),
  ]);

  const cooperationCreator = requireExactField(cooperationFields, "红人姓名", 1);
  const cooperationDate = requireExactField(cooperationFields, "合作时间", 5);
  const cooperationFollowers = requireExactField(cooperationFields, "粉丝数(K)", 2);
  const cooperationRemark = requireExactField(cooperationFields, "备注", 1);
  const developmentCreator = requireExactField(developmentFields, "红人姓名", 1);
  const developmentFinalOwner = requireExactField(developmentFields, "最终归属");
  const developmentSecondOwner = requireExactField(developmentFields, "开发人2");
  const developmentFirstOwner = requireExactField(developmentFields, "开发人1");
  const onlineCreator = requireExactField(onlineFields, "达人姓名", 1);
  const onlineCooperationDate = requireFormulaFieldByPattern(onlineFields, /^合作时间(?:\s|\(|（|$)/);
  const onlineFollowers = requireExactFormulaField(onlineFields, "粉丝量(K)");
  const onlineRemark = requireExactFormulaField(onlineFields, "备注");
  const onlineDeveloper = requireExactFormulaField(onlineFields, "开发人");

  const targets: FormulaTarget[] = [
    {
      field: onlineCooperationDate,
      purpose: "cooperationDate",
      expression: buildOnlineCooperationLookupFormula({
        cooperationTableId: cooperation.table_id,
        onlineTableId: online.table_id,
        cooperationCreatorFieldId: cooperationCreator.field_id!,
        cooperationValueFieldId: cooperationDate.field_id!,
        onlineCreatorFieldId: onlineCreator.field_id!,
      }),
    },
    {
      field: onlineFollowers,
      purpose: "followers",
      expression: buildOnlineCooperationLookupFormula({
        cooperationTableId: cooperation.table_id,
        onlineTableId: online.table_id,
        cooperationCreatorFieldId: cooperationCreator.field_id!,
        cooperationValueFieldId: cooperationFollowers.field_id!,
        onlineCreatorFieldId: onlineCreator.field_id!,
      }),
    },
    {
      field: onlineRemark,
      purpose: "remark",
      expression: buildOnlineCooperationLookupFormula({
        cooperationTableId: cooperation.table_id,
        onlineTableId: online.table_id,
        cooperationCreatorFieldId: cooperationCreator.field_id!,
        cooperationValueFieldId: cooperationRemark.field_id!,
        onlineCreatorFieldId: onlineCreator.field_id!,
      }),
    },
    {
      field: onlineDeveloper,
      purpose: "developer",
      expression: buildOnlineDeveloperFormula({
        developmentTableId: development.table_id,
        onlineTableId: online.table_id,
        developmentCreatorFieldId: developmentCreator.field_id!,
        developmentFinalOwnerFieldId: developmentFinalOwner.field_id!,
        developmentSecondOwnerFieldId: developmentSecondOwner.field_id!,
        developmentFirstOwnerFieldId: developmentFirstOwner.field_id!,
        onlineCreatorFieldId: onlineCreator.field_id!,
      }),
    },
  ];

  const manualFieldNames = new Set(
    onlineFields.filter((field) => field.type !== 20).map((field) => String(field.field_name ?? "")),
  );
  const manualBeforeHash = hashManualRecords(beforeOnlineRecords, manualFieldNames);
  const formulaBefore = Object.fromEntries(targets.map((target) => [
    target.purpose,
    {
      fieldId: target.field.field_id,
      fieldName: target.field.field_name,
      formatter: target.field.property?.formatter ?? "",
      expression: target.field.property?.formula_expression ?? "",
    },
  ]));

  const expected = buildExpectedRows(
    beforeOnlineRecords,
    cooperationRecords,
    developmentRecords,
  );
  const beforeEvaluation = evaluateRows(beforeOnlineRecords, expected);
  const changes = targets.filter(
    (target) => String(target.field.property?.formula_expression ?? "") !== target.expression,
  );

  if (!apply) {
    return {
      tenantId: tenant.binding.id,
      shop: tenant.profile.businessDisplayName,
      onlineTableId: online.table_id,
      recordCount: beforeOnlineRecords.length,
      mode: "dry-run",
      changes: changes.map(describeTarget),
      beforeEvaluation,
      manualDataHash: manualBeforeHash,
      safety: "字段原地更新；不创建、不删除、不修改任何记录",
    };
  }

  const backupDir = path.resolve("backups", "online-formula-repair");
  await mkdir(backupDir, { recursive: true });
  const backupPath = path.join(
    backupDir,
    `${tenant.binding.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await writeFile(backupPath, JSON.stringify({
    checkedAt: new Date().toISOString(),
    tenantId: tenant.binding.id,
    appToken,
    tableId: online.table_id,
    recordCount: beforeOnlineRecords.length,
    manualDataHash: manualBeforeHash,
    formulaBefore,
    proposedFormulaAfter: Object.fromEntries(targets.map((target) => [target.purpose, target.expression])),
  }, null, 2), "utf8");

  for (const target of changes) {
    const response: any = await retry(() => client.bitable.appTableField.update({
      path: {
        app_token: appToken,
        table_id: online.table_id,
        field_id: target.field.field_id,
      },
      data: {
        field_name: target.field.field_name,
        type: 20,
        ui_type: "Formula",
        property: {
          formatter: target.field.property?.formatter ?? "",
          formula_expression: target.expression,
        },
      },
    }));
    assertFeishuResponse(response, `${tenant.binding.id} 更新公式 ${target.field.field_name}`);
  }

  const verifiedFields = await listFields(client, appToken, online.table_id);
  for (const target of targets) {
    const verified = verifiedFields.find((field) => field.field_id === target.field.field_id);
    if (verified?.type !== 20 || verified.property?.formula_expression !== target.expression) {
      throw new Error(`${tenant.binding.id} 公式回读不一致：${target.field.field_name}`);
    }
  }

  let afterOnlineRecords = beforeOnlineRecords;
  let afterEvaluation = evaluateRows(afterOnlineRecords, expected);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    afterOnlineRecords = await listRecords(client, appToken, online.table_id);
    afterEvaluation = evaluateRows(afterOnlineRecords, expected);
    if (afterEvaluation.mismatches.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  const manualAfterHash = hashManualRecords(afterOnlineRecords, manualFieldNames);
  if (manualAfterHash !== manualBeforeHash) {
    throw new Error(`${tenant.binding.id} 非公式字段哈希发生变化，停止交付并人工核查`);
  }
  if (afterEvaluation.mismatches.length > 0) {
    throw new Error(`${tenant.binding.id} 公式结果仍有 ${afterEvaluation.mismatches.length} 条不一致：${JSON.stringify(afterEvaluation.mismatches.slice(0, 5))}`);
  }

  return {
    tenantId: tenant.binding.id,
    shop: tenant.profile.businessDisplayName,
    onlineTableId: online.table_id,
    recordCount: afterOnlineRecords.length,
    mode: "applied",
    changedFields: changes.map(describeTarget),
    beforeEvaluation,
    afterEvaluation,
    manualDataHashBefore: manualBeforeHash,
    manualDataHashAfter: manualAfterHash,
    manualDataUnchanged: manualAfterHash === manualBeforeHash,
    backupPath,
  };
}

function buildExpectedRows(
  onlineRecords: RecordItem[],
  cooperationRecords: RecordItem[],
  developmentRecords: RecordItem[],
) {
  const cooperationByHandle = uniqueByHandle(cooperationRecords, "红人姓名");
  const developmentByHandle = uniqueByHandle(developmentRecords, "红人姓名");
  return onlineRecords.map((record) => {
    const handle = normalizeHandle(record.fields?.["达人姓名"]);
    const cooperation = cooperationByHandle.get(handle);
    const development = developmentByHandle.get(handle);
    return {
      recordId: String(record.record_id ?? ""),
      handle,
      expected: {
        cooperationDate: cooperation?.fields?.["合作时间"],
        followers: cooperation?.fields?.["粉丝数(K)"],
        remark: cooperation?.fields?.["备注"],
        developer: firstNonBlank(
          development?.fields?.["最终归属"],
          development?.fields?.["开发人2"],
          development?.fields?.["开发人1"],
        ),
      },
      cooperationMatches: cooperationByHandle.counts.get(handle) ?? 0,
      developmentMatches: developmentByHandle.counts.get(handle) ?? 0,
    };
  });
}

function evaluateRows(records: RecordItem[], expectedRows: ReturnType<typeof buildExpectedRows>) {
  const recordsById = new Map(records.map((record) => [String(record.record_id ?? ""), record]));
  const mismatches: unknown[] = [];
  let checked = 0;
  for (const expectedRow of expectedRows) {
    if (!expectedRow.handle) continue;
    if (expectedRow.cooperationMatches > 1 || expectedRow.developmentMatches > 1) {
      mismatches.push({
        recordId: expectedRow.recordId,
        handle: expectedRow.handle,
        reason: "source-handle-not-unique",
        cooperationMatches: expectedRow.cooperationMatches,
        developmentMatches: expectedRow.developmentMatches,
      });
      continue;
    }
    const record = recordsById.get(expectedRow.recordId);
    if (!record) {
      mismatches.push({ recordId: expectedRow.recordId, reason: "record-missing-after-update" });
      continue;
    }
    checked += 1;
    const actual = {
      cooperationDate: findValueByName(record.fields ?? {}, /^合作时间/),
      followers: record.fields?.["粉丝量(K)"],
      remark: record.fields?.["备注"],
      developer: record.fields?.["开发人"],
    };
    for (const key of ["cooperationDate", "followers", "remark", "developer"] as const) {
      const matches = key === "cooperationDate"
        ? dateEquivalent(actual[key], expectedRow.expected[key])
        : equivalent(actual[key], expectedRow.expected[key]);
      if (!matches) {
        mismatches.push({
          recordId: expectedRow.recordId,
          handle: expectedRow.handle,
          field: key,
          expected: compactValue(expectedRow.expected[key]),
          actual: compactValue(actual[key]),
        });
      }
    }
  }
  return { checkedRows: checked, mismatchCount: mismatches.length, mismatches };
}

function uniqueByHandle(records: RecordItem[], fieldName: string) {
  const map = new Map<string, RecordItem>();
  const counts = new Map<string, number>();
  for (const record of records) {
    const handle = normalizeHandle(record.fields?.[fieldName]);
    if (!handle) continue;
    counts.set(handle, (counts.get(handle) ?? 0) + 1);
    if (!map.has(handle)) map.set(handle, record);
  }
  return Object.assign(map, { counts });
}

function describeTarget(target: FormulaTarget) {
  return {
    purpose: target.purpose,
    fieldId: target.field.field_id,
    fieldName: target.field.field_name,
    oldExpression: target.field.property?.formula_expression ?? "",
    newExpression: target.expression,
  };
}

function hashManualRecords(records: RecordItem[], manualFieldNames: Set<string>): string {
  const rows = records
    .map((record) => ({
      recordId: String(record.record_id ?? ""),
      fields: Object.fromEntries(
        [...manualFieldNames]
          .sort()
          .map((name) => [name, normalizeForHash(record.fields?.[name])]),
      ),
    }))
    .sort((left, right) => left.recordId.localeCompare(right.recordId));
  return createHash("sha256").update(stableStringify(rows)).digest("hex");
}

function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeForHash(nested)]),
    );
  }
  return value ?? null;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForHash(value));
}

function normalizeHandle(value: unknown): string {
  return rawCellText(value)
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\u2063\uFEFF]/g, "")
    .replace(/[\r\n\t ]+/g, "")
    .replace(/^@+/, "")
    .toLocaleLowerCase("en-US");
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

function firstNonBlank(...values: unknown[]): unknown {
  return values.find((value) => !isBlank(value));
}

function equivalent(actual: unknown, expected: unknown): boolean {
  if (isBlank(expected)) return isBlank(actual);
  const actualNumber = numericValue(actual);
  const expectedNumber = numericValue(expected);
  if (actualNumber !== null && expectedNumber !== null) return Math.abs(actualNumber - expectedNumber) < 1e-9;
  return rawCellText(actual).trim() === rawCellText(expected).trim();
}

function dateEquivalent(actual: unknown, expected: unknown): boolean {
  if (isBlank(expected)) return isBlank(actual);
  return dateKey(actual) !== "" && dateKey(actual) === dateKey(expected);
}

function dateKey(value: unknown): string {
  const numeric = numericValue(value);
  if (numeric !== null && numeric > 20_000 && numeric < 100_000) {
    const excelEpoch = Date.UTC(1899, 11, 30);
    return new Date(excelEpoch + numeric * 86_400_000).toISOString().slice(0, 10);
  }
  if (numeric !== null && numeric > 1_000_000_000) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(numeric));
  }
  return rawCellText(value).match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}

function numericValue(value: unknown): number | null {
  const unwrapped = value && typeof value === "object" && "value" in value
    ? (value as { value?: unknown }).value
    : value;
  const numeric = Number(rawCellText(unwrapped));
  return Number.isFinite(numeric) && rawCellText(unwrapped) !== "" ? numeric : null;
}

function compactValue(value: unknown): unknown {
  if (isBlank(value)) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return rawCellText(value) || value;
}

function isBlank(value: unknown): boolean {
  return value == null || value === "" || (Array.isArray(value) && value.length === 0);
}

function findValueByName(fields: Record<string, unknown>, pattern: RegExp): unknown {
  const key = Object.keys(fields).find((name) => pattern.test(name));
  return key ? fields[key] : undefined;
}

function requireExactField(fields: Field[], name: string, type?: number): Field {
  const matches = fields.filter((field) => field.field_name === name && field.field_id);
  if (matches.length !== 1) throw new Error(`字段“${name}”应恰好 1 个，实际 ${matches.length}`);
  if (type !== undefined && matches[0].type !== type) {
    throw new Error(`字段“${name}”类型应为 ${type}，实际 ${matches[0].type ?? "未知"}`);
  }
  return matches[0];
}

function requireExactFormulaField(fields: Field[], name: string): Field {
  const field = requireExactField(fields, name);
  if (field.type !== 20 || field.ui_type !== "Formula") {
    throw new Error(`字段“${name}”不是公式字段，拒绝转换或覆盖`);
  }
  return field;
}

function requireFormulaFieldByPattern(fields: Field[], pattern: RegExp): Field {
  const matches = fields.filter((field) => pattern.test(String(field.field_name ?? "")) && field.field_id);
  if (matches.length !== 1) throw new Error(`公式字段 ${pattern} 应恰好 1 个，实际 ${matches.length}`);
  if (matches[0].type !== 20 || matches[0].ui_type !== "Formula") {
    throw new Error(`字段“${matches[0].field_name}”不是公式字段，拒绝转换或覆盖`);
  }
  return matches[0];
}

async function listTables(client: any, appToken: string, tenantId: string): Promise<any[]> {
  return listAll(async (pageToken) => {
    const response: any = await retry(() => client.bitable.appTable.list({
      path: { app_token: appToken },
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    }));
    assertFeishuResponse(response, `${tenantId} 读取表清单`);
    return response;
  });
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
