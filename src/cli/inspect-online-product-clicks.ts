import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

const tenants = new TenantRegistry(getEnv());
for (const id of ["storetwo-formal", "storeone-formal", "storetwo-botanical-care-formal"]) {
  const tenant = tenants.byId(id);
  if (!tenant) throw new Error(`缺少店铺 ${id}`);
  const client = createFeishuClient(tenant.env);
  const tables = await client.bitable.appTable.list({ path: { app_token: tenant.env.FEISHU_BITABLE_APP_TOKEN }, params: { page_size: 100 } });
  assertFeishuResponse(tables, `${id} 表列表`);
  const table = tables.data?.items?.find((item) => item.name === tenant.profile.tables.online);
  if (!table?.table_id) throw new Error(`${id} 缺少红人上线表`);
  const path = { app_token: tenant.env.FEISHU_BITABLE_APP_TOKEN, table_id: table.table_id };
  const fields = await client.bitable.appTableField.list({ path, params: { page_size: 100 } });
  assertFeishuResponse(fields, `${id} 字段`);
  if (fields.data?.has_more) throw new Error(`${id} 字段分页未读全`);
  const rows = [];
  let next: string | undefined;
  do {
    const response = await client.bitable.appTableRecord.list({ path, params: { page_size: 500, page_token: next } });
    assertFeishuResponse(response, `${id} 记录`);
    rows.push(...response.data?.items ?? []);
    next = response.data?.has_more ? response.data.page_token : undefined;
  } while (next);
  const names = (fields.data?.items ?? []).map((field) => ({ id: field.field_id, name: field.field_name, type: field.type, formatter: field.property?.formatter }));
  const focus = names.filter((field) => ["视频上线地址", "视频曝光K", "商品点击量", "售出数量", "实上线日期(Ct)"].includes(field.name));
  const clickId = names.find((field) => field.name === "商品点击量")?.id;
  const viewList = await client.bitable.appTableView.list({ path, params: { page_size: 100 } });
  assertFeishuResponse(viewList, `${id} 视图`);
  if (viewList.data?.has_more) throw new Error(`${id} 视图分页未读全`);
  const views = [];
  for (const view of viewList.data?.items ?? []) {
    if (!view.view_id) continue;
    const response = await client.bitable.appTableView.get({ path: { ...path, view_id: view.view_id } });
    assertFeishuResponse(response, `${id} 视图字段`);
    views.push({ name: view.view_name, clickVisible: clickId ? !(response.data?.view?.property?.hidden_fields ?? []).includes(clickId) : null });
  }
  const videos = rows.filter((row) => /\/video\/\d{10,}/.test(String((row.fields?.视频上线地址 as { link?: string } | undefined)?.link ?? "")));
  const published = videos.map((row) => Number(row.fields?.["实上线日期(Ct)"])).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  const recentCount = videos.filter((row) => Number(row.fields?.["实上线日期(Ct)"]) >= Date.parse("2026-09-13T00:00:00Z")).length;
  console.log(JSON.stringify({ tenant: id, base: tenant.env.FEISHU_BITABLE_APP_TOKEN, tableId: table.table_id,
    rowCount: rows.length, videoCount: videos.length, recentCount, earliestPublished: published.length ? new Date(published[0]!).toISOString() : null,
    latestPublished: published.length ? new Date(published.at(-1)!).toISOString() : null, focus, views, order: names.map((field) => field.name),
    dateSample: videos.slice(0, 3).map((row) => row.fields?.["实上线日期(Ct)"]) }));
}
