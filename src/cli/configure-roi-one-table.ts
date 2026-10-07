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
const tableId = table.table_id;

async function fields(): Promise<any[]> {
  const response = await client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: 100 },
  });
  if (response.code && response.code !== 0) throw new Error(`${response.code}: ${response.msg}`);
  return response.data?.items ?? [];
}

let allFields = await fields();
let ids = Object.fromEntries(allFields.map((field: any) => [field.field_name, field.field_id]));
const ref = (name: string) => `bitable::$table[${tableId}].$field[${ids[name]}]`;
const weekdayExpression = `IF(${ref("日期")}="","",IF(WEEKDAY(${ref("日期")},2)=1,"星期一",IF(WEEKDAY(${ref("日期")},2)=2,"星期二",IF(WEEKDAY(${ref("日期")},2)=3,"星期三",IF(WEEKDAY(${ref("日期")},2)=4,"星期四",IF(WEEKDAY(${ref("日期")},2)=5,"星期五",IF(WEEKDAY(${ref("日期")},2)=6,"星期六","星期日")))))))`;
const weekday = allFields.find((field: any) => field.field_name === "星期");
const weekdayUpdate = await client.bitable.appTableField.update({
  path: { app_token: appToken, table_id: tableId, field_id: weekday.field_id },
  data: {
    field_name: "星期",
    type: 20,
    ui_type: "Formula",
    property: { formatter: "", formula_expression: weekdayExpression },
  },
});
if (weekdayUpdate.code && weekdayUpdate.code !== 0) {
  throw new Error(`更新中文星期失败：${weekdayUpdate.msg}`);
}

if (!ids["排序键"]) {
  const created = await client.bitable.appTableField.create({
    path: { app_token: appToken, table_id: tableId },
    data: {
      field_name: "排序键",
      type: 20,
      ui_type: "Formula",
      property: {
        formatter: "",
        formula_expression: `IF(${ref("商品")}="TechWave","000000","100000"&${ref("商品")})`,
      },
    },
  });
  if (created.code && created.code !== 0) throw new Error(`创建排序键失败：${created.msg}`);
}
allFields = await fields();
ids = Object.fromEntries(allFields.map((field: any) => [field.field_name, field.field_id]));

const viewsResponse = await client.bitable.appTableView.list({
  path: { app_token: appToken, table_id: tableId },
  params: { page_size: 100 },
});
if (viewsResponse.code && viewsResponse.code !== 0) {
  throw new Error(`${viewsResponse.code}: ${viewsResponse.msg}`);
}
const views: any[] = viewsResponse.data?.items ?? [];
const main = views.find((view) => view.view_name === "每日经营") ?? views[0];
if (!main?.view_id) throw new Error("未找到主视图");
const renamed = await client.bitable.appTableView.patch({
  path: { app_token: appToken, table_id: tableId, view_id: main.view_id },
  data: { view_name: "经营总览" },
});
if (renamed.code && renamed.code !== 0) throw new Error(`重命名主视图失败：${renamed.msg}`);

const wanted = ["店铺每日", "商品每日", "月度汇总"];
for (const name of wanted) {
  if (views.some((view) => view.view_name === name)) continue;
  const created = await client.bitable.appTableView.create({
    path: { app_token: appToken, table_id: tableId },
    data: { view_name: name, view_type: "grid" },
  });
  if (created.code && created.code !== 0) throw new Error(`创建视图“${name}”失败：${created.msg}`);
}

const refreshedViews = await client.bitable.appTableView.list({
  path: { app_token: appToken, table_id: tableId },
  params: { page_size: 100 },
});
if (refreshedViews.code && refreshedViews.code !== 0) {
  throw new Error(`${refreshedViews.code}: ${refreshedViews.msg}`);
}
const commonHidden = [
  "记录类型", "合作量源", "上线量源",
  "达人出单量源", "排序键",
];
const overviewHidden = [
  ...commonHidden,
  "商品卡出单数量", "达人出单数量", "自孵化出单量", "自孵化上线量",
  "雅岚广告花费", "雅岚广告出单量",
  "金凯悦-10广告花费", "金凯悦-10广告出单量",
  "金凯悦-11广告花费", "金凯悦-11广告出单量",
  "GMV Max花费", "GMV Max广告出单量",
];
const storeHidden = [
  ...commonHidden, "单量", "数量", "商品卡出单量", "商品卡出单数量",
  "销售额", "达人出单数量", "自孵化出单量", "自孵化上线量",
];
const productHidden = [
  ...commonHidden, "总单量", "总数量", "店铺商品卡出单量", "店铺销售额",
  "店铺浏览量", "转化率", "总广告出单量", "总广告花费",
  "雅岚广告花费", "雅岚广告出单量",
  "金凯悦-10广告花费", "金凯悦-10广告出单量",
  "金凯悦-11广告花费", "金凯悦-11广告出单量",
  "GMV Max花费", "GMV Max广告出单量", "退货量",
];
const definitions: Record<string, { hidden: string[]; filter?: any }> = {
  经营总览: { hidden: overviewHidden },
  店铺每日: {
    hidden: storeHidden,
    filter: {
      conjunction: "and",
      conditions: [{
        field_id: ids["商品"],
        operator: "is",
        value: JSON.stringify(["TechWave"]),
      }],
    },
  },
  商品每日: {
    hidden: productHidden,
    filter: {
      conjunction: "and",
      conditions: [{
        field_id: ids["商品"],
        operator: "isNot",
        value: JSON.stringify(["TechWave"]),
      }],
    },
  },
  月度汇总: { hidden: commonHidden },
};
for (const view of refreshedViews.data?.items ?? []) {
  const definition = definitions[view.view_name];
  if (!definition) continue;
  const response = await client.bitable.appTableView.patch({
    path: { app_token: appToken, table_id: tableId, view_id: view.view_id },
    data: {
      view_name: view.view_name,
      property: {
        hidden_fields: definition.hidden.map((name) => ids[name]).filter(Boolean),
        ...(definition.filter ? { filter_info: definition.filter } : {}),
      },
    },
  });
  if (response.code && response.code !== 0) {
    throw new Error(`配置视图“${view.view_name}”失败（${response.code}）：${response.msg}`);
  }
}
console.log("单表四视图及辅助字段已配置");
