import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseDotEnv } from "dotenv";
import { z } from "zod";

loadDeepSeekSecrets();

const envSchema = z.object({
  FEISHU_APP_ID: z.string().optional().default(""),
  FEISHU_APP_SECRET: z.string().optional().default(""),
  FEISHU_BITABLE_URL: z.string().optional().default(""),
  FEISHU_BITABLE_APP_TOKEN: z.string().optional().default(""),
  FEISHU_BITABLE_TABLE_ID: z.string().optional().default(""),
  BOT_ALLOWED_USER_IDS: z.string().optional().default(""),
  BOT_PRIVATE_USER_IDS: z.string().optional().default(""),
  MODEL_PROVIDER: z.enum(["mock", "deepseek"]).optional().default("mock"),
  DEEPSEEK_API_KEY: z.string().optional().default(""),
  DEEPSEEK_BASE_URL: z.string().url().optional().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL: z.string().optional().default(""),
  DRY_RUN: z.string().optional().default("true"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),
  DEEPSEEK_INPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative().optional().default(0),
  DEEPSEEK_OUTPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative().optional().default(0),
});

function loadDeepSeekSecrets(): void {
  if (String(process.env.MODEL_PROVIDER ?? "").trim() !== "deepseek") return;
  const configuredPath = String(process.env.DEEPSEEK_CONFIG_FILE ?? "").trim();
  if (!configuredPath) return;

  const values = parseDotEnv(readFileSync(resolve(process.cwd(), configuredPath)));
  const allowedKeys = [
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "DEEPSEEK_MODEL",
    "DEEPSEEK_INPUT_PRICE_PER_MILLION",
    "DEEPSEEK_OUTPUT_PRICE_PER_MILLION",
  ] as const;
  for (const key of allowedKeys) {
    if (!String(process.env[key] ?? "").trim() && String(values[key] ?? "").trim()) {
      process.env[key] = values[key];
    }
  }
}

export type AppEnv = Omit<z.infer<typeof envSchema>, "BOT_PRIVATE_USER_IDS"> & {
  BOT_PRIVATE_USER_IDS?: string;
  BOT_ADMIN_USER_IDS?: string;
  BOT_EDITOR_USER_IDS?: string;
  BOT_VIEWER_USER_IDS?: string;
};

export function getEnv(): AppEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`环境变量格式错误：${z.prettifyError(parsed.error)}`);
  }
  let appToken = parsed.data.FEISHU_BITABLE_APP_TOKEN;
  let tableId = parsed.data.FEISHU_BITABLE_TABLE_ID;
  const baseUrl = parsed.data.FEISHU_BITABLE_URL.trim();
  if (baseUrl && (!appToken || !tableId)) {
    try {
      const url = new URL(baseUrl);
      appToken ||= url.pathname.match(/\/base\/([^/?#]+)/)?.[1] ?? "";
      tableId ||= url.searchParams.get("table") ?? "";
    } catch {
      throw new Error("FEISHU_BITABLE_URL 不是有效的飞书多维表格地址。");
    }
  }
  return {
    ...parsed.data,
    FEISHU_BITABLE_APP_TOKEN: appToken,
    FEISHU_BITABLE_TABLE_ID: tableId,
  };
}

export function requireFeishuEnv(env = getEnv()): AppEnv {
  const missing = [
    ["FEISHU_APP_ID", env.FEISHU_APP_ID],
    ["FEISHU_APP_SECRET", env.FEISHU_APP_SECRET],
    ["FEISHU_BITABLE_APP_TOKEN", env.FEISHU_BITABLE_APP_TOKEN],
    ["FEISHU_BITABLE_TABLE_ID", env.FEISHU_BITABLE_TABLE_ID],
  ].filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`缺少飞书环境变量：${missing.join("、")}。请在本地 .env 中配置，勿在聊天中发送密钥。`);
  }
  return env;
}

export function requireDeepSeekEnv(env = getEnv()): AppEnv {
  const missing = [
    ["DEEPSEEK_API_KEY", env.DEEPSEEK_API_KEY],
    ["DEEPSEEK_MODEL", env.DEEPSEEK_MODEL],
  ].filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`缺少 DeepSeek 环境变量：${missing.join("、")}。可改用 MODEL_PROVIDER=mock。`);
  }
  return env;
}

export function allowedUserIds(env = getEnv()): Set<string> {
  return new Set(env.BOT_ALLOWED_USER_IDS.split(",").map((item: string) => item.trim()).filter(Boolean));
}

/**
 * 可在私聊中查看全部已关联店铺的人员。
 *
 * BOT_ALLOWED_USER_IDS 仅作为旧配置兼容回退；正式多店部署应显式填写
 * BOT_PRIVATE_USER_IDS，避免把普通群成员误授予跨店权限。
 */
export function privateUserIds(env = getEnv()): Set<string> {
  const configured = String(env.BOT_PRIVATE_USER_IDS ?? "").trim();
  return configured ? splitIds(configured) : allowedUserIds(env);
}

export function onlineDateAdminUserIds(env = getEnv()): Set<string> {
  const configured = String(process.env.ONLINE_DATE_ADMIN_USER_IDS ?? "").trim();
  if (!configured) return allowedUserIds(env);
  return new Set(configured.split(",").map((item: string) => item.trim()).filter(Boolean));
}

export function botAdminUserIds(env = getEnv()): Set<string> {
  const configured = String(env.BOT_ADMIN_USER_IDS ?? process.env.BOT_ADMIN_USER_IDS ?? "").trim();
  return configured
    ? splitIds(configured)
    : onlineDateAdminUserIds(env);
}

export function botEditorUserIds(env = getEnv()): Set<string> {
  return splitIds(String(env.BOT_EDITOR_USER_IDS ?? process.env.BOT_EDITOR_USER_IDS ?? ""));
}

export function botViewerUserIds(env = getEnv()): Set<string> {
  return splitIds(String(env.BOT_VIEWER_USER_IDS ?? process.env.BOT_VIEWER_USER_IDS ?? ""));
}

function splitIds(value: string): Set<string> {
  return new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
}
