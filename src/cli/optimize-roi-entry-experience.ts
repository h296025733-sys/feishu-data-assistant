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
if (!table?.table_id) throw new Error("未找到“投产比”数据表");
const tableId = String(table.table_id);

const listedFields = await client.bitable.appTableField.list({
  path: { app_token: appToken, table_id: tableId },
  params: { page_size: 100 },
});
assertOk(listedFields, "读取字段");
const fields = listedFields.data?.items ?? [];
const byName = new Map<string, any>(
  fields.map((field: any) => [String(field.field_name), field]),
);
const primary = fields.find((field: any) => field.is_primary);
if (!primary?.field_id) throw new Error("未找到主字段");

function fieldId(name: string): string {
  const field = byName.get(name);
  if (!field?.field_id) throw new Error(`缺少字段“${name}”`);
  return String(field.field_id);
}

function self(name: string): string {
  return `bitable::$table[${tableId}].$field[${fieldId(name)}]`;
}

function current(name: string): string {
  return `CurrentValue.$column[${fieldId(name)}]`;
}

const product = self("商品");
const date = self("日期");
const duplicateCount =
  `bitable::$table[${tableId}].COUNTIF(AND(` +
  `${current("商品")}=${product},` +
  `TEXT(${current("日期")},"YYYY-MM-DD")=TEXT(${date},"YYYY-MM-DD")))`;
const productNegative = [
  "单量",
  "数量",
  "商品卡出单量",
  "商品卡出单数量",
  "销售额",
  "出单视频",
  "自孵化出单量",
  "自孵化上线量",
].map((name) => `${self(name)}<0`).join(",");
const storeNegative = [
  "店铺浏览量",
  "出单视频",
  "雅岚广告花费",
  "雅岚广告出单量",
  "金凯悦-10广告花费",
  "金凯悦-10广告出单量",
  "金凯悦-11广告花费",
  "金凯悦-11广告出单量",
  "GMV Max花费",
  "GMV Max广告出单量",
  "退货量",
].map((name) => `${self(name)}<0`).join(",");
const productBlank = [
  "单量",
  "数量",
  "商品卡出单量",
  "商品卡出单数量",
  "销售额",
  "出单视频",
  "自孵化出单量",
  "自孵化上线量",
].map((name) => `${self(name)}=""`).join(",");

const expression =
  `IF(OR(${product}="",${date}=""),"待录入",` +
  `IF(${duplicateCount}>1,"⚠ 重复",` +
  `IF(${product}="TechWave",` +
  `IF(OR(${storeNegative}),"⚠ 负数","✓"),` +
  `IF(OR(${productNegative}),"⚠ 负数",` +
  `IF(OR(${self("商品卡出单量")}>${self("单量")},` +
  `${self("商品卡出单数量")}>${self("数量")}),"⚠ 商品卡超过总数",` +
  `IF(AND(${productBlank}),"待补数据","✓"))))))`;

const updated = await client.bitable.appTableField.update({
  path: {
    app_token: appToken,
    table_id: tableId,
    field_id: primary.field_id,
  },
  data: {
    field_name: "检查",
    type: 20,
    ui_type: "Formula",
    property: {
      formatter: "",
      formula_expression: expression,
    },
  },
});
assertOk(updated, "更新投产比录入检查");

const verify = await client.bitable.appTableField.list({
  path: { app_token: appToken, table_id: tableId },
  params: { page_size: 100 },
});
assertOk(verify, "复核投产比录入检查");
const verifiedPrimary = (verify.data?.items ?? []).find(
  (field: any) => field.is_primary,
);
if (
  verifiedPrimary?.field_name !== "检查" ||
  verifiedPrimary?.property?.formula_expression !== expression
) {
  throw new Error("投产比录入检查写后复核失败");
}

console.log(
  JSON.stringify(
    {
      tableId,
      field: "检查",
      meanings: {
        "✓": "当前记录通过基础检查",
        待录入: "商品或日期尚未填写",
        待补数据: "商品日期已有，但经营值尚未填写",
        "⚠ 重复": "同一商品与日期出现多条记录",
        "⚠ 负数": "发现负数",
        "⚠ 商品卡超过总数": "商品卡订单或数量超过对应总数",
      },
    },
    null,
    2,
  ),
);
