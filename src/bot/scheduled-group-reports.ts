import type { DailyAutomationRun } from "../automation/daily-sync.js";
import type { DailyGroupReportResult } from "./daily-group-report.js";
import type { PeriodicGroupReportResult } from "./periodic-group-report.js";

interface ReportService<Result> {
  start(lastAutomaticRun: DailyAutomationRun | null): Promise<Result>;
  handleRun(run: DailyAutomationRun): Promise<Result>;
}

export interface ScheduledGroupReportOutcome<Result> {
  ok: boolean;
  result: Result | null;
  error: unknown;
}

export interface ScheduledGroupReportBatch {
  daily: ScheduledGroupReportOutcome<DailyGroupReportResult>;
  periodic: ScheduledGroupReportOutcome<PeriodicGroupReportResult>;
}

/**
 * A tenant owns one report queue. Daily is always attempted first; weekly and
 * monthly are then handled by the periodic service in that order. One failed
 * report remains pending but never prevents the other due reports from being
 * attempted, and startup recovery cannot race a newly completed scheduled run.
 */
export class ScheduledGroupReportService {
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly daily: ReportService<DailyGroupReportResult>,
    private readonly periodic: ReportService<PeriodicGroupReportResult>,
  ) {}

  public start(lastAutomaticRun: DailyAutomationRun | null): Promise<ScheduledGroupReportBatch> {
    return this.serial(async () => this.execute(
      () => this.daily.start(lastAutomaticRun),
      () => this.periodic.start(lastAutomaticRun),
    ));
  }

  public handleRun(run: DailyAutomationRun): Promise<ScheduledGroupReportBatch> {
    return this.serial(async () => this.execute(
      () => this.daily.handleRun(run),
      () => this.periodic.handleRun(run),
    ));
  }

  private async execute(
    daily: () => Promise<DailyGroupReportResult>,
    periodic: () => Promise<PeriodicGroupReportResult>,
  ): Promise<ScheduledGroupReportBatch> {
    const dailyOutcome = await settled(daily);
    const periodicOutcome = await settled(periodic);
    return { daily: dailyOutcome, periodic: periodicOutcome };
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

async function settled<Result>(
  operation: () => Promise<Result>,
): Promise<ScheduledGroupReportOutcome<Result>> {
  try {
    return { ok: true, result: await operation(), error: null };
  } catch (error) {
    return { ok: false, result: null, error };
  }
}
