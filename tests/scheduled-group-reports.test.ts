import { describe, expect, it } from "vitest";
import type { DailyAutomationRun } from "../src/automation/daily-sync.js";
import type { DailyGroupReportResult } from "../src/bot/daily-group-report.js";
import type { PeriodicGroupReportResult } from "../src/bot/periodic-group-report.js";
import { ScheduledGroupReportService } from "../src/bot/scheduled-group-reports.js";

describe("scheduled group report queue", () => {
  it("attempts periodic reports after a daily failure", async () => {
    const order: string[] = [];
    const daily = {
      start: async () => skippedDaily(),
      handleRun: async () => {
        order.push("daily");
        throw new Error("daily failed");
      },
    };
    const periodic = {
      start: async () => skippedPeriodic(),
      handleRun: async () => {
        order.push("periodic");
        return skippedPeriodic();
      },
    };
    const service = new ScheduledGroupReportService(daily, periodic);
    const result = await service.handleRun(run("a"));

    expect(order).toEqual(["daily", "periodic"]);
    expect(result.daily.ok).toBe(false);
    expect(result.periodic.ok).toBe(true);
  });

  it("serializes concurrent startup/run requests within the same tenant", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let first = true;
    const daily = {
      start: async () => skippedDaily(),
      handleRun: async (current: DailyAutomationRun) => {
        order.push(`daily-${current.runId}`);
        if (first) {
          first = false;
          await gate;
        }
        return skippedDaily();
      },
    };
    const periodic = {
      start: async () => skippedPeriodic(),
      handleRun: async (current: DailyAutomationRun) => {
        order.push(`periodic-${current.runId}`);
        return skippedPeriodic();
      },
    };
    const service = new ScheduledGroupReportService(daily, periodic);
    const firstRun = service.handleRun(run("a"));
    const secondRun = service.handleRun(run("b"));
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["daily-a"]);
    releaseFirst();
    await Promise.all([firstRun, secondRun]);
    expect(order).toEqual(["daily-a", "periodic-a", "daily-b", "periodic-b"]);
  });
});

function skippedDaily(): DailyGroupReportResult {
  return { skipped: true, reason: "test", report: null, deliveries: [] };
}

function skippedPeriodic(): PeriodicGroupReportResult {
  return { skipped: true, reason: "test", reports: [], deliveries: [] };
}

function run(id: string): DailyAutomationRun {
  return {
    runId: id,
    trigger: "scheduled",
    startedAt: "2026-06-01T09:55:00.000Z",
    completedAt: "2026-06-01T10:00:00.000Z",
    latestCompleteDate: "2026-05-30",
    orderAttributionTargetDate: "2026-05-31",
    windowStart: "2026-05-30",
    windowEnd: "2026-05-30",
    catalog: phase(),
    online: phase(),
    roi: phase(),
    ok: true,
  };
}

function phase() {
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
