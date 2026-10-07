import type { DataRow, QueryIntent, TableData } from "../types/index.js";
import { canonicalRow, normalizeText, parseNumber, toDateKey } from "../utils/value.js";
import { buildOnlineOverview, entityValueMatches } from "./overview.js";

export interface QueryResult {
  value: number | string | string[] | Array<{ entity: string; value: number }> | Array<Record<string, unknown>> | Record<string, unknown>;
  matchedRows: number;
  matchedByTable: Record<string, number>;
  invalidNumericRows: number;
  duplicateRowsDetected: number;
  metricField: string;
  entityValue: string | null;
  dateRange: string;
  displayedRows: number;
}

export function executeQuery(table: TableData, intent: QueryIntent): QueryResult {
  // 字段完全相同的记录也可能是真实的两次合作/上线。只检测，不擅自删除。
  const rowKeys = table.rows.map((row) => canonicalRow(row, table.headers));
  const duplicateRowsDetected = rowKeys.length - new Set(rowKeys).size;
  let rows = table.rows;
  let invalidFilterRows = 0;

  if (intent.entityField && intent.entityValue) {
    rows = rows.filter((row) => entityValueMatches(intent.entityField!, row[intent.entityField!], intent.entityValue!));
  }
  if ((intent.startDate || intent.endDate) && !intent.dateField) throw new Error("缺少日期字段，无法过滤日期");
  if (intent.dateField && (intent.startDate || intent.endDate)) {
    rows = rows.filter((row) => {
      const key = toDateKey(row[intent.dateField!]);
      if (!key) return false;
      return (!intent.startDate || key >= intent.startDate) && (!intent.endDate || key <= intent.endDate);
    });
  }
  for (const filter of intent.numericFilters ?? []) {
    if (!table.headers.includes(filter.field)) throw new Error(`筛选字段不存在：${filter.field}`);
    rows = rows.filter((row) => {
      const value = parseNumber(row[filter.field]);
      if (value === null) {
        if (row[filter.field] != null && String(row[filter.field]).trim() !== "") invalidFilterRows += 1;
        return false;
      }
      if (filter.operator === "gt") return value > filter.value;
      if (filter.operator === "gte") return value >= filter.value;
      if (filter.operator === "lt") return value < filter.value;
      if (filter.operator === "lte") return value <= filter.value;
      return Math.abs(value - filter.value) < 0.000001;
    });
  }

  const dateRange = intent.startDate || intent.endDate
    ? `${intent.startDate ?? "最早"} 至 ${intent.endDate ?? "最新"}`
    : intent.dateField ? "全部日期" : "全部数据（表中无日期字段）";

  if (intent.intent !== "records" && (intent.intent !== "summary" || Boolean(intent.entityValue)) && rows.length === 0) {
    throw new Error("没有匹配记录，未生成数值答案");
  }

  if (intent.intent === "count") return base(rows.length, "记录数");

  if (intent.intent === "distinct_count") {
    if (!intent.entityField) throw new Error("缺少对象字段，无法统计去重数量");
    const values = new Set(rows.map((row) => normalizeText(row[intent.entityField!])).filter(Boolean));
    return base(values.size, `${intent.entityField}去重数`);
  }

  if (intent.intent === "list") {
    if (!intent.entityField) throw new Error("缺少商品或对象字段，无法列出分类");
    const values = [...new Set(rows.map((row) => String(row[intent.entityField!] ?? "").trim()).filter(Boolean))].sort();
    return base(values.slice(0, intent.limit), intent.entityField, Math.min(values.length, intent.limit));
  }

  if (intent.intent === "records") {
    const sortedRows = sortRows(rows, intent.sortField ?? intent.dateField, intent.sortDirection);
    const selected = intent.selectFields.length > 0 ? intent.selectFields : table.headers.slice(0, 8);
    if (intent.outputMode === "export" && sortedRows.length > 10_000) {
      throw new Error("导出结果超过10000行，请增加日期、商品或数值条件后重试");
    }
    const displayed = intent.outputMode === "export" ? sortedRows : sortedRows.slice(0, intent.limit);
    const records = displayed.map((row) => Object.fromEntries(selected.map((field) => [field, row[field] ?? null])));
    return base(records, selected.join("、") || "记录明细", records.length);
  }

  if (intent.intent === "summary") {
    if (/上线表/i.test(table.sheetName)) {
      return base(buildOnlineOverview(table, rows, intent), "综合表现");
    }
    return base({ 原始记录数: table.rows.length, 匹配记录数: rows.length, 字段数: table.headers.length }, "数据概览");
  }


  if (intent.intent === "rank_count") {
    if (!intent.entityField) throw new Error("缺少商品或对象字段，无法按记录数排名");
    const groups = new Map<string, number>();
    for (const row of rows) {
      const entity = String(row[intent.entityField] ?? "").trim();
      if (!entity) continue;
      groups.set(entity, (groups.get(entity) ?? 0) + 1);
    }
    if (groups.size === 0) throw new Error(`字段“${intent.entityField}”没有可排名的有效对象`);
    const direction = intent.sortDirection === "asc" ? 1 : -1;
    const ranked = [...groups]
      .map(([entity, value]) => ({ entity, value }))
      .sort((a, b) => direction * (a.value - b.value))
      .slice(0, intent.limit);
    return base(ranked, "记录数", ranked.length);
  }

  if (!intent.metricField) throw new Error("缺少指标字段");
  if (!table.headers.includes(intent.metricField)) throw new Error(`指标字段不存在：${intent.metricField}`);


  if (intent.intent === "rank") {
    if (!intent.entityField) throw new Error("缺少商品或对象字段，无法排名");
    const groups = new Map<string, number>();
    let invalid = 0;
    for (const row of rows) {
      const entity = String(row[intent.entityField] ?? "").trim();
      if (!entity) continue;
      const number = parseNumber(row[intent.metricField]);
      if (number === null) {
        if (row[intent.metricField] != null && String(row[intent.metricField]).trim() !== "") invalid += 1;
        continue;
      }
      groups.set(entity, (groups.get(entity) ?? 0) + number);
    }
    if (groups.size === 0) throw new Error(`字段“${intent.metricField}”没有可计算的有效数字`);
    const direction = intent.sortDirection === "asc" ? 1 : -1;
    const ranked = [...groups]
      .map(([entity, value]) => ({ entity, value }))
      .sort((a, b) => direction * (a.value - b.value))
      .slice(0, intent.limit);
    return { ...base(ranked, intent.metricField, ranked.length), invalidNumericRows: invalid + invalidFilterRows };
  }

  let invalid = 0;
  const numbers = rows.map((row) => {
    const parsed = parseNumber(row[intent.metricField!]);
    if (parsed === null && row[intent.metricField!] != null && String(row[intent.metricField!]).trim() !== "") invalid += 1;
    return parsed;
  }).filter((value): value is number => value !== null);
  if (numbers.length === 0) throw new Error(`字段“${intent.metricField}”没有可计算的有效数字`);

  const value = intent.intent === "average"
    ? numbers.reduce((sum, number) => sum + number, 0) / numbers.length
    : numbers.reduce((sum, number) => sum + number, 0);
  return { ...base(value, intent.metricField), invalidNumericRows: invalid + invalidFilterRows };

  function base(value: QueryResult["value"], metricField: string, displayedRows = 0): QueryResult {
    const matchedByTable: Record<string, number> = {};
    for (const row of rows) {
      const source = String(row.__sourceTable ?? table.sheetName);
      matchedByTable[source] = (matchedByTable[source] ?? 0) + 1;
    }
    return {
      value,
      matchedRows: rows.length,
      matchedByTable,
      invalidNumericRows: invalidFilterRows,
      duplicateRowsDetected,
      metricField,
      entityValue: intent.entityValue,
      dateRange,
      displayedRows,
    };
  }
}

function sortRows(rows: DataRow[], field: string | null, direction: QueryIntent["sortDirection"]): DataRow[] {
  if (!field || !direction) return [...rows];
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => factor * compareValues(a[field], b[field]));
}

function compareValues(left: unknown, right: unknown): number {
  const leftDate = toDateKey(left);
  const rightDate = toDateKey(right);
  if (leftDate && rightDate) return leftDate.localeCompare(rightDate);
  const leftNumber = parseNumber(left);
  const rightNumber = parseNumber(right);
  if (leftNumber != null && rightNumber != null) return leftNumber - rightNumber;
  return String(left ?? "").localeCompare(String(right ?? ""), "zh-CN");
}
