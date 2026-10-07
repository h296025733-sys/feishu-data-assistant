import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { classifyMediaFailure, correctedMediaRetryAfter } from "../video-analysis/media-failure-policy.js";

// Local evidence only. No API requests, status changes, media requests or analysis-field writes.
const flag = process.argv.indexOf("--audit");
if (flag < 0 || !process.argv[flag + 1]) throw new Error("--audit <formal-backlog-audit.json> required");
const auditPath = path.resolve(process.argv[flag + 1]);
const audit = JSON.parse(readFileSync(auditPath, "utf8"));
const result: Record<string, unknown>[] = [];
const byNativeReason: Record<string, number> = {};
for (const store of audit.result) {
  if (!/^(storeone|storetwo|storethree|storetwo-llc|storetwo-botanical-care)-formal$/.test(store.tenant)) throw new Error("Unexpected tenant");
  for (const row of store.remaining) {
    if (!/^tbl[\w]+$/.test(row.tableId) || !/^\d{19}$/.test(row.videoId)) throw new Error("Unexpected business key");
    const dir = path.resolve(".runtime", store.tenant.replace(/-formal$/, "") + "-video-analysis", "jobs", `${row.tableId}-${row.videoId}`);
    const file = path.join(dir, "status.json");
    if (!existsSync(file)) continue;
    const status = JSON.parse(readFileSync(file, "utf8"));
    if (status.state !== "MEDIA_UNAVAILABLE") continue;
    const logNames = readdirSync(dir).filter(name => /^download-.*\.(log|json)$/.test(name));
    const logs = logNames.map(name => readFileSync(path.join(dir, name), "utf8")).join("\n");
    const nativeReason = classifyMediaFailure(logs);
    byNativeReason[nativeReason] = (byNativeReason[nativeReason] ?? 0) + 1;
    result.push({ tenant: store.tenant, tableId: row.tableId, videoId: row.videoId,
      state: status.state, recordedReason: status.reason, nativeReason, at: status.at,
      retryAfter: status.retryAfter, eligiblePolicyCorrection: correctedMediaRetryAfter(status, logs), logNames });
  }
}
const root = path.resolve(".runtime/video-analysis-global/retry-policy-audits");
mkdirSync(root, { recursive: true });
const output = path.join(root, new Date().toISOString().replace(/[:.]/g, "-") + ".json");
const summary = { byNativeReason, eligiblePolicyCorrection: result.filter(row => row.eligiblePolicyCorrection).length };
writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), scope: "local saved native logs; not a new formal inventory",
  sourceAudit: auditPath, summary, result }, null, 2));
console.log(JSON.stringify({ output, summary }, null, 2));
