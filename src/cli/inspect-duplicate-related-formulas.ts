import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

const registry = new TenantRegistry(getEnv());

for (const tenant of registry.all()) {
  const client = createFeishuClient(tenant.env) as any;
  const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
  const tablesResponse = await client.bitable.appTable.list({
    path: { app_token: appToken },
    params: { page_size: 100 },
  });
  assertFeishuResponse(tablesResponse, `${tenant.binding.id} 读取表清单`);
  const tables = tablesResponse.data?.items ?? [];
  const result: unknown[] = [];
  const tableFields: Array<{ tableId: string; tableName: string; fields: any[] }> = [];

  for (const table of tables) {
    const tableId = String(table.table_id ?? "");
    const tableName = String(table.name ?? "");
    if (!tableId) continue;
    const fieldsResponse = await client.bitable.appTableField.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100 },
    });
    assertFeishuResponse(fieldsResponse, `${tenant.binding.id} 读取 ${tableName} 字段`);
    const fields = fieldsResponse.data?.items ?? [];
    tableFields.push({ tableId, tableName, fields });
  }
  const targetIds = tableFields.flatMap(({ fields }) => fields
      .filter((field: any) => ["红人姓名", "达人姓名"].includes(String(field.field_name ?? "")))
      .map((field: any) => String(field.field_id ?? ""))
      .filter(Boolean));
  for (const { tableId, tableName, fields } of tableFields) {
    for (const field of fields) {
      const expression = String(field.property?.formula_expression ?? "");
      if (!expression || !targetIds.some((fieldId) => expression.includes(fieldId))) continue;
      result.push({
        table: tableName,
        tableId,
        field: field.field_name,
        fieldId: field.field_id,
        formatter: field.property?.formatter ?? "",
        expression,
      });
    }
  }
  console.log(JSON.stringify({ tenant: tenant.binding.id, formulas: result }, null, 2));
}
