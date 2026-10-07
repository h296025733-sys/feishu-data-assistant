import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env) as any;
const tables = await client.bitable.appTable.list({
  path: { app_token: env.FEISHU_BITABLE_APP_TOKEN },
  params: { page_size: 100 },
});
if (tables.code && tables.code !== 0) throw new Error(`${tables.code}: ${tables.msg}`);
const table = tables.data?.items?.find((item: any) => item.name === "投产比");
if (!table?.table_id) throw new Error("未找到投产比");
const records = await client.bitable.appTableRecord.list({
  path: { app_token: env.FEISHU_BITABLE_APP_TOKEN, table_id: table.table_id },
  params: { page_size: 500, automatic_fields: true },
});
if (records.code && records.code !== 0) throw new Error(`${records.code}: ${records.msg}`);
const fields = [
  "商品", "日期", "合作量", "上线量", "单量", "总单量", "数量", "总数量",
  "达人出单量", "达人出单数量", "商品卡出单量", "店铺商品卡出单量",
  "销售额", "店铺销售额", "总广告花费", "总广告出单量",
];
const rows = (records.data?.items ?? []).map((item: any) => Object.fromEntries(
  fields.map((name) => [name, item.fields?.[name] ?? null]),
));
const errors = JSON.stringify(rows).match(/#(?:ERROR|REF|VALUE|N\/A|DIV\/0)[^"]*/g) ?? [];
console.log(JSON.stringify({ tableId: table.table_id, rows, errors }, null, 2));
if (errors.length > 0) throw new Error(`公式存在错误：${errors.join(", ")}`);
