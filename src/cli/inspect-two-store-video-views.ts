import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import { videoAnalysisConfig } from "../video-analysis/storeone-source.js";

const registry = new TenantRegistry(getEnv());
for (const tenantId of ["storeone-formal", "storetwo-formal", "storetwo-botanical-care-formal"] as const) {
  const tenant = registry.byId(tenantId);
  if (!tenant) throw new Error(`Missing ${tenantId}`);
  const config = videoAnalysisConfig(tenantId);
  if (config.appToken !== tenant.env.FEISHU_BITABLE_APP_TOKEN) throw new Error("Base mismatch");
  const client = createFeishuClient(tenant.env);
  for (const [kind, tableId] of Object.entries(config.tables)) {
    const fieldResponse = await client.bitable.appTableField.list({
      path: { app_token: config.appToken, table_id: tableId }, params: { page_size: 100 },
    });
    assertFeishuResponse(fieldResponse, `${tenantId} ${kind} fields`);
    const names = new Map((fieldResponse.data?.items ?? []).map((field) => [field.field_id, field.field_name]));
    const viewResponse = await client.bitable.appTableView.list({
      path: { app_token: config.appToken, table_id: tableId }, params: { page_size: 100 },
    });
    assertFeishuResponse(viewResponse, `${tenantId} ${kind} views`);
    for (const view of viewResponse.data?.items ?? []) {
      if (!view.view_id || view.view_type !== "grid") continue;
      const response = await client.bitable.appTableView.get({
        path: { app_token: config.appToken, table_id: tableId, view_id: view.view_id },
      });
      assertFeishuResponse(response, `${tenantId} ${kind} view ${view.view_name}`);
      const property = response.data?.view?.property;
      console.log(JSON.stringify({ tenantId, kind, tableId, viewId: view.view_id,
        viewName: view.view_name, hiddenFields: (property?.hidden_fields ?? []).map((id) =>
          ({ id, name: names.get(id) ?? null })),
        propertyKeys: Object.keys(property ?? {}),
      }));
    }
  }
}
