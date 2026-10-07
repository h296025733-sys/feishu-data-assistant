import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import { prepareLatestAccountSidePlan, type AccountSidePlan } from "../account-side/plan.js";
import { getEnv, requireFeishuEnv, type AppEnv } from "../config/env.js";
import { TenantRegistry, type ResolvedTenant } from "../config/tenant-registry.js";
import {
  installAccountSideSchemaWithClient,
  listFields,
  listRecords,
  listTables,
  listViews,
  syncAccountSidePlanWithClient,
  verifyAccountSidePlanWithClient,
  type AccountSideBase,
} from "../feishu/account-side-test.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import { resolveCommandAction } from "./command-action.js";

const PROJECT_ROOT = process.cwd();
const REPORT_ROOT = path.join(PROJECT_ROOT, ".runtime", "account-side-formal");
const FORMAL_APP_ID = "demo_ded47f35";
const EXPECTED_TENANTS = new Set(["storetwo-formal", "storeone-formal"]);
const ACCOUNT_SIDE_TABLE_NAMES = new Set(["视频号信息统计", "短视频数据表", "产品投产比", "账号投产比"]);
const CONFIRMATION = "ACCOUNT-SIDE-FORMAL-TWO-EXISTING-BASES-20260814";

interface BaseSnapshot {
  capturedAt: string;
  tenantId: string;
  storeName: string;
  app: { name: string; timeZone: string; isAdvanced: boolean };
  tables: Array<{
    tableId: string;
    name: string;
    fields: Awaited<ReturnType<typeof listFields>>;
    records: Awaited<ReturnType<typeof listRecords>>;
    views: Awaited<ReturnType<typeof listViews>>;
  }>;
}

const args = process.argv.slice(2).filter((value) => value !== "--");
const action = resolveCommandAction(args, {
  applyFlag: "--apply",
  fallback: "--audit",
  ignoredFlags: ["--confirm"],
});
const rootEnv = requireFeishuEnv(getEnv());
assertFormalIdentity(rootEnv);
const registry = new TenantRegistry(rootEnv);
const tenants = registry.all().sort((left, right) => left.binding.id.localeCompare(right.binding.id));
assertExactFormalTenants(tenants);
const client = createFeishuClient(rootEnv);

let result: Record<string, unknown>;
switch (action) {
  case "--audit":
    result = {
      action: "audit",
      evidence: "real-formal-feishu-api-read-only",
      checkedAt: new Date().toISOString(),
      tenants: await Promise.all(tenants.map((tenant) => auditTenant(client, tenant))),
    };
    break;
  case "--prepare": {
    await assertDailyJobsIdle(tenants);
    const plans = await preparePlans(tenants);
    const runDirectory = await savePreparedPlans(plans, "prepare");
    result = {
      action: "prepare",
      evidence: "real-tiktok-api-read-only",
      checkedAt: new Date().toISOString(),
      runDirectory,
      plans: summarizePlans(plans),
    };
    break;
  }
  case "--apply": {
    requireWriteConfirmation();
    await assertDailyJobsIdle(tenants);

    // Finish every external read and validate both shops before the first Feishu write.
    const plans = await preparePlans(tenants);
    await assertDailyJobsIdle(tenants);
    const runDirectory = await savePreparedPlans(plans, "apply");
    const before = await snapshotAll(client, tenants);
    await Promise.all(before.map((snapshot) => writeJsonAtomic(
      path.join(runDirectory, snapshot.tenantId, "before.json"),
      snapshot,
    )));

    const applied = [];
    for (const tenant of tenants) {
      const base = formalBase(tenant);
      const plan = plans.get(tenant.binding.id)!;
      const schema = await installAccountSideSchemaWithClient(client, base);
      const first = await syncAccountSidePlanWithClient(
        client,
        base,
        plan,
        { preserveAccountManualFields: true },
      );
      const replay = await syncAccountSidePlanWithClient(
        client,
        base,
        plan,
        { preserveAccountManualFields: true },
      );
      const verification = await verifyAccountSidePlanWithClient(
        client,
        base,
        plan,
        { preserveAccountManualFields: true },
      );
      applied.push({
        tenantId: tenant.binding.id,
        storeName: tenant.profile.businessDisplayName,
        schema,
        first,
        replay,
        verification,
      });
    }

    const after = await snapshotAll(client, tenants);
    await Promise.all(after.map((snapshot) => writeJsonAtomic(
      path.join(runDirectory, snapshot.tenantId, "after.json"),
      snapshot,
    )));
    const originalIntegrity = compareOriginalTables(before, after);
    if (originalIntegrity.some((item) => !item.ok)) {
      throw new Error("正式Base原有表完整性回读不一致；账号端新表已保留，已停止后续发布，请查阅本地前后快照");
    }
    const manifest = {
      action: "apply",
      evidence: "real-tiktok-api-read-plus-real-formal-feishu-write-readback",
      completedAt: new Date().toISOString(),
      runDirectory,
      plans: summarizePlans(plans),
      applied,
      originalIntegrity,
    };
    await writeJsonAtomic(path.join(runDirectory, "result.json"), manifest);
    await writeJsonAtomic(path.join(REPORT_ROOT, "latest.json"), manifest);
    result = manifest;
    break;
  }
  default:
    throw new Error(`未知操作：${action}`);
}

console.log(JSON.stringify(sanitizeResult(result), null, 2));

function assertFormalIdentity(env: AppEnv): void {
  if (env.FEISHU_APP_ID !== FORMAL_APP_ID) {
    throw new Error(`当前飞书应用不是指定正式应用（${env.FEISHU_APP_ID || "空"}），拒绝执行`);
  }
  let host = "";
  try {
    host = new URL(env.FEISHU_BITABLE_URL).hostname;
  } catch {
    throw new Error("正式Base地址无效，拒绝执行");
  }
  if (!host.endsWith(".feishu.cn") || host.startsWith("test-")) {
    throw new Error(`当前Base地址不是正式飞书企业（${host || "空"}），拒绝执行`);
  }
}

function assertExactFormalTenants(values: ResolvedTenant[]): void {
  const actual = new Set(values.map((tenant) => tenant.binding.id));
  if (actual.size !== EXPECTED_TENANTS.size || [...EXPECTED_TENANTS].some((id) => !actual.has(id))) {
    throw new Error(`正式租户集合不符合预期：${[...actual].sort().join("、")}`);
  }
  for (const tenant of values) {
    assertFormalIdentity(tenant.env);
    if (!tenant.profile.accountSideAutomation?.enabled) {
      throw new Error(`${tenant.binding.id}未启用账号端自动化，拒绝只做一次性正式写入`);
    }
  }
}

function requireWriteConfirmation(): void {
  const confirmIndex = args.indexOf("--confirm");
  const actual = confirmIndex >= 0 ? args[confirmIndex + 1] : "";
  if (!args.includes("--apply") || actual !== CONFIRMATION) {
    throw new Error(`正式写入必须同时提供 --apply --confirm ${CONFIRMATION}`);
  }
}

async function assertDailyJobsIdle(values: ResolvedTenant[]): Promise<void> {
  for (const tenant of values) {
    const statusPath = path.join(
      PROJECT_ROOT,
      ".runtime",
      "tenants",
      tenant.binding.id,
      "daily-automation",
      "status.json",
    );
    const status = JSON.parse(await readFile(statusPath, "utf8")) as { running?: boolean };
    if (status.running !== false) throw new Error(`${tenant.binding.id}日更仍在运行，拒绝正式写入`);
  }
}

async function preparePlans(values: ResolvedTenant[]): Promise<Map<string, AccountSidePlan>> {
  const plans = new Map<string, AccountSidePlan>();
  for (const tenant of values) {
    const plan = await prepareLatestAccountSidePlan({
      profile: tenant.profile,
      days: tenant.profile.accountSideAutomation?.reconciliationDays ?? 7,
    });
    if (normalizeCore(plan.shop.name) !== normalizeCore(tenant.profile.businessDisplayName)) {
      throw new Error(`${tenant.binding.id}账号端计划店铺身份不一致`);
    }
    plans.set(tenant.binding.id, plan);
  }
  return plans;
}

async function savePreparedPlans(plans: Map<string, AccountSidePlan>, label: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = path.join(REPORT_ROOT, `${stamp}-${label}`);
  for (const [tenantId, plan] of plans) {
    await writeJsonAtomic(path.join(directory, tenantId, "plan.json"), plan);
  }
  return directory;
}

async function auditTenant(clientValue: Client, tenant: ResolvedTenant): Promise<Record<string, unknown>> {
  const tables = await listTables(clientValue, tenant.env.FEISHU_BITABLE_APP_TOKEN);
  return {
    tenantId: tenant.binding.id,
    storeName: tenant.profile.businessDisplayName,
    tableCount: tables.length,
    tables: tables.map((table) => ({
      name: table.name,
      tableId: table.tableId,
      accountSide: ACCOUNT_SIDE_TABLE_NAMES.has(table.name),
    })),
  };
}

async function snapshotAll(clientValue: Client, values: ResolvedTenant[]): Promise<BaseSnapshot[]> {
  const snapshots: BaseSnapshot[] = [];
  for (const tenant of values) snapshots.push(await snapshotBase(clientValue, tenant));
  return snapshots;
}

async function snapshotBase(clientValue: Client, tenant: ResolvedTenant): Promise<BaseSnapshot> {
  const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
  const appResponse = await clientValue.bitable.app.get({ path: { app_token: appToken } });
  assertFeishuResponse(appResponse, `读取${tenant.profile.businessDisplayName}正式Base元数据`);
  const tableRefs = (await listTables(clientValue, appToken)).sort(sortById);
  const tables: BaseSnapshot["tables"] = [];
  for (const table of tableRefs) {
    const [fields, records, views] = await Promise.all([
      listFields(clientValue, appToken, table.tableId),
      listRecords(clientValue, appToken, table.tableId),
      listViews(clientValue, appToken, table.tableId),
    ]);
    tables.push({
      ...table,
      fields: fields.sort(sortById),
      records: records.sort(sortById),
      views: views.sort(sortById),
    });
  }
  return {
    capturedAt: new Date().toISOString(),
    tenantId: tenant.binding.id,
    storeName: tenant.profile.businessDisplayName,
    app: {
      name: appResponse.data?.app?.name ?? "",
      timeZone: appResponse.data?.app?.time_zone ?? "",
      isAdvanced: appResponse.data?.app?.is_advanced ?? false,
    },
    tables,
  };
}

function compareOriginalTables(before: BaseSnapshot[], after: BaseSnapshot[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const priorBase of before) {
    const currentBase = after.find((item) => item.tenantId === priorBase.tenantId);
    if (!currentBase) throw new Error(`缺少${priorBase.tenantId}写后快照`);
    for (const priorTable of priorBase.tables.filter((table) => !ACCOUNT_SIDE_TABLE_NAMES.has(table.name))) {
      const currentTable = currentBase.tables.find((table) => table.tableId === priorTable.tableId);
      const beforeHash = sha256(priorTable);
      const afterHash = currentTable ? sha256(currentTable) : "missing";
      result.push({
        tenantId: priorBase.tenantId,
        tableName: priorTable.name,
        tableId: priorTable.tableId,
        beforeHash,
        afterHash,
        ok: beforeHash === afterHash,
      });
    }
  }
  return result;
}

function formalBase(tenant: ResolvedTenant): AccountSideBase {
  return {
    storeKey: tenant.binding.id,
    storeName: tenant.profile.businessDisplayName,
    appToken: tenant.env.FEISHU_BITABLE_APP_TOKEN,
    name: tenant.profile.businessDisplayName,
    url: tenant.env.FEISHU_BITABLE_URL,
    createdAt: "existing-formal-base",
  };
}

function summarizePlans(plans: Map<string, AccountSidePlan>): Array<Record<string, unknown>> {
  return [...plans].map(([tenantId, plan]) => ({
    tenantId,
    storeName: plan.shop.name,
    latestAvailableDate: plan.latestAvailableDate,
    startDate: plan.startDate,
    endDateInclusive: plan.endDateInclusive,
    counts: {
      accounts: plan.accounts.length,
      videos: plan.videos.length,
      productRoi: plan.productRows.length,
      accountRoi: plan.accountRows.length,
    },
    warnings: plan.warnings,
  }));
}

function sanitizeResult(value: Record<string, unknown>): Record<string, unknown> {
  // Result data intentionally contains only identifiers/counts/hashes. Full record backups stay mode-0600 on disk.
  return value;
}

function sortById(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftId = String(left.tableId ?? left.fieldId ?? left.recordId ?? left.viewId ?? "");
  const rightId = String(right.tableId ?? right.fieldId ?? right.recordId ?? right.viewId ?? "");
  return leftId.localeCompare(rightId);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").toUpperCase();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeCore(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "");
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}
