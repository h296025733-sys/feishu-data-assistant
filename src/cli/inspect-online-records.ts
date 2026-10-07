import { loadBusinessProfile } from "../config/business-profile.js";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env);
const tableName = loadBusinessProfile().tables.online;
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

function textValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => (
    item && typeof item === "object" && "text" in item
      ? String((item as { text?: unknown }).text ?? "")
      : String(item ?? "")
  )).join("");
  if (value && typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "");
  }
  return String(value ?? "");
}

function codePoints(value: string): string[] {
  return [...value].slice(0, 3).map((character) => (
    `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`
  ));
}

console.log(JSON.stringify((records.data?.items ?? []).map((record) => {
  const handle = textValue(record.fields?.达人姓名);
  const videoAddress = record.fields?.视频上线地址 as { link?: unknown; text?: unknown } | undefined;
  return {
    recordId: record.record_id,
    handle,
    handlePrefixCodePoints: codePoints(handle),
    publishedAt: record.fields?.["实上线日期(Ct)"],
    products: record.fields?.挂车产品,
    videoUrl: String(videoAddress?.link ?? textValue(videoAddress)),
    viewsK: record.fields?.视频曝光K,
    itemsSold: record.fields?.售出数量,
    gmv: record.fields?.销售额,
    duplicateHandleFlag: record.fields?.__重复_达人姓名,
    duplicateVideoFlag: record.fields?.__重复_视频上线地址,
  };
}), null, 2));
