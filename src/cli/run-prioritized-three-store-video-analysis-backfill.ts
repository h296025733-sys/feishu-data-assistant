import { spawn } from "node:child_process";
import { isVideoAnalysisSafetyWindow } from "../automation/report-priority.js";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { freemem } from "node:os";
import { withFeishuRetry } from "../feishu/client.js";
import { loadLiveStoreVideoInventory, videoAnalysisConfig } from "../video-analysis/storeone-source.js";
import { inspectOnlinePhase } from "../video-analysis/online-phase-gate.js";
import { VIDEO_ANALYSIS_MODEL } from "../video-analysis/model-policy.js";
import { videoWorkerCapacity } from "../video-analysis/runtime-policy.js";

type Tenant = "storeone-formal" | "storetwo-formal" | "storetwo-botanical-care-formal";
type TableScope = "online" | "account";
type Worker = { tenant: Tenant; shardIndex?: number; shardCount?: number };

const root = path.resolve(".runtime/video-analysis-global");
mkdirSync(root, { recursive: true });
const lockFile = path.join(root, "backfill.lock");
const stateFile = path.join(root, "priority-backfill.json");
const workers: Worker[] = [
  { tenant: "storeone-formal" },
  { tenant: "storetwo-formal", shardIndex: 0, shardCount: 2 },
  { tenant: "storetwo-formal", shardIndex: 1, shardCount: 2 },
  { tenant: "storetwo-botanical-care-formal" },
];
const active = new Set<string>();
const totals: Record<TableScope, Record<Tenant, number>> = {
  online: { "storeone-formal": 0, "storetwo-formal": 0, "storetwo-botanical-care-formal": 0 },
  account: { "storeone-formal": 0, "storetwo-formal": 0, "storetwo-botanical-care-formal": 0 },
};
let phase: TableScope = "online";
let status = "starting";
let lastReason = "";

function alive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) < 1) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
function lockActive(file: string): boolean {
  if (!existsSync(file)) return false;
  try { return alive(JSON.parse(readFileSync(file, "utf8")).pid); } catch { return true; }
}
function workerName(worker: Worker): string {
  return worker.shardCount && worker.shardCount > 1
    ? `${worker.tenant}#${worker.shardIndex}/${worker.shardCount}` : worker.tenant;
}
function tenantRoot(tenant: Tenant): string {
  return path.resolve(`.runtime/${tenant.replace(/-formal$/, "")}-video-analysis`);
}
function runnerLock(worker: Worker): string {
  const name = worker.shardCount && worker.shardCount > 1
    ? `runner-shard-${worker.shardIndex}-of-${worker.shardCount}.lock` : "runner.lock";
  return path.join(tenantRoot(worker.tenant), name);
}
function latestPath(worker: Worker): string {
  const name = worker.shardCount && worker.shardCount > 1
    ? `latest-shard-${worker.shardIndex}-of-${worker.shardCount}.json` : "latest.json";
  return path.join(tenantRoot(worker.tenant), name);
}
function report(): void {
  const temp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ at: new Date().toISOString(), pid: process.pid,
    status, phase, active: [...active], totals, lastReason,
    model: VIDEO_ANALYSIS_MODEL,
    concurrency: { total: 4, storeone: 1, storetwo: 2, botanical: 1 },
    memory: { freeGiB: freemem() / 1024 ** 3, admittedCapacity: videoWorkerCapacity(freemem()), reserveGiB: 4 },
  }, null, 2));
  renameSync(temp, stateFile);
}
function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function beijingMinute(): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai",
    hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === "hour")?.value) * 60
    + Number(parts.find((part) => part.type === "minute")?.value);
}
function dailySyncBusy(): boolean {
  const minute = beijingMinute();
  if (isVideoAnalysisSafetyWindow(minute)) return true;
  if (existsSync(path.resolve(".runtime/bot-control/maintenance.pause"))) return true;
  for (const tenant of ["storetwo-formal", "storeone-formal", "storethree-formal",
    "storetwo-llc-formal", "storetwo-botanical-care-formal"]) {
    const file = path.resolve(`.runtime/tenants/${tenant}/daily-automation/status.json`);
    if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).running === true) return true;
  }
  return false;
}
async function runBatch(worker: Worker, scope: TableScope, retryMedia: boolean,
  retryReview = false): Promise<number> {
  return await new Promise((resolve, reject) => {
    const args = ["--import", "tsx", "src/cli/run-storeone-video-analysis.ts",
      "--tenant", worker.tenant, "--table", scope,
      "--max-videos", "50", "--max-candidates", "300", "--retry-model"];
    if (retryMedia) args.push("--retry-media");
    if (retryReview) args.push("--retry-review", "--retry-evidence", "--only-retries");
    if (worker.shardCount && worker.shardCount > 1) {
      args.push("--shard-index", String(worker.shardIndex), "--shard-count", String(worker.shardCount));
    }
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(), windowsHide: true, stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
async function runWorker(worker: Worker, scope: TableScope): Promise<void> {
  const name = workerName(worker);
  let transientFailures = 0;
  let readFailures = 0;
  // Do not bypass media cooldown again each time a supervisor is recovered.
  let firstBatch = process.argv.includes("--retry-media-once");
  let reviewPasses = 0;
  let reviewOnly = false;
  while (true) {
    while (dailySyncBusy() || lockActive(runnerLock(worker))
      || active.size >= videoWorkerCapacity(freemem())) {
      status = active.size >= videoWorkerCapacity(freemem())
        ? "waiting_for_memory_capacity" : "waiting_for_safe_window_or_lock";
      report();
      await wait(30_000);
    }
    active.add(name);
    status = `running_${scope}`;
    report();
    const startedAt = Date.now();
    const exitCode = await runBatch(worker, scope, firstBatch, reviewOnly)
      .finally(() => active.delete(name));
    firstBatch = false;
    const latestFile = latestPath(worker);
    if (!existsSync(latestFile)) throw new Error(`${name} did not write a report`);
    const latest = JSON.parse(readFileSync(latestFile, "utf8")) as {
      at?: string; stopReason?: string; fatal?: boolean; tableScope?: string;
      retryableReadFailure?: boolean;
      model?: { name?: string; reasoning?: string; fast?: boolean };
      receipts?: Array<{ outcome: string }>;
    };
    if (!latest.at || Date.parse(latest.at) < startedAt - 5_000 || latest.tableScope !== scope) {
      throw new Error(`${name} wrote a stale or wrong-scope report`);
    }
    const written = latest.receipts?.filter((receipt) => receipt.outcome === "WRITTEN").length ?? 0;
    totals[scope][worker.tenant] += written;
    lastReason = `${name}/${scope}: ${latest.stopReason ?? "unknown"}; written=${written}; exit=${exitCode}; `
      + `model=${latest.model?.name}/${latest.model?.reasoning}/fast=${latest.model?.fast}`;
    active.delete(name);
    status = `batch_completed_${scope}`;
    report();
    if (latest.fatal && latest.retryableReadFailure && readFailures < 3) {
      readFailures++;
      status = "waiting_after_transient_read_error";
      report();
      await wait(readFailures * 30_000);
      continue;
    }
    if (!latest.fatal) readFailures = 0;
    if (/unavailable|capacity|quota|rate limit|99991403|\b429\b/i.test(lastReason)) {
      transientFailures++;
      status = "waiting_after_external_limit";
      report();
      await wait(Math.min(15, transientFailures * 5) * 60_000);
      continue;
    }
    if (latest.fatal || exitCode === 1) throw new Error(lastReason);
    transientFailures = 0;
    if (exitCode === 2) {
      await wait(60_000);
      continue;
    }
    if (reviewOnly) reviewPasses++;
    if (written === 0 || reviewOnly) {
      // Ordinary read/write and timing validation holds must be retried at the
      // batch boundary, not silently classified as inaccessible videos.
      if (scope === "online" && reviewPasses < 2) {
        reviewOnly = true;
        continue;
      }
      return;
    }
  }
}

async function runPhase(scope: TableScope): Promise<void> {
  // Retain the supervisor lock until ALL children settle, even if one fails.
  const results = await Promise.allSettled(workers.map(worker => runWorker(worker, scope)));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) throw new Error(failures.map(result => String(result.reason)).join("; "));
}

async function verifyOnlinePhase(): Promise<void> {
  while (dailySyncBusy()) {
    status = "waiting_for_safe_window_before_online_gate";
    report();
    await wait(30_000);
  }
  const evidence: Record<string, unknown> = {};
  const blocked: string[] = [];
  for (const tenant of [...new Set(workers.map(worker => worker.tenant))]) {
    const { inventory } = await withFeishuRetry(() => loadLiveStoreVideoInventory(tenant),
      { attempts: 3, baseDelayMs: 2000 });
    const decision = inspectOnlinePhase(inventory, videoAnalysisConfig(tenant).tables.online, key => {
      const file = path.join(tenantRoot(tenant), "jobs", key.replace(":", "-"), "status.json");
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).state : undefined;
    });
    evidence[tenant] = decision;
    blocked.push(...decision.blocked.map(item => `${tenant}/${item.key}: ${item.reason}`));
  }
  writeFileSync(path.join(root, "online-phase-gate.json"), JSON.stringify({
    at: new Date().toISOString(), evidence, ready: blocked.length === 0,
  }, null, 2));
  if (blocked.length) throw new Error(`Online phase still requires review; account phase not started: ${blocked.join("; ")}`);
}

if (lockActive(lockFile)) throw new Error("Video-analysis backlog supervisor is already running");
if (existsSync(lockFile)) renameSync(lockFile, path.join(root, `backfill.stale-${Date.now()}.json`));
writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(),
  mode: "online-first-sol-high-standard" }), { flag: "wx" });
try {
  status = "running_online_priority";
  report();
  await runPhase("online");
  await verifyOnlinePhase();
  phase = "account";
  status = "running_account_after_all_online";
  report();
  await runPhase("account");
  status = "backlog_drained_or_items_need_review";
  report();
} catch (error) {
  lastReason = error instanceof Error ? error.message : String(error);
  status = "stopped_supervisor_error";
  report();
  process.exitCode = 1;
} finally {
  if (existsSync(lockFile)) {
    const owner = JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: number };
    if (owner.pid === process.pid) unlinkSync(lockFile);
  }
}
