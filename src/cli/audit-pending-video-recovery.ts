import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadLiveStoreVideoInventory, videoAnalysisConfig, type VideoAnalysisTenantId } from "../video-analysis/storeone-source.js";

// Read-only production inventory check. No analysis, model calls, or remote writes.
const tenants: VideoAnalysisTenantId[] = process.argv.includes("--other-stores")
  ? ["storethree-formal", "storetwo-llc-formal", "storetwo-botanical-care-formal"]
  : ["storeone-formal", "storetwo-formal"];
const at = new Date().toISOString();
const stores = [];
for (const tenant of tenants) {
  const { inventory, tables } = await loadLiveStoreVideoInventory(tenant);
  const config = videoAnalysisConfig(tenant);
  const invalid = inventory.invalid.map(item => {
    const fields = tables[item.tableId].find(row => row.record_id === item.recordId)?.fields ?? {};
    const raw = fields[item.tableId === config.tables.online ? "视频上线地址" : "视频ID网址"];
    return { ...item, rawVideoLink: raw ?? null };
  });
  const root = path.resolve(`.runtime/${tenant.replace(/-formal$/, "")}-video-analysis/jobs`);
  const pending = inventory.pending.map(candidate => {
    const dir = path.join(root, `${candidate.tableId}-${candidate.videoId}`);
    const statePath = path.join(dir, "status.json");
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
    return { ...candidate, state: state.state ?? "UNATTEMPTED", reason: state.reason ?? null,
      retryAfter: state.retryAfter ?? null, due: !state.retryAfter || Date.parse(state.retryAfter) <= Date.now(),
      sourcePresent: existsSync(path.join(dir, "source.mp4")),
      evidencePresent: existsSync(path.join(dir, "evidence/manifest.json")),
      acceptedPresent: existsSync(path.join(dir, "sol/accepted.json")) };
  });
  stores.push({ tenant, total: inventory.totalRows, complete: inventory.completeRows,
    pending, partial: inventory.partial, invalid });
  console.log(JSON.stringify({ tenant, total: inventory.totalRows, complete: inventory.completeRows,
    pending: pending.length, partial: inventory.partial.length, invalid: inventory.invalid.length,
    invalidLinks: invalid.map(({ rawVideoLink }) => rawVideoLink),
    candidates: pending.map(({ videoId, state, reason, retryAfter, due, sourcePresent,
      evidencePresent, acceptedPresent }) => ({ videoId, state, reason, retryAfter, due,
      sourcePresent, evidencePresent, acceptedPresent })) }));
}
const dir = path.resolve(".runtime/video-analysis-global/recovery-audits");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${at.replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ at, mode: "READ_ONLY_PRODUCTION_INVENTORY", stores }, null, 2));
console.log(`evidence=${file}`);
