import type { MessageUnderstanding } from "../ai/types.js";

const MAX_REWRITTEN_LENGTH = 800;

export function redactMessageForModel(text: string): string {
  return text
    .replace(/([?&](?:code|access_token|refresh_token|token|secret|app_secret)=)[^&#\s]+/gi, "$1[敏感信息]")
    .replace(/\b(?:ROW|AUTH|TOKEN)_[A-Za-z0-9_-]{16,}\b/g, "[敏感信息]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[敏感信息]")
    .replace(/((?:密码|密钥|secret|token|授权码)\s*[:：=]\s*)\S+/gi, "$1[敏感信息]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱]")
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, "[手机号]")
    .trim();
}

export function protectedMessageLiterals(text: string): string[] {
  const patterns = [
    /\d{4}[年/-]\d{1,2}(?:[月/-]\d{1,2}日?)?/g,
    /\b\d{1,2}:\d{2}\b/g,
    /(?:近|最近|过去|前)(?:一|二|两|三|四|五|六|七|八|九|十|半|\d+)个?(?:天|周|月|年)/g,
    /(?:一|二|两|三|四|五|六|七|八|九|十|百)+个?(?:天|周|月|年)/g,
    /(?:大于|小于|高于|低于|超过|少于|不少于|不多于|至少|至多|等于)/g,
    /\d+(?:\.\d+)?%?/g,
  ];
  return [...new Set(patterns.flatMap((pattern) => text.match(pattern) ?? []))]
    .filter((literal) => !(literal === "一天" && /这一天/.test(text)));
}

export function validateMessageUnderstanding(
  source: string,
  value: MessageUnderstanding | null,
): MessageUnderstanding | null {
  if (!value || value.confidence < 0.45) return null;
  const rewritten = value.rewrittenQuestion.trim();
  if (!rewritten || rewritten.length > MAX_REWRITTEN_LENGTH) return null;
  const ambiguousBestSeller = /卖(?:得|的)?最(?:好|多|火)|最好卖/.test(source)
    && !/销量|数量|件数|单量|订单|销售额|金额|GMV/i.test(source);
  if (ambiguousBestSeller && /(?:按|以)?(?:商品)?(?:销量|数量|件数|单量|订单|销售额|金额|GMV)(?:排名|排行|口径)?/i.test(rewritten)) {
    return null;
  }
  const missingLiteral = protectedMessageLiterals(source).some((literal) => !messageLiteralPreserved(source, rewritten, literal));
  if (missingLiteral) return null;
  return { ...value, rewrittenQuestion: rewritten };
}

function messageLiteralPreserved(source: string, rewritten: string, literal: string): boolean {
  if (rewritten.includes(literal)) return true;
  const shortDate = source.match(/(?:^|[^\d])(\d{1,2})\s*[./]\s*(\d{1,2})\s*(?:日|号|当天|这一天)(?:[^\d]|$)/);
  if (shortDate && literal === `${shortDate[1]}.${shortDate[2]}` || shortDate && literal === `${shortDate[1]}/${shortDate[2]}`) {
    const month = Number(shortDate[1]);
    const day = Number(shortDate[2]);
    return new RegExp(`(?:${month}\\s*月\\s*${day}|${String(month).padStart(2, "0")}[-/.]${String(day).padStart(2, "0")})(?:\\s*(?:日|号))?`).test(rewritten);
  }
  return false;
}
