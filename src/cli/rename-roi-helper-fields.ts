import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env) as any;
const appToken = env.FEISHU_BITABLE_APP_TOKEN;
const tables = await client.bitable.appTable.list({
  path: { app_token: appToken },
  params: { page_size: 100 },
});
const table = tables.data?.items?.find((item: any) => item.name === "投产比");
if (!table?.table_id) throw new Error("未找到投产比");
const listed = await client.bitable.appTableField.list({
  path: { app_token: appToken, table_id: table.table_id },
  params: { page_size: 100 },
});
const renames: Record<string, string> = {
  "商品合作量（自动）": "合作量源",
  "商品上线量（自动）": "上线量源",
  "商品达人出单量（自动）": "达人出单量源",
};
for (const field of listed.data?.items ?? []) {
  const fieldName = renames[field.field_name];
  if (!fieldName) continue;
  const response = await client.bitable.appTableField.update({
    path: {
      app_token: appToken,
      table_id: table.table_id,
      field_id: field.field_id,
    },
    data: {
      field_name: fieldName,
      type: 20,
      ui_type: "Formula",
      property: {
        formatter: field.property?.formatter ?? "",
        formula_expression: field.property?.formula_expression,
      },
    },
  });
  if (response.code && response.code !== 0) {
    throw new Error(`重命名 ${field.field_name} 失败：${response.msg}`);
  }
}
console.log("底层字段已去除“自动”字样");
