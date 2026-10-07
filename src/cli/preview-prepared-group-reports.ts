import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createModelProvider } from "../ai/providers.js";
import type { DailyAutomationRun, DailyPhaseResult } from "../automation/daily-sync.js";
import { loadDailyReportPaidSnapshot } from "../bot/daily-report-paid-snapshot.js";
import { loadPeriodicReportPaidSnapshot } from "../bot/periodic-report-paid-snapshot.js";
import { PreparedGroupReportService } from "../bot/prepared-group-reports.js";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";
import { FeishuBitableDataSource } from "../feishu/data-source.js";
import { dateKeyInTimeZone, shiftIsoDate, zonedWallTimeToInstant } from "../realtime/business-time.js";

const registry = new TenantRegistry(getEnv());
const sendDate = argument("--send-date")
  ?? dateKeyInTimeZone(new Date(), "Asia/Shanghai");
const tenantId = argument("--tenant");
const selectedTenant = tenantId ? registry.byId(tenantId) : null;
if (tenantId && !selectedTenant) throw new Error(`店铺租户不存在或未启用：${tenantId}`);
const rows = [];
for (const tenant of selectedTenant ? [selectedTenant] : registry.all()) {
  const status = await readStatus(tenant.binding.id);
  const run = previewRun(sendDate, tenant.profile.businessTimeZone, status);
  const service = new PreparedGroupReportService({
    tenantId: tenant.binding.id,
    profile: tenant.profile,
    dataSource: new FeishuBitableDataSource(
      tenant.env,
      createFeishuClient(tenant.env),
      tenant.profile,
    ),
    provider: createModelProvider(tenant.env),
    groupChatIds: [],
    sendCard: async () => { throw new Error("只读预览禁止调用飞书消息发送接口"); },
    loadDailyPaidSnapshot: (date) => loadDailyReportPaidSnapshot(tenant.profile, date),
    loadPeriodicPaidSnapshot: (startDate, endDate) => (
      loadPeriodicReportPaidSnapshot(tenant.profile, startDate, endDate)
    ),
  });
  const result = await service.previewRun(run);
  rows.push({
    tenantId: tenant.binding.id,
    store: tenant.profile.businessDisplayName,
    sendDate,
    errors: result.errors,
    reports: result.reports.map((report) => ({
      reportKey: report.reportKey,
      audience: report.audience,
      kind: report.kind,
      sourcePeriod: `${report.sourceStartDate}..${report.sourceEndDate}`,
      dataReadOk: report.dataReadOk,
      dataComplete: report.dataComplete,
      atAllPresent: JSON.stringify(report.card).includes("<at id=all></at>"),
      text: report.text,
    })),
  });
}

const evidence = {
  ok: rows.every((row) => row.errors.length === 0),
  evidence: "真实正式Base + 必要时TikTok只读兜底 + 当前DeepSeek；未调用飞书消息发送接口，未写Base",
  checkedAt: new Date().toISOString(),
  sendDate,
  rows,
};
const output = argument("--output");
if (output) {
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(path.resolve(output), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify(evidence, null, 2));

async function readStatus(tenantId: string): Promise<{ lastAutomaticRun?: DailyAutomationRun; lastRun?: DailyAutomationRun }> {
  const file = path.resolve(".runtime", "tenants", tenantId, "daily-automation", "status.json");
  return JSON.parse(await readFile(file, "utf8"));
}

function previewRun(
  date: string,
  timeZone: string,
  status: { lastAutomaticRun?: DailyAutomationRun; lastRun?: DailyAutomationRun },
): DailyAutomationRun {
  const latest = status.lastAutomaticRun ?? status.lastRun;
  return {
    runId: `readonly-prepared-preview-${date}`,
    trigger: "scheduled",
    startedAt: zonedWallTimeToInstant(`${date} 17:35:00`, timeZone).toISOString(),
    completedAt: zonedWallTimeToInstant(`${date} 17:45:00`, timeZone).toISOString(),
    latestCompleteDate: latest?.latestCompleteDate ?? shiftIsoDate(date, -2),
    orderAttributionTargetDate: shiftIsoDate(date, -1),
    windowStart: latest?.windowStart ?? shiftIsoDate(date, -2),
    windowEnd: latest?.windowEnd ?? shiftIsoDate(date, -2),
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

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
  return value || null;
}
