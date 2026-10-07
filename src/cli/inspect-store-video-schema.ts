import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

const tenantId = process.argv[2];
if (!tenantId || !["storeone-formal", "storetwo-formal", "storetwo-botanical-care-formal", "storethree-formal", "storetwo-llc-formal"].includes(tenantId)) {
  throw new Error("Specify a supported formal video-analysis tenant");
}
const tenant = new TenantRegistry(getEnv()).byId(tenantId);
if (!tenant) throw new Error(`Tenant unavailable: ${tenantId}`);
const client = createFeishuClient(tenant.env);
const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
const tables = [];
let next: string | undefined;
do {
  const response = await client.bitable.appTable.list({
    path: { app_token: appToken }, params: { page_size: 100, page_token: next },
  });
  assertFeishuResponse(response, `${tenantId} table list`);
  tables.push(...response.data?.items ?? []);
  next = response.data?.has_more ? response.data.page_token : undefined;
} while (next);
const result = [];
for (const tableName of [tenant.profile.tables.online, "短视频数据表"]) {
  const table = tables.find((item) => item.name === tableName);
  if (!table?.table_id) throw new Error(`${tenantId} missing ${tableName}`);
  const fields = [];
  let pageToken: string | undefined;
  do {
    const response = await client.bitable.appTableField.list({
      path: { app_token: appToken, table_id: table.table_id },
      params: { page_size: 100, page_token: pageToken },
    });
    assertFeishuResponse(response, `${tenantId} ${tableName} field list`);
    fields.push(...response.data?.items ?? []);
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  result.push({ tableName, tableId: table.table_id, fields: fields.map((field) => ({
    name: field.field_name, id: field.field_id, type: field.type, uiType: field.ui_type,
    property: ["视频内容分析", "投广建议", "视频修改建议"].includes(field.field_name ?? "")
      ? field.property : undefined,
  })) });
}
console.log(JSON.stringify({ at: new Date().toISOString(), tenantId, appToken, result }, null, 2));
