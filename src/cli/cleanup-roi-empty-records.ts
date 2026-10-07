import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env) as any;
const appToken = env.FEISHU_BITABLE_APP_TOKEN;
const tables = await client.bitable.appTable.list({
  path: { app_token: appToken },
  params: { page_size: 100 },
});
const table = tables.data?.items?.find((item: any) => item.name === "投产比");
if (!table?.table_id) throw new Error("未找到投产比");
const response = await client.bitable.appTableRecord.list({
  path: { app_token: appToken, table_id: table.table_id },
  params: { page_size: 500, automatic_fields: true },
});
const manualFields = [
  "单量", "数量", "商品卡出单量", "商品卡出单数量", "销售额",
  "出单视频", "自孵化出单量", "自孵化上线量", "店铺浏览量",
  "雅岚广告花费", "雅岚广告出单量",
  "金凯悦-10广告花费", "金凯悦-10广告出单量",
  "金凯悦-11广告花费", "金凯悦-11广告出单量",
  "GMV Max花费", "GMV Max广告出单量", "退货量", "备注",
];
const emptyIds = (response.data?.items ?? []).filter((record: any) => {
  if (record.fields?.日期) return false;
  return manualFields.every((name) => {
    const value = record.fields?.[name];
    return value == null || value === "" || value === 0 || value === "0";
  });
}).map((record: any) => String(record.record_id));
if (emptyIds.length) {
  const deleted = await (client.bitable.appTableRecord as any).batchDelete({
    path: { app_token: appToken, table_id: table.table_id },
    data: { records: emptyIds },
  });
  if (deleted.code && deleted.code !== 0) {
    throw new Error(`删除空白记录失败：${deleted.msg}`);
  }
}
console.log(`已删除 ${emptyIds.length} 条无日期、无人工数据的空白记录`);
