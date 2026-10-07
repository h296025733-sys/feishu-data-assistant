import type { AppEnv } from "../config/env.js";
import {
  allowedUserIds,
  botAdminUserIds,
  botEditorUserIds,
  botViewerUserIds,
} from "../config/env.js";

export type BotRole = "admin" | "editor" | "viewer";
export type BotOperation = "query_basic" | "query_sensitive" | "write" | "rollback" | "admin";

export function roleForUser(userId: string, env: AppEnv): BotRole {
  if (botAdminUserIds(env).has(userId)) return "admin";
  if (botEditorUserIds(env).has(userId)) return "editor";
  if (botViewerUserIds(env).has(userId)) return "viewer";
  // BOT_ALLOWED_USER_IDS remains the outer allowlist. Unassigned members are
  // deliberately read-only once explicit role lists are introduced.
  return allowedUserIds(env).has(userId) ? "viewer" : "viewer";
}

export function canPerform(role: BotRole, operation: BotOperation): boolean {
  if (role === "admin") return true;
  if (role === "editor") return operation === "query_basic" || operation === "write";
  return operation === "query_basic";
}

export function assertCanPerform(role: BotRole, operation: BotOperation): void {
  if (canPerform(role, operation)) return;
  if (operation === "query_sensitive") {
    throw new Error("这类内容包含联系方式、付款或经营财务信息，仅管理员可以查询。你仍可查询上线/合作数量等基础进度。");
  }
  if (operation === "write") {
    throw new Error("你当前是只读成员，不能发起或确认填表。请由管理员把你的 open_id 加入 BOT_EDITOR_USER_IDS。");
  }
  if (operation === "rollback") {
    throw new Error("回滚会改变已有数据，仅管理员可以执行。");
  }
  throw new Error("当前操作仅管理员可以执行。");
}

export function queryOperation(question: string): BotOperation {
  return /邮箱|邮件|whatsapp|手机号|电话|联系方式|收货|地址|paypal|付款|支付|佣金|广告花费|销售额|成交额|gmv|投产比|roi|利润|成本/i.test(question)
    ? "query_sensitive"
    : "query_basic";
}

export function roleLabel(role: BotRole): string {
  if (role === "admin") return "店铺成员";
  if (role === "editor") return "运营录入员";
  return "只读成员";
}
