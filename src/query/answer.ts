import type { QueryIntent, TableData } from "../types/index.js";
import type { ModelParseTrace } from "../ai/types.js";
import type { QueryResult } from "./engine.js";
import { isOnlineOverviewValue, type MonthlyOnlineMetric, type OnlineOverviewValue } from "./overview.js";
import { formatCurrencyAmount, isMoneyField } from "../bot/currency.js";

function renderScalar(value: unknown, fieldName = "", currencyCode: string | null = null): string {
  if (value == null || value === "") return "";
  if (typeof value === "number") {
    if (/(?:日期|时间)/.test(fieldName) && value > 100_000_000_000) {
      return new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(value)).replaceAll("/", "-");
    }
    return isMoneyField(fieldName)
      ? formatCurrencyAmount(value, currencyCode)
      : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(value);
  }
  if (Array.isArray(value)) return value.map((item) => renderScalar(item, fieldName, currencyCode)).filter(Boolean).join("、");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferred = record.link ?? record.url ?? record.text ?? record.name;
    if (preferred != null) return cleanLinkText(renderScalar(preferred, fieldName, currencyCode));
    return Object.values(record).map((item) => renderScalar(item, fieldName, currencyCode)).filter(Boolean).join("、");
  }
  return cleanLinkText(String(value));
}

function renderValue(value: QueryResult["value"], fieldName = "", currencyCode: string | null = null): string {
  if (typeof value === "number") return isMoneyField(fieldName)
    ? formatCurrencyAmount(value, currencyCode)
    : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return "无";
    if (typeof value[0] === "string") return (value as string[]).join("、");
    if ("entity" in (value[0] as object)) {
      return (value as Array<{ entity: string; value: number }>).map((item) => `${item.entity}：${renderValue(item.value, fieldName, currencyCode)}`).join("；");
    }
    return renderRecords(value as Array<Record<string, unknown>>, currencyCode);
  }
  return Object.entries(value).map(([key, item]) => `${key}：${String(item)}`).join("；");
}

function renderRecords(records: Array<Record<string, unknown>>, currencyCode: string | null = null): string {
  return records.map((row, index) => {
    const visible = Object.entries(row)
      .map(([key, item]) => [key, renderScalar(item, key, currencyCode)] as const)
      .filter(([, item]) => Boolean(item));
    if (visible.length === 0) return `${index + 1}. 这条记录还没有内容`;
    const titleIndex = visible.findIndex(([key]) => /^(?:达人姓名|红人姓名|TK号|商品|产品)$/.test(key));
    const title = visible[titleIndex >= 0 ? titleIndex : 0];
    const details = visible.filter((_, itemIndex) => itemIndex !== (titleIndex >= 0 ? titleIndex : 0));
    return [
      `${index + 1}. ${title[1]}`,
      ...details.map(([key, item]) => `   ${key}：${item}`),
    ].join("\n");
  }).join("\n");
}

function renderRecordsAsTable(records: Array<Record<string, unknown>>, currencyCode: string | null = null): string {
  return records.length === 0 ? "没有找到记录" : renderRecords(records, currencyCode);
}

function cleanLinkText(value: string): string {
  const markdownLink = value.match(/^\[([^\]]+)]\((https?:\/\/[^)]+)\)$/);
  if (markdownLink) return markdownLink[2];
  return value.replace(/^\{?"?text"?:\s*"?/, "").replace(/"?,?\s*"?type"?:\s*"text"?\}?$/, "");
}


function monthLabel(month: string): string {
  const [year, value] = month.split("-");
  return `${year}年${Number(value)}月`;
}

function money(value: number): string {
  return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function monthPoint(label: string, value: MonthlyOnlineMetric | null, currencyCode: string | null): string {
  if (!value) return `${label}：无有效月份`;
  return `${label}：${monthLabel(value.month)}（上线${value.records}条、销量${renderValue(value.quantity)}、销售额${formatCurrencyAmount(value.sales, currencyCode)}）`;
}

function renderOnlineOverview(value: OnlineOverviewValue, currencyCode: string | null): string {
  const coverage = value.entity === "全部上线视频"
    ? `覆盖 ${renderValue(value.distinctCreators)} 位达人、${renderValue(value.distinctProducts)} 个产品`
    : value.entityKind === "product"
      ? `覆盖 ${renderValue(value.distinctCreators)} 位达人`
      : `涉及 ${renderValue(value.distinctProducts)} 个产品`;

  const lines = [
    `${value.entity}整体表现：${value.trendSummary}。`,
    `核心数据：上线 ${renderValue(value.records)} 条，${coverage}，售出 ${renderValue(value.quantity)} 件，销售额 ${formatCurrencyAmount(value.sales, currencyCode)}，曝光合计 ${renderValue(value.exposure)}。`,
    value.startDate && value.endDate ? `数据周期：${value.startDate} 至 ${value.endDate}。` : "数据周期：缺少有效上线日期。",
    `趋势：${monthPoint("销售额高峰", value.peakSalesMonth, currencyCode)}；${monthPoint("上线量高峰", value.peakRecordMonth, currencyCode)}；${monthPoint("最近有数据月份", value.latestMonth, currencyCode)}。`,
    value.missingDateRows > 0 ? `数据提醒：${value.missingDateRows} 条记录缺少上线日期，未参与月份趋势判断。` : "",
    "口径提醒：当前只能依据上线、曝光、销量和销售额判断表现；没有完整成本和广告花费，不能据此判断利润或ROI。",
  ];
  return lines.filter(Boolean).join("\n");
}

function renderExecution(intent: QueryIntent): string {
  if (intent.intent === "rank" || intent.intent === "rank_count") {
    const direction = intent.sortDirection === "asc" ? "升序" : "降序";
    return intent.intent === "rank_count"
      ? `按“${intent.entityField}”分组统计记录数，${direction}取前 ${intent.limit} 名`
      : `按“${intent.entityField}”分组汇总“${intent.metricField}”，${direction}取前 ${intent.limit} 名`;
  }
  if (intent.intent === "sum") return `汇总“${intent.metricField}”`;
  if (intent.intent === "average") return `计算“${intent.metricField}”平均值`;
  if (intent.intent === "count") return "统计匹配记录数";
  if (intent.intent === "distinct_count") return `统计“${intent.entityField}”去重数量`;
  if (intent.intent === "list") return `列出“${intent.entityField}”的唯一值`;
  if (intent.intent === "records") return `返回匹配记录明细，最多 ${intent.limit} 条`;
  return "生成数据概览";
}

function renderTrace(trace: ModelParseTrace): string {
  if (trace.source === "deepseek") return `DeepSeek ${trace.model}（${trace.durationMs} ms）`;
  return `本地规则${trace.fallbackReason ? `（模型未采用：${trace.fallbackReason}）` : ""}`;
}

function shortTableName(name: string): string {
  return name
    .replace(/^Tech-wave红人上线表[_\s-]?/i, "上线表")
    .replace(/^Tech-wave红人/, "")
    .replace(/表$/, "表");
}

function perTableSuffix(result: QueryResult): string {
  const entries = Object.entries(result.matchedByTable);
  if (entries.length <= 1) return "";
  return `（${entries.map(([name, count]) => `${shortTableName(name)} ${count}`).join("，")}）`;
}

function timePrefix(result: QueryResult): string {
  return result.dateRange.startsWith("全部") ? "" : `${result.dateRange}，`;
}

function entityPrefix(result: QueryResult): string {
  return result.entityValue ? `${result.entityValue} ` : "";
}

function actionLabel(question: string): { verb: string; unit: string } | null {
  if (/上线|视频/.test(question)) return { verb: "上线", unit: "次" };
  if (/合作/.test(question)) return { verb: "合作", unit: "次" };
  return null;
}

function distinctNoun(question: string, field: string | null): string {
  if (/产品|商品/.test(question) || /产品|商品/.test(field ?? "")) return "个产品";
  if (/达人|红人|博主|主播|账号/.test(question) || /达人|红人|姓名/.test(field ?? "")) return "位达人";
  return "个不同对象";
}

function conciseAnswer(result: QueryResult, intent: QueryIntent, question: string, currencyCode: string | null): string {
  const prefix = timePrefix(result);
  const entity = entityPrefix(result);
  if (isOnlineOverviewValue(result.value)) return renderOnlineOverview(result.value, currencyCode);
  const warning = result.invalidNumericRows > 0 ? `（${result.invalidNumericRows}条无效数字未计入）` : "";

  if (intent.intent === "count") {
    const action = actionLabel(question);
    if (action) return `${prefix}${entity}共${action.verb} ${renderValue(result.value)} ${action.unit}${perTableSuffix(result)}`;
    return `${prefix}${entity}共匹配 ${renderValue(result.value)} 条记录${perTableSuffix(result)}`;
  }

  if (intent.intent === "distinct_count") {
    return `${prefix}共有 ${renderValue(result.value)} ${distinctNoun(question, intent.entityField)}${perTableSuffix(result)}`;
  }

  if (intent.intent === "sum" || intent.intent === "average") {
    const method = intent.intent === "average" ? "平均" : "合计";
    return `${prefix}${entity}${result.metricField}${method}：${renderValue(result.value, result.metricField, currencyCode)}${perTableSuffix(result)}${warning}`;
  }

  if (intent.intent === "rank" || intent.intent === "rank_count") {
    const countAction = /合作/.test(question) ? "合作" : /上线|视频/.test(question) ? "上线" : "记录";
    const label = intent.intent === "rank_count"
      ? `${countAction}${intent.sortDirection === "asc" ? "最少" : "最多"}`
      : `${result.metricField}${intent.sortDirection === "asc" ? "最低" : "最高"}`;
    const firstRanked = Array.isArray(result.value) ? result.value[0] : null;
    const single = Array.isArray(result.value)
      && result.value.length === 1
      && firstRanked != null
      && typeof firstRanked === "object"
      && "entity" in firstRanked
      ? firstRanked as { entity: string; value: number }
      : null;
    if (single && intent.limit === 1) {
      if (intent.intent === "rank_count") {
        const unit = countAction === "记录" ? "条记录" : "次";
        return `${prefix}${single.entity}${countAction}${renderValue(single.value)}${unit}，为当前范围内最多${warning}`;
      }
      return `${prefix}${single.entity}的${result.metricField}${intent.sortDirection === "asc" ? "最低" : "最高"}，为${renderValue(single.value, result.metricField, currencyCode)}${warning}`;
    }
    return `${prefix}${label}前 ${intent.limit} 名：${renderValue(result.value, result.metricField, currencyCode)}${warning}`;
  }

  if (intent.intent === "list") {
    return `${prefix}${result.metricField}：${renderValue(result.value)}`;
  }

  if (intent.intent === "records") {
    const records = result.value as Array<Record<string, unknown>>;
    const head = `共找到 ${result.matchedRows} 条${result.displayedRows < result.matchedRows ? `，显示前 ${result.displayedRows} 条` : ""}${perTableSuffix(result)}`;
    const body = intent.responseStyle === "table" ? renderRecordsAsTable(records, currencyCode) : renderRecords(records, currencyCode);
    return `${head}\n${body}`;
  }

  return `数据概览：${renderValue(result.value)}`;
}

function detailedAnswer(_table: TableData, result: QueryResult, intent: QueryIntent, _trace: ModelParseTrace, currencyCode: string | null): string {
  if (isOnlineOverviewValue(result.value)) {
    return renderOnlineOverview(result.value, currencyCode);
  }
  const warnings = [
    result.duplicateRowsDetected > 0 ? `检测到 ${result.duplicateRowsDetected} 条字段完全相同的记录；已按原始记录保留并计数，未自动删除` : "",
    result.invalidNumericRows > 0 ? `已忽略 ${result.invalidNumericRows} 条无效数字` : "",
    intent.intent === "records" && result.matchedRows > result.displayedRows ? `共匹配 ${result.matchedRows} 条，本次显示前 ${result.displayedRows} 条` : "",
  ].filter(Boolean);
  if (intent.intent === "records") {
    const records = result.value as Array<Record<string, unknown>>;
    return [
      `找到了 ${result.matchedRows} 条${result.displayedRows < result.matchedRows ? `，先给你看前 ${result.displayedRows} 条` : ""}：`,
      renderRecords(records, currencyCode),
      warnings.length ? `提醒一下：${warnings.join("；")}。` : "",
    ].filter(Boolean).join("\n");
  }
  return [
    "查好了：",
    result.dateRange.startsWith("全部") ? null : `范围：${result.dateRange}`,
    `结果：${renderValue(result.value, result.metricField, currencyCode)}`,
    warnings.length ? `提醒一下：${warnings.join("；")}。` : null,
  ].filter(Boolean).join("\n");
}

export function formatAnswer(
  table: TableData,
  result: QueryResult,
  intent: QueryIntent,
  trace: ModelParseTrace,
  question = "",
  currencyCode: string | null = null,
): string {
  return intent.responseStyle === "detailed"
    ? detailedAnswer(table, result, intent, trace, currencyCode)
    : conciseAnswer(result, intent, question, currencyCode);
}
