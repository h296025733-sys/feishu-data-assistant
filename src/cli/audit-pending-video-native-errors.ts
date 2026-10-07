import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { classifyMediaFailure } from "../video-analysis/media-failure-policy.js";

// Local diagnostic evidence only: no network, model, business-field or retry-state writes.
const input = process.argv[2];
if (!input) throw new Error("Pass an existing formal video backlog audit JSON path");
const audit = JSON.parse(readFileSync(input, "utf8"));
const rows = audit.result.flatMap((store: any) => store.remaining.map((candidate: any) => {
  const dir = path.resolve(`.runtime/${store.tenant.replace(/-formal$/, "")}-video-analysis/jobs/${candidate.tableId}-${candidate.videoId}`);
  const names = ["download-chrome.log", "download-edge.log", "download-plain.log",
    "download-authorized-cookie.log", "download-official-player.json", "download-official-player-process.log",
    "download-public-page-session.json", "download-public-page-session-process.log"];
  const evidence = names.filter(name => existsSync(path.join(dir, name)));
  const text = evidence.map(name => readFileSync(path.join(dir, name), "utf8")).join("\n");
  const nativeReason = classifyMediaFailure(text);
  return { tenant: store.tenant, tableId: candidate.tableId, recordId: candidate.recordId,
    videoId: candidate.videoId, savedReason: candidate.reason, nativeReason,
    retryAfter: candidate.retryAfter,
    restrictionSeenInSavedLogs: ["ip_blocked", "rate_limited", "login_required"].includes(nativeReason),
    permanentUnavailabilityProven: false,
    evidence: evidence.map(name => path.relative(process.cwd(), path.join(dir, name))) };
}));
const byNativeReason = Object.fromEntries([...new Set(rows.map((row: any) => row.nativeReason))]
  .map(reason => [String(reason), rows.filter((row: any) => row.nativeReason === reason).length]));
const result = { at: new Date().toISOString(), sourceAudit: path.resolve(input),
  scope: "LOCAL_SAVED_NATIVE_ERRORS_NOT_CURRENT_PLATFORM_AVAILABILITY", rows, byNativeReason,
  total: rows.length, analysisWrites: 0, retryStateWrites: 0,
  limitation: "Saved access errors do not prove deletion or permanent failure; audio-only files do not prove photo-post type." };
const root = path.resolve(".runtime/video-analysis-global/native-error-audits");
mkdirSync(root, { recursive: true });
const output = path.join(root, new Date().toISOString().replace(/[:.]/g, "-") + ".json");
writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ total: result.total, byNativeReason, evidence: output,
  scope: result.scope, analysisWrites: 0, retryStateWrites: 0 }));
