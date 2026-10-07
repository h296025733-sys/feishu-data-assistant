import type { DataRow, TableData } from "../types/index.js";
import { parseNumber, toDateKey } from "../utils/value.js";

export type PlannedFieldType = "文本" | "数字" | "日期";

export interface PlannedField {
  name: string;
  type: PlannedFieldType;
  feishuType: 1 | 2 | 5;
  warning: string | null;
}

export interface ImportPlan {
  source: string;
  sheet: string;
  recordCount: number;
  fields: PlannedField[];
}

export function createImportPlan(table: TableData): ImportPlan {
  return {
    source: table.sourceName,
    sheet: table.sheetName,
    recordCount: table.rows.length,
    fields: table.headers.map((header) => planField(header, table.rows)),
  };
}

function planField(header: string, rows: DataRow[]): PlannedField {
  const values = rows.map((row) => row[header]).filter((value) => value != null && String(value).trim() !== "");
  const dateValues = values.filter((value) => value instanceof Date || (typeof value === "string" && toDateKey(value) !== null));
  const numericValues = values.filter((value) => parseNumber(value) !== null);
  if (values.length > 0 && dateValues.length === values.length) return { name: header, type: "日期", feishuType: 5, warning: null };
  if (values.length > 0 && numericValues.length === values.length) return { name: header, type: "数字", feishuType: 2, warning: null };
  const numericRatio = values.length ? numericValues.length / values.length : 0;
  const warning = numericRatio >= 0.8
    ? `约 ${Math.round(numericRatio * 100)}% 的非空值为数字，但存在混合值；为避免丢失原值按文本导入`
    : values.length === 0 ? "字段全空，按文本导入" : null;
  return { name: header, type: "文本", feishuType: 1, warning };
}

export function convertRowForFeishu(row: DataRow, fields: PlannedField[]): Record<string, string | number> {
  const converted: Record<string, string | number> = {};
  for (const field of fields) {
    const value = row[field.name];
    if (value == null || String(value).trim() === "") continue;
    if (field.type === "数字") {
      const number = parseNumber(value);
      if (number !== null) converted[field.name] = number;
    } else if (field.type === "日期") {
      const date = toDateKey(value);
      if (date) converted[field.name] = new Date(`${date}T00:00:00+08:00`).getTime();
    } else {
      converted[field.name] = value instanceof Date ? value.toISOString() : String(value);
    }
  }
  return converted;
}
