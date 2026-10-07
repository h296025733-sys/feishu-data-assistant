import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env);
const tables: Array<{ table_id?: string; name?: string }> = [];
let tablePage: string | undefined;
do {
  const response = await client.bitable.appTable.list({
    path: { app_token: env.FEISHU_BITABLE_APP_TOKEN },
    params: { page_size: 100, page_token: tablePage },
  });
  if (response.code && response.code !== 0) throw new Error(`${response.code}: ${response.msg}`);
  tables.push(...(response.data?.items ?? []));
  tablePage = response.data?.has_more ? response.data.page_token : undefined;
} while (tablePage);

for (const table of tables) {
  if (!table.table_id) continue;
  let fieldPage: string | undefined;
  do {
    const response = await client.bitable.appTableField.list({
      path: {
        app_token: env.FEISHU_BITABLE_APP_TOKEN,
        table_id: table.table_id,
      },
      params: { page_size: 100, page_token: fieldPage },
    });
    if (response.code && response.code !== 0) throw new Error(`${response.code}: ${response.msg}`);
    for (const field of response.data?.items ?? []) {
      if (field.type !== 20) continue;
      console.log(JSON.stringify({
        table: table.name,
        tableId: table.table_id,
        field: field.field_name,
        fieldId: field.field_id,
        expression: field.property?.formula_expression,
        formatter: field.property?.formatter,
      }, null, 2));
    }
    fieldPage = response.data?.has_more ? response.data.page_token : undefined;
  } while (fieldPage);
}
