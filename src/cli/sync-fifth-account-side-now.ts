import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareLatestAccountSidePlan } from "../account-side/plan.js";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import {
  listRecords,
  listTables,
  syncAccountSidePlanWithClient,
  verifyAccountSidePlanWithClient,
} from "../feishu/account-side-test.js";
import { createFeishuClient } from "../feishu/client.js";

const PROJECT_ROOT = String.raw`D:\workspace\feishu-data-assistant-poc`;
const TENANT_ID = "storetwo-botanical-care-formal";
const CONFIRMATION = "SYNC-STORETWO-BOTANICAL-ACCOUNT-SIDE-20260901";
const args = process.argv.slice(2).filter((value) => value !== "--");
const apply = args.includes("--apply");
const registry = new TenantRegistry(getEnv());
const tenant = registry.byId(TENANT_ID);
if (!tenant) throw new Error(`${TENANT_ID}不存在`);
if (apply && argument("--confirm") !== CONFIRMATION) {
  throw new Error(`正式账号端补齐必须提供 --confirm ${CONFIRMATION}`);
}
if (apply) await assertEveryDailyJobIdle(registry);

const plan = await prepareLatestAccountSidePlan({
  profile: tenant.profile,
  days: tenant.profile.accountSideAutomation?.reconciliationDays ?? 7,
});
if (plan.shop.name !== tenant.profile.businessDisplayName) throw new Error("TikTok计划与目标店铺不一致");
const client = createFeishuClient(tenant.env);
const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
const before = await snapshot(client, appToken);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDirectory = path.join(PROJECT_ROOT, ".runtime", "fifth-store-account-side-sync", stamp);
await writeJsonAtomic(path.join(runDirectory, "plan.json"), plan);
await writeJsonAtomic(path.join(runDirectory, "before.json"), before);

if (!apply) {
  const result = {
    action: "prepare",
    evidence: "real-tiktok-read-plus-real-formal-feishu-read-only",
    runDirectory,
    latestAvailableDate: plan.latestAvailableDate,
    window: [plan.startDate, plan.endDateInclusive],
    counts: planCounts(plan),
  };
  await writeJsonAtomic(path.join(runDirectory, "result.json"), result);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const first = await syncAccountSidePlanWithClient(
  client,
  formalBase(),
  plan,
  { preserveAccountManualFields: true },
);
const replay = await syncAccountSidePlanWithClient(
  client,
  formalBase(),
  plan,
  { preserveAccountManualFields: true },
);
const verification = await verifyAccountSidePlanWithClient(
  client,
  formalBase(),
  plan,
  { preserveAccountManualFields: true },
);
const after = await snapshot(client, appToken);
assertProtectedFieldsUnchanged(before, after);
await writeJsonAtomic(path.join(runDirectory, "after.json"), after);
const result = {
  action: "apply",
  evidence: "real-tiktok-read-plus-real-formal-feishu-write-readback-idempotent-replay",
  completedAt: new Date().toISOString(),
  runDirectory,
  latestAvailableDate: plan.latestAvailableDate,
  window: [plan.startDate, plan.endDateInclusive],
  counts: planCounts(plan),
  first,
  replay,
  verification,
  protectedFieldChanges: 0,
  ok: true,
};
await writeJsonAtomic(path.join(runDirectory, "result.json"), result);
console.log(JSON.stringify(result, null, 2));

function formalBase() {
  return {
    storeKey: TENANT_ID,
    storeName: tenant!.profile.businessDisplayName,
    appToken,
    name: tenant!.profile.businessDisplayName,
    url: tenant!.env.FEISHU_BITABLE_URL,
    createdAt: "existing-formal-base",
  };
}

function planCounts(value: typeof plan): Record<string, number> {
  return {
    accounts: value.accounts.length,
    videos: value.videos.length,
    productRows: value.productRows.length,
    accountRows: value.accountRows.length,
  };
}

async function snapshot(clientValue: ReturnType<typeof createFeishuClient>, token: string) {
  const names = new Set(["视频号信息统计", "短视频数据表", "产品投产比", "账号投产比"]);
  const tables = (await listTables(clientValue, token)).filter((table) => names.has(table.name));
  if (tables.length !== names.size) throw new Error(`账号端四表数量=${tables.length}`);
  return Promise.all(tables.map(async (table) => ({
    ...table,
    records: await listRecords(clientValue, token, table.tableId),
  })));
}

function assertProtectedFieldsUnchanged(
  before: Awaited<ReturnType<typeof snapshot>>,
  after: Awaited<ReturnType<typeof snapshot>>,
): void {
  const manualByTable = new Map<string, string[]>([
    ["视频号信息统计", ["负责人", "UID", "账号", "密码", "邮箱密码", "备注"]],
    ["产品投产比", ["广告花费", "广告出单量", "广告花费有"]],
    ["账号投产比", ["广告花费", "广告出单量"]],
  ]);
  for (const [tableName, fields] of manualByTable) {
    const prior = before.find((table) => table.name === tableName)!;
    const current = after.find((table) => table.name === tableName)!;
    const currentById = new Map(current.records.map((record) => [record.recordId, record]));
    for (const record of prior.records) {
      const next = currentById.get(record.recordId);
      if (!next) throw new Error(`${tableName}既有记录丢失：${record.recordId}`);
      for (const field of fields) {
        if (normalized(record.fields[field]) !== normalized(next.fields[field])) {
          throw new Error(`${tableName}.${record.recordId}.${field}人工字段发生变化`);
        }
      }
    }
  }
}

function normalized(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(normalized));
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value ?? "");
}

async function assertEveryDailyJobIdle(values: TenantRegistry): Promise<void> {
  for (const item of values.all()) {
    const statusPath = path.join(PROJECT_ROOT, ".runtime", "tenants", item.binding.id, "daily-automation", "status.json");
    const status = JSON.parse(await readFile(statusPath, "utf8")) as { running?: boolean };
    if (status.running !== false) throw new Error(`${item.binding.id}日更仍在运行`);
  }
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

function argument(name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] ?? "").trim() : "";
}
