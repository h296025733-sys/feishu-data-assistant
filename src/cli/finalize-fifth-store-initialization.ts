import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";

const PROJECT_ROOT = String.raw`D:\workspace\feishu-data-assistant-poc`;
const TENANT_ID = "storetwo-botanical-care-formal";
const CONFIRMATION = "FINALIZE-STORETWO-BOTANICAL-INIT-20260901";
const args = process.argv.slice(2).filter((value) => value !== "--");
if (argument("--confirm") !== CONFIRMATION) {
  throw new Error(`初始化收尾必须提供 --confirm ${CONFIRMATION}`);
}
const registry = new TenantRegistry(getEnv());
const tenant = registry.byId(TENANT_ID);
if (!tenant || tenant.profile.businessDisplayName !== "Storetwo Botanical Care") {
  throw new Error("第五店身份不一致");
}
await assertEveryDailyJobIdle(registry);

const accountRunDirectory = path.resolve(argument("--account-side-run"));
const allowedRoot = path.join(PROJECT_ROOT, ".runtime", "fifth-store-account-side-sync") + path.sep;
if (!accountRunDirectory.startsWith(allowedRoot)) throw new Error("账号端证据目录不在允许范围内");
const accountResult = JSON.parse(await readFile(path.join(accountRunDirectory, "result.json"), "utf8")) as any;
if (accountResult.action !== "apply" || accountResult.ok !== true || accountResult.verification?.ok !== true) {
  throw new Error("账号端真实写入/验证结果不完整");
}
if (accountResult.latestAvailableDate !== "2026-08-30"
  || accountResult.window?.[0] !== "2026-08-24"
  || accountResult.window?.[1] !== "2026-08-30") {
  throw new Error("账号端证据窗口不是本次初始化范围");
}
for (const sectionName of ["accounts", "videos", "product", "account"]) {
  const replay = accountResult.replay?.[sectionName] ?? {};
  if (Number(replay.created ?? 0) !== 0 || Number(replay.updated ?? 0) !== 0) {
    throw new Error(`账号端${sectionName}幂等复跑仍有变化`);
  }
}

const root = path.join(PROJECT_ROOT, ".runtime", "tenants", TENANT_ID, "daily-automation");
const initializationPath = path.join(root, "initialization.json");
const statusPath = path.join(root, "status.json");
const initialization = JSON.parse(await readFile(initializationPath, "utf8")) as any;
const status = JSON.parse(await readFile(statusPath, "utf8")) as any;
const priorRun = initialization.lastRun;
if (initialization.state !== "failed" || initialization.completed !== false || !priorRun) {
  throw new Error(`初始化不是可收尾的失败状态：${initialization.state}`);
}
if (priorRun.windowStart !== "2026-08-24" || priorRun.windowEnd !== "2026-08-30") {
  throw new Error("店铺端初始化窗口不一致");
}
for (const phase of ["catalog", "online", "roi"]) {
  if (priorRun[phase]?.ok !== true) throw new Error(`店铺端${phase}尚未真实通过`);
}
if (priorRun.accountSide?.ok !== false || !String(priorRun.accountSide?.error ?? "").includes("TextFieldConvFail")) {
  throw new Error("原失败原因不是本轮已修复的账号端日期类型错误");
}

const first = accountResult.first as Record<string, any>;
const accountSide = {
  ok: true,
  matched: sum(first, "planned"),
  created: sum(first, "created"),
  updated: sum(first, "updated"),
  unchanged: sum(first, "unchanged"),
  skipped: 0,
  conflicts: 0,
  missingItems: [],
  error: null,
};
const completedAt = String(accountResult.completedAt ?? new Date().toISOString());
const completedRun = {
  ...priorRun,
  completedAt,
  accountSide,
  ok: true,
};
const completedInitialization = {
  ...initialization,
  completed: true,
  windowStart: completedRun.windowStart,
  windowEnd: completedRun.windowEnd,
  completedAt,
  lastAttemptAt: completedAt,
  lastRun: completedRun,
  state: "completed",
  pendingProductIds: [],
  lastError: null,
  progress: null,
};
const completedStatus = {
  ...status,
  running: false,
  lastRun: completedRun,
  updatedAt: new Date().toISOString(),
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDirectory = path.join(PROJECT_ROOT, ".runtime", "fifth-store-initialization-finalize", stamp);
await writeJsonAtomic(path.join(evidenceDirectory, "before.json"), { initialization, status, accountResultPath: path.join(accountRunDirectory, "result.json") });
await writeJsonAtomicWithRetry(initializationPath, completedInitialization);
await writeJsonAtomicWithRetry(statusPath, completedStatus);

const initializationReadback = JSON.parse(await readFile(initializationPath, "utf8")) as any;
const statusReadback = JSON.parse(await readFile(statusPath, "utf8")) as any;
if (initializationReadback.completed !== true || initializationReadback.state !== "completed" || initializationReadback.lastRun?.ok !== true) {
  throw new Error("初始化状态写后回读失败");
}
if (statusReadback.running !== false || statusReadback.lastRun?.ok !== true || statusReadback.lastRun?.accountSide?.ok !== true) {
  throw new Error("日更状态写后回读失败");
}
const result = {
  ok: true,
  evidence: "composed-from-real-store-init-write-readback-plus-real-account-side-write-readback-idempotent-replay",
  completedAt,
  evidenceDirectory,
  runId: completedRun.runId,
  windowStart: completedRun.windowStart,
  windowEnd: completedRun.windowEnd,
  catalog: completedRun.catalog,
  online: completedRun.online,
  roi: completedRun.roi,
  accountSide,
};
await writeJsonAtomic(path.join(evidenceDirectory, "after.json"), { initialization: initializationReadback, status: statusReadback });
await writeJsonAtomic(path.join(evidenceDirectory, "result.json"), result);
console.log(JSON.stringify(result, null, 2));

function sum(result: Record<string, any>, field: string): number {
  return ["accounts", "videos", "product", "account"]
    .reduce((total, section) => total + Number(result[section]?.[field] ?? 0), 0);
}

async function assertEveryDailyJobIdle(values: TenantRegistry): Promise<void> {
  for (const item of values.all()) {
    const target = path.join(PROJECT_ROOT, ".runtime", "tenants", item.binding.id, "daily-automation", "status.json");
    const value = JSON.parse(await readFile(target, "utf8")) as { running?: boolean };
    if (value.running !== false) throw new Error(`${item.binding.id}日更仍在运行`);
  }
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

async function writeJsonAtomicWithRetry(target: string, value: unknown): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await writeJsonAtomic(target, value);
      return;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== "EPERM" || attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw lastError;
}

function argument(name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] ?? "").trim() : "";
}
