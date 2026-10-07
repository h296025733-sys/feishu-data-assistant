import type { AppEnv } from "../config/env.js";
import { requireDeepSeekEnv } from "../config/env.js";
import type { QueryIntent } from "../types/index.js";
import { parseModelIntentJson } from "../query/schema.js";
import { estimateCost, logModelCall } from "./cost-log.js";
import { loadBusinessLanguageMemory } from "./business-language-memory.js";
import { loadBotPersona } from "./bot-persona.js";
import type {
  AnalysisEvidence,
  AnswerRefinementEvidence,
  BusinessQueryDomain,
  CrossTenantQuestionContext,
  CrossTenantQuestionPlan,
  DailyReportHighlightContext,
  EntityCandidateSelection,
  MessageIntentHint,
  MessageUnderstanding,
  MessageUnderstandingContext,
  ModelAnalysisResult,
  ModelContext,
  ModelParseResult,
  ModelProvider,
  MetricComparisonPlan,
  ProductNameSuggestion,
  QuestionRouteResult,
} from "./types.js";

export class MockModelProvider implements ModelProvider {
  public readonly name = "mock" as const;
  public async parseIntent(_question: string, _context: ModelContext, fallback: QueryIntent): Promise<ModelParseResult> {
    return {
      intent: fallback,
      trace: { source: "local", model: null, durationMs: 0, fallbackReason: "未启用 AI 模型" },
    };
  }

  public async suggestProductName(): Promise<null> {
    return null;
  }

  public async selectEntityCandidates(): Promise<null> {
    return null;
  }

  public async understandMessage(): Promise<null> {
    return null;
  }

  public async selectDailyReportHighlights(): Promise<null> {
    return null;
  }
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class DeepSeekProvider implements ModelProvider {
  public readonly name = "deepseek" as const;
  public constructor(private readonly env: AppEnv) {
    requireDeepSeekEnv(env);
  }

  public async understandMessage(
    question: string,
    context: MessageUnderstandingContext,
  ): Promise<MessageUnderstanding | null> {
    const intents: MessageIntentHint[] = [
      "business_query",
      "task_status",
      "automatic_sync_result",
      "latest_business_data",
      "schedule_expectation",
      "pending_items",
      "base_link",
      "store_config",
      "initialization",
      "schedule_change",
      "memory_command",
      "help",
      "cancel",
      "chitchat",
      "other",
    ];
    const system = [
      "你是店铺经营机器人的统一语言理解层。每条自由文字都会先经过你；你只负责听懂和改写，不查数据、不执行操作、不编造答案。",
      "把用户当前话语改写成一条含义完整、可独立理解的中文问题或命令。结合最近对话补全省略的对象、指标、比较关系和时间范围，但当前话语永远优先。",
      "把经营口语规范成明确业务语义：‘货跑得快/哪个货最能跑’可改写为按商品销量排名；但‘哪个卖得最好/卖得最好的商品’没有明确说销量、单量或销售额时，不得擅自补入口径，保留原话让下游按统一默认口径处理。‘自己自然卖/我们店自己卖’通常指商品卡渠道；‘达人带货’指达人渠道。",
      "严格区分两个相近字段：‘红人上线表的售出数量/达人视频售出数量’是逐条视频成交件数；‘投产比的达人出单数量/达人卖了多少件’是按商品和日期汇总的达人归因销量。用户说‘已有记录、从表格有数据开始、全部历史、累计’时要保留为全历史范围，不能擅自改成最近7天。",
      "连续追问‘哪四次/分别是哪几次’必须承接上一问的月份和上线视频口径并要求列出明细；菜单提示后用户只发一个TK号或商品名，应理解为查询该对象的开发、合作、上线和经营综合情况。",
      "必须原样保留当前话语中的所有商品名、达人名、数字、日期、时间、比较符号和时间范围。不能把30改成7，不能把大于改成小于，不能凭空加入用户没说过的对象。",
      "不得凭空加入用户没有指定的指标。尤其不能把含糊的‘卖得最好’擅自改成‘按销量’或‘按销售额’。",
      "连续追问示例：上一问是‘最近商品卡和达人谁卖得更多’，当前说‘那最近一个月呢’，应改写为‘最近一个月商品卡和达人谁卖得更多’。上一问是商品销量前五，当前说‘把名字说出来’，应改写为‘把上一问商品销量前五名的商品名称说出来’。",
      "最近机器人回答可用于理解‘第二个、上面那个、刚才第一名’等指代。即使中间插入任务状态、菜单或寒暄，经营追问仍优先承接最近一次经营问题和经营回答。",
      "intentHint含义：business_query=查经营数据或分析；task_status=查询当前人工发起的初始化/历史补齐任务进度；automatic_sync_result=询问今天、刚才或上次定时自动同步是否成功、更新了什么；latest_business_data=要求查看已经写入表格的最新一日经营数据；schedule_expectation=询问下次同步时间、倒计时或能更新到哪天；pending_items=查询待人工确认项；base_link=索要多维表格链接；store_config=查看当前店铺绑定；initialization=请求初始化或补齐历史数据；schedule_change=修改、开启或暂停自动同步；memory_command=学习或管理店铺知识；help=菜单或帮助；cancel=取消当前追问；chitchat=寒暄、情绪或对机器人本身的闲聊；other=确实无法归类。",
      "特别区分：‘你今天十点更新了什么/上次自动更新成功了吗’是automatic_sync_result；‘最新更新的数据发给我/刚同步的数据怎么样’是latest_business_data；不能把它们归入旧的30天补齐任务，也不能把‘发给我看看’当成写表。",
      "只有chitchat可以填写directReply，语气自然、简短、有活人感；任何经营事实、任务状态、时间、数字或写入结果都不得在directReply中回答。其余意图directReply必须为null。",
      "不要因为过去聊过某张表就忽略当前问题。若当前是追问，contextualFollowUp=true；否则为false。",
      "只输出JSON：{\"rewrittenQuestion\":\"完整语义\",\"intentHint\":\"枚举值\",\"contextualFollowUp\":true或false,\"directReply\":null或\"短回复\",\"confidence\":0到1}。",
    ].join("\n");
    try {
      const completion = await this.complete(system, [
        `当前用户原话：${question}`,
        `最近用户话语（由旧到新）：${JSON.stringify(context.recentUserMessages.slice(-8))}`,
        `最近机器人回答（由旧到新）：${JSON.stringify(context.recentAssistantMessages.slice(-4))}`,
        `最近一次经营问题：${context.lastBusinessQuestion ?? "无"}`,
        `最近一次数据域：${context.recentDomain ?? "无"}`,
        `店铺长期知识（仅辅助理解词义）：${JSON.stringify(context.storeKnowledge.slice(0, 20))}`,
      ].join("\n"));
      const parsed = JSON.parse(completion.content) as Record<string, unknown>;
      const intentHint = String(parsed.intentHint ?? "");
      if (!intents.includes(intentHint as MessageIntentHint)) return null;
      const confidence = Number(parsed.confidence);
      const rewrittenQuestion = String(parsed.rewrittenQuestion ?? "").trim();
      if (!rewrittenQuestion) return null;
      const directReply = intentHint === "chitchat" && typeof parsed.directReply === "string"
        ? parsed.directReply.trim().slice(0, 300) || null
        : null;
      return {
        rewrittenQuestion,
        intentHint: intentHint as MessageIntentHint,
        contextualFollowUp: parsed.contextualFollowUp === true,
        directReply,
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      };
    } catch {
      return null;
    }
  }

  public async selectDailyReportHighlights(
    context: DailyReportHighlightContext,
  ): Promise<string[] | null> {
    const allowedIds = new Set(context.candidates.map((candidate) => candidate.id));
    if (allowedIds.size === 0) return [];
    const system = [
      "你负责从已经由本地代码计算并验证的店铺日报、周报或月报候选结论中，挑出最值得群里关注的内容。",
      "你只能返回候选项的id，不得改写文本、补充数字、原因、建议、目标或好坏判断。",
      "根据reportType和periodLabel理解报告周期；优先选择明显的同口径环比变化、真实成交商品和需要行动的事实，普通零变化可少选。",
      "选择1至3项，避免含义重复。只输出JSON：{\"selectedIds\":[\"id\"]}。",
    ].join("\n");
    try {
      const completion = await this.complete(system, JSON.stringify(context));
      const parsed = JSON.parse(completion.content) as { selectedIds?: unknown };
      if (!Array.isArray(parsed.selectedIds)) return null;
      const selected = [...new Set(parsed.selectedIds.map(String))]
        .filter((id) => allowedIds.has(id))
        .slice(0, 3);
      return selected.length > 0 ? selected : null;
    } catch {
      return null;
    }
  }

  public async understandCrossTenantQuestion(
    question: string,
    context: CrossTenantQuestionContext,
  ): Promise<CrossTenantQuestionPlan | null> {
    const allowedIds = new Set(context.stores.map((store) => store.id));
    const system = [
      "你是多店铺经营机器人的私聊路由层。只理解用户要查哪些店和哪种比较，不查数据、不计算、不回答。",
      "intent只能是：store_ranking（比较店铺）、product_ranking（跨店找商品）、cross_summary（横向概览）、single_store_query（只查一家店）、store_list（列出已接入店铺）、unknown。",
      "metric只能是sales、quantity、orders。销售额/成交额/GMV对应sales；销量/售出件数/数量对应quantity；单量/订单数对应orders。用户未说口径时：问店铺经营对比默认sales，问卖得最好的商品默认sales。",
      "days是用户要求的最近完整日天数；没说时间默认7。必须保留用户写出的天数，范围1至365。",
      "用户明确给出起止日期时，startDate/endDate使用YYYY-MM-DD；只说最近N天时两者为null。说‘从某日至今’时startDate填日期、endDate为null。不得擅自缩短天数。",
      "tenantIds只能使用给定店铺ID。明确点名一家店时用single_store_query；问哪家店最高、所有店、各店对比时选择跨店意图。",
      "delegatedQuestion用于single_store_query，去掉店铺选择语句后保留完整业务问题；其他意图可保留改写后的完整问题。",
      "连续追问要结合最近私聊上下文。例如上一问比较最近7天销售额，当前说‘那销量呢’，仍是相同店铺和7天，只把metric改为quantity。",
      "找不到明确店铺且也不是跨店问题时返回unknown，不得擅自选择默认店铺。",
      "只输出JSON：{\"intent\":\"...\",\"metric\":\"sales|quantity|orders\",\"days\":7,\"startDate\":null,\"endDate\":null,\"tenantIds\":[\"真实ID\"],\"delegatedQuestion\":\"...\",\"confidence\":0到1}。",
    ].join("\n");
    try {
      const completion = await this.complete(system, [
        `当前用户原话：${question}`,
        `已接入店铺：${JSON.stringify(context.stores)}`,
        `最近用户话语：${JSON.stringify(context.recentUserMessages.slice(-8))}`,
        `最近机器人回答：${JSON.stringify(context.recentAssistantMessages.slice(-4))}`,
        `上一问题：${context.lastQuestion ?? "无"}`,
        `上一意图：${context.lastIntent ?? "无"}`,
        `上一指标：${context.lastMetric ?? "无"}`,
        `上一天数：${context.lastDays ?? "无"}`,
        `上一开始日期：${context.lastStartDate ?? "无"}`,
        `上一结束日期：${context.lastEndDate ?? "无"}`,
        `上一店铺范围：${JSON.stringify(context.lastTenantIds)}`,
      ].join("\n"));
      const parsed = JSON.parse(completion.content) as Record<string, unknown>;
      const intents = new Set(["store_ranking", "product_ranking", "cross_summary", "single_store_query", "store_list", "unknown"]);
      const metrics = new Set(["sales", "quantity", "orders"]);
      const intent = String(parsed.intent ?? "");
      const metric = String(parsed.metric ?? "");
      const days = Math.trunc(Number(parsed.days));
      const tenantIds = Array.isArray(parsed.tenantIds)
        ? [...new Set(parsed.tenantIds.map(String).filter((id) => allowedIds.has(id)))]
        : [];
      const delegatedQuestion = String(parsed.delegatedQuestion ?? question).trim();
      const startDate = typeof parsed.startDate === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(parsed.startDate)
        ? parsed.startDate
        : null;
      const endDate = typeof parsed.endDate === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(parsed.endDate)
        ? parsed.endDate
        : null;
      const confidence = Number(parsed.confidence);
      if (!intents.has(intent) || !metrics.has(metric) || days < 1 || days > 365 || !delegatedQuestion) return null;
      if (intent === "single_store_query" && tenantIds.length !== 1) return null;
      return {
        intent: intent as CrossTenantQuestionPlan["intent"],
        metric: metric as CrossTenantQuestionPlan["metric"],
        days,
        startDate,
        endDate,
        tenantIds,
        delegatedQuestion,
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      };
    } catch {
      return null;
    }
  }

  public async routeQuestion(
    question: string,
    recentDomain: BusinessQueryDomain | null,
  ): Promise<QuestionRouteResult | null> {
    const system = [
      "你负责判断经营机器人应该查询哪个数据域，只做语义路由，不回答问题。",
      "development=达人线索、开发人、联系方式、归属；cooperation=寄样、合作时间、粉丝、付款、合作方式；online=达人发布视频、上线日期、播放曝光、视频成交；roi=按日期统计的商品或全店单量、销量、销售额、浏览量、转化率、商品卡、广告等经营数据。",
      "comprehensive=用户泛问某个达人或商品‘数据怎么样/整体情况/综合表现’，且没有明确只看合作、上线或投产比。",
      "出现最近N天、某月、每天等时间范围，并询问商品/店铺经营数据时优先roi；明确出现上线、视频、曝光时选online；明确出现合作、寄样时选cooperation。",
      "出现销量、销售额、单量、卖得最好、商品卡、达人出单或增长趋势时优先roi；不要因为近期上下文曾查询上线表就继续路由到online。",
      "例外：明确说‘红人上线表/视频的售出数量’或‘已有视频记录里售出数量最高的商品’时选online；说‘达人出单数量、达人卖了多少件、跟达人有关的售卖量’时选roi。不要把这两个字段混为一谈。",
      "简短追问可以参考recentDomain，但用户新句子中的明确业务词优先。不要因为只出现‘数据’就随意猜具体表。",
      "只输出JSON：{\"domain\":\"development|cooperation|online|roi|comprehensive|null\",\"confidence\":0到1}。",
    ].join("\n");
    try {
      const completion = await this.complete(
        system,
        `用户原话：${question}\n最近一次数据域：${recentDomain ?? "无"}`,
      );
      const parsed = JSON.parse(completion.content) as { domain?: unknown; confidence?: unknown };
      const domain = parsed.domain === "null" || parsed.domain == null ? null : String(parsed.domain);
      if (domain != null && !["development", "cooperation", "online", "roi", "comprehensive"].includes(domain)) {
        throw new Error("DeepSeek返回了无效数据域");
      }
      const confidence = Number(parsed.confidence);
      return {
        domain: domain as BusinessQueryDomain | null,
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      };
    } catch {
      return null;
    }
  }

  public async resolveMetricComparison(
    question: string,
    numericFields: string[],
  ): Promise<MetricComparisonPlan | null> {
    if (!/(?:还是|相比|比较|哪个|哪种|谁|更高|更多|多一点|占比|主要靠)/.test(question)) return null;
    const fields = [...new Set(numericFields)].slice(0, 80);
    if (fields.length < 2) return null;
    const system = [
      "你负责把经营问题中的两个比较对象映射为两个真实数值字段，不计算、不回答。",
      "只能从给定字段中各选一个，不能创造字段。商品卡和达人是销售渠道；若没有分渠道销售额，但存在商品卡出单量/达人出单量，应选择出单量并把标签写成商品卡/达人。",
      "若问题不是双指标比较或无法可靠映射，返回null。",
      "只输出JSON：{\"leftField\":\"真实字段\",\"rightField\":\"真实字段\",\"leftLabel\":\"简短标签\",\"rightLabel\":\"简短标签\",\"confidence\":0到1}或{\"comparison\":null}。",
    ].join("\n");
    try {
      const completion = await this.complete(
        system,
        `用户问题：${question}\n可选数值字段：${JSON.stringify(fields)}`,
      );
      const parsed = JSON.parse(completion.content) as Record<string, unknown>;
      if (parsed.comparison == null && !("leftField" in parsed)) return null;
      const leftField = String(parsed.leftField ?? "").trim();
      const rightField = String(parsed.rightField ?? "").trim();
      if (!fields.includes(leftField) || !fields.includes(rightField) || leftField === rightField) return null;
      const confidence = Number(parsed.confidence);
      return {
        leftField,
        rightField,
        leftLabel: String(parsed.leftLabel ?? leftField).trim().slice(0, 20) || leftField,
        rightLabel: String(parsed.rightLabel ?? rightField).trim().slice(0, 20) || rightField,
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      };
    } catch {
      return null;
    }
  }

  public async selectEntityCandidates(
    question: string,
    candidates: string[],
  ): Promise<EntityCandidateSelection | null> {
    const allowed = [...new Set(candidates.map((value) => value.trim()).filter(Boolean))].slice(0, 200);
    if (allowed.length === 0) return null;
    const system = [
      "你负责理解经营人员口语中的商品范围，并从真实候选商品中选择匹配项；不计算销量，也不回答问题。",
      "例如‘洗浴用品’可以匹配洗发水、沐浴露等真实候选；‘磨脚器’匹配对应商品；‘所有商品/全部产品’应选择全部候选。",
      "只能原样返回候选列表中存在的名称，不能改名、补造商品或凭空扩大范围。若用户没有限定品类，应选择全部候选。",
      "label写用户所说范围的简短中文；confidence为0到1。只输出JSON：{\"selected\":[\"真实候选名\"],\"label\":\"范围简称\",\"confidence\":0到1}。",
    ].join("\n");
    try {
      const completion = await this.complete(
        system,
        `用户问题：${question}\n真实候选商品：${JSON.stringify(allowed)}`,
      );
      const parsed = JSON.parse(completion.content) as { selected?: unknown; label?: unknown; confidence?: unknown };
      const selected = Array.isArray(parsed.selected)
        ? [...new Set(parsed.selected.map(String).map((value) => value.trim()).filter((value) => allowed.includes(value)))]
        : [];
      const confidence = Number(parsed.confidence);
      return {
        selected,
        label: typeof parsed.label === "string" ? parsed.label.trim().slice(0, 30) || null : null,
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      };
    } catch {
      return null;
    }
  }

  public async parseIntent(question: string, context: ModelContext, fallback: QueryIntent): Promise<ModelParseResult> {
    const businessLanguageMemory = await loadBusinessLanguageMemory();
    const safeContext = {
      headers: context.headers,
      fieldRoles: context.roles,
      entityCandidates: context.entityCandidates.slice(0, 100),
      entityCandidatesByField: Object.fromEntries(Object.entries(context.entityCandidatesByField ?? {}).map(([field, values]) => [field, values.slice(0, 60)])),
      localRuleHint: fallback,
    };
    const system = [
      "你只负责把经营数据问题转换成受控查询意图 JSON，不执行计算，不编写 SQL，不虚构字段或对象。",
      "你必须根据问题独立判断，可以纠正 localRuleHint；只能使用给定表头和候选对象。",
      "rank 表示先按 entityField 分组、对 metricField 求和，再按 sortDirection 排名；rank_count 表示按 entityField 分组统计原始记录数后排名；records 表示返回匹配记录明细，并在 selectFields 中列出需要展示的真实表头；distinct_count 表示对 entityField 去重计数；average 表示对 metricField 计算平均值。",
      "例如‘利润最高的产品’应返回 rank、产品字段、利润字段、desc、limit 1；‘查询某达人全部记录并返回合作时间和产品’应返回 records、对应对象字段和值、selectFields。",
      "只有问题明确提到某个候选对象时才填写 entityValue；没有日期条件时 startDate 和 endDate 都为 null。",
      "日常问法要按业务语义理解：‘卖了多少’通常是售出数量，‘卖了多少钱’是销售额，‘上线几次/合作几次’是按原始记录计数。",
      "用户要求最近/最新记录时，records 的 sortField 应选择真实日期字段，sortDirection=desc；用户要求表格/详细/只要结果时合理设置 responseStyle。",
      "数值条件放入 numericFilters：大于gt、大于等于gte、小于lt、小于等于lte、等于eq；field只能使用真实表头。‘导出/导成文件’使用 records、responseStyle=table、outputMode=export。",
      "不确定且不同理解会明显改变答案时，可以保守沿用 localRuleHint，不要虚构字段。limit 必须是 1 到 100 的整数；不要用 0 表示全部。",
      "仅输出 JSON，字段为 intent, metricField, entityField, entityValue, dateField, startDate, endDate, sortDirection, sortField, limit, selectFields, responseStyle, numericFilters, outputMode。",
      `长期经营语言记忆：${JSON.stringify(businessLanguageMemory)}`,
    ].join("\n");
    let first: CompletionResult;
    try {
      first = await this.complete(system, `问题：${question}\n安全上下文：${JSON.stringify(safeContext)}`);
    } catch (error) {
      return fallbackResult(fallback, error);
    }
    try {
      return deepSeekResult(validateAgainstContext(parseModelIntentJson(first.content), context), this.env.DEEPSEEK_MODEL, first.durationMs);
    } catch (firstError) {
      try {
        const repaired = await this.complete(system, `以下输出无效，请严格修复为指定 JSON。不要新增信息。\n无效输出：${first.content}\n错误：${firstError instanceof Error ? firstError.message : String(firstError)}`);
        return deepSeekResult(validateAgainstContext(parseModelIntentJson(repaired.content), context), this.env.DEEPSEEK_MODEL, first.durationMs + repaired.durationMs);
      } catch (error) {
        return fallbackResult(fallback, error, first.durationMs);
      }
    }
  }

  public async analyze(question: string, evidence: AnalysisEvidence): Promise<ModelAnalysisResult | null> {
    const persona = await loadBotPersona();
    const system = [
      "你是经营数据分析助手。只能依据给定的聚合证据回答，不得虚构记录、因果关系、利润或ROI。",
      "直接回答用户真正关心的结论，不要复述字段数、执行方式、模型耗时等工程信息。",
      "每个判断必须带上证据中的数字；数据不足时明确说不足。样本少于10条时必须提醒样本很小。",
      "必须遵守aggregationNotes中的统计口径，不能把记录行统计说成去重达人统计，也不能自行重算被排除的累计字段。",
      "numericSummaries里的validCount、missingCount以及零值分布默认都是记录条数，不得擅自改称天数；只有按日期去重后的证据才能称为N天。",
      "没有目标值、历史基线或对照组时，不得把数值评价为正常、优秀、偏高或偏低；人工字段为0时不得擅自断言业务上没有发生，也可能尚未补录。",
      "用户请求的时间长度与证据实际覆盖天数不一致时，开头必须明确实际覆盖范围和天数，不能把5个完整日继续简称成近7天。",
      "金额证据带currencyCode时，每一个销售额、GMV、佣金或花费数字都必须写明对应货币名称和代码；没有currencyCode时不得猜币种。",
      "先给结论，再给最多3条重点。只有用户明确问建议时才给最多2条建议，否则不要主动扩展经营策略。用简洁中文，不写空话。",
      "回复要适合飞书群聊阅读：分成2至4个短区块，区块之间空一行；至少使用2个贴切的视觉锚点，例如📌结论、🛒商品卡、🤝达人、📈趋势、⚠️提醒、🎯总结。关键指标一项一行，排名一名一行。",
      "必须给一句简短精准的总结，不能只罗列数字。必要提醒单独成段。全文通常控制在120至260字，不输出‘数据依据、匹配记录、更新时间’等技术尾注。",
      "输入中不含个人姓名、联系方式或原始明细；不得猜测或补充任何个人信息。",
      "仅输出JSON：{\"answer\":\"完整中文回答\"}。",
      `表达人格：${JSON.stringify(persona)}`,
    ].join("\n");
    try {
      const completion = await this.complete(
        system,
        `用户问题：${question}\n确定性聚合证据：${JSON.stringify(evidence)}`,
      );
      const parsed = JSON.parse(completion.content) as { answer?: unknown };
      const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
      if (!answer) throw new Error("DeepSeek 未返回分析文本");
      return {
        text: answer,
        trace: {
          source: "deepseek",
          model: this.env.DEEPSEEK_MODEL,
          durationMs: completion.durationMs,
          fallbackReason: null,
        },
      };
    } catch {
      return null;
    }
  }

  public async refineAnswer(
    question: string,
    evidence: AnswerRefinementEvidence,
  ): Promise<ModelAnalysisResult | null> {
    const persona = await loadBotPersona();
    const system = [
      "你是群聊里的经营数据同事。请把确定性的查询结果整理成自然、简短、好读的中文回复。",
      "只能使用证据里的事实和数字，不得补造原因、利润、ROI、商品、达人或日期。不要暴露模型名、字段ID、排序键、记录类型、执行耗时等工程信息。",
      "先直接回答用户关心的结论，再列最多3条关键数字或明细。记录很多时先总结，不要把几十条原始字段整段倾倒。",
      "回复要适合飞书群聊阅读：分成2至4个短区块，区块之间空一行；至少使用2个贴切的视觉锚点，例如📌结论、🛒商品卡、🤝达人、📈趋势、⚠️提醒、🎯总结。关键指标一项一行，排名一名一行。",
      "最后给一句简短精准的总结；必要提醒单独成段。全文通常控制在80至220字，不输出数据依据、匹配记录、更新时间等技术尾注。",
      "如果问题只要第一名而result只返回1条，这是按问题截取的结果；直接回答第一名，不得说其他对象的数据未提供、查不到或不存在。",
      "语气友好自然，可以有轻微口语感，但不要油腻；不要每次使用完全相同的开场白。",
      "如果证据不足，就明确说目前能确认什么、还缺什么。用户请求的时间长度与结果实际覆盖范围不一致时，必须明确实际覆盖范围，不能把不完整范围说成完整周期。",
      "证据带currencyCode时，每一个金额数字必须写明货币名称和代码；没有currencyCode时不得猜币种。",
      "仅输出JSON：{\"answer\":\"完整中文回复\"}。",
      `表达人格：${JSON.stringify(persona)}`,
    ].join("\n");
    try {
      const completion = await this.complete(
        system,
        `用户问题：${question}\n确定性查询证据：${JSON.stringify(evidence)}`,
      );
      const parsed = JSON.parse(completion.content) as { answer?: unknown };
      const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
      if (!answer) return null;
      return {
        text: answer,
        trace: {
          source: "deepseek",
          model: this.env.DEEPSEEK_MODEL,
          durationMs: completion.durationMs,
          fallbackReason: null,
        },
      };
    } catch {
      return null;
    }
  }

  public async suggestProductName(
    sourceTitle: string,
    existingNames: string[],
  ): Promise<ProductNameSuggestion | null> {
    const system = [
      "你负责给 TikTok Shop 商品拟一个供经营表使用的精炼中文名。",
      "只根据原始商品标题判断，不补充标题里没有的材质、功效、数量或规格。",
      "名称要自然、好懂，通常 4 至 10 个中文字符；不要机翻腔，不要品牌名、颜色、促销词和重复修饰词，除非这些信息是区分商品所必需。",
      "多个 TikTok 商品 ID 可能只是同一商品的颜色变体、重复上架或标题改写；只要核心商品和真实规格相同，必须优先复用当前已确认名称中的完全相同名称，以便合并为一个经营商品。",
      "数量、套装规格、型号、尺寸或核心功能确实不同的商品不得合并；颜色、促销词、标题顺序和普通营销描述本身不构成不同规格。",
      "如果标题明确是多件装，名称末尾保留统一规格，例如（2PCS）。",
      "不要复用一个含义不同的现有名称。只输出 JSON：{\"name\":\"中文简称\"}。",
    ].join("\n");
    try {
      const completion = await this.complete(
        system,
        `原始标题：${sourceTitle}\n当前已确认名称：${JSON.stringify(existingNames.slice(0, 100))}`,
      );
      const parsed = JSON.parse(completion.content) as { name?: unknown };
      const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
      if (!name) return null;
      return {
        name,
        trace: {
          source: "deepseek",
          model: this.env.DEEPSEEK_MODEL,
          durationMs: completion.durationMs,
          fallbackReason: null,
        },
      };
    } catch {
      return null;
    }
  }

  private async complete(system: string, user: string): Promise<CompletionResult> {
    const started = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let success = false;
    try {
      const baseUrl = this.env.DEEPSEEK_BASE_URL.replace(/\/$/, "");
      const endpoint = `${baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`}/chat/completions`;
      const apiKey = this.env.DEEPSEEK_API_KEY.startsWith("sk-") ? this.env.DEEPSEEK_API_KEY : `sk-${this.env.DEEPSEEK_API_KEY}`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: this.env.DEEPSEEK_MODEL, temperature: 0, thinking: { type: "disabled" }, response_format: { type: "json_object" }, messages: [
          { role: "system", content: system }, { role: "user", content: user },
        ] }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`DeepSeek 请求失败：HTTP ${response.status}`);
      const data = await response.json() as ChatResponse;
      inputTokens = data.usage?.prompt_tokens ?? 0;
      outputTokens = data.usage?.completion_tokens ?? 0;
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("DeepSeek 未返回内容");
      success = true;
      return { content, durationMs: Date.now() - started };
    } finally {
      logModelCall({
        timestamp: new Date().toISOString(),
        model: this.env.DEEPSEEK_MODEL,
        inputTokens,
        outputTokens,
        durationMs: Date.now() - started,
        success,
        estimatedCost: estimateCost(this.env, inputTokens, outputTokens),
      });
    }
  }
}

interface CompletionResult {
  content: string;
  durationMs: number;
}

function deepSeekResult(intent: QueryIntent, model: string, durationMs: number): ModelParseResult {
  return { intent, trace: { source: "deepseek", model, durationMs, fallbackReason: null } };
}

function fallbackResult(fallback: QueryIntent, error: unknown, durationMs = 0): ModelParseResult {
  return {
    intent: fallback,
    trace: {
      source: "local",
      model: null,
      durationMs,
      fallbackReason: error instanceof Error ? error.message : String(error),
    },
  };
}

function validateAgainstContext(intent: QueryIntent, context: ModelContext): QueryIntent {
  for (const [name, field] of [["指标", intent.metricField], ["对象", intent.entityField], ["日期", intent.dateField]] as const) {
    if (field && !context.headers.includes(field)) throw new Error(`模型返回了不存在的${name}字段：${field}`);
  }
  if (intent.entityValue) {
    const candidates = intent.entityField ? context.entityCandidatesByField?.[intent.entityField] : undefined;
    const allowed = candidates ?? context.entityCandidates;
    if (!allowed.includes(intent.entityValue)) throw new Error(`模型返回了不存在的对象：${intent.entityValue}`);
  }
  if ((intent.intent === "sum" || intent.intent === "average" || intent.intent === "rank") && !intent.metricField) throw new Error("模型未返回指标字段");
  if ((intent.intent === "rank" || intent.intent === "rank_count" || intent.intent === "list" || intent.intent === "distinct_count") && !intent.entityField) throw new Error("模型未返回对象字段");
  if (intent.sortField && !context.headers.includes(intent.sortField)) throw new Error(`模型返回了不存在的排序字段：${intent.sortField}`);
  for (const field of intent.selectFields) {
    if (!context.headers.includes(field)) throw new Error(`模型返回了不存在的展示字段：${field}`);
  }
  for (const filter of intent.numericFilters ?? []) {
    if (!context.headers.includes(filter.field)) throw new Error(`模型返回了不存在的筛选字段：${filter.field}`);
    if (!Number.isFinite(filter.value)) throw new Error(`模型返回了无效筛选值：${filter.field}`);
  }
  if (intent.entityValue && !intent.entityField) throw new Error("模型返回了对象值但没有对象字段");
  if ((intent.startDate || intent.endDate) && !intent.dateField) throw new Error("模型返回了日期范围但没有日期字段");
  return intent;
}

export function createModelProvider(env: AppEnv): ModelProvider {
  return env.MODEL_PROVIDER === "deepseek" ? new DeepSeekProvider(env) : new MockModelProvider();
}
