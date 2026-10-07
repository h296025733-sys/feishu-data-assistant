import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadLiveStoreVideoInventory, type VideoAnalysisTenantId } from "../video-analysis/storeone-source.js";

const tenants: VideoAnalysisTenantId[] = ["storeone-formal", "storetwo-formal", "storethree-formal",
  "storetwo-llc-formal", "storetwo-botanical-care-formal"];
const now = Date.now();
const result = [];
for (const tenant of tenants) {
  const { inventory } = await loadLiveStoreVideoInventory(tenant);
  const root = path.resolve(`.runtime/${tenant.replace(/-formal$/, "")}-video-analysis/jobs`);
  const pending = inventory.pending.map(candidate => {
    const file = path.join(root, `${candidate.tableId}-${candidate.videoId}`, "status.json");
    const status = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    return { tableId: candidate.tableId, recordId: candidate.recordId, videoId: candidate.videoId,
      url: candidate.url, state: status.state ?? "UNATTEMPTED", reason: status.reason ?? null,
      retryAfter: status.retryAfter ?? null,
      due: !status.retryAfter || Date.parse(status.retryAfter) <= now };
  });
  const byState = Object.fromEntries([...new Set(pending.map(p => p.state))]
    .map(state => [state, pending.filter(p => p.state === state).length]));
  const item = { tenant, total: inventory.totalRows, complete: inventory.completeRows,
    pending: pending.length, invalid: inventory.invalid.length, partial: inventory.partial.length,
    duplicates: inventory.duplicates.length, due: pending.filter(p => p.due).length, byState,
    remaining: pending, invalidRecords: inventory.invalid };
  result.push(item);
  console.log(JSON.stringify({ tenant, total: item.total, complete: item.complete, pending: item.pending,
    invalid: item.invalid, partial: item.partial, duplicates: item.duplicates, due: item.due, byState }));
}
const dir = path.resolve(".runtime/video-analysis-global/backlog-audits");
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = path.join(dir, `${stamp}.json`);
writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), result }, null, 2));
console.log(`evidence=${file}`);
