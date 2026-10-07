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

const [fieldResponse, viewResponse] = await Promise.all([
  client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: table.table_id },
    params: { page_size: 100 },
  }),
  client.bitable.appTableView.list({
    path: { app_token: appToken, table_id: table.table_id },
    params: { page_size: 100 },
  }),
]);
if (fieldResponse.code && fieldResponse.code !== 0) {
  throw new Error(`${fieldResponse.code}: ${fieldResponse.msg}`);
}
if (viewResponse.code && viewResponse.code !== 0) {
  throw new Error(`${viewResponse.code}: ${viewResponse.msg}`);
}

const fieldIds = Object.fromEntries(
  (fieldResponse.data?.items ?? []).map((field: any) => [field.field_name, field.field_id]),
);
const monthView = (viewResponse.data?.items ?? []).find(
  (view: any) => view.view_name === "月度汇总",
);
if (!monthView?.view_id) throw new Error("未找到月度汇总视图");

const detail = await client.bitable.appTableView.get({
  path: {
    app_token: appToken,
    table_id: table.table_id,
    view_id: monthView.view_id,
  },
});
if (detail.code && detail.code !== 0) throw new Error(`${detail.code}: ${detail.msg}`);

const reveal = new Set([fieldIds["周"], fieldIds["星期"]].filter(Boolean));
const hidden = detail.data?.view?.property?.hidden_fields ?? [];
const nextHidden = hidden.filter((fieldId: string) => !reveal.has(fieldId));
const updated = await client.bitable.appTableView.patch({
  path: {
    app_token: appToken,
    table_id: table.table_id,
    view_id: monthView.view_id,
  },
  data: {
    view_name: "月度汇总",
    property: { hidden_fields: nextHidden },
  },
});
if (updated.code && updated.code !== 0) throw new Error(`${updated.code}: ${updated.msg}`);

const verified = await client.bitable.appTableView.get({
  path: {
    app_token: appToken,
    table_id: table.table_id,
    view_id: monthView.view_id,
  },
});
if (verified.code && verified.code !== 0) throw new Error(`${verified.code}: ${verified.msg}`);
const remaining = verified.data?.view?.property?.hidden_fields ?? [];
if ([...reveal].some((fieldId) => remaining.includes(fieldId))) {
  throw new Error("周或星期仍被隐藏");
}

console.log(JSON.stringify({
  tableId: table.table_id,
  viewId: monthView.view_id,
  visible: ["周", "星期"],
  preservedHiddenFields: remaining.length,
}, null, 2));
