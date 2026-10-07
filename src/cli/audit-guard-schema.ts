import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
const result = [];
for (const tenant of new TenantRegistry(getEnv()).all()) {
  const client = createFeishuClient(tenant.env);
  const app_token = tenant.env.FEISHU_BITABLE_APP_TOKEN;
  const tables = await client.bitable.appTable.list({ path: { app_token }, params: { page_size: 100 } });
  assertFeishuResponse(tables, "Read guard tables");
  for (const [role, required] of Object.entries({
    roi: ["商品", "日期"], cooperation: ["红人姓名", tenant.profile.cooperationDateField ?? "合作时间", "寄样产品", "进度条"],
    online: ["达人姓名", "实上线日期(Ct)", "挂车产品"],
  })) {
    const tableName = tenant.profile.tables[role as "roi" | "cooperation" | "online"];
    const table_id = tables.data?.items?.find((t) => t.name === tableName)?.table_id;
    if (!table_id) throw new Error(`${tenant.binding.id} missing ${tableName}`);
    const fields = await client.bitable.appTableField.list({ path: { app_token, table_id }, params: { page_size: 100 } });
    assertFeishuResponse(fields, "Read guard fields");
    const names = fields.data?.items?.map((f) => f.field_name!) ?? [];
    result.push({ tenant: tenant.binding.id, role, table_id, required, missing: required.filter((name) => !names.includes(name)),
      fieldNames: names.filter((name) => /日期|时间|产品|姓名|进度/.test(name)) });
  }
}
console.log(JSON.stringify(result, null, 2));
