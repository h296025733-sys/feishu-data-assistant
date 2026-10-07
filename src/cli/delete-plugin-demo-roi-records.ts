import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

const DEMO_PRODUCT = "【演练】插件逻辑验证商品-0803";
const EXPECTED_RECORDS = new Map([
  ["demo_deb97be4", "2026-07-20"],
  ["demo_93ac9adb", "2026-07-22"],
  ["demo_b901bf25", "2026-07-23"],
  ["demo_c1c6b192", "2026-08-02"],
  ["demo_09282b46", "2026-08-04"],
]);

const env = requireFeishuEnv(getEnv());
const appToken = env.FEISHU_BITABLE_APP_TOKEN;
if (!appToken) throw new Error("缺少 FEISHU_BITABLE_APP_TOKEN");
const client = createFeishuClient(env) as any;

function assertOk(response: any, action: string): void {
  if (response.code && response.code !== 0) throw new Error(`${action}失败：${response.code} ${response.msg}`);
}

function textValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item && typeof item === "object" && "text" in item) return String((item as { text: unknown }).text);
      return String(item ?? "");
    }).join("");
  }
  return value === null || value === undefined ? "" : String(value);
}

function dateKey(value: unknown): string {
  if (typeof value !== "number") return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function listAllRecords(tableId: string): Promise<any[]> {
  const records: any[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 500, automatic_fields: true, ...(pageToken ? { page_token: pageToken } : {}) },
    });
    assertOk(response, "读取投产比记录");
    records.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more ? response.data?.page_token : undefined;
  } while (pageToken);
  return records;
}

const tablesResponse = await client.bitable.appTable.list({
  path: { app_token: appToken },
  params: { page_size: 100 },
});
assertOk(tablesResponse, "读取多维表格数据表");
const roiTable = (tablesResponse.data?.items ?? []).find((table: any) => table.name === "投产比");
if (!roiTable?.table_id) throw new Error("未找到投产比表");

const before = await listAllRecords(roiTable.table_id);
const demoRecords = before.filter((record) => textValue(record.fields?.商品) === DEMO_PRODUCT);
const demoIds = demoRecords.map((record) => record.record_id).sort();
const expectedIds = [...EXPECTED_RECORDS.keys()].sort();
if (JSON.stringify(demoIds) !== JSON.stringify(expectedIds)) {
  throw new Error(`演练记录集合已变化，停止删除。实际=${JSON.stringify(demoRecords.map((record) => ({
    recordId: record.record_id,
    date: dateKey(record.fields?.日期),
    status: textValue(record.fields?.检查),
    orders: record.fields?.单量 ?? null,
    quantity: record.fields?.数量 ?? null,
    cardOrders: record.fields?.商品卡出单量 ?? null,
    cardQuantity: record.fields?.商品卡出单数量 ?? null,
    sales: record.fields?.销售额 ?? null,
  })))}`);
}
for (const record of demoRecords) {
  const expectedDate = EXPECTED_RECORDS.get(record.record_id);
  const actualDate = dateKey(record.fields?.日期);
  if (!expectedDate || actualDate !== expectedDate) {
    throw new Error(`演练记录日期已变化，停止删除：${record.record_id} ${actualDate}`);
  }
}
const storeRecordIdsBefore = before
  .filter((record) => textValue(record.fields?.商品) === "TechWave")
  .map((record) => record.record_id)
  .sort();

const deleted = await client.bitable.appTableRecord.batchDelete({
  path: { app_token: appToken, table_id: roiTable.table_id },
  data: { records: expectedIds },
});
assertOk(deleted, "删除演练商品记录");

const after = await listAllRecords(roiTable.table_id);
const remainingDemo = after.filter((record) => textValue(record.fields?.商品) === DEMO_PRODUCT);
const storeRecordIdsAfter = after
  .filter((record) => textValue(record.fields?.商品) === "TechWave")
  .map((record) => record.record_id)
  .sort();
if (remainingDemo.length) throw new Error(`删除后仍有 ${remainingDemo.length} 条演练记录`);
if (JSON.stringify(storeRecordIdsAfter) !== JSON.stringify(storeRecordIdsBefore)) {
  throw new Error("删除后 TechWave 记录集合发生变化");
}

console.log(JSON.stringify({
  ok: true,
  deleted: demoRecords.map((record) => ({ recordId: record.record_id, date: dateKey(record.fields?.日期) })),
  preservedTechWaveRecordIds: storeRecordIdsAfter,
  remainingDemoRecords: remainingDemo.length,
}, null, 2));
