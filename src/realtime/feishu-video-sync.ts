import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { AppEnv } from "../config/env.js";
import { assertFeishuResponse } from "../feishu/client.js";
import type {
  FeishuFieldMeta,
  FeishuRecordSnapshot,
  FeishuTableMeta,
  RealtimeResultSummary,
  TikTokMachineContract,
  TikTokVideoRow,
  VideoUpdateChange,
  VideoUpdatePlan,
} from "./types.js";

const ONLINE_TABLE_PATTERN = /^Tech-wave红人上线表_\d+$/;
const FORMULA_FIELD_TYPES = new Set([20, 1001]);
const VIDEO_FIELD = "视频上线地址";
const VIEWS_FIELD = "视频曝光K";
const PROJECT_ROOT = process.cwd();
const BACKUP_ROOT = path.join(PROJECT_ROOT, "backups", "realtime-sync");
export const DEFAULT_WRITE_THRESHOLD = 100;

export class FeishuRealtimeGateway {
  public constructor(
    private readonly env: AppEnv,
    private readonly client: Client,
  ) {}

  public async discoverOnlineTables(): Promise<FeishuTableMeta[]> {
    const tableItems: Array<{ table_id?: string; name?: string }> = [];
    let pageToken: string | undefined;
    do {
      const response: any = await withFeishuRetry(() => (this.client.bitable.appTable as any).list({
        path: { app_token: this.env.FEISHU_BITABLE_APP_TOKEN },
        params: { page_size: 100, page_token: pageToken },
      }));
      assertFeishuResponse(response, "实时更新：读取数据表");
      tableItems.push(...(response.data?.items ?? []));
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);

    const online = tableItems
      .map((item) => ({ tableId: String(item.table_id ?? ""), name: String(item.name ?? "") }))
      .filter((item) => item.tableId && ONLINE_TABLE_PATTERN.test(item.name))
      .sort((a, b) => tableIndex(a.name) - tableIndex(b.name));
    if (online.length === 0) throw new Error("未发现任何 Tech-wave红人上线表_数字 分表");
    return Promise.all(online.map(async (table) => ({ ...table, fields: await this.listFields(table.tableId) })));
  }

  public async listRecords(table: FeishuTableMeta): Promise<FeishuRecordSnapshot[]> {
    const records: FeishuRecordSnapshot[] = [];
    let pageToken: string | undefined;
    do {
      const response = await withFeishuRetry(() => this.client.bitable.appTableRecord.list({
        path: {
          app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
          table_id: table.tableId,
        },
        params: {
          page_size: 500,
          page_token: pageToken,
          field_names: JSON.stringify([VIDEO_FIELD, VIEWS_FIELD]),
        },
      }));
      assertFeishuResponse(response, `实时更新：读取 ${table.name}`);
      for (const item of response.data?.items ?? []) {
        const recordId = String(item.record_id ?? "");
        if (!recordId) continue;
        records.push({
          tableId: table.tableId,
          tableName: table.name,
          recordId,
          fields: item.fields ?? {},
          lastModifiedTime: Number(item.last_modified_time ?? 0),
        });
      }
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    return records;
  }

  public async searchVideoRecords(
    table: FeishuTableMeta,
    videoIds: string[],
  ): Promise<FeishuRecordSnapshot[]> {
    const unique = [...new Set(videoIds.filter((value) => /^\d{10,}$/.test(value)))];
    const records = new Map<string, FeishuRecordSnapshot>();
    for (let start = 0; start < unique.length; start += 20) {
      const chunk = unique.slice(start, start + 20);
      let pageToken: string | undefined;
      do {
        const response = await withFeishuRetry(() => this.client.bitable.appTableRecord.search({
          path: {
            app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
            table_id: table.tableId,
          },
          params: { page_size: 500, page_token: pageToken },
          data: {
            field_names: [VIDEO_FIELD, VIEWS_FIELD],
            filter: {
              conjunction: "or",
              conditions: chunk.map((videoId) => ({
                field_name: VIDEO_FIELD,
                operator: "contains" as const,
                value: [videoId],
              })),
            },
          },
        }));
        assertFeishuResponse(response, `实时更新：搜索 ${table.name}`);
        for (const item of response.data?.items ?? []) {
          const recordId = String(item.record_id ?? "");
          if (!recordId) continue;
          records.set(recordId, {
            tableId: table.tableId,
            tableName: table.name,
            recordId,
            fields: item.fields ?? {},
            lastModifiedTime: Number(item.last_modified_time ?? 0),
          });
        }
        pageToken = response.data?.has_more ? response.data.page_token : undefined;
      } while (pageToken);
    }
    return [...records.values()];
  }

  public async getRecord(tableId: string, tableName: string, recordId: string): Promise<FeishuRecordSnapshot> {
    const response = await withFeishuRetry(() => this.client.bitable.appTableRecord.get({
      path: {
        app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
        table_id: tableId,
        record_id: recordId,
      },
    }));
    assertFeishuResponse(response, `实时更新：复读 ${tableName}/${recordId}`);
    const item = response.data?.record;
    if (!item) throw new Error(`实时更新：记录不存在 ${tableName}/${recordId}`);
    return {
      tableId,
      tableName,
      recordId,
      fields: item.fields ?? {},
      lastModifiedTime: Number(item.last_modified_time ?? 0),
    };
  }

  public async batchUpdate(
    tableId: string,
    records: Array<{ recordId: string; fields: Record<string, unknown> }>,
    clientToken: string,
  ): Promise<void> {
    if (records.length === 0) return;
    const response: any = await withFeishuRetry(() => (this.client.bitable.appTableRecord as any).batchUpdate({
      path: {
        app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
        table_id: tableId,
      },
      params: {
        client_token: clientToken.slice(0, 64),
        ignore_consistency_check: false,
      },
      data: {
        records: records.map((record) => ({
          record_id: record.recordId,
          fields: record.fields,
        })),
      },
    }));
    assertFeishuResponse(response, `实时更新：批量写入 ${tableId}`);
  }

  /**
   * Rollback favors a slower single-record update over a batch request. Some
   * Base tenants reject a mixed managed-field batch with WrongRequestBody;
   * updating and re-reading one record at a time prevents an ambiguous partial
   * restore and keeps the exact failing record visible.
   */
  public async updateOne(
    tableId: string,
    tableName: string,
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const response: any = await withFeishuRetry(() => this.client.bitable.appTableRecord.update({
      path: {
        app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
        table_id: tableId,
        record_id: recordId,
      },
      data: { fields: fields as any },
    }));
    assertFeishuResponse(response, `实时更新：逐条恢复 ${tableName}/${recordId}`);
  }

  public async batchDelete(
    tableId: string,
    recordIds: string[],
    clientToken: string,
  ): Promise<void> {
    if (recordIds.length === 0) return;
    const response: any = await withFeishuRetry(() => (this.client.bitable.appTableRecord as any).batchDelete({
      path: {
        app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
        table_id: tableId,
      },
      params: { client_token: clientToken.slice(0, 64) },
      data: { records: recordIds },
    }));
    assertFeishuResponse(response, `实时更新：批量删除 ${tableId}`);
  }

  public async recordExists(tableId: string, recordId: string): Promise<boolean> {
    let pageToken: string | undefined;
    do {
      const response = await withFeishuRetry(() => this.client.bitable.appTableRecord.list({
        path: { app_token: this.env.FEISHU_BITABLE_APP_TOKEN, table_id: tableId },
        params: { page_size: 500, page_token: pageToken },
      }));
      assertFeishuResponse(response, `实时更新：验证记录存在性 ${tableId}`);
      if ((response.data?.items ?? []).some((item) => item.record_id === recordId)) return true;
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    return false;
  }

  private async listFields(tableId: string): Promise<FeishuFieldMeta[]> {
    const fields: FeishuFieldMeta[] = [];
    let pageToken: string | undefined;
    do {
      const response = await withFeishuRetry(() => this.client.bitable.appTableField.list({
        path: {
          app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
          table_id: tableId,
        },
        params: { page_size: 100, page_token: pageToken },
      }));
      assertFeishuResponse(response, `实时更新：读取字段 ${tableId}`);
      for (const field of response.data?.items ?? []) {
        fields.push({
          fieldId: String(field.field_id ?? ""),
          fieldName: String(field.field_name ?? ""),
          type: Number(field.type ?? 0),
          uiType: String(field.ui_type ?? ""),
        });
      }
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    return fields;
  }
}

export async function buildVideoUpdatePlan(
  jobId: string,
  contract: TikTokMachineContract,
  gateway: FeishuRealtimeGateway,
): Promise<VideoUpdatePlan> {
  if (!contract.ok) throw new Error(contract.errors[0] ?? "TikTok 视频数据获取失败");
  if (contract.dataset !== "shop_video_performance") throw new Error(`不支持的数据集：${contract.dataset}`);
  if (contract.pagination_truncated) throw new Error("TikTok 视频数据分页不完整，拒绝计划写入");

  const tables = await gateway.discoverOnlineTables();
  const apiVideoIds = contract.rows.map((row) => numericId(row.id)).filter((value): value is string => Boolean(value));
  const recordsByTable: FeishuRecordSnapshot[][] = [];
  for (const table of tables) recordsByTable.push(await gateway.searchVideoRecords(table, apiVideoIds));
  const tableById = new Map(tables.map((table) => [table.tableId, table]));
  const recordIndex = new Map<string, FeishuRecordSnapshot[]>();
  for (const record of recordsByTable.flat()) {
    const videoId = extractVideoId(record.fields[VIDEO_FIELD]);
    if (!videoId) continue;
    const current = recordIndex.get(videoId) ?? [];
    current.push(record);
    recordIndex.set(videoId, current);
  }

  const changes: VideoUpdateChange[] = [];
  const conflicts: Array<{ key: string; reason: string }> = contract.conflicting_duplicate_ids
    .map((key) => ({ key, reason: "TikTok API 同一 video_id 指标冲突，已拒绝写入" }));
  const missingItems: string[] = [];
  let matched = 0;
  let unchanged = 0;
  let skipped = contract.conflicting_duplicate_ids.length;
  const seenApiIds = new Set<string>();

  for (const row of contract.rows) {
    const videoId = numericId(row.id);
    if (!videoId) {
      skipped += 1;
      conflicts.push({ key: "", reason: "TikTok 行缺少合法 video_id" });
      continue;
    }
    if (seenApiIds.has(videoId)) {
      skipped += 1;
      conflicts.push({ key: videoId, reason: "TikTok 机器合同包含重复 canonical video_id" });
      continue;
    }
    seenApiIds.add(videoId);
    const views = nonnegativeInteger(row.views);
    if (views === null) {
      skipped += 1;
      conflicts.push({ key: videoId, reason: "views 不是非负整数" });
      continue;
    }
    const candidates = recordIndex.get(videoId) ?? [];
    if (candidates.length === 0) {
      skipped += 1;
      conflicts.push({ key: videoId, reason: "两张上线分表均无匹配视频；MVP 不盲目新增" });
      continue;
    }
    if (candidates.length > 1) {
      skipped += 1;
      conflicts.push({ key: videoId, reason: `飞书存在 ${candidates.length} 个匹配候选，拒绝猜测` });
      continue;
    }
    matched += 1;
    const candidate = candidates[0];
    const table = tableById.get(candidate.tableId);
    if (!table) throw new Error(`找不到记录所属表：${candidate.tableId}`);
    const viewsMeta = table.fields.find((field) => field.fieldName === VIEWS_FIELD);
    const videoMeta = table.fields.find((field) => field.fieldName === VIDEO_FIELD);
    if (!viewsMeta || !videoMeta) {
      skipped += 1;
      conflicts.push({ key: videoId, reason: `${table.name} 缺少 ${VIDEO_FIELD}/${VIEWS_FIELD}` });
      continue;
    }
    if (FORMULA_FIELD_TYPES.has(viewsMeta.type) || ![1, 2].includes(viewsMeta.type)) {
      skipped += 1;
      conflicts.push({ key: videoId, reason: `${table.name}/${VIEWS_FIELD} 类型 ${viewsMeta.type} 不在写入白名单` });
      continue;
    }
    const afterValue = viewsMeta.type === 2 ? views : String(views);
    const beforeValue = candidate.fields[VIEWS_FIELD];
    if (equivalentScalar(beforeValue, afterValue)) {
      unchanged += 1;
      continue;
    }
    changes.push({
      tableId: candidate.tableId,
      tableName: candidate.tableName,
      recordId: candidate.recordId,
      uniqueKey: `tiktok_video_id:${videoId}`,
      beforeFields: candidate.fields,
      afterFields: { [VIEWS_FIELD]: afterValue },
      lastModifiedTime: candidate.lastModifiedTime,
      sourceField: "views",
      sourceFiles: contract.raw_source_paths,
      requestIds: contract.request_ids,
      reason: "TikTok views 已与 Seller Center VV 完成 51/51 对账；按原始整数更新视频曝光K",
    });
  }

  if (hasNonzeroUncalibratedSales(contract.rows)) {
    missingItems.push(
      "首次非零售出/GMV尚未校准：请导出同日 Seller Center → Analytics → Video Performance List，核对“视频商品成交件数”和“视频 GMV ($)”",
    );
  }
  return {
    version: 1,
    jobId,
    generatedAt: new Date().toISOString(),
    windowStart: contract.window_start,
    windowEndExclusive: contract.window_end_exclusive,
    dataset: contract.dataset,
    sourceFiles: contract.raw_source_paths,
    requestIds: contract.request_ids,
    changes,
    matched,
    unchanged,
    skipped,
    conflicts,
    missingItems,
    exactDuplicateCount: contract.exact_duplicate_count,
  };
}

export async function executeVideoUpdatePlan(
  plan: VideoUpdatePlan,
  gateway: FeishuRealtimeGateway,
  writeThreshold = DEFAULT_WRITE_THRESHOLD,
): Promise<RealtimeResultSummary> {
  if (plan.changes.length > writeThreshold) {
    throw new Error(`计划修改 ${plan.changes.length} 条，超过安全阈值 ${writeThreshold} 条`);
  }
  const backupDirectory = path.join(BACKUP_ROOT, plan.jobId);
  await mkdir(backupDirectory, { recursive: true });
  const hydrated: VideoUpdateChange[] = [];
  const initialConcurrencyConflicts: Array<{ key: string; reason: string }> = [];
  for (const change of plan.changes) {
    const current = await gateway.getRecord(change.tableId, change.tableName, change.recordId);
    const targetChanged = Object.keys(change.afterFields).some(
      (field) => !equivalentScalar(current.fields[field], change.beforeFields[field]),
    );
    if (targetChanged) {
      initialConcurrencyConflicts.push({ key: change.uniqueKey, reason: "生成计划后、写前快照前目标字段发生并发变化" });
      continue;
    }
    hydrated.push({ ...change, beforeFields: current.fields, lastModifiedTime: current.lastModifiedTime });
  }
  const executionPlan: VideoUpdatePlan = { ...plan, changes: hydrated };
  const before = {
    version: 1,
    jobId: plan.jobId,
    generatedAt: new Date().toISOString(),
    records: hydrated.map((change) => ({
      tableId: change.tableId,
      tableName: change.tableName,
      recordId: change.recordId,
      fields: change.beforeFields,
      lastModifiedTime: change.lastModifiedTime,
    })),
  };
  const beforeText = `${JSON.stringify(before, null, 2)}\n`;
  await writeFile(path.join(backupDirectory, "before.json"), beforeText, { encoding: "utf8", mode: 0o600 });
  await writeFile(
    path.join(backupDirectory, "before.sha256"),
    `${createHash("sha256").update(beforeText).digest("hex")}  before.json\n`,
    "ascii",
  );
  await writeJson(path.join(backupDirectory, "plan.json"), executionPlan);

  const ready: VideoUpdateChange[] = [];
  const concurrencyConflicts: Array<{ key: string; reason: string }> = [...initialConcurrencyConflicts];
  for (const change of hydrated) {
    const current = await gateway.getRecord(change.tableId, change.tableName, change.recordId);
    const changedDuringPlan = Object.keys(change.afterFields).some(
      (field) => !equivalentScalar(current.fields[field], change.beforeFields[field]),
    );
    if (changedDuringPlan) {
      concurrencyConflicts.push({ key: change.uniqueKey, reason: "计划期间目标字段发生并发变化" });
      continue;
    }
    ready.push(change);
  }

  const written: VideoUpdateChange[] = [];
  let failure: string | null = null;
  const byTable = groupBy(ready, (change) => change.tableId);
  try {
    for (const [tableId, changes] of byTable) {
      for (let offset = 0; offset < changes.length; offset += 50) {
        const batch = changes.slice(offset, offset + 50);
        await gateway.batchUpdate(
          tableId,
          batch.map((change) => ({ recordId: change.recordId, fields: change.afterFields })),
          `${plan.jobId}-${tableId}-${offset}`,
        );
        written.push(...batch);
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  const verified: VideoUpdateChange[] = [];
  const verificationFailures: Array<{ key: string; reason: string }> = [];
  for (const change of written) {
    const actual = await gateway.getRecord(change.tableId, change.tableName, change.recordId);
    const valid = Object.entries(change.afterFields).every(
      ([field, value]) => equivalentScalar(actual.fields[field], value),
    );
    if (valid) verified.push(change);
    else verificationFailures.push({ key: change.uniqueKey, reason: "写后读取值与计划不一致" });
  }

  const rollback = {
    version: 1,
    jobId: plan.jobId,
    confirmation: `ROLLBACK-${plan.jobId}`,
    operations: verified.map((change) => ({
      tableId: change.tableId,
      tableName: change.tableName,
      recordId: change.recordId,
      expectedAfter: change.afterFields,
      restoreFields: Object.fromEntries(
        Object.keys(change.afterFields).map((field) => [field, change.beforeFields[field]]),
      ),
    })),
  };
  await writeJson(path.join(backupDirectory, "rollback.json"), rollback);
  const rollbackCommand = `pnpm exec tsx src/cli/realtime-rollback.ts --job-id ${plan.jobId} --confirm ROLLBACK-${plan.jobId}`;
  await writeFile(
    path.join(backupDirectory, "ROLLBACK.cmd"),
    `@echo off\r\ncd /d "${PROJECT_ROOT}"\r\ncall ${rollbackCommand}\r\n`,
    "ascii",
  );

  const result = {
    version: 1,
    jobId: plan.jobId,
    completedAt: new Date().toISOString(),
    planned: plan.changes.length,
    written: written.length,
    verified: verified.length,
    concurrencyConflicts,
    verificationFailures,
    failure,
    stoppedAfterFailure: Boolean(failure),
  };
  await writeJson(path.join(backupDirectory, "result.json"), result);
  if (failure) throw new Error(`飞书写入失败，后续批次已停止：${failure}`);
  if (verificationFailures.length > 0) {
    throw new Error(`飞书写后验证失败 ${verificationFailures.length} 条；请使用该 job 回滚文件`);
  }
  return {
    windowStart: plan.windowStart,
    windowEndExclusive: plan.windowEndExclusive,
    sources: plan.sourceFiles,
    matched: plan.matched,
    created: 0,
    updated: verified.length,
    unchanged: plan.unchanged,
    skipped: plan.skipped + concurrencyConflicts.length,
    conflicts: plan.conflicts.length + concurrencyConflicts.length,
    missingItems: plan.missingItems,
    backupPath: backupDirectory,
    rollbackCommand,
  };
}

export async function executeRollback(
  jobId: string,
  confirmation: string,
  gateway: FeishuRealtimeGateway,
  backupRoot = BACKUP_ROOT,
): Promise<{ restored: number; skipped: number; resultPath: string; alreadyCompleted?: boolean }> {
  if (!/^rt-\d{14}-[a-f0-9]{8}$/.test(jobId)) throw new Error("job_id 格式无效");
  if (confirmation !== `ROLLBACK-${jobId}`) throw new Error("回滚确认参数不匹配");
  const inspection = await inspectRollback(jobId, backupRoot);
  if (inspection.completedResult) {
    return { ...inspection.completedResult, alreadyCompleted: true };
  }
  const directory = path.join(backupRoot, jobId);
  const rollback = JSON.parse(await readFile(path.join(directory, "rollback.json"), "utf8")) as {
    jobId: string;
    operations: Array<{
      action?: "restore" | "delete_created";
      tableId: string;
      tableName: string;
      recordId: string;
      expectedAfter: Record<string, unknown>;
      restoreFields: Record<string, unknown>;
    }>;
  };
  if (rollback.jobId !== jobId) throw new Error("回滚清单 job_id 与请求不一致");
  const readyRestore: typeof rollback.operations = [];
  const readyDelete: typeof rollback.operations = [];
  let skipped = 0;
  for (const operation of rollback.operations) {
    if (operation.action === "delete_created" && !(await gateway.recordExists(operation.tableId, operation.recordId))) {
      skipped += 1;
      continue;
    }
    const current = await gateway.getRecord(operation.tableId, operation.tableName, operation.recordId);
    const stillOwned = Object.entries(operation.expectedAfter).every(
      ([field, value]) => equivalentScalar(current.fields[field], value),
    );
    if (stillOwned && operation.action === "delete_created") readyDelete.push(operation);
    else if (stillOwned) readyRestore.push(operation);
    else skipped += 1;
  }
  if (typeof (gateway as any).updateOne === "function") {
    for (const operation of readyRestore) {
      await gateway.updateOne(
        operation.tableId,
        operation.tableName,
        operation.recordId,
        operation.restoreFields,
      );
      const restored = await gateway.getRecord(operation.tableId, operation.tableName, operation.recordId);
      const verified = Object.entries(operation.restoreFields).every(
        ([field, value]) => equivalentScalar(restored.fields[field], value),
      );
      if (!verified) throw new Error(`回滚逐条写后验证失败：${operation.tableName}/${operation.recordId}`);
    }
  } else {
    // Compatibility path for existing gateways and isolated tests.
    for (const [tableId, operations] of groupBy(readyRestore, (operation) => operation.tableId)) {
      for (let offset = 0; offset < operations.length; offset += 50) {
        const batch = operations.slice(offset, offset + 50);
        await gateway.batchUpdate(
          tableId,
          batch.map((operation) => ({ recordId: operation.recordId, fields: operation.restoreFields })),
          `rollback-${jobId}-${tableId}-${offset}`,
        );
      }
    }
  }
  for (const [tableId, operations] of groupBy(readyDelete, (operation) => operation.tableId)) {
    for (let offset = 0; offset < operations.length; offset += 500) {
      const batch = operations.slice(offset, offset + 500);
      await gateway.batchDelete(
        tableId,
        batch.map((operation) => operation.recordId),
        `rollback-delete-${jobId}-${tableId}-${offset}`,
      );
    }
  }
  for (const operation of readyRestore) {
    const actual = await gateway.getRecord(operation.tableId, operation.tableName, operation.recordId);
    const restored = Object.entries(operation.restoreFields).every(
      ([field, value]) => equivalentScalar(actual.fields[field], value),
    );
    if (!restored) throw new Error(`回滚写后验证失败：${operation.tableName}/${operation.recordId}`);
  }
  for (const operation of readyDelete) {
    if (await gateway.recordExists(operation.tableId, operation.recordId)) {
      throw new Error(`回滚删除新增记录失败：${operation.tableName}/${operation.recordId}`);
    }
  }
  const resultPath = path.join(directory, "rollback-result.json");
  await writeJson(resultPath, {
    version: 1,
    jobId,
    completedAt: new Date().toISOString(),
    restored: readyRestore.length + readyDelete.length,
    skipped,
  });
  return { restored: readyRestore.length + readyDelete.length, skipped, resultPath };
}

export interface RollbackInspection {
  jobId: string;
  operationCount: number;
  tableNames: string[];
  fieldNames: string[];
  backupHashVerified: boolean;
  completedResult: { restored: number; skipped: number; resultPath: string } | null;
}

export async function inspectRollback(
  jobId: string,
  backupRoot = BACKUP_ROOT,
): Promise<RollbackInspection> {
  if (!/^rt-\d{14}-[a-f0-9]{8}$/.test(jobId)) throw new Error("job_id 格式无效");
  const directory = path.join(backupRoot, jobId);
  const beforeText = await readFile(path.join(directory, "before.json"), "utf8");
  const sidecar = await readFile(path.join(directory, "before.sha256"), "ascii");
  const expectedHash = sidecar.trim().split(/\s+/)[0]?.toLowerCase();
  const actualHash = createHash("sha256").update(beforeText).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(expectedHash ?? "") || expectedHash !== actualHash) {
    throw new Error("写前备份 SHA256 校验失败，拒绝回滚");
  }
  const rollback = JSON.parse(await readFile(path.join(directory, "rollback.json"), "utf8")) as {
    jobId: string;
    operations: Array<{
      action?: "restore" | "delete_created";
      tableName: string;
      expectedAfter: Record<string, unknown>;
      restoreFields: Record<string, unknown>;
    }>;
  };
  if (rollback.jobId !== jobId || !Array.isArray(rollback.operations)) {
    throw new Error("回滚清单与任务不一致");
  }
  let completedResult: RollbackInspection["completedResult"] = null;
  const resultPath = path.join(directory, "rollback-result.json");
  try {
    const prior = JSON.parse(await readFile(resultPath, "utf8")) as {
      jobId?: string;
      restored?: number;
      skipped?: number;
    };
    if (prior.jobId !== jobId) throw new Error("回滚结果与任务不一致");
    completedResult = {
      restored: Number(prior.restored ?? 0),
      skipped: Number(prior.skipped ?? 0),
      resultPath,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    jobId,
    operationCount: rollback.operations.length,
    tableNames: [...new Set(rollback.operations.map((operation) => operation.tableName))].sort(),
    fieldNames: [...new Set(rollback.operations.flatMap((operation) => (
      operation.action === "delete_created"
        ? ["（删除本任务新增记录）"]
        : Object.keys(operation.restoreFields)
    )))].sort(),
    backupHashVerified: true,
    completedResult,
  };
}

export function extractVideoId(value: unknown): string | null {
  const texts = collectStrings(value);
  for (const text of texts) {
    const match = text.match(/\/video\/(\d{10,})/i);
    if (match) return match[1];
  }
  return null;
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [record.link, record.text, record.url].flatMap(collectStrings);
  }
  return [];
}

function numericId(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return /^\d{10,}$/.test(text) ? text : null;
}

function nonnegativeInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function scalarText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  const strings = collectStrings(value);
  return strings.length === 1 ? strings[0].trim() : JSON.stringify(value);
}

function equivalentScalar(left: unknown, right: unknown): boolean {
  return scalarText(left) === scalarText(right);
}

function hasNonzeroUncalibratedSales(rows: TikTokVideoRow[]): boolean {
  return rows.some((row) => {
    const items = Number(row.items_sold ?? 0);
    const gmv = Number(row.gmv_amount ?? 0);
    return (Number.isFinite(items) && items !== 0) || (Number.isFinite(gmv) && gmv !== 0);
  });
}

function tableIndex(name: string): number {
  return Number(name.match(/(\d+)$/)?.[1] ?? 0);
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    const current = groups.get(value) ?? [];
    current.push(item);
    groups.set(value, current);
  }
  return groups;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function withFeishuRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastCode = 0;
  let lastMessage = "未知错误";
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const details = feishuErrorDetails(error);
      lastCode = details.code;
      lastMessage = details.message;
      const retryable = details.code === 1254607
        || details.status === 429
        || details.status >= 500;
      if (!retryable || attempt === 5) {
        throw new Error(`飞书 API 失败（${details.code || details.status || "unknown"}）：${details.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** (attempt - 1), 5) * 1_000));
    }
  }
  throw new Error(`飞书 API 重试耗尽（${lastCode || "unknown"}）：${lastMessage}`);
}

function feishuErrorDetails(error: unknown): { code: number; status: number; message: string } {
  const value = error as {
    response?: { status?: unknown; data?: { code?: unknown; msg?: unknown } };
    status?: unknown;
    message?: unknown;
  };
  const code = Number(value?.response?.data?.code ?? 0);
  const status = Number(value?.response?.status ?? value?.status ?? 0);
  const rawMessage = String(value?.response?.data?.msg ?? value?.message ?? "未知错误");
  const message = rawMessage
    .replace(/Bearer\s+\S+/gi, "Bearer ****")
    .replace(/(?:app_secret|access_token|refresh_token|Authorization)(\s*[:=]\s*)\S+/gi, "$1****")
    .slice(0, 500);
  return { code, status, message };
}
