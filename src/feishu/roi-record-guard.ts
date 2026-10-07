import type { Client } from "@larksuiteoapi/node-sdk";
import type { AppEnv } from "../config/env.js";
import { loadBusinessProfile, type BusinessProfile } from "../config/business-profile.js";
import type { BitableRecordChangeEvent } from "./contact-duplicate-index.js";
import {
  assertFeishuResponse,
  feishuRetryDelayMs,
  isRetryableFeishuError,
  withFeishuBitableQuotaCircuit,
} from "./client.js";

const PRODUCT_FIELD = "商品";
const DATE_FIELD = "日期";
const COOP_PRODUCT_FIELD = "寄样产品";
const COOP_DATE_FIELD = "合作时间";
const ONLINE_PRODUCT_FIELD = "挂车产品";
const ONLINE_DATE_FIELD = "实上线日期(Ct)";
const EVENT_DEBOUNCE_MS = 800;
const EXTERNAL_BUSY_RETRY_MS = 1_500;
// Record-change events normally trigger this guard within a second. Keep a
// slower polling fallback for Feishu's occasional missed events without
// continuously colliding with Base formula recalculation.
const PERIODIC_RECONCILIATION_MS = 5 * 60_000;
const PAGE_SIZE = 500;
const BATCH_CREATE_LIMIT = 500;
const TRANSIENT_READ_DELAYS_MS = [0, 500, 1_500] as const;

export interface RoiDailyKeyRecord {
  product: string;
  date: number | null;
}

export interface RoiSourceRecord {
  products: string[];
  date: number | null;
}

export interface RoiRecordGuardPlan {
  missingProductDates: Array<{ product: string; dateKey: string; timestamp: number }>;
  missingStoreDates: Array<{ dateKey: string; timestamp: number }>;
  duplicateKeys: string[];
}

export interface RoiRecordGuardResult extends RoiRecordGuardPlan {
  reason: string;
  created: number;
  createdProductRows: number;
  createdStoreRows: number;
  records: number;
}

export interface RoiRecordGuardPlanOptions {
  sourceRecords?: readonly RoiSourceRecord[];
  allowedProducts?: readonly string[];
  storeName?: string;
}

/**
 * Plans only missing anchor rows. It never plans an update or deletion, so existing
 * API/manual values in ROI records remain untouched.
 */
export function buildRoiRecordGuardPlan(
  records: readonly RoiDailyKeyRecord[],
  options: RoiRecordGuardPlanOptions = {},
): RoiRecordGuardPlan {
  const storeName = options.storeName ?? loadBusinessProfile().storeAggregateLabel;
  const allowed = new Set((options.allowedProducts ?? []).map((item) => item.trim()).filter(Boolean));
  const restrictProducts = allowed.size > 0;
  const existingKeys = new Map<string, number>();
  const storeDateCounts = new Map<string, number>();
  const requiredProductDates = new Map<string, { product: string; dateKey: string; timestamp: number }>();
  const requiredStoreDates = new Map<string, number>();

  for (const record of records) {
    const product = record.product.trim();
    const timestamp = record.date;
    if (!product || typeof timestamp !== "number") continue;
    const dateKey = shanghaiDateKey(timestamp);
    if (!dateKey) continue;
    const uniqueKey = roiKey(product, dateKey);
    existingKeys.set(uniqueKey, (existingKeys.get(uniqueKey) ?? 0) + 1);
    if (product === storeName) {
      storeDateCounts.set(dateKey, (storeDateCounts.get(dateKey) ?? 0) + 1);
    } else if (!requiredStoreDates.has(dateKey)) {
      requiredStoreDates.set(dateKey, timestamp);
    }
  }

  for (const source of options.sourceRecords ?? []) {
    if (typeof source.date !== "number") continue;
    const dateKey = shanghaiDateKey(source.date);
    if (!dateKey) continue;
    for (const rawProduct of source.products) {
      const product = rawProduct.trim();
      if (!product || product === storeName || (restrictProducts && !allowed.has(product))) continue;
      const key = roiKey(product, dateKey);
      if (!requiredProductDates.has(key)) {
        requiredProductDates.set(key, { product, dateKey, timestamp: source.date });
      }
      if (!requiredStoreDates.has(dateKey)) requiredStoreDates.set(dateKey, source.date);
    }
  }

  const missingProductDates = [...requiredProductDates]
    .filter(([key]) => !existingKeys.has(key))
    .map(([, item]) => item)
    .sort((left, right) => left.dateKey.localeCompare(right.dateKey)
      || left.product.localeCompare(right.product, "zh-CN"));
  const missingStoreDates = [...requiredStoreDates]
    .filter(([dateKey]) => !storeDateCounts.has(dateKey))
    .map(([dateKey, timestamp]) => ({ dateKey, timestamp }))
    .sort((left, right) => left.dateKey.localeCompare(right.dateKey));
  const duplicateKeys = [...existingKeys]
    .filter(([, count]) => count > 1)
    .map(([key]) => key.replace("\u0000", " + "))
    .sort();
  return { missingProductDates, missingStoreDates, duplicateKeys };
}

interface TableIds {
  roi: string;
  cooperation: string;
  online: string;
}

export class RoiRecordGuardService {
  private tableIds: TableIds | null = null;
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

  public async start(): Promise<RoiRecordGuardResult> {
    if (!this.periodicTimer) {
      this.periodicTimer = setInterval(() => {
        this.rerunRequested = true;
        this.schedule(0);
      }, PERIODIC_RECONCILIATION_MS);
      this.periodicTimer.unref();
    }
    try {
      this.tableIds = await this.discoverTableIds();
      return await this.reconcile("startup");
    } catch (error) {
      // Feishu can briefly return "Data not ready" while a Base is loading.
      // Startup reconciliation is useful, but it must never take the bot down.
      // Keep the deterministic guard queued and retry after the WebSocket is up.
      this.rerunRequested = true;
      const retryDelay = feishuRetryDelayMs(error, PERIODIC_RECONCILIATION_MS);
      this.retryNotBefore = Date.now() + retryDelay;
      this.schedule(retryDelay);
      throw error;
    }
  }

  public handleRecordChanged(event: BitableRecordChangeEvent): void {
    if (event.file_token && event.file_token !== this.env.FEISHU_BITABLE_APP_TOKEN) return;
    if (!this.tableIds) return;
    const changedTableId = String(event.table_id ?? "");
    if (![this.tableIds.roi, this.tableIds.cooperation, this.tableIds.online].includes(changedTableId)) return;
    this.rerunRequested = true;
    this.schedule();
  }

  public async preview(): Promise<RoiRecordGuardResult> {
    this.tableIds = await this.discoverTableIds();
    return this.reconcile("readonly_preview", false);
  }

  public async waitForIdle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.running || this.timer || this.rerunRequested) {
      if (Date.now() >= deadline) throw new Error("等待投产比记录保护队列空闲超时");
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
        if (!this.tableIds) this.tableIds = await this.discoverTableIds();
        const result = await this.reconcile("record_changed_event");
        console.log(`[roi-record-guard] ${JSON.stringify(result)}`);
      } while (this.rerunRequested && !this.externalBusy());
    } catch (error) {
      console.error(`[roi-record-guard:${this.profile.businessDisplayName}] 同步失败：${error instanceof Error ? error.message : String(error)}`);
      this.rerunRequested = true;
      retryDelayMs = feishuRetryDelayMs(error, PERIODIC_RECONCILIATION_MS);
      this.retryNotBefore = Date.now() + retryDelayMs;
    } finally {
      this.running = false;
      if (this.rerunRequested && !this.timer) {
        this.schedule(this.externalBusy() ? EXTERNAL_BUSY_RETRY_MS : retryDelayMs);
      }
    }
  }

  private async reconcile(reason: string, apply = true): Promise<RoiRecordGuardResult> {
    if (!this.tableIds) throw new Error("投产比记录保护器尚未完成表发现");
    const [before, cooperation, online] = await Promise.all([
      this.readRoiRecords(this.tableIds.roi),
      this.readSourceRecords(this.tableIds.cooperation, COOP_PRODUCT_FIELD, this.profile.cooperationDateField ?? COOP_DATE_FIELD),
      this.readSourceRecords(this.tableIds.online, ONLINE_PRODUCT_FIELD, ONLINE_DATE_FIELD),
    ]);
    const plan = buildRoiRecordGuardPlan(before, {
      sourceRecords: [...cooperation, ...online],
      allowedProducts: this.profile.tiktok.autoEnrollNewProducts
        ? undefined
        : this.profile.tiktok.includedCanonicalProducts,
      storeName: this.profile.storeAggregateLabel,
    });
    const creates = [
      ...plan.missingProductDates.map((item) => ({
        fields: { [PRODUCT_FIELD]: item.product, [DATE_FIELD]: item.timestamp },
      })),
      ...plan.missingStoreDates.map((item) => ({
        fields: { [PRODUCT_FIELD]: this.profile.storeAggregateLabel, [DATE_FIELD]: item.timestamp },
      })),
    ];
    const roiTableId = this.tableIds.roi;
    for (let offset = 0; apply && offset < creates.length; offset += BATCH_CREATE_LIMIT) {
      const response = await this.bitableRequest(() => this.client.bitable.appTableRecord.batchCreate({
        path: { app_token: this.env.FEISHU_BITABLE_APP_TOKEN, table_id: roiTableId },
        data: { records: creates.slice(offset, offset + BATCH_CREATE_LIMIT) },
      }));
      assertFeishuResponse(response, "按合作/上线源表补齐投产比日期骨架");
    }

    if (apply && creates.length > 0) {
      const after = await this.readRoiRecords(this.tableIds.roi);
      const afterPlan = buildRoiRecordGuardPlan(after, {
        sourceRecords: [...cooperation, ...online],
        allowedProducts: this.profile.tiktok.autoEnrollNewProducts
          ? undefined
          : this.profile.tiktok.includedCanonicalProducts,
        storeName: this.profile.storeAggregateLabel,
      });
      if (afterPlan.missingProductDates.length || afterPlan.missingStoreDates.length) {
        throw new Error(`写后验证失败：仍缺商品日行 ${afterPlan.missingProductDates.length}、店铺日行 ${afterPlan.missingStoreDates.length}`);
      }
    }
    return {
      reason,
      created: apply ? creates.length : 0,
      createdProductRows: apply ? plan.missingProductDates.length : 0,
      createdStoreRows: apply ? plan.missingStoreDates.length : 0,
      records: before.length + (apply ? creates.length : 0),
      ...plan,
    };
  }

  private async discoverTableIds(): Promise<TableIds> {
    const tables: Array<{ table_id?: string; name?: string }> = [];
    let pageToken: string | undefined;
    do {
      const response = await this.bitableRequest(() => this.client.bitable.appTable.list({
        path: { app_token: this.env.FEISHU_BITABLE_APP_TOKEN },
        params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
      }));
      assertFeishuResponse(response, "发现投产比与红人源表");
      tables.push(...(response.data?.items ?? []));
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    const one = (name: string): string => {
      const matches = tables.filter((item) => item.name === name && item.table_id);
      if (matches.length !== 1) throw new Error(`应恰好发现一张“${name}”，实际 ${matches.length} 张`);
      return String(matches[0].table_id);
    };
    return {
      roi: one(this.profile.tables.roi),
      cooperation: one(this.profile.tables.cooperation),
      online: one(this.profile.tables.online),
    };
  }

  private async readRoiRecords(tableId: string): Promise<RoiDailyKeyRecord[]> {
    const records: RoiDailyKeyRecord[] = [];
    for (const item of await this.readAllRecords(tableId, [PRODUCT_FIELD, DATE_FIELD])) {
      records.push({
        product: String(item.fields?.[PRODUCT_FIELD] ?? "").trim(),
        date: timestampValue(item.fields?.[DATE_FIELD]),
      });
    }
    return records;
  }

  private async readSourceRecords(
    tableId: string,
    productField: string,
    dateField: string,
  ): Promise<RoiSourceRecord[]> {
    return (await this.readAllRecords(tableId, [productField, dateField])).map((item) => ({
      products: cellStrings(item.fields?.[productField]),
      date: timestampValue(item.fields?.[dateField]),
    }));
  }

  private async readAllRecords(
    tableId: string,
    fieldNames: string[],
  ): Promise<Array<{ fields?: Record<string, unknown> }>> {
    const records: Array<{ fields?: Record<string, unknown> }> = [];
    let pageToken: string | undefined;
    do {
      const response = await this.readPageWithRetry(tableId, fieldNames, pageToken);
      assertFeishuResponse(response, "读取投产比即时联动数据");
      records.push(...(response.data?.items ?? []));
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    return records;
  }

  private async readPageWithRetry(
    tableId: string,
    fieldNames: string[],
    pageToken?: string,
  ): Promise<any> {
    let lastError: unknown;
    for (const delayMs of TRANSIENT_READ_DELAYS_MS) {
      if (delayMs) await sleep(delayMs);
      try {
        return await this.bitableRequest(() => this.client.bitable.appTableRecord.list({
          path: { app_token: this.env.FEISHU_BITABLE_APP_TOKEN, table_id: tableId },
          params: {
            page_size: PAGE_SIZE,
            automatic_fields: false,
            field_names: JSON.stringify(fieldNames),
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        }));
      } catch (error) {
        lastError = error;
        if (!isRetryableFeishuError(error)) throw error;
      }
    }
    throw lastError;
  }

  private bitableRequest<T>(operation: () => Promise<T>): Promise<T> {
    return withFeishuBitableQuotaCircuit(this.env.FEISHU_APP_ID, operation);
  }
}

function roiKey(product: string, dateKey: string): string {
  return `${product}\u0000${dateKey}`;
}

function cellStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values.map((item) => {
    if (typeof item === "string") return item.trim();
    if (item && typeof item === "object") {
      const candidate = item as { name?: unknown; text?: unknown; value?: unknown };
      return String(candidate.name ?? candidate.text ?? candidate.value ?? "").trim();
    }
    return String(item).trim();
  }).filter(Boolean))];
}

function timestampValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function shanghaiDateKey(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year && values.month && values.day ? `${values.year}-${values.month}-${values.day}` : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
