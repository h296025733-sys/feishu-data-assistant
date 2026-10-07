import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ANALYSIS_FIELDS } from "../video-analysis/storeone-inventory.js";
import { feishuErrorDetails, withFeishuRetry } from "../feishu/client.js";
import { loadLiveStoreVideoInventory, type VideoAnalysisTenantId } from "../video-analysis/storeone-source.js";
import { plainLanguageResult } from "../video-analysis/storeone-result.js";

const tenantFlag = process.argv.indexOf("--tenant");
const tenant = tenantFlag < 0 ? "storeone-formal" : process.argv[tenantFlag + 1];
if (!["storeone-formal", "storetwo-formal", "storetwo-botanical-care-formal"].includes(tenant)) {
  throw new Error("Unsupported video-analysis tenant");
}
const videoFlag = process.argv.indexOf("--video-id");
const videoId = videoFlag < 0 ? undefined : process.argv[videoFlag + 1];
if (videoFlag >= 0 && !/^\d{19}$/.test(videoId ?? "")) throw new Error("Invalid video ID");
const jobsRoot = path.resolve(`.runtime/${tenant.replace(/-formal$/, "")}-video-analysis/jobs`);
const { tables } = await withFeishuRetry(
  () => loadLiveStoreVideoInventory(tenant as VideoAnalysisTenantId),
  { attempts: 3, baseDelayMs: 2000 },
).catch((error: unknown) => {
  // A failed read must not dump Axios request headers or modify local receipts.
  console.error(JSON.stringify({ at: new Date().toISOString(), tenantId: tenant,
    evidence: "Formal read-only reconciliation scan failed before receipt changes",
    error: feishuErrorDetails(error) }, null, 2));
  process.exit(2);
});
const reconciled: string[] = [];
const skipped: Array<{ job: string; reason: string }> = [];

for (const name of existsSync(jobsRoot) ? readdirSync(jobsRoot) : []) {
  if (videoId && !name.endsWith(`-${videoId}`)) continue;
  const dir = path.join(jobsRoot, name);
  const statusPath = path.join(dir, "status.json");
  if (!existsSync(statusPath)) continue;
  const status = JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, any>;
  if (status.state !== "REVIEW_REQUIRED"
      || !/status code (?:400|5\d\d)|timeout|timed out|ECONNRESET/i.test(String(status.reason ?? ""))) continue;
  const candidatePath = path.join(dir, "candidate.json");
  const beforePath = path.join(dir, "write-before.json");
  const acceptedPath = path.join(dir, "sol", "accepted.json");
  if (![candidatePath, beforePath, acceptedPath].every(existsSync)) {
    skipped.push({ job: name, reason: "missing candidate, write-before, or accepted result" });
    continue;
  }
  const candidate = JSON.parse(readFileSync(candidatePath, "utf8")) as
    { tableId: string; recordId: string; videoId: string };
  const before = JSON.parse(readFileSync(beforePath, "utf8")) as { fields: Record<string, unknown> };
  const accepted = JSON.parse(readFileSync(acceptedPath, "utf8")) as { attempt: string };
  if (!/^attempt-\d+$/.test(accepted.attempt)) {
    skipped.push({ job: name, reason: "invalid accepted attempt" });
    continue;
  }
  const resultPath = path.join(dir, "sol", accepted.attempt, "result.json");
  if (!existsSync(resultPath)) {
    skipped.push({ job: name, reason: "accepted result missing" });
    continue;
  }
  const result = plainLanguageResult(JSON.parse(readFileSync(resultPath, "utf8"))) as
    { analysis: string; recommendation: string; suggestions: string };
  const expected: Record<string, unknown> = {
    "视频内容分析": result.analysis,
    "投广建议": result.recommendation,
    "视频修改建议": result.suggestions,
  };
  const after = tables[candidate.tableId]?.find((row) => row.record_id === candidate.recordId);
  if (!after) {
    skipped.push({ job: name, reason: "live record missing" });
    continue;
  }
  const analysisMatches = ANALYSIS_FIELDS.every((field) => after.fields[field] === expected[field]);
  const protectedMatch = [...new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])]
    .filter((field) => !ANALYSIS_FIELDS.includes(field as (typeof ANALYSIS_FIELDS)[number]))
    .every((field) => JSON.stringify(before.fields[field]) === JSON.stringify(after.fields[field]));
  if (!analysisMatches || !protectedMatch) {
    skipped.push({ job: name, reason: `live readback mismatch analysis=${analysisMatches} protected=${protectedMatch}` });
    continue;
  }
  writeFileSync(path.join(dir, "write-readback.json"), JSON.stringify({
    at: new Date().toISOString(), before, after,
    protectedFieldsUnchanged: true,
    ambiguousUpdateRecovered: true,
    updateFailure: status.reason,
  }, null, 2));
  writeFileSync(statusPath, JSON.stringify({
    at: new Date().toISOString(), state: "WRITTEN", recordId: candidate.recordId,
    videoId: candidate.videoId, reconciledFromAmbiguousUpdate: true,
  }, null, 2));
  reconciled.push(name);
}

console.log(JSON.stringify({ at: new Date().toISOString(), tenantId: tenant, reconciled, skipped,
  evidence: "Formal Base read-only comparison; only task-local receipts/status were repaired" }, null, 2));
if (skipped.length) process.exitCode = 2;
