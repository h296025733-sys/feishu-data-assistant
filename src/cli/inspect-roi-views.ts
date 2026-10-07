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

const views = await client.bitable.appTableView.list({
  path: { app_token: appToken, table_id: table.table_id },
  params: { page_size: 100 },
});
if (views.code && views.code !== 0) throw new Error(`${views.code}: ${views.msg}`);

if (process.argv.includes("--list-only")) {
  console.log(JSON.stringify({ tableId: table.table_id, views: views.data?.items ?? [] }, null, 2));
  process.exit(0);
}

const details = [];
for (const view of views.data?.items ?? []) {
  const detail = await client.bitable.appTableView.get({
    path: {
      app_token: appToken,
      table_id: table.table_id,
      view_id: view.view_id,
    },
  });
  details.push({
    list: view,
    get: detail,
  });
}

console.log(JSON.stringify({ tableId: table.table_id, views: details }, null, 2));
