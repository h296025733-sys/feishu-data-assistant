import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ANALYSIS_FIELDS } from "../video-analysis/storeone-inventory.js";
import { feishuErrorDetails, withFeishuRetry } from "../feishu/client.js";
import { loadLiveStoreVideoInventory, type VideoAnalysisTenantId } from
  "../video-analysis/storeone-source.js";

const flag = process.argv.indexOf("--tenant");
const selectedTenant = flag < 0 ? "storeone-formal" : process.argv[flag + 1];
if (selectedTenant !== "storeone-formal" && selectedTenant !== "storetwo-formal"
    && selectedTenant !== "storethree-formal" && selectedTenant !== "storetwo-llc-formal"
    && selectedTenant !== "storetwo-botanical-care-formal") {
  throw new Error("Unsupported video-analysis tenant");
}
const tenantId: VideoAnalysisTenantId = selectedTenant;
const scanStartedAt = Date.now();
const { tables, inventory } = await withFeishuRetry(() => loadLiveStoreVideoInventory(tenantId),
  { attempts: 3, baseDelayMs: 2000 }).catch((error: unknown) => {
  // Axios errors contain authentication headers. Report the native code/message,
  // never dump the request object when a read-only audit fails.
  console.error(JSON.stringify({ at: new Date().toISOString(), tenantId,
    evidence: "Formal read-only scan failed before completion", error: feishuErrorDetails(error) }, null, 2));
  process.exit(2);
});
const rowById = new Map(Object.entries(tables).flatMap(([tableId, rows]) =>
  rows.map((row) => [`${tableId}:${row.record_id}`, row] as const)));
const root = path.resolve(`.runtime/${tenantId.replace(/-formal$/, "")}-video-analysis`);
const jobsRoot = path.join(root, "jobs");
const everCompletePath = path.join(root, "ever-complete-keys.json");
const everComplete = existsSync(everCompletePath)
  ? JSON.parse(readFileSync(everCompletePath, "utf8")) as Record<string, string> : {};
const errors: string[] = [];
let writtenJobs = 0;
let currentlyMatching = 0;
let protectedAtWrite = 0;
let concurrentWritesSkipped = 0;
for (const name of existsSync(jobsRoot) ? readdirSync(jobsRoot) : []) {
  const dir = path.join(jobsRoot, name);
  const statusPath = path.join(dir, "status.json");
  if (!existsSync(statusPath)) continue;
  const status = JSON.parse(readFileSync(statusPath, "utf8")) as
    { state?: string; recordId?: string; videoId?: string; at?: string };
  if (status.state !== "WRITTEN") continue;
  // A runner can finish after the live-table snapshot was taken. Compare only
  // receipts that existed when this scan began; verify newer writes next time.
  if (status.at && Date.parse(status.at) >= scanStartedAt) {
    concurrentWritesSkipped++;
    continue;
  }
  writtenJobs++;
  const readbackPath = path.join(dir, "write-readback.json");
  if (!existsSync(readbackPath)) { errors.push(`${name}: no write-readback`); continue; }
  const readback = JSON.parse(readFileSync(readbackPath, "utf8")) as {
    protectedFieldsUnchanged?: boolean;
    before?: { fields?: Record<string, unknown> };
    after?: { fields?: Record<string, unknown> };
  };
  if (readback.protectedFieldsUnchanged !== true) {
    errors.push(`${name}: protected-at-write verification missing`);
    continue;
  }
  protectedAtWrite++;
  const tableId = name.split("-")[0];
  const row = rowById.get(`${tableId}:${status.recordId}`);
  if (!row) { errors.push(`${name}: live record missing`); continue; }
  const same = ANALYSIS_FIELDS.every((field) =>
    row.fields[field] === readback.after?.fields?.[field]);
  if (!same) { errors.push(`${name}: analysis fields differ from write receipt`); continue; }
  currentlyMatching++;
}

console.log(JSON.stringify({ at: new Date().toISOString(), scanStartedAt: new Date(scanStartedAt).toISOString(), tenantId,
  live: { totalRows: inventory.totalRows, completeRows: inventory.completeRows,
    pending: inventory.pending.length, invalidWithoutVideoLink: inventory.invalid.length,
    partial: inventory.partial.length, duplicates: inventory.duplicates.length,
    previouslyCompleteNowBlank: inventory.pending.filter((item) => everComplete[item.key]
      && Date.parse(everComplete[item.key]) < scanStartedAt).length },
  perTable: Object.fromEntries(Object.entries(tables).map(([tableId, rows]) => [tableId, {
    totalRows: rows.length,
    completeRows: inventory.completeKeys.filter(key => key.startsWith(`${tableId}:`)).length,
    pending: inventory.pending.filter(item => item.tableId === tableId).length,
    invalidWithoutVideoLink: inventory.invalid.filter(item => item.tableId === tableId).length,
    partial: inventory.partial.filter(item => item.tableId === tableId).length,
  }])),
  receipts: { writtenJobs, protectedAtWrite, currentlyMatching, concurrentWritesSkipped }, errors,
  evidence: "Real formal Base read-only scan plus task-local written receipts; no mutation" }, null, 2));
if (errors.length) process.exitCode = 2;
