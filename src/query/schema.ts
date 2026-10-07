import { z } from "zod";

export const queryIntentSchema = z.object({
  intent: z.enum(["sum", "average", "count", "distinct_count", "rank", "rank_count", "list", "summary", "records"]),
  metricField: z.string().nullable(),
  entityField: z.string().nullable(),
  entityValue: z.string().nullable(),
  dateField: z.string().nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  sortDirection: z.enum(["asc", "desc"]).nullable(),
  sortField: z.string().nullable().optional().default(null),
  // 模型偶尔用 0 表示“不限制”。接受后归一化为 100，避免整次解析失败。
  limit: z.coerce.number().int().min(0).max(100).optional().default(10).transform((value: number) => value === 0 ? 100 : value),
  selectFields: z.array(z.string()).optional().default([]),
  responseStyle: z.enum(["concise", "detailed", "table"]).optional().default("concise"),
  numericFilters: z.array(z.object({
    field: z.string(),
    operator: z.enum(["gt", "gte", "lt", "lte", "eq"]),
    value: z.number().finite(),
  }).strict()).max(8).optional().default([]),
  outputMode: z.enum(["answer", "export"]).optional().default("answer"),
}).strict();

export function parseModelIntentJson(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch {
    throw new Error("模型返回的查询意图不是有效 JSON");
  }
  const parsed = queryIntentSchema.safeParse(value);
  if (!parsed.success) throw new Error(`模型返回的查询意图结构无效：${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
