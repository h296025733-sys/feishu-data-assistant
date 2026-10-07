import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadBusinessProfile } from "../config/business-profile.js";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";
import {
  StorefourDemoGateway,
  type OnlineRecordSnapshot,
} from "../feishu/storefour-demo-gateway.js";
import { shopTimestampToBusinessDate } from "../realtime/business-time.js";
import { RealtimeJobStore } from "../realtime/job-store.js";
import type { OnlineImportPlan } from "../realtime/online-import.js";

const PROJECT_ROOT = process.cwd();
const MANAGED_FIELDS = [
  "登记日期", "实上线日期(Ct)", "达人姓名", "挂车产品", "视频上线地址", "视频曝光K",
] as const;

const jobId = parseJobId(process.argv.slice(2));
const profile = loadBusinessProfile();
const store = new RealtimeJobStore();
const job = await store.get(jobId);
if (!job?.resultSummary || job.status !== "succeeded") {
  throw new Error("只允许修正已成功且有结果摘要的上线导入任务");
}
const plan = JSON.parse(await readFile(
  path.join(store.jobDirectory(jobId), "online-import-plan.json"),
  "utf8",
)) as OnlineImportPlan;
if (plan.version !== 1 || plan.jobId !== jobId || plan.videos.length === 0) {
  throw new Error("任务的上线导入计划无效");
}

const rawRows = await readRawRows(plan.sourceFiles);
const correctedVideos = plan.videos.map((item) => {
  const matches = rawRows.filter((row) => String(row.id ?? "") === item.video.id);
  if (matches.length !== 1) {
    throw new Error(`视频${item.video.id}在原始API证据中的记录数=${matches.length}`);
  }
  const rawPostTime = String(matches[0].video_post_time ?? "");
  const businessDate = shopTimestampToBusinessDate(
    rawPostTime,
    profile.tiktok.shopTimeZone,
    profile.businessTimeZone,
  );
  return {
    rawPostTime,
    oldDate: item.video.date,
    video: { ...item.video, date: businessDate },
  };
});

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env);
const gateway = new StorefourDemoGateway(env, client);
await gateway.initializeOnlineProducts(
  [...new Set(correctedVideos.flatMap((item) => item.video.products))],
);
const before: OnlineRecordSnapshot[] = [];
for (const item of correctedVideos) {
  const snapshot = await gateway.snapshotOnlineByVideoId(item.video.id);
  if (!snapshot) throw new Error(`视频${item.video.id}在上线表中不存在`);
  before.push(snapshot);
}

const backupDirectory = path.join(PROJECT_ROOT, "backups", "realtime-sync", jobId);
const beforeEvidence = {
  version: 1,
  jobId,
  generatedAt: new Date().toISOString(),
  shopTimeZone: profile.tiktok.shopTimeZone,
  businessTimeZone: profile.businessTimeZone,
  job,
  conversions: correctedVideos.map(({ rawPostTime, oldDate, video }) => ({
    videoId: video.id,
    rawPostTime,
    oldDate,
    correctedDate: video.date,
  })),
  records: before,
};
const beforeText = `${JSON.stringify(beforeEvidence, null, 2)}\n`;
await writeFile(path.join(backupDirectory, "timezone-correction-before.json"), beforeText, {
  encoding: "utf8",
  mode: 0o600,
});
await writeFile(
  path.join(backupDirectory, "timezone-correction-before.sha256"),
  `${createHash("sha256").update(beforeText).digest("hex")}  timezone-correction-before.json\n`,
  "ascii",
);
try {
  const rollbackBefore = await readFile(path.join(backupDirectory, "rollback.json"), "utf8");
  await writeFile(
    path.join(backupDirectory, "rollback-before-timezone-correction.json"),
    rollbackBefore,
    { encoding: "utf8", mode: 0o600 },
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const verified: OnlineRecordSnapshot[] = [];
for (const item of correctedVideos) {
  const sync = await gateway.syncOnline(item.video);
  const result = await gateway.verifyOnline(item.video, sync.recordId);
  if (!result.ok) {
    throw new Error(`视频${item.video.id}北京时间修正后验证失败：${result.errors.join("；")}`);
  }
  verified.push(result.record);
}

const rollbackOperations = verified.map((record) => ({
  action: "delete_created",
  tableId: record.tableId,
  tableName: record.tableName,
  recordId: record.recordId,
  expectedAfter: Object.fromEntries(
    MANAGED_FIELDS.map((field) => [field, record.fields[field] ?? null]),
  ),
  restoreFields: {},
}));
await writeJson(path.join(backupDirectory, "rollback.json"), {
  version: 1,
  jobId,
  confirmation: `ROLLBACK-${jobId}`,
  operations: rollbackOperations,
});
await writeJson(path.join(backupDirectory, "timezone-correction-result.json"), {
  version: 1,
  jobId,
  completedAt: new Date().toISOString(),
  shopTimeZone: profile.tiktok.shopTimeZone,
  businessTimeZone: profile.businessTimeZone,
  conversions: correctedVideos.map(({ rawPostTime, oldDate, video }) => ({
    videoId: video.id,
    rawPostTime,
    oldDate,
    correctedDate: video.date,
  })),
  verifiedRecordIds: verified.map((record) => record.recordId),
  preservedUnknownRecords: true,
});
await store.update(job, {
  prompt: `上线视频已按${profile.tiktok.shopTimeZone}换算到${profile.businessTimeZone}并逐条回读；原始API时间、旧日期和修正日期已留档。`,
  error: null,
});

console.log(JSON.stringify({
  ok: true,
  jobId,
  shopTimeZone: profile.tiktok.shopTimeZone,
  businessTimeZone: profile.businessTimeZone,
  conversions: correctedVideos.map(({ rawPostTime, oldDate, video }) => ({
    videoId: video.id,
    rawPostTime,
    oldDate,
    correctedDate: video.date,
  })),
  verifiedRecordIds: verified.map((record) => record.recordId),
}, null, 2));

function parseJobId(values: string[]): string {
  const index = values.indexOf("--job-id");
  const value = index >= 0 ? String(values[index + 1] ?? "") : "";
  if (!/^rt-\d{14}-[a-f0-9]{8}$/.test(value)) throw new Error("用法：--job-id <job_id>");
  return value;
}

async function readRawRows(files: string[]): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      data?: { videos?: unknown[] };
    };
    for (const value of parsed.data?.videos ?? []) {
      if (value && typeof value === "object") rows.push(value as Record<string, unknown>);
    }
  }
  return rows;
}

async function writeJson(target: string, value: unknown): Promise<void> {
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
