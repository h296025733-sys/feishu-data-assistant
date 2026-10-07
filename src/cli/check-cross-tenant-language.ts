import { createModelProvider } from "../ai/providers.js";
import { getEnv } from "../config/env.js";
import type { CrossTenantQuestionContext } from "../ai/types.js";

const provider = createModelProvider(getEnv());
if (!provider.understandCrossTenantQuestion) throw new Error("当前模型没有启用跨店语言理解");
const base: CrossTenantQuestionContext = {
  stores: [
    { id: "store-a", name: "晨光店", aliases: ["Morning Store"] },
    { id: "store-b", name: "星河店", aliases: ["Galaxy Store"] },
  ],
  recentUserMessages: [],
  recentAssistantMessages: [],
  lastQuestion: null,
  lastIntent: null,
  lastMetric: null,
  lastDays: null,
  lastStartDate: null,
  lastEndDate: null,
  lastTenantIds: [],
};
const samples = [
  { question: "最近7天哪家店销售额最高？", expected: "store_ranking" },
  { question: "最近30天销量最高的产品来自哪个店？", expected: "product_ranking" },
  { question: "星河店上次自动同步成功了吗？", expected: "single_store_query", tenant: "store-b" },
] as const;
const results = [];
for (const sample of samples) {
  const plan = await provider.understandCrossTenantQuestion(sample.question, base);
  const ok = plan?.intent === sample.expected && (!("tenant" in sample) || plan.tenantIds.includes(sample.tenant));
  results.push({ question: sample.question, ok, plan });
}
console.log(JSON.stringify({ ok: results.every((item) => item.ok), provider: provider.name, results }, null, 2));
if (results.some((item) => !item.ok)) process.exitCode = 1;
