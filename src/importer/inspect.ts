import type { DataRow, FieldRoles, TableData } from "../types/index.js";
import { canonicalRow, parseNumber, toDateKey } from "../utils/value.js";
import { isSensitiveField } from "../utils/security.js";

type Role = "date" | "entity" | "amount" | "quantity";

const ROLE_PATTERNS: Record<Role, RegExp[]> = {
  date: [/^日期$/, /时间/, /日期/, /date/i],
  entity: [/^红人姓名$/, /^达人姓名$/, /红人|达人|账号|昵称|姓名/, /^商品$/, /^产品$/, /商品名称/, /产品名称/, /寄样产品/, /挂车产品/, /项目/, /对象/, /品名/, /sku/i],
  amount: [/实付金额/, /销售额/, /^金额$/, /成交额/, /收入/, /成本|利润|售价|价格|运费|佣金|amount/i],
  quantity: [/^数量$/, /销售数量/, /销量/, /件数/, /^库存$/, /quantity|qty/i],
};

function headerScore(header: string, role: Role): number {
  if (role === "amount" && /模式/.test(header)) return 0;
  const patterns = ROLE_PATTERNS[role];
  const index = patterns.findIndex((pattern) => pattern.test(header.trim()));
  return index < 0 ? 0 : patterns.length - index;
}

function inferRole(headers: string[], role: Role): { field: string | null; ambiguous?: string[] } {
  const scored = headers.map((field) => ({ field, score: headerScore(field, role) })).filter((item) => item.score > 0);
  if (scored.length === 0) return { field: null };
  if (role === "amount") {
    const exactPreferred = scored.filter((item) => /实付金额|销售额|^金额$|成交额|收入|amount/i.test(item.field));
    if (exactPreferred.length === 1) return { field: exactPreferred[0].field };
    if (exactPreferred.length > 1) return { field: null, ambiguous: exactPreferred.map((item) => item.field) };
    return scored.length === 1 ? { field: scored[0].field } : { field: null, ambiguous: scored.map((item) => item.field) };
  }
  const max = Math.max(...scored.map((item) => item.score));
  const best = scored.filter((item) => item.score === max).map((item) => item.field);
  return best.length === 1 ? { field: best[0] } : { field: null, ambiguous: best };
}

export function inferFieldRoles(headers: string[]): FieldRoles {
  const date = inferRole(headers, "date");
  const entity = inferRole(headers, "entity");
  const amount = inferRole(headers, "amount");
  const quantity = inferRole(headers, "quantity");
  const ambiguous: FieldRoles["ambiguous"] = {};
  if (date.ambiguous) ambiguous.date = date.ambiguous;
  if (entity.ambiguous) ambiguous.entity = entity.ambiguous;
  if (amount.ambiguous) ambiguous.amount = amount.ambiguous;
  if (quantity.ambiguous) ambiguous.quantity = quantity.ambiguous;
  return {
    dateField: date.field,
    entityField: entity.field,
    amountField: amount.field,
    quantityField: quantity.field,
    ambiguous,
  };
}

function maskedSample(rows: DataRow[], headers: string[]): DataRow[] {
  return rows.slice(0, 3).map((row) => Object.fromEntries(headers.map((header) => [
    header,
    isSensitiveField(header) && row[header] != null ? "***" : row[header],
  ])));
}

export function inspectTable(table: TableData) {
  const roles = inferFieldRoles(table.headers);
  const rowKeys = table.rows.map((row) => canonicalRow(row, table.headers));
  const emptyCounts = Object.fromEntries(table.headers.map((header) => [
    header,
    table.rows.filter((row) => row[header] == null || String(row[header]).trim() === "").length,
  ]));
  const typeHints = Object.fromEntries(table.headers.map((header) => {
    const values = table.rows.map((row) => row[header]).filter((value) => value != null && String(value).trim() !== "");
    const numbers = values.filter((value) => parseNumber(value) !== null).length;
    const dates = values.filter((value) => value instanceof Date || (typeof value === "string" && toDateKey(value) !== null)).length;
    const hint = values.length > 0 && dates / values.length >= 0.8 ? "日期" : values.length > 0 && numbers / values.length >= 0.8 ? "数字" : "文本/待确认";
    return [header, hint];
  }));
  return {
    文件名: table.sourceName,
    工作表: table.sheetName,
    表头: table.headers,
    数据行数: table.rows.length,
    前3行脱敏样例: maskedSample(table.rows, table.headers),
    空值数量: emptyCounts,
    重复行数量: rowKeys.length - new Set(rowKeys).size,
    字段类型推测: typeHints,
    推测日期字段: roles.dateField ?? roles.ambiguous.date ?? "待确认",
    推测商品或对象字段: roles.entityField ?? roles.ambiguous.entity ?? "待确认",
    推测金额字段: roles.amountField ?? roles.ambiguous.amount ?? "待确认",
    推测数量字段: roles.quantityField ?? roles.ambiguous.quantity ?? "待确认",
    可能的敏感字段: table.headers.filter(isSensitiveField),
  };
}
