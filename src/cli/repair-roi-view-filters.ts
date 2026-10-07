import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env) as any;
const appToken = env.FEISHU_BITABLE_APP_TOKEN;

function assertOk(response: any, action: string): void {
  if (response?.code && response.code !== 0) {
    throw new Error(`${action}失败（${response.code}）：${response.msg ?? "未知错误"}`);
  }
}

const tables = await client.bitable.appTable.list({
  path: { app_token: appToken },
  params: { page_size: 100 },
});
assertOk(tables, "读取数据表");
const table = (tables.data?.items ?? []).find((item: any) => item.name === "投产比");
if (!table?.table_id) throw new Error("未找到“投产比”数据表");
const tableId = String(table.table_id);

const fields = await client.bitable.appTableField.list({
  path: { app_token: appToken, table_id: tableId },
  params: { page_size: 100 },
});
assertOk(fields, "读取字段");
const product = (fields.data?.items ?? []).find((field: any) => field.field_name === "商品");
if (!product?.field_id) throw new Error("未找到新的“商品”字段");

const views = await client.bitable.appTableView.list({
  path: { app_token: appToken, table_id: tableId },
  params: { page_size: 100 },
});
assertOk(views, "读取视图");

const operators: Record<string, string> = {
  店铺每日: "is",
  商品每日: "isNot",
};
for (const view of views.data?.items ?? []) {
  const operator = operators[view.view_name];
  if (!operator || !view.view_id) continue;
  const detail = await client.bitable.appTableView.get({
    path: {
      app_token: appToken,
      table_id: tableId,
      view_id: view.view_id,
    },
  });
  assertOk(detail, `读取视图“${view.view_name}”`);
  const hidden = detail.data?.view?.property?.hidden_fields ?? [];
  const response = await client.bitable.appTableView.patch({
    path: {
      app_token: appToken,
      table_id: tableId,
      view_id: view.view_id,
    },
    data: {
      view_name: view.view_name,
      property: {
        hidden_fields: hidden,
        filter_info: {
          conjunction: "and",
          conditions: [{
            field_id: product.field_id,
            operator,
            value: JSON.stringify(["TechWave"]),
          }],
        },
      },
    },
  });
  assertOk(response, `恢复视图“${view.view_name}”筛选`);
}

console.log(JSON.stringify({
  tableId,
  productFieldId: product.field_id,
  repaired: ["店铺每日：商品等于 TechWave", "商品每日：商品不等于 TechWave"],
}, null, 2));
