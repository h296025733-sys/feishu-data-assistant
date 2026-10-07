import type { QueryIntent, TableData } from "../types/index.js";
import { canonicalRow, parseNumber, toDateKey } from "../utils/value.js";
import type { AnalysisEvidence } from "./types.js";

const SENSITIVE_FIELD = /姓名|达人|红人|开发人|负责人|最终归属|主页|联系|邮箱|邮件|whatsapp|手机|电话|地址|证件|身份证|银行|卡号|账号|paypal|备注|mcn/i;
const CATEGORY_FIELD = /产品|商品|寄样|挂车|合作方式|付款渠道|进度|状态|直播|颜色|星期|月份|渠道|类型/i;
const NUMERIC_FIELD = /粉丝|曝光|播放|浏览|数量|单量|销量|售出|销售额|成交额|花费|佣金|退货|转化率/i;
const DATE_FIELD = /日期|时间/i;

export function buildAnalysisEvidence(table: TableData, intent?: QueryIntent): AnalysisEvidence {
  const rows = selectRows(table, intent);
  const mixedRoi = table.headers.includes("记录类型") && table.headers.includes("商品");
  const safeHeaders = table.headers.filter((header) => !SENSITIVE_FIELD.test(header));
  const rowKeys = rows.map((row) => canonicalRow(row, table.headers));
  const duplicateRecordCount = rowKeys.length - new Set(rowKeys).size;

  const dateRanges = safeHeaders
    .filter((header) => DATE_FIELD.test(header))
    .slice(0, 4)
    .map((field) => {
      const dates = rows.map((row) => toDateKey(row[field])).filter((value): value is string => Boolean(value)).sort();
      return {
        field,
        earliest: dates[0] ?? null,
        latest: dates.at(-1) ?? null,
        validCount: dates.length,
        missingCount: rows.length - dates.length,
      };
    });

  const categoryBreakdowns = safeHeaders
    .filter((header) => CATEGORY_FIELD.test(header) && !DATE_FIELD.test(header))
    .slice(0, 10)
    .map((field) => {
      const counts = new Map<string, number>();
      let nonEmptyCount = 0;
      for (const row of rows) {
        const values = categoryValues(row[field], field);
        if (values.length > 0) nonEmptyCount += 1;
        for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      return {
        field,
        nonEmptyCount,
        uniqueCount: counts.size,
        topValues: [...counts]
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "zh-CN"))
          .slice(0, 8),
      };
    })
    .filter((item) => item.nonEmptyCount > 0);

  const numericSummaries = safeHeaders
    .filter((header) => NUMERIC_FIELD.test(header))
    .slice(0, 14)
    .map((field) => {
      const numbers = rows.map((row) => parseNumber(row[field])).filter((value): value is number => value !== null);
      if (numbers.length === 0) return null;
      const sum = numbers.reduce((total, value) => total + value, 0);
      return {
        field,
        validCount: numbers.length,
        missingCount: rows.length - numbers.length,
        sum: round(sum),
        average: round(sum / numbers.length),
        minimum: round(Math.min(...numbers)),
        maximum: round(Math.max(...numbers)),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const evidenceHeaders = [...new Set([
    ...dateRanges.map((item) => item.field),
    ...categoryBreakdowns.map((item) => item.field),
    ...numericSummaries.map((item) => item.field),
  ])];
  const missingFields = (mixedRoi ? [] : evidenceHeaders)
    .map((field) => {
      const missingCount = rows.filter((row) => isEmpty(row[field])).length;
      return {
        field,
        missingCount,
        missingRate: rows.length === 0 ? 0 : round(missingCount / rows.length),
      };
    })
    .filter((item) => item.missingCount > 0)
    .sort((a, b) => b.missingRate - a.missingRate)
    .slice(0, 10);

  return {
    tableName: table.sheetName,
    recordCount: rows.length,
    duplicateRecordCount,
    aggregationNotes: [
      "所有分布和数值统计均按记录行计算；同一对象有多条记录时会重复计入，不能解释为去重对象统计。",
      "达人累计类字段（例如合作次数、上线次数）不进入通用分析求和，避免跨记录重复累计。",
      ...(mixedRoi
        ? ["投产比同时包含商品行和店铺汇总行；商品字段中的店铺汇总不是商品，统计商品数量时必须排除记录类型为店铺的行。两类行结构不同造成的空白不是数据缺失，不要报告字段缺失率。numericSummaries中的validCount和零值数量都是记录条数，不能说成天数。广告等人工字段为0也可能表示尚未补录，不能直接断言没有投放。"]
        : []),
    ],
    dateRanges,
    categoryBreakdowns,
    numericSummaries,
    missingFields,
  };
}

function selectRows(table: TableData, intent?: QueryIntent): TableData["rows"] {
  if (!intent) return table.rows;
  return table.rows.filter((row) => {
    if (intent.entityField && intent.entityValue) {
      const value = String(row[intent.entityField] ?? "");
      if (!value.includes(intent.entityValue)) return false;
    }
    if (intent.dateField && (intent.startDate || intent.endDate)) {
      const date = toDateKey(row[intent.dateField]);
      if (!date) return false;
      if (intent.startDate && date < intent.startDate) return false;
      if (intent.endDate && date > intent.endDate) return false;
    }
    return true;
  });
}

function categoryValues(value: unknown, field: string): string[] {
  const raw = Array.isArray(value) ? value : [value];
  const values = raw.flatMap((item) => {
    if (item == null) return [];
    if (typeof item === "object") {
      const record = item as Record<string, unknown>;
      return [record.name ?? record.text ?? record.value ?? ""];
    }
    return [item];
  }).map((item) => String(item).trim()).filter(Boolean);
  if (!/产品|商品|寄样|挂车/.test(field)) return values;
  return values.flatMap((item) => item.split(/[,，;；、]/).map((part) => part.trim()).filter(Boolean));
}

function isEmpty(value: unknown): boolean {
  return value == null || String(value).trim() === "";
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
