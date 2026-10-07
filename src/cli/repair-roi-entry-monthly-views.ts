import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env) as any;
const appToken = env.FEISHU_BITABLE_APP_TOKEN;
if (!appToken) throw new Error("缺少 FEISHU_BITABLE_APP_TOKEN");

function assertOk(response: any, action: string): void {
  if (response.code && response.code !== 0) {
    throw new Error(`${action}失败（${response.code}）：${response.msg}`);
  }
}

const tables = await client.bitable.appTable.list({
  path: { app_token: appToken },
  params: { page_size: 100 },
});
assertOk(tables, "读取数据表");
const table = tables.data?.items?.find((item: any) => item.name === "投产比");
if (!table?.table_id) throw new Error("未找到投产比");
const tableId = table.table_id;

const fieldsResponse = await client.bitable.appTableField.list({
  path: { app_token: appToken, table_id: tableId },
  params: { page_size: 100 },
});
assertOk(fieldsResponse, "读取字段");
const fields: any[] = fieldsResponse.data?.items ?? [];
const fieldIds = Object.fromEntries(
  fields.map((field) => [field.field_name, field.field_id]),
);
const allFieldIds = fields.map((field) => field.field_id).filter(Boolean);
if (!fieldIds["商品"]) throw new Error("投产比缺少商品字段");

async function listViews(): Promise<any[]> {
  const response = await client.bitable.appTableView.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: 100 },
  });
  assertOk(response, "读取视图");
  return response.data?.items ?? [];
}

async function ensureView(
  name: string,
  type: "grid",
  aliases: string[] = [],
): Promise<any> {
  const views = await listViews();
  const found = views.find((view) =>
    [name, ...aliases].includes(view.view_name),
  );
  if (found) {
    if (found.view_name !== name) {
      const renamed = await client.bitable.appTableView.patch({
        path: {
          app_token: appToken,
          table_id: tableId,
          view_id: found.view_id,
        },
        data: { view_name: name },
      });
      assertOk(renamed, `重命名视图为${name}`);
    }
    return { ...found, view_name: name };
  }
  const created = await client.bitable.appTableView.create({
    path: { app_token: appToken, table_id: tableId },
    data: { view_name: name, view_type: type },
  });
  assertOk(created, `创建视图${name}`);
  return created.data?.view;
}

function hiddenExcept(visibleNames: string[]): string[] {
  const visibleIds = new Set(
    visibleNames.map((name) => fieldIds[name]).filter(Boolean),
  );
  return allFieldIds.filter((fieldId) => !visibleIds.has(fieldId));
}

async function configureGridView(
  view: any,
  visibleNames: string[],
  operator: "is" | "isNot",
): Promise<void> {
  const response = await client.bitable.appTableView.patch({
    path: {
      app_token: appToken,
      table_id: tableId,
      view_id: view.view_id,
    },
    data: {
      view_name: view.view_name,
      property: {
        hidden_fields: hiddenExcept(visibleNames),
        filter_info: {
          conjunction: "and",
          conditions: [{
            field_id: fieldIds["商品"],
            operator,
            value: JSON.stringify(["TechWave"]),
          }],
        },
      },
    },
  });
  assertOk(response, `配置视图${view.view_name}`);
}

const storeMonthly = await ensureView("店铺月度", "grid", ["月度汇总"]);
const productMonthly = await ensureView("商品月度", "grid");
const obsoleteEntryForm = (await listViews()).find(
  (view) =>
    ["新增商品", "经营录入"].includes(view.view_name) &&
    view.view_type === "form",
);
if (obsoleteEntryForm?.view_id) {
  const deleted = await client.bitable.appTableView.delete({
    path: {
      app_token: appToken,
      table_id: tableId,
      view_id: obsoleteEntryForm.view_id,
    },
  });
  assertOk(deleted, "删除不适合的新增商品表单视图");
}
const entryView = await ensureView("经营录入", "grid");

await configureGridView(
  storeMonthly,
  [
    "检查", "商品", "日期", "月份", "周", "星期",
    "合作量", "上线量", "店铺浏览量", "总单量", "总数量", "转化率",
    "达人出单量", "店铺商品卡出单量", "店铺销售额", "出单视频",
    "总广告出单量", "总广告花费",
    "雅岚广告花费", "雅岚广告出单量",
    "金凯悦-10广告花费", "金凯悦-10广告出单量",
    "金凯悦-11广告花费", "金凯悦-11广告出单量",
    "GMV Max花费", "GMV Max广告出单量", "退货量", "备注",
  ],
  "is",
);

await configureGridView(
  productMonthly,
  [
    "检查", "商品", "日期", "月份", "周", "星期",
    "合作量", "上线量", "单量", "数量",
    "达人出单量", "达人出单数量",
    "商品卡出单量", "商品卡出单数量", "销售额",
  ],
  "isNot",
);

const entryVisibleNames = [
  "检查", "商品", "日期",
  "单量", "数量",
  "商品卡出单量", "商品卡出单数量", "销售额",
  "出单视频", "自孵化出单量", "自孵化上线量", "备注",
];
await configureGridView(
  entryView,
  entryVisibleNames,
  "isNot",
);

const recordsResponse = await client.bitable.appTableRecord.list({
  path: { app_token: appToken, table_id: tableId },
  params: { page_size: 500, automatic_fields: true },
});
assertOk(recordsResponse, "读取空白占位记录");
const formulaFields = new Set(
  fields
    .filter((field) => field.ui_type === "Formula" || field.type === 20)
    .map((field) => field.field_name),
);
const emptyAnchorIds = (recordsResponse.data?.items ?? [])
  .filter((record: any) => !record.fields?.日期 && record.fields?.商品)
  .filter((record: any) =>
    Object.entries(record.fields ?? {}).every(([name, value]) =>
      name === "商品" ||
      formulaFields.has(name) ||
      value === null ||
      value === undefined ||
      value === "",
    ),
  )
  .map((record: any) => record.record_id)
  .filter(Boolean);

if (emptyAnchorIds.length) {
  const deleted = await client.bitable.appTableRecord.batchDelete({
    path: { app_token: appToken, table_id: tableId },
    data: { records: emptyAnchorIds },
  });
  assertOk(deleted, "删除无用空白占位记录");
}

console.log(JSON.stringify({
  tableId,
  views: {
    storeMonthly: storeMonthly.view_id,
    productMonthly: productMonthly.view_id,
    entry: entryView.view_id,
  },
  entryVisibleFields: entryVisibleNames.filter((name) => fieldIds[name]),
  deletedEmptyAnchors: emptyAnchorIds,
  manualLayoutRemaining: [
    "商品月度：按商品、月份分组",
    "店铺月度：按月份分组",
  ],
}, null, 2));
