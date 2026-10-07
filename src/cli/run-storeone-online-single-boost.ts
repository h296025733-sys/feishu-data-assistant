import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { VIDEO_ANALYSIS_MODEL } from "../video-analysis/model-policy.js";

const globalRoot = path.resolve(".runtime/video-analysis-global");
const tenantRoot = path.resolve(".runtime/storeone-video-analysis");
mkdirSync(globalRoot, { recursive: true });
const lockFile = path.join(globalRoot, "storeone-online-single-boost.lock");
const stateFile = path.join(globalRoot, "storeone-online-single-boost.json");
let status = "starting";
let totalWritten = 0;
let lastReason = "";

function alive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) < 1) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
function lockActive(file: string): boolean {
  if (!existsSync(file)) return false;
  try { return alive(JSON.parse(readFileSync(file, "utf8")).pid); } catch { return true; }
}
function anyRunnerActive(): boolean {
  if (lockActive(path.join(tenantRoot, "runner.lock"))) return true;
  return readdirSync(tenantRoot).some((name) => /^runner-shard-\d+-of-\d+\.lock$/.test(name)
    && lockActive(path.join(tenantRoot, name)));
}
function report(): void {
  const temp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ at: new Date().toISOString(), pid: process.pid,
    status, totalWritten, lastReason, tableScope: "online",
    model: VIDEO_ANALYSIS_MODEL, concurrency: 1,
  }, null, 2));
  renameSync(temp, stateFile);
}
function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function runBatch(retryMedia: boolean): Promise<number> {
  return await new Promise((resolve, reject) => {
    const args = ["--import", "tsx", "src/cli/run-storeone-video-analysis.ts",
      "--tenant", "storeone-formal", "--table", "online", "--max-videos", "50",
      "--max-candidates", "300", "--retry-model"];
    if (retryMedia) args.push("--retry-media");
    const child = spawn(process.execPath, args, { cwd: process.cwd(), windowsHide: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

if (lockActive(lockFile)) throw new Error("STOREONE single boost already running");
if (existsSync(lockFile)) renameSync(lockFile, `${lockFile}.stale-${Date.now()}.json`);
writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
try {
  while (anyRunnerActive()) {
    status = "waiting_for_existing_storeone_runner";
    report();
    await wait(10_000);
  }
  let firstBatch = true;
  while (true) {
    status = "running_online_single";
    report();
    const startedAt = Date.now();
    const exitCode = await runBatch(firstBatch);
    firstBatch = false;
    const latestFile = path.join(tenantRoot, "latest.json");
    const latest = JSON.parse(readFileSync(latestFile, "utf8")) as {
      at?: string; tableScope?: string; stopReason?: string; fatal?: boolean;
      model?: { name?: string; reasoning?: string; fast?: boolean };
      receipts?: Array<{ outcome: string }>;
    };
    if (!latest.at || Date.parse(latest.at) < startedAt - 5_000 || latest.tableScope !== "online") {
      throw new Error("STOREONE single boost report stale or wrong scope");
    }
    const written = latest.receipts?.filter((receipt) => receipt.outcome === "WRITTEN").length ?? 0;
    totalWritten += written;
    lastReason = `${latest.stopReason}; written=${written}; exit=${exitCode}; `
      + `model=${latest.model?.name}/${latest.model?.reasoning}/fast=${latest.model?.fast}`;
    status = "batch_completed";
    report();
    if (latest.fatal || exitCode === 1) throw new Error(lastReason);
    if (exitCode === 2) {
      await wait(60_000);
      continue;
    }
    if (written === 0) break;
  }
  status = "storeone_online_single_drained_or_blocked";
  report();
} catch (error) {
  lastReason = error instanceof Error ? error.message : String(error);
  status = "storeone_online_single_error";
  report();
  process.exitCode = 1;
} finally {
  if (existsSync(lockFile)) {
    const owner = JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: number };
    if (owner.pid === process.pid) unlinkSync(lockFile);
  }
}
