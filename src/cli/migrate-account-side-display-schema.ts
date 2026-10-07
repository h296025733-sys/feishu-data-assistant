import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import { getEnv, requireFeishuEnv, type AppEnv } from "../config/env.js";
import { TenantRegistry, type ResolvedTenant } from "../config/tenant-registry.js";
import {
  ACCOUNT_SIDE_TABLES,
  assertTestEnterpriseEnv,
  listRecords,
  listTables,
  listViews,
  type AccountSideBase,
  type FieldDefinition,
} from "../feishu/account-side-test.js";
import { assertFeishuResponse, createFeishuClient, withFeishuRetry } from "../feishu/client.js";

const PROJECT_ROOT = String.raw`D:\workspace\feishu-data-assistant-poc`;
const REPORT_ROOT = path.join(PROJECT_ROOT, ".runtime", "account-side-schema-migration");
const FORMAL_APP_ID = "demo_ded47f35";
const EXPECTED_FORMAL_TENANTS = new Set(["storetwo-formal", "storeone-formal"]);
const TARGET_TABLE_NAMES = new Set(["视频号信息统计", "短视频数据表"]);
const CONFIRMATION = "ACCOUNT-SIDE-DISPLAY-SCHEMA-V3-20260817";
const OLD_ACCOUNT_FIELDS = new Set(["账号键", "店铺", "负责人", "账号名", "UID", "账号主页", "账号类型", "状态", "备注", "数据更新时间"]);
const OLD_VIDEO_FIELDS = new Set([
  "视频商品键", "店铺", "账号", "账号UID", "账号类型", "视频ID", "视频链接", "发布时间（北京时间）",
  "商品", "TikTok商品ID", "视频曝光", "视频出单量", "售出数量", "销售额", "指标起始日", "指标截止日",
  "数据更新时间", "数据状态",
]);

interface RawField {
  field_id?: string;
  field_name?: string;
  type?: number;
  ui_type?: string;
  is_primary?: boolean;
  property?: Record<string, unknown>;
}

interface BaseSnapshot {
  capturedAt: string;
  storeName: string;
  appToken: string;
  tables: Array<{
    tableId: string;
    name: string;
    fields: RawField[];
    records: Awaited<ReturnType<typeof listRecords>>;
    views: Awaited<ReturnType<typeof listViews>>;
  }>;
}

const args = process.argv.slice(2).filter((value) => value !== "--");
const scope = argument("--scope") ?? "formal";
const recoveryDirectory = argument("--recover-from");
const apply = args.includes("--apply");
const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env);
const targets = scope === "test" ? testTargets(env) : formalTargets(env);

if (apply) {
  requireConfirmation();
  if (scope === "formal") await assertDailyJobsIdle(targets);
}

const runDirectory = path.join(
  REPORT_ROOT,
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${scope}-${apply ? "apply" : "audit"}`,
);
const before = [];
for (const target of targets) before.push(await snapshotBase(client, target.base));
await Promise.all(before.map((snapshot) => writeJsonAtomic(
  path.join(runDirectory, safeName(snapshot.storeName), "before.json"),
  snapshot,
)));

if (!apply) {
  const result = {
    action: "audit",
    scope,
    evidence: scope === "formal" ? "real-formal-feishu-api-read-only" : "real-test-enterprise-feishu-api-read-only",
    checkedAt: new Date().toISOString(),
    runDirectory,
    bases: before.map(summarizeSnapshot),
  };
  await writeJsonAtomic(path.join(runDirectory, "result.json"), result);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const applied = [];
for (const target of targets) {
  const prior = before.find((item) => item.storeName === target.base.storeName)!;
  const recovery = recoveryDirectory ? await readRecoverySnapshot(recoveryDirectory, target.base.storeName) : undefined;
  applied.push(await migrateBase(client, target.base, prior, recovery));
}

const after = [];
for (const target of targets) after.push(await snapshotBase(client, target.base));
await Promise.all(after.map((snapshot) => writeJsonAtomic(
  path.join(runDirectory, safeName(snapshot.storeName), "after.json"),
  snapshot,
)));
const unaffectedIntegrity = compareUnaffected(before, after);
if (unaffectedIntegrity.some((item) => !item.ok)) {
  throw new Error("非目标表在迁移前后不一致，已停止；请查阅本地完整快照");
}
if (scope === "formal") await assertDailyJobsIdle(targets);

const result = {
  action: "apply",
  scope,
  evidence: scope === "formal"
    ? "real-formal-feishu-schema-write-record-migration-and-readback"
    : "real-test-enterprise-feishu-schema-write-record-migration-and-readback",
  completedAt: new Date().toISOString(),
  runDirectory,
  applied,
  unaffectedIntegrity,
};
await writeJsonAtomic(path.join(runDirectory, "result.json"), result);
await writeJsonAtomic(path.join(REPORT_ROOT, `latest-${scope}.json`), result);
console.log(JSON.stringify(result, null, 2));

function testTargets(value: AppEnv): Array<{ id: string; base: AccountSideBase }> {
  assertTestEnterpriseEnv(value);
  return [{
    id: "storeone-existing-test-base",
    base: {
      storeKey: "storeone-test",
      storeName: "STOREONE",
      appToken: value.FEISHU_BITABLE_APP_TOKEN,
      name: "店铺经营工作台模板",
      url: value.FEISHU_BITABLE_URL,
      createdAt: "existing-test-base",
    },
  }];
}

function formalTargets(value: AppEnv): Array<{ id: string; base: AccountSideBase }> {
  assertFormalIdentity(value);
  const tenants = new TenantRegistry(value).all().sort((left, right) => left.binding.id.localeCompare(right.binding.id));
  const actual = new Set(tenants.map((tenant) => tenant.binding.id));
  if (actual.size !== EXPECTED_FORMAL_TENANTS.size || [...EXPECTED_FORMAL_TENANTS].some((id) => !actual.has(id))) {
    throw new Error(`正式租户集合不符合预期：${[...actual].sort().join("、")}`);
  }
  return tenants.map((tenant) => ({ id: tenant.binding.id, base: formalBase(tenant) }));
}

function assertFormalIdentity(value: AppEnv): void {
  if (value.FEISHU_APP_ID !== FORMAL_APP_ID) throw new Error("当前不是指定正式应用，拒绝执行正式字段迁移");
  const host = new URL(value.FEISHU_BITABLE_URL).hostname;
  if (!host.endsWith(".feishu.cn") || host.startsWith("test-")) throw new Error(`当前不是正式企业Base：${host}`);
}

function formalBase(tenant: ResolvedTenant): AccountSideBase {
  assertFormalIdentity(tenant.env);
  return {
    storeKey: tenant.binding.id,
    storeName: tenant.profile.businessDisplayName,
    appToken: tenant.env.FEISHU_BITABLE_APP_TOKEN,
    name: tenant.profile.businessDisplayName,
    url: tenant.env.FEISHU_BITABLE_URL,
    createdAt: "existing-formal-base",
  };
}

async function assertDailyJobsIdle(values: Array<{ id: string }>): Promise<void> {
  for (const item of values) {
    const statusPath = path.join(PROJECT_ROOT, ".runtime", "tenants", item.id, "daily-automation", "status.json");
    const status = JSON.parse(await readFile(statusPath, "utf8")) as { running?: boolean };
    if (status.running !== false) throw new Error(`${item.id}日更仍在运行，拒绝字段迁移`);
  }
}

async function migrateBase(
  clientValue: Client,
  base: AccountSideBase,
  before: BaseSnapshot,
  recovery?: BaseSnapshot,
): Promise<Record<string, unknown>> {
  const account = requireTable(before, "视频号信息统计");
  const video = requireTable(before, "短视频数据表");
  const accountResult = await migrateTable(
    clientValue,
    base,
    account,
    definition("视频号信息统计"),
    OLD_ACCOUNT_FIELDS,
    accountTargetFields,
    recovery ? requireTable(recovery, "视频号信息统计") : undefined,
  );
  const videoResult = await migrateTable(
    clientValue,
    base,
    video,
    definition("短视频数据表"),
    OLD_VIDEO_FIELDS,
    videoTargetFields,
    recovery ? requireTable(recovery, "短视频数据表") : undefined,
  );
  return { storeName: base.storeName, account: accountResult, video: videoResult };
}

async function migrateTable(
  clientValue: Client,
  base: AccountSideBase,
  prior: BaseSnapshot["tables"][number],
  target: { name: string; fields: FieldDefinition[] },
  oldNames: Set<string>,
  transform: (fields: Record<string, unknown>) => Record<string, unknown>,
  recovery?: BaseSnapshot["tables"][number],
): Promise<Record<string, unknown>> {
  const currentNames = prior.fields.map((field) => String(field.field_name ?? ""));
  const targetNames = target.fields.map((field) => field.field_name);
  const alreadyMigrated = sameSet(currentNames, targetNames);
  const exactOld = sameSet(currentNames, [...oldNames]);
  const additiveUpgrade = currentNames.length < targetNames.length
    && currentNames.every((name) => targetNames.includes(name))
    && target.fields.filter((field) => !currentNames.includes(field.field_name)).every((field) => field.field_name !== target.fields[0]?.field_name);
  const recoverablePartialOld = Boolean(recovery)
    && currentNames.length > 0
    && currentNames.every((name) => oldNames.has(name))
    && sameSet(recovery!.fields.map((field) => String(field.field_name ?? "")), [...oldNames])
    && recovery!.tableId === prior.tableId;
  if (!alreadyMigrated && !exactOld && !recoverablePartialOld && !additiveUpgrade) {
    throw new Error(`${base.storeName}/${target.name}字段既不是旧版也不是目标版，拒绝猜测迁移：${currentNames.join("、")}`);
  }
  if (alreadyMigrated) {
    await verifyMigratedTable(clientValue, base, prior.tableId, target, prior.records.length);
    return { table: target.name, changed: false, records: prior.records.length, fields: targetNames };
  }
  if (additiveUpgrade) {
    const missingFields = target.fields.filter((field) => !currentNames.includes(field.field_name));
    for (const field of missingFields) {
      await withFeishuRetry(async () => {
        const response = await clientValue.bitable.appTableField.create({
          path: { app_token: base.appToken, table_id: prior.tableId },
          data: field as never,
        });
        assertFeishuResponse(response, `新增${base.storeName}/${target.name}字段${field.field_name}`);
        return response;
      });
    }
    await verifyMigratedTable(clientValue, base, prior.tableId, target, prior.records.length);
    return { table: target.name, changed: true, mode: "additive", records: prior.records.length, fields: targetNames };
  }

  const sourceRecords = recoverablePartialOld ? recovery!.records : prior.records;
  if (sourceRecords.length !== prior.records.length) {
    throw new Error(`${base.storeName}/${target.name}恢复快照记录数与当前表不一致，拒绝迁移`);
  }
  const currentRecordIds = new Set(prior.records.map((record) => record.recordId));
  if (sourceRecords.some((record) => !currentRecordIds.has(record.recordId))) {
    throw new Error(`${base.storeName}/${target.name}恢复快照记录ID与当前表不一致，拒绝迁移`);
  }
  const transformed = new Map(sourceRecords.map((record) => [record.recordId, transform(record.fields)]));
  for (const [recordId, fields] of transformed) {
    // Preserve pre-existing completely blank placeholder rows.  They are not
    // business records, but deleting them would be an unnecessary destructive
    // action and filling them with guessed values would be worse.
    if (Object.keys(fields).length === 0) continue;
    const manualAccountFields = new Set(["负责人", "UID", "账号", "密码", "备注"]);
    const missing = targetNames.filter((name) => !manualAccountFields.has(name) && !meaningful(fields[name]));
    if (missing.length) throw new Error(`${base.storeName}/${target.name}/${recordId}迁移值缺少：${missing.join("、")}`);
  }
  const primary = prior.fields.find((field) => field.is_primary) ?? prior.fields[0];
  if (!primary?.field_id) throw new Error(`${base.storeName}/${target.name}无法确定主字段`);

  for (const field of prior.fields.filter((field) => field.field_id && field.field_id !== primary.field_id)) {
    await withFeishuRetry(async () => {
      const response = await clientValue.bitable.appTableField.delete({
        path: { app_token: base.appToken, table_id: prior.tableId, field_id: field.field_id! },
      });
      // A successful delete can lose its HTTP acknowledgement.  The retry then
      // receives FieldIdNotFound even though the desired state was achieved.
      if (response.code === 1254044) return response;
      assertFeishuResponse(response, `删除${base.storeName}/${target.name}旧字段${field.field_name ?? field.field_id}`);
      return response;
    });
  }
  await withFeishuRetry(async () => {
    const response = await clientValue.bitable.appTableField.update({
      path: { app_token: base.appToken, table_id: prior.tableId, field_id: primary.field_id! },
      data: target.fields[0] as never,
    });
    assertFeishuResponse(response, `重设${base.storeName}/${target.name}主字段`);
    return response;
  });
  for (const field of target.fields.slice(1)) {
    await withFeishuRetry(async () => {
      const response = await clientValue.bitable.appTableField.create({
        path: { app_token: base.appToken, table_id: prior.tableId },
        data: field as never,
      });
      assertFeishuResponse(response, `创建${base.storeName}/${target.name}字段${field.field_name}`);
      return response;
    });
  }

  const updates = [...transformed].map(([record_id, values]) => ({ record_id, fields: values }));
  for (const batch of chunks(updates, 500)) {
    const response = await withFeishuRetry(async () => {
      const current = await clientValue.bitable.appTableRecord.batchUpdate({
        path: { app_token: base.appToken, table_id: prior.tableId },
        params: { client_token: randomUUID() },
        data: { records: batch as never },
      });
      assertFeishuResponse(current, `回填${base.storeName}/${target.name}迁移记录`);
      return current;
    });
    if ((response.data?.records?.length ?? 0) !== batch.length) throw new Error(`${base.storeName}/${target.name}回填数量不一致`);
  }

  const verified = await verifyMigratedTable(clientValue, base, prior.tableId, target, prior.records.length);
  for (const record of verified.records) {
    const expected = transformed.get(record.recordId);
    if (!expected || !managedFieldsEqual(record.fields, expected)) {
      throw new Error(`${base.storeName}/${target.name}/${record.recordId}迁移值回读不一致`);
    }
  }
  return { table: target.name, changed: true, records: prior.records.length, fields: targetNames };
}

async function readRecoverySnapshot(directory: string, storeName: string): Promise<BaseSnapshot> {
  const resolvedDirectory = path.resolve(directory);
  if (!resolvedDirectory.startsWith(path.resolve(REPORT_ROOT) + path.sep)) {
    throw new Error(`恢复快照必须位于${REPORT_ROOT}内`);
  }
  const snapshotPath = path.join(resolvedDirectory, safeName(storeName), "before.json");
  const parsed = JSON.parse(await readFile(snapshotPath, "utf8")) as BaseSnapshot;
  if (parsed.storeName !== storeName) throw new Error(`${storeName}恢复快照店铺身份不匹配`);
  return parsed;
}

async function verifyMigratedTable(
  clientValue: Client,
  base: AccountSideBase,
  tableId: string,
  target: { name: string; fields: FieldDefinition[] },
  expectedRecords: number,
): Promise<{ fields: RawField[]; records: Awaited<ReturnType<typeof listRecords>> }> {
  const [fields, records] = await Promise.all([
    listRawFields(clientValue, base.appToken, tableId),
    listRecords(clientValue, base.appToken, tableId),
  ]);
  const expected = new Map(target.fields.map((field) => [field.field_name, field.type]));
  const actual = new Map(fields.map((field) => [String(field.field_name ?? ""), Number(field.type ?? 0)]));
  const missing = [...expected].filter(([name, type]) => actual.get(name) !== type);
  const extra = [...actual].filter(([name]) => !expected.has(name));
  if (fields.length !== target.fields.length || missing.length || extra.length) {
    throw new Error(`${base.storeName}/${target.name}字段回读不一致：缺失${missing.map(([name]) => name).join("、") || "无"}；多余${extra.map(([name]) => name).join("、") || "无"}`);
  }
  if (records.length !== expectedRecords) throw new Error(`${base.storeName}/${target.name}记录数由${expectedRecords}变为${records.length}`);
  return { fields, records };
}

export function accountTargetFields(fields: Record<string, unknown>): Record<string, unknown> {
  if (!hasMeaningfulField(fields)) return {};
  return compact({
    负责人: textValue(fields.负责人),
    账号名: textValue(fields.账号名),
    UID: textValue(fields.UID),
    账号: textValue(fields.账号),
    密码: textValue(fields.密码),
    账号主页: urlValue(fields.账号主页),
    账号类型: textValue(fields.账号类型),
    备注: textValue(fields.备注),
  });
}

export function videoTargetFields(fields: Record<string, unknown>): Record<string, unknown> {
  if (!hasMeaningfulField(fields)) return {};
  return compact({
    达人昵称: textValue(fields.账号 ?? fields.达人昵称),
    达人ID: textValue(fields.账号UID ?? fields.达人ID),
    视频ID网址: urlLink(fields.视频链接 ?? fields.视频ID网址),
    发布时间: fields["发布时间（北京时间）"] ?? fields.发布时间,
    商品: textValue(fields.商品),
    视频vv: numberValue(fields.视频曝光 ?? fields.视频vv),
    视频商品成交件数: numberValue(fields.售出数量 ?? fields.视频商品成交件数),
    "商品交易总额（视频） ($)": numberValue(fields.销售额 ?? fields["商品交易总额（视频） ($)"]),
  });
}

async function snapshotBase(clientValue: Client, base: AccountSideBase): Promise<BaseSnapshot> {
  const tables = await listTables(clientValue, base.appToken);
  const snapshots: BaseSnapshot["tables"] = [];
  for (const table of tables) {
    const [fields, records, views] = await Promise.all([
      listRawFields(clientValue, base.appToken, table.tableId),
      listRecords(clientValue, base.appToken, table.tableId),
      listViews(clientValue, base.appToken, table.tableId),
    ]);
    snapshots.push({ tableId: table.tableId, name: table.name, fields, records, views });
  }
  return { capturedAt: new Date().toISOString(), storeName: base.storeName, appToken: base.appToken, tables: snapshots };
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
      assertFeishuResponse(current, "读取字段");
      return current;
    });
    result.push(...(response.data?.items ?? []) as RawField[]);
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return result;
}

function summarizeSnapshot(snapshot: BaseSnapshot): Record<string, unknown> {
  return {
    storeName: snapshot.storeName,
    tables: snapshot.tables.filter((table) => TARGET_TABLE_NAMES.has(table.name)).map((table) => ({
      table: table.name,
      tableId: table.tableId,
      records: table.records.length,
      fields: table.fields.map((field) => field.field_name),
      targetFields: definition(table.name).fields.map((field) => field.field_name),
      nonEmptyUid: table.name === "视频号信息统计" ? table.records.filter((record) => meaningful(record.fields.UID)).length : undefined,
      nonEmptyNotes: table.name === "视频号信息统计" ? table.records.filter((record) => meaningful(record.fields.备注)).length : undefined,
    })),
  };
}

function compareUnaffected(before: BaseSnapshot[], after: BaseSnapshot[]): Array<Record<string, unknown>> {
  const result = [];
  for (const priorBase of before) {
    const currentBase = after.find((item) => item.storeName === priorBase.storeName);
    if (!currentBase) throw new Error(`缺少${priorBase.storeName}写后快照`);
    for (const table of priorBase.tables.filter((item) => !TARGET_TABLE_NAMES.has(item.name))) {
      const current = currentBase.tables.find((item) => item.tableId === table.tableId);
      const beforeHash = sha256(table);
      const afterHash = current ? sha256(current) : "missing";
      result.push({ storeName: priorBase.storeName, table: table.name, tableId: table.tableId, beforeHash, afterHash, ok: beforeHash === afterHash });
    }
  }
  return result;
}

function definition(name: string): { name: string; fields: FieldDefinition[] } {
  const found = ACCOUNT_SIDE_TABLES.find((item) => item.name === name);
  if (!found) throw new Error(`缺少${name}目标字段定义`);
  return found;
}

function requireTable(snapshot: BaseSnapshot, name: string): BaseSnapshot["tables"][number] {
  const matches = snapshot.tables.filter((table) => table.name === name);
  if (matches.length !== 1) throw new Error(`${snapshot.storeName}无法唯一定位${name}`);
  return matches[0];
}

function requireConfirmation(): void {
  const index = args.indexOf("--confirm");
  const actual = index >= 0 ? args[index + 1] : "";
  if (actual !== CONFIRMATION) throw new Error(`写入必须提供 --apply --confirm ${CONFIRMATION}`);
}

function argument(name: string): string | null {
  const index = args.indexOf(name);
  const value = index >= 0 ? String(args[index + 1] ?? "").trim() : "";
  return value || null;
}

function urlValue(value: unknown): { text: string; link: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const link = String(item.link ?? "").trim();
  if (!link) return undefined;
  return { text: String(item.text ?? link).trim(), link };
}

function urlLink(value: unknown): string {
  if (value && typeof value === "object") return String((value as Record<string, unknown>).link ?? "").trim();
  return String(value ?? "").trim();
}

function textValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(textValue).join("").trim();
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return String(item.text ?? item.name ?? item.value ?? "").trim();
  }
  return String(value ?? "").trim();
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) throw new Error(`无法迁移数值：${String(value)}`);
  return number;
}

function compact(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function meaningful(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  return !Array.isArray(value) || value.length > 0;
}

function hasMeaningfulField(fields: Record<string, unknown>): boolean {
  return Object.values(fields).some(meaningful);
}

function managedFieldsEqual(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([name, value]) => normalized(value) === normalized(actual[name]));
}

function normalized(value: unknown): string {
  if (typeof value === "number") return String(Math.round(value * 1_000_000) / 1_000_000);
  if (Array.isArray(value)) return JSON.stringify(value.map(normalized).sort());
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    if ("link" in item || "text" in item) return JSON.stringify({ text: String(item.text ?? ""), link: String(item.link ?? "") });
    return stableStringify(value);
  }
  return String(value ?? "");
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").toUpperCase();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "capturedAt")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeName(value: string): string {
  return value.replace(/[^\p{L}\p{N}._-]+/gu, "-");
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}
