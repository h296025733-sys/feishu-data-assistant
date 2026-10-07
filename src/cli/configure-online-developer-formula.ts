import { loadBusinessProfile } from "../config/business-profile.js";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import { buildOnlineDeveloperFormula } from "../feishu/online-developer-formula.js";

interface NamedTable { table_id?: string; name?: string }
interface NamedField {
  field_id?: string;
  field_name?: string;
  type?: number;
  property?: { formatter?: string; formula_expression?: string };
}

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env) as any;
const profile = loadBusinessProfile();
const appToken = env.FEISHU_BITABLE_APP_TOKEN;

const tablesResponse = await client.bitable.appTable.list({
  path: { app_token: appToken },
  params: { page_size: 100 },
});
assertFeishuResponse(tablesResponse, "读取业务表");
const tables = (tablesResponse.data?.items ?? []) as NamedTable[];
const developmentTable = requireTable(tables, profile.tables.development);
const onlineTable = requireTable(tables, profile.tables.online);
const developmentFields = await listFields(developmentTable.table_id!);
const onlineFields = await listFields(onlineTable.table_id!);

const developmentCreator = requireField(developmentFields, "红人姓名");
const developmentFinalOwner = requireField(developmentFields, "最终归属");
const developmentSecondOwner = requireField(developmentFields, "开发人2");
const developmentFirstOwner = requireField(developmentFields, "开发人1");
const onlineCreator = requireField(onlineFields, "达人姓名");
const onlineDeveloper = requireField(onlineFields, "开发人");

if (onlineDeveloper.type !== 1 && onlineDeveloper.type !== 20) {
  throw new Error(`开发人字段当前类型为 ${onlineDeveloper.type ?? "未知"}，拒绝覆盖非文本/公式字段`);
}

if (onlineDeveloper.type === 1) {
  const records = await listRecords(onlineTable.table_id!);
  const nonBlank = records.filter((record) => cellText(record.fields?.开发人));
  if (nonBlank.length > 0) {
    throw new Error(`开发人字段仍有 ${nonBlank.length} 条人工数据，拒绝在未迁移前转换为公式`);
  }
}

const expression = buildOnlineDeveloperFormula({
  developmentTableId: developmentTable.table_id!,
  onlineTableId: onlineTable.table_id!,
  developmentCreatorFieldId: developmentCreator.field_id!,
  developmentFinalOwnerFieldId: developmentFinalOwner.field_id!,
  developmentSecondOwnerFieldId: developmentSecondOwner.field_id!,
  developmentFirstOwnerFieldId: developmentFirstOwner.field_id!,
  onlineCreatorFieldId: onlineCreator.field_id!,
});

if (onlineDeveloper.type !== 20 || onlineDeveloper.property?.formula_expression !== expression) {
  const updated = await client.bitable.appTableField.update({
    path: {
      app_token: appToken,
      table_id: onlineTable.table_id,
      field_id: onlineDeveloper.field_id,
    },
    data: {
      field_name: "开发人",
      type: 20,
      ui_type: "Formula",
      property: { formatter: "", formula_expression: expression },
    },
  });
  assertFeishuResponse(updated, "将上线表开发人转换为公式");
}

const verifiedFields = await listFields(onlineTable.table_id!);
const verifiedDeveloper = requireField(verifiedFields, "开发人");
if (verifiedDeveloper.type !== 20 || verifiedDeveloper.property?.formula_expression !== expression) {
  throw new Error("开发人公式写后回读不一致");
}

let matched: Array<{ recordId: string; developer: string }> = [];
for (let attempt = 0; attempt < 10; attempt += 1) {
  const records = await listRecords(onlineTable.table_id!);
  matched = records
    .filter((record) => normalizeHandle(record.fields?.达人姓名) === "graceguitron")
    .map((record) => ({
      recordId: String(record.record_id ?? ""),
      developer: cellText(record.fields?.开发人),
    }));
  if (matched.length === 0 || matched.every((record) => record.developer === "李")) break;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
if (matched.length > 0 && matched.some((record) => record.developer !== "李")) {
  throw new Error(`开发人公式真实记录验证失败：${JSON.stringify(matched)}`);
}

console.log(JSON.stringify({
  fieldId: onlineDeveloper.field_id,
  type: verifiedDeveloper.type,
  expression: verifiedDeveloper.property?.formula_expression,
  verifiedGraceguitronRows: matched,
}, null, 2));

async function listFields(tableId: string): Promise<NamedField[]> {
  const result: NamedField[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.bitable.appTableField.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100, page_token: pageToken },
    });
    assertFeishuResponse(response, `读取字段 ${tableId}`);
    result.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return result;
}

async function listRecords(tableId: string): Promise<any[]> {
  const result: any[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 500, page_token: pageToken },
    });
    assertFeishuResponse(response, `读取记录 ${tableId}`);
    result.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return result;
}

function requireTable(tables: NamedTable[], name: string): NamedTable {
  const table = tables.find((item) => item.name === name && item.table_id);
  if (!table) throw new Error(`未找到表：${name}`);
  return table;
}

function requireField(fields: NamedField[], name: string): NamedField {
  const field = fields.find((item) => item.field_name === name && item.field_id);
  if (!field) throw new Error(`未找到字段：${name}`);
  return field;
}

function cellText(value: unknown): string {
  if (Array.isArray(value)) return value.map(cellText).join("").trim();
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if ("text" in object) return cellText(object.text);
    if ("value" in object) return cellText(object.value);
  }
  return value === null || value === undefined ? "" : String(value).trim();
}

function normalizeHandle(value: unknown): string {
  return cellText(value).replace(/[\u200B-\u200D\u2060\u2063\uFEFF]/g, "").replace(/^@/, "").toLowerCase();
}
