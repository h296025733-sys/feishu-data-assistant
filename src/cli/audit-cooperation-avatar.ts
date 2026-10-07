import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

const result = [];
for (const tenant of new TenantRegistry(getEnv()).all().filter(t => t.binding.id.endsWith("-formal"))) {
  const client = createFeishuClient(tenant.env);
  const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
  const tables = await client.bitable.appTable.list({ path: { app_token: appToken }, params: { page_size: 100 } });
  assertFeishuResponse(tables, "Cooperation avatar table list");
  const matches = (tables.data?.items ?? []).filter(t => t.name === tenant.profile.tables.cooperation);
  if (matches.length !== 1 || !matches[0].table_id) throw new Error(`Ambiguous cooperation table ${tenant.binding.id}`);
  const tableId = matches[0].table_id;
  const apiPath = { app_token: appToken, table_id: tableId };
  const fields = await client.bitable.appTableField.list({ path: apiPath, params: { page_size: 100 } });
  assertFeishuResponse(fields, "Cooperation avatar fields");
  if (fields.data?.has_more) throw new Error(`Incomplete field list ${tenant.binding.id}`);
  const views = await client.bitable.appTableView.list({ path: apiPath, params: { page_size: 100 } });
  assertFeishuResponse(views, "Cooperation avatar views");
  if (views.data?.has_more) throw new Error(`Incomplete view list ${tenant.binding.id}`);
  const rows = [];
  let pageToken: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await client.bitable.appTableRecord.list({ path: apiPath,
      params: { page_size: 500, page_token: pageToken } });
    assertFeishuResponse(page, "Cooperation avatar records");
    rows.push(...page.data?.items ?? []);
    if (!page.data?.has_more) break;
    pageToken = page.data.page_token;
    if (!pageToken || seen.has(pageToken)) throw new Error(`Record pagination loop ${tenant.binding.id}`);
    seen.add(pageToken);
  } while (true);
  const fieldList = (fields.data?.items ?? []).map(f => ({ id: f.field_id, name: f.field_name,
    type: f.type, uiType: f.ui_type }));
  const item = { tenant: tenant.binding.id, appToken, tableId, fieldList,
    views: (views.data?.items ?? []).map(v => ({ id: v.view_id, name: v.view_name, type: v.view_type, property: v.property })),
    rows };
  result.push(item);
  console.log(JSON.stringify({ tenant: item.tenant, tableId, rowCount: rows.length, fields: fieldList,
    views: item.views, samples: rows.slice(0, 2).map(r => ({ id: r.record_id,
      creator: r.fields?.红人姓名, homepage: r.fields?.主页, avatar: r.fields?.红人头像 })) }));
}
const dir = path.resolve(".runtime/cooperation-avatar");
await mkdir(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = path.join(dir, `audit-${stamp}.json`);
await writeFile(file, JSON.stringify({ at: new Date().toISOString(), result }, null, 2));
console.log(`evidence=${file}`);
