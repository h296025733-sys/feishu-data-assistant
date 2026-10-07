import type { ConversationContext, DataSource, QueryIntent, TableData } from "../types/index.js";
import { inferFieldRoles } from "../importer/inspect.js";
import { filterSensitiveHeaders } from "../utils/security.js";
import { formatAnswer } from "../query/answer.js";
import { executeQuery } from "../query/engine.js";
import { ClarificationError } from "../query/errors.js";
import { parseQuestion } from "../query/parser.js";
import { entityValueMatches } from "../query/overview.js";
import { parseNumber, toDateKey, normalizeText } from "../utils/value.js";
import type {
  AnswerRefinementEvidence,
  BusinessQueryDomain,
  ModelParseResult,
  ModelProvider,
} from "../ai/types.js";
import { buildAnalysisEvidence } from "../ai/analysis-evidence.js";
import { buildCsvExport, type CsvExport } from "../query/export.js";
import { loadBusinessProfile, type BusinessProfile } from "../config/business-profile.js";
import { formatReadableBotReply } from "./reply-layout.js";
import { formatCurrencyAmount, isMoneyField } from "./currency.js";

export interface AnswerWithContextResult {
  text: string;
  context: ConversationContext;
  exportFile?: CsvExport;
}

export function emptyConversationContext(): ConversationContext {
  return {
    lastEntityValue: null,
    lastEntityField: null,
    lastMetricField: null,
    lastDateField: null,
    lastStartDate: null,
    lastEndDate: null,
    lastTableHint: null,
    lastSelectFields: [],
    lastQuestion: null,
    updatedAt: 0,
  };
}

export async function answerQuestion(dataSource: DataSource, provider: ModelProvider, question: string): Promise<string> {
  return (await answerQuestionWithContext(dataSource, provider, question, emptyConversationContext())).text;
}

export async function answerQuestionWithContext(
  dataSource: DataSource,
  provider: ModelProvider,
  question: string,
  context: ConversationContext,
  profile: BusinessProfile = loadBusinessProfile(),
  storeKnowledge: readonly string[] = [],
): Promise<AnswerWithContextResult> {
  if (/投产比固定经营简报/.test(question)) {
    const roi = await dataSource.getTable(profile.tables.roi);
    return answerFixedRoiBrief(roi, provider, context, question, profile);
  }
  if (/红人上线表固定查询/.test(question)) {
    const online = await dataSource.getTable(profile.tables.online);
    return answerRecentOnlineVideos(online, context, question, profile);
  }
  const contextualQuestion = applyContextHints(question, context);
  const modelQuestion = withStoreKnowledge(contextualQuestion, storeKnowledge);
  const route = !questionContainsSensitiveData(contextualQuestion) && provider.routeQuestion
    ? await provider.routeQuestion(modelQuestion, context.lastTableHint)
    : null;
  const deterministicDomain = deterministicBusinessDomain(contextualQuestion);
  const effectiveQuestion = applyRouteHint(
    contextualQuestion,
    deterministicDomain ?? (route && route.confidence >= 0.55 ? route.domain : null),
  );
  const modelEffectiveQuestion = withStoreKnowledge(effectiveQuestion, storeKnowledge);
  if (/上下文数据域：(?:开发、)?合作和上线|上下文数据域：综合/.test(effectiveQuestion)) {
    return answerComprehensiveOverview(dataSource, provider, effectiveQuestion, context, question, profile);
  }
  const table = await dataSource.getTable(effectiveQuestion);
  const onlineAnswer = answerOnlineTableQuestion(table, effectiveQuestion, context, question);
  if (onlineAnswer) return onlineAnswer;
  const specialized = await answerSpecializedBusinessQuestion(
    table,
    provider,
    effectiveQuestion,
    context,
    question,
    profile,
  );
  if (specialized) return specialized;
  const roles = inferFieldRoles(table.headers);
  const local = parseWithModelFriendlyFallback(effectiveQuestion, table, roles, context, profile, provider);
  const safeHeaders = filterSensitiveHeaders(table.headers);
  const safeRoles = {
    dateField: roles.dateField && safeHeaders.includes(roles.dateField) ? roles.dateField : null,
    entityField: roles.entityField && safeHeaders.includes(roles.entityField) ? roles.entityField : null,
    amountField: roles.amountField && safeHeaders.includes(roles.amountField) ? roles.amountField : null,
    quantityField: roles.quantityField && safeHeaders.includes(roles.quantityField) ? roles.quantityField : null,
    ambiguous: Object.fromEntries(Object.entries(roles.ambiguous).map(([key, fields]) => [key, fields?.filter((field) => safeHeaders.includes(field))])),
  };
  const candidatesByField = buildEntityCandidatesByField(table, safeHeaders);
  const primaryCandidates = local.intent.entityField
    ? candidatesByField[local.intent.entityField] ?? []
    : safeRoles.entityField ? candidatesByField[safeRoles.entityField] ?? [] : [];
  const locallyTargetsSpecificFields = local.intent.intent !== "summary"
    || local.intent.entityValue != null
    || local.intent.selectFields.length > 0;
  const usesSensitiveField = questionContainsSensitiveData(effectiveQuestion)
    || (locallyTargetsSpecificFields
      && [
        local.intent.metricField,
        local.intent.entityField,
        local.intent.dateField,
        local.intent.sortField,
        ...local.intent.selectFields,
        ...(local.intent.numericFilters ?? []).map((filter) => filter.field),
      ]
        .some((field) => field != null && !safeHeaders.includes(field)));

  if (!usesSensitiveField && provider.analyze && local.intent.outputMode !== "export" && isAnalysisRequest(question)) {
    const evidence = {
      ...buildAnalysisEvidence(table, local.intent),
      currencyCode: profile.tiktok.currencyCode ?? null,
    };
    const analysis = await provider.analyze(modelEffectiveQuestion, evidence);
    if (analysis && analysisStaysWithinRequestedRange(analysis.text, local.intent)) {
      const rangeHeader = fixedRangeHeader(local.intent);
      const coverageWarning = buildRequestedCoverageWarning(table, local.intent, question, profile);
      return {
        text: formatReadableBotReply([
          rangeHeader,
          coverageWarning,
          analysis.text,
        ].filter((line): line is string => Boolean(line)).join("\n\n")),
        context: updateConversationContext(context, local.intent, table, question),
      };
    }
  }

  const parsed: ModelParseResult = usesSensitiveField || provider.name !== "deepseek" ? {
    intent: local.intent,
    trace: {
      source: "local",
      model: null,
      durationMs: 0,
      fallbackReason: usesSensitiveField ? "问题涉及敏感字段，未发送给模型" : null,
    },
  } : await provider.parseIntent(modelEffectiveQuestion, {
    headers: safeHeaders,
    roles: safeRoles,
    entityCandidates: primaryCandidates,
    entityCandidatesByField: candidatesByField,
  }, local.intent);

  const intent = preserveLocalConstraints(
    local.intent,
    parsed.intent,
    effectiveQuestion,
    Boolean(provider.analyze) && isAnalysisRequest(question),
  );
  assertExecutableQueryIntent(effectiveQuestion, intent);
  const result = executeQuery(table, intent);
  const nextContext = updateConversationContext(context, intent, table, question);
  if (intent.outputMode === "export") {
    if (intent.intent !== "records" || !Array.isArray(result.value)) {
      throw new Error("导出任务没有生成记录明细");
    }
    if (result.matchedRows === 0) {
      return {
        text: `已完成筛选：${result.dateRange}没有符合条件的记录，因此没有生成空CSV文件。`,
        context: nextContext,
      };
    }
    const exportFile = buildCsvExport(
      result.value as Array<Record<string, unknown>>,
      new Date(),
      profile.businessDisplayName,
    );
    return {
      text: `已按条件筛选 ${result.matchedRows} 条记录，CSV 文件已生成。\n日期范围：${result.dateRange}。`,
      context: nextContext,
      exportFile,
    };
  }
  const currencyCode = profile.tiktok.currencyCode ?? null;
  const draft = formatAnswer(table, result, intent, parsed.trace, question, currencyCode);
  const coverageWarning = buildRequestedCoverageWarning(table, intent, question, profile);
  const refined = !usesSensitiveField && provider.refineAnswer && shouldRefineAnswer(question, intent, result.matchedRows)
    ? await provider.refineAnswer(question, buildAnswerRefinementEvidence(
        table.sheetName,
        result,
        safeHeaders,
        draft,
        currencyCode,
      ))
    : null;
  const answer = formatReadableBotReply(selectSafeRefinement(
      refined?.text,
      draft,
      [
        ...(currencyCode && draft.includes(currencyCode) ? [currencyCode] : []),
        ...resultFactAnchors(result.value),
      ],
  ));
  const rangeHeader = fixedRangeHeader(intent);
  return {
    text: [rangeHeader, coverageWarning, answer]
      .filter((line): line is string => Boolean(line))
      .join("\n\n"),
    context: nextContext,
  };
}

function fixedRangeHeader(intent: QueryIntent): string | null {
  if (!intent.startDate || !intent.endDate) return null;
  const days = calendarDateKeys(intent.startDate, intent.endDate).length;
  return `📅 固定口径：${intent.startDate} 至 ${intent.endDate}（${days}个完整日）`;
}

function analysisStaysWithinRequestedRange(text: string, intent: QueryIntent): boolean {
  if (!intent.startDate || !intent.endDate) return true;
  const requestedDays = calendarDateKeys(intent.startDate, intent.endDate).length;
  const dayClaims = [...text.matchAll(/(?:近|最近|过去|共|覆盖|完整|合计)\s*(\d{1,3})\s*(?:天|日)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  if (dayClaims.some((days) => days > requestedDays)) return false;

  const expectedYear = intent.endDate.slice(0, 4);
  const dateClaims = [...text.matchAll(/(?:(20\d{2})\s*(?:年|[./-]))?\s*(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})\s*(?:日|号)?/g)]
    .map((match) => {
      const year = match[1] ?? expectedYear;
      const month = match[2].padStart(2, "0");
      const day = match[3].padStart(2, "0");
      return `${year}-${month}-${day}`;
    })
    .filter((date) => /^20\d{2}-\d{2}-\d{2}$/.test(date));
  return dateClaims.every((date) => date >= intent.startDate! && date <= intent.endDate!);
}

function buildRequestedCoverageWarning(
  table: TableData,
  intent: QueryIntent,
  question: string,
  profile: BusinessProfile,
): string | null {
  const requestedDays = extractRecentDays(question);
  if (!requestedDays || !intent.startDate || !intent.endDate) return null;
  if (normalizeText(table.sheetName) !== normalizeText(profile.tables.roi)) return null;
  const dateField = intent.dateField ?? firstAvailable(table.headers, ["日期"]);
  if (!dateField) return null;
  let rows = table.rows.filter((row) => {
    const date = toDateKey(row[dateField]);
    return Boolean(date && date >= intent.startDate! && date <= intent.endDate!);
  });
  if (intent.entityField && intent.entityValue) {
    rows = rows.filter((row) => entityValueMatches(intent.entityField!, row[intent.entityField!], intent.entityValue!));
  } else {
    const productField = firstAvailable(table.headers, ["商品", "产品"]);
    if (productField) {
      const aggregateRows = rows.filter((row) => entityValueMatches(productField, row[productField], profile.storeAggregateLabel));
      if (aggregateRows.length > 0) rows = aggregateRows;
    }
  }
  const presentDates = [...new Set(rows
    .map((row) => toDateKey(row[dateField]))
    .filter((date): date is string => Boolean(date)))]
    .sort();
  if (presentDates.length >= requestedDays) return null;
  const expectedDates = calendarDateKeys(intent.startDate, intent.endDate);
  const present = new Set(presentDates);
  const missingDates = expectedDates.filter((date) => !present.has(date));
  const actualRange = presentDates.length > 0
    ? `${presentDates[0]} 至 ${presentDates.at(-1)}`
    : "暂无覆盖日期";
  return [
    `⚠️ 你问的是最近${requestedDays}个完整日（${intent.startDate} 至 ${intent.endDate}）。`,
    `📚 当前表格只覆盖其中${presentDates.length}日（${actualRange}），还缺${missingDates.length}日。`,
    `下面只汇总已覆盖的${presentDates.length}日；缺失日期没有被当成0，也不冒充完整${requestedDays}日。`,
  ].join("\n");
}

function withStoreKnowledge(question: string, facts: readonly string[]): string {
  const selected = facts.map((fact) => fact.trim()).filter(Boolean).slice(0, 8);
  if (selected.length === 0) return question;
  return [
    question,
    "店铺长期知识（仅用于理解团队说法；实时数字必须以表格为准）：",
    ...selected.map((fact) => `- ${fact}`),
  ].join("\n");
}

function deterministicBusinessDomain(question: string): BusinessQueryDomain | null {
  const currentInput = (question.match(/(?:^|\n)当前追问：([^\n]+)/)?.[1] ?? question).trim();
  if (/^@?[a-z][a-z0-9._]{1,31}$/i.test(currentInput)) return "comprehensive";
  if (/(?:合作|寄样).*(?:和|与|及|还有).*(?:上线|视频)|(?:上线|视频).*(?:和|与|及|还有).*(?:合作|寄样)/.test(question)) {
    return "comprehensive";
  }
  if (/(?:达人|红人|视频).*(?:售出数量).*(?:最多|最高|排名|排行|商品|产品)|(?:已有记录|表格有数据|全部历史).*(?:达人|红人|视频)?.*售出数量/.test(question)) {
    return "online";
  }
  if (/(?:达人|红人).*(?:售卖量|销量|卖了多少|卖出多少|售卖了多少|售出多少|数量)|(?:跟|与).*(?:达人|红人).*(?:有关的)?(?:售卖量|销量|数量)/.test(question)) {
    return "roi";
  }
  if (/上线|视频地址|视频链接|视频曝光|播放量|VV/i.test(question)
    && !/销量|销售额|单量|商品卡|达人出单|卖得|售卖|趋势/.test(question)) return "online";
  if (/销量|销售额|单量|数量|商品卡|达人出单|转化率|店铺浏览量|投产|广告花费|经营|卖得|售卖|成交|增加|增长|下降|平淡|趋势/.test(question)) {
    return "roi";
  }
  return null;
}

function answerOnlineTableQuestion(
  table: TableData,
  question: string,
  context: ConversationContext,
  originalQuestion: string,
): AnswerWithContextResult | null {
  if (!isOnlineVideoTable(table)) return null;
  const salesRanking = answerOnlineProductSalesRanking(table, question, context, originalQuestion);
  if (salesRanking) return salesRanking;
  return answerOnlineVideoActivity(table, question, context, originalQuestion);
}

function isOnlineVideoTable(table: TableData): boolean {
  return /上线/.test(table.sheetName)
    || Boolean(
      firstAvailable(table.headers, ["实上线日期(Ct)", "实上线日期(CT)", "实上线日期", "上线日期"])
      && firstAvailable(table.headers, ["达人姓名", "红人姓名", "TK号"])
      && firstAvailable(table.headers, ["视频上线地址", "视频地址", "视频链接", "链接"]),
    );
}

function validOnlineVideoRows(table: TableData): Array<{ row: TableData["rows"][number]; date: string; index: number }> {
  const dateField = firstAvailable(table.headers, ["实上线日期(Ct)", "实上线日期(CT)", "实上线日期", "上线日期", "发布日期"]);
  const creatorField = firstAvailable(table.headers, ["达人姓名", "红人姓名", "TK号"]);
  const linkField = firstAvailable(table.headers, ["视频上线地址", "视频地址", "视频链接", "链接"]);
  if (!dateField || (!creatorField && !linkField)) return [];
  return table.rows
    .map((row, index) => ({ row, index, date: toDateKey(row[dateField]) }))
    .filter((item): item is { row: TableData["rows"][number]; index: number; date: string } => (
      Boolean(item.date)
      && Boolean(
        (creatorField && readableCell(item.row[creatorField]))
        || (linkField && readableCell(item.row[linkField])),
      )
    ));
}

function answerOnlineVideoActivity(
  table: TableData,
  question: string,
  context: ConversationContext,
  originalQuestion: string,
): AnswerWithContextResult | null {
  const currentInput = currentFollowUpInput(question);
  const previousAskedActivity = /(?:上线视频|视频上线|上线了?)(?:吗|几次|多少|哪些|哪几)/.test(question);
  const asksActivity = /(?:上线视频|视频上线|上线了?)(?:吗|几次|多少|哪些|哪几)|(?:哪|分别).*(?:次|条)|具体.*(?:视频|上线)/.test(currentInput);
  if (!asksActivity && !previousAskedActivity) return null;

  const dateField = firstAvailable(table.headers, ["实上线日期(Ct)", "实上线日期(CT)", "实上线日期", "上线日期", "发布日期"]);
  const creatorField = firstAvailable(table.headers, ["达人姓名", "红人姓名", "TK号"]);
  const productField = firstAvailable(table.headers, ["挂车产品", "商品", "产品"]);
  const linkField = firstAvailable(table.headers, ["视频上线地址", "视频地址", "视频链接", "链接"]);
  if (!dateField || !creatorField) return null;
  const namesSpecificCreator = table.rows
    .map((row) => readableCell(row[creatorField]))
    .filter(Boolean)
    .some((creator) => normalizeText(question).includes(normalizeText(creator)));
  if (namesSpecificCreator) return null;

  const valid = validOnlineVideoRows(table);
  const allDates = table.rows.map((row) => toDateKey(row[dateField])).filter((value): value is string => Boolean(value)).sort();
  const month = extractCalendarMonth(question, allDates.at(-1) ?? new Date().toISOString().slice(0, 10));
  const range = month ?? (
    context.lastStartDate && context.lastEndDate && /哪|分别|具体/.test(currentInput)
      ? { startDate: context.lastStartDate, endDate: context.lastEndDate, label: `${context.lastStartDate} 至 ${context.lastEndDate}` }
      : null
  );
  const selected = valid
    .filter((item) => !range || (item.date >= range.startDate && item.date <= range.endDate))
    .sort((left, right) => left.date.localeCompare(right.date) || left.index - right.index);
  const placeholders = table.rows.filter((row) => {
    const date = toDateKey(row[dateField]);
    if (!date || (range && (date < range.startDate || date > range.endDate))) return false;
    return !valid.some((item) => item.row === row);
  }).length;
  const wantsDetails = /哪|分别|明细|具体|列|地址|链接/.test(currentInput);
  const lines = [
    `📌 ${range?.label ?? "全部已有记录"}：有效上线视频 ${selected.length} 条。`,
    "",
    ...(wantsDetails && selected.length > 0
      ? selected.flatMap((item, index) => {
          const creator = readableCell(item.row[creatorField]) || "达人未填写";
          const product = productField ? readableCell(item.row[productField]) : "";
          const link = linkField ? readableCell(item.row[linkField]) : "";
          return [
            `${index + 1}. ${item.date}｜${creator}${product ? `｜${product}` : ""}`,
            link ? `   🔗 ${link}` : null,
          ];
        })
      : []),
    placeholders > 0 ? `🧹 另有 ${placeholders} 条只有日期、没有达人或视频链接的占位记录，已排除。` : null,
    selected.length === 0
      ? "🎯 结论：这个范围没有真实上线视频，不能把空占位行算成上线次数。"
      : wantsDetails
        ? `🎯 结论：上面就是这 ${selected.length} 条有效视频。`
        : "想看具体达人、日期和链接，继续问“分别是哪几条”就行。",
  ].filter((line): line is string => line !== null);
  const startDate = range?.startDate ?? selected[0]?.date ?? allDates[0] ?? null;
  const endDate = range?.endDate ?? selected.at(-1)?.date ?? allDates.at(-1) ?? null;
  return {
    text: lines.join("\n"),
    context: {
      ...context,
      lastEntityValue: null,
      lastEntityField: creatorField,
      lastMetricField: "有效上线视频数",
      lastDateField: dateField,
      lastStartDate: startDate,
      lastEndDate: endDate,
      lastTableHint: "online",
      lastSelectFields: [creatorField, productField, dateField, linkField].filter((field): field is string => Boolean(field)),
      lastQuestion: originalQuestion,
      updatedAt: Date.now(),
    },
  };
}

function answerOnlineProductSalesRanking(
  table: TableData,
  question: string,
  context: ConversationContext,
  originalQuestion: string,
): AnswerWithContextResult | null {
  const semantic = question.replace(/上下文数据域：[^\n]+/g, "");
  if (!/(?:达人|红人|视频).*(?:售出数量).*(?:最多|最高|排名|排行|商品|产品)|(?:已有记录|表格有数据|全部历史).*(?:达人|红人|视频)?.*售出数量/.test(semantic)) return null;
  const productField = firstAvailable(table.headers, ["挂车产品", "商品", "产品"]);
  const quantityField = firstAvailable(table.headers, ["售出数量"]);
  const dateField = firstAvailable(table.headers, ["实上线日期(Ct)", "实上线日期(CT)", "实上线日期", "上线日期", "发布日期"]);
  if (!productField || !quantityField || !dateField) return null;
  const valid = validOnlineVideoRows(table).filter((item) => readableCell(item.row[productField]));
  if (valid.length === 0) {
    throw new ClarificationError("红人上线表还没有带商品的有效视频记录。", ["查看最新上线视频"]);
  }
  const ranked = new Map<string, number>();
  for (const item of valid) {
    const product = readableCell(item.row[productField]);
    ranked.set(product, (ranked.get(product) ?? 0) + (parseNumber(item.row[quantityField]) ?? 0));
  }
  const result = [...ranked.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN"));
  const [winner, quantity] = result[0];
  const dates = valid.map((item) => item.date).sort();
  const lines = [
    "📌 按红人上线表的全部有效记录统计：",
    "",
    `🥇 ${winner}：${formatNumber(quantity)}件`,
    `🎬 有效视频：${valid.length}条`,
    `🗓️ 记录范围：${dates[0]} 至 ${dates.at(-1)}`,
    "",
    `📊 口径：逐条汇总“${quantityField}”，没有拿投产比里的总销量替代。`,
    `🎯 结论：${winner}是当前达人视频售出数量最高的商品。`,
  ];
  return {
    text: lines.join("\n"),
    context: {
      ...context,
      lastEntityValue: winner,
      lastEntityField: productField,
      lastMetricField: quantityField,
      lastDateField: dateField,
      lastStartDate: dates[0],
      lastEndDate: dates.at(-1) ?? dates[0],
      lastTableHint: "online",
      lastSelectFields: [productField, quantityField, dateField],
      lastQuestion: originalQuestion,
      updatedAt: Date.now(),
    },
  };
}

function extractCalendarMonth(
  question: string,
  latestReferenceDate: string,
): { startDate: string; endDate: string; label: string } | null {
  const matched = question.match(/(?:(20\d{2})\s*年\s*)?([一二两三四五六七八九十]{1,3}|\d{1,2})\s*月份?/);
  if (!matched) return null;
  const month = /^\d+$/.test(matched[2]) ? Number(matched[2]) : parseSmallChineseNumber(matched[2]);
  if (!month || month < 1 || month > 12) return null;
  const year = Number(matched[1] ?? latestReferenceDate.slice(0, 4));
  const padded = String(month).padStart(2, "0");
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    startDate: `${year}-${padded}-01`,
    endDate: `${year}-${padded}-${String(lastDay).padStart(2, "0")}`,
    label: `${year}年${month}月`,
  };
}

function currentFollowUpInput(question: string): string {
  return question.match(/(?:^|\n)当前追问：([^\n]+)/)?.[1]?.trim() ?? question.trim();
}

async function answerFixedRoiBrief(
  table: TableData,
  provider: ModelProvider,
  context: ConversationContext,
  originalQuestion: string,
  profile: BusinessProfile,
): Promise<AnswerWithContextResult> {
  const dateField = firstAvailable(table.headers, ["日期"]);
  const productField = firstAvailable(table.headers, ["商品", "产品"]);
  const recordTypeField = firstAvailable(table.headers, ["记录类型"]);
  if (!dateField || !productField) {
    return {
      text: `⚠️ “${profile.tables.roi}”缺少日期或商品字段，暂时无法生成固定经营简报；我没有改表，也没有用其他表代替。`,
      context: { ...context, lastQuestion: originalQuestion, updatedAt: Date.now() },
    };
  }

  const datedRows = table.rows
    .map((row) => ({ row, date: toDateKey(row[dateField]) }))
    .filter((item): item is { row: TableData["rows"][number]; date: string } => Boolean(item.date));
  const latest = datedRows.map((item) => item.date).sort().at(-1) ?? null;
  if (!latest) {
    return {
      text: `📭 最近7个完整日经营简报：当前没有可识别日期的“${profile.tables.roi}”记录。`,
      context: {
        ...context,
        lastTableHint: "roi",
        lastQuestion: originalQuestion,
        updatedAt: Date.now(),
      },
    };
  }
  const start = shiftDate(latest, -6);
  const windowRows = datedRows.filter((item) => item.date >= start && item.date <= latest);
  const aggregateNames = new Set([
    normalizeText(profile.storeAggregateLabel),
    normalizeText("店铺汇总"),
  ]);
  const isAggregate = (row: TableData["rows"][number]): boolean => {
    const product = normalizeText(readableCell(row[productField]));
    const recordType = recordTypeField ? normalizeText(readableCell(row[recordTypeField])) : "";
    return aggregateNames.has(product) || /店铺|汇总/.test(recordType);
  };
  const aggregateRows = windowRows.filter((item) => isAggregate(item.row));
  const productRows = windowRows.filter((item) => !isAggregate(item.row) && readableCell(item.row[productField]));
  const storeRows = (aggregateRows.length > 0 ? aggregateRows : productRows).map((item) => item.row);
  const coverageSource = aggregateRows.length > 0 ? aggregateRows : windowRows;
  const coverageDates = [...new Set(coverageSource.map((item) => item.date))].sort();

  const orders = preferredMetric(table, storeRows, aggregateRows.length > 0 ? ["总单量", "单量"] : ["单量", "总单量"]);
  const quantity = preferredMetric(table, storeRows, aggregateRows.length > 0 ? ["总数量", "数量"] : ["数量", "总数量"]);
  const sales = preferredMetric(table, storeRows, aggregateRows.length > 0 ? ["店铺销售额", "销售额"] : ["销售额", "店铺销售额"]);
  const shopCardOrders = preferredMetric(table, storeRows, aggregateRows.length > 0
    ? ["店铺商品卡出单量", "店铺商品卡出单量(API)", "商品卡出单量"]
    : ["商品卡出单量", "店铺商品卡出单量", "店铺商品卡出单量(API)"]);
  const creatorOrders = preferredMetric(table, storeRows, ["达人出单量"]);
  const views = preferredMetric(table, storeRows, ["店铺浏览量"]);
  const currencyCode = profile.tiktok.currencyCode ?? null;

  const productSalesField = firstAvailable(table.headers, ["销售额", "成交额", "GMV"]);
  const productSales = new Map<string, number>();
  if (productSalesField) {
    for (const item of productRows) {
      const product = readableCell(item.row[productField]);
      const value = parseNumber(item.row[productSalesField]);
      if (!product || value == null) continue;
      productSales.set(product, (productSales.get(product) ?? 0) + value);
    }
  }
  const rankedProducts = [...productSales.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN"));
  const leaders = rankedProducts.length > 0
    ? rankedProducts.filter((item) => item[1] === rankedProducts[0][1])
    : [];

  const metricLines = [
    orders || quantity
      ? `• 总单量：${orders ? `${formatNumber(orders.value)}单` : "未记录"}｜总销量：${quantity ? `${formatNumber(quantity.value)}件` : "未记录"}`
      : null,
    sales ? `• 销售额：${formatCurrencyAmount(sales.value, currencyCode)}` : null,
    shopCardOrders || creatorOrders
      ? `• 商品卡出单：${shopCardOrders ? `${formatNumber(shopCardOrders.value)}单` : "未记录"}｜达人出单：${creatorOrders ? `${formatNumber(creatorOrders.value)}单` : "未记录"}`
      : null,
    views ? `• 店铺浏览量：${formatNumber(views.value)}` : null,
  ].filter((line): line is string => Boolean(line));
  const productLine = leaders.length === 0
    ? "📦 商品销售额：当前范围没有可汇总的商品行。"
    : leaders.length === 1
      ? `📦 销售额最高商品：${leaders[0][0]}（${formatCurrencyAmount(leaders[0][1], currencyCode)}）`
      : `📦 商品销售额并列最高：${leaders.slice(0, 3).map(([name]) => name).join("、")}（均为${formatCurrencyAmount(leaders[0][1], currencyCode)}）`;
  const coverageLine = coverageDates.length < 7
    ? `⚠️ 表格在固定范围内只覆盖 ${coverageDates.length}/7 个日期；缺失日期没有当成0。`
    : null;
  const localDraft = [
    `📅 固定口径：${start} 至 ${latest}（7个完整日）`,
    "",
    `📌 ${profile.businessDisplayName} 经营简报`,
    ...metricLines,
    "",
    productLine,
    coverageLine,
    "",
    "🎯 总结：这里只汇总固定7个完整日；没有目标值或前期基线时，不擅自判断经营好坏。",
  ].filter((line): line is string => line !== null).join("\n");

  const refined = provider.refineAnswer
    ? await provider.refineAnswer(originalQuestion, {
        tableName: table.sheetName,
        dateRange: `${start} 至 ${latest}`,
        matchedRows: windowRows.length,
        metricField: "固定7日经营简报",
        currencyCode,
        result: {
          startDate: start,
          endDate: latest,
          coveredDates: coverageDates.length,
          orders: orders?.value ?? null,
          quantity: quantity?.value ?? null,
          sales: sales?.value ?? null,
          shopCardOrders: shopCardOrders?.value ?? null,
          creatorOrders: creatorOrders?.value ?? null,
          views: views?.value ?? null,
          leadingProducts: leaders.slice(0, 3),
        },
        localDraft,
      })
    : null;
  const requiredFacts = [
    start,
    latest,
    orders ? formatNumber(orders.value) : null,
    quantity ? formatNumber(quantity.value) : null,
    sales ? formatCurrencyAmount(sales.value, currencyCode) : null,
    shopCardOrders ? formatNumber(shopCardOrders.value) : null,
    creatorOrders ? formatNumber(creatorOrders.value) : null,
    views ? formatNumber(views.value) : null,
    ...leaders.slice(0, 3).map(([name]) => name),
  ].filter((value): value is string => Boolean(value));
  const safeRefinement = selectSafeRefinement(refined?.text, localDraft, requiredFacts);
  const forbiddenQualitativeClaim = /(?:优秀|低迷|冷清|强劲|疲软|正常水平|偏高|偏低|表现很好|表现很差|因为|导致|建议|应该)/.test(safeRefinement)
    && !/(?:优秀|低迷|冷清|强劲|疲软|正常水平|偏高|偏低|表现很好|表现很差|因为|导致|建议|应该)/.test(localDraft);
  const unsupportedField = ["转化率", "广告", "利润", "成本", "退货"]
    .some((field) => safeRefinement.includes(field) && !localDraft.includes(field));
  const text = forbiddenQualitativeClaim || unsupportedField ? localDraft : safeRefinement;
  return {
    text: formatReadableBotReply(text),
    context: {
      ...context,
      lastEntityValue: null,
      lastEntityField: productField,
      lastMetricField: sales?.field ?? orders?.field ?? null,
      lastDateField: dateField,
      lastStartDate: start,
      lastEndDate: latest,
      lastTableHint: "roi",
      lastSelectFields: [productField, dateField, orders?.field, quantity?.field, sales?.field]
        .filter((field): field is string => Boolean(field)),
      lastQuestion: originalQuestion,
      updatedAt: Date.now(),
    },
  };
}

function preferredMetric(
  table: TableData,
  rows: TableData["rows"],
  candidates: string[],
): { field: string; value: number } | null {
  for (const field of candidates) {
    if (!table.headers.includes(field)) continue;
    const values = rows.map((row) => parseNumber(row[field])).filter((value): value is number => value !== null);
    if (values.length > 0) return { field, value: values.reduce((sum, value) => sum + value, 0) };
  }
  return null;
}

function answerRecentOnlineVideos(
  table: TableData,
  context: ConversationContext,
  originalQuestion: string,
  profile: BusinessProfile,
): AnswerWithContextResult {
  const dateField = firstAvailable(table.headers, ["实上线日期(Ct)", "实上线日期(CT)", "实上线日期", "上线日期", "发布日期"]);
  const creatorField = firstAvailable(table.headers, ["达人姓名", "红人姓名", "TK号"]);
  const productField = firstAvailable(table.headers, ["挂车产品", "商品", "产品"]);
  const exposureField = firstAvailable(table.headers, ["视频VV", "视频曝光K", "播放量", "曝光量", "VV"]);
  const quantityField = firstAvailable(table.headers, ["售出数量", "销量", "数量"]);
  const salesField = firstAvailable(table.headers, ["销售额", "成交额", "GMV"]);
  const linkField = firstAvailable(table.headers, ["视频上线地址", "视频地址", "视频链接", "链接"]);
  if (!dateField || !creatorField) {
    return {
      text: [
        "⚠️ 最新上线视频暂时无法生成。",
        "",
        `“${profile.tables.online}”缺少上线日期或达人姓名字段；我没有改表，也没有用其他表的数据代替。`,
        "请由管理员检查字段配置后原样再点一次。",
      ].join("\n"),
      context: { ...context, lastQuestion: originalQuestion, updatedAt: Date.now() },
    };
  }
  const rows = table.rows
    .map((row, index) => ({ row, index, date: toDateKey(row[dateField]) }))
    .filter((item): item is { row: TableData["rows"][number]; index: number; date: string } => (
      Boolean(item.date) && Boolean(readableCell(item.row[creatorField]) || (linkField && readableCell(item.row[linkField])))
    ))
    .sort((left, right) => right.date.localeCompare(left.date) || right.index - left.index)
    .slice(0, 5);
  if (rows.length === 0) {
    return {
      text: [
        "📭 最新上线视频：当前 0 条。",
        "",
        `“${profile.tables.online}”目前没有同时具备实际上线日期，以及达人或视频链接的有效记录。`,
        "只有日期的空占位不会被算作上线视频。",
        "",
        `🎯 口径：只读“${profile.tables.online}”；没有混入投产比商品日报，也没有改动表格。`,
      ].join("\n"),
      context: {
        ...context,
        lastEntityValue: null,
        lastEntityField: creatorField,
        lastMetricField: exposureField,
        lastDateField: dateField,
        lastStartDate: null,
        lastEndDate: null,
        lastTableHint: "online",
        lastSelectFields: [creatorField, productField, dateField, exposureField, quantityField, salesField, linkField]
          .filter((field): field is string => Boolean(field)),
        lastQuestion: originalQuestion,
        updatedAt: Date.now(),
      },
    };
  }
  const currencyCode = profile.tiktok.currencyCode ?? null;
  const lines = [
    `🎬 最新上线视频（${rows.length}条）`,
    "",
    ...rows.flatMap(({ row, date }, index) => {
      const creator = readableCell(row[creatorField]) || "达人未填写";
      const product = productField ? readableCell(row[productField]) : "";
      const exposure = exposureField ? parseNumber(row[exposureField]) : null;
      const quantity = quantityField ? parseNumber(row[quantityField]) : null;
      const sales = salesField ? parseNumber(row[salesField]) : null;
      const link = linkField ? readableCell(row[linkField]) : "";
      return [
        `${index + 1}. ${date}｜${creator}`,
        product ? `   📦 ${product}` : null,
        [
          exposure != null ? `👀 ${formatNumber(exposure)}${/K/i.test(exposureField ?? "") ? "K" : ""} VV` : null,
          quantity != null ? `🛍️ ${formatNumber(quantity)}件` : null,
          sales != null ? `💵 ${formatCurrencyAmount(sales, currencyCode)}` : null,
        ].filter(Boolean).join("｜") || null,
        link ? `   🔗 ${link}` : null,
        index < rows.length - 1 ? "" : null,
      ];
    }),
    `🎯 口径：只读“${profile.tables.online}”，按实际上线日期倒序；没有混入投产比商品日报。`,
  ].filter((line): line is string => line !== null);
  return {
    text: lines.join("\n"),
    context: {
      ...context,
      lastEntityValue: null,
      lastEntityField: creatorField,
      lastMetricField: exposureField,
      lastDateField: dateField,
      lastStartDate: rows.at(-1)?.date ?? null,
      lastEndDate: rows[0]?.date ?? null,
      lastTableHint: "online",
      lastSelectFields: [creatorField, productField, dateField, exposureField, quantityField, salesField, linkField]
        .filter((field): field is string => Boolean(field)),
      lastQuestion: originalQuestion,
      updatedAt: Date.now(),
    },
  };
}

function readableCell(value: unknown): string {
  if (value == null || value === "") return "";
  if (Array.isArray(value)) return value.map(readableCell).filter(Boolean).join("、");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferred = record.link ?? record.url ?? record.text ?? record.name;
    return preferred != null
      ? readableCell(preferred)
      : Object.values(record).map(readableCell).filter(Boolean).join("、");
  }
  return String(value).trim();
}

function isLatestBusinessSnapshotQuestion(question: string): boolean {
  return /(?:最新|刚更新|刚同步|最近更新|本次更新).*(?:数据|经营|销售|单量|销量)|最新完整日.*(?:经营|数据)/.test(question);
}

function answerLatestDailyBusinessSnapshot(
  table: TableData,
  context: ConversationContext,
  originalQuestion: string,
  profile: BusinessProfile,
): AnswerWithContextResult {
  const dateField = firstAvailable(table.headers, ["日期"]);
  const productField = firstAvailable(table.headers, ["商品", "产品"]);
  if (!dateField || !productField) {
    throw new ClarificationError("投产比缺少商品或日期字段，暂时无法汇总最新经营数据。", ["查看投产比"]);
  }
  const dates = table.rows.map((row) => toDateKey(row[dateField])).filter((value): value is string => Boolean(value)).sort();
  const date = dates.at(-1);
  if (!date) throw new ClarificationError("投产比里还没有可用日期。", ["查看投产比"]);
  const dayRows = table.rows.filter((row) => toDateKey(row[dateField]) === date);
  const storeRows = dayRows.filter((row) => entityValueMatches(productField, row[productField], profile.storeAggregateLabel));
  const productRows = dayRows.filter((row) => {
    const product = String(row[productField] ?? "").trim();
    return product && product !== profile.storeAggregateLabel;
  });
  const sourceRows = storeRows.length > 0 ? storeRows : productRows;
  const ordersField = firstAvailable(table.headers, storeRows.length > 0 ? ["总单量", "单量"] : ["单量", "总单量"]);
  const quantityField = firstAvailable(table.headers, storeRows.length > 0 ? ["总数量", "数量"] : ["数量", "总数量"]);
  const salesField = firstAvailable(table.headers, ["销售额", "成交额", "GMV"]);
  const cardField = firstAvailable(table.headers, storeRows.length > 0 ? ["店铺商品卡出单量(API)", "店铺商品卡出单量", "商品卡出单量"] : ["商品卡出单量"]);
  const creatorField = firstAvailable(table.headers, ["达人出单量"]);
  const sales = sumField(sourceRows, salesField);
  const productSales = sumField(productRows, salesField);
  const storeSalesPresent = Boolean(salesField && storeRows.some((row) => parseNumber(row[salesField]) != null));
  const salesMismatch = Boolean(salesField && storeRows.length > 0 && (!storeSalesPresent || Math.abs(sales - productSales) > 0.005));
  const displayedSales = salesMismatch ? productSales : sales;
  const ranked = new Map<string, number>();
  for (const row of productRows) {
    const product = String(row[productField] ?? "").trim();
    ranked.set(product, (ranked.get(product) ?? 0) + (parseNumber(salesField ? row[salesField] : null) ?? 0));
  }
  const winner = [...ranked.entries()].sort((left, right) => right[1] - left[1])[0] ?? null;
  const currencyCode = profile.tiktok.currencyCode ?? null;
  const lines = [
    `📅 最新完整日：${date}`,
    "",
    ordersField ? `📋 总单量：${formatNumber(sumField(sourceRows, ordersField))}单` : null,
    quantityField ? `🛍️ 总销量：${formatNumber(sumField(sourceRows, quantityField))}件` : null,
    salesField ? `💵 ${salesMismatch ? "商品明细销售额" : "销售额"}：${formatCurrencyAmount(displayedSales, currencyCode)}` : null,
    cardField ? `🛒 商品卡出单：${formatNumber(sumField(sourceRows, cardField))}单` : null,
    creatorField ? `🎬 达人出单：${formatNumber(sumField(sourceRows, creatorField))}单` : null,
    "",
    winner ? `🥇 当天销售额最高：${winner[0]}（${formatCurrencyAmount(winner[1], currencyCode)}）` : null,
    salesMismatch
      ? storeSalesPresent
        ? `⚠️ 数据校验：店铺汇总销售额为${formatCurrencyAmount(sales, currencyCode)}，但商品明细合计为${formatCurrencyAmount(productSales, currencyCode)}；本次展示明细合计，没有把矛盾数字伪装成一致。`
        : `⚠️ 数据校验：店铺汇总行没有销售额，商品明细合计为${formatCurrencyAmount(productSales, currencyCode)}；本次展示明细合计。`
      : null,
    `🎯 总结：以上是表格已写入的最新完整日数据，不是历史30天补齐任务的统计。`,
  ].filter((line): line is string => line !== null);
  return {
    text: lines.join("\n"),
    context: specialContext(context, null, salesField ?? ordersField ?? "经营数据", { startDate: date, endDate: date }, originalQuestion),
  };
}

async function answerSpecializedBusinessQuestion(
  table: TableData,
  provider: ModelProvider,
  question: string,
  context: ConversationContext,
  originalQuestion: string,
  profile: BusinessProfile,
): Promise<AnswerWithContextResult | null> {
  if (!/商品|日期/.test(table.headers.join("|"))) return null;
  const isFollowUp = /上一轮用户问题：/.test(question);
  const semanticQuestion = isFollowUp ? question : originalQuestion;
  const finish = async (result: Promise<AnswerWithContextResult | null>): Promise<AnswerWithContextResult | null> => {
    const resolved = await result;
    if (resolved && isFollowUp && context.lastQuestion) resolved.context.lastQuestion = context.lastQuestion;
    return resolved;
  };
  if (isLatestBusinessSnapshotQuestion(semanticQuestion)) {
    return finish(Promise.resolve(answerLatestDailyBusinessSnapshot(table, context, originalQuestion, profile)));
  }
  if (/(?:展开|详细|具体|单独|说说|看看)/.test(semanticQuestion)) {
    const snapshot = await answerProductSnapshot(table, question, context, semanticQuestion, profile);
    if (snapshot) return finish(Promise.resolve(snapshot));
  }
  if (isDirectCreatorQuantityQuestion(semanticQuestion)) {
    return finish(Promise.resolve(answerCreatorAttributedQuantity(table, question, context, semanticQuestion, profile)));
  }
  if (/(?:还是|相比|比较|哪个|哪种|谁|更多|多一点|主要靠)/.test(semanticQuestion)
    && /商品卡|达人|自营|店铺|渠道/.test(semanticQuestion)) {
    return finish(answerMetricComparison(table, provider, question, context, semanticQuestion, profile));
  }
  if (/关系|影响|带动|关联|有关|导致|因为|靠.*(?:视频|达人|红人)/.test(semanticQuestion)
    && /达人|红人|视频|上线/.test(semanticQuestion)
    && /销量|销售|单量|订单|成交|卖/.test(semanticQuestion)) {
    return finish(answerSalesVideoRelationship(table, provider, question, context, semanticQuestion, profile));
  }
  if (/增加|增长|上升|下降|减少|平淡|持平|趋势|变多|变少|走高|走低/.test(semanticQuestion)) {
    return finish(answerMetricTrend(table, provider, question, context, semanticQuestion, profile));
  }
  if (isProductRankingQuestion(semanticQuestion)) {
    return finish(answerBestSellingProduct(table, provider, question, context, semanticQuestion, profile));
  }
  return null;
}

function isDirectCreatorQuantityQuestion(question: string): boolean {
  const current = currentFollowUpInput(question);
  const mentionsCreator = /达人|红人/.test(current);
  const asksQuantity = /售卖量|销量|卖了多少|卖出多少|售卖了多少|售出多少|多少数量|多少件|数量是多少/.test(current);
  const asksCausality = /有关系吗|有关联吗|影响|带动|导致|为什么|原因|趋势|增加|下降|平淡|相关系数/.test(current);
  return mentionsCreator && asksQuantity && !asksCausality;
}

function answerCreatorAttributedQuantity(
  table: TableData,
  question: string,
  context: ConversationContext,
  originalQuestion: string,
  profile: BusinessProfile,
): AnswerWithContextResult | null {
  const metric = firstAvailable(table.headers, ["达人出单数量"]);
  if (!metric) {
    throw new ClarificationError(
      "投产比目前没有“达人出单数量”字段，不能拿达人订单数冒充售出件数。",
      ["查看达人出单量", "查看投产比字段"],
    );
  }
  const entity = resolveAnalysisProduct(table, question, context, profile);
  const allHistory = usesAllRecordedHistory(question, context);
  const range = allHistory
    ? fullRecordedRange(table)
    : resolveAnalysisRange(table, question, context, extractRecentDays(originalQuestion) ?? 7);
  const rows = analysisRows(table, range, entity, profile);
  if (rows.length === 0) {
    throw new ClarificationError("这个商品和时间范围里没有达人归因销量记录。", ["查看近7天", "查看全部历史"]);
  }
  const quantity = sumField(rows, metric);
  const subject = entity ?? profile.storeAggregateLabel;
  const lines = [
    `📌 ${subject}的达人归因销量：${formatNumber(quantity)}件`,
    "",
    `🗓️ ${range.startDate} 至 ${range.endDate}`,
    `📊 口径：投产比“${metric}”${allHistory ? "，从表格最早有数据的日期累计" : ""}`,
    "",
    `🎯 结论：这不是全店总销量，也不是上线表单条视频的“售出数量”。`,
  ];
  return {
    text: lines.join("\n"),
    context: specialContext(context, entity, metric, range, originalQuestion),
  };
}

function usesAllRecordedHistory(question: string, context: ConversationContext): boolean {
  return /已有记录|表格有数据|从.*有数据.*开始|全部历史|所有历史|全部记录|累计至今|从最早/.test(question)
    || Boolean(context.lastQuestion && /已有记录|表格有数据|从.*有数据.*开始|全部历史|所有历史|全部记录|累计至今|从最早/.test(context.lastQuestion));
}

function fullRecordedRange(table: TableData): { startDate: string; endDate: string } {
  const dateField = firstAvailable(table.headers, ["日期"]);
  const dates = dateField
    ? table.rows.map((row) => toDateKey(row[dateField])).filter((value): value is string => Boolean(value)).sort()
    : [];
  if (dates.length === 0) throw new ClarificationError("投产比还没有可用日期。", ["查看投产比"]);
  return { startDate: dates[0], endDate: dates.at(-1)! };
}

async function answerProductSnapshot(
  table: TableData,
  question: string,
  context: ConversationContext,
  originalQuestion: string,
  profile: BusinessProfile,
): Promise<AnswerWithContextResult | null> {
  const product = resolveAnalysisProduct(table, originalQuestion, context, profile);
  const productField = firstAvailable(table.headers, ["商品", "产品"]);
  const dateField = firstAvailable(table.headers, ["日期"]);
  if (!product || !productField || !dateField || product === profile.storeAggregateLabel) return null;
  const days = extractRecentDays(originalQuestion) ?? 7;
  const range = resolveAnalysisRange(table, originalQuestion, context, days, false);
  const rows = analysisRows(table, range, product, profile);
  if (rows.length === 0) return null;
  const quantityField = firstAvailable(table.headers, ["数量", "总数量"]);
  const orderField = firstAvailable(table.headers, ["单量", "总单量"]);
  const salesField = firstAvailable(table.headers, ["销售额", "成交额", "GMV"]);
  const creatorField = firstAvailable(table.headers, ["达人出单量"]);
  const cardField = firstAvailable(table.headers, ["商品卡出单量"]);
  const quantity = sumField(rows, quantityField);
  const orders = sumField(rows, orderField);
  const sales = sumField(rows, salesField);
  const creatorOrders = sumField(rows, creatorField);
  const cardOrders = sumField(rows, cardField);
  const lines = [
    `📦 ${product} · 最近${days}天`,
    `🗓️ ${range.startDate} 至 ${range.endDate}`,
    "",
    quantityField ? `🛍️ 销量：${formatNumber(quantity)}件` : null,
    orderField ? `📋 单量：${formatNumber(orders)}单` : null,
    salesField ? `💵 销售额：${formatCurrencyAmount(sales, profile.tiktok.currencyCode ?? null)}` : null,
    creatorField ? `🎬 达人出单：${formatNumber(creatorOrders)}单` : null,
    cardField ? `🛒 商品卡出单：${formatNumber(cardOrders)}单` : null,
    "",
    `🎯 总结：这段时间${quantityField ? `售出${formatNumber(quantity)}件` : `记录到${formatNumber(orders)}单`}${creatorField && cardField ? `，${creatorOrders > cardOrders ? "达人渠道更多" : cardOrders > creatorOrders ? "商品卡渠道更多" : "达人和商品卡持平"}` : ""}。`,
  ].filter((line): line is string => line !== null);
  return {
    text: lines.join("\n"),
    context: specialContext(context, product, quantityField ?? orderField ?? salesField ?? "经营表现", range, originalQuestion),
  };
}

async function answerSalesVideoRelationship(
  table: TableData,
  provider: ModelProvider,
  question: string,
  context: ConversationContext,
  originalQuestion: string,
  profile: BusinessProfile,
): Promise<AnswerWithContextResult | null> {
  const dateField = firstAvailable(table.headers, ["日期"]);
  const onlineField = firstAvailable(table.headers, ["上线量"]);
  if (!dateField || !onlineField) return null;
  const entity = resolveAnalysisProduct(table, question, context, profile);
  const quantityField = entity
    ? firstAvailable(table.headers, ["数量", "总数量"])
    : firstAvailable(table.headers, ["总数量", "数量"]);
  const orderField = entity
    ? firstAvailable(table.headers, ["单量", "总单量"])
    : firstAvailable(table.headers, ["总单量", "单量"]);
  const creatorOrderField = firstAvailable(table.headers, ["达人出单量"]);
  if (!quantityField || !orderField || !creatorOrderField) return null;

  const days = extractRecentDays(originalQuestion) ?? 7;
  const recent = resolveAnalysisRange(table, question, context, days, false);
  const previous = { startDate: shiftDate(recent.startDate, -days), endDate: shiftDate(recent.startDate, -1) };
  const currentRows = analysisRows(table, recent, entity, profile);
  const previousRows = analysisRows(table, previous, entity, profile);
  if (currentRows.length === 0 || previousRows.length === 0) {
    throw new ClarificationError(
      `判断销量表现和达人视频关系，至少需要连续两段各${days}天的数据；当前历史范围还不够。`,
      [`查看最近${days}天明细`, "换短一点的周期"],
    );
  }

  const currentQuantity = sumField(currentRows, quantityField);
  const previousQuantity = sumField(previousRows, quantityField);
  const changeRate = previousQuantity === 0 ? null : (currentQuantity - previousQuantity) / previousQuantity;
  const currentOrders = sumField(currentRows, orderField);
  const creatorOrders = sumField(currentRows, creatorOrderField);
  const creatorShare = currentOrders > 0 ? creatorOrders / currentOrders : null;
  const onlineCount = sumField(currentRows, onlineField);
  const correlation = dailyCorrelation(currentRows, dateField, onlineField, quantityField);
  const subject = entity ?? profile.storeAggregateLabel;
  const performance = describeTrend(currentQuantity, previousQuantity, changeRate);
  const relation = creatorOrders > 0
    ? `达人渠道确实带来 ${formatNumber(creatorOrders)} 单，占总单量 ${formatPercent(creatorShare ?? 0)}`
    : onlineCount > 0
      ? "有达人视频上线，但当前没有记录到达人归因订单，暂时不能说视频带动了成交"
      : "最近没有新达人视频，也没有达人归因订单，当前数据不足以支持两者有关";
  const correlationText = correlation == null
    ? "上线量变化太少，无法做可靠的同期相关计算"
    : `${correlation >= 0 ? "同向" : "反向"}相关系数 ${correlation.toFixed(2)}（${describeCorrelation(correlation)}）`;
  const draft = [
    `📌 结论：${subject}最近${days}天的销量${performance}。`,
    "",
    `📦 最近${days}天：${formatNumber(currentQuantity)}件`,
    `◀️ 此前${days}天：${formatNumber(previousQuantity)}件`,
    changeRate == null
      ? "📈 此前为0，不能用普通环比百分比判断"
      : `📈 变化：${changeRate >= 0 ? "+" : ""}${(changeRate * 100).toFixed(1)}%`,
    "",
    `🎬 达人上线：${formatNumber(onlineCount)}条`,
    `🤝 达人归因：${relation}`,
    `🔎 同期走势：${correlationText}`,
    "",
    "⚠️ 说明：这些数据能判断同期关联和达人渠道贡献，但不能单凭相关性证明“发视频一定导致销量变化”。",
  ].join("\n");
  const refined = provider.refineAnswer
    ? await provider.refineAnswer(originalQuestion, {
        tableName: table.sheetName,
        dateRange: `${previous.startDate} 至 ${recent.endDate}`,
        matchedRows: currentRows.length + previousRows.length,
        metricField: `${quantityField}、${onlineField}、${creatorOrderField}`,
        currencyCode: profile.tiktok.currencyCode ?? null,
        result: {
          subject,
          recent: { ...recent, quantity: currentQuantity, onlineCount, orders: currentOrders, creatorOrders },
          previous: { ...previous, quantity: previousQuantity },
          changeRate,
          creatorShare,
          sameDayCorrelation: correlation,
          causalityBoundary: "只能判断同期关联和达人归因贡献，不能证明因果",
        },
        localDraft: draft,
      })
    : null;
  return {
    text: formatReadableBotReply(selectSafeRefinement(refined?.text, draft, [
      subject,
      formatNumber(currentQuantity),
      formatNumber(previousQuantity),
      formatNumber(onlineCount),
      formatNumber(creatorOrders),
      "不能",
    ])),
    context: specialContext(context, entity, quantityField, recent, originalQuestion),
  };
}

async function answerMetricComparison(
  table: TableData,
  provider: ModelProvider,
  question: string,
  context: ConversationContext,
  originalQuestion: string,
  profile: BusinessProfile,
): Promise<AnswerWithContextResult | null> {
  const entity = resolveAnalysisProduct(table, question, context, profile);
  const numericFields = table.headers.filter((field) => table.rows.some((row) => parseNumber(row[field]) != null));
  const local = localChannelComparisonPlan(originalQuestion, table.headers, entity == null);
  const ai = provider.resolveMetricComparison
    ? await provider.resolveMetricComparison(question, numericFields)
    : null;
  const selectedPlan = ai && ai.confidence >= 0.55 ? ai : local;
  const plan = selectedPlan ? normalizeChannelComparisonPlan(selectedPlan, table.headers, entity == null) : null;
  if (!plan || !table.headers.includes(plan.leftField) || !table.headers.includes(plan.rightField)) return null;

  // 当前问题中的时间范围必须压过旧会话范围。统一语义层会把
  // “那最近一个月呢”改成完整问题；这里直接以该完整问题计算，
  // 避免旧的7天上下文继续覆盖30天。
  const days = extractRecentDays(originalQuestion) ?? extractRecentDays(question) ?? 7;
  const range = resolveAnalysisRange(table, originalQuestion, context, days, false);
  const rows = analysisRows(table, range, entity, profile);
  if (rows.length === 0) throw new ClarificationError("这个范围里还没有能比较的商品经营数据。你可以换一个商品或时间范围。", ["近7天", "近30天"]);
  const left = sumField(rows, plan.leftField);
  const right = sumField(rows, plan.rightField);
  const total = left + right;
  const leftShare = total > 0 ? left / total : 0;
  const rightShare = total > 0 ? right / total : 0;
  const unit = /数量/.test(`${plan.leftField}${plan.rightField}`) ? "件" : "单";
  const winner = left === right ? "两边一样" : left > right ? `${plan.leftLabel}更多` : `${plan.rightLabel}更多`;
  const lacksChannelMoney = /销售(?!量)|销售额|金额/.test(originalQuestion)
    && !isMoneyField(plan.leftField)
    && !isMoneyField(plan.rightField);
  const subject = entity ?? profile.storeAggregateLabel;
  const draft = [
    `📌 结论：${range.startDate} 至 ${range.endDate}，${subject}的${winner}。`,
    "",
    `${/达人|红人/.test(plan.leftLabel) ? "🎬" : "🛒"} ${plan.leftLabel}：${formatNumber(left)}${unit}，占 ${formatPercent(leftShare)}`,
    `${/达人|红人/.test(plan.rightLabel) ? "🎬" : "🛒"} ${plan.rightLabel}：${formatNumber(right)}${unit}，占 ${formatPercent(rightShare)}`,
    "",
    lacksChannelMoney ? "⚠️ 当前表没有按渠道拆分销售额，所以这里比较的是出单量，不是成交金额。" : null,
    `🎯 总结：目前主要由${left === right ? "两种渠道共同" : left > right ? plan.leftLabel : plan.rightLabel}贡献。`,
  ].filter((line): line is string => line !== null).join("\n");
  const refined = provider.refineAnswer
    ? await provider.refineAnswer(originalQuestion, {
        tableName: table.sheetName,
        dateRange: `${range.startDate} 至 ${range.endDate}`,
        matchedRows: rows.length,
        metricField: `${plan.leftField} vs ${plan.rightField}`,
        currencyCode: profile.tiktok.currencyCode ?? null,
        result: {
          subject,
          left: { label: plan.leftLabel, field: plan.leftField, value: left, share: leftShare },
          right: { label: plan.rightLabel, field: plan.rightField, value: right, share: rightShare },
          comparisonBasis: lacksChannelMoney ? "按出单量比较；没有分渠道销售额" : "按表内两个真实指标比较",
        },
        localDraft: draft,
      })
    : null;
  return {
    text: formatReadableBotReply(selectSafeRefinement(refined?.text, draft, [
      subject,
      plan.leftLabel,
      plan.rightLabel,
      formatNumber(left),
      formatNumber(right),
      ...(lacksChannelMoney ? ["出单量"] : []),
    ])),
    context: specialContext(context, entity, plan.leftField, range, originalQuestion),
  };
}

async function answerMetricTrend(
  table: TableData,
  provider: ModelProvider,
  question: string,
  context: ConversationContext,
  originalQuestion: string,
  profile: BusinessProfile,
): Promise<AnswerWithContextResult | null> {
  const metric = /销售额|金额/.test(originalQuestion)
    ? firstAvailable(table.headers, ["销售额", "成交额", "GMV"])
    : /单量|订单/.test(originalQuestion)
      ? firstAvailable(table.headers, ["单量", "总单量"])
      : firstAvailable(table.headers, ["数量", "总数量", "单量"]);
  if (!metric) return null;
  const entity = resolveAnalysisProduct(table, question, context, profile);
  const days = extractRecentDays(originalQuestion) ?? 7;
  const recent = resolveAnalysisRange(table, question, context, days, false);
  const previous = {
    startDate: shiftDate(recent.startDate, -days),
    endDate: shiftDate(recent.startDate, -1),
  };
  const currentRows = analysisRows(table, recent, entity, profile);
  const previousRows = analysisRows(table, previous, entity, profile);
  if (currentRows.length === 0 || previousRows.length === 0) {
    throw new ClarificationError(`判断趋势至少需要连续两段各${days}天的数据；目前历史范围还不够。`, [`查看最近${days}天明细`, "换短一点的周期"]);
  }
  const currentValue = sumField(currentRows, metric);
  const previousValue = sumField(previousRows, metric);
  const delta = currentValue - previousValue;
  const changeRate = previousValue === 0 ? null : delta / previousValue;
  const direction = delta === 0 ? "持平" : delta > 0 ? "增加" : "下降";
  const currencyCode = profile.tiktok.currencyCode ?? null;
  const renderMetric = (value: number) => isMoneyField(metric)
    ? formatCurrencyAmount(value, currencyCode)
    : `${formatNumber(value)}${/数量/.test(metric) ? "件" : "单"}`;
  const subject = entity ?? profile.storeAggregateLabel;
  const draft = [
    `📈 结论：${subject}最近${days}天的${metric}${direction}。`,
    "",
    `🔹 最近${days}天（${recent.startDate} 至 ${recent.endDate}）：${renderMetric(currentValue)}`,
    `🔸 此前${days}天（${previous.startDate} 至 ${previous.endDate}）：${renderMetric(previousValue)}`,
    "",
    changeRate == null
      ? `🎯 总结：此前为0，本期为${renderMetric(currentValue)}；可以确认方向变多，但基数太低，不适合夸大增幅。`
      : `🎯 总结：变化 ${changeRate >= 0 ? "+" : ""}${(changeRate * 100).toFixed(1)}%，属于数值上的${direction}。`,
  ].join("\n");
  const refined = provider.refineAnswer
    ? await provider.refineAnswer(originalQuestion, {
        tableName: table.sheetName,
        dateRange: `${previous.startDate} 至 ${recent.endDate}`,
        matchedRows: currentRows.length + previousRows.length,
        metricField: metric,
        currencyCode,
        result: {
          subject,
          recent: { ...recent, value: currentValue },
          previous: { ...previous, value: previousValue },
          delta,
          changeRate,
          direction,
        },
        localDraft: draft,
      })
    : null;
  return {
    text: formatReadableBotReply(selectSafeRefinement(refined?.text, draft, [
      subject,
      renderMetric(currentValue),
      renderMetric(previousValue),
      direction,
      ...(isMoneyField(metric) && currencyCode ? [currencyCode] : []),
    ])),
    context: specialContext(context, entity, metric, recent, originalQuestion),
  };
}

async function answerBestSellingProduct(
  table: TableData,
  provider: ModelProvider,
  question: string,
  context: ConversationContext,
  originalQuestion: string,
  profile: BusinessProfile,
): Promise<AnswerWithContextResult | null> {
  const semanticQuestion = isProductRankingQuestion(originalQuestion) ? originalQuestion : question;
  const metric = /销量|数量|件数|跑得|跑量/.test(semanticQuestion)
    ? firstAvailable(table.headers, ["数量", "总数量"])
    : /单量|订单/.test(semanticQuestion)
      ? firstAvailable(table.headers, ["单量", "总单量"])
      : firstAvailable(table.headers, ["销售额", "成交额", "GMV"]);
  const productField = firstAvailable(table.headers, ["商品", "产品"]);
  if (!metric || !productField) return null;
  const range = resolveAnalysisRange(table, question, context, extractRecentDays(originalQuestion) ?? 7);
  const candidates = [...new Set(table.rows.map((row) => String(row[productField] ?? "").trim()))]
    .filter((value) => value && value !== profile.storeAggregateLabel);
  const scope = await resolveProductRankingScope(provider, semanticQuestion, candidates);
  if (scope.explicit && scope.products.length === 0) {
    throw new ClarificationError(
      `我理解你要查“${scope.label ?? "这个品类"}”，但当前商品目录里没有能可靠归入该范围的商品。`,
      candidates.slice(0, 6),
    );
  }
  const rows = table.rows.filter((row) => {
    const product = String(row[productField] ?? "").trim();
    const date = toDateKey(row[firstAvailable(table.headers, ["日期"]) ?? ""]);
    return product
      && product !== profile.storeAggregateLabel
      && (!scope.explicit || scope.products.includes(product))
      && date != null
      && date >= range.startDate
      && date <= range.endDate;
  });
  const ranked = new Map<string, number>();
  for (const row of rows) {
    const product = String(row[productField] ?? "").trim();
    ranked.set(product, (ranked.get(product) ?? 0) + (parseNumber(row[metric]) ?? 0));
  }
  const result = [...ranked.entries()].sort((left, right) => right[1] - left[1]);
  if (result.length === 0) throw new ClarificationError("最近范围里还没有商品经营数据。", ["查看投产比", "换一个时间范围"]);
  const requestedLimit = rankingLimit(semanticQuestion);
  const displayed = result.slice(0, Math.min(requestedLimit, result.length));
  const [winner, value] = displayed[0];
  const currencyCode = profile.tiktok.currencyCode ?? null;
  const renderedValues = displayed.map(([, metricValue]) => (
    isMoneyField(metric)
      ? formatCurrencyAmount(metricValue, currencyCode)
      : `${formatNumber(metricValue)}${/数量/.test(metric) ? "件" : "单"}`
  ));
  const rendered = renderedValues[0];
  const defaultBasis = !/销量|数量|件数|单量|订单|销售额|金额/.test(semanticQuestion);
  const rangeLabel = scope.explicit && scope.label ? scope.label : "商品";
  const draft = [
    `📌 ${range.startDate} 至 ${range.endDate}，${rangeLabel}${requestedLimit > 1 ? `前${requestedLimit}名` : "第一名"}如下：`,
    "",
    ...displayed.map(([product], index) => `${rankMedal(index)} ${product}：${renderedValues[index]}`),
    "",
    `📊 口径：${metric}${defaultBasis ? "（你没指定口径，我默认按销售额）" : ""}`,
    displayed.length < requestedLimit ? `⚠️ 这个范围目前只有 ${displayed.length} 个有记录的商品，因此没有凑满 ${requestedLimit} 名。` : null,
    `🎯 总结：${winner}排第一，${metric}为${rendered}。`,
  ].filter((line): line is string => line !== null).join("\n");
  const refined = provider.refineAnswer
    ? await provider.refineAnswer(semanticQuestion, {
        tableName: table.sheetName,
        dateRange: `${range.startDate} 至 ${range.endDate}`,
        matchedRows: rows.length,
        metricField: metric,
        currencyCode,
        result: {
          winner,
          value,
          basis: metric,
          defaultBasis,
          requestedLimit,
          category: scope.label,
          ranking: displayed.map(([product, metricValue], index) => ({ rank: index + 1, product, value: metricValue })),
        },
        localDraft: draft,
      })
    : null;
  return {
    text: formatReadableBotReply(selectSafeRefinement(refined?.text, draft, [
      ...displayed.flatMap(([product], index) => [product, renderedValues[index]]),
      metric,
      ...(isMoneyField(metric) && currencyCode ? [currencyCode] : []),
    ])),
    context: {
      ...specialContext(
        context,
        displayed.length === 1 ? winner : null,
        metric,
        range,
        isProductRankingQuestion(originalQuestion) ? originalQuestion : context.lastQuestion ?? originalQuestion,
      ),
      lastEntityValue: displayed.length === 1 ? winner : null,
      lastEntityField: displayed.length === 1 ? productField : null,
    },
  };
}

function isProductRankingQuestion(question: string): boolean {
  const namesProduct = /商品|产品|用品|货品|东西|款/.test(question);
  const namesMetric = /销量|销售额|单量|订单|数量|件数|卖得|卖的|售卖|成交|跑得|跑量/.test(question);
  const namesRanking = /(?:前|top\s*)\s*(?:\d+|[一二两三四五六七八九十]+)\s*(?:名|个)?|排名|排行|榜|最好|最高|最多|最热卖|卖得最|跑得最|最快/i.test(question);
  return namesMetric && namesRanking && (namesProduct || /哪个|哪款|什么|所有|全部/.test(question));
}

async function resolveProductRankingScope(
  provider: ModelProvider,
  question: string,
  candidates: string[],
): Promise<{ products: string[]; label: string | null; explicit: boolean }> {
  const explicitCategory = /用品|品类|系列|类目|洗浴|洗护|沐浴|染发|清洁|护理/.test(question);
  const direct = candidates.filter((candidate) => normalizeText(question).includes(normalizeText(candidate)));
  if (direct.length > 0 && !explicitCategory) {
    return { products: direct, label: direct.length === 1 ? direct[0] : "指定商品", explicit: true };
  }
  if (provider.selectEntityCandidates) {
    const selected = await provider.selectEntityCandidates(question, candidates);
    if (selected && selected.confidence >= 0.45 && selected.selected.length > 0) {
      const local = explicitCategory ? localProductCategoryMatches(question, candidates) : [];
      const combined = [...new Set([...selected.selected, ...local])];
      const isAll = combined.length === candidates.length && !explicitCategory;
      return {
        products: combined,
        label: isAll ? null : selected.label,
        explicit: !isAll,
      };
    }
  }
  if (explicitCategory) {
    const local = localProductCategoryMatches(question, candidates);
    return { products: local, label: inferProductCategoryLabel(question), explicit: true };
  }
  return { products: candidates, label: null, explicit: false };
}

function localProductCategoryMatches(question: string, candidates: string[]): string[] {
  if (/洗浴|洗护|沐浴|洗澡/.test(question)) {
    return candidates.filter((value) => /洗发|沐浴|香皂|洗手|清洁|护发|磨脚|修脚|修剪|剃|刮毛|脱毛/.test(value));
  }
  if (/染发/.test(question)) return candidates.filter((value) => /染发/.test(value));
  if (/清洁/.test(question)) return candidates.filter((value) => /清洁|洗|去污/.test(value));
  return [];
}

function inferProductCategoryLabel(question: string): string {
  if (/洗浴|洗护|沐浴|洗澡/.test(question)) return "洗浴用品";
  if (/染发/.test(question)) return "染发产品";
  if (/清洁/.test(question)) return "清洁用品";
  return "指定品类";
}

function rankingLimit(question: string): number {
  const match = question.match(/(?:前|top\s*)\s*(\d+|[一二两三四五六七八九十]+)\s*(?:名|个)?/i);
  if (!match) return 1;
  return Math.max(1, Math.min(10, parseSmallChineseNumber(match[1]) ?? 1));
}

function parseSmallChineseNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === "十") return 10;
  if (value.includes("十")) {
    const [tens, ones = ""] = value.split("十", 2);
    return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0);
  }
  return digits[value] ?? null;
}

function rankMedal(index: number): string {
  return ["🥇", "🥈", "🥉"][index] ?? `${index + 1}.`;
}

function localChannelComparisonPlan(
  question: string,
  headers: string[],
  aggregate: boolean,
): import("../ai/types.js").MetricComparisonPlan | null {
  const quantity = /销量|数量|件数/.test(question);
  const leftField = quantity
    ? firstAvailable(headers, aggregate ? ["店铺商品卡出单数量", "商品卡出单数量"] : ["商品卡出单数量", "店铺商品卡出单数量"])
    : firstAvailable(headers, aggregate ? ["店铺商品卡出单量(API)", "店铺商品卡出单量", "商品卡出单量"] : ["商品卡出单量", "店铺商品卡出单量(API)", "店铺商品卡出单量"]);
  const rightField = quantity
    ? firstAvailable(headers, ["达人出单数量"])
    : firstAvailable(headers, ["达人出单量"]);
  return leftField && rightField
    ? { leftField, rightField, leftLabel: "商品卡", rightLabel: "达人", confidence: 0.9 }
    : null;
}

function normalizeChannelComparisonPlan(
  plan: import("../ai/types.js").MetricComparisonPlan,
  headers: string[],
  aggregate: boolean,
): import("../ai/types.js").MetricComparisonPlan {
  const normalizeField = (field: string): string => {
    if (aggregate && /^商品卡出单/.test(field)) {
      const storeField = `店铺${field}`;
      if (headers.includes(storeField)) return storeField;
    }
    if (!aggregate && /^店铺商品卡出单/.test(field)) {
      const productField = field.replace(/^店铺/, "");
      if (headers.includes(productField)) return productField;
    }
    return field;
  };
  return {
    ...plan,
    leftField: normalizeField(plan.leftField),
    rightField: normalizeField(plan.rightField),
  };
}

function resolveAnalysisProduct(
  table: TableData,
  question: string,
  context: ConversationContext,
  profile: BusinessProfile,
): string | null {
  const productField = firstAvailable(table.headers, ["商品", "产品"]);
  if (!productField) return null;
  const candidates = [...new Set(table.rows.map((row) => String(row[productField] ?? "").trim()))]
    .filter((value) => value && value !== profile.storeAggregateLabel);
  const direct = candidates
    .map((value) => ({ value, score: longestSharedSubstring(value, question) }))
    .filter((item) => item.score >= 3)
    .sort((left, right) => right.score - left.score)[0]?.value;
  if (direct) return direct;
  if (context.lastEntityValue && candidates.includes(context.lastEntityValue) && refersToPriorEntity(question)) {
    return context.lastEntityValue;
  }
  return null;
}

function longestSharedSubstring(value: string, question: string): number {
  const candidate = normalizeText(value).replace(/\s+/g, "");
  const text = normalizeText(question).replace(/\s+/g, "");
  for (let length = candidate.length; length >= 3; length -= 1) {
    for (let index = 0; index + length <= candidate.length; index += 1) {
      if (text.includes(candidate.slice(index, index + length))) return length;
    }
  }
  return 0;
}

function refersToPriorEntity(question: string): boolean {
  return /它|这个|该商品|该产品|刚才|上面|前面|再看|还是|相比|趋势|增加|下降|平淡|跟达人有关|达人.*(?:售卖|销量|卖了多少)/.test(question);
}

function resolveAnalysisRange(
  table: TableData,
  question: string,
  context: ConversationContext,
  defaultDays: number,
  allowContext = true,
): { startDate: string; endDate: string } {
  const currentInput = question.match(/(?:^|\n)当前追问：([^\n]+)/)?.[1] ?? question;
  const requestedDays = extractRecentDays(currentInput);
  const dateField = firstAvailable(table.headers, ["日期"]);
  const dates = dateField
    ? table.rows.map((row) => toDateKey(row[dateField])).filter((value): value is string => Boolean(value)).sort()
    : [];
  const endDate = dates.at(-1);
  if (!endDate) throw new ClarificationError("表里还没有可用日期，暂时无法判断最近范围。", ["查看表格"]);
  const explicitRange = extractExplicitCalendarRange(currentInput, endDate);
  if (explicitRange) return explicitRange;
  if (allowContext
    && context.lastStartDate
    && context.lastEndDate
    && /上下文时间范围/.test(question)
    && requestedDays == null) {
    return { startDate: context.lastStartDate, endDate: context.lastEndDate };
  }
  const days = requestedDays ?? extractRecentDays(question) ?? defaultDays;
  return { startDate: shiftDate(endDate, -(days - 1)), endDate };
}

function extractExplicitCalendarRange(
  question: string,
  latestReferenceDate: string,
): { startDate: string; endDate: string } | null {
  const iso = [...question.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map((match) => match[1]);
  if (iso.length >= 2) return { startDate: iso[0], endDate: iso[1] };
  if (iso.length === 1) return { startDate: iso[0], endDate: iso[0] };

  const full = question.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?/);
  if (full) {
    const value = validCalendarDate(full[1], full[2], full[3]);
    return value ? { startDate: value, endDate: value } : null;
  }
  const short = question.match(/(?:^|[^\d])(\d{1,2})\s*(?:月|[./])\s*(\d{1,2})\s*(?:日|号|当天|这一天)?(?:[^\d]|$)/);
  if (!short) return null;
  const value = validCalendarDate(latestReferenceDate.slice(0, 4), short[1], short[2]);
  return value ? { startDate: value, endDate: value } : null;
}

function validCalendarDate(year: string, month: string, day: string): string | null {
  const value = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function hasExplicitCalendarDate(question: string): boolean {
  return /20\d{2}-\d{2}-\d{2}|20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}|\d{1,2}\s*(?:月|[./])\s*\d{1,2}\s*(?:日|号|当天|这一天)?/.test(question);
}

function extractRecentDays(question: string): number | null {
  if (/(?:最近|近|过去)\s*(?:一|1|一个)个?月/.test(question)) return 30;
  const matched = question.match(/(?:最近|近|过去|前)\s*(\d{1,2}|[一二两三四五六七八九十]+)\s*(?:个)?(?:完整)?日|(?:最近|近|过去|前)\s*(\d{1,2}|[一二两三四五六七八九十]+)\s*天/);
  const raw = matched?.[1] ?? matched?.[2] ?? "";
  const value = /^\d+$/.test(raw) ? Number(raw) : parseSmallChineseNumber(raw);
  return value != null && Number.isInteger(value) && value >= 1 && value <= 31 ? value : null;
}

function analysisRows(
  table: TableData,
  range: { startDate: string; endDate: string },
  entity: string | null,
  profile: BusinessProfile,
): TableData["rows"] {
  const productField = firstAvailable(table.headers, ["商品", "产品"]);
  const dateField = firstAvailable(table.headers, ["日期"]);
  if (!productField || !dateField) return [];
  const preferred = entity ?? profile.storeAggregateLabel;
  let rows = table.rows.filter((row) => {
    const date = toDateKey(row[dateField]);
    return date != null
      && date >= range.startDate
      && date <= range.endDate
      && entityValueMatches(productField, row[productField], preferred);
  });
  if (!entity && rows.length === 0) {
    rows = table.rows.filter((row) => {
      const date = toDateKey(row[dateField]);
      const product = String(row[productField] ?? "").trim();
      return date != null && date >= range.startDate && date <= range.endDate && product !== profile.storeAggregateLabel;
    });
  }
  return rows;
}

function specialContext(
  previous: ConversationContext,
  entity: string | null,
  metric: string,
  range: { startDate: string; endDate: string },
  question: string,
): ConversationContext {
  return {
    ...previous,
    lastEntityValue: entity ?? previous.lastEntityValue,
    lastEntityField: entity ? "商品" : previous.lastEntityField,
    lastMetricField: metric,
    lastDateField: "日期",
    lastStartDate: range.startDate,
    lastEndDate: range.endDate,
    lastTableHint: "roi",
    lastQuestion: question,
    updatedAt: Date.now(),
  };
}

function shiftDate(dateKey: string, days: number): string {
  const value = new Date(`${dateKey}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function calendarDateKeys(startDate: string, endDate: string): string[] {
  const values: string[] = [];
  let current = startDate;
  while (current <= endDate && values.length <= 366) {
    values.push(current);
    current = shiftDate(current, 1);
  }
  return values;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function parseWithModelFriendlyFallback(
  question: string,
  table: TableData,
  roles: ReturnType<typeof inferFieldRoles>,
  context: ConversationContext,
  profile: BusinessProfile,
  provider: ModelProvider,
): ReturnType<typeof parseQuestion> {
  try {
    return parseQuestion(
      question,
      table,
      roles,
      relativeDateReference(question, table, roles.dateField),
      context,
      profile.storeAggregateLabel,
    );
  } catch (error) {
    if (!(error instanceof ClarificationError) || provider.name !== "deepseek") throw error;
    return {
      intent: {
        intent: "summary",
        metricField: null,
        entityField: context.lastEntityValue ? context.lastEntityField ?? roles.entityField : null,
        entityValue: context.lastEntityValue,
        dateField: context.lastDateField ?? roles.dateField,
        startDate: context.lastStartDate,
        endDate: context.lastEndDate,
        sortDirection: null,
        sortField: null,
        limit: 10,
        selectFields: [],
        responseStyle: "concise",
        numericFilters: [],
        outputMode: "answer",
      },
      matchedEntity: context.lastEntityValue,
    };
  }
}

function relativeDateReference(question: string, table: TableData, dateField: string | null): Date {
  if (!/(?:最近|近|过去)\s*(?:\d+|[一二两三四五六七八九十]+|一周)/.test(question) || !dateField) {
    return new Date();
  }
  const latest = table.rows
    .map((row) => toDateKey(row[dateField]))
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  if (!latest) return new Date();
  const reference = new Date(`${latest}T12:00:00`);
  reference.setDate(reference.getDate() + 1);
  return reference;
}

function applyRouteHint(question: string, domain: BusinessQueryDomain | null): string {
  if (!domain) return question;
  const labels: Record<BusinessQueryDomain, string> = {
    development: "开发",
    cooperation: "合作",
    online: "上线",
    roi: "投产比",
    comprehensive: "综合",
  };
  const withoutStaleHint = question.replace(/(?:^|\n)上下文数据域：[^\n]+/g, "").trim();
  return `${withoutStaleHint}\n上下文数据域：${labels[domain]}`;
}

function shouldRefineAnswer(question: string, intent: QueryIntent, matchedRows: number): boolean {
  return intent.intent === "summary"
    || /怎么样|如何|表现|分析|总结|趋势|帮我|看一下|查一下|数据/.test(question);
}

function buildAnswerRefinementEvidence(
  tableName: string,
  result: ReturnType<typeof executeQuery>,
  safeHeaders: string[],
  draft: string,
  currencyCode: string | null = null,
): AnswerRefinementEvidence {
  return {
    tableName,
    dateRange: result.dateRange,
    matchedRows: result.matchedRows,
    metricField: result.metricField,
    currencyCode,
    result: sanitizeResultForModel(result.value, safeHeaders),
    localDraft: draft.slice(0, 2_000),
  };
}

function sanitizeResultForModel(value: unknown, safeHeaders: string[]): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length === 0 || typeof value[0] !== "object" || value[0] == null || "entity" in value[0]) {
    return value.slice(0, 10);
  }
  const allowed = new Set(safeHeaders.filter((field) => !/排序键|记录类型|检查|来源|字段ID/i.test(field)));
  return (value as Array<Record<string, unknown>>).slice(0, 5).map((row) => Object.fromEntries(
    Object.entries(row).filter(([field]) => allowed.has(field)),
  ));
}

export function assertExecutableQueryIntent(question: string, intent: QueryIntent): void {
  const thresholdLanguage = /(?:大于|小于|超过|高于|低于|破|不少于|不多于|至少|至多|偏高|偏低|太高|太低|明显|>=|<=|>|<|=)/.test(question);
  if (intent.outputMode === "export" && thresholdLanguage && (intent.numericFilters?.length ?? 0) === 0) {
    throw new ClarificationError("我识别到你想按阈值筛选，但无法可靠确定具体数字。请改成例如“店铺浏览量大于200的数据导出”。");
  }
  if (thresholdLanguage && /%|百分之/.test(question)) {
    throw new ClarificationError("百分比阈值需要先明确表内口径。请使用表中实际数值，例如“转化率大于0.05”，不要只写5%。");
  }
}


async function answerComprehensiveOverview(
  dataSource: DataSource,
  provider: ModelProvider,
  question: string,
  context: ConversationContext,
  originalQuestion: string,
  profile: BusinessProfile,
): Promise<AnswerWithContextResult> {
  const cooperation = await dataSource.getTable("上下文数据域：合作");
  const online = await dataSource.getTable("上下文数据域：上线");
  let roi: TableData | null = null;
  try { roi = await dataSource.getTable("上下文数据域：投产比"); } catch {}
  const wantsDevelopment = /上下文数据域：开发、合作和上线/.test(question);
  const development = wantsDevelopment ? await dataSource.getTable("上下文数据域：开发") : null;

  const entity = findComprehensiveEntity(question, context, cooperation, online, roi);
  if (!entity) throw new ClarificationError("你想综合查看哪个达人或产品？请直接发名称。", ["达人名称", "产品名称"]);

  const cooperationField = entity.kind === "product"
    ? firstAvailable(cooperation.headers, ["寄样产品", "挂车产品", "产品", "商品"])
    : firstAvailable(cooperation.headers, ["红人姓名", "达人姓名"]);
  const onlineField = entity.kind === "product"
    ? firstAvailable(online.headers, ["挂车产品", "寄样产品", "产品", "商品"])
    : firstAvailable(online.headers, ["达人姓名", "红人姓名"]);

  const cooperationRows = cooperationField
    ? cooperation.rows.filter((row) => entityValueMatches(cooperationField, row[cooperationField], entity.value))
    : [];
  const onlineRows = onlineField
    ? online.rows.filter((row) => entityValueMatches(onlineField, row[onlineField], entity.value))
    : [];

  const quantityField = firstAvailable(online.headers, ["售出数量", "销量", "数量"]);
  const salesField = firstAvailable(online.headers, ["销售额", "成交额", "金额"]);
  const productField = firstAvailable(online.headers, ["挂车产品", "产品", "商品"]);
  const creatorField = firstAvailable(online.headers, ["达人姓名", "红人姓名"]);
  const onlineDate = firstAvailable(online.headers, ["实上线日期(Ct)", "实上线日期(CT)", "实上线日期"]);
  const cooperationDate = firstAvailable(cooperation.headers, ["合作时间", "最近联系日期"]);

  const quantity = sumField(onlineRows, quantityField);
  const sales = sumField(onlineRows, salesField);
  const related = new Set(onlineRows.map((row) => String(row[entity.kind === "product" ? creatorField ?? "" : productField ?? ""] ?? "").trim()).filter(Boolean));
  const recentOnline = latestDate(onlineRows, onlineDate);
  const recentCooperation = latestDate(cooperationRows, cooperationDate);

  const roiField = roi && entity.kind === "product"
    ? firstAvailable(roi.headers, ["商品", "产品"])
    : null;
  const roiRows = roi && roiField
    ? roi.rows.filter((row) => entityValueMatches(roiField, row[roiField], entity.value))
    : [];
  const roiDateField = roi ? firstAvailable(roi.headers, ["日期"]) : null;
  const roiDates = roiRows.map((row) => toDateKey(roiDateField ? row[roiDateField] : null))
    .filter((value): value is string => Boolean(value)).sort();
  const roiOrders = sumField(roiRows, roi ? firstAvailable(roi.headers, ["单量"]) : null);
  const roiItems = sumField(roiRows, roi ? firstAvailable(roi.headers, ["数量"]) : null);
  const roiSales = sumField(roiRows, roi ? firstAvailable(roi.headers, ["销售额"]) : null);

  let developmentLine = "";
  if (development && entity.kind === "creator") {
    const field = firstAvailable(development.headers, ["红人姓名", "达人姓名"]);
    const count = field ? development.rows.filter((row) => entityValueMatches(field, row[field], entity.value)).length : 0;
    developmentLine = `开发记录：${count}条。\n`;
  }

  const relatedLabel = entity.kind === "product" ? "位达人" : "个产品";
  const currencyCode = profile.tiktok.currencyCode ?? null;
  const text = [
    `${entity.value}综合情况：`,
    developmentLine.trim(),
    `合作：${cooperationRows.length}条记录${recentCooperation ? `，最近合作日期 ${recentCooperation}` : ""}。`,
    `上线：${onlineRows.length}条记录，涉及${related.size}${relatedLabel}，售出${formatNumber(quantity)}件，销售额${formatCurrencyAmount(sales, currencyCode)}${recentOnline ? `，最近上线日期 ${recentOnline}` : ""}。`,
    entity.kind === "product" && roiRows.length > 0
      ? `经营：${roiDates[0] ?? "未知"} 至 ${roiDates.at(-1) ?? "未知"}，单量${formatNumber(roiOrders)}、销量${formatNumber(roiItems)}、销售额${formatCurrencyAmount(roiSales, currencyCode)}。`
      : "",
    "说明：综合结果分别读取合作表和全部上线分表；没有成本和广告花费时，不判断利润或ROI。",
  ].filter(Boolean).join("\n");

  const refined = entity.kind === "product" && provider.refineAnswer
    ? await provider.refineAnswer(originalQuestion, {
        tableName: "合作表 + 上线表 + 投产比",
        dateRange: roiDates.length > 0 ? `${roiDates[0]} 至 ${roiDates.at(-1)}` : "全部已记录数据",
        matchedRows: cooperationRows.length + onlineRows.length + roiRows.length,
        metricField: "综合经营表现",
        currencyCode,
        result: {
          product: entity.value,
          cooperationRecords: cooperationRows.length,
          latestCooperationDate: recentCooperation,
          onlineRecords: onlineRows.length,
          onlineCreators: related.size,
          onlineQuantity: quantity,
          onlineSales: sales,
          latestOnlineDate: recentOnline,
          roiDays: roiDates.length,
          roiOrders,
          roiItems,
          roiSales,
        },
        localDraft: text,
      })
    : null;

  return {
    text: selectSafeRefinement(refined?.text, text, [
      entity.value,
      ...(currencyCode && (roiSales > 0 || sales > 0) ? [currencyCode] : []),
    ]),
    context: {
      ...context,
      lastEntityValue: entity.value,
      lastEntityField: entity.kind === "product" ? onlineField : onlineField,
      lastTableHint: "online",
      lastQuestion: originalQuestion,
      updatedAt: Date.now(),
    },
  };
}

function selectSafeRefinement(
  refined: string | null | undefined,
  verifiedDraft: string,
  requiredFacts: string[],
): string {
  if (!refined?.trim()) return verifiedDraft;
  const normalized = normalizeText(refined);
  const hasEveryFact = requiredFacts
    .filter((fact) => fact.trim().length > 0)
    .every((fact) => normalized.includes(normalizeText(fact)));
  if (!hasEveryFact) return verifiedDraft;
  const verifiedNumbers = new Set(extractClaimNumbers(verifiedDraft));
  const addsUnverifiedNumber = extractClaimNumbers(refined).some((value) => !verifiedNumbers.has(value));
  return addsUnverifiedNumber ? verifiedDraft : refined.trim();
}

function resultFactAnchors(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return typeof value === "number" || typeof value === "string" ? [String(value)] : [];
  }
  const anchors: string[] = [];
  for (const item of value.slice(0, 10)) {
    if (item && typeof item === "object" && "entity" in item && "value" in item) {
      const ranked = item as { entity: unknown; value: unknown };
      anchors.push(String(ranked.entity), String(ranked.value));
    }
  }
  return anchors.filter((item) => item.trim().length > 0);
}

function extractClaimNumbers(text: string): string[] {
  return [...text.matchAll(/\d+(?:\.\d+)?%?/g)].map((match) => match[0]);
}

function findComprehensiveEntity(
  question: string,
  context: ConversationContext,
  cooperation: TableData,
  online: TableData,
  roi: TableData | null = null,
): { value: string; kind: "creator" | "product" } | null {
  const candidates: Array<{ value: string; kind: "creator" | "product" }> = [];
  const fields: Array<[TableData, string[], "creator" | "product"]> = [
    [online, ["达人姓名", "红人姓名"], "creator"],
    [cooperation, ["红人姓名", "达人姓名"], "creator"],
    [online, ["挂车产品", "产品", "商品"], "product"],
    [cooperation, ["寄样产品", "产品", "商品"], "product"],
  ];
  if (roi) fields.push([roi, ["商品", "产品"], "product"]);
  const normalizedQuestion = normalizeText(question);
  for (const [table, names, kind] of fields) {
    const field = firstAvailable(table.headers, names);
    if (!field) continue;
    for (const value of new Set(table.rows.map((row) => String(row[field] ?? "").trim()).filter(Boolean))) {
      if (normalizedQuestion.includes(normalizeText(value))) candidates.push({ value, kind });
    }
  }
  const unique = [...new Map(candidates.map((item) => [`${item.kind}\0${item.value}`, item])).values()]
    .sort((a, b) => normalizeText(b.value).length - normalizeText(a.value).length);
  if (unique.length > 0) return unique[0];

  const explicitHandle = question.match(/(?:^|[^a-z0-9._])@?([a-z][a-z0-9._]{1,31})(?=[^a-z0-9._]|$)/i)?.[1];
  if (explicitHandle && !/^(?:roi|usd|gmv|vv|tiktok|base)$/i.test(explicitHandle)) {
    return { value: explicitHandle, kind: "creator" };
  }

  if (context.lastEntityValue) {
    const creatorFields = [
      firstAvailable(online.headers, ["达人姓名", "红人姓名"]),
      firstAvailable(cooperation.headers, ["红人姓名", "达人姓名"]),
    ].filter((field): field is string => Boolean(field));
    const isCreator = creatorFields.some((field) =>
      online.rows.some((row) => entityValueMatches(field, row[field], context.lastEntityValue!))
      || cooperation.rows.some((row) => entityValueMatches(field, row[field], context.lastEntityValue!)),
    );
    return { value: context.lastEntityValue, kind: isCreator ? "creator" : "product" };
  }
  return null;
}

function firstAvailable(headers: string[], names: string[]): string | null {
  return names.find((name) => headers.includes(name)) ?? null;
}

function sumField(rows: TableData["rows"], field: string | null): number {
  if (!field) return 0;
  return rows.reduce((sum, row) => sum + (parseNumber(row[field]) ?? 0), 0);
}

function dailyCorrelation(
  rows: TableData["rows"],
  dateField: string,
  leftField: string,
  rightField: string,
): number | null {
  const daily = new Map<string, { left: number; right: number }>();
  for (const row of rows) {
    const date = toDateKey(row[dateField]);
    if (!date) continue;
    const value = daily.get(date) ?? { left: 0, right: 0 };
    value.left += parseNumber(row[leftField]) ?? 0;
    value.right += parseNumber(row[rightField]) ?? 0;
    daily.set(date, value);
  }
  const values = [...daily.values()];
  if (values.length < 4) return null;
  const leftMean = values.reduce((sum, item) => sum + item.left, 0) / values.length;
  const rightMean = values.reduce((sum, item) => sum + item.right, 0) / values.length;
  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (const item of values) {
    const left = item.left - leftMean;
    const right = item.right - rightMean;
    numerator += left * right;
    leftVariance += left ** 2;
    rightVariance += right ** 2;
  }
  if (leftVariance === 0 || rightVariance === 0) return null;
  return numerator / Math.sqrt(leftVariance * rightVariance);
}

function describeTrend(current: number, previous: number, rate: number | null): string {
  if (previous === 0) return current > 0 ? "有起色，但此前基数为0" : "仍然没有起量";
  if (rate == null || Math.abs(rate) < 0.05) return "基本平稳";
  if (rate >= 0.2) return "明显增加";
  if (rate > 0) return "小幅增加";
  if (rate <= -0.2) return "明显下降";
  return "小幅下降";
}

function describeCorrelation(value: number): string {
  const strength = Math.abs(value);
  if (strength >= 0.7) return "同期走势较强";
  if (strength >= 0.4) return "同期走势中等";
  if (strength >= 0.2) return "同期走势较弱";
  return "同期走势不明显";
}

function latestDate(rows: TableData["rows"], field: string | null): string | null {
  if (!field) return null;
  const dates = rows.map((row) => toDateKey(row[field])).filter((value): value is string => Boolean(value)).sort();
  return dates.at(-1) ?? null;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(value);
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function applyContextHints(question: string, context: ConversationContext): string {
  const text = question.trim();
  const explicitAnswerFollowUp = /^(?:那|那么|所以|然后|再|继续|刚才|上面|前面)?(?:把)?(?:名字|名称|产品名|商品名|结果|明细|排名|名次|第[一二两三四五六七八九十0-9]+名).*(?:说|列|给|展开|看看|是什么|呢|出来|一下)?$|^(?:分别是什么|是哪几个|有哪些|具体呢|展开说说|列出来|把名字说出来)$|^(?:哪|分别).*(?:次|条)[？?]?$/.test(text);
  const conversationalConnector = /^(?:那|那么|所以|然后|再|继续|刚才|上面|前面|这个|这些|它|他们|还有|我说的是|我是说|就看|只看)/.test(text)
    || /(?:呢|分别是什么|怎么理解|为什么|什么原因|具体点|详细点|展开说说|是哪几个|列出来)$/.test(text);
  const followsPreviousAnswer = Boolean(context.lastQuestion)
    && text.length <= 40
    && (explicitAnswerFollowUp || conversationalConnector);
  if (followsPreviousAnswer && context.lastQuestion) {
    return [
      `上一轮用户问题：${context.lastQuestion}`,
      `当前追问：${text}`,
      "请沿用上一轮的对象、指标、日期范围和数据域继续回答，不要重新让用户选择表。",
      context.lastMetricField ? `上下文指标：${context.lastMetricField}` : null,
      context.lastTableHint ? `上下文数据域：${tableHintLabel(context.lastTableHint)}` : null,
      context.lastStartDate && context.lastEndDate ? `上下文时间范围：${context.lastStartDate} 至 ${context.lastEndDate}` : null,
    ].filter((line): line is string => line !== null).join("\n");
  }
  const sharedEntityFragment = context.lastEntityValue
    ? longestSharedSubstring(context.lastEntityValue, text) >= 3
    : false;
  const refersToContext = sharedEntityFragment
    || /(?:^|[，,。\s])(他|她|它|这个达人|这个红人|这个博主|这个账号|这个产品|这个商品|这个(?!月|周|星期)|该达人|该产品|那|再|然后|接着)/.test(text)
    || /^(?:最近呢?|这个月呢|本月呢|上个月呢|上周呢|本周呢|销量呢|销售额呢|曝光呢|合作呢|上线呢|那.*呢|还有呢)$/.test(text)
    || (Boolean(context.lastEntityValue) && /跟达人有关|达人.*(?:售卖|销量|卖了多少|卖出多少)/.test(text))
    || (Boolean(context.lastEntityValue || context.lastMetricField || context.lastTableHint)
      && /还是|相比|比较|增加|增长|下降|平淡|趋势/.test(text));
  if (!refersToContext) return text;
  if (!context.lastEntityValue && !context.lastMetricField && !context.lastTableHint) {
    throw new ClarificationError("你是在接着问哪个达人或产品？请直接发名称。", ["达人名称", "产品名称"]);
  }
  const hints = [text];
  if (context.lastEntityValue) hints.push(`上下文对象：${context.lastEntityValue}`);
  if (context.lastMetricField) hints.push(`上下文指标：${context.lastMetricField}`);
  if (context.lastTableHint) hints.push(`上下文数据域：${tableHintLabel(context.lastTableHint)}`);
  if (context.lastStartDate && context.lastEndDate
    && extractRecentDays(text) == null
    && !hasExplicitCalendarDate(text)) {
    hints.push(`上下文时间范围：${context.lastStartDate} 至 ${context.lastEndDate}`);
  }
  return hints.join("\n");
}

function tableHintLabel(hint: NonNullable<ConversationContext["lastTableHint"]>): string {
  if (hint === "online") return "上线";
  if (hint === "cooperation") return "合作";
  if (hint === "development") return "开发";
  return "投产比";
}

function buildEntityCandidatesByField(table: TableData, safeHeaders: string[]): Record<string, string[]> {
  const fields = safeHeaders.filter((header) => /姓名|达人|红人|账号|产品|商品|开发人|负责人|mcn/i.test(header));
  return Object.fromEntries(fields.map((field) => [
    field,
    [...new Set(table.rows.map((row) => String(row[field] ?? "").trim()).filter(Boolean))].slice(0, 500),
  ]));
}

function questionContainsSensitiveData(question: string): boolean {
  return /邮箱|邮件|whatsapp|手机号|电话|联系方式|收货地址|收件地址|身份证|证件号|银行卡|卡号|paypal|客户备注/i.test(question)
    || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(question)
    || /(?:\+?\d[\d\s().-]{6,}\d)/.test(question);
}

function isAnalysisRequest(question: string): boolean {
  return /分析|判断|重点|洞察|趋势|增加|增长|上升|下降|平淡|持平|比较|相比|主要靠|建议|总结|概括|值得关注|表现|最好|效果如何|效果怎么样|经营数据|投产比怎么样|数据(?!域)(?:怎么样|如何|情况|概览|分析)?/.test(question);
}

function preserveLocalConstraints(
  local: QueryIntent,
  model: QueryIntent,
  question: string,
  lockAnalysisSummary = false,
): QueryIntent {
  const localHasExplicitLimit = /(?:最近|最新|前|top\s*)\s*(?:\d+|[一二两三四五六七八九十]+)|最近一次|最新一次|最后一次/i.test(question);
  return {
    ...model,
    entityField: local.entityValue ? local.entityField : model.entityField ?? local.entityField,
    entityValue: local.entityValue ?? model.entityValue,
    dateField: local.startDate || local.endDate ? local.dateField : model.dateField ?? local.dateField,
    startDate: local.startDate ?? model.startDate,
    endDate: local.endDate ?? model.endDate,
    metricField: local.metricField ?? model.metricField,
    intent: lockAnalysisSummary ? "summary" : local.intent !== "summary" ? local.intent : model.intent,
    selectFields: local.selectFields.length > 0 ? local.selectFields : model.selectFields,
    sortDirection: local.sortDirection ?? model.sortDirection,
    sortField: local.sortField ?? model.sortField,
    limit: localHasExplicitLimit || local.intent === "records" ? local.limit : model.limit,
    responseStyle: local.responseStyle,
    numericFilters: (local.numericFilters?.length ?? 0) > 0 ? local.numericFilters : model.numericFilters,
    outputMode: local.outputMode ?? model.outputMode,
  };
}

function updateConversationContext(
  previous: ConversationContext,
  intent: QueryIntent,
  table: TableData,
  question: string,
): ConversationContext {
  return {
    lastEntityValue: intent.entityValue ?? previous.lastEntityValue,
    lastEntityField: intent.entityField ?? previous.lastEntityField,
    lastMetricField: intent.metricField ?? previous.lastMetricField,
    lastDateField: intent.dateField ?? previous.lastDateField,
    lastStartDate: intent.startDate ?? previous.lastStartDate,
    lastEndDate: intent.endDate ?? previous.lastEndDate,
    lastTableHint: inferTableHint(table.sheetName) ?? previous.lastTableHint,
    lastSelectFields: intent.selectFields.length > 0 ? intent.selectFields : previous.lastSelectFields,
    lastQuestion: question,
    updatedAt: Date.now(),
  };
}

function inferTableHint(sheetName: string): ConversationContext["lastTableHint"] {
  if (/上线表/i.test(sheetName)) return "online";
  if (/合作表/i.test(sheetName)) return "cooperation";
  if (/开发表/i.test(sheetName)) return "development";
  if (/投产比|roi/i.test(sheetName)) return "roi";
  return null;
}
