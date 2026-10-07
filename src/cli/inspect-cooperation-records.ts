import { loadBusinessProfile } from "../config/business-profile.js";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env);
const tableName = loadBusinessProfile().tables.cooperation;
const tables = await client.bitable.appTable.list({
  path: { app_token: env.FEISHU_BITABLE_APP_TOKEN },
  params: { page_size: 100 },
});
assertFeishuResponse(tables, "读取数据表");
const tableId = tables.data?.items?.find((item) => item.name === tableName)?.table_id;
if (!tableId) throw new Error(`未找到${tableName}`);

const records = await client.bitable.appTableRecord.list({
  path: { app_token: env.FEISHU_BITABLE_APP_TOKEN, table_id: tableId },
  params: { page_size: 500, automatic_fields: true },
});
assertFeishuResponse(records, `读取${tableName}`);

console.log(JSON.stringify((records.data?.items ?? []).map((record) => ({
  recordId: record.record_id,
  creator: textValue(record.fields?.红人姓名),
  cooperationDate: record.fields?.合作时间,
  products: record.fields?.寄样产品,
  onlineCount: record.fields?.上线次数,
})), null, 2));

function textValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(textValue).join("").trim();
  if (value && typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "").trim();
  }
  return String(value ?? "").trim();
}
