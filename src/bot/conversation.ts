import type { ConversationContext } from "../types/index.js";
import { normalizeText } from "../utils/value.js";

export interface PendingClarificationState {
  question: string;
  options: string[];
  createdAt: number;
  attempts: number;
}

export function sessionIsFresh(
  context: ConversationContext,
  pending: PendingClarificationState | null,
  now = Date.now(),
  ttlMs = 2 * 60 * 60_000,
): boolean {
  const lastActivity = Math.max(context.updatedAt, pending?.createdAt ?? 0);
  return lastActivity > 0 && now - lastActivity < ttlMs;
}

export function clarificationDomain(text: string, options: string[] = []): "development" | "cooperation" | "online" | "all" | null {
  const normalized = normalizeText(text);
  const optionText = normalizeText(options.join(" "));
  const combined = `${normalized}${optionText}`;

  if (/^(?:都可以|都行|都看|全部|全都|一起看|都要|两个都看|三个都看)$/.test(normalized)) {
    return "all";
  }

  if (/上线|视频|销量|销售额|曝光|播放|挂车/.test(normalized) && /上线|视频|销量|销售额|曝光|播放|挂车/.test(combined)) {
    return "online";
  }
  if (/合作|寄样|付款|粉丝|联系方式|主页/.test(normalized) && /合作|寄样|付款|粉丝|联系方式|主页/.test(combined)) {
    return "cooperation";
  }
  if (/开发|邮箱|whatsapp|联盟|归属/.test(normalized) && /开发|邮箱|whatsapp|联盟|归属/.test(combined)) {
    return "development";
  }
  return null;
}

export function mergeClarificationReply(originalQuestion: string, reply: string, options: string[]): string {
  const domain = clarificationDomain(reply, options);
  const parts = [originalQuestion, `用户补充：${reply}`];
  if (domain === "online") parts.push("上下文数据域：上线");
  if (domain === "cooperation") parts.push("上下文数据域：合作");
  if (domain === "development") parts.push("上下文数据域：开发");
  if (domain === "all") {
    const hasDevelopment = options.some((option) => /开发/.test(option));
    parts.push(hasDevelopment ? "上下文数据域：开发、合作和上线" : "上下文数据域：合作和上线");
  }
  return parts.join("\n");
}
