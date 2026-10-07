import { createHash, randomUUID } from "node:crypto";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { AppEnv } from "../config/env.js";
import { loadBusinessProfile, type BusinessProfile } from "../config/business-profile.js";
import { requireCanonicalProductName } from "../business/product-naming.js";
import { normalizeTikTokHandle } from "../realtime/tiktok-identity.js";
import { assertFeishuResponse, feishuErrorDetails, isRetryableFeishuError, withFeishuBitableQuotaCircuit, withFeishuRetry } from "./client.js";
import { dateValueForField, linkValueForField, numberValueForField } from "./field-values.js";
import { registerTrustedOnlineImport, registerTrustedOnlineImports } from "./online-date-trusted-imports.js";

const FORMULA_TYPES = new Set([20, 1001]);
type NumericVerification = [
  label: string,
  actual: unknown,
  expected: number,
  mode?: "exact" | "at_least",
];

export type FeishuRecord = {
  record_id?: string;
  fields?: Record<string, unknown>;
  last_modified_time?: number;
  created_time?: number;
};

export interface CooperationSeed {
  recordId: string;
  creatorHandle: string;
  cooperationDate: string;
  products: string[];
  lastModifiedTime: number;
  createdTime: number;
  missingItems: string[];
}

export interface DailySource {
  date: string;
  orders: number;
  items: number;
  gmv: number;
  cardOrders: number;
  cardItems: number;
  visitors: number;
  orderingVideos: number;
  storeOrderingVideos: number;
  allianceVideoOrders?: number;
  allianceVideoItems?: number;
  allianceLiveOrders?: number;
  allianceLiveItems?: number;
  selfOperatedVideoOrders?: number;
  selfOperatedVideoItems?: number;
  selfOperatedLiveOrders?: number;
  selfOperatedLiveItems?: number;
  storeAllianceVideoOrders?: number;
  storeAllianceVideoItems?: number;
  storeAllianceLiveOrders?: number;
  storeAllianceLiveItems?: number;
  storeSelfOperatedVideoOrders?: number;
  storeSelfOperatedVideoItems?: number;
  storeSelfOperatedLiveOrders?: number;
  storeSelfOperatedLiveItems?: number;
  storeCardOrders?: number;
  storeCardItems?: number;
  sourceFiles: string[];
  requestIds: string[];
}

export type DailyOrderAttributionSource = Pick<DailySource,
  | "date" | "orders" | "items" | "cardOrders" | "cardItems"
  | "allianceVideoOrders" | "allianceVideoItems"
  | "allianceLiveOrders" | "allianceLiveItems"
  | "selfOperatedVideoOrders" | "selfOperatedVideoItems"
  | "selfOperatedLiveOrders" | "selfOperatedLiveItems"
  | "storeAllianceVideoOrders" | "storeAllianceVideoItems"
  | "storeAllianceLiveOrders" | "storeAllianceLiveItems"
  | "storeSelfOperatedVideoOrders" | "storeSelfOperatedVideoItems"
  | "storeSelfOperatedLiveOrders" | "storeSelfOperatedLiveItems"
  | "storeCardOrders" | "storeCardItems"
  | "sourceFiles" | "requestIds"
>;

export interface DailyPaidOrderSnapshotSource {
  date: string;
  orders: number;
  items: number;
  sales?: number;
  salesCurrency?: string;
  sourceFiles: string[];
  requestIds: string[];
}

/** Paid-order totals are historical observations: later sources may add, never subtract. */
export function mergeMonotonicNumberFields(
  current: Record<string, unknown> | undefined,
  desired: Record<string, unknown>,
  fieldNames: readonly string[],
): Record<string, unknown> {
  const merged = { ...desired };
  for (const fieldName of fieldNames) {
    const before = Number(current?.[fieldName]);
    const after = Number(desired[fieldName]);
    if (Number.isFinite(before) && Number.isFinite(after) && before > after) {
      merged[fieldName] = before;
    }
  }
  return merged;
}

/**
 * Only the deterministic order-attribution metrics belong in this payload.
 * Keeping the mapping isolated prevents a backfill from touching sales,
 * advertising, returns, or other manually maintained fields.
 */
export function productOrderAttributionValues(
  source: DailyOrderAttributionSource,
): Record<string, number> {
  return {
    单量: source.orders,
    数量: source.items,
    联盟达人视频出单量: source.allianceVideoOrders ?? 0,
    联盟达人视频出单数量: source.allianceVideoItems ?? 0,
    联盟达人直播出单量: source.allianceLiveOrders ?? 0,
    联盟达人直播出单数量: source.allianceLiveItems ?? 0,
    自营达人视频出单量: source.selfOperatedVideoOrders ?? 0,
    自营达人视频出单数量: source.selfOperatedVideoItems ?? 0,
    自营达人直播出单量: source.selfOperatedLiveOrders ?? 0,
    自营达人直播出单数量: source.selfOperatedLiveItems ?? 0,
    商品卡出单量: source.cardOrders,
    商品卡出单数量: source.cardItems,
  };
}

export interface VideoSource {
  id: string;
  date: string;
  creator: string;
  products: string[];
  url: string;
  viewsK: number;
  itemsSold: number;
  gmv: number;
  gmvCurrency: "USD";
  metricWindowStart: string;
  metricWindowEndExclusive: string;
}

export interface OnlineRecordSnapshot {
  tableId: string;
  tableName: string;
  recordId: string;
  fields: Record<string, unknown>;
  lastModifiedTime: number;
}

export interface RoiProductRecordSnapshot {
  recordId: string;
  productName: string;
  dateKey: string;
  fields: Record<string, unknown>;
  lastModifiedTime: number;
}

export interface BusinessProductOptionResult {
  cooperationOptionsAdded: number;
  onlineOptionsAdded: number;
}

interface ChangeCounts {
  created: number;
  updated: number;
  unchanged: number;
}

export class StorefourDemoGateway {
  private readonly client: any;
  private readonly appToken: string;
  private readonly appId: string;
  private roiTableId = "";
  private onlineTableId = "";
  private cooperationTableId = "";
  private onlineVideoLinkFieldType: number | null = null;
  private onlineRegistrationDateFieldType: number | null = null;
  private onlineViewsFieldType: number | null = null;

  public constructor(
    env: AppEnv,
    client: Client,
    private readonly profile: BusinessProfile = loadBusinessProfile(),
    private readonly options: { trustedImportPath?: string } = {},
  ) {
    this.client = client;
    this.appToken = env.FEISHU_BITABLE_APP_TOKEN;
    this.appId = env.FEISHU_APP_ID;
  }

  public async initialize(
    productName: string,
    scope: "roi" | "all" = "all",
  ): Promise<void> {
    const tables = await this.listAll((pageToken) => this.client.bitable.appTable.list({
      path: { app_token: this.appToken },
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    }));
    this.roiTableId = requireUniqueTable(tables, this.profile.tables.roi);
    const roiFields = await this.listFields(this.roiTableId);
    assertWritableFields(roiFields, [
      "商品", "日期", "单量", "数量", "商品卡出单量", "商品卡出单数量",
      "销售额", "店铺浏览量", "出单视频",
    ]);
    if (this.profile.tiktok.orderAttribution?.enabled) {
      assertWritableFields(roiFields, [
        "联盟达人视频出单量", "联盟达人视频出单数量",
        "联盟达人直播出单量", "联盟达人直播出单数量",
        "自营达人视频出单量", "自营达人视频出单数量",
        "自营达人直播出单量", "自营达人直播出单数量",
        "店铺联盟达人视频出单量", "店铺联盟达人视频出单数量",
        "店铺联盟达人直播出单量", "店铺联盟达人直播出单数量",
        "店铺自营达人视频出单量", "店铺自营达人视频出单数量",
        "店铺自营达人直播出单量", "店铺自营达人直播出单数量",
        "店铺商品卡出单量(API)", "店铺商品卡出单数量",
      ]);
    }
    assertFormulaFields(roiFields, [
      "合作量", "上线量", "达人出单量", "达人出单数量", "总单量", "总数量",
      "店铺商品卡出单量", "店铺销售额", "转化率",
    ]);
    if (scope === "roi") return;
    this.onlineTableId = requireUniqueTable(tables, this.profile.tables.online);
    const onlineFields = await this.listFields(this.onlineTableId);
    this.onlineVideoLinkFieldType = fieldType(onlineFields, "视频上线地址");
    this.onlineRegistrationDateFieldType = fieldType(onlineFields, "登记日期");
    this.onlineViewsFieldType = fieldType(onlineFields, "视频曝光K");
    assertWritableFields(onlineFields, [
      "登记日期", "实上线日期(Ct)", "达人姓名", "挂车产品",
      "视频上线地址", "视频曝光K", "售出数量", "销售额",
    ]);
    await this.ensureMultiSelectOption(this.onlineTableId, onlineFields, "挂车产品", productName);
  }

  public async initializeOnlineProducts(productNames: readonly string[]): Promise<void> {
    const unique = [...new Set(productNames.map((name) => name.trim()).filter(Boolean))];
    if (unique.length === 0) throw new Error("上线视频缺少已映射商品");
    await this.initializeOnlineReadOnly();
    let fields = await this.listFields(this.onlineTableId);
    for (const productName of unique) {
      await this.ensureMultiSelectOption(this.onlineTableId, fields, "挂车产品", productName);
      fields = await this.listFields(this.onlineTableId);
    }
  }

  public async ensureBusinessProductOptions(
    productNames: readonly string[],
  ): Promise<BusinessProductOptionResult> {
    const unique = [...new Set(productNames.map(requireCanonicalProductName))];
    if (unique.length === 0) {
      return { cooperationOptionsAdded: 0, onlineOptionsAdded: 0 };
    }
    const tables = await this.listAll((pageToken) => this.client.bitable.appTable.list({
      path: { app_token: this.appToken },
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    }));
    this.cooperationTableId = requireUniqueTable(tables, this.profile.tables.cooperation);
    this.onlineTableId = requireUniqueTable(tables, this.profile.tables.online);

    let cooperationFields = await this.listFields(this.cooperationTableId);
    let onlineFields = await this.listFields(this.onlineTableId);
    let cooperationOptionsAdded = 0;
    let onlineOptionsAdded = 0;
    for (const productName of unique) {
      if (await this.ensureMultiSelectOption(
        this.cooperationTableId,
        cooperationFields,
        "寄样产品",
        productName,
      )) cooperationOptionsAdded += 1;
      cooperationFields = await this.listFields(this.cooperationTableId);
      if (await this.ensureMultiSelectOption(
        this.onlineTableId,
        onlineFields,
        "挂车产品",
        productName,
      )) onlineOptionsAdded += 1;
      onlineFields = await this.listFields(this.onlineTableId);
    }
    return { cooperationOptionsAdded, onlineOptionsAdded };
  }

  public async initializeOnlineReadOnly(): Promise<void> {
    const tables = await this.listAll((pageToken) => this.client.bitable.appTable.list({
      path: { app_token: this.appToken },
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    }));
    this.onlineTableId = requireUniqueTable(tables, this.profile.tables.online);
    const onlineFields = await this.listFields(this.onlineTableId);
    this.onlineVideoLinkFieldType = fieldType(onlineFields, "视频上线地址");
    this.onlineRegistrationDateFieldType = fieldType(onlineFields, "登记日期");
    this.onlineViewsFieldType = fieldType(onlineFields, "视频曝光K");
    assertWritableFields(onlineFields, [
      "登记日期", "实上线日期(Ct)", "达人姓名", "挂车产品",
      "视频上线地址", "视频曝光K", "售出数量", "销售额",
    ]);
  }

  public async listCooperationSeeds(): Promise<CooperationSeed[]> {
    const tables = await this.listAll((pageToken) => this.client.bitable.appTable.list({
      path: { app_token: this.appToken },
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    }));
    this.cooperationTableId = requireUniqueTable(tables, this.profile.tables.cooperation);
    const fields = await this.listFields(this.cooperationTableId);
    for (const name of ["红人姓名", this.profile.cooperationDateField ?? "合作时间", "寄样产品"]) {
      if (!fields.some((field) => field.field_name === name)) {
        throw new Error(`合作表缺少字段“${name}”`);
      }
    }
    const records = await this.listRecords(this.cooperationTableId, true);
    return records.map((record) => {
      const recordId = String(record.record_id ?? "");
      const creatorHandle = normalizeTikTokHandle(textValue(record.fields?.红人姓名));
      const cooperationDate = dateKey(record.fields?.[this.profile.cooperationDateField ?? "合作时间"]);
      const products = selectValues(record.fields?.寄样产品).map(requireCanonicalProductName);
      const missingItems = [
        ...(!creatorHandle ? ["红人姓名（TK号）"] : []),
        ...(!cooperationDate ? ["合作时间"] : []),
        ...(products.length === 0 ? ["寄样产品"] : []),
      ];
      return {
        recordId,
        creatorHandle,
        cooperationDate,
        products,
        lastModifiedTime: Number(record.last_modified_time ?? 0),
        createdTime: Number(record.created_time ?? 0),
        missingItems,
      };
    }).sort((left, right) => (
      right.lastModifiedTime - left.lastModifiedTime
      || right.createdTime - left.createdTime
      || right.recordId.localeCompare(left.recordId)
    ));
  }

  public async snapshotOnlineByVideoId(videoId: string): Promise<OnlineRecordSnapshot | null> {
    return (await this.snapshotOnlineByVideoIds([videoId])).get(videoId) ?? null;
  }

  /** One paginated table read per plan, not per video. Never cache across jobs. */
  public async snapshotOnlineByVideoIds(videoIds: readonly string[]): Promise<Map<string, OnlineRecordSnapshot | null>> {
    const result = new Map<string, OnlineRecordSnapshot | null>(videoIds.map((id) => [id, null]));
    if (result.size === 0) return result;
    const records = await this.listRecords(this.onlineTableId);
    for (const record of records) {
      const videoId = urlValue(record.fields?.视频上线地址).match(/\/video\/(\d+)(?:[/?#]|$)/)?.[1];
      if (!videoId || !result.has(videoId) || !record.record_id) continue;
      if (result.get(videoId)) throw new Error(`视频 ${videoId} 在上线表出现多次`);
      result.set(videoId, {
        tableId: this.onlineTableId,
        tableName: this.profile.tables.online,
        recordId: record.record_id,
        fields: record.fields ?? {},
        lastModifiedTime: Number(record.last_modified_time ?? 0),
      });
    }
    return result;
  }

  public async getOnlineRecordSnapshot(recordId: string): Promise<OnlineRecordSnapshot> {
    const record = await this.getRecord(this.onlineTableId, recordId, true);
    return {
      tableId: this.onlineTableId,
      tableName: this.profile.tables.online,
      recordId,
      fields: record.fields ?? {},
      lastModifiedTime: Number(record.last_modified_time ?? 0),
    };
  }

  public async verifyRoi(
    sources: readonly DailySource[],
    productName: string,
  ): Promise<{ ok: boolean; errors: string[]; rows: unknown[] }> {
    await sleep(3_000);
    const roiRecords = await this.listRecords(this.roiTableId, true);
    const errors: string[] = [];
    const rows = sources.map((source) => {
      const productRows = roiRecords.filter((record) => (
        textValue(record.fields?.商品) === productName
        && dateKey(record.fields?.日期) === source.date
      ));
      const storeRows = roiRecords.filter((record) => (
        textValue(record.fields?.商品) === this.profile.storeAggregateLabel
        && dateKey(record.fields?.日期) === source.date
      ));
      if (productRows.length !== 1) {
        errors.push(`${productName} ${source.date} 记录数=${productRows.length}`);
      }
      if (storeRows.length !== 1) {
        errors.push(`${this.profile.storeAggregateLabel} ${source.date} 记录数=${storeRows.length}`);
      }
      const product = productRows[0]?.fields ?? {};
      const store = storeRows[0]?.fields ?? {};
      const checks: NumericVerification[] = [
        ["商品单量", product.单量, source.orders, "at_least"],
        ["商品数量", product.数量, source.items, "at_least"],
        ["商品卡出单量", product.商品卡出单量, source.cardOrders],
        ["商品卡出单数量", product.商品卡出单数量, source.cardItems],
        ["商品销售额", product.销售额, source.gmv],
        ["商品出单视频", product.出单视频, source.orderingVideos],
        ["商品达人出单量", product.达人出单量, source.orders - source.cardOrders, "at_least"],
        ["商品达人出单数量", product.达人出单数量, source.items - source.cardItems, "at_least"],
        ["店铺浏览量", store.店铺浏览量, source.visitors],
        ["店铺总单量", store.总单量, source.orders, "at_least"],
        ["店铺总数量", store.总数量, source.items, "at_least"],
        ["店铺商品卡出单量", store.店铺商品卡出单量, source.cardOrders],
        ["店铺销售额", store.店铺销售额, source.gmv],
        ["店铺出单视频", store.出单视频, source.storeOrderingVideos],
      ];
      if (source.allianceVideoOrders !== undefined) {
        checks.push(
          ["联盟达人视频出单量", product.联盟达人视频出单量, source.allianceVideoOrders],
          ["联盟达人视频出单数量", product.联盟达人视频出单数量, source.allianceVideoItems ?? 0],
          ["联盟达人直播出单量", product.联盟达人直播出单量, source.allianceLiveOrders ?? 0],
          ["联盟达人直播出单数量", product.联盟达人直播出单数量, source.allianceLiveItems ?? 0],
          ["自营达人视频出单量", product.自营达人视频出单量, source.selfOperatedVideoOrders ?? 0],
          ["自营达人视频出单数量", product.自营达人视频出单数量, source.selfOperatedVideoItems ?? 0],
          ["自营达人直播出单量", product.自营达人直播出单量, source.selfOperatedLiveOrders ?? 0],
          ["自营达人直播出单数量", product.自营达人直播出单数量, source.selfOperatedLiveItems ?? 0],
          ["店铺联盟达人视频出单量", store.店铺联盟达人视频出单量, source.storeAllianceVideoOrders ?? 0],
          ["店铺联盟达人视频出单数量", store.店铺联盟达人视频出单数量, source.storeAllianceVideoItems ?? 0],
          ["店铺联盟达人直播出单量", store.店铺联盟达人直播出单量, source.storeAllianceLiveOrders ?? 0],
          ["店铺联盟达人直播出单数量", store.店铺联盟达人直播出单数量, source.storeAllianceLiveItems ?? 0],
          ["店铺自营达人视频出单量", store.店铺自营达人视频出单量, source.storeSelfOperatedVideoOrders ?? 0],
          ["店铺自营达人视频出单数量", store.店铺自营达人视频出单数量, source.storeSelfOperatedVideoItems ?? 0],
          ["店铺自营达人直播出单量", store.店铺自营达人直播出单量, source.storeSelfOperatedLiveOrders ?? 0],
          ["店铺自营达人直播出单数量", store.店铺自营达人直播出单数量, source.storeSelfOperatedLiveItems ?? 0],
          ["店铺商品卡出单量", store["店铺商品卡出单量(API)"], source.storeCardOrders ?? 0],
          ["店铺商品卡出单数量", store.店铺商品卡出单数量, source.storeCardItems ?? 0],
        );
      }
      for (const [label, actual, expected, mode] of checks) {
        if (!managedNumberMatches(actual, expected, mode)) {
          errors.push(`${source.date}.${label}=${String(actual)}，应为 ${expected}`);
        }
      }
      return { date: source.date, product, store };
    });
    return { ok: errors.length === 0, errors, rows };
  }

  public async listRoiProductNames(): Promise<string[]> {
    if (!this.roiTableId) await this.initialize("管理员读取", "roi");
    const records = await this.listRecords(this.roiTableId, true);
    return [...new Set(records
      .map((record) => textValue(record.fields?.商品))
      .filter((name) => name && name !== this.profile.storeAggregateLabel))]
      .sort((left, right) => left.localeCompare(right, "zh-CN"));
  }

  public async snapshotRoiProductRecords(productName: string): Promise<RoiProductRecordSnapshot[]> {
    const exactName = requireCanonicalProductName(productName);
    if (exactName === this.profile.storeAggregateLabel) throw new Error("店铺汇总不能作为商品删除");
    if (!this.roiTableId) await this.initialize(exactName, "roi");
    const records = await this.listRecords(this.roiTableId, true);
    return records
      .filter((record) => textValue(record.fields?.商品) === exactName)
      .map((record) => ({
        recordId: String(record.record_id ?? ""),
        productName: exactName,
        dateKey: dateKey(record.fields?.日期),
        fields: structuredClone(record.fields ?? {}),
        lastModifiedTime: Number(record.last_modified_time ?? 0),
      }))
      .filter((record) => record.recordId)
      .sort((left, right) => left.dateKey.localeCompare(right.dateKey) || left.recordId.localeCompare(right.recordId));
  }

  public async deleteRoiProductRecords(input: {
    productName: string;
    expected: readonly Pick<RoiProductRecordSnapshot, "recordId" | "lastModifiedTime">[];
    operationId: string;
  }): Promise<number> {
    const exactName = requireCanonicalProductName(input.productName);
    if (exactName === this.profile.storeAggregateLabel) throw new Error("店铺汇总不能作为商品删除");
    const current = await this.snapshotRoiProductRecords(exactName);
    const expectedById = new Map(input.expected.map((record) => [record.recordId, record.lastModifiedTime]));
    const currentById = new Map(current.map((record) => [record.recordId, record.lastModifiedTime]));
    const sameSet = expectedById.size === currentById.size
      && [...expectedById].every(([recordId, modifiedAt]) => (
        currentById.has(recordId)
        && (!modifiedAt || !currentById.get(recordId) || currentById.get(recordId) === modifiedAt)
      ));
    if (!sameSet) {
      throw new Error("删除预览后该商品记录发生变化，已停止删除；请重新发送删除命令生成新预览");
    }
    const recordIds = [...expectedById.keys()];
    for (let offset = 0; offset < recordIds.length; offset += 500) {
      const batch = recordIds.slice(offset, offset + 500);
      const response = await this.client.bitable.appTableRecord.batchDelete({
        path: { app_token: this.appToken, table_id: this.roiTableId },
        params: { client_token: token(`${input.operationId}|${offset}`) },
        data: { records: batch },
      });
      assertFeishuResponse(response, `删除商品“${exactName}”投产比记录 ${offset + 1}-${offset + batch.length}`);
    }
    const remaining = await this.snapshotRoiProductRecords(exactName);
    if (remaining.length) throw new Error(`删除后复读仍有 ${remaining.length} 条完全同名记录`);
    return recordIds.length;
  }

  public async verifyRoiBulk(
    entries: ReadonlyArray<{
      product: { id: string; name: string };
      sources: readonly DailySource[];
    }>,
  ): Promise<{ ok: boolean; errors: string[]; rows: unknown[] }> {
    await sleep(3_000);
    const roiRecords = await this.listRecords(this.roiTableId, true);
    const errors: string[] = [];
    const rows: unknown[] = [];
    const expectedStore = new Map<string, {
      orders: number;
      items: number;
      cardOrders: number;
      cardItems: number;
      storeCardOrders: number;
      storeCardItems: number;
      gmv: number;
      visitors: number;
      storeOrderingVideos: number;
      allianceVideoOrders: number;
      allianceVideoItems: number;
      allianceLiveOrders: number;
      allianceLiveItems: number;
      selfOperatedVideoOrders: number;
      selfOperatedVideoItems: number;
      selfOperatedLiveOrders: number;
      selfOperatedLiveItems: number;
      hasOrderAttribution: boolean;
    }>();

    for (const entry of entries) {
      for (const source of entry.sources) {
        const productRows = roiRecords.filter((record) => (
          textValue(record.fields?.商品) === entry.product.name
          && dateKey(record.fields?.日期) === source.date
        ));
        if (productRows.length !== 1) {
          errors.push(`${entry.product.name} ${source.date} 记录数=${productRows.length}`);
        }
        const product = productRows[0]?.fields ?? {};
        const checks: NumericVerification[] = [
          ["单量", product.单量, source.orders, "at_least"],
          ["数量", product.数量, source.items, "at_least"],
          ["商品卡出单量", product.商品卡出单量, source.cardOrders],
          ["商品卡出单数量", product.商品卡出单数量, source.cardItems],
          ["销售额", product.销售额, source.gmv],
          ["出单视频", product.出单视频, source.orderingVideos],
          ["达人出单量", product.达人出单量, source.orders - source.cardOrders, "at_least"],
          ["达人出单数量", product.达人出单数量, source.items - source.cardItems, "at_least"],
        ];
        if (source.allianceVideoOrders !== undefined) {
          checks.push(
            ["联盟达人视频出单量", product.联盟达人视频出单量, source.allianceVideoOrders],
            ["联盟达人视频出单数量", product.联盟达人视频出单数量, source.allianceVideoItems ?? 0],
            ["联盟达人直播出单量", product.联盟达人直播出单量, source.allianceLiveOrders ?? 0],
            ["联盟达人直播出单数量", product.联盟达人直播出单数量, source.allianceLiveItems ?? 0],
            ["自营达人视频出单量", product.自营达人视频出单量, source.selfOperatedVideoOrders ?? 0],
            ["自营达人视频出单数量", product.自营达人视频出单数量, source.selfOperatedVideoItems ?? 0],
            ["自营达人直播出单量", product.自营达人直播出单量, source.selfOperatedLiveOrders ?? 0],
            ["自营达人直播出单数量", product.自营达人直播出单数量, source.selfOperatedLiveItems ?? 0],
          );
        }
        for (const [label, actual, expected, mode] of checks) {
          if (!managedNumberMatches(actual, expected, mode)) {
            errors.push(`${source.date}.${entry.product.name}.${label}=${String(actual)}，应为 ${expected}`);
          }
        }
        const store = expectedStore.get(source.date) ?? {
          orders: 0,
          items: 0,
          cardOrders: 0,
          cardItems: 0,
          storeCardOrders: source.storeCardOrders ?? 0,
          storeCardItems: source.storeCardItems ?? 0,
          gmv: 0,
          visitors: source.visitors,
          storeOrderingVideos: source.storeOrderingVideos,
          allianceVideoOrders: source.storeAllianceVideoOrders ?? 0,
          allianceVideoItems: source.storeAllianceVideoItems ?? 0,
          allianceLiveOrders: source.storeAllianceLiveOrders ?? 0,
          allianceLiveItems: source.storeAllianceLiveItems ?? 0,
          selfOperatedVideoOrders: source.storeSelfOperatedVideoOrders ?? 0,
          selfOperatedVideoItems: source.storeSelfOperatedVideoItems ?? 0,
          selfOperatedLiveOrders: source.storeSelfOperatedLiveOrders ?? 0,
          selfOperatedLiveItems: source.storeSelfOperatedLiveItems ?? 0,
          hasOrderAttribution: source.storeAllianceVideoOrders !== undefined,
        };
        if (Math.abs(store.visitors - source.visitors) > 0.000001) {
          errors.push(`${source.date} 店铺访客来源不一致`);
        }
        if (store.storeOrderingVideos !== source.storeOrderingVideos) {
          errors.push(`${source.date} 店铺出单视频来源不一致`);
        }
        store.orders += source.orders;
        store.items += source.items;
        store.cardOrders += source.cardOrders;
        store.cardItems += source.cardItems;
        store.gmv += source.gmv;
        if (source.storeAllianceVideoOrders !== undefined) {
          const expectedDirect = [
            store.allianceVideoOrders, store.allianceVideoItems,
            store.allianceLiveOrders, store.allianceLiveItems,
            store.selfOperatedVideoOrders, store.selfOperatedVideoItems,
            store.selfOperatedLiveOrders, store.selfOperatedLiveItems,
            store.storeCardOrders, store.storeCardItems,
          ];
          const sourceDirect = [
            source.storeAllianceVideoOrders ?? 0, source.storeAllianceVideoItems ?? 0,
            source.storeAllianceLiveOrders ?? 0, source.storeAllianceLiveItems ?? 0,
            source.storeSelfOperatedVideoOrders ?? 0, source.storeSelfOperatedVideoItems ?? 0,
            source.storeSelfOperatedLiveOrders ?? 0, source.storeSelfOperatedLiveItems ?? 0,
            source.storeCardOrders ?? 0, source.storeCardItems ?? 0,
          ];
          if (expectedDirect.some((value, index) => value !== sourceDirect[index])) {
            errors.push(`${source.date} 店铺订单归因来源不一致`);
          }
        }
        expectedStore.set(source.date, store);
        rows.push({ date: source.date, productName: entry.product.name, product });
      }
    }

    for (const [date, expected] of expectedStore) {
      const storeRows = roiRecords.filter((record) => (
        textValue(record.fields?.商品) === this.profile.storeAggregateLabel
        && dateKey(record.fields?.日期) === date
      ));
      if (storeRows.length !== 1) errors.push(`${this.profile.storeAggregateLabel} ${date} 记录数=${storeRows.length}`);
      const store = storeRows[0]?.fields ?? {};
      const checks: NumericVerification[] = [
        ["店铺浏览量", store.店铺浏览量, expected.visitors],
        ["总单量", store.总单量, expected.orders, "at_least"],
        ["总数量", store.总数量, expected.items, "at_least"],
        ["商品卡出单量", store.店铺商品卡出单量, expected.cardOrders],
        ["销售额", store.店铺销售额, expected.gmv],
        ["出单视频", store.出单视频, expected.storeOrderingVideos],
      ];
      if (expected.hasOrderAttribution) {
        checks.push(
          ["联盟达人视频出单量", store.店铺联盟达人视频出单量, expected.allianceVideoOrders],
          ["联盟达人视频出单数量", store.店铺联盟达人视频出单数量, expected.allianceVideoItems],
          ["联盟达人直播出单量", store.店铺联盟达人直播出单量, expected.allianceLiveOrders],
          ["联盟达人直播出单数量", store.店铺联盟达人直播出单数量, expected.allianceLiveItems],
          ["自营达人视频出单量", store.店铺自营达人视频出单量, expected.selfOperatedVideoOrders],
          ["自营达人视频出单数量", store.店铺自营达人视频出单数量, expected.selfOperatedVideoItems],
          ["自营达人直播出单量", store.店铺自营达人直播出单量, expected.selfOperatedLiveOrders],
          ["自营达人直播出单数量", store.店铺自营达人直播出单数量, expected.selfOperatedLiveItems],
          ["商品卡出单量", store["店铺商品卡出单量(API)"], expected.storeCardOrders],
          ["商品卡出单数量", store.店铺商品卡出单数量, expected.storeCardItems],
        );
      }
      for (const [label, actual, value, mode] of checks) {
        if (!managedNumberMatches(actual, value, mode)) {
          errors.push(`${date}.${this.profile.storeAggregateLabel}.${label}=${String(actual)}，应为 ${value}`);
        }
      }
      rows.push({ date, store });
    }
    return { ok: errors.length === 0, errors, rows };
  }

  public async syncRoi(
    sources: readonly DailySource[],
    productName: string,
  ): Promise<ChangeCounts> {
    const result: ChangeCounts = { created: 0, updated: 0, unchanged: 0 };
    const beforeRoi = await this.listRecords(this.roiTableId);
    for (const source of sources) {
      await this.upsertUniqueRecord({
        records: beforeRoi,
        uniqueKey: `${productName}|${source.date}`,
        match: (record) => (
          textValue(record.fields?.商品) === productName
          && dateKey(record.fields?.日期) === source.date
        ),
        desired: {
          商品: productName,
          日期: dateTimestamp(source.date),
          单量: source.orders,
          数量: source.items,
          商品卡出单量: source.cardOrders,
          商品卡出单数量: source.cardItems,
          销售额: source.gmv,
          出单视频: source.orderingVideos,
          ...(source.allianceVideoOrders === undefined ? {} : {
            联盟达人视频出单量: source.allianceVideoOrders,
            联盟达人视频出单数量: source.allianceVideoItems ?? 0,
            联盟达人直播出单量: source.allianceLiveOrders ?? 0,
            联盟达人直播出单数量: source.allianceLiveItems ?? 0,
            自营达人视频出单量: source.selfOperatedVideoOrders ?? 0,
            自营达人视频出单数量: source.selfOperatedVideoItems ?? 0,
            自营达人直播出单量: source.selfOperatedLiveOrders ?? 0,
            自营达人直播出单数量: source.selfOperatedLiveItems ?? 0,
          }),
        },
        result,
      });
    }

    // 新店铺的空白Base没有预先存在的店铺汇总日记录，也不应依赖外部
    // 工作流在不确定时间内代建。机器人用同一唯一键直接补齐，再由飞书
    // 公式汇总商品行；重复运行仍会命中并更新原记录。
    const storeRecords = await this.listRecords(this.roiTableId);
    for (const source of sources) {
      await this.upsertUniqueRecord({
        records: storeRecords,
        uniqueKey: `${this.profile.storeAggregateLabel}|${source.date}`,
        match: (record) => (
          textValue(record.fields?.商品) === this.profile.storeAggregateLabel
          && dateKey(record.fields?.日期) === source.date
        ),
        desired: {
          商品: this.profile.storeAggregateLabel,
          日期: dateTimestamp(source.date),
          店铺浏览量: source.visitors,
          出单视频: source.storeOrderingVideos,
          ...(source.storeAllianceVideoOrders === undefined ? {} : {
            店铺联盟达人视频出单量: source.storeAllianceVideoOrders,
            店铺联盟达人视频出单数量: source.storeAllianceVideoItems ?? 0,
            店铺联盟达人直播出单量: source.storeAllianceLiveOrders ?? 0,
            店铺联盟达人直播出单数量: source.storeAllianceLiveItems ?? 0,
            店铺自营达人视频出单量: source.storeSelfOperatedVideoOrders ?? 0,
            店铺自营达人视频出单数量: source.storeSelfOperatedVideoItems ?? 0,
            店铺自营达人直播出单量: source.storeSelfOperatedLiveOrders ?? 0,
            店铺自营达人直播出单数量: source.storeSelfOperatedLiveItems ?? 0,
            "店铺商品卡出单量(API)": source.storeCardOrders ?? 0,
            店铺商品卡出单数量: source.storeCardItems ?? 0,
          }),
        },
        result,
      });
    }
    return result;
  }

  public async syncOrderAttribution(
    sources: readonly DailyOrderAttributionSource[],
    productName: string,
  ): Promise<ChangeCounts> {
    const result: ChangeCounts = { created: 0, updated: 0, unchanged: 0 };
    const productRecords = await this.listRecords(this.roiTableId);
    for (const source of sources) {
      await this.upsertUniqueRecord({
        records: productRecords,
        uniqueKey: `${productName}|${source.date}|order-attribution`,
        match: (record) => (
          textValue(record.fields?.商品) === productName
          && dateKey(record.fields?.日期) === source.date
        ),
        desired: {
          商品: productName,
          日期: dateTimestamp(source.date),
          ...productOrderAttributionValues(source),
        },
        result,
      });
    }
    const storeRecords = await this.listRecords(this.roiTableId);
    for (const source of sources) {
      await this.upsertUniqueRecord({
        records: storeRecords,
        uniqueKey: `${this.profile.storeAggregateLabel}|${source.date}|order-attribution`,
        match: (record) => (
          textValue(record.fields?.商品) === this.profile.storeAggregateLabel
          && dateKey(record.fields?.日期) === source.date
        ),
        desired: {
          商品: this.profile.storeAggregateLabel,
          日期: dateTimestamp(source.date),
          店铺联盟达人视频出单量: source.storeAllianceVideoOrders ?? 0,
          店铺联盟达人视频出单数量: source.storeAllianceVideoItems ?? 0,
          店铺联盟达人直播出单量: source.storeAllianceLiveOrders ?? 0,
          店铺联盟达人直播出单数量: source.storeAllianceLiveItems ?? 0,
          店铺自营达人视频出单量: source.storeSelfOperatedVideoOrders ?? 0,
          店铺自营达人视频出单数量: source.storeSelfOperatedVideoItems ?? 0,
          店铺自营达人直播出单量: source.storeSelfOperatedLiveOrders ?? 0,
          店铺自营达人直播出单数量: source.storeSelfOperatedLiveItems ?? 0,
          "店铺商品卡出单量(API)": source.storeCardOrders ?? 0,
          店铺商品卡出单数量: source.storeCardItems ?? 0,
        },
        result,
      });
    }
    return result;
  }

  public async syncPaidOrderSnapshot(
    sources: readonly DailyPaidOrderSnapshotSource[],
    productName: string,
  ): Promise<ChangeCounts> {
    const result: ChangeCounts = { created: 0, updated: 0, unchanged: 0 };
    const records = await this.listRecords(this.roiTableId);
    // A paid-order row can arrive before any cooperation/online source row for
    // the same date. Create the store aggregate anchor synchronously here so
    // formula totals and the report readback never race the asynchronous ROI
    // record guard (the 2026-08-16 report exposed exactly that race).
    for (const date of [...new Set(sources.map((source) => source.date))]) {
      await this.upsertUniqueRecord({
        records,
        uniqueKey: `${this.profile.storeAggregateLabel}|${date}|paid-snapshot-anchor`,
        match: (record) => (
          textValue(record.fields?.商品) === this.profile.storeAggregateLabel
          && dateKey(record.fields?.日期) === date
        ),
        desired: {
          商品: this.profile.storeAggregateLabel,
          日期: dateTimestamp(date),
        },
        result,
      });
    }
    for (const source of sources) {
      await this.upsertUniqueRecord({
        records,
        uniqueKey: `${productName}|${source.date}|paid-snapshot`,
        match: (record) => (
          textValue(record.fields?.商品) === productName
          && dateKey(record.fields?.日期) === source.date
        ),
        desired: {
          商品: productName,
          日期: dateTimestamp(source.date),
          单量: source.orders,
          数量: source.items,
          ...(source.sales === undefined ? {} : { 销售额: source.sales }),
        },
        result,
      });
    }
    return result;
  }

  /**
   * Ensure one product row per configured product and one store aggregate row
   * for every requested Beijing-facing ROI date. This is create-only for the
   * business keys: existing manual/API values are never overwritten.
   */
  public async ensureRoiDateSkeleton(
    dates: readonly string[],
    productNames: readonly string[],
  ): Promise<ChangeCounts> {
    const uniqueDates = [...new Set(dates.map((date) => date.trim()).filter(Boolean))].sort();
    const uniqueProducts = [...new Set(productNames.map((name) => name.trim()).filter(Boolean))]
      .filter((name) => name !== this.profile.storeAggregateLabel)
      .sort((left, right) => left.localeCompare(right, "zh-CN"));
    if (uniqueDates.length === 0 || uniqueProducts.length === 0) {
      throw new Error("投产比日期骨架缺少日期或正式商品范围");
    }
    const result: ChangeCounts = { created: 0, updated: 0, unchanged: 0 };
    const records = await this.listRecords(this.roiTableId);
    for (const date of uniqueDates) {
      for (const productName of uniqueProducts) {
        await this.upsertUniqueRecord({
          records,
          uniqueKey: `${productName}|${date}|daily-skeleton`,
          match: (record) => (
            textValue(record.fields?.商品) === productName
            && dateKey(record.fields?.日期) === date
          ),
          desired: { 商品: productName, 日期: dateTimestamp(date) },
          result,
        });
      }
      await this.upsertUniqueRecord({
        records,
        uniqueKey: `${this.profile.storeAggregateLabel}|${date}|daily-skeleton`,
        match: (record) => (
          textValue(record.fields?.商品) === this.profile.storeAggregateLabel
          && dateKey(record.fields?.日期) === date
        ),
        desired: { 商品: this.profile.storeAggregateLabel, 日期: dateTimestamp(date) },
        result,
      });
    }
    return result;
  }

  public async verifyPaidOrderSnapshotBulk(
    entries: ReadonlyArray<{
      product: { name: string };
      sources: readonly DailyPaidOrderSnapshotSource[];
    }>,
  ): Promise<{ ok: boolean; errors: string[] }> {
    await sleep(3_000);
    const records = await this.listRecords(this.roiTableId, true);
    const errors: string[] = [];
    const expectedStore = new Map<string, { orders: number; items: number; sales: number; salesComplete: boolean }>();
    for (const entry of entries) {
      for (const source of entry.sources) {
        const matches = records.filter((record) => (
          textValue(record.fields?.商品) === entry.product.name
          && dateKey(record.fields?.日期) === source.date
        ));
        if (matches.length !== 1) {
          errors.push(`${entry.product.name} ${source.date} 记录数=${matches.length}`);
          continue;
        }
        const fields = matches[0].fields ?? {};
        if (!managedNumberMatches(fields.单量, source.orders)) {
          errors.push(`${source.date}.${entry.product.name}.单量=${String(fields.单量)}，应为 ${source.orders}`);
        }
        if (!managedNumberMatches(fields.数量, source.items)) {
          errors.push(`${source.date}.${entry.product.name}.数量=${String(fields.数量)}，应为 ${source.items}`);
        }
        if (source.sales !== undefined && !managedNumberMatches(fields.销售额, source.sales)) {
          errors.push(`${source.date}.${entry.product.name}.销售额=${String(fields.销售额)}，应为 ${source.sales}`);
        }
        const store = expectedStore.get(source.date) ?? { orders: 0, items: 0, sales: 0, salesComplete: true };
        store.orders += source.orders;
        store.items += source.items;
        store.sales += source.sales ?? 0;
        store.salesComplete = store.salesComplete && source.sales !== undefined;
        expectedStore.set(source.date, store);
      }
    }
    for (const [date, expected] of expectedStore) {
      const matches = records.filter((record) => (
        textValue(record.fields?.商品) === this.profile.storeAggregateLabel
        && dateKey(record.fields?.日期) === date
      ));
      if (matches.length !== 1) {
        errors.push(`${this.profile.storeAggregateLabel} ${date} 记录数=${matches.length}`);
        continue;
      }
      const fields = matches[0].fields ?? {};
      if (!managedNumberMatches(fields.总单量, expected.orders)) {
        errors.push(`${date}.${this.profile.storeAggregateLabel}.总单量=${String(fields.总单量)}，应为 ${expected.orders}`);
      }
      if (!managedNumberMatches(fields.总数量, expected.items)) {
        errors.push(`${date}.${this.profile.storeAggregateLabel}.总数量=${String(fields.总数量)}，应为 ${expected.items}`);
      }
      if (expected.salesComplete && !managedNumberMatches(fields.店铺销售额, expected.sales)) {
        errors.push(`${date}.${this.profile.storeAggregateLabel}.店铺销售额=${String(fields.店铺销售额)}，应为 ${expected.sales}`);
      }
    }
    return { ok: errors.length === 0, errors };
  }

  public async verifyOrderAttributionBulk(
    entries: ReadonlyArray<{ product: { name: string }; sources: readonly DailyOrderAttributionSource[] }>,
  ): Promise<{ ok: boolean; errors: string[] }> {
    await sleep(3_000);
    const records = await this.listRecords(this.roiTableId, true);
    const errors: string[] = [];
    const expectedStore = new Map<string, DailyOrderAttributionSource>();
    for (const entry of entries) {
      for (const source of entry.sources) {
        const matches = records.filter((record) => (
          textValue(record.fields?.商品) === entry.product.name
          && dateKey(record.fields?.日期) === source.date
        ));
        if (matches.length !== 1) errors.push(`${entry.product.name} ${source.date} 记录数=${matches.length}`);
        const fields = matches[0]?.fields ?? {};
        const checks: NumericVerification[] = [
          ["单量", fields.单量, source.orders, "at_least"],
          ["数量", fields.数量, source.items, "at_least"],
          ["联盟达人视频出单量", fields.联盟达人视频出单量, source.allianceVideoOrders ?? 0],
          ["联盟达人视频出单数量", fields.联盟达人视频出单数量, source.allianceVideoItems ?? 0],
          ["联盟达人直播出单量", fields.联盟达人直播出单量, source.allianceLiveOrders ?? 0],
          ["联盟达人直播出单数量", fields.联盟达人直播出单数量, source.allianceLiveItems ?? 0],
          ["自营达人视频出单量", fields.自营达人视频出单量, source.selfOperatedVideoOrders ?? 0],
          ["自营达人视频出单数量", fields.自营达人视频出单数量, source.selfOperatedVideoItems ?? 0],
          ["自营达人直播出单量", fields.自营达人直播出单量, source.selfOperatedLiveOrders ?? 0],
          ["自营达人直播出单数量", fields.自营达人直播出单数量, source.selfOperatedLiveItems ?? 0],
          ["商品卡出单量", fields.商品卡出单量, source.cardOrders],
          ["商品卡出单数量", fields.商品卡出单数量, source.cardItems],
        ];
        for (const [label, actual, expected, mode] of checks) {
          if (!managedNumberMatches(actual, expected, mode)) {
            errors.push(`${source.date}.${entry.product.name}.${label}=${String(actual)}，应为 ${expected}`);
          }
        }
        const prior = expectedStore.get(source.date);
        if (prior && JSON.stringify(storeAttributionSnapshot(prior)) !== JSON.stringify(storeAttributionSnapshot(source))) {
          errors.push(`${source.date} 店铺订单归因来源不一致`);
        } else if (!prior) {
          expectedStore.set(source.date, source);
        }
      }
    }
    for (const [date, source] of expectedStore) {
      const matches = records.filter((record) => (
        textValue(record.fields?.商品) === this.profile.storeAggregateLabel
        && dateKey(record.fields?.日期) === date
      ));
      if (matches.length !== 1) errors.push(`${this.profile.storeAggregateLabel} ${date} 记录数=${matches.length}`);
      const fields = matches[0]?.fields ?? {};
      const checks: NumericVerification[] = [
        ["联盟达人视频出单量", fields.店铺联盟达人视频出单量, source.storeAllianceVideoOrders ?? 0],
        ["联盟达人视频出单数量", fields.店铺联盟达人视频出单数量, source.storeAllianceVideoItems ?? 0],
        ["联盟达人直播出单量", fields.店铺联盟达人直播出单量, source.storeAllianceLiveOrders ?? 0],
        ["联盟达人直播出单数量", fields.店铺联盟达人直播出单数量, source.storeAllianceLiveItems ?? 0],
        ["自营达人视频出单量", fields.店铺自营达人视频出单量, source.storeSelfOperatedVideoOrders ?? 0],
        ["自营达人视频出单数量", fields.店铺自营达人视频出单数量, source.storeSelfOperatedVideoItems ?? 0],
        ["自营达人直播出单量", fields.店铺自营达人直播出单量, source.storeSelfOperatedLiveOrders ?? 0],
        ["自营达人直播出单数量", fields.店铺自营达人直播出单数量, source.storeSelfOperatedLiveItems ?? 0],
        ["商品卡出单量", fields["店铺商品卡出单量(API)"], source.storeCardOrders ?? 0],
        ["商品卡出单数量", fields.店铺商品卡出单数量, source.storeCardItems ?? 0],
      ];
      for (const [label, actual, expected, mode] of checks) {
        if (!managedNumberMatches(actual, expected, mode)) {
          errors.push(`${date}.${this.profile.storeAggregateLabel}.${label}=${String(actual)}，应为 ${expected}`);
        }
      }
    }
    return { ok: errors.length === 0, errors };
  }

  public async syncOnline(video: VideoSource, expected?: OnlineRecordSnapshot | null): Promise<ChangeCounts & { recordId: string }> {
    const creatorHandle = normalizeTikTokHandle(video.creator);
    if (!creatorHandle) {
      throw new Error(
        "达人姓名必须是已确认的 TikTok username（不带 @），不能使用展示昵称或 creator ID",
      );
    }
    const result: ChangeCounts = { created: 0, updated: 0, unchanged: 0 };
    // Existing rows are re-read by immutable record ID immediately before
    // writing. New rows still get a fresh uniqueness check before creation.
    const prior = expected?.recordId
      ? await this.getOnlineRecordSnapshot(expected.recordId)
      : await this.snapshotOnlineByVideoId(video.id);
    if (expected !== undefined && (prior?.recordId ?? null) !== (expected?.recordId ?? null)) {
      throw new Error(`视频 ${video.id} 写前记录身份发生变化，拒绝覆盖`);
    }
    if (prior && !urlValue(prior.fields.视频上线地址).includes(`/video/${video.id}`)) {
      throw new Error(`视频 ${video.id} 写前链接发生变化，拒绝覆盖`);
    }

    const desired = {
      达人姓名: creatorHandle,
      挂车产品: video.products,
      视频上线地址: linkValueForField(video.url, this.onlineVideoLinkFieldType),
      视频曝光K: numberValueForField(video.viewsK, this.onlineViewsFieldType),
      售出数量: video.itemsSold,
      销售额: video.gmv,
    };
    let recordId = prior?.recordId ?? "";
    if (!recordId) {
      const created = await this.client.bitable.appTableRecord.create({
        path: { app_token: this.appToken, table_id: this.onlineTableId },
        data: {
          fields: {
            登记日期: dateValueForField(
              shanghaiToday(),
              dateTimestamp(shanghaiToday()),
              this.onlineRegistrationDateFieldType,
            ),
            ...desired,
          },
        },
      });
      assertFeishuResponse(created, "新增真实上线记录");
      recordId = String(created.data?.record?.record_id ?? "");
      if (!recordId) throw new Error("新增真实上线记录未返回 record_id");
      result.created += 1;
    } else {
      await this.updateManagedFields(
        this.onlineTableId,
        { record_id: prior!.recordId, fields: prior!.fields },
        desired,
        `online|${video.id}`,
        result,
      );
    }

    await registerTrustedOnlineImport(recordId, dateTimestamp(video.date));
    if (dateKey(prior?.fields["实上线日期(Ct)"]) !== video.date) {
      const updated = await this.client.bitable.appTableRecord.update({
        path: {
          app_token: this.appToken,
          table_id: this.onlineTableId,
          record_id: recordId,
        },
        data: { fields: { "实上线日期(Ct)": dateTimestamp(video.date) } },
      });
      assertFeishuResponse(updated, "写入真实上线日期");
      result.updated += 1;
    }
    return { ...result, recordId };
  }

  /** Existing video rows only: one bounded/idempotent batch write, no manual fields. */
  public async syncExistingOnlineBatch(items: readonly { video: VideoSource; before: OnlineRecordSnapshot }[]): Promise<void> {
    if (items.length > 50) throw new Error("上线更新批次超过50条");
    if (!items.length) return;
    const current = await this.snapshotOnlineByVideoIds(items.map((item) => item.video.id));
    const updates: Array<{ record_id: string; fields: Record<string, unknown> }> = [];
    for (const { video, before } of items) {
      const live = current.get(video.id);
      if (!live || live.recordId !== before.recordId || JSON.stringify(live.fields) !== JSON.stringify(before.fields)) {
        throw new Error(`视频${video.id}批量写前发生变化，拒绝覆盖`);
      }
      const creator = normalizeTikTokHandle(video.creator);
      if (!creator) throw new Error(`视频${video.id}缺少可信TK号`);
      const desired: Record<string, unknown> = {
        达人姓名: creator,
        挂车产品: video.products,
        视频上线地址: linkValueForField(video.url, this.onlineVideoLinkFieldType),
        视频曝光K: numberValueForField(video.viewsK, this.onlineViewsFieldType),
        售出数量: video.itemsSold,
        销售额: video.gmv,
      };
      if (dateKey(live.fields["实上线日期(Ct)"]) !== video.date) desired["实上线日期(Ct)"] = dateTimestamp(video.date);
      const fields = Object.fromEntries(Object.entries(desired).filter(([name, value]) => !sameManagedValue(live.fields[name], value)));
      if (Object.keys(fields).length) updates.push({ record_id: live.recordId, fields });
    }
    if (!updates.length) return;
    await registerTrustedOnlineImports(items.map(({ video, before }) => ({
      recordId: before.recordId, expectedDate: dateTimestamp(video.date),
    })), { path: this.options.trustedImportPath });
    const clientToken = randomUUID();
    await withFeishuRetry(async () => {
      const response = await withFeishuBitableQuotaCircuit<any>(this.appId, () => this.client.bitable.appTableRecord.batchUpdate({
        path: { app_token: this.appToken, table_id: this.onlineTableId },
        params: { client_token: clientToken },
        data: { records: updates },
      }));
      assertFeishuResponse(response, "批量更新上线自动字段");
      if (response.data?.records?.length !== updates.length) throw new Error("批量上线更新回执数量不匹配");
    });
  }

  public async verifyOnline(
    video: VideoSource,
    recordId: string,
    snapshot?: OnlineRecordSnapshot,
  ): Promise<{ ok: boolean; errors: string[]; record: OnlineRecordSnapshot }> {
    const record = snapshot ?? await this.getOnlineRecordSnapshot(recordId);
    const errors: string[] = [];
    if (normalizeTikTokHandle(record.fields.达人姓名) !== normalizeTikTokHandle(video.creator)) {
      errors.push("达人姓名写后不匹配");
    }
    if (dateKey(record.fields["实上线日期(Ct)"]) !== video.date) {
      errors.push(`实上线日期未保持为 ${video.date}`);
    }
    if (!urlValue(record.fields.视频上线地址).includes(video.id)) {
      errors.push("视频上线地址写后不匹配");
    }
    const actualProducts = Array.isArray(record.fields.挂车产品)
      ? record.fields.挂车产品.map(textValue)
      : [textValue(record.fields.挂车产品)].filter(Boolean);
    for (const product of video.products) {
      if (!actualProducts.includes(product)) errors.push(`挂车产品缺少 ${product}`);
    }
    if (Math.abs(Number(record.fields.视频曝光K ?? 0) - video.viewsK) > 0.000001) {
      errors.push(`视频曝光K=${String(record.fields.视频曝光K)}，应为 ${video.viewsK}`);
    }
    if (Math.abs(Number(record.fields.售出数量 ?? 0) - video.itemsSold) > 0.000001) {
      errors.push(`售出数量=${String(record.fields.售出数量)}，应为 ${video.itemsSold}`);
    }
    if (Math.abs(Number(record.fields.销售额 ?? 0) - video.gmv) > 0.000001) {
      errors.push(`销售额=${String(record.fields.销售额)}，应为 ${video.gmv}`);
    }
    return { ok: errors.length === 0, errors, record };
  }

  public async verify(
    sources: readonly DailySource[],
    productName: string,
    video: VideoSource,
    videoRecordId: string,
  ): Promise<{ ok: boolean; errors: string[]; rows: unknown[] }> {
    await sleep(3_000);
    const [roiRecords, onlineRecord] = await Promise.all([
      this.listRecords(this.roiTableId, true),
      this.getRecord(this.onlineTableId, videoRecordId, true),
    ]);
    const errors: string[] = [];
    const rows = sources.map((source) => {
      const productRows = roiRecords.filter((record) => (
        textValue(record.fields?.商品) === productName
        && dateKey(record.fields?.日期) === source.date
      ));
      const storeRows = roiRecords.filter((record) => (
        textValue(record.fields?.商品) === this.profile.storeAggregateLabel
        && dateKey(record.fields?.日期) === source.date
      ));
      if (productRows.length !== 1) {
        errors.push(`${productName} ${source.date} 记录数=${productRows.length}`);
      }
      if (storeRows.length !== 1) {
        errors.push(`${this.profile.storeAggregateLabel} ${source.date} 记录数=${storeRows.length}`);
      }
      const product = productRows[0]?.fields ?? {};
      const store = storeRows[0]?.fields ?? {};
      const expectedOnline = source.date === video.date ? 1 : 0;
      const checks: NumericVerification[] = [
        ["商品单量", product.单量, source.orders, "at_least"],
        ["商品数量", product.数量, source.items, "at_least"],
        ["商品卡出单量", product.商品卡出单量, source.cardOrders],
        ["商品卡出单数量", product.商品卡出单数量, source.cardItems],
        ["销售额", product.销售额, source.gmv],
        ["商品出单视频", product.出单视频, source.orderingVideos],
        ["达人出单量", product.达人出单量, source.orders - source.cardOrders, "at_least"],
        ["达人出单数量", product.达人出单数量, source.items - source.cardItems, "at_least"],
        ["商品上线量", product.上线量, expectedOnline],
        ["店铺浏览量", store.店铺浏览量, source.visitors],
        ["店铺总单量", store.总单量, source.orders, "at_least"],
        ["店铺总数量", store.总数量, source.items, "at_least"],
        ["店铺商品卡出单量", store.店铺商品卡出单量, source.cardOrders],
        ["店铺销售额", store.店铺销售额, source.gmv],
        ["店铺出单视频", store.出单视频, source.storeOrderingVideos],
        ["店铺上线量", store.上线量, expectedOnline],
      ];
      if (source.allianceVideoOrders !== undefined) {
        checks.push(
          ["联盟达人视频出单量", product.联盟达人视频出单量, source.allianceVideoOrders],
          ["联盟达人视频出单数量", product.联盟达人视频出单数量, source.allianceVideoItems ?? 0],
          ["联盟达人直播出单量", product.联盟达人直播出单量, source.allianceLiveOrders ?? 0],
          ["联盟达人直播出单数量", product.联盟达人直播出单数量, source.allianceLiveItems ?? 0],
          ["自营达人视频出单量", product.自营达人视频出单量, source.selfOperatedVideoOrders ?? 0],
          ["自营达人视频出单数量", product.自营达人视频出单数量, source.selfOperatedVideoItems ?? 0],
          ["自营达人直播出单量", product.自营达人直播出单量, source.selfOperatedLiveOrders ?? 0],
          ["自营达人直播出单数量", product.自营达人直播出单数量, source.selfOperatedLiveItems ?? 0],
          ["店铺联盟达人视频出单量", store.店铺联盟达人视频出单量, source.storeAllianceVideoOrders ?? 0],
          ["店铺联盟达人视频出单数量", store.店铺联盟达人视频出单数量, source.storeAllianceVideoItems ?? 0],
          ["店铺联盟达人直播出单量", store.店铺联盟达人直播出单量, source.storeAllianceLiveOrders ?? 0],
          ["店铺联盟达人直播出单数量", store.店铺联盟达人直播出单数量, source.storeAllianceLiveItems ?? 0],
          ["店铺自营达人视频出单量", store.店铺自营达人视频出单量, source.storeSelfOperatedVideoOrders ?? 0],
          ["店铺自营达人视频出单数量", store.店铺自营达人视频出单数量, source.storeSelfOperatedVideoItems ?? 0],
          ["店铺自营达人直播出单量", store.店铺自营达人直播出单量, source.storeSelfOperatedLiveOrders ?? 0],
          ["店铺自营达人直播出单数量", store.店铺自营达人直播出单数量, source.storeSelfOperatedLiveItems ?? 0],
          ["店铺商品卡出单量", store["店铺商品卡出单量(API)"], source.storeCardOrders ?? 0],
          ["店铺商品卡出单数量", store.店铺商品卡出单数量, source.storeCardItems ?? 0],
        );
      }
      for (const [label, actual, expected, mode] of checks) {
        if (!managedNumberMatches(actual, expected, mode)) {
          errors.push(`${source.date}.${label}=${String(actual)}，应为 ${expected}`);
        }
      }
      return { date: source.date, product, store };
    });
    if (dateKey(onlineRecord.fields?.["实上线日期(Ct)"]) !== video.date) {
      errors.push(`上线日期未保持为 ${video.date}`);
    }
    if (!urlValue(onlineRecord.fields?.视频上线地址).includes(video.id)) {
      errors.push("上线视频地址写后不匹配");
    }
    return { ok: errors.length === 0, errors, rows };
  }

  private async ensureMultiSelectOption(
    tableId: string,
    fields: any[],
    fieldName: string,
    optionName: string,
  ): Promise<boolean> {
    const field = fields.find((item) => item.field_name === fieldName);
    if (!field?.field_id || Number(field.type) !== 4) {
      throw new Error(`字段“${fieldName}”不是多选字段`);
    }
    const options = field.property?.options ?? [];
    if (options.some((option: any) => option.name === optionName)) return false;
    const response = await this.client.bitable.appTableField.update({
      path: {
        app_token: this.appToken,
        table_id: tableId,
        field_id: field.field_id,
      },
      params: { client_token: token(`option|${fieldName}|${optionName}`) },
      data: {
        field_name: fieldName,
        type: 4,
        ui_type: "MultiSelect",
        property: { options: [...options, { name: optionName, color: 46 }] },
      },
    });
    assertFeishuResponse(response, `新增“${optionName}”选项`);
    const verified = await this.listFields(tableId);
    const current = verified.find((item) => item.field_name === fieldName);
    if (!current?.property?.options?.some((option: any) => option.name === optionName)) {
      throw new Error(`“${optionName}”选项写后验证失败`);
    }
    return true;
  }

  private async upsertUniqueRecord(input: {
    records: FeishuRecord[];
    uniqueKey: string;
    match: (record: FeishuRecord) => boolean;
    desired: Record<string, unknown>;
    monotonicFields?: readonly string[];
    result: ChangeCounts;
  }): Promise<void> {
    let matches = input.records.filter(input.match);
    if (matches.length > 1) throw new Error(`唯一键重复：${input.uniqueKey}`);
    if (matches.length === 0) {
      const latest = await this.listRecords(this.roiTableId);
      matches = latest.filter(input.match);
      if (matches.length > 1) throw new Error(`并发后唯一键重复：${input.uniqueKey}`);
    }
    if (matches.length === 0) {
      const response = await this.client.bitable.appTableRecord.create({
        path: { app_token: this.appToken, table_id: this.roiTableId },
        data: { fields: input.desired },
      });
      assertFeishuResponse(response, `新增记录 ${input.uniqueKey}`);
      input.result.created += 1;
      return;
    }
    const mergedDesired = mergeMonotonicNumberFields(
      matches[0].fields,
      input.desired,
      input.monotonicFields ?? [],
    );
    const mutableDesired = Object.fromEntries(
      Object.entries(mergedDesired).filter(([field]) => field !== "商品" && field !== "日期"),
    );
    await this.updateManagedFields(
      this.roiTableId,
      matches[0],
      mutableDesired,
      input.uniqueKey,
      input.result,
    );
  }

  private async updateManagedFields(
    tableId: string,
    record: FeishuRecord,
    desired: Record<string, unknown>,
    scope: string,
    result: Pick<ChangeCounts, "updated" | "unchanged">,
  ): Promise<void> {
    const changed = Object.fromEntries(
      Object.entries(desired).filter(([name, value]) => (
        !sameManagedValue(record.fields?.[name], value)
      )),
    );
    if (Object.keys(changed).length === 0) {
      result.unchanged += 1;
      return;
    }
    const recordId = String(record.record_id ?? "");
    const current = await this.getRecord(tableId, recordId);
    if (
      record.last_modified_time
      && current.last_modified_time
      && Number(record.last_modified_time) !== Number(current.last_modified_time)
    ) {
      throw new Error(`并发冲突：${scope} 在读取后被其他人修改`);
    }
    const response = await this.client.bitable.appTableRecord.update({
      path: { app_token: this.appToken, table_id: tableId, record_id: recordId },
      data: { fields: changed },
    });
    assertFeishuResponse(response, `更新记录 ${scope}`);
    result.updated += 1;
  }

  private async listFields(tableId: string): Promise<any[]> {
    return this.listAll((pageToken) => this.client.bitable.appTableField.list({
      path: { app_token: this.appToken, table_id: tableId },
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    }));
  }

  private async listRecords(
    tableId: string,
    automaticFields = false,
  ): Promise<FeishuRecord[]> {
    return this.listAll((pageToken) => this.client.bitable.appTableRecord.list({
      path: { app_token: this.appToken, table_id: tableId },
      params: {
        page_size: 500,
        automatic_fields: automaticFields,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    }));
  }

  private async getRecord(
    tableId: string,
    recordId: string,
    automaticFields = false,
  ): Promise<FeishuRecord> {
    const response = await this.withDataReadyRetry<any>(() => this.client.bitable.appTableRecord.get({
      path: { app_token: this.appToken, table_id: tableId, record_id: recordId },
      params: { automatic_fields: automaticFields },
    }), `读取记录 ${recordId}`);
    assertFeishuResponse(response, `读取记录 ${recordId}`);
    if (!response.data?.record) throw new Error(`记录不存在：${recordId}`);
    return response.data.record;
  }

  private async listAll(
    request: (pageToken?: string) => Promise<any>,
  ): Promise<any[]> {
    const items: any[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.withDataReadyRetry(
        () => request(pageToken),
        "分页读取飞书数据",
      );
      assertFeishuResponse(response, "分页读取飞书数据");
      items.push(...(response.data?.items ?? []));
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    return items;
  }

  private async withDataReadyRetry<T>(action: () => Promise<T>, label: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        return await withFeishuBitableQuotaCircuit(this.appId, async () => {
          const response = await action();
          assertFeishuResponse(response as { code?: number; msg?: string }, label);
          return response;
        });
      } catch (error) {
        lastError = error;
        const code = feishuErrorDetails(error).code;
        const dataReady = code === 1254607;
        if ((!dataReady && !isRetryableFeishuError(error)) || attempt >= (dataReady ? 6 : 3)) throw error;
        console.warn(`[feishu-data-ready] ${label}：第 ${attempt} 次等待后重试`);
        await sleep(attempt * (dataReady ? 2_000 : 500));
      }
    }
    throw lastError;
  }
}

function requireUniqueTable(tables: any[], name: string): string {
  const matches = tables.filter((table) => table.name === name && table.table_id);
  if (matches.length !== 1) throw new Error(`数据表“${name}”数量不是 1`);
  return String(matches[0].table_id);
}

function assertWritableFields(fields: any[], names: string[]): void {
  for (const name of names) {
    const field = fields.find((item) => item.field_name === name);
    if (!field || FORMULA_TYPES.has(Number(field.type))) {
      throw new Error(`字段“${name}”不存在或不是可写字段`);
    }
  }
}

function assertFormulaFields(fields: any[], names: string[]): void {
  for (const name of names) {
    const field = fields.find((item) => item.field_name === name);
    if (!field || !FORMULA_TYPES.has(Number(field.type))) {
      throw new Error(`字段“${name}”不存在或不是公式字段`);
    }
  }
}

function fieldType(fields: any[], name: string): number | null {
  const value = Number(fields.find((item) => item.field_name === name)?.type);
  return Number.isFinite(value) ? value : null;
}

function shanghaiToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
  }).format(new Date());
}

export function dateTimestamp(date: string): number {
  return Date.parse(`${date}T12:00:00Z`);
}

export function dateKey(value: unknown): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function storeAttributionSnapshot(source: DailyOrderAttributionSource): number[] {
  return [
    source.storeAllianceVideoOrders ?? 0, source.storeAllianceVideoItems ?? 0,
    source.storeAllianceLiveOrders ?? 0, source.storeAllianceLiveItems ?? 0,
    source.storeSelfOperatedVideoOrders ?? 0, source.storeSelfOperatedVideoItems ?? 0,
    source.storeSelfOperatedLiveOrders ?? 0, source.storeSelfOperatedLiveItems ?? 0,
    source.storeCardOrders ?? 0, source.storeCardItems ?? 0,
  ];
}

function textValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(textValue).join("").trim();
  if (value && typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "").trim();
  }
  return value === null || value === undefined ? "" : String(value).trim();
}

function selectValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return [...new Set(values.map(textValue).map((item) => item.trim()).filter(Boolean))];
}

function urlValue(value: unknown): string {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return String(object.link ?? object.text ?? value ?? "");
}

export function sameManagedValue(left: unknown, right: unknown): boolean {
  if (typeof right === "number") {
    if (left === null || left === undefined || left === "") return false;
    const parsed = Number(left);
    return Number.isFinite(parsed) && Math.abs(parsed - right) < 0.000001;
  }
  if (typeof left === "string" && typeof right === "string") {
    const withoutDuplicateMarker = (value: string): string => value.replaceAll("\u2063", "");
    return withoutDuplicateMarker(left) === withoutDuplicateMarker(right);
  }
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function managedNumberAtLeast(actual: unknown, expected: number): boolean {
  const value = Number(actual ?? 0);
  return Number.isFinite(value) && value + 0.000001 >= expected;
}

function managedNumberMatches(
  actual: unknown,
  expected: number,
  mode: "exact" | "at_least" = "exact",
): boolean {
  return mode === "at_least"
    ? managedNumberAtLeast(actual, expected)
    : Math.abs(Number(actual ?? 0) - expected) <= 0.000001;
}

function token(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
