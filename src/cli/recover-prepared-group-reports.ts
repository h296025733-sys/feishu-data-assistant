import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createModelProvider } from "../ai/providers.js";
import type { DailyAutomationRun, DailyPhaseResult } from "../automation/daily-sync.js";
import { loadDailyReportPaidSnapshot } from "../bot/daily-report-paid-snapshot.js";
import { loadPeriodicReportPaidSnapshot } from "../bot/periodic-report-paid-snapshot.js";
import { PreparedGroupReportService } from "../bot/prepared-group-reports.js";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import {
  assertFeishuResponse,
  createFeishuClient,
  withFeishuRetry,
} from "../feishu/client.js";
import { FeishuBitableDataSource } from "../feishu/data-source.js";
import { dateKeyInTimeZone, shiftIsoDate, zonedWallTimeToInstant } from "../realtime/business-time.js";

const CONFIRMATION = "PREPARED-REPORT-RECOVERY";
const rootEnv = requireFeishuEnv(getEnv());
const registry = new TenantRegistry(rootEnv);
const sendDate = argument("--send-date")
  ?? dateKeyInTimeZone(new Date(), "Asia/Shanghai");
const tenantId = argument("--tenant");
const selectedTenant = tenantId ? registry.byId(tenantId) : null;
if (tenantId && !selectedTenant) throw new Error(`店铺租户不存在或未启用：${tenantId}`);
const shouldSend = process.argv.includes("--send");
const prepareOnly = process.argv.includes("--prepare-only");
const deliverOnly = process.argv.includes("--deliver-only");
if ((prepareOnly && shouldSend) || (deliverOnly && !shouldSend)) throw new Error("prepare-only 与 send 互斥；deliver-only 需要 send");
if (shouldSend && argument("--confirm") !== CONFIRMATION) {
  throw new Error(`真实补发必须追加 --confirm ${CONFIRMATION}`);
}

const rows: Array<Record<string, unknown>> = [];
for (const tenant of selectedTenant ? [selectedTenant] : registry.all()) {
  const status = await readStatus(tenant.binding.id);
  const run = recoveryRun(sendDate, tenant.profile.businessTimeZone, status);
  const client = createFeishuClient(tenant.env);
  const chatIds = registry.groupRoutesForTenant(tenant.binding.id).map((route) => route.chatId);
  if (chatIds.length !== 1) {
    throw new Error(`${tenant.binding.id} 必须且只能绑定一个正式经营群，当前为 ${chatIds.length} 个`);
  }
  const service = new PreparedGroupReportService({
    tenantId: tenant.binding.id,
    profile: tenant.profile,
    dataSource: new FeishuBitableDataSource(tenant.env, client, tenant.profile),
    provider: createModelProvider(tenant.env),
    groupChatIds: chatIds,
    sendCard: async (chatId, card, idempotencyKey) => {
      if (!shouldSend) throw new Error("只读恢复预览禁止调用飞书消息发送接口");
      const uuid = deterministicUuid(idempotencyKey);
      return withFeishuRetry(async () => {
        const response = await client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "interactive",
            content: JSON.stringify(card),
            uuid,
          },
        });
        assertFeishuResponse(response, "补发店铺群报告");
        const messageId = String(response.data?.message_id ?? "").trim();
        if (!messageId) throw new Error("飞书补发成功但没有返回 message_id");
        return messageId;
      }, { attempts: 4, baseDelayMs: 1_000 });
    },
    loadDailyPaidSnapshot: (date) => loadDailyReportPaidSnapshot(tenant.profile, date),
    loadPeriodicPaidSnapshot: (startDate, endDate) => (
      loadPeriodicReportPaidSnapshot(tenant.profile, startDate, endDate)
    ),
  });

  if (!shouldSend) {
    const preview = prepareOnly ? await service.prepareRun(run) : await service.previewRun(run);
    rows.push({
      tenantId: tenant.binding.id,
      store: tenant.profile.businessDisplayName,
      sendDate,
      mode: prepareOnly ? "prepared-local-no-send" : "preview",
      errors: preview.errors,
      reports: preview.reports.map((report) => ({
        reportKey: report.reportKey,
        audience: report.audience,
        kind: report.kind,
        sourcePeriod: `${report.sourceStartDate}..${report.sourceEndDate}`,
        dataReadOk: report.dataReadOk,
        dataComplete: report.dataComplete,
        text: report.text,
      })),
    });
    continue;
  }

  const priorState = await readFile(path.resolve(".runtime", "tenants", tenant.binding.id, "prepared-group-reports", "state.json"), "utf8")
    .then((value) => JSON.parse(value))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return { deliveries: {} };
      throw error;
    });
  const previousIds = new Set(Object.values(priorState.deliveries ?? {}).flatMap((byChat: any) => Object.values(byChat).map((record: any) => record.messageId)));
  const prepared = deliverOnly ? { errors: [], reports: [] } : await service.prepareRun(run);
  const delivery = await service.deliverDate(sendDate);
  rows.push({
    tenantId: tenant.binding.id,
    store: tenant.profile.businessDisplayName,
    sendDate,
    mode: "send",
    newlyDelivered: delivery.delivered.filter((item) => !previousIds.has(item.messageId)).length,
    alreadyDelivered: delivery.delivered.filter((item) => previousIds.has(item.messageId)).length,
    preparedErrors: prepared.errors,
    preparedReportKeys: prepared.reports.map((report) => report.reportKey),
    delivered: delivery.delivered.map((item) => ({
      reportKey: item.reportKey,
      chatId: item.chatId,
      messageId: item.messageId,
      deliveredAt: item.deliveredAt,
    })),
    pendingReportKeys: delivery.pendingReportKeys,
    preparationErrors: delivery.preparationErrors,
  });
}

const summary = {
  ok: rows.every((row) => (
    !Array.isArray(row.errors) || row.errors.length === 0
  ) && (
    !Array.isArray(row.pendingReportKeys) || row.pendingReportKeys.length === 0
  ) && (
    !Array.isArray(row.preparationErrors) || row.preparationErrors.length === 0
  )),
  evidence: shouldSend
    ? deliverOnly
      ? "复用已验证本地载荷，正式IM投递/已有回执幂等跳过；未重新全表读取Base"
      : "正式Base读取 + 正式IM投递/已有回执幂等跳过；持久reportKey与确定性UUID双重幂等"
    : prepareOnly ? "正式Base/TikTok只读准备并在本地保存载荷；未发消息、未写Base" : "正式Base只读预览；未发消息、未写Base",
  checkedAt: new Date().toISOString(),
  sendDate,
  rows,
};
console.log(JSON.stringify(summary, null, 2));
const output = argument("--output");
if (output) {
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(path.resolve(output), JSON.stringify(summary, null, 2), { mode: 0o600 });
}

async function readStatus(tenantIdValue: string): Promise<{ lastAutomaticRun?: DailyAutomationRun; lastRun?: DailyAutomationRun }> {
  const file = path.resolve(".runtime", "tenants", tenantIdValue, "daily-automation", "status.json");
  return JSON.parse(await readFile(file, "utf8"));
}

function recoveryRun(
  date: string,
  timeZone: string,
  status: { lastAutomaticRun?: DailyAutomationRun; lastRun?: DailyAutomationRun },
): DailyAutomationRun {
  const latest = status.lastAutomaticRun ?? status.lastRun;
  // A historical replay must not borrow a later day's account analytics date.
  // Preserve the latest known complete date only when it is not in the future
  // relative to this report's normal T+2 account-side boundary.
  const accountDateCeiling = shiftIsoDate(date, -2);
  const latestCompleteDate = latest?.latestCompleteDate && latest.latestCompleteDate < accountDateCeiling
    ? latest.latestCompleteDate
    : accountDateCeiling;
  return {
    runId: `prepared-report-recovery-${date}`,
    trigger: "scheduled",
    startedAt: zonedWallTimeToInstant(`${date} 17:35:00`, timeZone).toISOString(),
    completedAt: zonedWallTimeToInstant(`${date} 17:45:00`, timeZone).toISOString(),
    latestCompleteDate,
    orderAttributionTargetDate: shiftIsoDate(date, -1),
    windowStart: latestCompleteDate,
    windowEnd: latestCompleteDate,
    catalog: phase(),
    online: phase(),
    roi: phase(),
    accountSide: phase(),
    ok: true,
  };
}

function phase(): DailyPhaseResult {
  return {
    ok: true,
    matched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    conflicts: 0,
    missingItems: [],
    error: null,
  };
}

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
  return value || null;
}
