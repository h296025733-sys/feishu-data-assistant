import type { ConversationContext, FieldRoles, NumericFilter, QueryIntent, ResponseStyle, TableData } from "../types/index.js";
import { formatDate, normalizeText, shiftDate } from "../utils/value.js";
import { ClarificationError } from "./errors.js";
import { matchEntityValue } from "./match.js";

export interface ParsedQuestion {
  intent: QueryIntent;
  matchedEntity: string | null;
}

interface DateRange {
  startDate: string | null;
  endDate: string | null;
  mentioned: boolean;
}

function explicitMetric(question: string, headers: string[], entityField: string | null, dateField: string | null): string | null {
  const candidates = headers
    .filter((header) => header !== entityField && header !== dateField)
    .filter((header) => question.includes(header) || normalizeText(question).includes(normalizeText(header)))
    .sort((a, b) => normalizeText(b).length - normalizeText(a).length);
  return candidates[0] ?? null;
}

function extractEntityHint(question: string, table: TableData, metricField: string | null): string {
  let hint = question;
  const removals = [
    ...table.headers,
    metricField ?? "",
    "今天", "昨天", "前天", "本周", "这周", "上周", "本月", "这个月", "上个月", "今年", "去年",
    "合计", "总计", "总和", "求和", "最高", "最低", "最多", "最少", "平均", "均值", "最近", "最新",
    "是多少", "有多少", "多少", "几个", "几次", "哪个", "哪些", "产品", "商品", "记录", "数据", "的", "了", "卖", "销售",
    "查询", "查一下", "看一下", "请返回", "返回", "字段", "等于", "匹配", "全部", "实际", "告诉我", "帮我",
    "上下文对象", "上下文数据域", "上下文指标",
  ].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const value of removals) hint = hint.replaceAll(value, " ");
  hint = hint.replace(/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/g, " ");
  return hint.replace(/[?？,，。:：；;\[\]()（）]/g, " ").replace(/\s+/g, " ").trim();
}

function startOfWeek(date: Date): Date {
  const day = date.getDay() || 7;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - day + 1);
}

function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function parseDates(question: string, now: Date): DateRange {
  if (question.includes("昨天")) return { startDate: shiftDate(now, -1), endDate: shiftDate(now, -1), mentioned: true };
  if (question.includes("前天")) return { startDate: shiftDate(now, -2), endDate: shiftDate(now, -2), mentioned: true };
  if (question.includes("今天")) return { startDate: formatDate(now), endDate: formatDate(now), mentioned: true };

  const recentDays = question.match(/(?:最近|近|过去)(\d{1,3}|[一二两三四五六七八九十]{1,3})(?:天|日)/);
  if (recentDays) {
    const parsed = chineseNumber(recentDays[1]);
    if (parsed != null) {
      const days = Math.max(1, Math.min(365, parsed));
      return { startDate: shiftDate(now, -days), endDate: shiftDate(now, -1), mentioned: true };
    }
  }
  if (/近一周|最近一周|过去一周|过去7天/.test(question)) {
    return { startDate: shiftDate(now, -7), endDate: shiftDate(now, -1), mentioned: true };
  }

  if (/本周|这周|这一周|这个星期/.test(question)) {
    const start = startOfWeek(now);
    return { startDate: formatDate(start), endDate: formatDate(now), mentioned: true };
  }
  if (/上周|上一周|上个星期|上星期|前一周/.test(question)) {
    const currentStart = startOfWeek(now);
    const start = new Date(currentStart.getFullYear(), currentStart.getMonth(), currentStart.getDate() - 7);
    return { startDate: formatDate(start), endDate: shiftDate(start, 6), mentioned: true };
  }
  if (/本月|这个月|这月/.test(question)) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { startDate: formatDate(start), endDate: formatDate(endOfMonth(now)), mentioned: true };
  }
  if (/上月|上个月/.test(question)) {
    const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { startDate: formatDate(previous), endDate: formatDate(endOfMonth(previous)), mentioned: true };
  }
  if (/今年/.test(question)) {
    return { startDate: `${now.getFullYear()}-01-01`, endDate: `${now.getFullYear()}-12-31`, mentioned: true };
  }
  if (/去年/.test(question)) {
    const year = now.getFullYear() - 1;
    return { startDate: `${year}-01-01`, endDate: `${year}-12-31`, mentioned: true };
  }

  const month = question.match(/(?:(\d{4})年)?(\d{1,2})月(?!\d)/);
  if (month) {
    const year = month[1] ? Number(month[1]) : now.getFullYear();
    const monthIndex = Number(month[2]) - 1;
    if (monthIndex >= 0 && monthIndex <= 11) {
      const start = new Date(year, monthIndex, 1);
      return { startDate: formatDate(start), endDate: formatDate(endOfMonth(start)), mentioned: true };
    }
  }

  const dates = [...question.matchAll(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/g)]
    .map((match) => `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`);
  if (dates.length === 1) return { startDate: dates[0], endDate: dates[0], mentioned: true };
  if (dates.length >= 2) return { startDate: dates[0], endDate: dates[1], mentioned: true };
  return { startDate: null, endDate: null, mentioned: false };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanExplicitValue(value: string): string {
  return value
    .replace(/^[\s“”"'‘’]+|[\s“”"'‘’]+$/g, "")
    .replace(/(?:的)?(?:全部)?记录.*$/s, "")
    .replace(/(?:请返回|最后告诉我|要求)[:：]?.*$/s, "")
    .replace(/[，。；;]\s*$/g, "")
    .trim();
}

function explicitEntityFromQuestion(question: string, table: TableData): { field: string; value: string } | null {
  const mentioned = table.headers
    .filter((header) => normalizeText(header).length >= 2 && normalizeText(question).includes(normalizeText(header)))
    .sort((a, b) => normalizeText(b).length - normalizeText(a).length);

  for (const field of mentioned) {
    const escaped = escapeRegExp(field);
    const patterns = [
      new RegExp(`[“”"'‘’]?${escaped}[“”"'‘’]?(?:字段)?\\s*(?:等于|为|是|=|：|:)\\s*[“"'‘]([^”"'’]+)[”"'’]`, "i"),
      new RegExp(`[“”"'‘’]?${escaped}[“”"'‘’]?(?:字段)?\\s*(?:等于|为|是|=|：|:)\\s*([^\\n，。；;]+)`, "i"),
    ];
    for (const pattern of patterns) {
      const match = question.match(pattern);
      const value = match?.[1] ? cleanExplicitValue(match[1]) : "";
      if (value) return { field, value };
    }
  }
  return null;
}

function isPotentialEntityHeader(header: string): boolean {
  return !/日期|时间|金额|销售额|数量|销量|单量|浏览量|访客|转化率|roi|成本|利润|佣金|粉丝|次数|曝光|状态|备注|地址|链接|code|方式|类型/i.test(header);
}

function findDirectEntityAcrossHeaders(question: string, table: TableData): { field: string; value: string } | null {
  const normalizedQuestion = normalizeText(question);
  const matches: Array<{ field: string; value: string }> = [];
  for (const header of table.headers.filter(isPotentialEntityHeader)) {
    const values = [...new Set(table.rows.map((row) => String(row[header] ?? "").trim()).filter((value) => value.length >= 2))];
    for (const value of values) {
      const normalizedValue = normalizeText(value);
      if (normalizedValue.length >= 2 && normalizedQuestion.includes(normalizedValue)) matches.push({ field: header, value });
    }
  }
  const unique = [...new Map(matches.map((item) => [`${item.field}\u0000${item.value}`, item])).values()]
    .sort((a, b) => normalizeText(b.value).length - normalizeText(a.value).length);
  if (unique.length === 0) return null;
  if (unique.length === 1) return unique[0];
  if (normalizeText(unique[0].value).length > normalizeText(unique[1].value).length) return unique[0];
  return null;
}

function firstExisting(headers: string[], names: string[]): string | null {
  return names.find((name) => headers.includes(name)) ?? null;
}

function tableFamily(table: TableData): "development" | "cooperation" | "online" | "roi" | null {
  if (/上线表/i.test(table.sheetName)) return "online";
  if (/合作表/i.test(table.sheetName)) return "cooperation";
  if (/开发表/i.test(table.sheetName)) return "development";
  if (/投产比|roi/i.test(table.sheetName)) return "roi";
  return null;
}

function resolveEntityAlias(question: string, table: TableData, roles: FieldRoles): string | null {
  const headers = table.headers;
  const family = tableFamily(table);
  if (/达人|红人|博主|主播|账号|创作者|kol|influencer/i.test(question)) {
    return firstExisting(headers, family === "online" ? ["达人姓名", "红人姓名"] : ["红人姓名", "达人姓名"]);
  }
  if (/产品|商品|sku|品类/i.test(question)) {
    return firstExisting(headers, family === "online" ? ["挂车产品", "寄样产品", "产品", "商品"] : ["寄样产品", "挂车产品", "产品", "商品"]);
  }
  if (/开发人|负责人|员工/.test(question)) return firstExisting(headers, ["开发人", "负责人"]);
  return roles.entityField;
}

function resolveDateField(question: string, table: TableData, roles: FieldRoles): string | null {
  const explicit = table.headers
    .filter((header) => /日期|时间/i.test(header))
    .find((header) => normalizeText(question).includes(normalizeText(header)));
  if (explicit) return explicit;
  const family = tableFamily(table);
  if (family === "online") return firstExisting(table.headers, ["实上线日期(Ct)", "实上线日期(CT)", "实上线日期", "登记日期", "合作时间"]);
  if (family === "cooperation") return firstExisting(table.headers, ["合作时间", "最近联系日期", "最近联系时间"]);
  if (family === "development") return firstExisting(table.headers, ["日期1", "日期2", "开发日期", "日期"]);
  return roles.dateField;
}

function resolveMetricAlias(question: string, table: TableData, roles: FieldRoles): string | null {
  const headers = table.headers;
  const direct = explicitMetric(question, headers, null, null);
  if (direct && !/次数|记录数/.test(direct)) return direct;
  if (/卖了多少钱|卖多少钱|销售额|成交额|gmv|营收|收入|金额/.test(question)) {
    return firstExisting(headers, ["销售额", "实付金额", "成交额", "金额", "收入"]) ?? roles.amountField;
  }
  if (/销量|卖了多少(?!钱)|卖出多少|卖得|带货|售出|卖了几件|出单|订单量|件数/.test(question)) {
    return firstExisting(headers, ["售出数量", "销量", "销售数量", "数量"] ) ?? roles.quantityField;
  }
  if (/曝光|播放量|播放|浏览量|观看量/.test(question)) return firstExisting(headers, ["视频曝光K", "曝光", "播放量", "浏览量"]);
  if (/佣金/.test(question)) return firstExisting(headers, ["佣金总金额", "佣金", "佣金金额"]);
  if (/利润/.test(question)) return firstExisting(headers, ["利润", "毛利", "净利润"]);
  if (/成本|广告花费/.test(question)) {
    return firstExisting(headers, ["总广告花费", "成本", "广告花费", "花费"])
      ?? headers.find((header) => header.endsWith("广告花费"))
      ?? null;
  }
  return null;
}

function chineseNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const map: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (value in map) return map[value];
  const match = value.match(/^十([一二三四五六七八九])$/);
  if (match) return 10 + map[match[1]];
  const tens = value.match(/^([二三四五六七八九])十([一二三四五六七八九])?$/);
  if (tens) return map[tens[1]] * 10 + (tens[2] ? map[tens[2]] : 0);
  return null;
}

function parseLimit(question: string, fallback: number): number {
  const patterns = [
    /(?:最近|最新|前|top\s*)(\d{1,3}|[一二两三四五六七八九十]{1,3})(?:条|个|位|名|次)?/i,
    /(\d{1,3}|[一二两三四五六七八九十]{1,3})(?:条|个|位|名)(?:记录|视频|达人|红人|产品)?/,
  ];
  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (!match) continue;
    const parsed = chineseNumber(match[1]);
    if (parsed != null) return Math.max(1, Math.min(100, parsed));
  }
  if (/最近一次|最新一次|最后一次/.test(question)) return 1;
  return fallback;
}

function responseStyle(question: string): ResponseStyle {
  if (/表格|制表|按表|导出|导成|(?:整理|生成|做)成?(?:csv|excel|文件)/i.test(question)) return "table";
  if (/详细|过程|依据|数据来源|每张表|分表|解释|调试|怎么查的/.test(question)) return "detailed";
  return "concise";
}

function numericFiltersFromQuestion(question: string, headers: string[]): NumericFilter[] {
  const operators: Array<[RegExp, NumericFilter["operator"]]> = [
    [/(?:大于等于|不少于|不低于|至少|>=|≥)/, "gte"],
    [/(?:小于等于|不多于|不高于|至多|<=|≤)/, "lte"],
    [/(?:大于|超过|高于|破|>)/, "gt"],
    [/(?:小于|少于|低于|<)/, "lt"],
    [/(?:等于|正好为|=)/, "eq"],
  ];
  const filters: NumericFilter[] = [];
  for (const field of [...headers].sort((a, b) => b.length - a.length)) {
    if (!normalizeText(question).includes(normalizeText(field))) continue;
    const fieldIndex = question.indexOf(field);
    if (fieldIndex < 0) continue;
    const tail = question.slice(fieldIndex + field.length, fieldIndex + field.length + 32);
    for (const [pattern, operator] of operators) {
      const match = tail.match(new RegExp(`^\\s*(?:的)?\\s*${pattern.source}\\s*([-+]?\\d+(?:\\.\\d+)?)`, "i"));
      if (!match) continue;
      const value = Number(match[1]);
      if (Number.isFinite(value)) filters.push({ field, operator, value });
      break;
    }
  }
  return filters.slice(0, 8);
}

function contextualReference(question: string): boolean {
  return /(?:^|[，,。\s])(他|她|它|这个达人|这个红人|这个博主|这个账号|这个产品|这个商品|这个(?!月|周|星期)|该达人|该产品|那|再|然后|接着)/.test(question)
    || /^(?:最近呢?|这个月呢|本月呢|上个月呢|上周呢|本周呢|销量呢|销售额呢|曝光呢|合作呢|上线呢|还有呢)$/.test(question.trim());
}

function mapContextEntityField(context: ConversationContext, table: TableData): string | null {
  if (context.lastEntityField && table.headers.includes(context.lastEntityField)) return context.lastEntityField;
  if (context.lastEntityField && /红人姓名|达人姓名/.test(context.lastEntityField)) {
    return firstExisting(table.headers, ["达人姓名", "红人姓名"]);
  }
  if (context.lastEntityField && /挂车产品|寄样产品|产品|商品/.test(context.lastEntityField)) {
    return firstExisting(table.headers, ["挂车产品", "寄样产品", "产品", "商品"]);
  }
  return null;
}

function selectFieldsFromQuestion(question: string, table: TableData, entityField: string | null, dateField: string | null): string[] {
  const headers = table.headers;
  const selected: string[] = headers
    .filter((header) => normalizeText(header).length >= 2 && normalizeText(question).includes(normalizeText(header)))
    .sort((a, b) => question.indexOf(a) - question.indexOf(b));

  const aliases: Array<[RegExp, string | null]> = [
    [/达人|红人|博主|主播|账号/, entityField],
    [/上线日期|发布时间|日期|时间/, dateField],
    [/产品|商品/, firstExisting(headers, ["挂车产品", "寄样产品", "产品", "商品"])],
    [/视频(?:链接|地址)?|链接/, firstExisting(headers, ["视频上线地址", "视频地址", "链接"])],
    [/曝光|播放/, firstExisting(headers, ["视频曝光K", "曝光", "播放量"])],
    [/销量|售出|卖出/, firstExisting(headers, ["售出数量", "销量", "数量"])],
    [/销售额|成交额|金额/, firstExisting(headers, ["销售额", "实付金额", "金额"])],
    [/粉丝/, firstExisting(headers, ["粉丝量(K)", "粉丝数(K)", "粉丝量", "粉丝数"])],
    [/开发人|负责人/, firstExisting(headers, ["开发人", "负责人"])],
    [/备注/, firstExisting(headers, ["备注"])],
  ];
  for (const [pattern, field] of aliases) {
    if (field && pattern.test(question) && !selected.includes(field)) selected.push(field);
  }
  return selected;
}

function defaultRecordFields(table: TableData, entityField: string | null, dateField: string | null): string[] {
  const family = tableFamily(table);
  const candidates = family === "online"
    ? [entityField, dateField, "开发人", "挂车产品", "视频上线地址", "视频曝光K", "售出数量", "销售额"]
    : family === "cooperation"
      ? [entityField, dateField, "开发人", "粉丝数(K)", "寄样产品", "合作方式", "主页", "备注"]
      : family === "development"
        ? [dateField, entityField, "开发人", "邮箱", "whatsapp", "联盟", "最终归属", "备注"]
        : [
            entityField,
            dateField,
            "单量",
            "数量",
            "商品卡出单量",
            "商品卡出单数量",
            "销售额",
            "店铺浏览量",
            "总单量",
            "总数量",
            "店铺销售额",
            "转化率",
            "出单视频",
          ];
  return [...new Set(candidates.filter((field): field is string => Boolean(field) && table.headers.includes(field as string)))].slice(0, 8);
}

function isStoreScopedRoiField(field: string): boolean {
  if (/广告(?:花费|出单量)$/.test(field)) return true;
  return [
    "店铺浏览量",
    "总单量",
    "总数量",
    "转化率",
    "店铺商品卡出单量",
    "店铺商品卡出单量(API)",
    "店铺销售额",
    "总广告出单量",
    "总广告花费",
    "退货量",
  ].includes(field);
}


function looksLikeNamedEntityHint(hint: string): boolean {
  const compact = hint.replace(/\s+/g, "");
  return /[A-Za-z0-9_@.-]{3,}/.test(compact);
}

function describeMetricChoices(table: TableData): string {
  const family = tableFamily(table);
  if (family === "online") return "你想看上线次数、最近视频、销量、销售额，还是曝光量？";
  if (family === "cooperation") return "你想看合作次数、最近合作、寄样产品，还是联系方式？";
  if (family === "development") return "你想查开发记录、邮箱、WhatsApp，还是归属情况？";
  return "你想统计哪个指标？请说一个字段或业务目标。";
}

export function parseQuestion(
  question: string,
  table: TableData,
  roles: FieldRoles,
  now = new Date(),
  context?: ConversationContext,
  storeAggregateLabel = "TechWave",
): ParsedQuestion {
  const text = question.trim();
  if (!text) throw new Error("问题不能为空");
  const style = responseStyle(text);
  const dates = parseDates(text, now);
  const explicitEntity = explicitEntityFromQuestion(text, table);
  let directEntity = explicitEntity ?? findDirectEntityAcrossHeaders(text, table);

  const usesContext = contextualReference(text);
  if (!directEntity && usesContext && context?.lastEntityValue) {
    const contextField = mapContextEntityField(context, table);
    if (contextField) directEntity = { field: contextField, value: context.lastEntityValue };
  }
  if (!directEntity && usesContext && !context?.lastEntityValue) {
    throw new ClarificationError("你说的“他/它/这个”具体指哪个达人或产品？请直接发名称。", ["达人名称", "产品名称"]);
  }

  const numericFilters = numericFiltersFromQuestion(text, table.headers);
  const storeScopedFilter = numericFilters.find((filter) => isStoreScopedRoiField(filter.field));
  if (storeScopedFilter && tableFamily(table) === "roi" && table.headers.includes("商品")) {
    if (directEntity && directEntity.field === "商品" && directEntity.value !== storeAggregateLabel) {
      throw new ClarificationError(`“${storeScopedFilter.field}”是${storeAggregateLabel}全店指标，不属于单个商品。请查询${storeAggregateLabel}店铺，或改用商品级指标。`);
    }
    if (!directEntity) directEntity = { field: "商品", value: storeAggregateLabel };
  }

  const entityField = directEntity?.field ?? resolveEntityAlias(text, table, roles);
  const dateField = resolveDateField(text, table, roles);
  if (dates.mentioned && !dateField) {
    throw new ClarificationError("这张表里有多个或没有明确日期字段。你想按哪个日期统计？", roles.ambiguous.date ?? []);
  }

  const metricAlias = resolveMetricAlias(text, table, roles);
  const isExportRequest = /导出|导成(?:文件|表格|csv|excel)?|(?:整理|生成|做)成?(?:csv|excel|文件)/i.test(text);
  const asksRanking = /最高|最低|最好|最差|最多|最少|排名|排行|top\s*\d*|前\s*\d+/i.test(text);
  const isRecentRecords = /最近|最新|最后一次|最近一次/.test(text)
    && /记录|视频|合作|上线|哪条|什么时候|日期/.test(text)
    && !asksRanking;
  const isRecordRequest = /全部记录|记录明细|明细记录|返回以下.*字段|列出.*记录|查.*记录|视频列表|哪几条|最近\d*条/.test(text) || isRecentRecords || isExportRequest;
  const isFollowerLookup = /粉丝.*(?:多少|几|情况)|(?:多少|几).*粉丝/.test(text) && !/最高|最低|排名/.test(text);
  const isSingleValueLookup = isFollowerLookup || /联系方式|邮箱|whatsapp|主页/.test(text);
  const isQuantitySum = /销量|卖了多少(?!钱)|卖出多少|卖得|带货|售出|卖了几件|出单|订单量|件数/.test(text);
  const isAmountSum = /卖了多少钱|卖多少钱|销售额|成交额|gmv|营收|收入|金额/.test(text);
  const isOtherSum = /曝光|播放量|佣金|利润|成本/.test(text) && /多少|合计|总计|总和|一共|汇总|最高|最低|平均/.test(text);
  const distinctTarget = /(?:多少|几个|几位)(?:个|位)?(达人|红人|博主|主播|账号|产品|商品)/.test(text);
  const countAction = /(?:上线|合作).*(?:几次|多少次|多少条|有多少)|(?:几次|多少次|多少条).*(?:上线|合作)|记录总数|记录数|匹配到多少|有多少条/.test(text);
  const countRanking = /(?:上线|合作|视频).*(?:最多|最少)|(?:最多|最少).*(?:上线|合作|视频)/.test(text);
  const broadOverview = /整体表现|表现怎么样|表现如何|趋势怎么样|趋势如何|趋势|走势|销售表现|带货表现|效果怎么样|整体数据|卖得怎么样|好不好/.test(text);

  let intentName: QueryIntent["intent"];
  if (isRecordRequest || isFollowerLookup || /联系方式|邮箱|whatsapp|主页|备注是什么/.test(text)) intentName = "records";
  else if (/平均|均值/.test(text)) intentName = "average";
  else if (countRanking) intentName = "rank_count";
  else if (asksRanking) intentName = "rank";
  else if (distinctTarget && !directEntity) intentName = "distinct_count";
  else if (isQuantitySum || isAmountSum || isOtherSum || /合计|总计|总和|求和/.test(text)) intentName = "sum";
  else if (countAction || /上线(?:了|过)?(?:吗|没有)?$/.test(text)) intentName = "count";
  else if (/有哪些|列出.*分类|所有产品|所有达人/.test(text)) intentName = "list";
  else if (/上线/.test(text) && directEntity) intentName = "count";
  else if (/合作/.test(text) && directEntity) intentName = "count";
  else if (broadOverview || /概览|汇总|简报/.test(text)) intentName = "summary";
  else if (/情况|怎么样|查一下|看一下|帮我查/.test(text)) throw new ClarificationError(describeMetricChoices(table));
  else intentName = metricAlias ? "sum" : "summary";

  let metricField = metricAlias;
  if (["count", "distinct_count", "rank_count", "list", "summary", "records"].includes(intentName)) metricField = null;
  if ((intentName === "sum" || intentName === "average" || intentName === "rank") && !metricField) {
    throw new ClarificationError(describeMetricChoices(table));
  }

  let matchedEntity: string | null = directEntity?.value ?? null;
  if (!matchedEntity && entityField && intentName !== "summary" && intentName !== "rank" && intentName !== "rank_count" && intentName !== "distinct_count") {
    const values = table.rows.map((row) => String(row[entityField] ?? "").trim()).filter(Boolean);
    const direct = [...new Set(values)].filter((value) => normalizeText(text).includes(normalizeText(value)));
    if (direct.length === 1) matchedEntity = direct[0];
    else if (direct.length > 1) {
      const longest = direct.sort((a, b) => normalizeText(b).length - normalizeText(a).length);
      if (normalizeText(longest[0]).length > normalizeText(longest[1]).length) matchedEntity = longest[0];
      else throw new ClarificationError(`我找到多个相近对象：${direct.slice(0, 8).join("、")}。你指哪一个？`, direct.slice(0, 8));
    } else {
      const hint = extractEntityHint(text, table, metricField);
      if (hint && numericFilters.length === 0) {
        const match = matchEntityValue(hint, values);
        if (match.status === "matched") matchedEntity = match.value;
        if (match.status === "ambiguous") throw new ClarificationError(`我找到多个相近对象：${match.candidates.join("、")}。你指哪一个？`, match.candidates);
        if (match.status === "not_found" && (explicitEntity || looksLikeNamedEntityHint(hint))) {
          throw new Error(`没有找到查询对象“${explicitEntity?.value ?? hint}”`);
        }
      }
    }
  }

  if ((intentName === "rank" || intentName === "rank_count") && !entityField) {
    throw new ClarificationError("你想按达人排名，还是按产品排名？", ["按达人", "按产品"]);
  }
  if (intentName === "distinct_count" && !entityField) {
    throw new ClarificationError("你想统计不同达人数量，还是不同产品数量？", ["达人数量", "产品数量"]);
  }

  const recent = /最近|最新|最后/.test(text) || isSingleValueLookup;
  const sortDirection = /最低|最少|最差|升序|最早/.test(text) ? "asc" : (intentName === "rank" || intentName === "rank_count" || recent) ? "desc" : null;
  const defaultLimit = (intentName === "rank" || intentName === "rank_count") && /谁|哪个|哪位|第一名|什么(?:产品|商品|达人|红人)/.test(text) ? 1 : 10;
  const limit = isSingleValueLookup ? 1 : parseLimit(text, defaultLimit);
  const implicitRecentRange = !dates.mentioned
    && /最近|近期|这几天/.test(text)
    && ["rank", "rank_count", "summary"].includes(intentName)
    && Boolean(dateField);
  const startDate = implicitRecentRange ? shiftDate(now, -7) : dates.startDate;
  const endDate = implicitRecentRange ? shiftDate(now, -1) : dates.endDate;
  let selectFields = intentName === "records" ? selectFieldsFromQuestion(text, table, entityField, dateField) : [];
  if (intentName === "records") {
    const defaults = defaultRecordFields(table, entityField, dateField);
    if (isExportRequest) {
      selectFields = [...new Set([entityField, dateField, ...numericFilters.map((filter) => filter.field), ...selectFields, ...defaults]
        .filter((field): field is string => Boolean(field)))];
    } else if (selectFields.length === 0) selectFields = defaults;
    else if (recent) selectFields = [...new Set([entityField, dateField, ...selectFields].filter((field): field is string => Boolean(field)))];
  }

  return {
    matchedEntity,
    intent: {
      intent: intentName,
      metricField,
      entityField,
      entityValue: matchedEntity,
      dateField,
      startDate,
      endDate,
      sortDirection,
      sortField: recent ? dateField : intentName === "rank" ? metricField : null,
      limit,
      selectFields,
      responseStyle: style,
      ...(numericFilters.length > 0 ? { numericFilters } : {}),
      ...(isExportRequest ? { outputMode: "export" as const } : {}),
    },
  };
}
