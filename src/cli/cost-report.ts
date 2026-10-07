import { readModelCalls } from "../ai/cost-log.js";

const records = readModelCalls();
const now = new Date();
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const day = dateKey(now);
const month = day.slice(0, 7);
const today = records.filter((item) => dateKey(new Date(item.timestamp)) === day);
const thisMonth = records.filter((item) => dateKey(new Date(item.timestamp)).startsWith(month));
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const input = sum(thisMonth.map((item) => item.inputTokens));
const output = sum(thisMonth.map((item) => item.outputTokens));

console.log(JSON.stringify({
  当日调用次数: today.length,
  当月调用次数: thisMonth.length,
  当月输入Token总量: input,
  当月输出Token总量: output,
  当月估算费用: Number(sum(thisMonth.map((item) => item.estimatedCost)).toFixed(6)),
  单次平均Token: thisMonth.length ? Math.round((input + output) / thisMonth.length) : 0,
  平均响应时间毫秒: thisMonth.length ? Math.round(sum(thisMonth.map((item) => item.durationMs)) / thisMonth.length) : 0,
}, null, 2));
