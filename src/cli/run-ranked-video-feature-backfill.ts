import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";
import path from "node:path";
import { isVideoAnalysisSafetyWindow } from "../automation/report-priority.js";
import { VIDEO_ANALYSIS_MODEL } from "../video-analysis/model-policy.js";
import { videoPendingRetryClock, videoWorkerCapacity } from "../video-analysis/runtime-policy.js";
import { realtimePriorityActive } from "../video-analysis/realtime-policy.js";
import { loadLiveStoreVideoInventory, type VideoAnalysisTenantId } from "../video-analysis/storeone-source.js";

// One finite, user-requested backfill. Does not enable any recurring schedule.
if (!process.argv.includes("--confirm=RANKED-VIDEO-BACKFILL")) throw new Error("Confirmation required");
const root = path.resolve(".runtime/video-analysis-global");
const followRetries = process.argv.includes("--follow-retries");
const pendingAuditFlag = process.argv.indexOf("--pending-audit");
const knownPending = new Map<VideoAnalysisTenantId, Array<{ tableId: string; videoId: string }>>();
if (pendingAuditFlag >= 0) {
  if (!followRetries || !process.argv[pendingAuditFlag + 1]) throw new Error("--pending-audit requires --follow-retries and a saved formal audit");
  const prior = JSON.parse(readFileSync(path.resolve(process.argv[pendingAuditFlag + 1]), "utf8"));
  for (const store of prior.result) {
    if (!["storeone-formal", "storetwo-formal", "storethree-formal", "storetwo-llc-formal", "storetwo-botanical-care-formal"].includes(store.tenant)) throw new Error("Unexpected pending audit tenant");
    for (const candidate of store.remaining) {
      if (!/^tbl\w+$/.test(candidate.tableId) || !/^\d{19}$/.test(candidate.videoId)) throw new Error("Unexpected pending audit business key");
    }
    knownPending.set(store.tenant, store.remaining);
  }
}
mkdirSync(root, { recursive: true });
const lock = path.join(root, "backfill.lock");
const stateFile = path.join(root, "ranked-feature-backfill.json");
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
if (existsSync(lock)) {
  const prior = JSON.parse(readFileSync(lock, "utf8"));
  if (!Number.isSafeInteger(prior.pid) || alive(prior.pid)) throw new Error("Another backfill owns the lock");
  renameSync(lock, `${lock}.stale-${Date.now()}`);
}
const audit = JSON.parse(readFileSync(".runtime/video-feature-parity-2026-09-29/audit.json", "utf8"));
const ranked: Array<{ tenant: VideoAnalysisTenantId; rows: number }> = audit.result
  .filter((s: any) => s.id !== "storeone-formal")
  .map((s: any) => ({ tenant: s.id, rows: s.tables.reduce((n: number, t: any) => n + t.count, 0) }))
  .sort((a: any, b: any) => b.rows - a.rows);
if (process.argv.includes("--include-storeone-first")) {
  const storeone = audit.result.find((s: any) => s.id === "storeone-formal");
  if (!storeone) throw new Error("STOREONE missing from formal video audit");
  ranked.unshift({ tenant: "storeone-formal", rows: storeone.tables.reduce((n: number, t: any) => n + t.count, 0) });
}
const allTenants = [...ranked.map(x => x.tenant), "storeone-formal"];
writeFileSync(lock, JSON.stringify({ pid: process.pid, mode: "one-off-ranked-medium-fast", at: new Date().toISOString() }), { flag: "wx" });
const state: any = { pid: process.pid, mode: "one-off", model: VIDEO_ANALYSIS_MODEL, ranked,
  status: "starting", followRetries, pendingAudit: pendingAuditFlag >= 0 ? process.argv[pendingAuditFlag + 1] : null,
  active: [], batches: [], finalInventory: {}, written: 0, reserveGiB: 4, concurrency: 2 };
function save() {
  state.at = new Date().toISOString();
  const temp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2));
  renameSync(temp, stateFile);
}
function blocked(): boolean {
  if (realtimePriorityActive()) return true;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const minute = Number(parts.find(p => p.type === "hour")?.value) * 60 + Number(parts.find(p => p.type === "minute")?.value);
  if (isVideoAnalysisSafetyWindow(minute) || existsSync(".runtime/bot-control/maintenance.pause")) return true;
  return allTenants.some(tenant => {
    const file = `.runtime/tenants/${tenant}/daily-automation/status.json`;
    return !existsSync(file) || JSON.parse(readFileSync(file, "utf8")).running === true;
  });
}
async function safeWindow(): Promise<void> {
  while (blocked() || videoWorkerCapacity(freemem()) < 1) {
    state.status = "waiting_for_business_window_or_4GiB_reserve"; save();
    await new Promise(resolve => setTimeout(resolve, 30_000));
  }
}
function pendingClock(tenant: VideoAnalysisTenantId): { remaining: number; due: number; next: number } {
  const statuses = (knownPending.get(tenant) ?? []).map(candidate => {
    const file = path.resolve(`.runtime/${tenant.replace(/-formal$/, "")}-video-analysis/jobs/${candidate.tableId}-${candidate.videoId}/status.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  });
  return videoPendingRetryClock(statuses, Date.now());
}
async function waitForPendingDue(): Promise<boolean> {
  while (true) {
    const clocks = [...knownPending.keys()].map(pendingClock);
    if (clocks.some(clock => clock.due > 0)) return true;
    if (clocks.every(clock => clock.remaining === 0)) return false;
    const next = Math.min(...clocks.map(clock => clock.next));
    const nextAt = Number.isFinite(next) ? new Date(next).toISOString() : null;
    if (state.status !== "waiting_for_native_retry" || state.nextRetryAt !== nextAt) {
      state.status = "waiting_for_native_retry";
      state.active = [];
      state.fullCompletion = false;
      state.nextRetryAt = nextAt;
      state.waitingScope = "local saved pending keys; no API/media/model requests while cooling";
      save();
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(60_000, Math.max(1000, next - Date.now()))));
  }
}
async function batch(tenant: VideoAnalysisTenantId, scope: string, shard: number, pass: number, freshOnly = false): Promise<any> {
  const args = ["--import", "tsx", "src/cli/run-storeone-video-analysis.ts", "--tenant", tenant,
    "--table", scope, "--max-videos", "50", "--max-candidates", "300", "--shard-index", String(shard), "--shard-count", "2", "--retry-model"];
  if (freshOnly) args.push("--fresh-only");
  if (!freshOnly && pass === 0 && process.argv.includes("--retry-held-once")) args.push("--retry-media", "--retry-review", "--retry-evidence");
  const started = Date.now();
  const exit = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), windowsHide: true, stdio: "inherit" });
    child.on("error", reject); child.on("close", code => resolve(code ?? 1));
  });
  const reportFile = `.runtime/${tenant.replace(/-formal$/, "")}-video-analysis/latest-shard-${shard}-of-2.json`;
  if (!existsSync(reportFile)) throw new Error(`${tenant} shard ${shard} did not save a receipt`);
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  if (Date.parse(report.at) < started - 5000 || report.tenantId !== tenant || report.tableScope !== scope) throw new Error("Stale/mismatched worker receipt");
  const result = { tenant, scope, shard, pass, freshOnly, exit, at: report.at, runDir: report.runDir,
    written: report.receipts.filter((r: any) => r.outcome === "WRITTEN").length,
    stopReason: report.stopReason, fatal: report.fatal === true };
  state.written += result.written; state.batches.push(result); save();
  return result;
}
try {
  if (pendingAuditFlag >= 0) await waitForPendingDue();
  do {
  for (const { tenant } of ranked) {
    if (followRetries && knownPending.has(tenant) && pendingClock(tenant).due === 0) continue;
    for (const freshOnly of process.argv.includes("--fresh-first") ? [true, false] : [false]) {
    for (const scope of ["online", "account"]) {
      for (let pass = 0; pass < 6; pass++) {
        await safeWindow();
        state.status = "running"; state.active = [{ tenant, scope, shards: 2, freshOnly }]; save();
        const settled = videoWorkerCapacity(freemem()) >= 2
          ? await Promise.allSettled([batch(tenant, scope, 0, pass, freshOnly), batch(tenant, scope, 1, pass, freshOnly)])
          : [await Promise.resolve(batch(tenant, scope, 0, pass, freshOnly)).then(
              value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason })),
            await Promise.resolve(batch(tenant, scope, 1, pass, freshOnly)).then(
              value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }))];
        state.active = []; save();
        const failures = settled.filter(r => r.status === "rejected");
        if (failures.length) throw new Error(failures.map(r => String((r as PromiseRejectedResult).reason)).join("; "));
        const results = settled.map(r => (r as PromiseFulfilledResult<any>).value);
        if (results.some(r => r.fatal || r.exit === 1)) throw new Error(results.map(r => r.stopReason).join("; "));
        if (results.some(r => r.exit === 2)) { pass--; continue; }
        if (results.every(r => r.written === 0)) break;
      }
    }
    }
    await safeWindow();
    const { inventory } = await loadLiveStoreVideoInventory(tenant);
    knownPending.set(tenant, inventory.pending.map(candidate => ({ tableId: candidate.tableId, videoId: candidate.videoId })));
    const pendingStatus = inventory.pending.map(candidate => {
      const file = path.resolve(`.runtime/${tenant.replace(/-formal$/, "")}-video-analysis/jobs/${candidate.tableId}-${candidate.videoId}/status.json`);
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    });
    const futureRetries = pendingStatus.map(s => s.retryAfter).filter(at => typeof at === "string" && Date.parse(at) > Date.now()).sort();
    state.finalInventory[tenant] = { complete: inventory.completeRows, pending: inventory.pending.length,
      invalid: inventory.invalid.length, partial: inventory.partial.length, duplicates: inventory.duplicates.length,
      nextRetryAt: futureRetries[0] ?? null };
    save();
  }
  } while (followRetries && await waitForPendingDue());
  // A terminal completion claim always uses a current formal read of every store, never local statuses alone.
  if (followRetries) {
    await safeWindow();
    for (const { tenant } of ranked) {
      const { inventory } = await loadLiveStoreVideoInventory(tenant);
      state.finalInventory[tenant] = { complete: inventory.completeRows, pending: inventory.pending.length,
        invalid: inventory.invalid.length, partial: inventory.partial.length, duplicates: inventory.duplicates.length };
    }
  }
  const totals = Object.values(state.finalInventory).reduce((sum: any, store: any) => ({
    pending: sum.pending + store.pending, invalid: sum.invalid + store.invalid,
    partial: sum.partial + store.partial, duplicates: sum.duplicates + store.duplicates,
  }), { pending: 0, invalid: 0, partial: 0, duplicates: 0 }) as any;
  state.remaining = totals;
  state.fullCompletion = Object.values(totals).every(n => n === 0);
  state.status = totals.pending > 0 ? "waiting_for_retry_or_source_evidence"
    : state.fullCompletion ? "formal_inventory_complete" : "source_gaps_or_review_remain";
  save();
} catch (error) {
  state.status = "blocked"; state.error = String(error); save(); process.exitCode = 1;
} finally {
  if (existsSync(lock) && JSON.parse(readFileSync(lock, "utf8")).pid === process.pid) unlinkSync(lock);
}
