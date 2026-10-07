import type { Client } from "@larksuiteoapi/node-sdk";
import type { AppEnv } from "../config/env.js";
import { loadBusinessProfile, type BusinessProfile } from "../config/business-profile.js";
import {
  assertFeishuResponse,
  feishuRetryDelayMs,
  isRetryableFeishuError,
  withFeishuBitableQuotaCircuit,
} from "./client.js";
import {
  contactCellToString,
  normalizeContact,
} from "./contact-duplicate-colors.js";
import type { BitableRecordChangeEvent } from "./contact-duplicate-index.js";

const EVENT_BATCH_WINDOW_MS = 800;
const EVENT_BATCH_RECORD_LIMIT = 1_000;
const BATCH_GET_LIMIT = 100;
const BATCH_UPDATE_LIMIT = 500;
// The formal Feishu app does not consistently deliver bitable record-change
// events for every direct grid edit. Keep event-driven updates for speed, and
// use a lightweight full read as a deterministic fallback for live editing.
const PERIODIC_RECONCILIATION_MS = 5 * 60_000;
const RECONCILIATION_IDLE_MS = 30_000;
const FAILED_RETRY_MS = 5_000;
const RETRY_DELAYS_MS = [0, 500, 1_500] as const;
const RETRYABLE_CODES = new Set([1254002, 1254290, 1254291, 1254607]);
const INVISIBLE_CHARACTERS = /[\u200B-\u200D\u2060\u2063\uFEFF]/g;
export const DUPLICATE_CELL_MARKER = "\u2063";
export const DUPLICATE_FLAG_VALUE = "重复";

export type DuplicateValueKind = "text" | "contact" | "url";

export interface DuplicateTargetSpec {
  tableName: string;
  fieldName: string;
  flagFieldName: string;
  kind: DuplicateValueKind;
  /**
   * Feishu conditional formatting cannot color a different cell from the one
   * used in the condition. For the user-facing cooperation/online fields we
   * therefore keep the hidden audit flag and add/remove an invisible marker
   * in the source cell. The view rule can then color exactly that cell.
   */
  markSourceCell?: boolean;
}

export function duplicateTargetsForProfile(profile: BusinessProfile): readonly DuplicateTargetSpec[] {
  const businessTables = profile.tables;
  return [
  {
    tableName: businessTables.development,
    fieldName: "红人姓名",
    flagFieldName: "__重复_红人姓名",
    kind: "text",
  },
  {
    tableName: businessTables.development,
    fieldName: "邮箱",
    flagFieldName: "__重复_邮箱",
    kind: "contact",
  },
  {
    tableName: businessTables.development,
    fieldName: "whatsapp",
    flagFieldName: "__重复_whatsapp",
    kind: "contact",
  },
  {
    tableName: businessTables.cooperation,
    fieldName: "红人姓名",
    flagFieldName: "__重复_红人姓名",
    kind: "text",
    markSourceCell: true,
  },
  {
    tableName: businessTables.cooperation,
    fieldName: "联系方式（邮箱/WhatsApp）",
    flagFieldName: "__重复_联系方式",
    kind: "contact",
    markSourceCell: true,
  },
  {
    tableName: businessTables.online,
    fieldName: "达人姓名",
    flagFieldName: "__重复_达人姓名",
    kind: "text",
    markSourceCell: true,
  },
  {
    tableName: businessTables.online,
    fieldName: "视频上线地址",
    flagFieldName: "__重复_视频上线地址",
    kind: "url",
    markSourceCell: true,
  },
  {
    tableName: businessTables.online,
    fieldName: "AD CODE（没有要到的备注要码时间）",
    flagFieldName: "__重复_AD CODE",
    kind: "text",
    markSourceCell: true,
  },
  ] as const;
}

export const DEFAULT_DUPLICATE_TARGETS: readonly DuplicateTargetSpec[] = duplicateTargetsForProfile(loadBusinessProfile());

interface ResolvedTarget extends DuplicateTargetSpec {
  tableId: string;
  fieldId: string;
  flagFieldId: string;
  recordValues: Map<string, string>;
  groups: Map<string, Set<string>>;
  flagStates: Map<string, boolean>;
}

interface ResolvedTable {
  tableId: string;
  tableName: string;
  targets: ResolvedTarget[];
  pendingRecordIds: Set<string>;
  timer: NodeJS.Timeout | null;
  processing: boolean;
  fullReconciliationRequested: boolean;
  initialized: boolean;
  lastEventAt: number;
}

interface RecordState {
  recordId: string;
  values: Map<string, unknown>;
  flags: Map<string, boolean>;
}

export interface DuplicateTargetSummary {
  tableName: string;
  fieldName: string;
  records: number;
  duplicateGroups: number;
  duplicateRecords: number;
  flagsChanged: number;
  sourceCellsChanged: number;
}

export function normalizeDuplicateValue(value: unknown, kind: DuplicateValueKind): string {
  if (kind === "contact") return normalizeContact(value);
  const urlValue = kind === "url" && value && typeof value === "object" && "link" in value
    ? String((value as { link?: unknown }).link ?? "")
    : value;
  const raw = contactCellToString(urlValue)
    .normalize("NFKC")
    .replace(INVISIBLE_CHARACTERS, "")
    .trim();
  if (!raw) return "";
  if (kind === "text") return raw.toLocaleLowerCase("en-US").replace(/\s+/g, " ");
  try {
    const url = new URL(raw);
    url.hostname = url.hostname.toLocaleLowerCase("en-US");
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return raw.toLocaleLowerCase("en-US").replace(/\/+$/, "");
  }
}

export function buildDuplicateFlags(
  records: ReadonlyArray<{ recordId: string; value: unknown }>,
  kind: DuplicateValueKind,
): Map<string, boolean> {
  const normalized = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const record of records) {
    const value = normalizeDuplicateValue(record.value, kind);
    normalized.set(record.recordId, value);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return new Map(
    [...normalized].map(([recordId, value]) => [
      recordId,
      Boolean(value && (counts.get(value) ?? 0) > 1),
    ]),
  );
}

export function isDuplicateFlagValue(value: unknown): boolean {
  return value === true || contactCellToString(value).trim() === DUPLICATE_FLAG_VALUE;
}

export function hasDuplicateCellMarker(value: unknown): boolean {
  return contactCellToString(value).startsWith(DUPLICATE_CELL_MARKER);
}

export function markedDuplicateCellValue(
  value: unknown,
  duplicate: boolean,
): unknown | undefined {
  if (typeof value === "string") {
    const clean = value.replaceAll(DUPLICATE_CELL_MARKER, "");
    const desired = duplicate && clean ? `${DUPLICATE_CELL_MARKER}${clean}` : clean;
    return desired === value ? undefined : desired;
  }
  if (Array.isArray(value)) {
    const current = contactCellToString(value);
    const clean = current.replaceAll(DUPLICATE_CELL_MARKER, "");
    const desired = duplicate && clean ? `${DUPLICATE_CELL_MARKER}${clean}` : clean;
    return desired === current ? undefined : desired;
  }
  if (value && typeof value === "object" && "link" in value) {
    const current = String((value as { text?: unknown }).text ?? "");
    const clean = current.replaceAll(DUPLICATE_CELL_MARKER, "");
    const fallback = String((value as { link?: unknown }).link ?? "");
    const desiredText = duplicate && (clean || fallback)
      ? `${DUPLICATE_CELL_MARKER}${clean || fallback}`
      : (clean || fallback);
    if (desiredText === current) return undefined;
    return { ...value, text: desiredText };
  }
  return undefined;
}

export class DuplicateCellFlagService {
  private readonly tables = new Map<string, ResolvedTable>();
  private periodicTimer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly env: AppEnv,
    private readonly client: Client,
    private readonly specs: readonly DuplicateTargetSpec[] = DEFAULT_DUPLICATE_TARGETS,
    private readonly externalBusy: () => boolean = () => false,
  ) {}

  public async start(): Promise<DuplicateTargetSummary[]> {
    await this.discoverTargets();
    const summaries: DuplicateTargetSummary[] = [];
    for (const table of this.tables.values()) {
      summaries.push(...await this.reconcileTable(table, "bot_startup"));
    }
    if (!this.periodicTimer) {
      this.periodicTimer = setInterval(() => {
        for (const table of this.tables.values()) {
          if (Date.now() - table.lastEventAt < RECONCILIATION_IDLE_MS) continue;
          table.fullReconciliationRequested = true;
          this.scheduleDrain(table, 0);
        }
      }, PERIODIC_RECONCILIATION_MS);
      this.periodicTimer.unref();
    }
    return summaries;
  }

  public handleRecordChanged(event: BitableRecordChangeEvent): void {
    if (event.file_token !== this.env.FEISHU_BITABLE_APP_TOKEN) return;
    const table = this.tables.get(String(event.table_id ?? ""));
    if (!table) return;
    // A duplicate state change affects every member of both the old and new
    // groups. Feishu events can omit before-values, so a full table read is the
    // only deterministic way to remove stale markers from former group peers.
    table.pendingRecordIds.clear();
    table.fullReconciliationRequested = true;
    table.lastEventAt = Date.now();
    this.scheduleDrain(table);
  }

  public async waitForIdle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ([...this.tables.values()].some((table) => (
      table.processing
      || table.timer !== null
      || table.pendingRecordIds.size > 0
      || table.fullReconciliationRequested
    ))) {
      if (Date.now() >= deadline) throw new Error("等待重复值队列空闲超时");
      await sleep(10);
    }
  }

  private async discoverTargets(): Promise<void> {
    const tables = await this.listTables();
    const tableIdsByName = new Map(
      tables.map((table) => [String(table.name ?? ""), String(table.table_id ?? "")]),
    );
    const specsByTable = new Map<string, DuplicateTargetSpec[]>();
    for (const spec of this.specs) {
      const list = specsByTable.get(spec.tableName) ?? [];
      list.push(spec);
      specsByTable.set(spec.tableName, list);
    }

    this.tables.clear();
    for (const [tableName, specs] of specsByTable) {
      const tableId = tableIdsByName.get(tableName);
      if (!tableId) throw new Error(`没有找到重复值目标表“${tableName}”`);
      const fields = await this.listFields(tableId);
      const fieldIdsByName = new Map(
        fields.map((field) => [String(field.field_name ?? ""), String(field.field_id ?? "")]),
      );
      const targets: ResolvedTarget[] = specs.map((spec) => {
        const fieldId = fieldIdsByName.get(spec.fieldName);
        const flagFieldId = fieldIdsByName.get(spec.flagFieldName);
        if (!fieldId || !flagFieldId) {
          throw new Error(
            `“${tableName}”缺少字段“${!fieldId ? spec.fieldName : spec.flagFieldName}”`,
          );
        }
        return {
          ...spec,
          tableId,
          fieldId,
          flagFieldId,
          recordValues: new Map(),
          groups: new Map(),
          flagStates: new Map(),
        };
      });
      this.tables.set(tableId, {
        tableId,
        tableName,
        targets,
        pendingRecordIds: new Set(),
        timer: null,
        processing: false,
        fullReconciliationRequested: false,
        initialized: false,
        lastEventAt: 0,
      });
    }
  }

  private scheduleDrain(table: ResolvedTable, delayMs = EVENT_BATCH_WINDOW_MS): void {
    if (
      !table.initialized
      || table.processing
      || table.timer
      || (!table.fullReconciliationRequested && table.pendingRecordIds.size === 0)
    ) return;
    table.timer = setTimeout(() => {
      table.timer = null;
      void this.drainTable(table);
    }, delayMs);
    table.timer.unref();
  }

  private async drainTable(table: ResolvedTable): Promise<void> {
    if (table.processing || !table.initialized) return;
    if (this.externalBusy()) {
      this.scheduleDrain(table, 30_000);
      return;
    }
    table.processing = true;
    try {
      while (table.fullReconciliationRequested || table.pendingRecordIds.size > 0) {
        if (table.fullReconciliationRequested) {
          table.fullReconciliationRequested = false;
          try {
            const summaries = await this.reconcileTable(table, "safety_reconciliation");
            console.log(`[duplicate-flags] ${JSON.stringify({ mode: "full", summaries })}`);
          } catch (error) {
            table.fullReconciliationRequested = true;
            console.error(
              `[duplicate-flags] ${table.tableName} 全量校验失败：`
              + `${error instanceof Error ? error.message : String(error)}`,
            );
            this.scheduleDrain(table, feishuRetryDelayMs(error, FAILED_RETRY_MS));
            return;
          }
          continue;
        }

        const recordIds = [...table.pendingRecordIds].slice(0, EVENT_BATCH_RECORD_LIMIT);
        for (const recordId of recordIds) table.pendingRecordIds.delete(recordId);
        try {
          const result = await this.processIncrementalBatch(table, recordIds);
          console.log(`[duplicate-flags] ${JSON.stringify(result)}`);
        } catch (error) {
          for (const recordId of recordIds) table.pendingRecordIds.add(recordId);
          table.fullReconciliationRequested = true;
          console.error(
            `[duplicate-flags] ${table.tableName} 增量同步失败，转入全量校验：`
            + `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      table.processing = false;
      if (table.fullReconciliationRequested || table.pendingRecordIds.size > 0) {
        this.scheduleDrain(table, table.fullReconciliationRequested ? FAILED_RETRY_MS : 0);
      }
    }
  }

  private async reconcileTable(
    table: ResolvedTable,
    reason: string,
  ): Promise<DuplicateTargetSummary[]> {
    const records = await this.readAllRecords(table);
    const desiredByRecord = new Map<string, Record<string, unknown>>();
    const summaries: DuplicateTargetSummary[] = [];

    for (const target of table.targets) {
      target.recordValues.clear();
      target.groups.clear();
      target.flagStates.clear();
      for (const record of records) {
        const normalized = normalizeDuplicateValue(
          record.values.get(target.fieldName) ?? "",
          target.kind,
        );
        target.recordValues.set(record.recordId, normalized);
        if (normalized) {
          const group = target.groups.get(normalized) ?? new Set<string>();
          group.add(record.recordId);
          target.groups.set(normalized, group);
        }
        target.flagStates.set(record.recordId, record.flags.get(target.flagFieldName) ?? false);
      }

      let duplicateGroups = 0;
      let duplicateRecords = 0;
      for (const members of target.groups.values()) {
        if (members.size <= 1) continue;
        duplicateGroups += 1;
        duplicateRecords += members.size;
      }
      let flagsChanged = 0;
      let sourceCellsChanged = 0;
      for (const record of records) {
        const normalized = target.recordValues.get(record.recordId) ?? "";
        const desired = Boolean(normalized && (target.groups.get(normalized)?.size ?? 0) > 1);
        const fields = desiredByRecord.get(record.recordId) ?? {};
        let changed = false;
        if ((target.flagStates.get(record.recordId) ?? false) !== desired) {
          fields[target.flagFieldName] = desired ? DUPLICATE_FLAG_VALUE : "";
          flagsChanged += 1;
          changed = true;
        }
        if (target.markSourceCell) {
          const markedValue = markedDuplicateCellValue(
            record.values.get(target.fieldName),
            desired,
          );
          if (markedValue !== undefined) {
            fields[target.fieldName] = markedValue;
            sourceCellsChanged += 1;
            changed = true;
          }
        }
        if (changed) desiredByRecord.set(record.recordId, fields);
      }
      summaries.push({
        tableName: table.tableName,
        fieldName: target.fieldName,
        records: records.length,
        duplicateGroups,
        duplicateRecords,
        flagsChanged,
        sourceCellsChanged,
      });
    }

    await this.writeFlagUpdates(table, desiredByRecord);
    table.initialized = true;
    table.fullReconciliationRequested = false;
    console.log(`[duplicate-flags] ${JSON.stringify({ reason, table: table.tableName, summaries })}`);
    return summaries;
  }

  private async processIncrementalBatch(
    table: ResolvedTable,
    recordIds: string[],
  ): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const latest = await this.readRecordsByIds(table, recordIds);
    const desiredByRecord = new Map<string, Record<string, unknown>>();
    const affectedByTarget = new Map<ResolvedTarget, Set<string>>();

    for (const target of table.targets) {
      const affected = new Set<string>();
      affectedByTarget.set(target, affected);
      for (const recordId of recordIds) {
        const oldValue = target.recordValues.get(recordId) ?? "";
        const oldMembers = oldValue ? new Set(target.groups.get(oldValue) ?? []) : new Set<string>();
        for (const member of oldMembers) affected.add(member);

        const record = latest.get(recordId);
        if (!record) {
          if (oldValue) {
            const group = target.groups.get(oldValue);
            group?.delete(recordId);
            if (group?.size === 0) target.groups.delete(oldValue);
          }
          target.recordValues.delete(recordId);
          target.flagStates.delete(recordId);
          continue;
        }

        const newValue = normalizeDuplicateValue(
          record.values.get(target.fieldName) ?? "",
          target.kind,
        );
        if (oldValue !== newValue) {
          if (oldValue) {
            const oldGroup = target.groups.get(oldValue);
            oldGroup?.delete(recordId);
            if (oldGroup?.size === 0) target.groups.delete(oldValue);
          }
          target.recordValues.set(recordId, newValue);
          if (newValue) {
            const newGroup = target.groups.get(newValue) ?? new Set<string>();
            newGroup.add(recordId);
            target.groups.set(newValue, newGroup);
          }
        }
        target.flagStates.set(
          recordId,
          record.flags.get(target.flagFieldName) ?? target.flagStates.get(recordId) ?? false,
        );
        affected.add(recordId);
        if (newValue) {
          for (const member of target.groups.get(newValue) ?? []) affected.add(member);
        }
        if (oldValue) {
          for (const member of target.groups.get(oldValue) ?? []) affected.add(member);
        }
      }
    }

    for (const [target, affected] of affectedByTarget) {
      for (const recordId of affected) {
        if (!target.recordValues.has(recordId)) continue;
        const normalized = target.recordValues.get(recordId) ?? "";
        const desired = Boolean(normalized && (target.groups.get(normalized)?.size ?? 0) > 1);
        if ((target.flagStates.get(recordId) ?? false) === desired) continue;
        const fields = desiredByRecord.get(recordId) ?? {};
        fields[target.flagFieldName] = desired ? DUPLICATE_FLAG_VALUE : "";
        desiredByRecord.set(recordId, fields);
      }
    }

    const changedFlags = [...desiredByRecord.values()]
      .reduce((sum, fields) => sum + Object.keys(fields).length, 0);
    await this.writeFlagUpdates(table, desiredByRecord);
    return {
      reason: "record_changed_event",
      mode: "incremental",
      table: table.tableName,
      eventRecords: recordIds.length,
      fetchedRecords: latest.size,
      changedRecords: desiredByRecord.size,
      changedFlags,
      durationMs: Date.now() - startedAt,
    };
  }

  private async writeFlagUpdates(
    table: ResolvedTable,
    desiredByRecord: Map<string, Record<string, unknown>>,
  ): Promise<void> {
    const updates = [...desiredByRecord].map(([recordId, fields]) => ({
      record_id: recordId,
      fields,
    }));
    for (let offset = 0; offset < updates.length; offset += BATCH_UPDATE_LIMIT) {
      const batch = updates.slice(offset, offset + BATCH_UPDATE_LIMIT);
      const response = await this.withRetry("批量写入重复值标记", () => (
        this.client.bitable.appTableRecord.batchUpdate({
          path: {
            app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
            table_id: table.tableId,
          },
          data: { records: batch as any },
        })
      ));
      assertFeishuResponse(response, "批量写入重复值标记");

      const verified = await this.readRecordsByIds(
        table,
        batch.map((item) => item.record_id),
      );
      for (const expected of batch) {
        const actual = verified.get(expected.record_id);
        if (!actual) throw new Error(`写后验证找不到记录 ${expected.record_id}`);
        for (const [fieldName, value] of Object.entries(expected.fields)) {
          const flagTarget = table.targets.find((target) => target.flagFieldName === fieldName);
          if (flagTarget && (actual.flags.get(fieldName) ?? false) !== isDuplicateFlagValue(value)) {
            throw new Error(`写后验证失败：${expected.record_id} / ${fieldName}`);
          }
          const sourceTarget = table.targets.find((target) => target.fieldName === fieldName);
          if (sourceTarget) {
            const actualValue = actual.values.get(fieldName);
            if (
              hasDuplicateCellMarker(actualValue) !== hasDuplicateCellMarker(value)
              || normalizeDuplicateValue(actualValue, sourceTarget.kind)
                !== normalizeDuplicateValue(value, sourceTarget.kind)
            ) {
              throw new Error(`重复单元格标记写后验证失败：${expected.record_id} / ${fieldName}`);
            }
          }
        }
      }

      for (const expected of batch) {
        for (const target of table.targets) {
          if (Object.hasOwn(expected.fields, target.flagFieldName)) {
            target.flagStates.set(
              expected.record_id,
              isDuplicateFlagValue(expected.fields[target.flagFieldName]),
            );
          }
        }
      }
    }
  }

  private async readAllRecords(table: ResolvedTable): Promise<RecordState[]> {
    const records: RecordState[] = [];
    const fieldNames = table.targets.flatMap((target) => [
      target.fieldName,
      target.flagFieldName,
    ]);
    let pageToken: string | undefined;
    do {
      const response = await this.withRetry("读取重复值目标记录", () => (
        this.client.bitable.appTableRecord.list({
          path: {
            app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
            table_id: table.tableId,
          },
          params: {
            page_size: 500,
            page_token: pageToken,
            field_names: JSON.stringify(fieldNames),
          },
        })
      ));
      for (const item of response.data?.items ?? []) {
        const recordId = String(item.record_id ?? "");
        if (!recordId) continue;
        records.push(this.toRecordState(table, recordId, item.fields ?? {}));
      }
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    return records;
  }

  private async readRecordsByIds(
    table: ResolvedTable,
    recordIds: string[],
  ): Promise<Map<string, RecordState>> {
    const records = new Map<string, RecordState>();
    for (let offset = 0; offset < recordIds.length; offset += BATCH_GET_LIMIT) {
      const batch = recordIds.slice(offset, offset + BATCH_GET_LIMIT);
      const response = await this.withRetry("批量读取变化记录", () => (
        this.client.bitable.appTableRecord.batchGet({
          path: {
            app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
            table_id: table.tableId,
          },
          data: {
            record_ids: batch,
            automatic_fields: false,
          },
        })
      ));
      if ((response.data?.forbidden_record_ids ?? []).length > 0) {
        throw new Error("变化记录存在无读取权限的行");
      }
      for (const item of response.data?.records ?? []) {
        const recordId = String(item.record_id ?? "");
        if (!recordId) continue;
        records.set(recordId, this.toRecordState(table, recordId, item.fields ?? {}));
      }
      const absent = new Set((response.data?.absent_record_ids ?? []).map(String));
      for (const recordId of batch) {
        if (!records.has(recordId) && !absent.has(recordId)) {
          throw new Error(`变化记录 ${recordId} 状态未知`);
        }
      }
    }
    return records;
  }

  private toRecordState(
    table: ResolvedTable,
    recordId: string,
    fields: Record<string, unknown>,
  ): RecordState {
    const values = new Map<string, unknown>();
    const flags = new Map<string, boolean>();
    for (const target of table.targets) {
      values.set(target.fieldName, fields[target.fieldName]);
      flags.set(target.flagFieldName, isDuplicateFlagValue(fields[target.flagFieldName]));
    }
    return { recordId, values, flags };
  }

  private async listTables(): Promise<Array<{ table_id?: string; name?: string }>> {
    const items: Array<{ table_id?: string; name?: string }> = [];
    let pageToken: string | undefined;
    do {
      const response = await this.withRetry("读取多维表格清单", () => (
        this.client.bitable.appTable.list({
          path: { app_token: this.env.FEISHU_BITABLE_APP_TOKEN },
          params: { page_size: 100, page_token: pageToken },
        })
      ));
      items.push(...(response.data?.items ?? []));
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    return items;
  }

  private async listFields(
    tableId: string,
  ): Promise<Array<{ field_id?: string; field_name?: string }>> {
    const items: Array<{ field_id?: string; field_name?: string }> = [];
    let pageToken: string | undefined;
    do {
      const response = await this.withRetry("读取重复值目标字段", () => (
        this.client.bitable.appTableField.list({
          path: {
            app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
            table_id: tableId,
          },
          params: { page_size: 100, page_token: pageToken },
        })
      ));
      items.push(...(response.data?.items ?? []));
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    return items;
  }

  private async withRetry<T extends { code?: number; msg?: string }>(
    action: string,
    request: () => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
      const delayMs = RETRY_DELAYS_MS[attempt];
      if (delayMs > 0) await sleep(delayMs);
      try {
        const response = await withFeishuBitableQuotaCircuit(this.env.FEISHU_APP_ID, request);
        if (!response.code || response.code === 0) return response;
        if (!RETRYABLE_CODES.has(response.code) || attempt === RETRY_DELAYS_MS.length - 1) {
          assertFeishuResponse(response, action);
        }
        lastError = new Error(`${action}暂时失败（${response.code}）：${response.msg ?? "未知错误"}`);
      } catch (error) {
        lastError = error;
        if (!isRetryableFeishuError(error) || attempt === RETRY_DELAYS_MS.length - 1) break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${action}失败`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
