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
assertOk(fieldResponse, "读取字段");
assertOk(viewResponse, "读取视图");

const fields: any[] = fieldResponse.data?.items ?? [];
const views: any[] = viewResponse.data?.items ?? [];
const fieldIds = Object.fromEntries(
  fields.map((field) => [field.field_name, field.field_id]),
);
const allFieldIds = fields.map((field) => field.field_id).filter(Boolean);
const primaryFieldId =
  fields.find((field) => field.is_primary)?.field_id ??
  fields[0]?.field_id;

const overview = views.find((view) => view.view_name === "经营总览");
if (overview?.view_id) {
  const deleted = await client.bitable.appTableView.delete({
    path: {
      app_token: appToken,
      table_id: tableId,
      view_id: overview.view_id,
    },
  });
  assertOk(deleted, "删除冗余经营总览");
}

const entry = views.find((view) =>
  ["经营录入", "商品录入"].includes(view.view_name),
);
if (!entry?.view_id) throw new Error("未找到商品录入视图");
if (entry.view_name !== "商品录入") {
  const renamed = await client.bitable.appTableView.patch({
    path: {
      app_token: appToken,
      table_id: tableId,
      view_id: entry.view_id,
    },
    data: { view_name: "商品录入" },
  });
  assertOk(renamed, "重命名商品录入视图");
  entry.view_name = "商品录入";
}

const visibleByView: Record<string, string[]> = {
  商品录入: [
    "检查", "商品", "日期",
    "单量", "数量", "商品卡出单量", "商品卡出单数量", "销售额",
    "出单视频", "自孵化出单量", "自孵化上线量", "备注",
  ],
  商品每日: [
    "检查", "日期", "星期", "合作量", "上线量",
    "单量", "数量", "达人出单量", "达人出单数量",
    "商品卡出单量", "商品卡出单数量", "销售额",
    "出单视频", "自孵化出单量", "自孵化上线量", "备注",
  ],
  店铺每日: [
    "检查", "日期", "星期", "合作量", "上线量",
    "店铺浏览量", "总单量", "总数量", "转化率",
    "达人出单量", "店铺商品卡出单量", "店铺销售额", "出单视频",
    "总广告出单量", "总广告花费",
    "雅岚广告花费", "雅岚广告出单量",
    "金凯悦-10广告花费", "金凯悦-10广告出单量",
    "金凯悦-11广告花费", "金凯悦-11广告出单量",
    "GMV Max花费", "GMV Max广告出单量", "退货量", "备注",
  ],
  商品月度: [
    "检查", "日期", "合作量", "上线量",
    "单量", "数量", "达人出单量", "达人出单数量",
    "商品卡出单量", "商品卡出单数量", "销售额",
  ],
  店铺月度: [
    "检查", "日期", "合作量", "上线量", "店铺浏览量",
    "总单量", "总数量", "转化率", "达人出单量",
    "店铺商品卡出单量", "店铺销售额", "出单视频",
    "总广告出单量", "总广告花费",
    "雅岚广告花费", "雅岚广告出单量",
    "金凯悦-10广告花费", "金凯悦-10广告出单量",
    "金凯悦-11广告花费", "金凯悦-11广告出单量",
    "GMV Max花费", "GMV Max广告出单量", "退货量",
  ],
};

const refreshedViews = await client.bitable.appTableView.list({
  path: { app_token: appToken, table_id: tableId },
  params: { page_size: 100 },
});
assertOk(refreshedViews, "重新读取视图");
for (const view of refreshedViews.data?.items ?? []) {
  const visibleNames = visibleByView[view.view_name];
  if (!visibleNames) continue;
  const visibleIds = new Set(
    visibleNames.map((name) => fieldIds[name]).filter(Boolean),
  );
  const updated = await client.bitable.appTableView.patch({
    path: {
      app_token: appToken,
      table_id: tableId,
      view_id: view.view_id,
    },
    data: {
      view_name: view.view_name,
      property: {
        hidden_fields: allFieldIds.filter(
          (fieldId) =>
            fieldId !== primaryFieldId &&
            !visibleIds.has(fieldId),
        ),
      },
    },
  });
  assertOk(updated, `优化视图${view.view_name}`);
}

const finalViews = await client.bitable.appTableView.list({
  path: { app_token: appToken, table_id: tableId },
  params: { page_size: 100 },
});
assertOk(finalViews, "验证视图");

const expectedHiddenByView: Record<string, string[]> = {
  商品每日: ["商品"],
  店铺每日: ["商品"],
  商品月度: ["商品", "月份"],
  店铺月度: ["商品", "月份"],
};
for (const view of finalViews.data?.items ?? []) {
  const expectedNames = expectedHiddenByView[view.view_name];
  if (!expectedNames) continue;
  const detail = await client.bitable.appTableView.get({
    path: {
      app_token: appToken,
      table_id: tableId,
      view_id: view.view_id,
    },
  });
  assertOk(detail, `验证视图${view.view_name}`);
  const hiddenIds = new Set(
    detail.data?.view?.property?.hidden_fields ?? [],
  );
  const missing = expectedNames.filter(
    (name) => !hiddenIds.has(fieldIds[name]),
  );
  if (missing.length > 0) {
    throw new Error(`${view.view_name}仍显示冗余字段：${missing.join("、")}`);
  }
}

console.log(JSON.stringify({
  tableId,
  deletedView: overview?.view_id ? "经营总览" : null,
  remainingViews: (finalViews.data?.items ?? []).map(
    (view: any) => view.view_name,
  ),
  responsibilities: {
    商品录入: "唯一商品人工录入入口",
    商品每日: "查看商品每日明细和公式",
    店铺每日: "填写店铺独有数据并检查店铺日汇总",
    商品月度: "查看商品月度与全部累计",
    店铺月度: "查看店铺月度与全部累计",
  },
}, null, 2));
