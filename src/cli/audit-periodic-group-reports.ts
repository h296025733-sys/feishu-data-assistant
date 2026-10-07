import type { DailyAutomationRun, DailyPhaseResult } from "../automation/daily-sync.js";
import { createModelProvider } from "../ai/providers.js";
import { loadPeriodicReportPaidSnapshot } from "../bot/periodic-report-paid-snapshot.js";
import {
  buildPeriodicGroupReport,
  periodForKind,
} from "../bot/periodic-group-report.js";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";
import { FeishuBitableDataSource } from "../feishu/data-source.js";
import {
  dateKeyInTimeZone,
  shiftIsoDate,
  zonedWallTimeToInstant,
} from "../realtime/business-time.js";

const registry = new TenantRegistry(getEnv());
const now = new Date();
const rows = [];
for (const tenant of registry.all()) {
  const today = dateKeyInTimeZone(now, tenant.profile.businessTimeZone);
  const client = createFeishuClient(tenant.env);
  const dataSource = new FeishuBitableDataSource(tenant.env, client, tenant.profile);
  const provider = createModelProvider(tenant.env);
  const reports = [];
  for (const kind of ["weekly", "monthly"] as const) {
    const sendDate = kind === "weekly" ? mondayOnOrBefore(today) : `${today.slice(0, 7)}-01`;
    const run = previewRun(sendDate, tenant.profile.businessTimeZone);
    const report = await buildPeriodicGroupReport({
      tenantId: tenant.binding.id,
      profile: tenant.profile,
      dataSource,
      provider,
      run,
      period: periodForKind(kind, sendDate),
      loadPaidSnapshot: (startDate, endDate) => (
        loadPeriodicReportPaidSnapshot(tenant.profile, startDate, endDate)
      ),
    });
    reports.push({
      kind,
      sendDate,
      period: `${report.startDate}..${report.endDate}`,
      reportKey: report.reportKey,
      dataReadOk: report.dataReadOk,
      dataComplete: report.dataComplete,
      dataReadError: report.dataReadError,
      deepSeekSelected: report.usedDeepSeekSelection,
      selectedHighlightIds: report.selectedHighlightIds,
      atAllPresent: JSON.stringify(report.card).includes("<at id=all></at>"),
      text: report.text,
    });
  }
  rows.push({
    tenantId: tenant.binding.id,
    store: tenant.profile.businessDisplayName,
    groupCount: registry.groupRoutesForTenant(tenant.binding.id).length,
    reports,
  });
}

console.log(JSON.stringify({
  ok: true,
  evidence: "真实正式Base、TikTok只读兜底及当前DeepSeek；未调用飞书消息发送接口，未写Base",
  checkedAt: new Date().toISOString(),
  rows,
}, null, 2));

function mondayOnOrBefore(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const distance = (weekday + 6) % 7;
  return shiftIsoDate(value, -distance);
}

function previewRun(sendDate: string, timeZone: string): DailyAutomationRun {
  const startedAt = zonedWallTimeToInstant(`${sendDate} 17:55:00`, timeZone).toISOString();
  const completedAt = zonedWallTimeToInstant(`${sendDate} 18:00:00`, timeZone).toISOString();
  return {
    runId: `readonly-periodic-preview-${sendDate}`,
    trigger: "scheduled",
    startedAt,
    completedAt,
    latestCompleteDate: shiftIsoDate(sendDate, -2),
    orderAttributionTargetDate: shiftIsoDate(sendDate, -1),
    windowStart: shiftIsoDate(sendDate, -2),
    windowEnd: shiftIsoDate(sendDate, -2),
    catalog: phase(),
    online: phase(),
    roi: phase(),
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
