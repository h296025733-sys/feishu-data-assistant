import { randomUUID } from "node:crypto";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { AppEnv } from "../config/env.js";
import type {
  AccountSideAccount,
  AccountSidePlan,
  AccountSideRoiRow,
  AccountSideVideo,
} from "../account-side/plan.js";
import { assertFeishuResponse, createFeishuClient, withFeishuRetry } from "./client.js";
import { linkValueForField } from "./field-values.js";

const FORMAL_APP_ID = "demo_ded47f35";
const EXPECTED_TEST_HOST = "test-dka0z44btrnq.feishu.cn";

export type TestStoreKey = "storetwo" | "storeone";

export interface AccountSideBase {
  storeKey: string;
  storeName: string;
  appToken: string;
  name: string;
  url: string;
  createdAt: string;
}

export interface AccountSideTestBase extends AccountSideBase {
  storeKey: TestStoreKey;
}

export interface AccountSideSyncOptions {
  /** These fields belong to people after the first insert and are never overwritten by automation. */
  preserveAccountManualFields?: boolean;
}

const SOURCE_AD_SPEND_FIELD = "总广告花费";
const TARGET_AD_SPEND_FIELD = "广告花费";
const SOURCE_AD_ORDERS_FIELD = "总广告出单量";
const TARGET_AD_ORDERS_FIELD = "广告出单量";
// Keep the visible field names from the user-approved native template.  The
// semantics live in the descriptions and values: 达人ID stores @username and
// 视频vv stores thousands (K).  Renaming these keys in code breaks every
// existing formal Base even though the underlying metric contract is unchanged.
const SHORT_VIDEO_CREATOR_ID_FIELD = "达人ID";
const SHORT_VIDEO_VIEWS_K_FIELD = "视频vv";
const SHORT_VIDEO_GMV_FIELD = "商品交易总额（视频） ($)";

export type FieldDefinition = {
  field_name: string;
  type: number;
  ui_type?: string;
  property?: Record<string, unknown>;
  description?: { text?: string; disable_sync?: boolean };
};

type RecordValue = string | number | boolean | { text?: string; link?: string } | string[] | null;
type RecordFields = Record<string, RecordValue>;

export function accountSideManagedUpdateFields(
  actual: Record<string, unknown>,
  desired: RecordFields,
  preserveOnUpdate?: Set<string>,
): RecordFields | null {
  if (managedFieldsEqual(actual, desired, preserveOnUpdate)) return null;
  return preserveOnUpdate
    ? Object.fromEntries(Object.entries(desired).filter(([field]) => !preserveOnUpdate.has(field))) as RecordFields
    : desired;
}

/** Account-side advertising totals are user-owned facts and must never be overwritten by TikTok sync. */
export function preserveAccountSideManualAdvertising(plan: AccountSidePlan): AccountSidePlan {
  const strip = (rows: AccountSideRoiRow[]): AccountSideRoiRow[] => rows.map((row) => {
    const { adSpend: _adSpend, adOrders: _adOrders, ...automaticRow } = row;
    return automaticRow;
  });
  return {
    ...plan,
    productRows: strip(plan.productRows),
    accountRows: strip(plan.accountRows),
  };
}

export type AccountSideTableName = "视频号信息统计" | "短视频数据表" | "产品投产比" | "账号投产比";

export const ACCOUNT_SIDE_TABLES: Array<{
  name: AccountSideTableName;
  defaultViewName: string;
  primaryField: string;
  fields: FieldDefinition[];
}> = [
  {
    name: "视频号信息统计",
    defaultViewName: "账号总览",
    primaryField: "负责人",
    fields: [
      textField("负责人", "人工维护；自动同步不会覆盖"),
      textField("账号名", "TikTok显示名称；由自动化维护"),
      textField("UID", "人工维护；API返回值不再自动写入"),
      textField("账号", "人工维护"),
      textField("密码", "人工维护；自动同步不会读取或覆盖"),
      urlField("账号主页", "可点击直达TikTok账号主页"),
      selectField("账号类型", ["官方账号", "营销账号"], "TikTok Shop Analytics账号类型"),
      textField("备注", "人工维护；自动同步不会覆盖"),
    ],
  },
  {
    name: "短视频数据表",
    defaultViewName: "全部视频",
    primaryField: "达人昵称",
    fields: [
      textField("达人昵称", "TikTok显示昵称（creator_nick_name）；由自动化维护"),
      textField(SHORT_VIDEO_CREATOR_ID_FIELD, "TikTok可搜索账号ID（@creator_user_name）；由自动化维护"),
      textField("视频ID网址", "TikTok视频完整网址；由自动化维护"),
      dateField("发布时间", "视频发布时间，按北京时间显示", true),
      textField("商品", "正式商品名称"),
      numberField(SHORT_VIDEO_VIEWS_K_FIELD, "视频级曝光，单位K（千）；多商品视频会重复展示，跨商品合计时必须按网址去重", "0.000"),
      numberField("视频商品成交件数", "视频归因售出件数"),
      currencyField(SHORT_VIDEO_GMV_FIELD, "视频归因GMV（USD），不是预估佣金"),
    ],
  },
  {
    name: "产品投产比",
    defaultViewName: "产品日数据",
    primaryField: "检查",
    fields: roiFieldDefinitions("商品", "TikTok商品ID"),
  },
  {
    name: "账号投产比",
    defaultViewName: "账号日数据",
    primaryField: "检查",
    fields: [
      ...roiFieldDefinitions("账号", "账号UID"),
      selectField("账号类型", ["官方账号", "营销账号"], "账号归属类型"),
    ],
  },
];

export function assertTestEnterpriseEnv(env: AppEnv): void {
  if (env.FEISHU_APP_ID === FORMAL_APP_ID) throw new Error("当前是正式企业应用身份，拒绝执行账号端测试写入");
  let host = "";
  try {
    host = new URL(env.FEISHU_BITABLE_URL).hostname;
  } catch {
    throw new Error("测试Base地址无效，拒绝执行");
  }
  if (host !== EXPECTED_TEST_HOST) throw new Error(`当前Base不属于测试企业（${host || "空"}），拒绝执行`);
}

export async function auditAccountSideBase(env: AppEnv, appToken = env.FEISHU_BITABLE_APP_TOKEN): Promise<Record<string, unknown>> {
  assertTestEnterpriseEnv(env);
  const client = createFeishuClient(env);
  return auditBase(client, appToken);
}

/** Install the four account-side tables into one already-existing test Base. */
export async function installAccountSideSchemaInExistingBase(
  env: AppEnv,
  base: AccountSideTestBase,
): Promise<Record<string, unknown>> {
  assertTestEnterpriseEnv(env);
  return installAccountSideSchemaWithClient(createFeishuClient(env), base);
}

export async function installAccountSideSchemaWithClient(
  client: Client,
  base: AccountSideBase,
): Promise<Record<string, unknown>> {
  const tables = await listTables(client, base.appToken);
  const created: string[] = [];
  for (const definition of ACCOUNT_SIDE_TABLES) {
    const candidates = tables.filter((table) => table.name === definition.name);
    if (candidates.length > 1) throw new Error(`${base.storeName}存在重复数据表“${definition.name}”`);
    if (candidates.length === 0) {
      const response = await withFeishuRetry(async () => {
        const current = await client.bitable.appTable.create({
          path: { app_token: base.appToken },
          data: {
            table: {
              name: definition.name,
              default_view_name: definition.defaultViewName,
              fields: definition.fields as never,
            },
          },
        });
        assertFeishuResponse(current, `在既有${base.storeName}测试Base新建“${definition.name}”`);
        return current;
      });
      if (!response.data?.table_id) throw new Error(`新建“${definition.name}”后缺少table_id`);
      tables.push({ tableId: response.data.table_id, name: definition.name });
      created.push(definition.name);
    }
  }
  const verification = [];
  for (const definition of ACCOUNT_SIDE_TABLES) {
    const table = tables.find((item) => item.name === definition.name)!;
    let fields = await listFields(client, base.appToken, table.tableId);
    const duplicateNames = duplicates(fields.map((field) => field.fieldName));
    if (duplicateNames.length) {
      throw new Error(`${base.storeName}“${definition.name}”存在重复字段名：${duplicateNames.join("、")}`);
    }
    const advertisingDefinitions = definition.fields.filter((field) => (
      field.field_name === TARGET_AD_SPEND_FIELD || field.field_name === TARGET_AD_ORDERS_FIELD
    ));
    for (const advertisingDefinition of advertisingDefinitions) {
      if (fields.some((field) => field.fieldName === advertisingDefinition.field_name)) continue;
      await withFeishuRetry(async () => {
        const response = await client.bitable.appTableField.create({
          path: { app_token: base.appToken, table_id: table.tableId },
          data: advertisingDefinition as never,
        });
        assertFeishuResponse(response, `给${base.storeName}“${definition.name}”新增${advertisingDefinition.field_name}字段`);
        return response;
      });
      fields = await listFields(client, base.appToken, table.tableId);
    }
    const byName = new Map(fields.map((field) => [field.fieldName, field]));
    const missing = definition.fields.filter((field) => !byName.has(field.field_name)).map((field) => field.field_name);
    const wrongType = definition.fields.flatMap((field) => {
      const actual = byName.get(field.field_name);
      return actual && actual.type !== field.type ? [`${field.field_name}:${actual.type}!=${field.type}`] : [];
    });
    if (missing.length || wrongType.length) {
      throw new Error(`${base.storeName}“${definition.name}”字段验证失败：${[...missing, ...wrongType].join("、")}`);
    }
    verification.push({ table: definition.name, tableId: table.tableId, fields: fields.length });
  }
  return { created, verification };
}

export async function syncAccountSidePlanToBase(
  env: AppEnv,
  base: AccountSideTestBase,
  plan: AccountSidePlan,
): Promise<Record<string, unknown>> {
  assertTestEnterpriseEnv(env);
  if (normalizeCore(base.storeName) !== normalizeCore(plan.shop.name)) {
    throw new Error(`计划店铺${plan.shop.name}与目标测试Base ${base.storeName}不一致`);
  }
  return syncAccountSidePlanWithClient(createFeishuClient(env), base, plan);
}

export async function syncAccountSidePlanWithClient(
  client: Client,
  base: AccountSideBase,
  plan: AccountSidePlan,
  options: AccountSideSyncOptions = {},
): Promise<Record<string, unknown>> {
  if (normalizeCore(base.storeName) !== normalizeCore(plan.shop.name)) {
    throw new Error(`计划店铺${plan.shop.name}与目标Base ${base.storeName}不一致`);
  }
  const tables = await listTables(client, base.appToken);
  const table = (name: string) => {
    const matches = tables.filter((item) => item.name === name);
    if (matches.length !== 1) throw new Error(`${base.storeName}无法唯一定位“${name}”`);
    return matches[0];
  };
  const effectivePlan = preserveAccountSideManualAdvertising(plan);

  const accountTable = table("视频号信息统计");
  const accountSchema = await listFields(client, base.appToken, accountTable.tableId);
  const accountHomepageType = accountSchema.find((field) => field.fieldName === "账号主页")?.type;
  const accounts = await upsertRows(
    client,
    base.appToken,
    accountTable,
    ["账号主页"],
    effectivePlan.accounts.map((account) => accountFields(account, accountHomepageType)),
  );
  const videos = await upsertRows(client, base.appToken, table("短视频数据表"), ["视频ID网址", "商品"], effectivePlan.videos.map(videoFields));
  const product = await upsertRows(client, base.appToken, table("产品投产比"), "检查", effectivePlan.productRows.map((row) => accountSideRoiFields(row, "商品", "TikTok商品ID")));
  const account = await upsertRows(client, base.appToken, table("账号投产比"), "检查", effectivePlan.accountRows.map((row) => ({
    ...accountSideRoiFields(row, "账号", "账号UID"),
    账号类型: row.accountTypeLabel,
  })));
  const verification = await verifyEffectiveAccountSidePlan(client, base, effectivePlan, tables, options);
  return {
    accounts,
    videos,
    product,
    account,
    advertising: {
      mode: "manual",
      targetFields: [TARGET_AD_SPEND_FIELD, TARGET_AD_ORDERS_FIELD],
      automaticOverwrite: false,
    },
    verification,
  };
}

export async function verifyAccountSideBase(
  env: AppEnv,
  base: AccountSideTestBase,
  expectedPlan?: AccountSidePlan,
): Promise<Record<string, unknown>> {
  assertTestEnterpriseEnv(env);
  const client = createFeishuClient(env);
  if (expectedPlan) return verifyAccountSidePlanWithClient(client, base, expectedPlan);
  return auditBase(client, base.appToken);
}

export async function verifyAccountSidePlanWithClient(
  client: Client,
  base: AccountSideBase,
  plan: AccountSidePlan,
  options: AccountSideSyncOptions = {},
): Promise<Record<string, unknown>> {
  const tables = await listTables(client, base.appToken);
  return verifyEffectiveAccountSidePlan(
    client,
    base,
    preserveAccountSideManualAdvertising(plan),
    tables,
    options,
  );
}

async function verifyEffectiveAccountSidePlan(
  client: Client,
  base: AccountSideBase,
  plan: AccountSidePlan,
  tables: Array<{ tableId: string; name: string }>,
  options: AccountSideSyncOptions = {},
): Promise<Record<string, unknown>> {
  const accountTable = tables.find((item) => item.name === "视频号信息统计");
  if (!accountTable) throw new Error(`${base.storeName}缺少“视频号信息统计”`);
  const accountSchema = await listFields(client, base.appToken, accountTable.tableId);
  const accountHomepageType = accountSchema.find((field) => field.fieldName === "账号主页")?.type;
  const expectations: Array<{
    name: string;
    key: string | string[];
    desired: RecordFields[];
    ignoredFields?: Set<string>;
  }> = [
    {
      name: "视频号信息统计",
      key: ["账号主页"],
      desired: plan.accounts.map((account) => accountFields(account, accountHomepageType)),
    },
    { name: "短视频数据表", key: ["视频ID网址", "商品"], desired: plan.videos.map(videoFields) },
    { name: "产品投产比", key: "检查", desired: plan.productRows.map((item) => accountSideRoiFields(item, "商品", "TikTok商品ID")) },
    { name: "账号投产比", key: "检查", desired: plan.accountRows.map((item) => ({ ...accountSideRoiFields(item, "账号", "账号UID"), 账号类型: item.accountTypeLabel } as RecordFields)) },
  ];
  const result = [];
  for (const expectation of expectations) {
    const target = tables.find((item) => item.name === expectation.name);
    if (!target) throw new Error(`${base.storeName}缺少“${expectation.name}”`);
    const records = await listRecords(client, base.appToken, target.tableId,
      expectation.name === "视频号信息统计" ? ["账号主页", "账号名", "账号类型"] : undefined);
    const keys = records.map((record) => compositeKey(record.fields, expectation.key)).filter(Boolean);
    const duplicateKeys = duplicates(keys);
    const byKey = new Map(records.map((record) => [compositeKey(record.fields, expectation.key), record]));
    const missingKeys = expectation.desired
      .map((fields) => compositeKey(fields, expectation.key))
      .filter((key) => !byKey.has(key));
    const mismatchedKeys = expectation.desired.flatMap((fields) => {
      const key = compositeKey(fields, expectation.key);
      const actual = byKey.get(key);
      return actual && !managedFieldsEqual(actual.fields, fields, expectation.ignoredFields) ? [key] : [];
    });
    if (duplicateKeys.length || missingKeys.length || mismatchedKeys.length) {
      throw new Error(`${base.storeName}“${expectation.name}”复读失败：重复${duplicateKeys.length}、缺失${missingKeys.length}、字段不一致${mismatchedKeys.length}`);
    }
    result.push({ table: expectation.name, expected: expectation.desired.length, records: records.length, duplicateKeys: 0, missingKeys: 0, mismatchedKeys: 0 });
  }
  return { ok: true, latestAvailableDate: plan.latestAvailableDate, tables: result };
}

export function mergeAccountSideAdvertisingSpend(
  plan: AccountSidePlan,
  spendByDate: ReadonlyMap<string, number | null>,
  ordersByDate: ReadonlyMap<string, number | null> = new Map(),
): AccountSidePlan {
  const mergeRows = (rows: AccountSideRoiRow[]): AccountSideRoiRow[] => rows.map((row) => {
    const { adSpend: _priorSpend, adOrders: _priorOrders, ...baseRow } = row;
    const storeOverview = row.dimension === plan.shop.name && !row.dimensionId;
    return storeOverview
      ? {
          ...baseRow,
          adSpend: spendByDate.get(row.date) ?? null,
          adOrders: ordersByDate.get(row.date) ?? null,
        }
      : baseRow;
  });
  return {
    ...plan,
    productRows: mergeRows(plan.productRows),
    accountRows: mergeRows(plan.accountRows),
  };
}

export function advertisingSpendByDateFromRows(
  rows: readonly { fields: Record<string, unknown> }[],
  options: { storeAggregateLabel: string; businessTimeZone: string },
): Map<string, number | null> {
  const result = new Map<string, number | null>();
  for (const row of rows) {
    if (textValue(row.fields.商品) !== options.storeAggregateLabel) continue;
    const date = dateKey(row.fields.日期, options.businessTimeZone);
    if (!date) continue;
    if (result.has(date)) throw new Error(`店铺端投产比 ${date} 存在重复“${options.storeAggregateLabel}”行`);
    result.set(date, optionalNonNegativeMoney(row.fields[SOURCE_AD_SPEND_FIELD], `${date}.${SOURCE_AD_SPEND_FIELD}`));
  }
  return result;
}

export function advertisingOrdersByDateFromRows(
  rows: readonly { fields: Record<string, unknown> }[],
  options: { storeAggregateLabel: string; businessTimeZone: string },
): Map<string, number | null> {
  const result = new Map<string, number | null>();
  for (const row of rows) {
    if (textValue(row.fields.商品) !== options.storeAggregateLabel) continue;
    const date = dateKey(row.fields.日期, options.businessTimeZone);
    if (!date) continue;
    if (result.has(date)) throw new Error(`店铺端投产比 ${date} 存在重复“${options.storeAggregateLabel}”行`);
    result.set(date, optionalNonNegativeCount(row.fields[SOURCE_AD_ORDERS_FIELD], `${date}.${SOURCE_AD_ORDERS_FIELD}`));
  }
  return result;
}

async function upsertRows(
  client: Client,
  appToken: string,
  table: { tableId: string; name: string },
  keyField: string | string[],
  desired: RecordFields[],
  options: { preserveOnUpdate?: Set<string> } = {},
): Promise<Record<string, number>> {
  const desiredKeys = desired.map((fields) => compositeKey(fields, keyField));
  if (desiredKeys.some((key) => !key) || duplicates(desiredKeys).length) {
    throw new Error(`${table.name}写入计划有缺失或重复业务键，写前拒绝执行`);
  }
  // Account credentials are human-only; this sync does not need to read them.
  const accountReadFields = table.name === "视频号信息统计" ? ["账号主页", "账号名", "账号类型"] : undefined;
  const existing = await listRecords(client, appToken, table.tableId, accountReadFields);
  const byKey = new Map<string, Array<{ recordId: string; fields: Record<string, unknown> }>>();
  for (const record of existing) {
    const key = compositeKey(record.fields, keyField);
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push(record);
    byKey.set(key, list);
  }
  const duplicateKeys = [...byKey].filter(([, records]) => records.length > 1).map(([key]) => key);
  if (duplicateKeys.length) throw new Error(`${table.name}存在重复业务键，拒绝覆盖：${duplicateKeys.slice(0, 10).join("、")}`);
  const creates: RecordFields[] = [];
  const updates: Array<{ record_id: string; fields: RecordFields }> = [];
  let unchanged = 0;
  for (const fields of desired) {
    const key = compositeKey(fields, keyField);
    if (!key) throw new Error(`${table.name}写入计划缺少${Array.isArray(keyField) ? keyField.join("+") : keyField}`);
    const prior = byKey.get(key)?.[0];
    if (!prior) {
      creates.push(Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== null && value !== ""),
      ) as RecordFields);
      continue;
    }
    const managed = accountSideManagedUpdateFields(prior.fields, fields, options.preserveOnUpdate);
    if (!managed) {
      unchanged += 1;
      continue;
    }
    updates.push({ record_id: prior.recordId, fields: managed });
  }
  for (const batch of chunks(creates, 500)) {
    const clientToken = randomUUID();
    const response = await withFeishuRetry(async () => {
      const current = await client.bitable.appTableRecord.batchCreate({
        path: { app_token: appToken, table_id: table.tableId },
        params: { client_token: clientToken },
        data: { records: batch.map((fields) => ({ fields })) as never },
      });
      assertFeishuResponse(current, `新增${table.name}记录`);
      return current;
    });
    if ((response.data?.records?.length ?? 0) !== batch.length) throw new Error(`${table.name}批量新增返回数量不一致`);
  }
  for (const batch of chunks(updates, 500)) {
    const clientToken = randomUUID();
    const response = await withFeishuRetry(async () => {
      const current = await client.bitable.appTableRecord.batchUpdate({
        path: { app_token: appToken, table_id: table.tableId },
        params: { client_token: clientToken },
        data: { records: batch as never },
      });
      assertFeishuResponse(current, `更新${table.name}记录`);
      return current;
    });
    if ((response.data?.records?.length ?? 0) !== batch.length) throw new Error(`${table.name}批量更新返回数量不一致`);
  }
  return { planned: desired.length, created: creates.length, updated: updates.length, unchanged };
}

export function accountFields(account: AccountSideAccount, homepageFieldType = 15): RecordFields {
  return compactFields({
    账号名: account.accountName,
    账号主页: account.handle
      ? linkValueForField(
          `https://www.tiktok.com/@${account.handle}`,
          homepageFieldType,
          `@${account.handle}`,
        )
      : undefined,
    账号类型: account.accountTypeLabel,
  });
}

export function videoFields(video: AccountSideVideo): RecordFields {
  return compactFields({
    达人昵称: video.accountNickName || video.accountName,
    [SHORT_VIDEO_CREATOR_ID_FIELD]: video.accountName.startsWith("未识别账号-") ? undefined : `@${video.accountName}`,
    视频ID网址: video.videoUrl,
    发布时间: video.publishedAtMs,
    商品: video.productName,
    [SHORT_VIDEO_VIEWS_K_FIELD]: viewsToK(video.views),
    视频商品成交件数: video.items,
    [SHORT_VIDEO_GMV_FIELD]: video.gmv,
  });
}

export function viewsToK(views: number): number {
  if (!Number.isFinite(views) || views < 0) throw new Error(`视频VV不是有效非负数：${String(views)}`);
  return Math.round((views / 1_000) * 1_000) / 1_000;
}

export function accountSideRoiFields(row: AccountSideRoiRow, dimensionField: string, dimensionIdField: string): RecordFields {
  const fields = compactFields({
    检查: row.key,
    店铺: row.store,
    [dimensionField]: row.dimension,
    [dimensionIdField]: row.dimensionId,
    日期: dateTimestamp(row.date),
    上线量: row.publishedVideos,
    出单视频: row.orderingVideos,
    单量: row.orders,
    数量: row.items,
    视频曝光: row.views,
    销售额: row.gmv,
    数据状态: row.status,
  });
  if (Object.hasOwn(row, "adSpend")) {
    fields[TARGET_AD_SPEND_FIELD] = row.adSpend ?? null;
  }
  if (Object.hasOwn(row, "adOrders")) {
    fields[TARGET_AD_ORDERS_FIELD] = row.adOrders ?? null;
  }
  return fields;
}

export async function auditBase(client: Client, appToken: string): Promise<Record<string, unknown>> {
  const appResponse = await client.bitable.app.get({ path: { app_token: appToken } });
  assertFeishuResponse(appResponse, "读取测试Base元数据");
  const tables = await listTables(client, appToken);
  const audited = [];
  for (const table of tables) {
    const [fields, records, views] = await Promise.all([
      listFields(client, appToken, table.tableId),
      listRecords(client, appToken, table.tableId),
      listViews(client, appToken, table.tableId),
    ]);
    audited.push({ ...table, fieldCount: fields.length, recordCount: records.length, fields, views });
  }
  return {
    app: {
      name: appResponse.data?.app?.name ?? "",
      timeZone: appResponse.data?.app?.time_zone ?? "",
      isAdvanced: appResponse.data?.app?.is_advanced ?? false,
    },
    tableCount: audited.length,
    tables: audited,
  };
}

export async function listTables(client: Client, appToken: string): Promise<Array<{ tableId: string; name: string }>> {
  const result: Array<{ tableId: string; name: string }> = [];
  let pageToken: string | undefined;
  do {
    const response = await withFeishuRetry(async () => {
      const current = await client.bitable.appTable.list({ path: { app_token: appToken }, params: { page_size: 100, page_token: pageToken } });
      assertFeishuResponse(current, "读取测试Base数据表");
      return current;
    });
    for (const item of response.data?.items ?? []) {
      if (item.table_id) result.push({ tableId: item.table_id, name: item.name ?? item.table_id });
    }
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return result;
}

export async function listFields(client: Client, appToken: string, tableId: string): Promise<Array<{
  fieldId: string;
  fieldName: string;
  type: number;
  uiType: string;
  description?: unknown;
  property?: Record<string, unknown>;
}>> {
  const result: Array<{
    fieldId: string;
    fieldName: string;
    type: number;
    uiType: string;
    description?: unknown;
    property?: Record<string, unknown>;
  }> = [];
  let pageToken: string | undefined;
  do {
    const response = await withFeishuRetry(async () => {
      const current = await client.bitable.appTableField.list({ path: { app_token: appToken, table_id: tableId }, params: { page_size: 100, page_token: pageToken } });
      assertFeishuResponse(current, "读取测试Base字段");
      return current;
    });
    for (const item of response.data?.items ?? []) {
      if (item.field_id) result.push({
        fieldId: item.field_id,
        fieldName: item.field_name ?? item.field_id,
        type: item.type ?? 0,
        uiType: item.ui_type ?? "",
        description: item.description,
        property: item.property as Record<string, unknown> | undefined,
      });
    }
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return result;
}

export async function listRecords(
  client: Client,
  appToken: string,
  tableId: string,
  fieldNames?: readonly string[],
): Promise<Array<{ recordId: string; fields: Record<string, unknown> }>> {
  const result: Array<{ recordId: string; fields: Record<string, unknown> }> = [];
  let pageToken: string | undefined;
  do {
    const response = await withFeishuRetry(async () => {
      const current = await client.bitable.appTableRecord.list({
        path: { app_token: appToken, table_id: tableId },
        params: {
          page_size: 500,
          page_token: pageToken,
          automatic_fields: true,
          ...(fieldNames?.length ? { field_names: JSON.stringify(fieldNames) } : {}),
        },
      });
      assertFeishuResponse(current, "读取测试Base记录");
      return current;
    });
    for (const item of response.data?.items ?? []) {
      if (item.record_id) result.push({ recordId: item.record_id, fields: item.fields ?? {} });
    }
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return result;
}

export async function listViews(client: Client, appToken: string, tableId: string): Promise<Array<{ viewId: string; viewName: string; viewType: string }>> {
  const result: Array<{ viewId: string; viewName: string; viewType: string }> = [];
  let pageToken: string | undefined;
  do {
    const response = await withFeishuRetry(async () => {
      const current = await client.bitable.appTableView.list({ path: { app_token: appToken, table_id: tableId }, params: { page_size: 100, page_token: pageToken } });
      assertFeishuResponse(current, "读取测试Base视图");
      return current;
    });
    for (const item of response.data?.items ?? []) {
      if (item.view_id) result.push({ viewId: item.view_id, viewName: item.view_name ?? item.view_id, viewType: item.view_type ?? "" });
    }
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return result;
}

function textField(name: string, description: string): FieldDefinition {
  return { field_name: name, type: 1, ui_type: "Text", description: { text: description, disable_sync: false } };
}

function numberField(name: string, description: string, formatter = "0"): FieldDefinition {
  return { field_name: name, type: 2, ui_type: "Number", property: { formatter }, description: { text: description, disable_sync: false } };
}

function currencyField(name: string, description: string): FieldDefinition {
  return { field_name: name, type: 2, ui_type: "Currency", property: { formatter: "0.00", currency_code: "USD" }, description: { text: description, disable_sync: false } };
}

function dateField(name: string, description: string, withTime = false): FieldDefinition {
  return { field_name: name, type: 5, ui_type: "DateTime", property: { date_formatter: withTime ? "yyyy/MM/dd HH:mm" : "yyyy/MM/dd", auto_fill: false }, description: { text: description, disable_sync: false } };
}

function urlField(name: string, description: string): FieldDefinition {
  return { field_name: name, type: 15, ui_type: "Url", description: { text: description, disable_sync: false } };
}

function selectField(name: string, options: string[], description: string): FieldDefinition {
  return {
    field_name: name,
    type: 3,
    ui_type: "SingleSelect",
    property: { options: options.map((option, index) => ({ name: option, color: [0, 2, 4, 6][index % 4] })) },
    description: { text: description, disable_sync: false },
  };
}

function roiFieldDefinitions(dimensionName: string, dimensionIdName: string): FieldDefinition[] {
  return [
    textField("检查", "店铺、主体与日期唯一键；插件按此检查重复"),
    textField("店铺", "所属店铺"),
    textField(dimensionName, dimensionName === "商品" ? "正式商品名称；店铺汇总行使用店铺名" : "子账号；店铺汇总行使用店铺名"),
    textField(dimensionIdName, `${dimensionName}的TikTok唯一标识`),
    dateField("日期", "TikTok店铺注册时区完整经营日；北京时间界面只负责显示，不改写来源边界"),
    numberField("上线量", "该经营日发布的视频数"),
    numberField("出单视频", "该经营日产生归因成交的去重视频数；月度与全部按日平均"),
    numberField("单量", "该经营日视频归因订单数"),
    numberField("数量", "该经营日视频归因售出件数"),
    numberField("视频曝光", "该经营日视频曝光合计；月度与全部按日平均"),
    currencyField("销售额", "该经营日视频归因GMV（USD），不是预估佣金"),
    currencyField(TARGET_AD_SPEND_FIELD, "人工维护；仅店铺总览填写，自动日更不覆盖，产品/账号明细留空"),
    numberField(TARGET_AD_ORDERS_FIELD, "人工维护的广告转化量；仅店铺总览填写，自动日更不覆盖，产品/账号明细留空"),
    textField("数据状态", "数据完整性说明；完整日的0与空白严格区分"),
  ];
}

function compactFields(fields: Record<string, RecordValue | null | undefined>): RecordFields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null && value !== undefined && value !== "")) as RecordFields;
}

function dateTimestamp(date: string): number {
  const timestamp = new Date(`${date}T00:00:00+08:00`).getTime();
  if (!Number.isFinite(timestamp)) throw new Error(`日期格式无效：${date}`);
  return timestamp;
}

function dateKey(value: unknown, timeZone: string): string {
  if (Array.isArray(value)) return value.length ? dateKey(value[0], timeZone) : "";
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return dateKey(object.value ?? object.timestamp ?? object.text ?? object.content, timeZone);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(value));
  }
  const text = String(value ?? "").trim();
  const iso = text.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (iso) return iso;
  const timestamp = Number(text);
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(timestamp))
    : "";
}

function optionalNonNegativeMoney(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.length === 1) return optionalNonNegativeMoney(value[0], label);
    return optionalNonNegativeMoney(value.map(textValue).join(""), label);
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return optionalNonNegativeMoney(
      object.value ?? object.number ?? object.text ?? object.content ?? object.amount,
      label,
    );
  }
  const clean = String(value).replace(/[$,\s]/g, "").trim();
  if (!clean) return null;
  const parsed = Number(clean);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label}不是可靠的非负金额`);
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function optionalNonNegativeCount(value: unknown, label: string): number | null {
  const parsed = optionalNonNegativeMoney(value, label);
  if (parsed === null) return null;
  if (!Number.isInteger(parsed)) throw new Error(`${label}不是可靠的非负整数`);
  return parsed;
}

function textValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(textValue).join("").trim();
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return String(object.text ?? object.name ?? object.value ?? "").trim();
  }
  return String(value ?? "").trim();
}

function compositeKey(fields: Record<string, unknown>, keyField: string | string[]): string {
  const names = Array.isArray(keyField) ? keyField : [keyField];
  const parts = names.map((name) => textValue(fields[name]));
  return parts.every(Boolean) ? parts.join("\u0000") : "";
}

function managedFieldsEqual(actual: Record<string, unknown>, desired: RecordFields, ignoredFields?: Set<string>): boolean {
  return Object.entries(desired).every(([field, expected]) => (
    ignoredFields?.has(field) || normalizedValue(actual[field]) === normalizedValue(expected)
  ));
}

function normalizedValue(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(Math.round(value * 1_000_000) / 1_000_000) : "NaN";
  if (Array.isArray(value)) return JSON.stringify(value.map(normalizedValue).sort());
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if ("link" in object || "text" in object) return JSON.stringify({ text: textValue(object.text), link: String(object.link ?? "") });
    return JSON.stringify(value);
  }
  return String(value ?? "");
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    else seen.add(value);
  }
  return [...duplicate];
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function normalizeCore(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "");
}
