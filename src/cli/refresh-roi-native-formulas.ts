import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env) as any;
const appToken = env.FEISHU_BITABLE_APP_TOKEN;
const tables = await client.bitable.appTable.list({
  path: { app_token: appToken },
  params: { page_size: 100 },
});
if (tables.code && tables.code !== 0) throw new Error(`${tables.code}: ${tables.msg}`);
const table = tables.data?.items?.find((item: any) => item.name === "投产比");
if (!table?.table_id) throw new Error("未找到投产比");
const listed = await client.bitable.appTableField.list({
  path: { app_token: appToken, table_id: table.table_id },
  params: { page_size: 100 },
});
if (listed.code && listed.code !== 0) throw new Error(`${listed.code}: ${listed.msg}`);
const fields = listed.data?.items ?? [];
const ids = Object.fromEntries(fields.map((field: any) => [field.field_name, field.field_id]));
const ref = (name: string) => `bitable::$table[${table.table_id}].$field[${ids[name]}]`;

for (const field of fields.filter((item: any) => item.type === 20)) {
  let expression = field.property?.formula_expression;
  if (field.field_name === "转化率") {
    expression = `IF(OR(${ref("商品")}!="TechWave",${ref("店铺浏览量")}="",${ref("店铺浏览量")}=0),"",${ref("总单量")}/${ref("店铺浏览量")})`;
  }
  const response = await client.bitable.appTableField.update({
    path: {
      app_token: appToken,
      table_id: table.table_id,
      field_id: field.field_id,
    },
    data: {
      field_name: field.field_name,
      type: 20,
      ui_type: "Formula",
      property: {
        formatter: field.property?.formatter ?? "",
        formula_expression: expression,
      },
    },
  });
  if (response.code && response.code !== 0) {
    throw new Error(`刷新公式 ${field.field_name} 失败（${response.code}）：${response.msg}`);
  }
}
console.log(`已刷新 ${fields.filter((item: any) => item.type === 20).length} 个原生公式字段`);
