import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const appToken = env.FEISHU_BITABLE_APP_TOKEN;
if (!appToken) throw new Error("缺少 FEISHU_BITABLE_APP_TOKEN");
const client = createFeishuClient(env) as any;
const apply = process.argv.includes("--apply");

function assertOk(response: any, action: string): void {
  if (response.code && response.code !== 0) throw new Error(`${action}失败：${response.code} ${response.msg}`);
}

function textValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => item && typeof item === "object" && "text" in item ? String((item as any).text) : String(item ?? "")).join("");
  return value === null || value === undefined ? "" : String(value);
}

function dateKey(value: unknown): string {
  if (typeof value !== "number") return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function listRecords(tableId: string): Promise<any[]> {
  const response = await client.bitable.appTableRecord.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: 500, automatic_fields: true },
  });
  assertOk(response, "读取投产比记录");
  return response.data?.items ?? [];
}

const tables = await client.bitable.appTable.list({ path: { app_token: appToken }, params: { page_size: 100 } });
assertOk(tables, "读取数据表");
const roiTable = (tables.data?.items ?? []).find((table: any) => table.name === "投产比");
if (!roiTable?.table_id) throw new Error("未找到投产比表");

const before = await listRecords(roiTable.table_id);
const isVerifiedApiRecord = (record: any): boolean => {
  const product = textValue(record.fields?.商品);
  const date = dateKey(record.fields?.日期);
  return (product === "电动磨脚器" || product === "TechWave") && (date === "2026-07-23" || date === "2026-07-24");
};
const keep = before.filter(isVerifiedApiRecord);
const remove = before.filter((record) => !isVerifiedApiRecord(record));
const describe = (record: any) => ({ recordId: record.record_id, product: textValue(record.fields?.商品), date: dateKey(record.fields?.日期) });

if (before.length !== 12 || keep.length !== 4 || remove.length !== 8) {
  throw new Error(`清理集合与只读盘点不一致，停止。${JSON.stringify({ total: before.length, keep: keep.map(describe), remove: remove.map(describe) })}`);
}

if (!apply) {
  console.log(JSON.stringify({ ok: true, mode: "dry-run", keep: keep.map(describe), remove: remove.map(describe) }, null, 2));
} else {
  const response = await client.bitable.appTableRecord.batchDelete({
    path: { app_token: appToken, table_id: roiTable.table_id },
    data: { records: remove.map((record) => record.record_id) },
  });
  assertOk(response, "删除剩余投产比测试记录");
  const after = await listRecords(roiTable.table_id);
  const actual = after.map(describe).sort((a, b) => a.recordId.localeCompare(b.recordId));
  const expected = keep.map(describe).sort((a, b) => a.recordId.localeCompare(b.recordId));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`清理后记录集合不一致：${JSON.stringify(actual)}`);
  console.log(JSON.stringify({ ok: true, mode: "applied", deleted: remove.map(describe), remaining: actual }, null, 2));
}
