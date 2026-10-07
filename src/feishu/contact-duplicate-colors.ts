import { createHash } from "node:crypto";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { AppEnv } from "../config/env.js";
import { assertFeishuResponse } from "./client.js";
import {
  ContactCountIndex,
  collectContactRecordChanges,
  type BitableRecordChangeEvent,
  type ContactIndexUpdate,
} from "./contact-duplicate-index.js";

export const CONTACT_FIELD_ID = "fld50bR4xy";
export const CONTACT_FIELD_NAME = "联系方式（邮箱/WhatsApp）";

// Feishu's option palette contains 55 colors arranged as 5 shades x 11 hues.
// 44 is the strongest red in the first hue column; 10 is the light neutral gray.
export const DUPLICATE_CONTACT_COLOR = 44;
export const UNIQUE_CONTACT_COLOR = 10;

const INVISIBLE_CHARACTERS = /[\u200B-\u200D\u2060\u2063\uFEFF]/g;
const PHONE_CHARACTERS = /^[\d\s()+\-./\\]+$/;
const WHATSAPP_PREFIX = /^whats\s*app\s*[:：-]?\s*/;
const EVENT_BATCH_WINDOW_MS = 800;
const EVENT_BATCH_RECORD_LIMIT = 1_000;
const BATCH_GET_LIMIT = 100;
const PERIODIC_RECONCILIATION_MS = 60 * 60_000;
const RECONCILIATION_IDLE_MS = 30_000;
const FAILED_RETRY_MS = 5_000;
const RETRY_DELAYS_MS = [0, 250, 750, 1_500, 3_000] as const;
const RETRYABLE_CODES = new Set([1254002, 1254290, 1254291, 1254607]);

export interface ContactRecord {
  recordId: string;
  value: string;
}

export interface SelectOption {
  name?: string;
  id?: string;
  color?: number;
}

export interface ContactFieldState {
  field_name: string;
  field_id?: string;
  type: number;
  ui_type?: string;
  is_hidden?: boolean;
  description?: unknown;
  property?: {
    options?: SelectOption[];
  };
}

export interface ContactColorPlan {
  options: SelectOption[];
  nonblankRecords: number;
  exactValues: number;
  normalizedValues: number;
  duplicateGroups: number;
  duplicateRecords: number;
  changedOptions: number;
  addedOptions: number;
}

export interface ContactSnapshot {
  capturedAtUtc: string;
  appTokenRedacted: true;
  tableId: string;
  field: ContactFieldState;
  records: ContactRecord[];
  summary: {
    totalRecords: number;
    nonblankRecords: number;
    exactValues: number;
    normalizedValues: number;
    duplicateGroups: number;
    duplicateRecords: number;
    recordsSha256: string;
  };
}

export interface ContactSyncResult {
  skipped: boolean;
  reason: string;
  fieldType: number;
  totalRecords: number;
  nonblankRecords: number;
  duplicateGroups: number;
  duplicateRecords: number;
  changedOptions: number;
  addedOptions: number;
  fieldUpdated: boolean;
}

export function contactCellToString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) {
          return String((item as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("")
      .trim();
  }
  if (typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "").trim();
  }
  return String(value).trim();
}

export function normalizeContact(value: unknown): string {
  const raw = contactCellToString(value)
    .normalize("NFKC")
    .replace(INVISIBLE_CHARACTERS, "")
    .trim()
    .toLocaleLowerCase("en-US");

  if (!raw) return "";
  if (raw.includes("@")) return raw.replace(/\s+/g, "");

  const phoneCandidate = raw.replace(WHATSAPP_PREFIX, "");
  const digits = phoneCandidate.replace(/\D/g, "");
  if (digits.length >= 7 && PHONE_CHARACTERS.test(phoneCandidate)) {
    return `${phoneCandidate.includes("+") ? "+" : ""}${digits}`;
  }

  return raw.replace(/\s+/g, " ");
}

export function buildContactColorPlan(
  records: readonly ContactRecord[],
  existingOptions: readonly SelectOption[] = [],
): ContactColorPlan {
  const normalizedCounts = new Map<string, number>();
  const exactValues = new Map<string, true>();
  let nonblankRecords = 0;

  for (const record of records) {
    const value = record.value.trim();
    const normalized = normalizeContact(value);
    if (!value || !normalized) continue;
    nonblankRecords += 1;
    exactValues.set(value, true);
    normalizedCounts.set(normalized, (normalizedCounts.get(normalized) ?? 0) + 1);
  }

  const duplicateGroups = [...normalizedCounts.values()].filter((count) => count > 1).length;
  const duplicateRecords = [...normalizedCounts.values()]
    .filter((count) => count > 1)
    .reduce((sum, count) => sum + count, 0);

  const options: SelectOption[] = [];
  const coveredNames = new Set<string>();
  let changedOptions = 0;

  for (const option of existingOptions) {
    const name = String(option.name ?? "");
    if (!name || coveredNames.has(name)) continue;
    coveredNames.add(name);
    const count = normalizedCounts.get(normalizeContact(name)) ?? 0;
    const color = count > 1 ? DUPLICATE_CONTACT_COLOR : UNIQUE_CONTACT_COLOR;
    if (option.color !== color) changedOptions += 1;
    options.push({
      ...(option.id ? { id: option.id } : {}),
      name,
      color,
    });
  }

  let addedOptions = 0;
  for (const name of exactValues.keys()) {
    if (coveredNames.has(name)) continue;
    coveredNames.add(name);
    addedOptions += 1;
    const count = normalizedCounts.get(normalizeContact(name)) ?? 0;
    options.push({
      name,
      color: count > 1 ? DUPLICATE_CONTACT_COLOR : UNIQUE_CONTACT_COLOR,
    });
  }

  return {
    options,
    nonblankRecords,
    exactValues: exactValues.size,
    normalizedValues: normalizedCounts.size,
    duplicateGroups,
    duplicateRecords,
    changedOptions,
    addedOptions,
  };
}

export interface IncrementalContactColorPlan {
  options: SelectOption[];
  changedOptions: number;
  addedOptions: number;
}

export function buildIncrementalContactColorPlan(
  index: ContactCountIndex,
  impactedNormalizedValues: ReadonlySet<string>,
  currentValues: ReadonlySet<string>,
  existingOptions: readonly SelectOption[],
): IncrementalContactColorPlan {
  const options: SelectOption[] = [];
  const coveredNames = new Set<string>();
  let changedOptions = 0;

  for (const option of existingOptions) {
    const name = String(option.name ?? "");
    if (!name || coveredNames.has(name)) continue;
    coveredNames.add(name);
    const normalized = normalizeContact(name);
    const desiredColor = impactedNormalizedValues.has(normalized)
      ? (index.count(normalized) > 1 ? DUPLICATE_CONTACT_COLOR : UNIQUE_CONTACT_COLOR)
      : option.color;
    if (desiredColor !== option.color) changedOptions += 1;
    options.push({
      ...(option.id ? { id: option.id } : {}),
      name,
      ...(desiredColor === undefined ? {} : { color: desiredColor }),
    });
  }

  let addedOptions = 0;
  for (const value of currentValues) {
    const name = value.trim();
    if (!name || coveredNames.has(name)) continue;
    coveredNames.add(name);
    addedOptions += 1;
    const normalized = normalizeContact(name);
    options.push({
      name,
      color: index.count(normalized) > 1 ? DUPLICATE_CONTACT_COLOR : UNIQUE_CONTACT_COLOR,
    });
  }

  return { options, changedOptions, addedOptions };
}

export class ContactDuplicateColorService {
  private timer: NodeJS.Timeout | null = null;
  private periodicTimer: NodeJS.Timeout | null = null;
  private processing = false;
  private initialized = false;
  private fullReconciliationRequested = false;
  private readonly pendingRecordIds = new Set<string>();
  private readonly index = new ContactCountIndex(normalizeContact);
  private contactFieldId: string | null = null;
  private lastEventAt = 0;

  public constructor(
    private readonly env: AppEnv,
    private readonly client: Client,
  ) {}

  public async subscribeToBaseEvents(): Promise<void> {
    try {
      await this.withRetry("订阅多维表格变更事件", () => (
        this.client.drive.file.subscribe({
          path: { file_token: this.env.FEISHU_BITABLE_APP_TOKEN },
          params: { file_type: "bitable" },
        })
      ));
    } catch (error) {
      const details = error as {
        message?: string;
        response?: { status?: number; data?: unknown };
      };
      throw new Error(
        `订阅多维表格变更事件失败：HTTP ${details.response?.status ?? "unknown"}；`
        + `${JSON.stringify(details.response?.data ?? details.message ?? "unknown")}`,
      );
    }
  }

  public handleRecordChanged(event: BitableRecordChangeEvent): void {
    if (
      event.file_token !== this.env.FEISHU_BITABLE_APP_TOKEN
      || event.table_id !== this.env.FEISHU_BITABLE_TABLE_ID
    ) {
      return;
    }

    const changes = collectContactRecordChanges(event, this.contactFieldId);
    if (changes.recordIds.size === 0 && !changes.requiresFullReconciliation) return;
    this.lastEventAt = Date.now();
    for (const recordId of changes.recordIds) this.pendingRecordIds.add(recordId);
    if (changes.requiresFullReconciliation) this.fullReconciliationRequested = true;
    this.scheduleDrain();
  }

  public async start(): Promise<ContactSyncResult> {
    const result = await this.sync("bot_startup");
    if (!this.periodicTimer) {
      this.periodicTimer = setInterval(() => {
        if (Date.now() - this.lastEventAt < RECONCILIATION_IDLE_MS) return;
        this.fullReconciliationRequested = true;
        this.scheduleDrain(0);
      }, PERIODIC_RECONCILIATION_MS);
      this.periodicTimer.unref();
    }
    return result;
  }

  public async waitForIdle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (
      this.processing
      || this.timer !== null
      || this.pendingRecordIds.size > 0
      || this.fullReconciliationRequested
    ) {
      if (Date.now() >= deadline) throw new Error("等待联系方式增量队列空闲超时");
      await sleep(10);
    }
  }

  public async captureSnapshot(): Promise<ContactSnapshot> {
    const records = await this.readRecords();
    const field = await this.readField();
    const plan = buildContactColorPlan(records, field.property?.options ?? []);
    return {
      capturedAtUtc: new Date().toISOString(),
      appTokenRedacted: true,
      tableId: this.env.FEISHU_BITABLE_TABLE_ID,
      field,
      records,
      summary: {
        totalRecords: records.length,
        nonblankRecords: plan.nonblankRecords,
        exactValues: plan.exactValues,
        normalizedValues: plan.normalizedValues,
        duplicateGroups: plan.duplicateGroups,
        duplicateRecords: plan.duplicateRecords,
        recordsSha256: hashRecords(records),
      },
    };
  }

  public async installFromSnapshot(snapshot: ContactSnapshot): Promise<ContactSyncResult> {
    if (!snapshot.field.field_id || snapshot.field.field_name !== CONTACT_FIELD_NAME) {
      throw new Error(`联系方式字段不匹配：${snapshot.field.field_name ?? "missing"}`);
    }
    this.contactFieldId = snapshot.field.field_id;
    if (![1, 3].includes(snapshot.field.type)) {
      throw new Error(`联系方式字段类型 ${snapshot.field.type} 不支持原位转换。`);
    }

    if (snapshot.field.type === 1) {
      const plan = buildContactColorPlan(snapshot.records);
      await this.updateFieldToSingleSelect(plan.options);
    }

    const current = await this.captureSnapshot();
    const mismatch = compareRecordValues(snapshot.records, current.records);
    if (mismatch.length > 0) {
      throw new Error(`字段转换后发现 ${mismatch.length} 条联系方式不一致，停止安装并要求回滚。`);
    }
    return this.sync("install");
  }

  public async sync(reason = "manual"): Promise<ContactSyncResult> {
    const records = await this.readRecords();
    let field = await this.readField();

    if (field.type !== 3 || field.ui_type !== "SingleSelect") {
      return {
        skipped: true,
        reason: `联系方式字段尚未转换为单选（type=${field.type}, ui=${field.ui_type ?? "unknown"}）`,
        fieldType: field.type,
        totalRecords: records.length,
        nonblankRecords: 0,
        duplicateGroups: 0,
        duplicateRecords: 0,
        changedOptions: 0,
        addedOptions: 0,
        fieldUpdated: false,
      };
    }

    let plan = buildContactColorPlan(records, field.property?.options ?? []);
    let fieldUpdated = false;
    if (plan.changedOptions > 0 || plan.addedOptions > 0) {
      const reconciliation = await this.reconcileAllOptions(records);
      plan = reconciliation.plan;
      fieldUpdated = reconciliation.fieldUpdated;
    }
    this.index.reset(records);
    this.initialized = true;
    this.scheduleDrain(0);

    return {
      skipped: false,
      reason,
      fieldType: field.type,
      totalRecords: records.length,
      nonblankRecords: plan.nonblankRecords,
      duplicateGroups: plan.duplicateGroups,
      duplicateRecords: plan.duplicateRecords,
      changedOptions: plan.changedOptions,
      addedOptions: plan.addedOptions,
      fieldUpdated,
    };
  }

  public async rollback(snapshot: ContactSnapshot): Promise<{
    restoredRecords: number;
    fieldType: number;
    verified: boolean;
  }> {
    this.contactFieldId = snapshot.field.field_id ?? null;
    await this.updateFieldToText();
    let current = await this.readRecords();
    const mismatches = compareRecordValues(snapshot.records, current);

    if (mismatches.length > 0) {
      for (let index = 0; index < mismatches.length; index += 1_000) {
        const batch = mismatches.slice(index, index + 1_000);
        await this.withRetry("回滚联系方式字段值", () => (
          this.client.bitable.appTableRecord.batchUpdate({
            path: {
              app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
              table_id: this.env.FEISHU_BITABLE_TABLE_ID,
            },
            data: {
              records: batch.map((record) => ({
                record_id: record.recordId,
                fields: { [CONTACT_FIELD_NAME]: record.value },
              })),
            },
          })
        ));
      }
      current = await this.readRecords();
    }

    const remaining = compareRecordValues(snapshot.records, current);
    const field = await this.readField();
    return {
      restoredRecords: mismatches.length,
      fieldType: field.type,
      verified: remaining.length === 0 && field.type === 1,
    };
  }

  private scheduleDrain(delayMs = EVENT_BATCH_WINDOW_MS): void {
    if (
      !this.initialized
      || this.processing
      || this.timer
      || (!this.fullReconciliationRequested && this.pendingRecordIds.size === 0)
    ) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drainPendingChanges();
    }, delayMs);
    this.timer.unref();
  }

  private async drainPendingChanges(): Promise<void> {
    if (this.processing || !this.initialized) return;
    this.processing = true;
    try {
      while (this.fullReconciliationRequested || this.pendingRecordIds.size > 0) {
        if (this.fullReconciliationRequested) {
          this.fullReconciliationRequested = false;
          try {
            const startedAt = Date.now();
            const result = await this.sync("safety_reconciliation");
            console.log(`[contact-colors] ${JSON.stringify({
              ...result,
              mode: "full",
              durationMs: Date.now() - startedAt,
            })}`);
          } catch (error) {
            this.fullReconciliationRequested = true;
            console.error(`[contact-colors] 全量校验失败：${error instanceof Error ? error.message : String(error)}`);
            this.scheduleDrain(FAILED_RETRY_MS);
            return;
          }
          continue;
        }

        const recordIds = [...this.pendingRecordIds].slice(0, EVENT_BATCH_RECORD_LIMIT);
        for (const recordId of recordIds) this.pendingRecordIds.delete(recordId);
        try {
          const result = await this.processIncrementalBatch(recordIds);
          console.log(`[contact-colors] ${JSON.stringify(result)}`);
        } catch (error) {
          for (const recordId of recordIds) this.pendingRecordIds.add(recordId);
          this.fullReconciliationRequested = true;
          console.error(`[contact-colors] 增量同步失败，转入全量校验：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      this.processing = false;
      if (this.fullReconciliationRequested || this.pendingRecordIds.size > 0) {
        this.scheduleDrain(this.fullReconciliationRequested ? FAILED_RETRY_MS : 0);
      }
    }
  }

  private async processIncrementalBatch(recordIds: string[]): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const latest = await this.readRecordsByIds(recordIds);
    const updates: ContactIndexUpdate[] = recordIds.map((recordId) => ({
      recordId,
      value: latest.records.get(recordId) ?? null,
    }));
    const delta = this.index.apply(updates);
    let changedOptions = 0;
    let addedOptions = 0;

    if (delta.impactedNormalizedValues.size > 0) {
      const update = await this.updateImpactedOptions(
        delta.impactedNormalizedValues,
        delta.currentValues,
      );
      changedOptions = update.changedOptions;
      addedOptions = update.addedOptions;
    }

    const stats = this.index.stats();
    return {
      skipped: false,
      reason: "record_changed_event",
      mode: "incremental",
      eventRecords: recordIds.length,
      changedRecords: delta.changedRecords,
      fetchedRecords: latest.records.size,
      absentRecords: latest.absentRecordIds.size,
      totalRecords: stats.totalRecords,
      nonblankRecords: stats.nonblankRecords,
      duplicateGroups: stats.duplicateGroups,
      duplicateRecords: stats.duplicateRecords,
      changedOptions,
      addedOptions,
      fieldUpdated: changedOptions > 0 || addedOptions > 0,
      durationMs: Date.now() - startedAt,
    };
  }

  private async readRecordsByIds(recordIds: string[]): Promise<{
    records: Map<string, string>;
    absentRecordIds: Set<string>;
  }> {
    const records = new Map<string, string>();
    const absentRecordIds = new Set<string>();

    for (let offset = 0; offset < recordIds.length; offset += BATCH_GET_LIMIT) {
      const batch = recordIds.slice(offset, offset + BATCH_GET_LIMIT);
      const response = await this.withRetry("批量读取变化记录", () => (
        this.client.bitable.appTableRecord.batchGet({
          path: {
            app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
            table_id: this.env.FEISHU_BITABLE_TABLE_ID,
          },
          data: {
            record_ids: batch,
            automatic_fields: false,
          },
        })
      ));
      const forbidden = response.data?.forbidden_record_ids ?? [];
      if (forbidden.length > 0) {
        throw new Error(`${forbidden.length} 条变化记录无读取权限`);
      }
      for (const item of response.data?.records ?? []) {
        const recordId = String(item.record_id ?? "");
        if (!recordId) continue;
        records.set(recordId, contactCellToString(item.fields?.[CONTACT_FIELD_NAME]));
      }
      for (const recordId of response.data?.absent_record_ids ?? []) {
        absentRecordIds.add(recordId);
      }
    }

    const unresolved = recordIds.filter((recordId) => (
      !records.has(recordId) && !absentRecordIds.has(recordId)
    ));
    if (unresolved.length > 0) {
      throw new Error(`${unresolved.length} 条变化记录状态未知`);
    }
    return { records, absentRecordIds };
  }

  private async reconcileAllOptions(records: readonly ContactRecord[]): Promise<{
    plan: ContactColorPlan;
    fieldUpdated: boolean;
  }> {
    let latestPlan: ContactColorPlan | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const field = await this.readField();
      latestPlan = buildContactColorPlan(records, field.property?.options ?? []);
      if (latestPlan.changedOptions === 0 && latestPlan.addedOptions === 0) {
        return { plan: latestPlan, fieldUpdated: false };
      }

      const confirmation = await this.readField();
      if (
        optionFingerprint(field.property?.options ?? [])
        !== optionFingerprint(confirmation.property?.options ?? [])
      ) {
        continue;
      }

      try {
        await this.updateFieldToSingleSelect(latestPlan.options);
        await this.verifyOptions(latestPlan.options);
        return { plan: latestPlan, fieldUpdated: true };
      } catch (error) {
        if (attempt === 2) throw error;
        await sleep(RETRY_DELAYS_MS[attempt + 1]);
      }
    }
    if (!latestPlan) throw new Error("无法生成联系方式全量颜色计划");
    return { plan: latestPlan, fieldUpdated: false };
  }

  private async updateImpactedOptions(
    impactedNormalizedValues: ReadonlySet<string>,
    currentValues: ReadonlySet<string>,
  ): Promise<{ changedOptions: number; addedOptions: number }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const field = await this.readField();
      if (field.type !== 3 || field.ui_type !== "SingleSelect") {
        throw new Error("联系方式字段不是单选");
      }
      const plan = buildIncrementalContactColorPlan(
        this.index,
        impactedNormalizedValues,
        currentValues,
        field.property?.options ?? [],
      );
      if (plan.changedOptions === 0 && plan.addedOptions === 0) {
        return { changedOptions: 0, addedOptions: 0 };
      }

      // A second read narrows the race window with people creating new select
      // options. If metadata changed, merge again instead of overwriting it.
      const confirmation = await this.readField();
      if (
        optionFingerprint(field.property?.options ?? [])
        !== optionFingerprint(confirmation.property?.options ?? [])
      ) {
        continue;
      }

      try {
        await this.updateFieldToSingleSelect(plan.options);
        await this.verifyOptions(plan.options);
        return {
          changedOptions: plan.changedOptions,
          addedOptions: plan.addedOptions,
        };
      } catch (error) {
        if (attempt === 2) throw error;
        await sleep(RETRY_DELAYS_MS[attempt + 1]);
      }
    }
    throw new Error("联系方式选项持续发生并发变化，已转入安全重试");
  }

  private async readField(): Promise<ContactFieldState> {
    let pageToken: string | undefined;
    do {
      const response = await this.withRetry("读取联系方式字段", () => (
        this.client.bitable.appTableField.list({
          path: {
            app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
            table_id: this.env.FEISHU_BITABLE_TABLE_ID,
          },
          params: { page_size: 100, page_token: pageToken },
        })
      ));
      const items = (response.data?.items ?? []) as ContactFieldState[];
      const field = items.find((item) => item.field_id === this.contactFieldId)
        ?? items.find((item) => item.field_name === CONTACT_FIELD_NAME)
        ?? items.find((item) => item.field_id === CONTACT_FIELD_ID);
      if (field) {
        this.contactFieldId = field.field_id ?? null;
        return field;
      }
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    throw new Error(`没有找到联系方式字段“${CONTACT_FIELD_NAME}”`);
  }

  private async readRecords(): Promise<ContactRecord[]> {
    const records: ContactRecord[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.withRetry("读取联系方式记录", () => (
        this.client.bitable.appTableRecord.list({
          path: {
            app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
            table_id: this.env.FEISHU_BITABLE_TABLE_ID,
          },
          params: {
            page_size: 500,
            page_token: pageToken,
            field_names: JSON.stringify([CONTACT_FIELD_NAME]),
          },
        })
      ));
      for (const item of response.data?.items ?? []) {
        const recordId = String(item.record_id ?? "");
        if (!recordId) continue;
        records.push({
          recordId,
          value: contactCellToString(item.fields?.[CONTACT_FIELD_NAME]),
        });
      }
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    return records;
  }

  private async updateFieldToSingleSelect(options: SelectOption[]): Promise<void> {
    const fieldId = await this.requireContactFieldId();
    const clientToken = createHash("sha256")
      .update(JSON.stringify(options.map((option) => [option.id ?? "", option.name ?? "", option.color ?? -1])))
      .digest("hex");
    const response = await this.client.bitable.appTableField.update({
      path: {
        app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
        table_id: this.env.FEISHU_BITABLE_TABLE_ID,
        field_id: fieldId,
      },
      params: { client_token: clientToken },
      data: {
        field_name: CONTACT_FIELD_NAME,
        type: 3,
        ui_type: "SingleSelect",
        property: { options },
        is_hidden: false,
      },
    });
    if (response.code === 1254606) return;
    assertFeishuResponse(response, "更新联系方式单选颜色");
  }

  private async updateFieldToText(): Promise<void> {
    const fieldId = await this.requireContactFieldId();
    await this.withRetry("回滚联系方式字段为文本", () => (
      this.client.bitable.appTableField.update({
        path: {
          app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
          table_id: this.env.FEISHU_BITABLE_TABLE_ID,
          field_id: fieldId,
        },
        params: { client_token: `rollback-${Date.now()}` },
        data: {
          field_name: CONTACT_FIELD_NAME,
          type: 1,
          ui_type: "Text",
          is_hidden: false,
        },
      })
    ), new Set([1254606]));
  }

  private async verifyOptions(options: readonly SelectOption[]): Promise<void> {
    const field = await this.readField();
    if (field.type !== 3 || field.ui_type !== "SingleSelect") {
      throw new Error("写后验证失败：联系方式字段不是单选。");
    }
    const current = new Map(
      (field.property?.options ?? []).map((option) => [String(option.name ?? ""), option]),
    );
    const mismatches = options.filter((expected) => {
      const actual = current.get(String(expected.name ?? ""));
      return !actual || actual.color !== expected.color;
    });
    if (mismatches.length > 0) {
      throw new Error(`写后验证失败：${mismatches.length} 个选项颜色不一致。`);
    }
  }

  private async withRetry<T extends { code?: number; msg?: string }>(
    action: string,
    request: () => Promise<T>,
    acceptedCodes: ReadonlySet<number> = new Set(),
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
      const delayMs = RETRY_DELAYS_MS[attempt];
      if (delayMs > 0) await sleep(delayMs);
      try {
        const response = await request();
        if (!response.code || response.code === 0 || acceptedCodes.has(response.code)) {
          return response;
        }
        if (!RETRYABLE_CODES.has(response.code) || attempt === RETRY_DELAYS_MS.length - 1) {
          assertFeishuResponse(response, action);
        }
        lastError = new Error(`${action}暂时失败（${response.code}）：${response.msg ?? "未知错误"}`);
      } catch (error) {
        lastError = error;
        if (!isRetryableError(error) || attempt === RETRY_DELAYS_MS.length - 1) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${action}失败`);
  }

  private async requireContactFieldId(): Promise<string> {
    if (this.contactFieldId) return this.contactFieldId;
    const field = await this.readField();
    if (!field.field_id) throw new Error(`联系方式字段“${CONTACT_FIELD_NAME}”缺少字段 ID`);
    return field.field_id;
  }
}

export function compareRecordValues(
  expected: readonly ContactRecord[],
  actual: readonly ContactRecord[],
): ContactRecord[] {
  const actualById = new Map(actual.map((record) => [record.recordId, record.value]));
  return expected.filter((record) => actualById.get(record.recordId) !== record.value);
}

function hashRecords(records: readonly ContactRecord[]): string {
  const canonical = [...records]
    .sort((left, right) => left.recordId.localeCompare(right.recordId))
    .map((record) => `${record.recordId}\0${record.value}`)
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

function optionFingerprint(options: readonly SelectOption[]): string {
  return createHash("sha256")
    .update(JSON.stringify(options.map((option) => [
      option.id ?? "",
      option.name ?? "",
      option.color ?? -1,
    ])))
    .digest("hex");
}

function isRetryableError(error: unknown): boolean {
  const details = error as {
    message?: string;
    response?: { status?: number; data?: { code?: number } };
  };
  const status = details.response?.status;
  const code = details.response?.data?.code;
  if (status === 429 || (typeof status === "number" && status >= 500)) return true;
  if (typeof code === "number" && RETRYABLE_CODES.has(code)) return true;
  const message = String(details.message ?? error ?? "");
  return [...RETRYABLE_CODES].some((candidate) => message.includes(String(candidate)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
