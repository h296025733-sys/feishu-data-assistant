import { getEnv } from "../config/env.js";
import { TenantRegistry, type ResolvedTenant } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

const RETAINED = {
  spend: { id: "fldbJeK2L1", oldName: "雅岚广告花费", formatter: "0.00" },
  orders: { id: "fldYa1V62d", oldName: "雅岚广告出单量", formatter: "0" },
} as const;

const TOTAL = {
  spend: { id: "flde1ijDaR", name: "总广告花费", formatter: "0.00" },
  orders: { id: "fldyzqfd1H", name: "总广告出单量", formatter: "0" },
} as const;

const OBSOLETE = [
  { id: "fld8KhLYYa", name: "金凯悦-10广告花费" },
  { id: "fldmvldC2G", name: "金凯悦-10广告出单量" },
  { id: "fldYFCwgSC", name: "金凯悦-11广告花费" },
  { id: "fldb8AbAhe", name: "金凯悦-11广告出单量" },
  { id: "fldxD08EiH", name: "GMV Max花费" },
  { id: "fldjxU6S80", name: "GMV Max广告出单量" },
] as const;

type Field = {
  field_id?: string;
  field_name?: string;
  type?: number;
  property?: { formula_expression?: string };
};

const apply = process.argv.includes("--apply");
const tenantArg = process.argv.find((value) => value.startsWith("--tenant="))?.slice("--tenant=".length);
const registry = new TenantRegistry(getEnv());
const tenants = tenantArg ? [registry.byId(tenantArg)].filter(Boolean) as ResolvedTenant[] : registry.all();

if (!tenants.length) throw new Error(`没有找到店铺租户：${tenantArg}`);

for (const tenant of tenants) {
  if (!tenant.profile.advertising) {
    console.log(JSON.stringify({ tenant: tenant.binding.id, skipped: "未配置 advertising" }, null, 2));
    continue;
  }
  await migrateTenant(tenant);
}

async function migrateTenant(tenant: ResolvedTenant): Promise<void> {
  const client = createFeishuClient(tenant.env) as any;
  const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
  const tableId = tenant.env.FEISHU_BITABLE_TABLE_ID;
  const fields = await listFields(client, appToken, tableId);
  const byId = new Map(fields.map((field) => [String(field.field_id ?? ""), field]));
  const targetNames = {
    spend: tenant.profile.advertising!.spendFieldName,
    orders: tenant.profile.advertising!.orderFieldName,
  };

  requireField(byId, RETAINED.spend.id, [RETAINED.spend.oldName, targetNames.spend]);
  requireField(byId, RETAINED.orders.id, [RETAINED.orders.oldName, targetNames.orders]);
  requireField(byId, TOTAL.spend.id, [TOTAL.spend.name]);
  requireField(byId, TOTAL.orders.id, [TOTAL.orders.name]);

  const obsoletePresent = OBSOLETE.filter((definition) => byId.has(definition.id));
  const valueCounts = await nonEmptyCounts(
    client,
    appToken,
    tableId,
    [
      String(byId.get(RETAINED.spend.id)?.field_name ?? ""),
      String(byId.get(RETAINED.orders.id)?.field_name ?? ""),
      ...obsoletePresent.map((definition) => String(byId.get(definition.id)?.field_name ?? definition.name)),
    ],
  );
  const unsafe = obsoletePresent.filter((definition) => (
    (valueCounts[String(byId.get(definition.id)?.field_name ?? definition.name)] ?? 0) > 0
  ));
  if (unsafe.length) {
    throw new Error(`${tenant.binding.id} 的待删除广告字段已有数据：${unsafe.map((item) => item.name).join("、")}；已停止，未修改`);
  }

  const plan = {
    tenant: tenant.binding.id,
    tableId,
    mode: apply ? "apply" : "dry-run",
    rename: [
      `${byId.get(RETAINED.spend.id)?.field_name} → ${targetNames.spend}`,
      `${byId.get(RETAINED.orders.id)?.field_name} → ${targetNames.orders}`,
    ],
    formulas: [
      `${TOTAL.spend.name} = ${targetNames.spend}`,
      `${TOTAL.orders.name} = ${targetNames.orders}`,
    ],
    delete: obsoletePresent.map((definition) => byId.get(definition.id)?.field_name ?? definition.name),
    nonEmptyValues: valueCounts,
  };
  if (!apply) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  await updateNumberField(client, appToken, tableId, RETAINED.spend.id, targetNames.spend, RETAINED.spend.formatter);
  await updateNumberField(client, appToken, tableId, RETAINED.orders.id, targetNames.orders, RETAINED.orders.formatter);
  await updateFormulaField(client, appToken, tableId, TOTAL.spend, RETAINED.spend.id);
  await updateFormulaField(client, appToken, tableId, TOTAL.orders, RETAINED.orders.id);

  const preDelete = await listFields(client, appToken, tableId);
  verifyCore(preDelete, tableId, targetNames);
  for (const definition of obsoletePresent) {
    const response = await client.bitable.appTableField.delete({
      path: { app_token: appToken, table_id: tableId, field_id: definition.id },
    });
    assertFeishuResponse(response, `删除字段“${definition.name}”`);
  }

  const verified = await listFields(client, appToken, tableId);
  verifyCore(verified, tableId, targetNames);
  const remainingObsolete = verified.filter((field) => OBSOLETE.some((definition) => definition.id === field.field_id));
  if (remainingObsolete.length) throw new Error(`${tenant.binding.id} 仍存在旧广告字段：${remainingObsolete.map((field) => field.field_name).join("、")}`);
  console.log(JSON.stringify({ ...plan, verified: true, remainingAdvertisingFields: verified.filter((field) => /广告|GMV/.test(String(field.field_name ?? ""))).map((field) => field.field_name) }, null, 2));
}

async function listFields(client: any, appToken: string, tableId: string): Promise<Field[]> {
  const response = await client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: 100 },
  });
  assertFeishuResponse(response, "读取投产比字段");
  return response.data?.items ?? [];
}

async function nonEmptyCounts(
  client: any,
  appToken: string,
  tableId: string,
  fieldNames: string[],
): Promise<Record<string, number>> {
  const counts = Object.fromEntries(fieldNames.filter(Boolean).map((name) => [name, 0]));
  let pageToken: string | undefined;
  do {
    const response = await client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100, page_token: pageToken, field_names: JSON.stringify(Object.keys(counts)) },
    });
    assertFeishuResponse(response, "检查广告字段现有值");
    for (const record of response.data?.items ?? []) {
      for (const name of Object.keys(counts)) {
        const value = record.fields?.[name];
        if (value !== undefined && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0)) counts[name] += 1;
      }
    }
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return counts;
}

async function updateNumberField(
  client: any,
  appToken: string,
  tableId: string,
  fieldId: string,
  fieldName: string,
  formatter: string,
): Promise<void> {
  const response = await client.bitable.appTableField.update({
    path: { app_token: appToken, table_id: tableId, field_id: fieldId },
    data: { field_name: fieldName, type: 2, ui_type: "Number", property: { formatter } },
  });
  assertFeishuResponse(response, `重命名字段“${fieldName}”`);
}

async function updateFormulaField(
  client: any,
  appToken: string,
  tableId: string,
  total: { id: string; name: string; formatter: string },
  inputFieldId: string,
): Promise<void> {
  const expression = `IF(bitable::$table[${tableId}].$field[fldU1pcF5j]!="店铺汇总","",bitable::$table[${tableId}].$field[${inputFieldId}])`;
  const response = await client.bitable.appTableField.update({
    path: { app_token: appToken, table_id: tableId, field_id: total.id },
    data: { field_name: total.name, type: 20, ui_type: "Formula", property: { formatter: total.formatter, formula_expression: expression } },
  });
  assertFeishuResponse(response, `更新公式“${total.name}”`);
}

function requireField(byId: Map<string, Field>, id: string, names: string[]): void {
  const field = byId.get(id);
  if (!field) throw new Error(`缺少预期字段ID：${id}`);
  if (!names.includes(String(field.field_name ?? ""))) {
    throw new Error(`字段 ${id} 名称异常：${field.field_name ?? "空"}`);
  }
}

function verifyCore(fields: Field[], tableId: string, targetNames: { spend: string; orders: string }): void {
  const byId = new Map(fields.map((field) => [String(field.field_id ?? ""), field]));
  if (byId.get(RETAINED.spend.id)?.field_name !== targetNames.spend) throw new Error("广告花费字段重命名复读失败");
  if (byId.get(RETAINED.orders.id)?.field_name !== targetNames.orders) throw new Error("广告出单量字段重命名复读失败");
  const expectedSpend = `bitable::$table[${tableId}].$field[${RETAINED.spend.id}]`;
  const expectedOrders = `bitable::$table[${tableId}].$field[${RETAINED.orders.id}]`;
  const spendFormula = String(byId.get(TOTAL.spend.id)?.property?.formula_expression ?? "");
  const orderFormula = String(byId.get(TOTAL.orders.id)?.property?.formula_expression ?? "");
  if (!spendFormula.includes(expectedSpend) || OBSOLETE.some((definition) => spendFormula.includes(definition.id))) throw new Error("总广告花费公式复读失败");
  if (!orderFormula.includes(expectedOrders) || OBSOLETE.some((definition) => orderFormula.includes(definition.id))) throw new Error("总广告出单量公式复读失败");
}
