import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env) as any;
const appToken = env.FEISHU_BITABLE_APP_TOKEN;

function assertOk(response: any, action: string): void {
  if (response?.code && response.code !== 0) {
    throw new Error(
      `${action}失败（${response.code}）：${response.msg ?? "未知错误"}`,
    );
  }
}

const tables = await client.bitable.appTable.list({
  path: { app_token: appToken },
  params: { page_size: 100 },
});
assertOk(tables, "读取数据表");
const table = (tables.data?.items ?? []).find(
  (item: any) => item.name === "投产比",
);
if (!table?.table_id) {
  throw new Error("未找到“投产比”数据表");
}
const tableId = String(table.table_id);

const listedFields = await client.bitable.appTableField.list({
  path: { app_token: appToken, table_id: tableId },
  params: { page_size: 100 },
});
assertOk(listedFields, "读取字段");
const fields = listedFields.data?.items ?? [];
const primary = fields.find((field: any) => field.is_primary);
const date = fields.find((field: any) => field.field_name === "日期");
if (!primary?.field_id || !date?.field_id) {
  throw new Error("未找到索引列或日期字段");
}

const primaryUpdate = await client.bitable.appTableField.update({
  path: {
    app_token: appToken,
    table_id: tableId,
    field_id: primary.field_id,
  },
  data: {
    field_name: "记录",
    type: 20,
    ui_type: "Formula",
    property: {
      formatter: "",
      formula_expression: '""',
    },
  },
});
assertOk(primaryUpdate, "把索引列改为空白记录列");

const views = await client.bitable.appTableView.list({
  path: { app_token: appToken, table_id: tableId },
  params: { page_size: 100 },
});
assertOk(views, "读取视图");

for (const view of views.data?.items ?? []) {
  if (!view.view_id || !view.view_name) continue;
  const detail = await client.bitable.appTableView.get({
    path: {
      app_token: appToken,
      table_id: tableId,
      view_id: view.view_id,
    },
  });
  assertOk(detail, `读取视图“${view.view_name}”`);
  const hidden: string[] = detail.data?.view?.property?.hidden_fields ?? [];
  const nextHidden = hidden.filter((fieldId) => fieldId !== date.field_id);
  const property: Record<string, unknown> = { hidden_fields: nextHidden };
  if (detail.data?.view?.property?.filter_info) {
    property.filter_info = detail.data.view.property.filter_info;
  }
  const patched = await client.bitable.appTableView.patch({
    path: {
      app_token: appToken,
      table_id: tableId,
      view_id: view.view_id,
    },
    data: {
      view_name: view.view_name,
      property,
    },
  });
  assertOk(patched, `显示视图“${view.view_name}”的日期字段`);
}

const verifiedFields = await client.bitable.appTableField.list({
  path: { app_token: appToken, table_id: tableId },
  params: { page_size: 100 },
});
assertOk(verifiedFields, "复核字段");
const verifiedPrimary = (verifiedFields.data?.items ?? []).find(
  (field: any) => field.is_primary,
);
if (
  verifiedPrimary?.field_name !== "记录" ||
  verifiedPrimary?.type !== 20 ||
  verifiedPrimary?.property?.formula_expression !== '""'
) {
  throw new Error("索引列复核失败");
}

console.log(
  JSON.stringify(
    {
      tableId,
      primary: "记录（空白只读）",
      editableDateVisibleIn: (views.data?.items ?? []).map(
        (view: any) => view.view_name,
      ),
    },
    null,
    2,
  ),
);
