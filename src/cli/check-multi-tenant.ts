import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getEnv, privateUserIds, requireFeishuEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { readTenantRuntimeSettings } from "../config/tenant-runtime-settings.js";
import { createFeishuClient } from "../feishu/client.js";
import { FeishuBitableDataSource } from "../feishu/data-source.js";
import { isolatedChildEnvironment } from "../realtime/tiktok-cli.js";

const execFileAsync = promisify(execFile);
const TIKTOK_ROOT = (process.env.TIKTOK_PIPELINE_ROOT || "../tiktok-shop-data-pipeline");
const TIKTOK_PYTHON = `${TIKTOK_ROOT}\\.venv\\Scripts\\python.exe`;

interface TenantCheck {
  id: string;
  store: string;
  base: { ok: boolean; tables: string[]; missing: string[]; error: string | null };
  tiktok: {
    ok: boolean;
    shopIdConfigured: boolean;
    credentialProfile: string | null;
    accessTokenPresent: boolean;
    refreshTokenPresent: boolean;
    error: string | null;
  };
  groups: Array<{ chatId: string; source: "configured" | "runtime" }>;
  schedule: {
    enabled: boolean;
    localTime: string | null;
    reportLocalTime: string | null;
    timeZone: string;
    source: "runtime" | "profile";
  };
}

const env = requireFeishuEnv(getEnv());
const registry = new TenantRegistry(env);
const client = createFeishuClient(env);
const configuredPrivate = String(process.env[registry.privateAccess.userIdsEnv] ?? "").trim();
const privateUsers = configuredPrivate
  ? new Set(configuredPrivate.split(",").map((item) => item.trim()).filter(Boolean))
  : privateUserIds(env);
const checks: TenantCheck[] = [];

for (const tenant of registry.all()) {
  const runtimeSettings = await readTenantRuntimeSettings(tenant.binding.id);
  const requiredTables = Object.values(tenant.profile.tables);
  let tables: string[] = [];
  let baseError: string | null = null;
  try {
    tables = await new FeishuBitableDataSource(tenant.env, client, tenant.profile).getTableNames();
  } catch (error) {
    baseError = safeError(error);
  }
  const missing = requiredTables.filter((name) => !tables.includes(name));

  let accessTokenPresent = false;
  let refreshTokenPresent = false;
  let tiktokError: string | null = null;
  const credentialProfile = tenant.profile.tiktok.credentialProfile ?? null;
  if (!credentialProfile) {
    tiktokError = "未配置 credentialProfile";
  } else {
    try {
      const result = await execFileAsync(TIKTOK_PYTHON, ["-m", "src.cli", "auth", "status"], {
        cwd: TIKTOK_ROOT,
        env: {
          ...isolatedChildEnvironment(),
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
          TTS_CREDENTIAL_PROFILE: credentialProfile,
        },
        timeout: 30_000,
        windowsHide: true,
      });
      const status = JSON.parse(result.stdout) as Record<string, unknown>;
      accessTokenPresent = status.access_token_present === true;
      refreshTokenPresent = status.refresh_token_present === true;
    } catch (error) {
      tiktokError = safeError(error);
    }
  }

  checks.push({
    id: tenant.binding.id,
    store: tenant.profile.businessDisplayName,
    base: {
      ok: !baseError && missing.length === 0,
      tables,
      missing,
      error: baseError,
    },
    tiktok: {
      ok: Boolean(tenant.profile.tiktok.shopId) && accessTokenPresent && refreshTokenPresent && !tiktokError,
      shopIdConfigured: Boolean(tenant.profile.tiktok.shopId),
      credentialProfile,
      accessTokenPresent,
      refreshTokenPresent,
      error: tiktokError,
    },
    groups: registry.groupRoutesForTenant(tenant.binding.id),
    schedule: {
      enabled: runtimeSettings?.dailyAutomation.enabled
        ?? tenant.profile.dailyAutomation?.enabled
        ?? false,
      localTime: runtimeSettings?.dailyAutomation.localTime
        ?? tenant.profile.dailyAutomation?.localTime
        ?? null,
      reportLocalTime: tenant.profile.dailyAutomation?.reportLocalTime ?? null,
      timeZone: tenant.profile.businessTimeZone,
      source: runtimeSettings ? "runtime" : "profile",
    },
  });
}

const ok = checks.every((item) => item.base.ok && item.tiktok.ok)
  && (!registry.privateAccess.enabled || privateUsers.size > 0);
console.log(JSON.stringify({
  ok,
  checkedAt: new Date().toISOString(),
  tenantCount: checks.length,
  privateAccess: {
    enabled: registry.privateAccess.enabled,
    userIdsEnv: registry.privateAccess.userIdsEnv,
    authorizedUserCount: privateUsers.size,
  },
  tenants: checks,
  notes: [
    "群聊ID为空不代表配置失败；可以在新群中由私聊白名单成员发送绑定命令建立运行绑定。",
    "本报告只显示Token是否存在，不显示任何密钥或Token内容。",
  ],
}, null, 2));
if (!ok) process.exitCode = 1;

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:access|refresh)[_-]?token\s*[:=]\s*[^\s,;]+/gi, "token=[REDACTED]")
    .replace(/sk-[a-zA-Z0-9_-]+/g, "sk-[REDACTED]")
    .slice(0, 500);
}
