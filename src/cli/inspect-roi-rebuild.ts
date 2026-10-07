import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env) as any;
const appToken = env.FEISHU_BITABLE_APP_TOKEN;
const tableResponse = await client.bitable.appTable.list({
  path: { app_token: appToken },
  params: { page_size: 100 },
});
if (tableResponse.code && tableResponse.code !== 0) {
  throw new Error(`${tableResponse.code}: ${tableResponse.msg}`);
}
for (const table of tableResponse.data?.items ?? []) {
  if (!String(table.name).startsWith("投产比")) continue;
  const fieldResponse = await client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: table.table_id },
    params: { page_size: 100 },
  });
  const recordResponse = await client.bitable.appTableRecord.list({
    path: { app_token: appToken, table_id: table.table_id },
    params: { page_size: 500, automatic_fields: true },
  });
  console.log(JSON.stringify({
    name: table.name,
    tableId: table.table_id,
    records: recordResponse.data?.total ?? recordResponse.data?.items?.length ?? 0,
    formulas: (fieldResponse.data?.items ?? [])
      .filter((field: any) => field.type === 20)
      .map((field: any) => field.field_name),
  }, null, 2));
}
