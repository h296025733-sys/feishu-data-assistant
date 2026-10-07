import { getEnv, requireFeishuEnv } from "../config/env.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import {
  ROI_FIELD_NAMES,
  TECHWAVE_STORE_NAME,
} from "../feishu/roi-pivot-plan.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env);
const appToken = env.FEISHU_BITABLE_APP_TOKEN;
if (!appToken) throw new Error("缺少 FEISHU_BITABLE_APP_TOKEN");

const tables: Array<{ table_id?: string; name?: string }> = [];
let tablePageToken: string | undefined;
do {
  const response = await client.bitable.appTable.list({
    path: { app_token: appToken },
    params: { page_size: 100, page_token: tablePageToken },
  });
  assertFeishuResponse(response, "只读发现投产比数据表");
  tables.push(...(response.data?.items ?? []));
  tablePageToken = response.data?.has_more ? response.data.page_token : undefined;
} while (tablePageToken);

const roiTables = tables.filter((table) => table.name === "投产比" && table.table_id);
if (roiTables.length !== 1) {
  throw new Error(`应恰好发现一张“投产比”表，实际 ${roiTables.length} 张`);
}
const tableId = String(roiTables[0]?.table_id ?? "");

const records: Array<{
  recordId: string;
  fields: Record<string, unknown>;
}> = [];
let recordPageToken: string | undefined;
do {
  const response = await client.bitable.appTableRecord.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: 500, page_token: recordPageToken },
  });
  assertFeishuResponse(response, "只读分页读取投产比记录");
  for (const item of response.data?.items ?? []) {
    const recordId = String(item.record_id ?? "");
    if (recordId) records.push({ recordId, fields: item.fields ?? {} });
  }
  recordPageToken = response.data?.has_more ? response.data.page_token : undefined;
} while (recordPageToken);

const requestedProducts = process.argv.slice(2).map((value) => value.trim()).filter(Boolean);
const selectedProducts = requestedProducts.length > 0
  ? new Set([TECHWAVE_STORE_NAME, ...requestedProducts])
  : null;

const rows = records.flatMap((record) => {
  const product = cellText(record.fields[ROI_FIELD_NAMES.product]);
  if (selectedProducts && !selectedProducts.has(product)) return [];
  return [{
    recordId: record.recordId,
    product,
    metric: cellText(record.fields[ROI_FIELD_NAMES.metric])
      || cellText(record.fields[ROI_FIELD_NAMES.metricDisplay]),
    metricCodeRaw: record.fields[ROI_FIELD_NAMES.metric] ?? null,
    metricDisplayRaw: record.fields[ROI_FIELD_NAMES.metricDisplay] ?? null,
    value: numberValue(record.fields[ROI_FIELD_NAMES.value]),
    valueRaw: record.fields[ROI_FIELD_NAMES.value] ?? null,
    hasValueField: Object.prototype.hasOwnProperty.call(record.fields, ROI_FIELD_NAMES.value),
    date: dateText(record.fields[ROI_FIELD_NAMES.date]),
    dateRaw: record.fields[ROI_FIELD_NAMES.date] ?? null,
    hasDateField: Object.prototype.hasOwnProperty.call(record.fields, ROI_FIELD_NAMES.date),
    periodType: cellText(record.fields[ROI_FIELD_NAMES.periodType]),
    role: cellText(record.fields[ROI_FIELD_NAMES.recordRole]),
    pivotColumn: cellText(record.fields[ROI_FIELD_NAMES.pivotColumn]),
  }];
}).sort((left, right) => (
  left.product.localeCompare(right.product, "zh-CN")
  || left.metric.localeCompare(right.metric, "zh-CN")
  || left.date.localeCompare(right.date)
  || left.periodType.localeCompare(right.periodType, "zh-CN")
  || left.recordId.localeCompare(right.recordId)
));

console.log(JSON.stringify({
  readOnly: true,
  tableId,
  recordCount: records.length,
  selectedProducts: selectedProducts ? [...selectedProducts] : "all",
  rows,
}, null, 2));

function cellText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(cellText).join("").trim();
  if (value && typeof value === "object") {
    if ("text" in value) return String((value as { text?: unknown }).text ?? "").trim();
    if ("name" in value) return String((value as { name?: unknown }).name ?? "").trim();
  }
  return value === null || value === undefined ? "" : String(value).trim();
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = cellText(value);
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateText(value: unknown): string {
  const numeric = typeof value === "number" ? value : Number(cellText(value));
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(numeric));
  }
  return cellText(value);
}
