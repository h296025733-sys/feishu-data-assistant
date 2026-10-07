import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { TenantRegistry, type ResolvedTenant } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import { DuplicateCellFlagService, duplicateTargetsForProfile } from "../feishu/duplicate-cell-flags.js";
import {
  buildRoiRecordGuardPlan,
  type RoiDailyKeyRecord,
  type RoiSourceRecord,
} from "../feishu/roi-record-guard.js";

const apply = process.argv.includes("--apply");
const registry = new TenantRegistry(getEnv());
const timestamp = new Date().toISOString().replaceAll(":", "-");
const backupRoot = path.resolve("backups", `source-driven-roi-${timestamp}`);

type Field = {
  field_id?: string;
  field_name?: string;
  type?: number;
  ui_type?: string;
  property?: { formula_expression?: string; formatter?: string };
};
type RecordItem = { record_id?: string; fields?: Record<string, unknown> };

for (const tenant of registry.all()) await migrateTenant(tenant);

async function migrateTenant(tenant: ResolvedTenant): Promise<void> {
  const client = createFeishuClient(tenant.env) as any;
  const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
  const tables = await listTables(client, appToken);
  const tableId = (name: string) => {
    const matches = tables.filter((item: any) => item.name === name && item.table_id);
    if (matches.length !== 1) throw new Error(`${tenant.binding.id} 应恰好有一张“${name}”，实际 ${matches.length} 张`);
    return String(matches[0].table_id);
  };
  const ids = {
    cooperation: tableId(tenant.profile.tables.cooperation),
    online: tableId(tenant.profile.tables.online),
    roi: tableId(tenant.profile.tables.roi),
  };
  const [cooperationFields, onlineFields, roiFields] = await Promise.all([
    listFields(client, appToken, ids.cooperation),
    listFields(client, appToken, ids.online),
    listFields(client, appToken, ids.roi),
  ]);
  const byName = (fields: Field[]) => new Map(fields.map((field) => [String(field.field_name ?? ""), field]));
  const cooperationMap = byName(cooperationFields);
  const onlineMap = byName(onlineFields);
  const roiMap = byName(roiFields);
  for (const name of ["红人姓名", "联系方式（邮箱/WhatsApp）", "寄样产品", "合作时间"]) requireField(cooperationMap, name);
  for (const name of ["达人姓名", "视频上线地址", "挂车产品", "实上线日期(Ct)"]) requireField(onlineMap, name);
  for (const name of ["商品", "日期", "合作量源", "上线量源", "合作量", "上线量"]) requireField(roiMap, name);

  const snapshot = await captureSnapshot(client, appToken, ids, {
    cooperation: cooperationFields,
    online: onlineFields,
    roi: roiFields,
  });
  const sourceRecords = [
    ...toSourceRecords(snapshot.records.cooperation, "寄样产品", "合作时间"),
    ...toSourceRecords(snapshot.records.online, "挂车产品", "实上线日期(Ct)"),
  ];
  const roiKeys = snapshot.records.roi.map((item) => ({
    product: String(item.fields?.商品 ?? "").trim(),
    date: timestampValue(item.fields?.日期),
  } satisfies RoiDailyKeyRecord));
  const roiPlan = buildRoiRecordGuardPlan(roiKeys, {
    sourceRecords,
    allowedProducts: tenant.profile.tiktok.includedCanonicalProducts,
    storeName: tenant.profile.storeAggregateLabel,
  });
  const needsCooperationCreatorFlag = !cooperationMap.has("__重复_红人姓名");
  const formulas = formulaExpressions(ids, cooperationMap, onlineMap, roiMap, tenant.profile.storeAggregateLabel);
  const formulaChanges = formulas.filter((definition) => (
    String(roiMap.get(definition.name)?.property?.formula_expression ?? "") !== definition.expression
  ));
  const plan = {
    tenant: tenant.binding.id,
    mode: apply ? "apply" : "dry-run",
    addFields: needsCooperationCreatorFlag ? ["红人合作表.__重复_红人姓名（内部文本标记）"] : [],
    updateFormulaFields: formulaChanges.map((item) => item.name),
    createProductDateRows: roiPlan.missingProductDates,
    createStoreDateRows: roiPlan.missingStoreDates,
    existingDuplicateKeys: roiPlan.duplicateKeys,
    protectedExistingRecords: snapshot.businessHashes.size,
    protectedBusinessDataSha256: digestMap(snapshot.businessHashes),
  };
  if (!apply) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  mkdirSync(backupRoot, { recursive: true });
  writeFileSync(path.join(backupRoot, `${tenant.binding.id}.before.json`), `${JSON.stringify({ plan, snapshot }, null, 2)}\n`, "utf8");

  if (needsCooperationCreatorFlag) {
    const response = await client.bitable.appTableField.create({
      path: { app_token: appToken, table_id: ids.cooperation },
      data: { field_name: "__重复_红人姓名", type: 1, ui_type: "Text" },
    });
    assertFeishuResponse(response, `${tenant.binding.id} 创建合作表达人重复辅助字段`);
  }
  for (const definition of formulaChanges) {
    const target = roiMap.get(definition.name)!;
    const response = await client.bitable.appTableField.update({
      path: { app_token: appToken, table_id: ids.roi, field_id: String(target.field_id) },
      data: {
        field_name: definition.name,
        type: 20,
        ui_type: "Formula",
        property: { formatter: "0", formula_expression: definition.expression },
      },
    });
    assertFeishuResponse(response, `${tenant.binding.id} 更新公式“${definition.name}”`);
  }
  const creates = [
    ...roiPlan.missingProductDates.map((item) => ({ fields: { 商品: item.product, 日期: item.timestamp } })),
    ...roiPlan.missingStoreDates.map((item) => ({ fields: { 商品: tenant.profile.storeAggregateLabel, 日期: item.timestamp } })),
  ];
  for (let offset = 0; offset < creates.length; offset += 500) {
    const response = await client.bitable.appTableRecord.batchCreate({
      path: { app_token: appToken, table_id: ids.roi },
      data: { records: creates.slice(offset, offset + 500) },
    });
    assertFeishuResponse(response, `${tenant.binding.id} 创建即时合作/上线投产比骨架行`);
  }

  const duplicateService = new DuplicateCellFlagService(
    tenant.env,
    client,
    duplicateTargetsForProfile(tenant.profile),
  );
  const duplicateSummary = await duplicateService.start();

  const afterFields = {
    cooperation: await listFields(client, appToken, ids.cooperation),
    online: await listFields(client, appToken, ids.online),
    roi: await listFields(client, appToken, ids.roi),
  };
  const after = await captureSnapshot(client, appToken, ids, afterFields, snapshot.businessFieldNames);
  verifyBusinessHashes(snapshot.businessHashes, after.businessHashes);
  const afterRoiPlan = buildRoiRecordGuardPlan(
    after.records.roi.map((item) => ({
      product: String(item.fields?.商品 ?? "").trim(),
      date: timestampValue(item.fields?.日期),
    })),
    {
      sourceRecords: [
        ...toSourceRecords(after.records.cooperation, "寄样产品", "合作时间"),
        ...toSourceRecords(after.records.online, "挂车产品", "实上线日期(Ct)"),
      ],
      allowedProducts: tenant.profile.tiktok.includedCanonicalProducts,
      storeName: tenant.profile.storeAggregateLabel,
    },
  );
  if (afterRoiPlan.missingProductDates.length || afterRoiPlan.missingStoreDates.length) {
    throw new Error(`${tenant.binding.id} 写后仍缺即时骨架行`);
  }
  const verifiedRoiMap = byName(afterFields.roi);
  for (const definition of formulas) {
    if (String(verifiedRoiMap.get(definition.name)?.property?.formula_expression ?? "") !== definition.expression) {
      throw new Error(`${tenant.binding.id} 公式“${definition.name}”写后不一致`);
    }
  }
  const result = {
    ...plan,
    verified: true,
    created: creates.length,
    duplicateSummary,
    protectedBusinessDataUnchanged: true,
    afterProtectedBusinessDataSha256: digestMap(after.businessHashes),
  };
  writeFileSync(path.join(backupRoot, `${tenant.binding.id}.after.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
}

function formulaExpressions(
  ids: { cooperation: string; online: string; roi: string },
  cooperation: Map<string, Field>,
  online: Map<string, Field>,
  roi: Map<string, Field>,
  storeName: string,
): Array<{ name: "合作量" | "上线量"; expression: string }> {
  const id = (map: Map<string, Field>, name: string) => String(requireField(map, name).field_id);
  const ref = (name: string) => `bitable::$table[${ids.roi}].$field[${id(roi, name)}]`;
  const sourceTotal = (tableId: string, map: Map<string, Field>, product: string, date: string) => (
    `bitable::$table[${tableId}].COUNTIF(AND(CurrentValue.$column[${id(map, product)}]!="",TEXT(CurrentValue.$column[${id(map, date)}],"YYYY-MM-DD")=TEXT(${ref("日期")},"YYYY-MM-DD")))`
  );
  return [
    {
      name: "合作量",
      expression: `IF(${ref("商品")}="${storeName}",${sourceTotal(ids.cooperation, cooperation, "寄样产品", "合作时间")},${ref("合作量源")})`,
    },
    {
      name: "上线量",
      expression: `IF(${ref("商品")}="${storeName}",${sourceTotal(ids.online, online, "挂车产品", "实上线日期(Ct)")},${ref("上线量源")})`,
    },
  ];
}

async function captureSnapshot(
  client: any,
  appToken: string,
  ids: { cooperation: string; online: string; roi: string },
  fields: { cooperation: Field[]; online: Field[]; roi: Field[] },
  fixedFieldNames?: Record<string, string[]>,
) {
  const businessFieldNames = fixedFieldNames ?? Object.fromEntries(
    Object.entries(fields).map(([key, values]) => [key, values
      .filter((field) => field.type !== 20 && !String(field.field_name ?? "").startsWith("__重复_"))
      .map((field) => String(field.field_name ?? ""))
      .filter(Boolean)
      .sort()]),
  );
  const records = {
    cooperation: await listRecords(client, appToken, ids.cooperation),
    online: await listRecords(client, appToken, ids.online),
    roi: await listRecords(client, appToken, ids.roi),
  };
  const businessHashes = new Map<string, string>();
  for (const [kind, items] of Object.entries(records)) {
    for (const item of items) {
      const recordId = String(item.record_id ?? "");
      if (!recordId) continue;
      const selected = Object.fromEntries((businessFieldNames[kind] ?? []).map((name) => [name, item.fields?.[name] ?? null]));
      businessHashes.set(`${kind}:${recordId}`, sha256(stable(selected)));
    }
  }
  return { capturedAt: new Date().toISOString(), records, businessFieldNames, businessHashes };
}

function verifyBusinessHashes(before: Map<string, string>, after: Map<string, string>): void {
  for (const [key, hash] of before) {
    if (!after.has(key)) throw new Error(`受保护的原记录消失：${key}`);
    if (after.get(key) !== hash) throw new Error(`受保护的原记录业务字段发生变化：${key}`);
  }
}

function digestMap(values: Map<string, string>): string {
  return sha256(stable(Object.fromEntries([...values].sort(([a], [b]) => a.localeCompare(b)))));
}

function toSourceRecords(records: RecordItem[], productField: string, dateField: string): RoiSourceRecord[] {
  return records.map((item) => ({
    products: cellStrings(item.fields?.[productField]),
    date: timestampValue(item.fields?.[dateField]),
  }));
}

function cellStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values.map((item) => {
    if (typeof item === "string") return item.trim();
    if (item && typeof item === "object") {
      const entry = item as { name?: unknown; text?: unknown; value?: unknown };
      return String(entry.name ?? entry.text ?? entry.value ?? "").trim();
    }
    return String(item).trim();
  }).filter(Boolean))];
}

function timestampValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function requireField(map: Map<string, Field>, name: string): Field {
  const field = map.get(name);
  if (!field?.field_id) throw new Error(`缺少字段“${name}”；当前字段：${[...map.keys()].join("、")}`);
  return field;
}

async function listTables(client: any, appToken: string): Promise<any[]> {
  const items: any[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.bitable.appTable.list({
      path: { app_token: appToken },
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    });
    assertFeishuResponse(response, "读取多维表格表清单");
    items.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return items;
}

async function listFields(client: any, appToken: string, tableId: string): Promise<Field[]> {
  const items: Field[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.bitable.appTableField.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    });
    assertFeishuResponse(response, "读取字段定义");
    items.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return items;
}

async function listRecords(client: any, appToken: string, tableId: string): Promise<RecordItem[]> {
  const items: RecordItem[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 500, automatic_fields: false, ...(pageToken ? { page_token: pageToken } : {}) },
    });
    assertFeishuResponse(response, "读取原记录快照");
    items.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return items;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
