import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import {
  StorefourDemoGateway,
  type OnlineRecordSnapshot,
} from "../feishu/storefour-demo-gateway.js";
import { RealtimeJobStore } from "../realtime/job-store.js";
import type { OnlineImportPlan } from "../realtime/online-import.js";
import { normalizeTikTokHandle } from "../realtime/tiktok-identity.js";
import type { RealtimeResultSummary } from "../realtime/types.js";

const PROJECT_ROOT = process.cwd();
const MANAGED_FIELDS = [
  "登记日期", "实上线日期(Ct)", "达人姓名", "挂车产品", "视频上线地址", "视频曝光K",
] as const;
const INVISIBLE_CHARACTERS = /[\u200B-\u200D\u2060\u2063\uFEFF]/g;

const jobId = parseJobId(process.argv.slice(2));
const store = new RealtimeJobStore();
const job = await store.get(jobId);
if (!job) throw new Error(`找不到任务 ${jobId}`);
if (job.status === "succeeded") {
  console.log(JSON.stringify({ ok: true, alreadyRecovered: true, job }, null, 2));
  process.exit(0);
}

const planPath = path.join(store.jobDirectory(jobId), "online-import-plan.json");
const plan = JSON.parse(await readFile(planPath, "utf8")) as OnlineImportPlan;
if (plan.version !== 1 || plan.jobId !== jobId || plan.videos.length === 0) {
  throw new Error("上线导入恢复计划无效或没有视频");
}
if (plan.videos.some((item) => item.before !== null)) {
  throw new Error("该恢复工具只处理原计划全部为新增记录的任务，拒绝覆盖既有记录");
}

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env);
const gateway = new StorefourDemoGateway(env, client);
await gateway.initializeOnlineReadOnly();

const snapshots: Array<{ expectedCreator: string; snapshot: OnlineRecordSnapshot }> = [];
for (const item of plan.videos) {
  const snapshot = await gateway.snapshotOnlineByVideoId(item.video.id);
  if (!snapshot) throw new Error(`视频${item.video.id}当前没有上线记录，拒绝把任务标记为成功`);
  const expectedCreator = normalizeTikTokHandle(item.video.creator);
  const actualCreator = normalizeTikTokHandle(cellText(snapshot.fields.达人姓名));
  if (!expectedCreator || actualCreator !== expectedCreator) {
    throw new Error(`视频${item.video.id}达人姓名无法安全归一为${expectedCreator || "有效TK号"}`);
  }
  snapshots.push({ expectedCreator, snapshot });
}

const backupDirectory = path.join(PROJECT_ROOT, "backups", "realtime-sync", jobId);
await mkdir(backupDirectory, { recursive: true });
const recoveryBefore = {
  version: 1,
  jobId,
  generatedAt: new Date().toISOString(),
  job,
  records: snapshots.map(({ snapshot }) => snapshot),
};
const recoveryBeforeText = `${JSON.stringify(recoveryBefore, null, 2)}\n`;
await writeFile(path.join(backupDirectory, "recovery-before.json"), recoveryBeforeText, {
  encoding: "utf8",
  mode: 0o600,
});
await writeFile(
  path.join(backupDirectory, "recovery-before.sha256"),
  `${createHash("sha256").update(recoveryBeforeText).digest("hex")}  recovery-before.json\n`,
  "ascii",
);

const repairedRecordIds: string[] = [];
for (const { expectedCreator, snapshot } of snapshots) {
  const beforeRead = await client.bitable.appTableRecord.get({
    path: {
      app_token: env.FEISHU_BITABLE_APP_TOKEN,
      table_id: snapshot.tableId,
      record_id: snapshot.recordId,
    },
    params: { automatic_fields: true },
  });
  assertFeishuResponse(beforeRead, `恢复前复读${snapshot.recordId}`);
  const current = beforeRead.data?.record;
  if (!current) throw new Error(`恢复前找不到记录${snapshot.recordId}`);
  const rawCreator = cellText(current.fields?.达人姓名);
  if (normalizeTikTokHandle(rawCreator) !== expectedCreator) {
    throw new Error(`记录${snapshot.recordId}在备份后被修改，已停止`);
  }
  const needsRepair = INVISIBLE_CHARACTERS.test(rawCreator)
    || current.fields?.__重复_达人姓名 === true;
  INVISIBLE_CHARACTERS.lastIndex = 0;
  if (!needsRepair) continue;
  const updated = await client.bitable.appTableRecord.update({
    path: {
      app_token: env.FEISHU_BITABLE_APP_TOKEN,
      table_id: snapshot.tableId,
      record_id: snapshot.recordId,
    },
    data: {
      fields: {
        达人姓名: expectedCreator,
        __重复_达人姓名: false,
      },
    },
  });
  assertFeishuResponse(updated, `清理达人姓名不可见标记${snapshot.recordId}`);
  repairedRecordIds.push(snapshot.recordId);
}

const verified: OnlineRecordSnapshot[] = [];
for (const item of plan.videos) {
  const result = await gateway.verifyOnline(item.video, snapshots.find(
    ({ snapshot }) => snapshot.fields.视频上线地址
      && videoAddress(snapshot.fields.视频上线地址).includes(item.video.id),
  )!.snapshot.recordId);
  if (!result.ok) {
    throw new Error(`视频${item.video.id}恢复后验证失败：${result.errors.join("；")}`);
  }
  if (INVISIBLE_CHARACTERS.test(cellText(result.record.fields.达人姓名))) {
    throw new Error(`视频${item.video.id}恢复后仍含不可见字符`);
  }
  INVISIBLE_CHARACTERS.lastIndex = 0;
  if (result.record.fields.__重复_达人姓名 === true) {
    throw new Error(`视频${item.video.id}恢复后达人姓名仍被标记为重复`);
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
const rollbackCommand = `pnpm exec tsx src/cli/realtime-rollback.ts --job-id ${jobId} --confirm ROLLBACK-${jobId}`;
await writeJson(path.join(backupDirectory, "rollback.json"), {
  version: 1,
  jobId,
  confirmation: `ROLLBACK-${jobId}`,
  operations: rollbackOperations,
});
await writeFile(
  path.join(backupDirectory, "ROLLBACK.cmd"),
  `@echo off\r\ncd /d "${PROJECT_ROOT}"\r\ncall ${rollbackCommand}\r\n`,
  "ascii",
);

const summary: RealtimeResultSummary = {
  windowStart: plan.startDate,
  windowEndExclusive: plan.endDateExclusive,
  sources: plan.sourceFiles,
  matched: plan.videos.length,
  created: plan.videos.length,
  updated: 0,
  unchanged: 0,
  skipped: plan.skipped,
  conflicts: plan.conflicts.length,
  missingItems: plan.missingItems,
  backupPath: backupDirectory,
  rollbackCommand,
};
const completed = await store.setResult(job, summary);
await store.update(completed, {
  prompt: "原写入已完成；写后校验曾被错误的达人姓名重复标记中断，现已清理标记并逐条回读通过。",
  error: null,
});
await writeJson(path.join(backupDirectory, "recovery-result.json"), {
  version: 1,
  jobId,
  completedAt: new Date().toISOString(),
  repairedRecordIds,
  verifiedRecordIds: verified.map((record) => record.recordId),
  preservedUnknownRecords: true,
  summary,
});

console.log(JSON.stringify({
  ok: true,
  jobId,
  repairedRecordIds,
  verifiedRecordIds: verified.map((record) => record.recordId),
  summary,
}, null, 2));

function parseJobId(values: string[]): string {
  const index = values.indexOf("--job-id");
  const value = index >= 0 ? String(values[index + 1] ?? "") : "";
  if (!/^rt-\d{14}-[a-f0-9]{8}$/.test(value)) {
    throw new Error("用法：--job-id <job_id>");
  }
  return value;
}

function cellText(value: unknown): string {
  if (Array.isArray(value)) return value.map(cellText).join("").trim();
  if (value && typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "").trim();
  }
  return String(value ?? "").trim();
}

function videoAddress(value: unknown): string {
  if (value && typeof value === "object") {
    const object = value as { link?: unknown; text?: unknown };
    return String(object.link ?? object.text ?? "");
  }
  return String(value ?? "");
}

async function writeJson(target: string, value: unknown): Promise<void> {
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
