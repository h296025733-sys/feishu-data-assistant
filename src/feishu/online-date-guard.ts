import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { AppEnv } from "../config/env.js";
import { loadBusinessProfile, type BusinessProfile } from "../config/business-profile.js";
import type { BitableRecordChangeEvent } from "./contact-duplicate-index.js";
import {
  assertFeishuResponse,
  isRetryableFeishuError,
  withFeishuBitableQuotaCircuit,
} from "./client.js";
import { trustedOnlineImportDate, trustedOnlineImportDates } from "./online-date-trusted-imports.js";

const FIELD_NAME = "实上线日期(Ct)";
const DATE_FIELD_TYPE = 5;
const STATE_VERSION = 1;
const PAGE_SIZE = 500;
const RETRY_DELAYS_MS = [0, 400, 1_200];

interface GuardState {
  version: number;
  tableId: string;
  fieldId: string;
  updatedAt: string;
  records: Record<string, number | null>;
}

interface CurrentRecord {
  recordId: string;
  date: number | null;
}

export interface OnlineDateGuardStartResult {
  table: string;
  field: string;
  records: number;
  retainedBaselines: number;
  seededBaselines: number;
  driftedRecords: number;
  admins: number;
}

export interface OnlineDateGuardEventResult {
  eventId: string;
  operator: string;
  admin: boolean;
  actions: number;
  corrected: number;
  accepted: number;
  removed: number;
}

export function shanghaiDayStartMs(input: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(input));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  if (!year || !month || !day) throw new Error(`无法解析上海日期：${input}`);
  return Date.UTC(year, month - 1, day) - 8 * 60 * 60_000;
}

export function eventTimestampMs(event: BitableRecordChangeEvent, now = Date.now()): number {
  const update = Number(event.update_time);
  if (Number.isFinite(update) && update > 0) return update < 1_000_000_000_000 ? update * 1_000 : update;
  const rawCreate = String(event.create_time ?? "").trim();
  const numericCreate = Number(rawCreate);
  if (Number.isFinite(numericCreate) && numericCreate > 0) {
    return numericCreate < 1_000_000_000_000 ? numericCreate * 1_000 : numericCreate;
  }
  const parsedCreate = Date.parse(rawCreate);
  return Number.isFinite(parsedCreate) ? parsedCreate : now;
}

export function operatorIds(event: BitableRecordChangeEvent): string[] {
  const operator = event.operator_id;
  return [operator?.open_id, operator?.user_id, operator?.union_id]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
}

export function isAdminEvent(
  event: BitableRecordChangeEvent,
  adminIds: ReadonlySet<string>,
): boolean {
  return operatorIds(event).some((id) => adminIds.has(id));
}

export class OnlineLaunchDateGuardService {
  private tableId = "";
  private fieldId = "";
  private readonly trustedDates = new Map<string, number | null>();
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;

  public constructor(
    private readonly env: AppEnv,
    private readonly client: Client,
    private readonly adminIds: ReadonlySet<string>,
    private readonly statePath = resolve(".runtime", "online-date-guard-state.json"),
    private readonly profile: BusinessProfile = loadBusinessProfile(),
    private readonly trustedImportPath?: string,
  ) {}

  public async start(): Promise<OnlineDateGuardStartResult> {
    const target = await this.discoverTarget();
    this.tableId = target.tableId;
    this.fieldId = target.fieldId;

    const current = await this.listCurrentRecords();
    const currentById = new Map(current.map((item) => [item.recordId, item.date]));
    const importedDates = await trustedOnlineImportDates(current.map((item) => item.recordId), { path: this.trustedImportPath });
    const stored = await this.loadState();
    let retainedBaselines = 0;
    let seededBaselines = 0;

    this.trustedDates.clear();
    if (stored?.tableId === this.tableId && stored.fieldId === this.fieldId) {
      for (const [recordId, date] of Object.entries(stored.records)) {
        if (!currentById.has(recordId)) continue;
        const storedDate = normalizeDate(date);
        const currentDate = currentById.get(recordId) ?? null;
        // An empty placeholder has no protected business date. Do not keep an
        // obsolete non-empty baseline for it, and accept a first fill that
        // happened while the guard was offline when the prior baseline was empty.
        this.trustedDates.set(
          recordId,
          storedDate === null || currentDate === null
            || (importedDates.has(recordId) && sameDate(currentDate, importedDates.get(recordId)!))
            ? currentDate : storedDate,
        );
        retainedBaselines += 1;
      }
    }
    for (const item of current) {
      if (this.trustedDates.has(item.recordId)) continue;
      this.trustedDates.set(item.recordId, item.date);
      seededBaselines += 1;
    }

    let driftedRecords = 0;
    for (const item of current) {
      if (!sameDate(this.trustedDates.get(item.recordId) ?? null, item.date)) {
        driftedRecords += 1;
      }
    }
    await this.persistState();
    return {
      table: this.profile.tables.online,
      field: FIELD_NAME,
      records: current.length,
      retainedBaselines,
      seededBaselines,
      driftedRecords,
      admins: this.adminIds.size,
    };
  }

  public handleRecordChanged(event: BitableRecordChangeEvent): void {
    if (event.file_token && event.file_token !== this.env.FEISHU_BITABLE_APP_TOKEN) return;
    if (!this.tableId || String(event.table_id ?? "") !== this.tableId) return;
    const relevant = (event.action_list ?? []).some((action) => {
      const name = String(action.action ?? "").toLocaleLowerCase("en-US");
      if (name.includes("add") || name.includes("delete")) return true;
      return [...(action.before_value ?? []), ...(action.after_value ?? [])]
        .some((field) => field.field_id === this.fieldId);
    });
    if (!relevant) return;

    this.pending += 1;
    this.queue = this.queue
      .then(async () => {
        const result = await this.processEvent(event);
        console.log(`[online-date-guard] ${JSON.stringify(result)}`);
      })
      .catch((error) => {
        console.error(
          `[online-date-guard] 处理失败：${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.pending = Math.max(0, this.pending - 1);
      });
  }

  public async waitForIdle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending > 0) {
      if (Date.now() >= deadline) throw new Error("等待上线日期保护队列超时");
      await sleep(20);
    }
    await this.queue;
  }

  private async processEvent(event: BitableRecordChangeEvent): Promise<OnlineDateGuardEventResult> {
    const admin = isAdminEvent(event, this.adminIds);
    const operator = operatorIds(event)[0] ?? "unknown";
    let corrected = 0;
    let accepted = 0;
    let removed = 0;
    let actions = 0;
    let stateChanged = false;

    for (const action of event.action_list ?? []) {
      const recordId = String(action.record_id ?? "").trim();
      if (!recordId) continue;
      const actionName = String(action.action ?? "").toLocaleLowerCase("en-US");
      const fields = [...(action.before_value ?? []), ...(action.after_value ?? [])];
      const touchesDate = fields.some((field) => field.field_id === this.fieldId);
      const isAdded = actionName.includes("add");
      const isDeleted = actionName.includes("delete");
      if (!touchesDate && !isAdded && !isDeleted) continue;
      actions += 1;

      if (isDeleted) {
        if (this.trustedDates.delete(recordId)) stateChanged = true;
        removed += 1;
        continue;
      }

      const current = await this.getCurrentDate(recordId);
      if (admin) {
        this.trustedDates.set(recordId, current);
        stateChanged = true;
        accepted += 1;
        continue;
      }

      const trustedImport = await trustedOnlineImportDate(recordId, { path: this.trustedImportPath });
      if (trustedImport !== null && sameDate(current, trustedImport)) {
        this.trustedDates.set(recordId, trustedImport);
        stateChanged = true;
        accepted += 1;
        continue;
      }

      // Existing blank placeholder: the first non-empty value establishes the
      // protected date. Later ordinary-user edits still revert to this date.
      if (this.trustedDates.has(recordId)
        && (this.trustedDates.get(recordId) ?? null) === null
        && current !== null) {
        this.trustedDates.set(recordId, current);
        stateChanged = true;
        accepted += 1;
        continue;
      }

      let trusted: number | null;
      if (this.trustedDates.has(recordId)) {
        trusted = this.trustedDates.get(recordId) ?? null;
      } else {
        trusted = shanghaiDayStartMs(eventTimestampMs(event));
        this.trustedDates.set(recordId, trusted);
        stateChanged = true;
      }

      if (sameDate(current, trusted)) {
        accepted += 1;
        continue;
      }
      await this.writeAndVerify(recordId, trusted);
      corrected += 1;
    }

    if (stateChanged || corrected > 0) await this.persistState();
    return {
      eventId: String(event.event_id ?? ""),
      operator,
      admin,
      actions,
      corrected,
      accepted,
      removed,
    };
  }

  private async discoverTarget(): Promise<{ tableId: string; fieldId: string }> {
    const tables = await this.withRetry("读取数据表", () => this.client.bitable.appTable.list({
      path: { app_token: this.env.FEISHU_BITABLE_APP_TOKEN },
      params: { page_size: 100 },
    }));
    assertFeishuResponse(tables, "读取数据表");
    const items = tables.data?.items ?? [];
    const exact = items.filter((item) => item.name === this.profile.tables.online && item.table_id);
    const matches = exact.length > 0
      ? exact
      : items.filter((item) => ["Tech-wave红人上线表", "红人上线表"].includes(String(item.name ?? "")) && item.table_id);
    if (matches.length !== 1) throw new Error(`应找到一张“${this.profile.tables.online}”，实际 ${matches.length} 张`);
    const tableId = String(matches[0].table_id);

    const fields = await this.withRetry("读取上线表字段", () => this.client.bitable.appTableField.list({
      path: { app_token: this.env.FEISHU_BITABLE_APP_TOKEN, table_id: tableId },
      params: { page_size: 100 },
    }));
    assertFeishuResponse(fields, "读取上线表字段");
    const fieldMatches = (fields.data?.items ?? []).filter(
      (item) => item.field_name === FIELD_NAME && item.field_id,
    );
    if (fieldMatches.length !== 1) throw new Error(`应找到一个“${FIELD_NAME}”字段，实际 ${fieldMatches.length} 个`);
    if (fieldMatches[0].type !== DATE_FIELD_TYPE) {
      throw new Error(`${this.profile.tables.online}.${FIELD_NAME} 不是日期字段，拒绝启动保护`);
    }
    return { tableId, fieldId: String(fieldMatches[0].field_id) };
  }

  private async listCurrentRecords(): Promise<CurrentRecord[]> {
    const records: CurrentRecord[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.withRetry("读取上线记录", () => this.client.bitable.appTableRecord.list({
        path: {
          app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
          table_id: this.tableId,
        },
        params: {
          page_size: PAGE_SIZE,
          automatic_fields: false,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }));
      assertFeishuResponse(response, "读取上线记录");
      for (const item of response.data?.items ?? []) {
        const recordId = String(item.record_id ?? "").trim();
        if (!recordId) continue;
        records.push({
          recordId,
          date: normalizeDate(item.fields?.[FIELD_NAME]),
        });
      }
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    return records;
  }

  private async getCurrentDate(recordId: string): Promise<number | null> {
    const response = await this.withRetry("读取上线日期", () => this.client.bitable.appTableRecord.get({
      path: {
        app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
        table_id: this.tableId,
        record_id: recordId,
      },
    }));
    assertFeishuResponse(response, "读取上线日期");
    const record = response.data?.record;
    if (!record) throw new Error(`上线记录不存在：${recordId}`);
    return normalizeDate(record.fields?.[FIELD_NAME]);
  }

  private async writeAndVerify(recordId: string, trusted: number | null): Promise<void> {
    const response = await this.withRetry("恢复实上线日期", () => (
      (this.client.bitable.appTableRecord as any).update({
        path: {
          app_token: this.env.FEISHU_BITABLE_APP_TOKEN,
          table_id: this.tableId,
          record_id: recordId,
        },
        data: { fields: { [FIELD_NAME]: trusted } },
      })
    ));
    assertFeishuResponse(response as { code?: number; msg?: string }, "恢复实上线日期");
    const verified = await this.getCurrentDate(recordId);
    if (!sameDate(verified, trusted)) {
      throw new Error(`写后验证失败：${recordId} 的 ${FIELD_NAME} 未恢复`);
    }
  }

  private async loadState(): Promise<GuardState | null> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as GuardState;
      if (parsed.version !== STATE_VERSION || !parsed.records) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async persistState(): Promise<void> {
    const state: GuardState = {
      version: STATE_VERSION,
      tableId: this.tableId,
      fieldId: this.fieldId,
      updatedAt: new Date().toISOString(),
      records: Object.fromEntries(this.trustedDates),
    };
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, this.statePath);
  }

  private async withRetry<T>(action: string, operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (const delay of RETRY_DELAYS_MS) {
      if (delay > 0) await sleep(delay);
      try {
        return await withFeishuBitableQuotaCircuit(this.env.FEISHU_APP_ID, operation);
      } catch (error) {
        lastError = error;
        if (!isRetryableFeishuError(error)) throw error;
      }
    }
    throw new Error(`${action}失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
}

function normalizeDate(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sameDate(left: number | null, right: number | null): boolean {
  return left === right;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
