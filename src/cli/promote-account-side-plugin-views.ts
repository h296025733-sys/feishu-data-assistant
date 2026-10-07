import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { AccountSidePlan } from "../account-side/plan.js";
import { getEnv, requireFeishuEnv, type AppEnv } from "../config/env.js";
import { TenantRegistry, type ResolvedTenant } from "../config/tenant-registry.js";
import {
  ACCOUNT_SIDE_TABLES,
  listFields,
  listRecords,
  listTables,
  listViews,
  syncAccountSidePlanWithClient,
  verifyAccountSidePlanWithClient,
  type AccountSideBase,
} from "../feishu/account-side-test.js";
import { assertFeishuResponse, createFeishuClient, withFeishuRetry } from "../feishu/client.js";

const PROJECT_ROOT = process.cwd();
const FORMAL_APP_ID = "demo_ded47f35";
const EXPECTED_TENANTS = new Set(["storetwo-formal", "storeone-formal"]);
const ACCOUNT_SIDE_REPORT = path.join(PROJECT_ROOT, ".runtime", "account-side-formal", "latest.json");
const REPORT_ROOT = path.join(PROJECT_ROOT, ".runtime", "account-side-plugin-promotion");
const APPLY_CONFIRMATION = "PROMOTE-ACCOUNT-SIDE-PLUGIN-VIEWS-20260814";
const FINALIZE_CONFIRMATION = "FINALIZE-ACCOUNT-SIDE-PLUGIN-VIEWS-20260814";
const ROLLBACK_CONFIRMATION = "ROLLBACK-ACCOUNT-SIDE-PLUGIN-VIEWS-20260814";
const CLEANUP_CONFIRMATION = "CLEANUP-FAILED-ACCOUNT-SIDE-PLUGIN-VIEWS-20260814";

const TARGETS = [
  {
    finalName: "产品投产比" as const,
    stagingName: "产品投产比__视图部署中",
    backupName: "产品投产比__API部署备份",
  },
  {
    finalName: "账号投产比" as const,
    stagingName: "账号投产比__视图部署中",
    backupName: "账号投产比__API部署备份",
  },
] as const;

type TargetName = (typeof TARGETS)[number]["finalName"];
type RawField = {
  field_id?: string;
  field_name?: string;
  type?: number;
  ui_type?: string;
  is_primary?: boolean;
};
type TableSnapshot = {
  tableId: string;
  name: string;
  fields: Awaited<ReturnType<typeof listFields>>;
  records: Awaited<ReturnType<typeof listRecords>>;
  views: Awaited<ReturnType<typeof listViews>>;
};
type BaseSnapshot = {
  capturedAt: string;
  tenantId: string;
  storeName: string;
  tables: TableSnapshot[];
};
type InitialManifest = {
  runDirectory: string;
  applied: Array<{
    tenantId: string;
    schema: { verification: Array<{ table: string; tableId: string }> };
  }>;
  originalIntegrity: Array<{
    tenantId: string;
    tableName: string;
    tableId: string;
    afterHash: string;
    ok: boolean;
  }>;
};
type PromotionManifest = {
  action: "apply";
  evidence: string;
  completedAt: string;
  runDirectory: string;
  deployments: Array<{
    tenantId: string;
    storeName: string;
    targets: Array<{
      finalName: TargetName;
      oldTableId: string;
      newTableId: string;
      backupName: string;
      fields: number;
      records: number;
      views: Array<{ viewId: string; viewName: string; viewType: string }>;
    }>;
    sync: unknown;
    verification: unknown;
  }>;
  originalIntegrity: Array<Record<string, unknown>>;
};

const args = process.argv.slice(2).filter((value) => value !== "--");
const action = args.includes("--rollback")
  ? "--rollback"
  : args.includes("--cleanup-failed")
    ? "--cleanup-failed"
  : args.includes("--finalize")
    ? "--finalize"
    : args.includes("--apply")
      ? "--apply"
      : "--audit";
const rootEnv = requireFeishuEnv(getEnv());
assertFormalIdentity(rootEnv);
const registry = new TenantRegistry(rootEnv);
const tenants = registry.all().sort((left, right) => left.binding.id.localeCompare(right.binding.id));
assertExactFormalTenants(tenants);
const client = createFeishuClient(rootEnv);
const initial = JSON.parse(await readFile(ACCOUNT_SIDE_REPORT, "utf8")) as InitialManifest;
assertInitialManifest(initial);

if (action === "--audit") {
  console.log(JSON.stringify({
    action: "audit",
    evidence: "real-formal-feishu-api-read-only",
    checkedAt: new Date().toISOString(),
    tenants: await Promise.all(tenants.map((tenant) => auditTenant(client, tenant, initial))),
  }, null, 2));
} else if (action === "--apply") {
  requireConfirmation(APPLY_CONFIRMATION);
  await assertDailyJobsIdle(tenants);
  const plans = await loadPlans(tenants, initial);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDirectory = path.join(REPORT_ROOT, `${stamp}-apply`);
  const before = await snapshotAll(client, tenants);
  await saveSnapshots(runDirectory, "before", before);
  assertOriginalIntegrity(initial, before);

  // Prepare every staging table before changing any active table name.
  for (const tenant of tenants) {
    const tables = await listTables(client, tenant.env.FEISHU_BITABLE_APP_TOKEN);
    for (const target of TARGETS) {
      const staging = requireUniqueTable(tables, target.stagingName, tenant.binding.id);
      await rebuildStagingTable(client, tenant, staging.tableId, target.finalName);
    }
  }

  const deployments: PromotionManifest["deployments"] = [];
  for (const tenant of tenants) {
    const base = formalBase(tenant);
    const appToken = base.appToken;
    const originalTables = await listTables(client, appToken);
    const expectedOld = expectedAccountTableIds(initial, tenant.binding.id);
    const swapped: Array<{ finalName: TargetName; oldTableId: string; newTableId: string; backupName: string }> = [];
    try {
      for (const target of TARGETS) {
        const current = requireUniqueTable(originalTables, target.finalName, tenant.binding.id);
        const staging = requireUniqueTable(originalTables, target.stagingName, tenant.binding.id);
        if (current.tableId !== expectedOld.get(target.finalName)) {
          throw new Error(`${tenant.binding.id}/${target.finalName}当前表ID不等于初始正式安装表，拒绝切换`);
        }
        await patchTableName(client, appToken, current.tableId, target.backupName);
        try {
          await patchTableName(client, appToken, staging.tableId, target.finalName);
        } catch (error) {
          await patchTableName(client, appToken, current.tableId, target.finalName).catch(() => undefined);
          throw error;
        }
        swapped.push({ finalName: target.finalName, oldTableId: current.tableId, newTableId: staging.tableId, backupName: target.backupName });
      }
    } catch (error) {
      // Old account-side data tables are retained. Roll names back on a partial swap.
      for (const item of [...swapped].reverse()) {
        await patchTableName(client, appToken, item.newTableId, `${item.finalName}__视图部署失败`).catch(() => undefined);
        await patchTableName(client, appToken, item.oldTableId, item.finalName).catch(() => undefined);
      }
      throw error;
    }

    const plan = plans.get(tenant.binding.id)!;
    const sync = await syncAccountSidePlanWithClient(client, base, plan, { preserveAccountManualFields: true });
    const verification = await verifyAccountSidePlanWithClient(client, base, plan, { preserveAccountManualFields: true });
    const currentTables = await listTables(client, appToken);
    const targets = [];
    for (const item of swapped) {
      const active = requireUniqueTable(currentTables, item.finalName, tenant.binding.id);
      if (active.tableId !== item.newTableId) throw new Error(`${tenant.binding.id}/${item.finalName}切换后ID不一致`);
      const [fields, records, views] = await Promise.all([
        listFields(client, appToken, active.tableId),
        listRecords(client, appToken, active.tableId),
        listViews(client, appToken, active.tableId),
      ]);
      targets.push({ ...item, fields: fields.length, records: records.length, views });
    }
    deployments.push({ tenantId: tenant.binding.id, storeName: tenant.profile.businessDisplayName, targets, sync, verification });
  }

  const after = await snapshotAll(client, tenants);
  await saveSnapshots(runDirectory, "after", after);
  const originalIntegrity = compareOriginalIntegrity(initial, after);
  if (originalIntegrity.some((item) => item.ok !== true)) {
    throw new Error("正式原有表哈希在插件视图切换后不一致；旧账号端备份表仍保留，已停止清理");
  }
  const manifest: PromotionManifest = {
    action: "apply",
    evidence: "real-formal-feishu-structure-rebuild-name-swap-write-readback",
    completedAt: new Date().toISOString(),
    runDirectory,
    deployments,
    originalIntegrity,
  };
  await writeJsonAtomic(path.join(runDirectory, "result.json"), manifest);
  await writeJsonAtomic(path.join(REPORT_ROOT, "latest.json"), manifest);
  console.log(JSON.stringify(manifest, null, 2));
} else if (action === "--finalize") {
  requireConfirmation(FINALIZE_CONFIRMATION);
  await assertDailyJobsIdle(tenants);
  const promotion = JSON.parse(await readFile(path.join(REPORT_ROOT, "latest.json"), "utf8")) as PromotionManifest;
  if (promotion.action !== "apply" || promotion.deployments.length !== tenants.length) {
    throw new Error("缺少完整的插件视图切换结果，拒绝删除备份表");
  }
  const plans = await loadPlans(tenants, initial);
  const deleted: Array<Record<string, unknown>> = [];
  for (const tenant of tenants) {
    const deployment = promotion.deployments.find((item) => item.tenantId === tenant.binding.id);
    if (!deployment) throw new Error(`缺少${tenant.binding.id}插件视图切换记录`);
    const base = formalBase(tenant);
    await verifyAccountSidePlanWithClient(client, base, plans.get(tenant.binding.id)!, { preserveAccountManualFields: true });
    const tables = await listTables(client, base.appToken);
    for (const target of deployment.targets) {
      const active = requireUniqueTable(tables, target.finalName, tenant.binding.id);
      const backup = requireUniqueTable(tables, target.backupName, tenant.binding.id);
      if (active.tableId !== target.newTableId || backup.tableId !== target.oldTableId) {
        throw new Error(`${tenant.binding.id}/${target.finalName}活动表或备份表ID发生变化，拒绝删除`);
      }
      const activeViews = await listViews(client, base.appToken, active.tableId);
      if (!activeViews.some((view) => view.viewType === "unknown" || /经营工作台/.test(view.viewName))) {
        throw new Error(`${tenant.binding.id}/${target.finalName}未回读到插件视图，拒绝删除备份`);
      }
      await withFeishuRetry(async () => {
        const current = await client.bitable.appTable.delete({ path: { app_token: base.appToken, table_id: backup.tableId } });
        assertFeishuResponse(current, `删除${tenant.binding.id}/${target.backupName}`);
        return current;
      });
      deleted.push({ tenantId: tenant.binding.id, tableName: target.backupName, tableId: backup.tableId });
    }
  }
  const finalSnapshots = await snapshotAll(client, tenants);
  const originalIntegrity = compareOriginalIntegrity(initial, finalSnapshots);
  if (originalIntegrity.some((item) => item.ok !== true)) throw new Error("删除账号端部署备份后，正式原有表哈希不一致");
  const finalVerification = [];
  for (const tenant of tenants) {
    const tables = await listTables(client, tenant.env.FEISHU_BITABLE_APP_TOKEN);
    const accountNames = new Set(ACCOUNT_SIDE_TABLES.map((definition) => definition.name));
    const actual = tables.filter((table) => accountNames.has(table.name as never));
    if (actual.length !== ACCOUNT_SIDE_TABLES.length) throw new Error(`${tenant.binding.id}最终账号端四表数量异常：${actual.length}`);
    finalVerification.push({ tenantId: tenant.binding.id, tableCount: tables.length, accountSideTables: actual });
  }
  const result = {
    action: "finalize",
    evidence: "real-formal-feishu-delete-exact-deployment-backups-and-readback",
    completedAt: new Date().toISOString(),
    deleted,
    originalIntegrity,
    finalVerification,
  };
  await writeJsonAtomic(path.join(REPORT_ROOT, "final.json"), result);
  console.log(JSON.stringify(result, null, 2));
} else if (action === "--rollback") {
  requireConfirmation(ROLLBACK_CONFIRMATION);
  await assertDailyJobsIdle(tenants);
  const promotion = JSON.parse(await readFile(path.join(REPORT_ROOT, "latest.json"), "utf8")) as PromotionManifest;
  if (promotion.action !== "apply" || promotion.deployments.length !== tenants.length) {
    throw new Error("缺少完整的插件视图切换结果，拒绝回切");
  }
  const plans = await loadPlans(tenants, initial);
  const restored = [];
  for (const tenant of tenants) {
    const deployment = promotion.deployments.find((item) => item.tenantId === tenant.binding.id);
    if (!deployment) throw new Error(`缺少${tenant.binding.id}插件视图切换记录`);
    const base = formalBase(tenant);
    const tables = await listTables(client, base.appToken);
    for (const target of deployment.targets) {
      const active = requireUniqueTable(tables, target.finalName, tenant.binding.id);
      const backup = requireUniqueTable(tables, target.backupName, tenant.binding.id);
      if (active.tableId !== target.newTableId || backup.tableId !== target.oldTableId) {
        throw new Error(`${tenant.binding.id}/${target.finalName}活动表或备份表ID发生变化，拒绝回切`);
      }
      const failedName = `${target.finalName}__视图部署失败`;
      await patchTableName(client, base.appToken, active.tableId, failedName);
      try {
        await patchTableName(client, base.appToken, backup.tableId, target.finalName);
      } catch (error) {
        await patchTableName(client, base.appToken, active.tableId, target.finalName).catch(() => undefined);
        throw error;
      }
      restored.push({ tenantId: tenant.binding.id, tableName: target.finalName, restoredTableId: backup.tableId, retainedFailedTableId: active.tableId, failedName });
    }
    await verifyAccountSidePlanWithClient(client, base, plans.get(tenant.binding.id)!, { preserveAccountManualFields: true });
  }
  const rollbackSnapshots = await snapshotAll(client, tenants);
  const originalIntegrity = compareOriginalIntegrity(initial, rollbackSnapshots);
  if (originalIntegrity.some((item) => item.ok !== true)) throw new Error("回切账号端表后，正式原有表哈希不一致");
  const result = {
    action: "rollback",
    evidence: "real-formal-feishu-name-rollback-and-plan-readback",
    completedAt: new Date().toISOString(),
    restored,
    originalIntegrity,
  };
  await writeJsonAtomic(path.join(REPORT_ROOT, "rollback.json"), result);
  console.log(JSON.stringify(result, null, 2));
} else {
  requireConfirmation(CLEANUP_CONFIRMATION);
  await assertDailyJobsIdle(tenants);
  const rollback = JSON.parse(await readFile(path.join(REPORT_ROOT, "rollback.json"), "utf8")) as {
    action: string;
    restored: Array<{ tenantId: string; tableName: TargetName; restoredTableId: string; retainedFailedTableId: string; failedName: string }>;
  };
  if (rollback.action !== "rollback" || rollback.restored.length !== tenants.length * TARGETS.length) {
    throw new Error("缺少完整的安全回切记录，拒绝清理失败副本");
  }
  const plans = await loadPlans(tenants, initial);
  const deleted = [];
  for (const tenant of tenants) {
    const base = formalBase(tenant);
    await verifyAccountSidePlanWithClient(client, base, plans.get(tenant.binding.id)!, { preserveAccountManualFields: true });
    const tables = await listTables(client, base.appToken);
    for (const item of rollback.restored.filter((entry) => entry.tenantId === tenant.binding.id)) {
      const active = requireUniqueTable(tables, item.tableName, tenant.binding.id);
      if (active.tableId !== item.restoredTableId) throw new Error(`${tenant.binding.id}/${item.tableName}活动表ID异常，拒绝清理`);
      const failed = requireUniqueTable(tables, item.failedName, tenant.binding.id);
      if (failed.tableId !== item.retainedFailedTableId) throw new Error(`${tenant.binding.id}/${item.failedName}失败副本ID异常，拒绝清理`);
      await withFeishuRetry(async () => {
        const current = await client.bitable.appTable.delete({ path: { app_token: base.appToken, table_id: failed.tableId } });
        assertFeishuResponse(current, `删除${tenant.binding.id}/${item.failedName}`);
        return current;
      });
      deleted.push({ tenantId: tenant.binding.id, tableName: item.failedName, tableId: failed.tableId });
    }
  }
  const cleanupSnapshots = await snapshotAll(client, tenants);
  const originalIntegrity = compareOriginalIntegrity(initial, cleanupSnapshots);
  if (originalIntegrity.some((item) => item.ok !== true)) throw new Error("清理失败副本后，正式原有表哈希不一致");
  const result = {
    action: "cleanup-failed",
    evidence: "real-formal-feishu-delete-exact-agent-created-failed-copies-and-readback",
    completedAt: new Date().toISOString(),
    deleted,
    originalIntegrity,
    tableCounts: cleanupSnapshots.map((snapshot) => ({ tenantId: snapshot.tenantId, tableCount: snapshot.tables.length })),
  };
  await writeJsonAtomic(path.join(REPORT_ROOT, "cleanup.json"), result);
  console.log(JSON.stringify(result, null, 2));
}

function assertFormalIdentity(env: AppEnv): void {
  if (env.FEISHU_APP_ID !== FORMAL_APP_ID) throw new Error(`当前飞书应用不是指定正式应用（${env.FEISHU_APP_ID || "空"}）`);
  let host = "";
  try { host = new URL(env.FEISHU_BITABLE_URL).hostname; } catch { throw new Error("正式Base地址无效"); }
  if (!host.endsWith(".feishu.cn") || host.startsWith("test-")) throw new Error(`当前不是正式飞书企业Base（${host || "空"}）`);
}

function assertExactFormalTenants(values: ResolvedTenant[]): void {
  const actual = new Set(values.map((tenant) => tenant.binding.id));
  if (actual.size !== EXPECTED_TENANTS.size || [...EXPECTED_TENANTS].some((id) => !actual.has(id))) {
    throw new Error(`正式租户集合不符合预期：${[...actual].sort().join("、")}`);
  }
  for (const tenant of values) assertFormalIdentity(tenant.env);
}

function assertInitialManifest(value: InitialManifest): void {
  if (!value.runDirectory || value.applied.length !== EXPECTED_TENANTS.size) throw new Error("正式账号端初始安装清单无效");
  if (value.originalIntegrity.some((item) => !item.ok)) throw new Error("正式账号端初始安装清单存在原表完整性失败项");
}

function requireConfirmation(expected: string): void {
  const index = args.indexOf("--confirm");
  const actual = index >= 0 ? args[index + 1] : "";
  if (actual !== expected) throw new Error(`正式操作必须提供 --confirm ${expected}`);
}

async function assertDailyJobsIdle(values: ResolvedTenant[]): Promise<void> {
  for (const tenant of values) {
    const statusPath = path.join(PROJECT_ROOT, ".runtime", "tenants", tenant.binding.id, "daily-automation", "status.json");
    const status = JSON.parse(await readFile(statusPath, "utf8")) as { running?: boolean };
    if (status.running !== false) throw new Error(`${tenant.binding.id}日更仍在运行，拒绝正式写入`);
  }
}

async function loadPlans(values: ResolvedTenant[], manifest: InitialManifest): Promise<Map<string, AccountSidePlan>> {
  const result = new Map<string, AccountSidePlan>();
  for (const tenant of values) {
    const plan = JSON.parse(await readFile(path.join(manifest.runDirectory, tenant.binding.id, "plan.json"), "utf8")) as AccountSidePlan;
    if (normalizeCore(plan.shop.name) !== normalizeCore(tenant.profile.businessDisplayName)) {
      throw new Error(`${tenant.binding.id}保存的账号端计划店铺身份不一致`);
    }
    result.set(tenant.binding.id, plan);
  }
  return result;
}

async function auditTenant(clientValue: Client, tenant: ResolvedTenant, manifest: InitialManifest): Promise<Record<string, unknown>> {
  const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
  const tables = await listTables(clientValue, appToken);
  const expectedOld = expectedAccountTableIds(manifest, tenant.binding.id);
  const targets = [];
  for (const target of TARGETS) {
    const current = requireUniqueTable(tables, target.finalName, tenant.binding.id);
    const staging = requireUniqueTable(tables, target.stagingName, tenant.binding.id);
    const [stagingFields, stagingRecords, stagingViews] = await Promise.all([
      listRawFields(clientValue, appToken, staging.tableId),
      listRecords(clientValue, appToken, staging.tableId),
      listViews(clientValue, appToken, staging.tableId),
    ]);
    targets.push({
      finalName: target.finalName,
      current: { ...current, expectedInitialId: expectedOld.get(target.finalName), idMatches: current.tableId === expectedOld.get(target.finalName) },
      staging: { ...staging, fields: stagingFields.length, records: stagingRecords.length, views: stagingViews },
    });
  }
  return { tenantId: tenant.binding.id, storeName: tenant.profile.businessDisplayName, tableCount: tables.length, targets };
}

async function rebuildStagingTable(clientValue: Client, tenant: ResolvedTenant, tableId: string, targetName: TargetName): Promise<void> {
  const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
  const [records, views, fields] = await Promise.all([
    listRecords(clientValue, appToken, tableId),
    listViews(clientValue, appToken, tableId),
    listRawFields(clientValue, appToken, tableId),
  ]);
  if (records.length !== 0) throw new Error(`${tenant.binding.id}/${targetName}部署副本不是空表，拒绝重建字段`);
  if (!views.some((view) => view.viewType === "unknown" || /经营工作台/.test(view.viewName))) {
    throw new Error(`${tenant.binding.id}/${targetName}部署副本没有插件视图，拒绝重建字段`);
  }
  const definition = ACCOUNT_SIDE_TABLES.find((item) => item.name === targetName);
  if (!definition) throw new Error(`缺少${targetName}字段定义`);
  const primary = fields.find((field) => field.is_primary)
    ?? fields.find((field) => field.field_name === "商品" && field.type === 1)
    ?? fields[0];
  if (!primary?.field_id) throw new Error(`${tenant.binding.id}/${targetName}无法确定主字段`);

  const deletable = fields.filter((field) => field.field_id && field.field_id !== primary.field_id);
  const ordered = [...deletable.filter((field) => field.type === 20), ...deletable.filter((field) => field.type !== 20)];
  for (const field of ordered) {
    await withFeishuRetry(async () => {
      const current = await clientValue.bitable.appTableField.delete({
        path: { app_token: appToken, table_id: tableId, field_id: field.field_id! },
      });
      assertFeishuResponse(current, `重建${tenant.binding.id}/${targetName}：删除副本字段${field.field_name ?? field.field_id}`);
      return current;
    });
  }

  await withFeishuRetry(async () => {
    const current = await clientValue.bitable.appTableField.update({
      path: { app_token: appToken, table_id: tableId, field_id: primary.field_id! },
      data: definition.fields[0] as never,
    });
    assertFeishuResponse(current, `重建${tenant.binding.id}/${targetName}：设置主字段`);
    return current;
  });
  for (const field of definition.fields.slice(1)) {
    await withFeishuRetry(async () => {
      const current = await clientValue.bitable.appTableField.create({
        path: { app_token: appToken, table_id: tableId },
        data: field as never,
      });
      assertFeishuResponse(current, `重建${tenant.binding.id}/${targetName}：新增字段${field.field_name}`);
      return current;
    });
  }
  const verified = await listFields(clientValue, appToken, tableId);
  const expected = new Map(definition.fields.map((field) => [field.field_name, field.type]));
  const actual = new Map(verified.map((field) => [field.fieldName, field.type]));
  const missing = [...expected].filter(([name, type]) => actual.get(name) !== type);
  const extra = [...actual].filter(([name]) => !expected.has(name));
  if (verified.length !== definition.fields.length || missing.length || extra.length) {
    throw new Error(`${tenant.binding.id}/${targetName}字段重建回读不一致：缺失${missing.map(([name]) => name).join("、") || "无"}；多余${extra.map(([name]) => name).join("、") || "无"}`);
  }
}

async function patchTableName(clientValue: Client, appToken: string, tableId: string, name: string): Promise<void> {
  await withFeishuRetry(async () => {
    const current = await clientValue.bitable.appTable.patch({ path: { app_token: appToken, table_id: tableId }, data: { name } });
    assertFeishuResponse(current, `重命名正式数据表为${name}`);
    return current;
  });
}

async function listRawFields(clientValue: Client, appToken: string, tableId: string): Promise<RawField[]> {
  const result: RawField[] = [];
  let pageToken: string | undefined;
  do {
    const response = await withFeishuRetry(async () => {
      const current = await clientValue.bitable.appTableField.list({
        path: { app_token: appToken, table_id: tableId },
        params: { page_size: 100, page_token: pageToken },
      });
      assertFeishuResponse(current, "读取正式部署副本字段");
      return current;
    });
    result.push(...(response.data?.items ?? []) as RawField[]);
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return result;
}

function requireUniqueTable(tables: Array<{ tableId: string; name: string }>, name: string, tenantId: string): { tableId: string; name: string } {
  const matches = tables.filter((table) => table.name === name);
  if (matches.length !== 1) throw new Error(`${tenantId}无法唯一定位数据表“${name}”（${matches.length}）`);
  return matches[0];
}

function expectedAccountTableIds(manifest: InitialManifest, tenantId: string): Map<TargetName, string> {
  const applied = manifest.applied.find((item) => item.tenantId === tenantId);
  if (!applied) throw new Error(`初始安装清单缺少${tenantId}`);
  return new Map(TARGETS.map((target) => {
    const item = applied.schema.verification.find((verification) => verification.table === target.finalName);
    if (!item?.tableId) throw new Error(`初始安装清单缺少${tenantId}/${target.finalName}表ID`);
    return [target.finalName, item.tableId];
  }));
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

async function snapshotAll(clientValue: Client, values: ResolvedTenant[]): Promise<BaseSnapshot[]> {
  const result: BaseSnapshot[] = [];
  for (const tenant of values) {
    const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
    const refs = (await listTables(clientValue, appToken)).sort(sortById);
    const tables: TableSnapshot[] = [];
    for (const table of refs) {
      const [fields, records, views] = await Promise.all([
        listFields(clientValue, appToken, table.tableId),
        listRecords(clientValue, appToken, table.tableId),
        listViews(clientValue, appToken, table.tableId),
      ]);
      tables.push({ ...table, fields: fields.sort(sortById), records: records.sort(sortById), views: views.sort(sortById) });
    }
    result.push({ capturedAt: new Date().toISOString(), tenantId: tenant.binding.id, storeName: tenant.profile.businessDisplayName, tables });
  }
  return result;
}

function assertOriginalIntegrity(manifest: InitialManifest, snapshots: BaseSnapshot[]): void {
  const result = compareOriginalIntegrity(manifest, snapshots);
  const failures = result.filter((item) => item.ok !== true);
  if (failures.length) throw new Error(`正式原有表在插件视图切换前已与初始快照不一致：${failures.map((item) => `${item.tenantId}/${item.tableName}`).join("、")}`);
}

function compareOriginalIntegrity(manifest: InitialManifest, snapshots: BaseSnapshot[]): Array<Record<string, unknown>> {
  return manifest.originalIntegrity.map((baseline) => {
    const current = snapshots.find((item) => item.tenantId === baseline.tenantId)?.tables.find((table) => table.tableId === baseline.tableId);
    const currentHash = current ? sha256(current) : "missing";
    return {
      tenantId: baseline.tenantId,
      tableName: baseline.tableName,
      tableId: baseline.tableId,
      baselineHash: baseline.afterHash,
      currentHash,
      ok: currentHash === baseline.afterHash,
    };
  });
}

async function saveSnapshots(directory: string, label: string, snapshots: BaseSnapshot[]): Promise<void> {
  await Promise.all(snapshots.map((snapshot) => writeJsonAtomic(path.join(directory, snapshot.tenantId, `${label}.json`), snapshot)));
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
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
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
