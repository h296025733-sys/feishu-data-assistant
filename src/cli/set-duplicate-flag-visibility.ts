import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import { duplicateTargetsForProfile } from "../feishu/duplicate-cell-flags.js";

const mode = process.argv.includes("--show") ? "show" : process.argv.includes("--hide") ? "hide" : null;
if (!mode) throw new Error("请传入 --show 或 --hide");

const registry = new TenantRegistry(getEnv());
for (const tenant of registry.all()) {
  const client = createFeishuClient(tenant.env) as any;
  const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
  const tableResponse = await client.bitable.appTable.list({
    path: { app_token: appToken },
    params: { page_size: 100 },
  });
  assertFeishuResponse(tableResponse, `${tenant.binding.id} 读取表清单`);
  const tableByName = new Map<string, string>(
    (tableResponse.data?.items ?? []).map((item: any) => [String(item.name ?? ""), String(item.table_id ?? "")]),
  );
  const wantedTables = new Set([tenant.profile.tables.cooperation, tenant.profile.tables.online]);
  const targetsByTable = new Map<string, Set<string>>();
  for (const target of duplicateTargetsForProfile(tenant.profile)) {
    if (!wantedTables.has(target.tableName)) continue;
    const names = targetsByTable.get(target.tableName) ?? new Set<string>();
    names.add(target.flagFieldName);
    targetsByTable.set(target.tableName, names);
  }

  for (const [tableName, flagNames] of targetsByTable) {
    const tableId = tableByName.get(tableName);
    if (!tableId) throw new Error(`${tenant.binding.id} 未找到 ${tableName}`);
    const [fieldResponse, viewResponse] = await Promise.all([
      client.bitable.appTableField.list({
        path: { app_token: appToken, table_id: tableId },
        params: { page_size: 100 },
      }),
      client.bitable.appTableView.list({
        path: { app_token: appToken, table_id: tableId },
        params: { page_size: 100 },
      }),
    ]);
    assertFeishuResponse(fieldResponse, `${tenant.binding.id} 读取 ${tableName} 字段`);
    assertFeishuResponse(viewResponse, `${tenant.binding.id} 读取 ${tableName} 视图`);
    const fieldIds = new Map<string, string>(
      (fieldResponse.data?.items ?? []).map((field: any) => [String(field.field_name ?? ""), String(field.field_id ?? "")]),
    );
    const flagIds = [...flagNames].map((name) => {
      const fieldId = fieldIds.get(name);
      if (!fieldId) throw new Error(`${tenant.binding.id} ${tableName} 缺少 ${name}`);
      return fieldId;
    });
    for (const view of viewResponse.data?.items ?? []) {
      if (view.view_type !== "grid" || !view.view_id) continue;
      const detail = await client.bitable.appTableView.get({
        path: { app_token: appToken, table_id: tableId, view_id: String(view.view_id) },
      });
      assertFeishuResponse(detail, `${tenant.binding.id} 读取 ${tableName}/${view.view_name}`);
      const current = new Set<string>(detail.data?.view?.property?.hidden_fields ?? []);
      if (mode === "show") flagIds.forEach((fieldId) => current.delete(fieldId));
      else flagIds.forEach((fieldId) => current.add(fieldId));
      const update = await client.bitable.appTableView.patch({
        path: { app_token: appToken, table_id: tableId, view_id: String(view.view_id) },
        data: {
          view_name: String(view.view_name ?? "表格"),
          property: { hidden_fields: [...current] },
        },
      });
      assertFeishuResponse(update, `${tenant.binding.id} ${mode} ${tableName}/${view.view_name} 重复标记字段`);
      const verified = await client.bitable.appTableView.get({
        path: { app_token: appToken, table_id: tableId, view_id: String(view.view_id) },
      });
      assertFeishuResponse(verified, `${tenant.binding.id} 回读 ${tableName}/${view.view_name}`);
      const hidden = new Set<string>(verified.data?.view?.property?.hidden_fields ?? []);
      const ok = mode === "show"
        ? flagIds.every((fieldId) => !hidden.has(fieldId))
        : flagIds.every((fieldId) => hidden.has(fieldId));
      if (!ok) throw new Error(`${tenant.binding.id} ${tableName}/${view.view_name} 可见性回读不一致`);
      console.log(JSON.stringify({
        tenant: tenant.binding.id,
        tableName,
        viewName: view.view_name,
        mode,
        flagFields: [...flagNames],
        verified: true,
      }));
    }
  }
}
