import { spawn } from "node:child_process";
import { isVideoAnalysisSafetyWindow } from "../automation/report-priority.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";

// One-off backlog supervisor. The per-video runner still owns all media, model, Feishu,
// daily-sync, and protected-field checks. This only starts the next bounded batch.
const root = path.resolve(".runtime/video-analysis-global");
mkdirSync(root, { recursive: true });
const lockFile = path.join(root, "backfill.lock");
const stateFile = path.join(root, "backfill.json");
const tenants = ["storeone-formal", "storetwo-formal", "storetwo-botanical-care-formal"] as const;
type Tenant = typeof tenants[number];
const blocked = new Set<Tenant>();
const totals: Record<Tenant, number> = {
  "storeone-formal": 0,
  "storetwo-formal": 0,
  "storetwo-botanical-care-formal": 0,
};
let current: string | null = null;
const active = new Set<string>();
let lastReason = "";
let iterations = 0;

function alive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) < 1) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
function lockActive(file: string): boolean {
  if (!existsSync(file)) return false;
  try { return alive(JSON.parse(readFileSync(file, "utf8")).pid); }
  catch { return true; } // Ambiguous lock: fail closed instead of starting an overlapping writer.
}
function report(status: string): void {
  writeFileSync(stateFile, JSON.stringify({ at: new Date().toISOString(), pid: process.pid,
    status, current, active: [...active], blocked: [...blocked], totals, iterations, lastReason }, null, 2));
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
function tenantLockActive(tenant: Tenant, shardIndex?: number, shardCount?: number): boolean {
  const rootName = tenant.replace(/-formal$/, "");
  const name = shardCount && shardCount > 1
    ? `runner-shard-${shardIndex}-of-${shardCount}.lock` : "runner.lock";
  return lockActive(path.resolve(`.runtime/${rootName}-video-analysis/${name}`));
}
function latestPath(tenant: Tenant, shardIndex?: number, shardCount?: number): string {
  const name = shardCount && shardCount > 1
    ? `latest-shard-${shardIndex}-of-${shardCount}.json` : "latest.json";
  return path.resolve(`.runtime/${tenant.replace(/-formal$/, "")}-video-analysis/${name}`);
}
async function runBatch(tenant: Tenant, retryMedia: boolean,
  shardIndex?: number, shardCount?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const args = ["--import", "tsx", "src/cli/run-storeone-video-analysis.ts",
      "--tenant", tenant, "--max-videos", "50", "--max-candidates", "300", "--retry-model"];
    if (retryMedia) args.push("--retry-media");
    if (shardCount && shardCount > 1) {
      args.push("--shard-index", String(shardIndex), "--shard-count", String(shardCount));
    }
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(), windowsHide: true, stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

if (lockActive(lockFile)) throw new Error("Two-store backlog supervisor is already running");
if (existsSync(lockFile)) renameSync(lockFile, path.join(root, `backfill.stale-${Date.now()}.json`));
writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
try {
  report("waiting_for_existing_batches");
  async function runTenant(tenant: Tenant): Promise<void> {
    let firstBatch = true;
    let transientFailures = 0;
    while (!blocked.has(tenant)) {
      // Once the two small queues are finished, release the single Storetwo worker at a
      // batch boundary and replace it with three stable, non-overlapping shards.
      if (tenant === "storetwo-formal" && blocked.has("storeone-formal")
          && blocked.has("storetwo-botanical-care-formal")) return;
      while (dailySyncBusy() || tenantLockActive(tenant)) {
        report("waiting_for_safe_window_or_batch");
        await wait(30_000);
      }
      active.add(tenant);
    current = tenant;
    iterations++;
    report("running_batch");
    const startedAt = Date.now();
      const exitCode = await runBatch(tenant, firstBatch);
      firstBatch = false;
    const latestFile = latestPath(tenant);
    if (!existsSync(latestFile)) throw new Error(`${tenant} batch did not write a report`);
    const latest = JSON.parse(readFileSync(latestFile, "utf8")) as {
      at?: string; stopReason?: string; fatal?: boolean;
      receipts?: Array<{ outcome: string }>;
    };
    if (!latest.at || Date.parse(latest.at) < startedAt - 5_000) {
      throw new Error(`${tenant} batch report is stale`);
    }
    const written = latest.receipts?.filter((receipt) => receipt.outcome === "WRITTEN").length ?? 0;
    totals[tenant] += written;
    lastReason = `${tenant}: ${latest.stopReason ?? "unknown"}; written=${written}; exit=${exitCode}`;
      active.delete(tenant);
    report("batch_completed");
    if (/Sol\/high unavailable|quota|rate limit|99991403|\b429\b/i.test(lastReason)) {
        transientFailures++;
        report("waiting_after_external_limit");
        await wait(Math.min(15, transientFailures * 5) * 60_000);
        continue;
    }
    if (latest.fatal || exitCode === 1) {
        blocked.add(tenant);
        report("tenant_stopped_batch_error");
        return;
    }
      transientFailures = 0;
    if (exitCode === 2) {
      // A daily-sync/maintenance boundary is temporary, not an exhausted backlog.
      await wait(60_000);
    } else if (written === 0) {
      blocked.add(tenant); // No spin on invalid/unavailable material.
    }
    current = null;
    }
  }
  await Promise.all(tenants.map(runTenant));
  if (!blocked.has("storetwo-formal")) {
    const tenant: Tenant = "storetwo-formal";
    const shardCount = 3;
    report("transitioning_storetwo_to_three_shards");
    async function runShard(shardIndex: number): Promise<void> {
      const worker = `${tenant}#${shardIndex}/${shardCount}`;
      let firstBatch = true;
      let transientFailures = 0;
      while (true) {
        while (dailySyncBusy() || tenantLockActive(tenant, shardIndex, shardCount)) {
          report("waiting_for_safe_window_or_shard");
          await wait(30_000);
        }
        active.add(worker);
        current = worker;
        iterations++;
        report("running_sharded_batch");
        const startedAt = Date.now();
        const exitCode = await runBatch(tenant, firstBatch, shardIndex, shardCount);
        firstBatch = false;
        const latestFile = latestPath(tenant, shardIndex, shardCount);
        if (!existsSync(latestFile)) throw new Error(`${worker} batch did not write a report`);
        const latest = JSON.parse(readFileSync(latestFile, "utf8")) as {
          at?: string; stopReason?: string; fatal?: boolean;
          receipts?: Array<{ outcome: string }>;
        };
        if (!latest.at || Date.parse(latest.at) < startedAt - 5_000) {
          throw new Error(`${worker} batch report is stale`);
        }
        const written = latest.receipts?.filter((receipt) => receipt.outcome === "WRITTEN").length ?? 0;
        totals[tenant] += written;
        lastReason = `${worker}: ${latest.stopReason ?? "unknown"}; written=${written}; exit=${exitCode}`;
        active.delete(worker);
        report("sharded_batch_completed");
        if (/Sol\/high unavailable|quota|rate limit|99991403|\b429\b/i.test(lastReason)) {
          transientFailures++;
          report("waiting_after_external_limit");
          await wait(Math.min(15, transientFailures * 5) * 60_000);
          continue;
        }
        if (latest.fatal || exitCode === 1) {
          report("shard_stopped_batch_error");
          return;
        }
        transientFailures = 0;
        if (exitCode === 2) {
          await wait(60_000);
          continue;
        }
        if (written === 0) return;
      }
    }
    await Promise.all(Array.from({ length: shardCount }, (_, index) => runShard(index)));
    blocked.add(tenant);
  }
  if (blocked.size === tenants.length) report("backlog_drained_or_items_need_review");
} catch (error) {
  lastReason = error instanceof Error ? error.message : String(error);
  report("stopped_supervisor_error");
  process.exitCode = 1;
} finally {
  if (existsSync(lockFile)) {
    const owner = JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: number };
    if (owner.pid === process.pid) unlinkSync(lockFile);
  }
}
