export type DataRow = Record<string, unknown>;

export interface TableData {
  sourceName: string;
  sheetName: string;
  headers: string[];
  rows: DataRow[];
  updatedAt: Date;
}

export interface DataSource {
  getTable(question?: string): Promise<TableData>;
}

export interface FieldRoles {
  dateField: string | null;
  entityField: string | null;
  amountField: string | null;
  quantityField: string | null;
  ambiguous: Partial<Record<"date" | "entity" | "amount" | "quantity", string[]>>;
}

export type QueryIntentName = "sum" | "average" | "count" | "distinct_count" | "rank" | "rank_count" | "list" | "summary" | "records";
export type ResponseStyle = "concise" | "detailed" | "table";
export type NumericFilterOperator = "gt" | "gte" | "lt" | "lte" | "eq";

export interface NumericFilter {
  field: string;
  operator: NumericFilterOperator;
  value: number;
}

export interface QueryIntent {
  intent: QueryIntentName;
  metricField: string | null;
  entityField: string | null;
  entityValue: string | null;
  dateField: string | null;
  startDate: string | null;
  endDate: string | null;
  sortDirection: "asc" | "desc" | null;
  sortField: string | null;
  limit: number;
  selectFields: string[];
  responseStyle: ResponseStyle;
  numericFilters?: NumericFilter[];
  outputMode?: "answer" | "export";
}

export interface ConversationContext {
  lastEntityValue: string | null;
  lastEntityField: string | null;
  lastMetricField: string | null;
  lastDateField: string | null;
  lastStartDate: string | null;
  lastEndDate: string | null;
  lastTableHint: "development" | "cooperation" | "online" | "roi" | null;
  lastSelectFields: string[];
  lastQuestion: string | null;
  updatedAt: number;
}
