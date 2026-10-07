import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";
import { buildVideoUpdatePlan, FeishuRealtimeGateway } from "../realtime/feishu-video-sync.js";
import { nextDate } from "../realtime/intent.js";
import { fetchTikTokVideoDay } from "../realtime/tiktok-cli.js";

const date = parseDate(process.argv.slice(2));
const env = requireFeishuEnv(getEnv());
const contract = await fetchTikTokVideoDay(date, nextDate(date));
if (!contract.ok) throw new Error(contract.errors.join("；") || "TikTok CLI 返回失败合同");
const gateway = new FeishuRealtimeGateway(env, createFeishuClient(env));
const jobId = `rt-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-dryrun00`;
const plan = await buildVideoUpdatePlan(jobId, contract, gateway);
const directory = path.join(
  process.cwd(),
  ".runtime",
  "realtime-sync",
  "dry-runs",
  `${date}-${Date.now()}`,
);
await mkdir(directory, { recursive: true });
const planPath = path.join(directory, "plan.json");
await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(JSON.stringify({
  ok: true,
  dryRun: true,
  writesPerformed: 0,
  date,
  windowEndExclusive: nextDate(date),
  apiRows: contract.row_count,
  exactDuplicateCount: contract.exact_duplicate_count,
  apiConflictingIds: contract.conflicting_duplicate_ids.length,
  matched: plan.matched,
  proposedUpdates: plan.changes.length,
  unchanged: plan.unchanged,
  skipped: plan.skipped,
  conflicts: plan.conflicts.length,
  missingItems: plan.missingItems,
  planPath,
}, null, 2));

function parseDate(values: string[]): string {
  const index = values.indexOf("--date");
  const value = index >= 0 ? values[index + 1] : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("用法：--date YYYY-MM-DD");
  return value;
}
