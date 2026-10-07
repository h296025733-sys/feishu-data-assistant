import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import { getEnv, requireFeishuEnv, type AppEnv } from "../config/env.js";
import { TenantRegistry, type ResolvedTenant } from "../config/tenant-registry.js";
import {
  ACCOUNT_SIDE_TABLES,
  assertTestEnterpriseEnv,
  listFields,
  listRecords,
  listTables,
  listViews,
  type AccountSideBase,
  type FieldDefinition,
} from "../feishu/account-side-test.js";
import { assertFeishuResponse, createFeishuClient, withFeishuRetry } from "../feishu/client.js";
import { viewsToK } from "../feishu/account-side-test.js";

const PROJECT_ROOT = String.raw`D:\workspace\feishu-data-assistant-poc`;
const REPORT_ROOT = path.join(PROJECT_ROOT, ".runtime", "account-side-video-display-migration");
const FORMAL_APP_ID = "demo_ded47f35";
const EXPECTED_FORMAL_TENANTS = new Set(["storetwo-formal", "storeone-formal"]);
const CONFIRMATION = "ACCOUNT-SIDE-VIDEO-DISPLAY-V2-20260817";
const TARGET_TABLES = new Set(["视频号信息统计", "短视频数据表"]);

interface Target {
  id: string;
  base: AccountSideBase;
}

interface Snapshot {
  storeName: string;
  tables: Array<{
    tableId: string;
    name: string;
    fields: Awaited<ReturnType<typeof listFields>>;
    records: Awaited<ReturnType<typeof listRecords>>;
    views: Awaited<ReturnType<typeof listViews>>;
  }>;
}

const args = process.argv.slice(2).filter((value) => value !== "--");
const scope = argument("--scope") ?? "formal";
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
const before: Snapshot[] = [];
for (const target of targets) before.push(await snapshotBase(client, target.base));
await Promise.all(before.map((snapshot) => writeJsonAtomic(path.join(runDirectory, safeName(snapshot.storeName), "before.json"), snapshot)));

const plans = before.map(planSnapshot);
if (!apply) {
  const result = { action: "audit", scope, evidence: `${scope}-feishu-api-read-only`, runDirectory, plans };
  await writeJsonAtomic(path.join(runDirectory, "result.json"), result);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const first = [];
for (const target of targets) {
  const snapshot = before.find((item) => item.storeName === target.base.storeName)!;
  first.push(await applyDisplayMigration(client, target.base, snapshot));
}
const replay = [];
for (const target of targets) {
  replay.push(await verifyAndReplay(client, target.base));
}

const after: Snapshot[] = [];
for (const target of targets) after.push(await snapshotBase(client, target.base));
await Promise.all(after.map((snapshot) => writeJsonAtomic(path.join(runDirectory, safeName(snapshot.storeName), "after.json"), snapshot)));
const unaffectedIntegrity = compareUnaffected(before, after);
if (unaffectedIntegrity.some((item) => !item.ok)) throw new Error("非目标表在迁移期间发生变化，已停止标记成功");
if (scope === "formal") await assertDailyJobsIdle(targets);

const result = {
  action: "apply",
  scope,
  evidence: `${scope}-feishu-write-readback-and-idempotent-replay`,
  completedAt: new Date().toISOString(),
  runDirectory,
  first,
  replay,
  unaffectedIntegrity,
};
await writeJsonAtomic(path.join(runDirectory, "result.json"), result);
await writeJsonAtomic(path.join(REPORT_ROOT, `latest-${scope}.json`), result);
console.log(JSON.stringify(result, null, 2));

async function applyDisplayMigration(clientValue: Client, base: AccountSideBase, snapshot: Snapshot): Promise<Record<string, unknown>> {
  const accountTable = requireTable(snapshot, "视频号信息统计");
  const videoTable = requireTable(snapshot, "短视频数据表");
  assertExactFields(accountTable, "视频号信息统计");
  assertExactFields(videoTable, "短视频数据表");
  const nicknames = accountNicknameMap(accountTable.records);
  const updates = desiredVideoUpdates(videoTable.records, nicknames);
  await writeUpdates(clientValue, base, videoTable.tableId, updates.records);
  const metadataUpdates = await updateDisplayMetadata(clientValue, base, videoTable.tableId, videoTable.fields);
  const verification = await verifyVideoRecords(clientValue, base, videoTable.tableId, nicknames);
  return { storeName: base.storeName, records: videoTable.records.length, recordUpdates: updates.changed, metadataUpdates, verification };
}

async function verifyAndReplay(clientValue: Client, base: AccountSideBase): Promise<Record<string, unknown>> {
  const snapshot = await snapshotBase(clientValue, base);
  const accountTable = requireTable(snapshot, "视频号信息统计");
  const videoTable = requireTable(snapshot, "短视频数据表");
  assertExactFields(accountTable, "视频号信息统计");
  assertExactFields(videoTable, "短视频数据表");
  const nicknames = accountNicknameMap(accountTable.records);
  const updates = desiredVideoUpdates(videoTable.records, nicknames);
  if (updates.changed) throw new Error(`${base.storeName}视频展示迁移复跑仍有${updates.changed}条待更新`);
  const metadataUpdates = await updateDisplayMetadata(clientValue, base, videoTable.tableId, videoTable.fields);
  if (metadataUpdates) throw new Error(`${base.storeName}视频字段元数据复跑仍有待更新`);
  return { storeName: base.storeName, recordUpdates: 0, metadataUpdates: 0, verification: await verifyVideoRecords(clientValue, base, videoTable.tableId, nicknames) };
}

function desiredVideoUpdates(
  records: Awaited<ReturnType<typeof listRecords>>,
  nicknames: Map<string, string>,
): { changed: number; records: Array<{ record_id: string; fields: Record<string, unknown> }> } {
  const updates = [];
  for (const record of records) {
    if (!Object.values(record.fields).some(meaningful)) continue;
    const handle = handleFromVideoUrl(record.fields.视频ID网址);
    const nickname = nicknames.get(handle.toLowerCase());
    if (!nickname) throw new Error(`${record.recordId}的@${handle}无法在视频号信息统计中唯一找到显示昵称`);
    const currentId = textValue(record.fields.达人ID);
    const alreadyK = currentId === `@${handle}`;
    const currentViews = finiteNumber(record.fields.视频vv, `${record.recordId}.视频vv`);
    const desired = {
      达人昵称: nickname,
      达人ID: `@${handle}`,
      视频vv: alreadyK ? currentViews : viewsToK(currentViews),
    };
    if (!sameDisplay(record.fields, desired)) updates.push({ record_id: record.recordId, fields: desired });
  }
  return { changed: updates.length, records: updates };
}

async function writeUpdates(
  clientValue: Client,
  base: AccountSideBase,
  tableId: string,
  records: Array<{ record_id: string; fields: Record<string, unknown> }>,
): Promise<void> {
  for (const batch of chunks(records, 500)) {
    const clientToken = randomUUID();
    const response = await withFeishuRetry(async () => {
      const current = await clientValue.bitable.appTableRecord.batchUpdate({
        path: { app_token: base.appToken, table_id: tableId },
        params: { client_token: clientToken },
        data: { records: batch as never },
      });
      assertFeishuResponse(current, `更新${base.storeName}短视频显示口径`);
      return current;
    });
    if ((response.data?.records?.length ?? 0) !== batch.length) throw new Error(`${base.storeName}短视频更新数量不一致`);
  }
}

async function updateDisplayMetadata(
  clientValue: Client,
  base: AccountSideBase,
  tableId: string,
  currentFields: Awaited<ReturnType<typeof listFields>>,
): Promise<number> {
  const definition = ACCOUNT_SIDE_TABLES.find((table) => table.name === "短视频数据表")!;
  const targetNames = new Set(["达人昵称", "达人ID", "视频vv"]);
  let changed = 0;
  for (const target of definition.fields.filter((field) => targetNames.has(field.field_name))) {
    const current = currentFields.find((field) => field.fieldName === target.field_name);
    if (!current) throw new Error(`${base.storeName}短视频数据表缺少${target.field_name}`);
    if (fieldMetadataMatches(current, target)) continue;
    const response = await withFeishuRetry(async () => {
      const value = await clientValue.bitable.appTableField.update({
        path: { app_token: base.appToken, table_id: tableId, field_id: current.fieldId },
        data: target as never,
      });
      assertFeishuResponse(value, `更新${base.storeName}/${target.field_name}字段说明`);
      return value;
    });
    void response;
    changed += 1;
  }
  return changed;
}

async function verifyVideoRecords(clientValue: Client, base: AccountSideBase, tableId: string, nicknames: Map<string, string>): Promise<Record<string, unknown>> {
  const records = await listRecords(clientValue, base.appToken, tableId);
  const desired = desiredVideoUpdates(records, nicknames);
  if (desired.changed) throw new Error(`${base.storeName}短视频显示口径写后回读仍有${desired.changed}条不一致`);
  const fields = await listFields(clientValue, base.appToken, tableId);
  const definition = ACCOUNT_SIDE_TABLES.find((table) => table.name === "短视频数据表")!;
  for (const name of ["达人昵称", "达人ID", "视频vv"]) {
    const current = fields.find((field) => field.fieldName === name);
    const target = definition.fields.find((field) => field.field_name === name)!;
    if (!current || !fieldMetadataMatches(current, target)) throw new Error(`${base.storeName}/${name}字段元数据回读不一致`);
  }
  return { ok: true, records: records.length, mismatches: 0 };
}

function accountNicknameMap(records: Awaited<ReturnType<typeof listRecords>>): Map<string, string> {
  const result = new Map<string, string>();
  for (const record of records) {
    const home = record.fields.账号主页;
    if (!home || typeof home !== "object") continue;
    const item = home as Record<string, unknown>;
    const handle = normalizeHandle(String(item.text ?? "") || String(item.link ?? ""));
    const nickname = textValue(record.fields.账号名);
    if (!handle || !nickname) continue;
    if (result.has(handle.toLowerCase()) && result.get(handle.toLowerCase()) !== nickname) throw new Error(`账号@${handle}出现多个显示昵称`);
    result.set(handle.toLowerCase(), nickname);
  }
  return result;
}

function fieldMetadataMatches(current: Awaited<ReturnType<typeof listFields>>[number], target: FieldDefinition): boolean {
  const expectedDescription = typeof target.description === "object" ? String((target.description as { text?: string }).text ?? "") : String(target.description ?? "");
  const currentDescription = typeof current.description === "object" ? String((current.description as { text?: string }).text ?? "") : String(current.description ?? "");
  const expectedFormatter = String((target.property as { formatter?: string } | undefined)?.formatter ?? "");
  const currentFormatter = String((current.property as { formatter?: string } | undefined)?.formatter ?? "");
  return expectedDescription === currentDescription && expectedFormatter === currentFormatter;
}

function assertExactFields(table: Snapshot["tables"][number], name: string): void {
  const target = ACCOUNT_SIDE_TABLES.find((item) => item.name === name)!;
  const actual = table.fields.map((field) => field.fieldName);
  const expected = target.fields.map((field) => field.field_name);
  if (actual.length !== expected.length || actual.some((field) => !expected.includes(field))) {
    throw new Error(`${table.name}字段不是当前目标结构：${actual.join("、")}`);
  }
}

function planSnapshot(snapshot: Snapshot): Record<string, unknown> {
  const account = requireTable(snapshot, "视频号信息统计");
  const video = requireTable(snapshot, "短视频数据表");
  const nicknames = accountNicknameMap(account.records);
  const desired = desiredVideoUpdates(video.records, nicknames);
  return { storeName: snapshot.storeName, accounts: nicknames.size, videoRecords: video.records.length, recordUpdates: desired.changed };
}

async function snapshotBase(clientValue: Client, base: AccountSideBase): Promise<Snapshot> {
  const tables = await listTables(clientValue, base.appToken);
  const result: Snapshot["tables"] = [];
  for (const table of tables) {
    const [fields, records, views] = await Promise.all([
      listFields(clientValue, base.appToken, table.tableId),
      listRecords(clientValue, base.appToken, table.tableId),
      listViews(clientValue, base.appToken, table.tableId),
    ]);
    result.push({ tableId: table.tableId, name: table.name, fields, records, views });
  }
  return { storeName: base.storeName, tables: result };
}

function compareUnaffected(before: Snapshot[], after: Snapshot[]): Array<Record<string, unknown>> {
  const result = [];
  for (const prior of before) {
    const current = after.find((item) => item.storeName === prior.storeName)!;
    for (const table of prior.tables.filter((item) => !TARGET_TABLES.has(item.name))) {
      const next = current.tables.find((item) => item.tableId === table.tableId);
      const beforeHash = sha256(table);
      const afterHash = next ? sha256(next) : "missing";
      result.push({ storeName: prior.storeName, table: table.name, beforeHash, afterHash, ok: beforeHash === afterHash });
    }
  }
  return result;
}

function testTargets(value: AppEnv): Target[] {
  assertTestEnterpriseEnv(value);
  return [{ id: "storeone-test", base: { storeKey: "storeone-test", storeName: "STOREONE", appToken: value.FEISHU_BITABLE_APP_TOKEN, name: "店铺经营工作台模板", url: value.FEISHU_BITABLE_URL, createdAt: "existing-test-base" } }];
}

function formalTargets(value: AppEnv): Target[] {
  if (value.FEISHU_APP_ID !== FORMAL_APP_ID) throw new Error("当前不是指定正式应用");
  const tenants = new TenantRegistry(value).all().sort((left, right) => left.binding.id.localeCompare(right.binding.id));
  const actual = new Set(tenants.map((tenant) => tenant.binding.id));
  if (actual.size !== EXPECTED_FORMAL_TENANTS.size || [...EXPECTED_FORMAL_TENANTS].some((id) => !actual.has(id))) throw new Error("正式租户集合不符合预期");
  return tenants.map((tenant) => ({ id: tenant.binding.id, base: formalBase(tenant) }));
}

function formalBase(tenant: ResolvedTenant): AccountSideBase {
  return { storeKey: tenant.binding.id, storeName: tenant.profile.businessDisplayName, appToken: tenant.env.FEISHU_BITABLE_APP_TOKEN, name: tenant.profile.businessDisplayName, url: tenant.env.FEISHU_BITABLE_URL, createdAt: "existing-formal-base" };
}

async function assertDailyJobsIdle(values: Target[]): Promise<void> {
  for (const target of values) {
    const status = JSON.parse(await readFile(path.join(PROJECT_ROOT, ".runtime", "tenants", target.id, "daily-automation", "status.json"), "utf8")) as { running?: boolean };
    if (status.running !== false) throw new Error(`${target.id}日更仍在运行`);
  }
}

function requireTable(snapshot: Snapshot, name: string): Snapshot["tables"][number] {
  const matches = snapshot.tables.filter((table) => table.name === name);
  if (matches.length !== 1) throw new Error(`${snapshot.storeName}无法唯一定位${name}`);
  return matches[0];
}

function requireConfirmation(): void {
  const index = args.indexOf("--confirm");
  if (index < 0 || args[index + 1] !== CONFIRMATION) throw new Error(`写入必须提供 --apply --confirm ${CONFIRMATION}`);
}

function argument(name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] ?? "").trim() || null : null;
}

function handleFromVideoUrl(value: unknown): string {
  const match = textValue(value).match(/\/\@([^/]+)\/video\//i);
  if (!match?.[1]) throw new Error(`视频网址无法解析账号ID：${textValue(value)}`);
  return match[1].trim();
}

function normalizeHandle(value: string): string {
  const urlMatch = value.match(/tiktok\.com\/\@([^/?#]+)/i);
  return (urlMatch?.[1] ?? value).replace(/^@/, "").trim();
}

function textValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(textValue).join("").trim();
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return String(item.text ?? item.link ?? item.name ?? item.value ?? "").trim();
  }
  return String(value ?? "").trim();
}

function finiteNumber(value: unknown, label: string): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label}不是有效非负数`);
  return number;
}

function sameDisplay(actual: Record<string, unknown>, desired: Record<string, unknown>): boolean {
  return textValue(actual.达人昵称) === desired.达人昵称
    && textValue(actual.达人ID) === desired.达人ID
    && finiteNumber(actual.视频vv, "视频vv") === desired.视频vv;
}

function meaningful(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "" && (!Array.isArray(value) || value.length > 0);
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
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
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
