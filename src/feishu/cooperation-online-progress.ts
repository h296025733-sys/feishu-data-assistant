import { createHash } from "node:crypto";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { AppEnv } from "../config/env.js";
import { loadBusinessProfile, type BusinessProfile } from "../config/business-profile.js";
import { normalizeTikTokHandle } from "../realtime/tiktok-identity.js";
import type { BitableRecordChangeEvent } from "./contact-duplicate-index.js";
import {
  assertFeishuResponse,
  feishuRetryDelayMs,
  isRetryableFeishuError,
  withFeishuBitableQuotaCircuit,
} from "./client.js";

const CREATOR_COOP_FIELD = "红人姓名";
const COOP_DATE_FIELD = "合作时间";
const COOP_PRODUCT_FIELD = "寄样产品";
const PROGRESS_FIELD = "进度条";
const CREATOR_ONLINE_FIELD = "达人姓名";
const ONLINE_DATE_FIELD = "实上线日期(Ct)";
const ONLINE_PRODUCT_FIELD = "挂车产品";
const ONLINE_PROGRESS = "已上线";
const EVENT_DEBOUNCE_MS = 800;
const EXTERNAL_BUSY_RETRY_MS = 1_500;
const PERIODIC_RECONCILIATION_MS = 5 * 60_000;
const PAGE_SIZE = 500;
const TRANSIENT_DELAYS_MS = [0, 500, 1_500] as const;
const TERMINAL_PROGRESS_PATTERN = /(?:完成|结算|终止|取消|拒绝|不合作|合作结束)/;

export interface CooperationProgressRecord {
  recordId: string;
  creatorHandle: string;
  cooperationDate: string;
  products: string[];
  progress: string;
  lastModifiedTime?: number;
}

export interface OnlineProgressEvidence {
  recordId: string;
  creatorHandle: string;
  onlineDate: string;
  products: string[];
}

export interface CooperationProgressUpdate {
  cooperationRecordId: string;
  creatorHandle: string;
  cooperationDate: string;
  products: string[];
  previousProgress: string;
  targetProgress: typeof ONLINE_PROGRESS;
  onlineRecordIds: string[];
}

export interface CooperationProgressDiagnostic {
  onlineRecordId: string;
  reason: string;
  candidateRecordIds: string[];
}

export interface CooperationOnlineProgressPlan {
  matchedOnlineRecords: number;
  updates: CooperationProgressUpdate[];
  alreadyOnlineRecordIds: string[];
  protectedRecordIds: string[];
  incompleteOnline: CooperationProgressDiagnostic[];
  unmatchedOnline: CooperationProgressDiagnostic[];
  ambiguousOnline: CooperationProgressDiagnostic[];
}

export interface CooperationOnlineProgressResult {
  reason: string;
  cooperationRecords: number;
  onlineRecords: number;
  matchedOnlineRecords: number;
  updated: number;
  pendingUpdates: number;
  alreadyOnline: number;
  protectedLaterProgress: number;
  incompleteOnline: number;
  unmatchedOnline: number;
  ambiguousOnline: number;
  targetOptionAdded: boolean;
  changedRecordIds: string[];
  diagnostics: CooperationProgressDiagnostic[];
}

interface SelectOption {
  id?: string;
  name?: string;
  color?: number;
}

interface FieldItem {
  field_id?: string;
  field_name?: string;
  type?: number;
  ui_type?: string;
  property?: { options?: SelectOption[]; [key: string]: unknown };
}

interface TableIds {
  cooperation: string;
  online: string;
}

interface RecordItem {
  record_id?: string;
  fields?: Record<string, unknown>;
  last_modified_time?: number;
}

interface ProgressContext {
  tableIds: TableIds;
  progressField: FieldItem;
  progressOptions: string[];
  targetOptionAdded: boolean;
}

export function buildCooperationOnlineProgressPlan(
  cooperationRecords: readonly CooperationProgressRecord[],
  onlineRecords: readonly OnlineProgressEvidence[],
  progressOptions: readonly string[],
): CooperationOnlineProgressPlan {
  const byHandle = new Map<string, CooperationProgressRecord[]>();
  for (const record of cooperationRecords) {
    if (!record.recordId || !record.creatorHandle || !record.cooperationDate || record.products.length === 0) continue;
    const rows = byHandle.get(record.creatorHandle) ?? [];
    rows.push(record);
    byHandle.set(record.creatorHandle, rows);
  }
  for (const rows of byHandle.values()) {
    rows.sort((left, right) => (
      right.cooperationDate.localeCompare(left.cooperationDate)
      || left.recordId.localeCompare(right.recordId)
    ));
  }

  const updateEvidence = new Map<string, Set<string>>();
  const selectedRecords = new Map<string, CooperationProgressRecord>();
  const alreadyOnlineRecordIds = new Set<string>();
  const protectedRecordIds = new Set<string>();
  const incompleteOnline: CooperationProgressDiagnostic[] = [];
  const unmatchedOnline: CooperationProgressDiagnostic[] = [];
  const ambiguousOnline: CooperationProgressDiagnostic[] = [];
  let matchedOnlineRecords = 0;

  for (const online of onlineRecords) {
    if (!online.recordId || !online.creatorHandle || !online.onlineDate || online.products.length === 0) {
      incompleteOnline.push({
        onlineRecordId: online.recordId,
        reason: missingOnlineReason(online),
        candidateRecordIds: [],
      });
      continue;
    }
    const onlineProducts = new Set(online.products.map(normalizeProduct).filter(Boolean));
    const handleMatches = byHandle.get(online.creatorHandle) ?? [];
    const eligible = handleMatches.filter((cooperation) => (
      cooperation.cooperationDate <= online.onlineDate
      && [...onlineProducts].every((product) => cooperation.products.map(normalizeProduct).includes(product))
    ));
    if (eligible.length === 0) {
      unmatchedOnline.push({
        onlineRecordId: online.recordId,
        reason: handleMatches.length === 0
          ? "没有同一达人账号的合作记录"
          : "没有同时满足商品一致且合作时间不晚于上线时间的合作记录",
        candidateRecordIds: handleMatches.map((record) => record.recordId),
      });
      continue;
    }
    const latestDate = eligible[0]!.cooperationDate;
    const latest = eligible.filter((record) => record.cooperationDate === latestDate);
    if (latest.length !== 1) {
      ambiguousOnline.push({
        onlineRecordId: online.recordId,
        reason: `同一达人、商品和最近合作日 ${latestDate} 仍有 ${latest.length} 条合作记录`,
        candidateRecordIds: latest.map((record) => record.recordId),
      });
      continue;
    }

    const cooperation = latest[0]!;
    matchedOnlineRecords += 1;
    if (cooperation.progress === ONLINE_PROGRESS) {
      alreadyOnlineRecordIds.add(cooperation.recordId);
      continue;
    }
    if (!canAdvanceProgress(cooperation.progress, progressOptions)) {
      protectedRecordIds.add(cooperation.recordId);
      continue;
    }
    selectedRecords.set(cooperation.recordId, cooperation);
    const evidence = updateEvidence.get(cooperation.recordId) ?? new Set<string>();
    evidence.add(online.recordId);
    updateEvidence.set(cooperation.recordId, evidence);
  }

  const updates = [...selectedRecords.values()].map<CooperationProgressUpdate>((record) => ({
    cooperationRecordId: record.recordId,
    creatorHandle: record.creatorHandle,
    cooperationDate: record.cooperationDate,
    products: [...record.products].sort((a, b) => a.localeCompare(b, "zh-CN")),
    previousProgress: record.progress,
    targetProgress: ONLINE_PROGRESS,
    onlineRecordIds: [...(updateEvidence.get(record.recordId) ?? [])].sort(),
  })).sort((left, right) => (
    left.cooperationDate.localeCompare(right.cooperationDate)
    || left.creatorHandle.localeCompare(right.creatorHandle)
    || left.cooperationRecordId.localeCompare(right.cooperationRecordId)
  ));

  return {
    matchedOnlineRecords,
    updates,
    alreadyOnlineRecordIds: [...alreadyOnlineRecordIds].sort(),
    protectedRecordIds: [...protectedRecordIds].sort(),
    incompleteOnline,
    unmatchedOnline,
    ambiguousOnline,
  };
}

export class CooperationOnlineProgressService {
  private context: ProgressContext | null = null;
  private timer: NodeJS.Timeout | null = null;
  private periodicTimer: NodeJS.Timeout | null = null;
  private running = false;
  private rerunRequested = false;
  private retryNotBefore = 0;

  public constructor(
    private readonly env: AppEnv,
    private readonly client: Client,
    private readonly profile: BusinessProfile = loadBusinessProfile(),
    private readonly externalBusy: () => boolean = () => false,
  ) {}

  public async start(): Promise<CooperationOnlineProgressResult> {
    if (!this.periodicTimer) {
      this.periodicTimer = setInterval(() => {
        this.rerunRequested = true;
        this.schedule(0);
      }, PERIODIC_RECONCILIATION_MS);
      this.periodicTimer.unref();
    }
    try {
      this.context = await this.discoverContext(true);
      return await this.reconcile("startup", true);
    } catch (error) {
      throw error;
    }
  }

  public handleRecordChanged(event: BitableRecordChangeEvent): void {
    if (event.file_token && event.file_token !== this.env.FEISHU_BITABLE_APP_TOKEN) return;
    if (!this.context) return;
    const tableId = String(event.table_id ?? "");
    if (![this.context.tableIds.cooperation, this.context.tableIds.online].includes(tableId)) return;
    this.rerunRequested = true;
    this.schedule();
  }

  public async preview(reason = "preview"): Promise<CooperationOnlineProgressResult> {
    this.context = await this.discoverContext(false);
    return this.reconcile(reason, false);
  }

  public async reconcileNow(reason = "manual"): Promise<CooperationOnlineProgressResult> {
    this.context = await this.discoverContext(true);
    return this.reconcile(reason, true);
  }

  public async waitForIdle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.running || this.timer || this.rerunRequested) {
      if (Date.now() >= deadline) throw new Error("等待合作进度自动推进队列空闲超时");
      await sleep(20);
    }
  }

  private schedule(delayMs = EVENT_DEBOUNCE_MS): void {
    if (this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delayMs);
    this.timer.unref();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    if (Date.now() < this.retryNotBefore) {
      this.schedule(this.retryNotBefore - Date.now());
      return;
    }
    if (this.externalBusy()) {
      this.rerunRequested = true;
      this.schedule(EXTERNAL_BUSY_RETRY_MS);
      return;
    }
    this.running = true;
    let retryDelayMs = EVENT_DEBOUNCE_MS;
    try {
      do {
        this.rerunRequested = false;
        if (!this.context) this.context = await this.discoverContext(true);
        const result = await this.reconcile("record_changed_event", true);
        console.log(`[cooperation-online-progress] ${JSON.stringify(result)}`);
      } while (this.rerunRequested && !this.externalBusy());
    } catch (error) {
      console.error(`[cooperation-online-progress:${this.profile.businessDisplayName}] 同步失败：${error instanceof Error ? error.message : String(error)}`);
      this.rerunRequested = true;
      retryDelayMs = feishuRetryDelayMs(error, PERIODIC_RECONCILIATION_MS);
      this.retryNotBefore = Date.now() + retryDelayMs;
    } finally {
      this.running = false;
      if (this.rerunRequested) this.schedule(this.externalBusy() ? EXTERNAL_BUSY_RETRY_MS : retryDelayMs);
    }
  }

  private async reconcile(reason: string, apply: boolean): Promise<CooperationOnlineProgressResult> {
    if (!this.context) throw new Error("合作进度自动推进器尚未完成表发现");
    const [cooperationRecords, onlineRecords] = await Promise.all([
      this.readCooperationRecords(this.context.tableIds.cooperation),
      this.readOnlineRecords(this.context.tableIds.online),
    ]);
    const plan = buildCooperationOnlineProgressPlan(
      cooperationRecords,
      onlineRecords,
      this.context.progressOptions,
    );
    const changedRecordIds: string[] = [];
    if (apply) {
      for (const update of plan.updates) {
        const changed = await this.applyUpdate(update, this.context);
        if (changed) changedRecordIds.push(update.cooperationRecordId);
        else this.rerunRequested = true;
      }
    }
    const diagnostics = [
      ...plan.incompleteOnline,
      ...plan.unmatchedOnline,
      ...plan.ambiguousOnline,
    ];
    return {
      reason,
      cooperationRecords: cooperationRecords.length,
      onlineRecords: onlineRecords.length,
      matchedOnlineRecords: plan.matchedOnlineRecords,
      updated: changedRecordIds.length,
      pendingUpdates: apply ? Math.max(0, plan.updates.length - changedRecordIds.length) : plan.updates.length,
      alreadyOnline: plan.alreadyOnlineRecordIds.length,
      protectedLaterProgress: plan.protectedRecordIds.length,
      incompleteOnline: plan.incompleteOnline.length,
      unmatchedOnline: plan.unmatchedOnline.length,
      ambiguousOnline: plan.ambiguousOnline.length,
      targetOptionAdded: this.context.targetOptionAdded,
      changedRecordIds,
      diagnostics,
    };
  }

  private async applyUpdate(
    update: CooperationProgressUpdate,
    context: ProgressContext,
  ): Promise<boolean> {
    const current = await this.getRecord(context.tableIds.cooperation, update.cooperationRecordId);
    const currentRow = this.toCooperationRecord(current);
    if (!sameCooperationIdentity(currentRow, update)) return false;
    if (currentRow.progress === ONLINE_PROGRESS) return true;
    if (!canAdvanceProgress(currentRow.progress, context.progressOptions)) return false;
    const response: any = await this.withRetry(() => (this.client.bitable.appTableRecord as any).update({
      path: {
        app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
        table_id: context.tableIds.cooperation,
        record_id: update.cooperationRecordId,
      },
      params: {
        client_token: createHash("sha256")
          .update(`cooperation-online-progress|${update.cooperationRecordId}|${ONLINE_PROGRESS}`)
          .digest("hex")
          .slice(0, 32),
      },
      data: { fields: { [PROGRESS_FIELD]: ONLINE_PROGRESS } },
    }));
    assertFeishuResponse(response, `把合作记录 ${update.cooperationRecordId} 推进为已上线`);
    const verified = await this.getRecord(context.tableIds.cooperation, update.cooperationRecordId);
    if (cellText(verified.fields?.[PROGRESS_FIELD]) !== ONLINE_PROGRESS) {
      throw new Error(`合作记录 ${update.cooperationRecordId} 的进度写后回读不是“已上线”`);
    }
    return true;
  }

  private async discoverContext(ensureTargetOption: boolean): Promise<ProgressContext> {
    const tables = await this.listTables();
    const one = (name: string): string => {
      const matches = tables.filter((item) => item.name === name && item.table_id);
      if (matches.length !== 1) throw new Error(`应恰好发现一张“${name}”，实际 ${matches.length} 张`);
      return String(matches[0]!.table_id);
    };
    const tableIds = {
      cooperation: one(this.profile.tables.cooperation),
      online: one(this.profile.tables.online),
    };
    let progressField = this.requireProgressField(await this.listFields(tableIds.cooperation));
    let options = progressField.property?.options ?? [];
    let targetOptionAdded = false;
    if (!options.some((option) => option.name === ONLINE_PROGRESS)) {
      if (ensureTargetOption) {
        const updatedOptions = [...options, { name: ONLINE_PROGRESS, color: 34 }];
        const response: any = await this.withRetry(() => (this.client.bitable.appTableField as any).update({
          path: {
            app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
            table_id: tableIds.cooperation,
            field_id: progressField.field_id,
          },
          params: {
            client_token: createHash("sha256")
              .update(`cooperation-progress-option|${tableIds.cooperation}|${ONLINE_PROGRESS}`)
              .digest("hex")
              .slice(0, 32),
          },
          data: {
            field_name: PROGRESS_FIELD,
            type: 3,
            ui_type: "SingleSelect",
            property: { ...(progressField.property ?? {}), options: updatedOptions },
          },
        }));
        assertFeishuResponse(response, "给合作表进度条增加“已上线”选项");
        progressField = this.requireProgressField(await this.listFields(tableIds.cooperation));
        options = progressField.property?.options ?? [];
        if (!options.some((option) => option.name === ONLINE_PROGRESS)) {
          throw new Error("合作表进度条的“已上线”选项写后回读失败");
        }
        targetOptionAdded = true;
      } else {
        options = [...options, { name: ONLINE_PROGRESS, color: 34 }];
      }
    }
    return {
      tableIds,
      progressField,
      progressOptions: options.map((option) => String(option.name ?? "").trim()).filter(Boolean),
      targetOptionAdded,
    };
  }

  private requireProgressField(fields: FieldItem[]): FieldItem {
    const matches = fields.filter((field) => field.field_name === PROGRESS_FIELD);
    if (matches.length !== 1) throw new Error(`合作表应恰好有一个“${PROGRESS_FIELD}”字段，实际 ${matches.length} 个`);
    const field = matches[0]!;
    if (!field.field_id || field.type !== 3 || field.ui_type !== "SingleSelect") {
      throw new Error(`合作表“${PROGRESS_FIELD}”必须是可写单选字段，当前类型 ${String(field.type)}/${String(field.ui_type)}`);
    }
    return field;
  }

  private async readCooperationRecords(tableId: string): Promise<CooperationProgressRecord[]> {
    return (await this.readAllRecords(tableId, [
      CREATOR_COOP_FIELD,
      this.profile.cooperationDateField ?? COOP_DATE_FIELD,
      COOP_PRODUCT_FIELD,
      PROGRESS_FIELD,
    ])).map((record) => this.toCooperationRecord(record));
  }

  private toCooperationRecord(record: RecordItem): CooperationProgressRecord {
    return {
      recordId: String(record.record_id ?? ""),
      creatorHandle: normalizeTikTokHandle(cellText(record.fields?.[CREATOR_COOP_FIELD])),
      cooperationDate: dateKey(record.fields?.[this.profile.cooperationDateField ?? COOP_DATE_FIELD], this.profile.businessTimeZone),
      products: cellStrings(record.fields?.[COOP_PRODUCT_FIELD]),
      progress: cellText(record.fields?.[PROGRESS_FIELD]),
      lastModifiedTime: Number(record.last_modified_time ?? 0),
    };
  }

  private async readOnlineRecords(tableId: string): Promise<OnlineProgressEvidence[]> {
    return (await this.readAllRecords(tableId, [
      CREATOR_ONLINE_FIELD,
      ONLINE_DATE_FIELD,
      ONLINE_PRODUCT_FIELD,
    ])).map((record) => ({
      recordId: String(record.record_id ?? ""),
      creatorHandle: normalizeTikTokHandle(cellText(record.fields?.[CREATOR_ONLINE_FIELD])),
      onlineDate: dateKey(record.fields?.[ONLINE_DATE_FIELD], this.profile.businessTimeZone),
      products: cellStrings(record.fields?.[ONLINE_PRODUCT_FIELD]),
    }));
  }

  private async listTables(): Promise<Array<{ table_id?: string; name?: string }>> {
    return this.listAll((pageToken) => (this.client.bitable.appTable as any).list({
      path: { app_token: this.env.FEISHU_BITABLE_APP_TOKEN },
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    }), "读取红人表清单");
  }

  private async listFields(tableId: string): Promise<FieldItem[]> {
    return this.listAll((pageToken) => (this.client.bitable.appTableField as any).list({
      path: { app_token: this.env.FEISHU_BITABLE_APP_TOKEN, table_id: tableId },
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    }), "读取合作表字段");
  }

  private async readAllRecords(tableId: string, fieldNames: string[]): Promise<RecordItem[]> {
    return this.listAll((pageToken) => (this.client.bitable.appTableRecord as any).list({
      path: { app_token: this.env.FEISHU_BITABLE_APP_TOKEN, table_id: tableId },
      params: {
        page_size: PAGE_SIZE,
        automatic_fields: false,
        field_names: JSON.stringify(fieldNames),
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    }), "读取合作/上线联动记录");
  }

  private async getRecord(tableId: string, recordId: string): Promise<RecordItem> {
    const response: any = await this.withRetry(() => (this.client.bitable.appTableRecord as any).get({
      path: { app_token: this.env.FEISHU_BITABLE_APP_TOKEN, table_id: tableId, record_id: recordId },
      params: { automatic_fields: false },
    }));
    assertFeishuResponse(response, `读取合作记录 ${recordId}`);
    if (!response.data?.record) throw new Error(`合作记录不存在：${recordId}`);
    return response.data.record;
  }

  private async listAll(
    request: (pageToken?: string) => Promise<any>,
    label: string,
  ): Promise<any[]> {
    const items: any[] = [];
    let pageToken: string | undefined;
    do {
      const response: any = await this.withRetry(() => request(pageToken));
      assertFeishuResponse(response, label);
      items.push(...(response.data?.items ?? []));
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    return items;
  }

  private async withRetry<T>(action: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (const delayMs of TRANSIENT_DELAYS_MS) {
      if (delayMs) await sleep(delayMs);
      try {
        return await withFeishuBitableQuotaCircuit(this.env.FEISHU_APP_ID, action);
      } catch (error) {
        lastError = error;
        if (!isRetryableFeishuError(error)) throw error;
      }
    }
    throw lastError;
  }
}

function canAdvanceProgress(progress: string, progressOptions: readonly string[]): boolean {
  const clean = progress.trim();
  if (!clean) return true;
  if (clean === ONLINE_PROGRESS) return false;
  if (TERMINAL_PROGRESS_PATTERN.test(clean)) return false;
  const targetIndex = progressOptions.indexOf(ONLINE_PROGRESS);
  const currentIndex = progressOptions.indexOf(clean);
  if (currentIndex < 0 || targetIndex < 0) return false;
  return currentIndex < targetIndex;
}

function missingOnlineReason(online: OnlineProgressEvidence): string {
  const missing = [
    ...(!online.creatorHandle ? ["达人姓名"] : []),
    ...(!online.onlineDate ? ["实上线日期(Ct)"] : []),
    ...(online.products.length === 0 ? ["挂车产品"] : []),
  ];
  return `上线记录缺少${missing.join("、") || "唯一匹配字段"}`;
}

function sameCooperationIdentity(
  current: CooperationProgressRecord,
  update: CooperationProgressUpdate,
): boolean {
  return current.creatorHandle === update.creatorHandle
    && current.cooperationDate === update.cooperationDate
    && sameStrings(current.products.map(normalizeProduct), update.products.map(normalizeProduct));
}

function sameStrings(left: string[], right: string[]): boolean {
  const a = [...new Set(left.filter(Boolean))].sort();
  const b = [...new Set(right.filter(Boolean))].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function normalizeProduct(value: string): string {
  return value.replace(/\u2063/g, "").trim().toLocaleLowerCase("zh-CN");
}

function cellStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values.map(cellText).map((item) => item.replace(/\u2063/g, "").trim()).filter(Boolean))];
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join("");
  if (typeof value === "object") {
    const item = value as { name?: unknown; text?: unknown; value?: unknown };
    return cellText(item.name ?? item.text ?? item.value ?? "");
  }
  return String(value).trim();
}

function dateKey(value: unknown, timeZone: string): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  const numeric = typeof value === "number" ? value : Number(cellText(value));
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(numeric));
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return fields.year && fields.month && fields.day ? `${fields.year}-${fields.month}-${fields.day}` : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
