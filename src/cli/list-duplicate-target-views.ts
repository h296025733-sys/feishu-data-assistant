import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

const registry = new TenantRegistry(getEnv());
for (const tenant of registry.all()) {
  const client = createFeishuClient(tenant.env) as any;
  const tablesResponse = await client.bitable.appTable.list({
    path: { app_token: tenant.env.FEISHU_BITABLE_APP_TOKEN },
    params: { page_size: 100 },
  });
  assertFeishuResponse(tablesResponse, "读取表清单");
  const targets = new Set([tenant.profile.tables.cooperation, tenant.profile.tables.online]);
  const tables = (tablesResponse.data?.items ?? []).filter((item: any) => targets.has(String(item.name ?? "")));
  const output: any[] = [];
  for (const table of tables) {
    const viewsResponse = await client.bitable.appTableView.list({
      path: { app_token: tenant.env.FEISHU_BITABLE_APP_TOKEN, table_id: String(table.table_id) },
      params: { page_size: 100 },
    });
    assertFeishuResponse(viewsResponse, "读取视图清单");
    output.push({
      tableName: table.name,
      tableId: table.table_id,
      views: (viewsResponse.data?.items ?? []).map((view: any) => ({
        viewId: view.view_id,
        viewName: view.view_name,
        viewType: view.view_type,
      })),
    });
  }
  console.log(JSON.stringify({ tenant: tenant.binding.id, baseUrl: tenant.env.FEISHU_BITABLE_URL, tables: output }, null, 2));
}
