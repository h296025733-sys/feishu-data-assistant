import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createModelProvider } from "../ai/providers.js";
import type { DailyAutomationRun, DailyPhaseResult } from "../automation/daily-sync.js";
import { buildDailyGroupReport } from "../bot/daily-group-report.js";
import { loadDailyReportPaidSnapshot } from "../bot/daily-report-paid-snapshot.js";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient, withFeishuRetry } from "../feishu/client.js";
import { FeishuBitableDataSource } from "../feishu/data-source.js";

interface TemplateTestState {
  version: 1;
  testId: string;
  scheduledFor: string;
  deliveries: Record<string, { messageId: string; deliveredAt: string }>;
  updatedAt: string;
}

const delaySeconds = boundedInteger(argument("--delay-seconds", "120"), 0, 600, "--delay-seconds");
const dryRun = process.argv.includes("--dry-run");
const testId = argument("--test-id", `daily-report-template-${new Date().toISOString().slice(0, 10)}`);
const statePath = path.resolve(argument(
  "--state-path",
  path.join(".runtime", "daily-report-template-tests", `${safeFilePart(testId)}.json`),
));
const registry = new TenantRegistry(getEnv());
const tenants = registry.all();
if (tenants.length === 0) throw new Error("没有启用的店铺租户");
for (const tenant of tenants) {
  const routes = registry.groupRoutesForTenant(tenant.binding.id);
  if (routes.length !== 1) {
    throw new Error(`${tenant.binding.id} 专属群数量=${routes.length}；模板测试拒绝跨群或回退投递`);
  }
}

if (dryRun) {
  for (const tenant of tenants) {
    const now = new Date();
    const client = createFeishuClient(tenant.env);
    const report = await buildDailyGroupReport({
      tenantId: tenant.binding.id,
      profile: tenant.profile,
      dataSource: new FeishuBitableDataSource(tenant.env, client, tenant.profile),
      provider: createModelProvider(tenant.env),
      run: templateRun(testId, now),
      presentation: "template_test",
      loadPaidSnapshot: (reportDate) => loadDailyReportPaidSnapshot(tenant.profile, reportDate),
    });
    console.log(JSON.stringify({
      tenantId: tenant.binding.id,
      mode: "dry-run",
      reportDate: report.reportDate,
      dataReadOk: report.dataReadOk,
      dataReadError: report.dataReadError,
      usedDeepSeekSelection: report.usedDeepSeekSelection,
      text: report.text,
      card: report.card,
    }));
  }
  process.exit(0);
}

let state = await readState(statePath);
if (!state) {
  const scheduledFor = new Date(Date.now() + delaySeconds * 1_000).toISOString();
  state = { version: 1, testId, scheduledFor, deliveries: {}, updatedAt: new Date().toISOString() };
  await writeState(statePath, state);
}
if (state.testId !== testId) throw new Error("模板测试状态文件与 --test-id 不一致");
const waitMs = Math.max(0, Date.parse(state.scheduledFor) - Date.now());
console.log(JSON.stringify({
  testId,
  scheduledFor: state.scheduledFor,
  delayRemainingSeconds: Math.ceil(waitMs / 1_000),
  tenants: tenants.map((tenant) => tenant.binding.id),
  alreadyDelivered: Object.keys(state.deliveries),
}));
if (waitMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, waitMs));

for (const tenant of tenants) {
  const tenantId = tenant.binding.id;
  if (state.deliveries[tenantId]) continue;
  const now = new Date();
  const run = templateRun(testId, now);
  const client = createFeishuClient(tenant.env);
  const report = await buildDailyGroupReport({
    tenantId,
    profile: tenant.profile,
    dataSource: new FeishuBitableDataSource(tenant.env, client, tenant.profile),
    provider: createModelProvider(tenant.env),
    run,
    presentation: "template_test",
    loadPaidSnapshot: (reportDate) => loadDailyReportPaidSnapshot(tenant.profile, reportDate),
  });
  const chatId = registry.groupRoutesForTenant(tenantId)[0]!.chatId;
  const uuid = deterministicUuid(`${testId}:${tenantId}:${chatId}`);
  const messageId = await withFeishuRetry(async () => {
    const response = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(report.card),
        uuid,
      },
    });
    assertFeishuResponse(response, `发送${tenant.profile.businessDisplayName}日报模板测试`);
    const id = String(response.data?.message_id ?? "").trim();
    if (!id) throw new Error(`${tenantId} 模板测试发送成功但没有返回 message_id`);
    return id;
  });
  state = {
    ...state,
    deliveries: {
      ...state.deliveries,
      [tenantId]: { messageId, deliveredAt: new Date().toISOString() },
    },
    updatedAt: new Date().toISOString(),
  };
  await writeState(statePath, state);
  console.log(JSON.stringify({
    tenantId,
    delivered: true,
    messageId,
    reportDate: report.reportDate,
    dataReadOk: report.dataReadOk,
    usedDeepSeekSelection: report.usedDeepSeekSelection,
  }));
}

function templateRun(id: string, at: Date): DailyAutomationRun {
  const phase = (): DailyPhaseResult => ({
    ok: true,
    matched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    conflicts: 0,
    missingItems: [],
    error: null,
  });
  return {
    runId: id,
    trigger: "scheduled",
    startedAt: at.toISOString(),
    completedAt: at.toISOString(),
    latestCompleteDate: null,
    orderAttributionTargetDate: null,
    windowStart: null,
    windowEnd: null,
    catalog: phase(),
    online: phase(),
    roi: phase(),
    ok: true,
  };
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "").trim() || fallback : fallback;
}

function boundedInteger(value: string, min: number, max: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} 必须是 ${min}—${max} 的整数`);
  }
  return parsed;
}

function safeFilePart(value: string): string {
  const result = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!result) throw new Error("--test-id 不能生成安全文件名");
  return result;
}

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function readState(file: string): Promise<TemplateTestState | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as TemplateTestState;
    if (parsed.version !== 1 || !parsed.testId || !parsed.scheduledFor || !parsed.deliveries) {
      throw new Error("模板测试状态文件格式无效");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(file: string, value: TemplateTestState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}
