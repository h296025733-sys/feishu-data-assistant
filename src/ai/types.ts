import type { FieldRoles, QueryIntent } from "../types/index.js";

export interface ModelContext {
  headers: string[];
  roles: FieldRoles;
  entityCandidates: string[];
  entityCandidatesByField?: Record<string, string[]>;
}

export interface ModelParseTrace {
  source: "deepseek" | "local";
  model: string | null;
  durationMs: number;
  fallbackReason: string | null;
}

export interface ModelParseResult {
  intent: QueryIntent;
  trace: ModelParseTrace;
}

export interface AnalysisEvidence {
  tableName: string;
  currencyCode?: string | null;
  recordCount: number;
  duplicateRecordCount: number;
  aggregationNotes: string[];
  dateRanges: Array<{
    field: string;
    earliest: string | null;
    latest: string | null;
    validCount: number;
    missingCount: number;
  }>;
  categoryBreakdowns: Array<{
    field: string;
    nonEmptyCount: number;
    uniqueCount: number;
    topValues: Array<{ value: string; count: number }>;
  }>;
  numericSummaries: Array<{
    field: string;
    validCount: number;
    missingCount: number;
    sum: number;
    average: number;
    minimum: number;
    maximum: number;
  }>;
  missingFields: Array<{ field: string; missingCount: number; missingRate: number }>;
}

export interface ModelAnalysisResult {
  text: string;
  trace: ModelParseTrace;
}

export interface ProductNameSuggestion {
  name: string;
  trace: ModelParseTrace;
}

export type BusinessQueryDomain = "development" | "cooperation" | "online" | "roi" | "comprehensive";

export interface QuestionRouteResult {
  domain: BusinessQueryDomain | null;
  confidence: number;
}

export interface AnswerRefinementEvidence {
  tableName: string;
  dateRange: string;
  matchedRows: number;
  metricField: string;
  currencyCode?: string | null;
  result: unknown;
  localDraft: string;
}

export interface MetricComparisonPlan {
  leftField: string;
  rightField: string;
  leftLabel: string;
  rightLabel: string;
  confidence: number;
}

export interface EntityCandidateSelection {
  selected: string[];
  label: string | null;
  confidence: number;
}

export interface DailyReportHighlightCandidate {
  id: string;
  text: string;
  priority: number;
}

export interface DailyReportHighlightContext {
  storeName: string;
  runLabel: string;
  reportType?: "daily" | "weekly" | "monthly";
  periodLabel?: string | null;
  analyticsDate: string | null;
  orderDate: string | null;
  candidates: DailyReportHighlightCandidate[];
}

export type CrossTenantIntent =
  | "store_ranking"
  | "product_ranking"
  | "cross_summary"
  | "single_store_query"
  | "store_list"
  | "unknown";

export type CrossTenantMetric = "sales" | "quantity" | "orders";

export interface CrossTenantStoreCandidate {
  id: string;
  name: string;
  aliases: string[];
}

export interface CrossTenantQuestionContext {
  stores: CrossTenantStoreCandidate[];
  recentUserMessages: string[];
  recentAssistantMessages: string[];
  lastQuestion: string | null;
  lastIntent: CrossTenantIntent | null;
  lastMetric: CrossTenantMetric | null;
  lastDays: number | null;
  lastStartDate: string | null;
  lastEndDate: string | null;
  lastTenantIds: string[];
}

export interface CrossTenantQuestionPlan {
  intent: CrossTenantIntent;
  metric: CrossTenantMetric;
  days: number;
  startDate: string | null;
  endDate: string | null;
  tenantIds: string[];
  delegatedQuestion: string;
  confidence: number;
}

export type MessageIntentHint =
  | "business_query"
  | "task_status"
  | "automatic_sync_result"
  | "latest_business_data"
  | "schedule_expectation"
  | "pending_items"
  | "base_link"
  | "store_config"
  | "initialization"
  | "schedule_change"
  | "memory_command"
  | "help"
  | "cancel"
  | "chitchat"
  | "other";

export interface MessageUnderstandingContext {
  recentUserMessages: string[];
  recentAssistantMessages: string[];
  lastBusinessQuestion: string | null;
  recentDomain: BusinessQueryDomain | null;
  storeKnowledge: string[];
}

export interface MessageUnderstanding {
  rewrittenQuestion: string;
  intentHint: MessageIntentHint;
  contextualFollowUp: boolean;
  directReply: string | null;
  confidence: number;
}

export interface ModelProvider {
  readonly name: "mock" | "deepseek";
  understandMessage?(question: string, context: MessageUnderstandingContext): Promise<MessageUnderstanding | null>;
  routeQuestion?(question: string, recentDomain: BusinessQueryDomain | null): Promise<QuestionRouteResult | null>;
  parseIntent(question: string, context: ModelContext, fallback: QueryIntent): Promise<ModelParseResult>;
  analyze?(question: string, evidence: AnalysisEvidence): Promise<ModelAnalysisResult | null>;
  refineAnswer?(question: string, evidence: AnswerRefinementEvidence): Promise<ModelAnalysisResult | null>;
  resolveMetricComparison?(question: string, numericFields: string[]): Promise<MetricComparisonPlan | null>;
  selectEntityCandidates?(question: string, candidates: string[]): Promise<EntityCandidateSelection | null>;
  selectDailyReportHighlights?(context: DailyReportHighlightContext): Promise<string[] | null>;
  suggestProductName?(sourceTitle: string, existingNames: string[]): Promise<ProductNameSuggestion | null>;
  understandCrossTenantQuestion?(
    question: string,
    context: CrossTenantQuestionContext,
  ): Promise<CrossTenantQuestionPlan | null>;
}
