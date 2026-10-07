import { spawn } from "node:child_process";
import { isVideoAnalysisSafetyWindow } from "../automation/report-priority.js";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { VIDEO_ANALYSIS_MODEL } from "../video-analysis/model-policy.js";

const globalRoot = path.resolve(".runtime/video-analysis-global");
const tenantRoot = path.resolve(".runtime/storeone-video-analysis");
mkdirSync(globalRoot, { recursive: true });
const lockFile = path.join(globalRoot, "storeone-online-boost.lock");
const stateFile = path.join(globalRoot, "storeone-online-boost.json");
const active = new Set<number>();
const totals = [0, 0];
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
function report(): void {
  const temp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ at: new Date().toISOString(), pid: process.pid,
    status, active: [...active], totals, lastReason, tableScope: "online",
    model: VIDEO_ANALYSIS_MODEL,
    concurrency: 2,
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
async function runBatch(shardIndex: number, retryMedia: boolean): Promise<number> {
  return await new Promise((resolve, reject) => {
    const args = ["--import", "tsx", "src/cli/run-storeone-video-analysis.ts",
      "--tenant", "storeone-formal", "--table", "online",
      "--max-videos", "50", "--max-candidates", "300", "--retry-model",
      "--shard-index", String(shardIndex), "--shard-count", "2"];
    if (retryMedia) args.push("--retry-media");
    const child = spawn(process.execPath, args, { cwd: process.cwd(), windowsHide: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
async function runShard(shardIndex: number): Promise<void> {
  const shardLock = path.join(tenantRoot, `runner-shard-${shardIndex}-of-2.lock`);
  let transientFailures = 0;
  let firstBatch = true;
  while (true) {
    while (dailySyncBusy() || lockActive(path.join(tenantRoot, "runner.lock")) || lockActive(shardLock)) {
      status = "waiting_for_unsharded_runner_or_safe_window";
      report();
      await wait(15_000);
    }
    active.add(shardIndex);
    status = "running_online_boost";
    report();
    const startedAt = Date.now();
    const exitCode = await runBatch(shardIndex, firstBatch);
    firstBatch = false;
    const latestFile = path.join(tenantRoot, `latest-shard-${shardIndex}-of-2.json`);
    if (!existsSync(latestFile)) throw new Error(`STOREONE shard ${shardIndex} wrote no report`);
    const latest = JSON.parse(readFileSync(latestFile, "utf8")) as {
      at?: string; tableScope?: string; stopReason?: string; fatal?: boolean;
      model?: { name?: string; reasoning?: string; fast?: boolean };
      receipts?: Array<{ outcome: string }>;
    };
    if (!latest.at || Date.parse(latest.at) < startedAt - 5_000 || latest.tableScope !== "online") {
      throw new Error(`STOREONE shard ${shardIndex} report stale or wrong scope`);
    }
    const written = latest.receipts?.filter((receipt) => receipt.outcome === "WRITTEN").length ?? 0;
    totals[shardIndex] += written;
    lastReason = `shard ${shardIndex}: ${latest.stopReason}; written=${written}; exit=${exitCode}; `
      + `model=${latest.model?.name}/${latest.model?.reasoning}/fast=${latest.model?.fast}`;
    active.delete(shardIndex);
    status = "online_boost_batch_completed";
    report();
    if (/capacity|quota|rate limit|99991403|\b429\b/i.test(lastReason)) {
      transientFailures++;
      await wait(Math.min(15, transientFailures * 5) * 60_000);
      continue;
    }
    if (latest.fatal || exitCode === 1) throw new Error(lastReason);
    transientFailures = 0;
    if (exitCode === 2) {
      await wait(60_000);
      continue;
    }
    if (written === 0) return;
  }
}

if (lockActive(lockFile)) throw new Error("STOREONE online boost already running");
if (existsSync(lockFile)) renameSync(lockFile, `${lockFile}.stale-${Date.now()}.json`);
writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
try {
  status = "waiting_for_current_storeone_runner";
  report();
  await Promise.all([runShard(0), runShard(1)]);
  status = "storeone_online_boost_drained_or_blocked";
  report();
} catch (error) {
  lastReason = error instanceof Error ? error.message : String(error);
  status = "storeone_online_boost_error";
  report();
  process.exitCode = 1;
} finally {
  if (existsSync(lockFile)) {
    const owner = JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: number };
    if (owner.pid === process.pid) unlinkSync(lockFile);
  }
}
