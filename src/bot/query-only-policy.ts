import { parseRealtimeMessage } from "../realtime/intent.js";
import { isNaturalWriteCandidate } from "../realtime/natural-write-intent.js";

export const QUERY_ONLY_WRITE_MESSAGE = "填表已改为每日自动同步，聊天机器人只提供查询。API 未提供的字段请在经营工作台人工补充；可发送“自动同步状态”查看进度。";

export function isManualWriteRequest(question: string): boolean {
  const normalized = question.trim().replace(/\s+/g, "");
  // “把结果/数据发给我、给我看看”是查询表达，不是写表。真正修改必须同时
  // 出现写入动作和明确的表格目标，或被受控实时意图解析器识别。
  if (/(?:最新|刚更新|刚同步|最近更新).*(?:数据|结果).*(?:发给我|给我看看|告诉我|展示|汇报)/.test(normalized)
    && !/(?:写入|填入|录入|导入|更新到|同步到|修改|删除).*(?:表|多维表|工作台)/.test(normalized)) {
    return false;
  }
  const parsed = parseRealtimeMessage(question);
  if (parsed.control === "status") return false;
  return Boolean(parsed.control || parsed.intent || isNaturalWriteCandidate(question));
}
