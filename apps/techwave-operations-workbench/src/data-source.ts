import type {
  IOpenCellValue,
  IFieldMeta,
  IRecord,
  ITable,
} from "@lark-opdev/block-bitable-api";
import {
  FIELD_IDS,
  ACCOUNT_SIDE_AGGREGATE_METRICS,
  ACCOUNT_SIDE_METRICS,
  PRODUCT_METRICS,
  ORDER_ATTRIBUTION_NUMBER_FIELDS,
  SHOP_METRICS,
  SHOP_NAME,
  setRuntimeStoreAggregateLabel,
  advertisingFieldRepairPlan,
  advertisingFieldWarnings,
  applyFormulaFallbacks,
  dateKeyToTimestamp,
  discoverAdvertisingAccounts,
  indexRecords,
  isMetricManuallyEditable,
  normalizeRecords,
  normalizeAccountSideRecords,
  orderAttributionSchemaIssues,
  recordKey,
  resolveFieldMap,
  toNumber,
  toText,
  validateFieldMap,
  type AdvertisingAccount,
  type FieldName,
  type NormalizedDataset,
  type NormalizedRecord,
} from "./domain";
import {
  BUSINESS_DISPLAY_NAME,
  ROI_TABLE_NAME,
  STORE_AGGREGATE_LABEL,
} from "./runtime-config";
import { requireCanonicalProductName } from "./product-naming";
import {
  mergeProductMappings,
  verifiedFormalProductMappings,
  type ProductLinkMapping,
} from "./product-links";

export type SaveState = "idle" | "saving" | "saved" | "conflict" | "error";

export interface CellWriteRequest {
  recordId: string;
  fieldName: string;
  expectedValue: number | null;
  nextValue: number | null;
}

export interface CellWriteResult {
  state: Exclude<SaveState, "idle" | "saving">;
  value: number | null;
  message: string;
}

export interface ProductMapping extends ProductLinkMapping {}

export interface WorkbenchConfig {
  businessDisplayName: string;
  storeAggregateLabel: string;
  roiTableName: string;
}

export interface CreateDailyRecordRequest {
  productName: string;
  dateKey: string;
  tiktokProductId?: string;
}

export interface WorkbenchDataSource {
  load(): Promise<NormalizedDataset>;
  saveCell(request: CellWriteRequest): Promise<CellWriteResult>;
  createDailyRecord(request: CreateDailyRecordRequest): Promise<{ recordId: string; created: boolean; message: string }>;
  deleteProduct(productName: string): Promise<{ deletedCount: number; message: string }>;
  getMappings(): Promise<ProductMapping[]>;
  getConfig(): Promise<WorkbenchConfig>;
  saveConfig(config: WorkbenchConfig): Promise<void>;
  addAdvertisingAccount(name: string): Promise<{ account: AdvertisingAccount; message: string }>;
  renameAdvertisingAccount(accountId: string, name: string): Promise<{ account: AdvertisingAccount; message: string }>;
  removeAdvertisingAccount(accountId: string): Promise<{ message: string }>;
  restoreAdvertisingAccount(accountId: string): Promise<{ message: string }>;
  repairAdvertisingAccounts(): Promise<{ repairedCount: number; message: string }>;
  subscribe(onChange: () => void): () => void;
  notify(message: string, type?: "success" | "warning" | "error"): Promise<void>;
}

type BitableSdk = typeof import("@lark-opdev/block-bitable-api");

async function loadBitableSdk(): Promise<BitableSdk> {
  return import("@lark-opdev/block-bitable-api");
}

const DEFAULT_PRODUCT_MAPPINGS: ProductMapping[] = verifiedFormalProductMappings();
const ACCOUNT_SIDE_TABLES = new Set(["产品投产比", "账号投产比"]);

/**
 * Currency fields store numeric cell values too, but the block SDK reports
 * them as FieldType.Currency (99003) rather than FieldType.Number (2).
 */
export function isAccountSideNumericFieldType(type: number): boolean {
  return type === 2 || type === 99003;
}

class SerialTaskQueue {
  private chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.chains.set(key, current);
    void current.finally(() => {
      if (this.chains.get(key) === current) this.chains.delete(key);
    });
    return current;
  }
}

const CONFIG_KEY = "store-workbench-config-v2";
const DEFAULT_CONFIG: WorkbenchConfig = {
  businessDisplayName: BUSINESS_DISPLAY_NAME,
  storeAggregateLabel: STORE_AGGREGATE_LABEL,
  roiTableName: ROI_TABLE_NAME,
};

interface StoredWorkbenchData extends Partial<WorkbenchConfig> {
  productMappings?: ProductMapping[];
  archivedAdvertisingSpendFieldIds?: string[];
}

const staticEditableFields = new Set<string>([
  ...PRODUCT_METRICS.filter(isMetricManuallyEditable).map((metric) => metric.fieldName),
  ...SHOP_METRICS.filter(isMetricManuallyEditable).map((metric) => metric.fieldName),
]);

const accountSideEditableFields = new Set<string>(
  ACCOUNT_SIDE_AGGREGATE_METRICS.filter(isMetricManuallyEditable).map((metric) => metric.fieldName),
);

function sameNumber(a: number | null, b: number | null): boolean {
  return a === b || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9);
}

async function readAllRecords(table: ITable): Promise<IRecord[]> {
  const records: IRecord[] = [];
  let pageToken: string | undefined;
  do {
    const page = await table.getRecords({ pageSize: 200, pageToken });
    records.push(...page.records);
    pageToken = page.hasMore ? page.pageToken : undefined;
  } while (pageToken);
  return records;
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(app_secret|token|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=<已隐藏>")
    .slice(0, 240);
}

export class FeishuWorkbenchDataSource implements WorkbenchDataSource {
  private queue = new SerialTaskQueue();
  private table: ITable | null = null;
  private fieldIds = new Map<string, string>();
  private editableFieldNames = new Set<string>();
  private config: WorkbenchConfig | null = null;

  private async ensureConfig(): Promise<WorkbenchConfig> {
    if (this.config) return this.config;
    try {
      const { bitable } = await loadBitableSdk();
      const stored = await bitable.bridge.getData<Partial<WorkbenchConfig>>(CONFIG_KEY);
      this.config = normalizeWorkbenchConfig({ ...DEFAULT_CONFIG, ...stored });
    } catch {
      this.config = { ...DEFAULT_CONFIG };
    }
    setRuntimeStoreAggregateLabel(this.config.storeAggregateLabel);
    return this.config;
  }

  private async getTargetTable(): Promise<ITable> {
    if (this.table) return this.table;
    const config = await this.ensureConfig();
    const { bitable } = await loadBitableSdk();
    const selection = await bitable.base.getSelection();
    const selected = selection.tableId ? await bitable.base.getTableById(selection.tableId) : null;
    if (selected) {
      const selectedName = await selected.getName();
      if (selectedName === config.roiTableName || ACCOUNT_SIDE_TABLES.has(selectedName)) {
        this.table = selected;
        return selected;
      }
    }
    this.table = await bitable.base.getTableByName(config.roiTableName);
    return this.table;
  }

  async load(): Promise<NormalizedDataset> {
    await this.ensureConfig();
    const { bitable, OperationType, PermissionEntity } = await loadBitableSdk();
    const table = await this.getTargetTable();
    const [tableName, initialMetas, tableEditable, baseEditable, deletable, manageable, stored] = await Promise.all([
      table.getName(),
      table.getFieldMetaList(),
      bitable.base.getPermission({ entity: PermissionEntity.Table, param: { tableId: table.id }, type: OperationType.Editable }).catch(() => false),
      bitable.base.isEditable().catch(() => false),
      bitable.base.getPermission({ entity: PermissionEntity.Record, param: { tableId: table.id }, type: OperationType.Deletable }),
      bitable.base.getBasePermission(OperationType.Manageable),
      bitable.bridge.getData<StoredWorkbenchData>(CONFIG_KEY).catch(() => null),
    ]);
    const records = await readAllRecords(table);
    const accountMode = tableName === "产品投产比"
      ? "account-product" as const
      : tableName === "账号投产比"
        ? "account-account" as const
        : null;
    if (accountMode) {
      const dimensionField = accountMode === "account-product" ? "商品" as const : "账号" as const;
      const fieldsByName = validateAccountSideFieldMap(initialMetas, dimensionField);
      const storeFieldId = fieldsByName.get("店铺")!.id;
      const aggregateLabel = records
        .map((record) => toText(record.fields[storeFieldId]).trim())
        .find(Boolean)
        ?? (await this.ensureConfig()).businessDisplayName;
      setRuntimeStoreAggregateLabel(aggregateLabel);
      this.fieldIds = new Map([...fieldsByName].map(([name, meta]) => [name, meta.id]));
      this.editableFieldNames = new Set(accountSideEditableFields);
      return {
        mode: accountMode,
        tableId: table.id,
        tableName,
        dimensionLabel: accountMode === "account-product" ? "产品" : "账号",
        aggregateLabel,
        aggregateMetrics: ACCOUNT_SIDE_AGGREGATE_METRICS,
        dimensionMetrics: ACCOUNT_SIDE_METRICS,
        showProductLinks: accountMode === "account-product",
        validateStoreFormulas: false,
        fieldsByName,
        advertisingAccounts: [],
        advertisingWarnings: [],
        records: normalizeAccountSideRecords(records, fieldsByName, dimensionField),
        loadedAt: new Date(),
        editable: tableEditable || baseEditable || manageable,
        canDeleteProducts: false,
        canManageAdvertising: false,
        isDemo: false,
      };
    }
    const metas = await this.ensureOrderAttributionFields(table, initialMetas, manageable);
    const archived = new Set(stored?.archivedAdvertisingSpendFieldIds ?? []);
    const advertisingAccounts = discoverAdvertisingAccounts(metas, archived);
    const fieldsByName = resolveFieldMap(metas);
    this.fieldIds = new Map([...fieldsByName].map(([name, meta]) => [name, meta.id]));
    this.editableFieldNames = new Set([
      ...staticEditableFields,
      ...advertisingAccounts.filter((account) => account.active).flatMap((account) => [account.spendFieldName, account.orderFieldName]),
    ]);
    return {
      mode: "store",
      tableId: table.id,
      tableName,
      dimensionLabel: "产品",
      aggregateLabel: SHOP_NAME,
      aggregateMetrics: SHOP_METRICS,
      dimensionMetrics: PRODUCT_METRICS,
      showProductLinks: true,
      validateStoreFormulas: true,
      fieldsByName,
      advertisingAccounts,
      advertisingWarnings: advertisingFieldWarnings(metas),
      records: applyFormulaFallbacks(normalizeRecords(records, fieldsByName)),
      loadedAt: new Date(),
      editable: tableEditable || baseEditable || manageable,
      canDeleteProducts: deletable,
      canManageAdvertising: manageable,
      isDemo: false,
    };
  }

  private async ensureOrderAttributionFields(table: ITable, initialMetas: IFieldMeta[], manageable: boolean): Promise<IFieldMeta[]> {
    const initialIssues = orderAttributionSchemaIssues(initialMetas);
    if (initialIssues.wrongType.length) {
      throw new Error(`以下渠道字段必须是数字类型：${initialIssues.wrongType.join("、")}`);
    }
    if (!initialIssues.missing.length) return initialMetas;
    if (!manageable) {
      throw new Error(`投产比缺少升级字段：${initialIssues.missing.join("、")}。请由 Base 管理员首次打开工作台完成无损升级`);
    }
    return this.queue.run("schema:order-attribution", async () => {
      const { FieldType, NumberFormatter } = await loadBitableSdk();
      let current = await table.getFieldMetaList();
      for (const fieldName of ORDER_ATTRIBUTION_NUMBER_FIELDS) {
        if (current.some((meta) => meta.name === fieldName)) continue;
        await table.addField({
          name: fieldName,
          type: FieldType.Number,
          property: { formatter: NumberFormatter.INTEGER },
        });
        current = await table.getFieldMetaList();
      }
      const verified = orderAttributionSchemaIssues(current);
      if (verified.missing.length || verified.wrongType.length) {
        throw new Error(`渠道字段升级后复读失败：${[...verified.missing, ...verified.wrongType].join("、")}`);
      }
      return current;
    });
  }

  async saveCell(request: CellWriteRequest): Promise<CellWriteResult> {
    return this.queue.run(request.recordId, async () => {
      const table = await this.getTargetTable();
      const fieldId = this.fieldIds.get(request.fieldName);
      if (!fieldId || !this.editableFieldNames.has(request.fieldName)) {
        return { state: "error", value: request.expectedValue, message: `字段“${request.fieldName}”不允许由插件写入` };
      }
      try {
        const latest = toNumber(await table.getCellValue(fieldId, request.recordId));
        if (!sameNumber(latest, request.expectedValue)) {
          return { state: "conflict", value: latest, message: "保存前发现其他用户已修改该格，已保留对方的新值" };
        }
        await table.setCellValue(fieldId, request.recordId, request.nextValue as IOpenCellValue);
        const verified = toNumber(await table.getCellValue(fieldId, request.recordId));
        if (!sameNumber(verified, request.nextValue)) {
          return { state: "error", value: verified, message: "飞书已响应写入，但复读结果不一致，请刷新后重试" };
        }
        return { state: "saved", value: verified, message: "已保存并复读验证" };
      } catch (error) {
        return { state: "error", value: request.expectedValue, message: `写入失败：${sanitizeError(error)}` };
      }
    });
  }

  async createDailyRecord(request: CreateDailyRecordRequest): Promise<{ recordId: string; created: boolean; message: string }> {
    const isStoreAggregate = request.productName.trim() === SHOP_NAME;
    const productName = isStoreAggregate ? SHOP_NAME : requireCanonicalProductName(request.productName);
    if (!productName) throw new Error("请输入正式商品名称");
    if (!isStoreAggregate && !/^\d{8,32}$/.test(request.tiktokProductId ?? "")) throw new Error("TikTok 商品ID应为8至32位数字");
    return this.queue.run(`create:${recordKey(productName, request.dateKey)}`, async () => {
      const table = await this.getTargetTable();
      const metas = await table.getFieldMetaList();
      const fieldsByName = validateFieldMap(metas);
      const productId = fieldsByName.get("商品")!.id;
      const dateId = fieldsByName.get("日期")!.id;
      const before = normalizeRecords(await readAllRecords(table), fieldsByName);
      const existing = indexRecords(before).byKey.get(recordKey(productName, request.dateKey));
      if (existing?.length) return { recordId: existing[0].recordId, created: false, message: "该商品与日期已存在，已定位到原记录" };

      if (!isStoreAggregate) {
        await this.saveMapping({ productName, tiktokProductId: request.tiktokProductId!, updatedAt: new Date().toISOString() });
      }
      const recordId = await table.addRecord({ fields: { [productId]: productName as IOpenCellValue, [dateId]: dateKeyToTimestamp(request.dateKey) } });
      const afterRaw = await readAllRecords(table);
      const after = normalizeRecords(afterRaw, fieldsByName);
      const duplicates = indexRecords(after).byKey.get(recordKey(productName, request.dateKey)) ?? [];
      if (duplicates.length === 1 && duplicates[0].recordId === recordId) {
        return {
          recordId,
          created: true,
          message: isStoreAggregate ? "店铺当日汇总行已创建，可以填写人工数据" : "商品日记录已创建并复读验证；数值仍为空白",
        };
      }
      if (duplicates.length > 1) {
        const ownRaw = afterRaw.find((record) => record.recordId === recordId);
        const protectedFieldIds = new Set([productId, dateId]);
        const hasBusinessValue = ownRaw && Object.entries(ownRaw.fields).some(([fieldId, value]) => !protectedFieldIds.has(fieldId) && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0));
        if (!hasBusinessValue) {
          await table.deleteRecord(recordId);
          const canonical = duplicates.find((record) => record.recordId !== recordId)!;
          return { recordId: canonical.recordId, created: false, message: "检测到并发新增，已撤回本插件刚创建的空白重复行并保留先到记录" };
        }
        throw new Error("检测到并发重复，但新行已出现业务值，未自动删除；请在“只看异常”中人工核对");
      }
      throw new Error("新增后未能复读到目标记录，未继续写入任何数值");
    });
  }

  async deleteProduct(productName: string): Promise<{ deletedCount: number; message: string }> {
    const exactName = productName.trim();
    if (!exactName || exactName === SHOP_NAME) throw new Error("店铺汇总不能作为商品删除");
    return this.queue.run(`delete:${exactName}`, async () => {
      const { bitable, OperationType, PermissionEntity } = await loadBitableSdk();
      const table = await this.getTargetTable();
      const [deletable, metas, before] = await Promise.all([
        bitable.base.getPermission({ entity: PermissionEntity.Record, param: { tableId: table.id }, type: OperationType.Deletable }),
        table.getFieldMetaList(),
        readAllRecords(table),
      ]);
      if (!deletable) throw new Error("你目前没有删除记录的权限，请让表格拥有者把本群权限设为“可编辑”");
      const fieldsByName = validateFieldMap(metas);
      const productFieldId = fieldsByName.get("商品")!.id;
      const targets = before.filter((record) => toText(record.fields[productFieldId]).trim() === exactName);
      if (!targets.length) return { deletedCount: 0, message: `商品“${exactName}”已无投产比日记录` };

      try {
        for (let start = 0; start < targets.length; start += 200) {
          await table.deleteRecords(targets.slice(start, start + 200).map((record) => record.recordId));
        }
      } catch (error) {
        const remaining = (await readAllRecords(table)).filter((record) => toText(record.fields[productFieldId]).trim() === exactName);
        const deletedCount = targets.length - remaining.length;
        throw new Error(`删除中断：已删除 ${deletedCount}/${targets.length} 条；${sanitizeError(error)}`);
      }

      const remaining = (await readAllRecords(table)).filter((record) => toText(record.fields[productFieldId]).trim() === exactName);
      if (remaining.length) throw new Error(`删除后复读仍有 ${remaining.length} 条记录，请刷新后重试`);
      return {
        deletedCount: targets.length,
        message: `已删除商品“${exactName}”的 ${targets.length} 条投产比日记录；未改动红人开发、合作或上线表`,
      };
    });
  }

  async getMappings(): Promise<ProductMapping[]> {
    try {
      const { bitable } = await loadBitableSdk();
      const stored = await bitable.bridge.getData<{ productMappings?: ProductMapping[] }>(CONFIG_KEY);
      return mergeProductMappings(DEFAULT_PRODUCT_MAPPINGS, stored?.productMappings ?? []);
    } catch {
      return structuredClone(DEFAULT_PRODUCT_MAPPINGS);
    }
  }

  async getConfig(): Promise<WorkbenchConfig> {
    return { ...await this.ensureConfig() };
  }

  async saveConfig(config: WorkbenchConfig): Promise<void> {
    const normalized = normalizeWorkbenchConfig(config);
    const { bitable, OperationType } = await loadBitableSdk();
    if (!await bitable.base.getBasePermission(OperationType.Manageable)) {
      throw new Error("只有多维表格管理员可以修改店铺配置");
    }
    const prior = await this.ensureConfig();
    const targetTable = await bitable.base.getTableByName(normalized.roiTableName);
    const metas = await targetTable.getFieldMetaList();
    const productFieldId = validateFieldMap(metas).get("商品")!.id;
    const records = await readAllRecords(targetTable);
    const priorRows = records.filter((record) => toText(record.fields[productFieldId]).trim() === prior.storeAggregateLabel);
    const conflictingRows = records.filter((record) => toText(record.fields[productFieldId]).trim() === normalized.storeAggregateLabel);
    if (prior.storeAggregateLabel !== normalized.storeAggregateLabel && conflictingRows.length > 0) {
      throw new Error(`新店铺汇总名“${normalized.storeAggregateLabel}”已被现有记录使用，未修改配置`);
    }
    const renameRows = async (label: string) => {
      for (let index = 0; index < priorRows.length; index += 200) {
        await targetTable.setRecords(priorRows.slice(index, index + 200).map((record) => ({
          recordId: record.recordId,
          fields: { [productFieldId]: label as IOpenCellValue },
        })));
      }
    };
    const formulaChanges = metas.flatMap((meta) => {
      const property = meta.property as { formula?: string } | null;
      const formula = property?.formula;
      if (!formula || !formula.includes(prior.storeAggregateLabel)) return [];
      return [{ fieldId: meta.id, formula }];
    });
    const setFormula = async (fieldId: string, formula: string) => {
      await targetTable.setField(fieldId, { property: { formula } } as never);
    };
    const rewrittenFormulas: typeof formulaChanges = [];
    let rowsRenamed = false;
    try {
      if (prior.storeAggregateLabel !== normalized.storeAggregateLabel) {
        for (const field of formulaChanges) {
          await setFormula(
            field.fieldId,
            field.formula.replaceAll(prior.storeAggregateLabel, normalized.storeAggregateLabel),
          );
          rewrittenFormulas.push(field);
        }
        rowsRenamed = true;
        await renameRows(normalized.storeAggregateLabel);
      }
      const stored = await bitable.bridge.getData<Record<string, unknown>>(CONFIG_KEY) ?? {};
      await bitable.bridge.setData(CONFIG_KEY, { ...stored, ...normalized });
      const verified = await bitable.bridge.getData<Partial<WorkbenchConfig>>(CONFIG_KEY);
      if (!verified || normalizeWorkbenchConfig(verified).storeAggregateLabel !== normalized.storeAggregateLabel) {
        throw new Error("店铺配置保存后复读失败");
      }
    } catch (error) {
      if (rowsRenamed) {
        await renameRows(prior.storeAggregateLabel);
      }
      if (rewrittenFormulas.length > 0) {
        for (const field of rewrittenFormulas) await setFormula(field.fieldId, field.formula);
      }
      throw error;
    }
    this.config = normalized;
    this.table = null;
    setRuntimeStoreAggregateLabel(normalized.storeAggregateLabel);
  }

  async addAdvertisingAccount(name: string): Promise<{ account: AdvertisingAccount; message: string }> {
    const accountName = normalizeAdvertisingAccountName(name);
    return this.queue.run("advertising:schema", async () => {
      await this.assertAdvertisingManageable();
      const { FieldType, NumberFormatter } = await loadBitableSdk();
      const table = await this.getTargetTable();
      const beforeMetas = await table.getFieldMetaList();
      const beforeAccounts = discoverAdvertisingAccounts(beforeMetas);
      assertAdvertisingNameAvailable(beforeAccounts, accountName);
      let spendFieldId = "";
      let orderFieldId = "";
      try {
        spendFieldId = await table.addField({
          name: `${accountName}广告花费`,
          type: FieldType.Number,
          property: { formatter: NumberFormatter.DIGITAL_ROUNDED_2 },
        });
        orderFieldId = await table.addField({
          name: `${accountName}广告出单量`,
          type: FieldType.Number,
          property: { formatter: NumberFormatter.INTEGER },
        });
        await this.rebuildAdvertisingTotals(table);
        const verified = discoverAdvertisingAccounts(await table.getFieldMetaList())
          .find((account) => account.spendFieldId === spendFieldId && account.orderFieldId === orderFieldId);
        if (!verified) throw new Error("新增字段后未能复读到完整的广告账户字段对");
        return { account: verified, message: `已新增广告账户“${accountName}”，花费与出单量两行均已建立` };
      } catch (error) {
        // 两个新字段在失败前没有任何业务值，允许精确撤回；不触碰其他字段。
        if (orderFieldId && await table.isFieldExist(orderFieldId)) await table.deleteField(orderFieldId).catch(() => false);
        if (spendFieldId && await table.isFieldExist(spendFieldId)) await table.deleteField(spendFieldId).catch(() => false);
        await this.rebuildAdvertisingTotals(table).catch(() => undefined);
        throw new Error(`新增广告账户失败，已撤回本次空字段：${sanitizeError(error)}`);
      }
    });
  }

  async renameAdvertisingAccount(accountId: string, name: string): Promise<{ account: AdvertisingAccount; message: string }> {
    const accountName = normalizeAdvertisingAccountName(name);
    return this.queue.run("advertising:schema", async () => {
      await this.assertAdvertisingManageable();
      const table = await this.getTargetTable();
      const beforeMetas = await table.getFieldMetaList();
      const accounts = discoverAdvertisingAccounts(beforeMetas);
      const target = accounts.find((account) => account.id === accountId);
      if (!target) throw new Error("广告账户已变化，请刷新后重试");
      if (target.name === accountName) return { account: target, message: "广告账户名称没有变化" };
      assertAdvertisingNameAvailable(accounts.filter((account) => account.id !== accountId), accountName);
      let spendRenamed = false;
      let orderRenamed = false;
      try {
        await table.setField(target.spendFieldId, { name: `${accountName}广告花费` });
        spendRenamed = true;
        await table.setField(target.orderFieldId, { name: `${accountName}广告出单量` });
        orderRenamed = true;
        await this.rebuildAdvertisingTotals(table);
        const verified = discoverAdvertisingAccounts(await table.getFieldMetaList())
          .find((account) => account.spendFieldId === target.spendFieldId && account.orderFieldId === target.orderFieldId);
        if (!verified || verified.name !== accountName) throw new Error("改名后复读结果不一致");
        return { account: verified, message: `已改名为“${accountName}”；历史每日数据保持在原字段 ID 中` };
      } catch (error) {
        if (orderRenamed) await table.setField(target.orderFieldId, { name: target.orderFieldName }).catch(() => undefined);
        if (spendRenamed) await table.setField(target.spendFieldId, { name: target.spendFieldName }).catch(() => undefined);
        await this.rebuildAdvertisingTotals(table).catch(() => undefined);
        throw new Error(`广告账户改名失败，已尝试恢复原名：${sanitizeError(error)}`);
      }
    });
  }

  async removeAdvertisingAccount(accountId: string): Promise<{ message: string }> {
    return this.queue.run("advertising:schema", async () => {
      await this.assertAdvertisingManageable();
      const table = await this.getTargetTable();
      const target = discoverAdvertisingAccounts(await table.getFieldMetaList()).find((account) => account.id === accountId);
      if (!target) throw new Error("广告账户已变化，请刷新后重试");
      const stored = await this.readStoredData();
      const archived = new Set(stored.archivedAdvertisingSpendFieldIds ?? []);
      archived.add(target.spendFieldId);
      await this.writeStoredData({ ...stored, archivedAdvertisingSpendFieldIds: [...archived] });
      return { message: `已从工作台移除“${target.name}”；原字段、历史数据和总计公式均完整保留，可随时恢复` };
    });
  }

  async restoreAdvertisingAccount(accountId: string): Promise<{ message: string }> {
    return this.queue.run("advertising:schema", async () => {
      await this.assertAdvertisingManageable();
      const table = await this.getTargetTable();
      const target = discoverAdvertisingAccounts(await table.getFieldMetaList()).find((account) => account.id === accountId);
      if (!target) throw new Error("广告账户字段已不存在，无法恢复");
      const stored = await this.readStoredData();
      const archived = new Set(stored.archivedAdvertisingSpendFieldIds ?? []);
      archived.delete(target.spendFieldId);
      await this.writeStoredData({ ...stored, archivedAdvertisingSpendFieldIds: [...archived] });
      return { message: `已恢复“${target.name}”到工作台` };
    });
  }

  async repairAdvertisingAccounts(): Promise<{ repairedCount: number; message: string }> {
    return this.queue.run("advertising:schema", async () => {
      await this.assertAdvertisingManageable();
      const { FieldType, NumberFormatter } = await loadBitableSdk();
      const table = await this.getTargetTable();
      const beforeMetas = await table.getFieldMetaList();
      const plan = advertisingFieldRepairPlan(beforeMetas);
      if (plan.length === 0) return { repairedCount: 0, message: "广告账户字段已经完整，无需修复" };
      const createdFieldIds: string[] = [];
      try {
        for (const item of plan) {
          const isSpend = item.missing === "spend";
          const fieldId = await table.addField({
            name: `${item.accountName}${isSpend ? "广告花费" : "广告出单量"}`,
            type: FieldType.Number,
            property: { formatter: isSpend ? NumberFormatter.DIGITAL_ROUNDED_2 : NumberFormatter.INTEGER },
          });
          createdFieldIds.push(fieldId);
        }
        await this.rebuildAdvertisingTotals(table);
        const remaining = advertisingFieldRepairPlan(await table.getFieldMetaList());
        if (remaining.length > 0) throw new Error(`仍有 ${remaining.length} 个账户字段未成对`);
        return { repairedCount: createdFieldIds.length, message: `已补齐 ${createdFieldIds.length} 个广告字段，并复读验证总计公式` };
      } catch (error) {
        for (const fieldId of createdFieldIds.reverse()) {
          if (await table.isFieldExist(fieldId)) await table.deleteField(fieldId).catch(() => false);
        }
        await this.rebuildAdvertisingTotals(table).catch(() => undefined);
        throw new Error(`广告字段修复失败，已撤回本次新增空字段：${sanitizeError(error)}`);
      }
    });
  }

  private async assertAdvertisingManageable(): Promise<void> {
    const { bitable, OperationType } = await loadBitableSdk();
    if (!await bitable.base.getBasePermission(OperationType.Manageable)) {
      throw new Error("广告账户会调整底层字段，只有多维表格管理员可以管理；日常录入仍对群成员开放");
    }
  }

  private async rebuildAdvertisingTotals(table: ITable): Promise<void> {
    const config = await this.ensureConfig();
    const metas = await table.getFieldMetaList();
    const fields = resolveFieldMap(metas);
    const accounts = discoverAdvertisingAccounts(metas);
    const productField = fields.get("商品");
    const totalSpend = fields.get("总广告花费");
    const totalOrders = fields.get("总广告出单量");
    if (!productField || !totalSpend || !totalOrders) throw new Error("缺少商品或广告总计字段，未更新公式");
    const escapeFormulaText = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const ref = (fieldId: string) => `bitable::$table[${table.id}].$field[${fieldId}]`;
    const sum = (fieldIds: string[]) => fieldIds.length ? `SUM(${fieldIds.map(ref).join(",")})` : "0";
    const prefix = `IF(${ref(productField.id)}!=\"${escapeFormulaText(config.storeAggregateLabel)}\",\"\",`;
    const spendFormula = `${prefix}${sum(accounts.map((account) => account.spendFieldId))})`;
    const orderFormula = `${prefix}${sum(accounts.map((account) => account.orderFieldId))})`;
    await table.setField(totalSpend.id, { property: { formula: spendFormula } } as never);
    await table.setField(totalOrders.id, { property: { formula: orderFormula } } as never);
    const [verifiedSpend, verifiedOrders] = await Promise.all([
      table.getFieldMetaById(totalSpend.id),
      table.getFieldMetaById(totalOrders.id),
    ]);
    const spendReadback = (verifiedSpend.property as { formula?: string } | null)?.formula;
    const ordersReadback = (verifiedOrders.property as { formula?: string } | null)?.formula;
    if (spendReadback !== spendFormula || ordersReadback !== orderFormula) {
      throw new Error("广告总计公式保存后复读不一致");
    }
  }

  private async readStoredData(): Promise<StoredWorkbenchData> {
    const { bitable } = await loadBitableSdk();
    return await bitable.bridge.getData<StoredWorkbenchData>(CONFIG_KEY) ?? {};
  }

  private async writeStoredData(next: StoredWorkbenchData): Promise<void> {
    const { bitable } = await loadBitableSdk();
    await bitable.bridge.setData(CONFIG_KEY, next);
    const verified = await bitable.bridge.getData<StoredWorkbenchData>(CONFIG_KEY);
    if (JSON.stringify(verified?.archivedAdvertisingSpendFieldIds ?? []) !== JSON.stringify(next.archivedAdvertisingSpendFieldIds ?? [])) {
      throw new Error("广告账户状态保存后复读失败");
    }
  }

  private async saveMapping(mapping: ProductMapping): Promise<void> {
    const mappings = await this.getMappings();
    const nameConflict = mappings.find((item) => item.productName === mapping.productName && item.tiktokProductId !== mapping.tiktokProductId);
    const idConflict = mappings.find((item) => item.tiktokProductId === mapping.tiktokProductId && item.productName !== mapping.productName);
    if (nameConflict || idConflict) throw new Error("商品名称或 TikTok 商品ID已映射到其他值，请先核对中央商品字典");
    const next = [...mappings.filter((item) => item.productName !== mapping.productName), mapping];
    const { bitable } = await loadBitableSdk();
    const stored = await bitable.bridge.getData<Record<string, unknown>>(CONFIG_KEY) ?? {};
    await bitable.bridge.setData(CONFIG_KEY, { ...stored, productMappings: next });
    const verified = await this.getMappings();
    if (!verified.some((item) => item.productName === mapping.productName && item.tiktokProductId === mapping.tiktokProductId)) {
      throw new Error("商品映射保存后复读失败，未创建每日记录");
    }
  }

  subscribe(onChange: () => void): () => void {
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(onChange, 700);
    };
    const cleanups: (() => void)[] = [];
    void this.getTargetTable().then((table) => {
      cleanups.push(table.onRecordAdd(schedule), table.onRecordDelete(schedule), table.onRecordModify(schedule));
    });
    return () => {
      window.clearTimeout(timer);
      cleanups.forEach((cleanup) => cleanup());
    };
  }

  async notify(message: string, type: "success" | "warning" | "error" = "success"): Promise<void> {
    const { bitable, ToastType } = await loadBitableSdk();
    const toastType = type === "success" ? ToastType.success : type === "warning" ? ToastType.warning : ToastType.error;
    try {
      await bitable.ui.showToast({ message, toastType });
    } catch {
      // 插件宿主不可用时，页面内状态仍会展示完整结果。
    }
  }
}

export class DemoWorkbenchDataSource implements WorkbenchDataSource {
  private records: NormalizedRecord[];
  private mappings: ProductMapping[] = mergeProductMappings(DEFAULT_PRODUCT_MAPPINGS, [{
    productName: "电动磨脚器",
    tiktokProductId: "1732482160735195549",
    updatedAt: "2026-08-13T00:00:00.000Z",
  }]);
  private config: WorkbenchConfig = { ...DEFAULT_CONFIG };
  private advertisingAccounts: AdvertisingAccount[] = [];

  constructor(records: NormalizedRecord[]) {
    this.records = records;
  }

  async load(): Promise<NormalizedDataset> {
    const metas = Object.entries(FIELD_IDS).map(([name, id]) => ({ id, name, type: 2, isPrimary: name === "检查", description: { content: null }, property: null })) as never;
    return { mode: "store", tableId: "demo-table", tableName: "投产比（本地视觉演示）", dimensionLabel: "产品", aggregateLabel: SHOP_NAME, aggregateMetrics: SHOP_METRICS, dimensionMetrics: PRODUCT_METRICS, showProductLinks: true, validateStoreFormulas: true, fieldsByName: resolveFieldMap(metas), advertisingAccounts: structuredClone(this.advertisingAccounts), advertisingWarnings: [], records: structuredClone(this.records), loadedAt: new Date(), editable: true, canDeleteProducts: true, canManageAdvertising: true, isDemo: true };
  }

  async saveCell(request: CellWriteRequest): Promise<CellWriteResult> {
    const record = this.records.find((item) => item.recordId === request.recordId);
    if (!record) return { state: "error", value: null, message: "演示记录不存在" };
    const latest = record.values[request.fieldName];
    const latestNumber = typeof latest === "number" ? latest : null;
    if (!sameNumber(latestNumber, request.expectedValue)) return { state: "conflict", value: latestNumber, message: "演示并发冲突" };
    await new Promise((resolve) => globalThis.setTimeout(resolve, 220));
    record.values[request.fieldName] = request.nextValue;
    return { state: "saved", value: request.nextValue, message: "本地演示保存成功（未写飞书）" };
  }

  async createDailyRecord(request: CreateDailyRecordRequest): Promise<{ recordId: string; created: boolean; message: string }> {
    const productName = requireCanonicalProductName(request.productName);
    const existing = this.records.find((record) => record.product === productName && record.dateKey === request.dateKey);
    if (existing) return { recordId: existing.recordId, created: false, message: "演示记录已存在" };
    const recordId = `demo-${crypto.randomUUID()}`;
    this.records.push({ recordId, product: productName, dateKey: request.dateKey, timestamp: dateKeyToTimestamp(request.dateKey), status: "待补数据", values: {} });
    this.mappings.push({ productName, tiktokProductId: request.tiktokProductId!, updatedAt: new Date().toISOString() });
    return { recordId, created: true, message: "已创建本地演示记录（未写飞书）" };
  }

  async deleteProduct(productName: string): Promise<{ deletedCount: number; message: string }> {
    if (productName === SHOP_NAME) throw new Error("店铺汇总不能作为商品删除");
    const before = this.records.length;
    this.records = this.records.filter((record) => record.product !== productName);
    const deletedCount = before - this.records.length;
    return { deletedCount, message: `已删除 ${deletedCount} 条本地演示记录（未写飞书）` };
  }

  async getMappings(): Promise<ProductMapping[]> { return this.mappings; }
  async getConfig(): Promise<WorkbenchConfig> { return { ...this.config }; }
  async saveConfig(config: WorkbenchConfig): Promise<void> {
    this.config = normalizeWorkbenchConfig(config);
    setRuntimeStoreAggregateLabel(this.config.storeAggregateLabel);
  }
  async addAdvertisingAccount(name: string): Promise<{ account: AdvertisingAccount; message: string }> {
    const accountName = normalizeAdvertisingAccountName(name);
    assertAdvertisingNameAvailable(this.advertisingAccounts, accountName);
    const key = crypto.randomUUID();
    const account: AdvertisingAccount = { id: key, name: accountName, spendFieldId: `${key}-spend`, spendFieldName: `${accountName}广告花费`, orderFieldId: `${key}-orders`, orderFieldName: `${accountName}广告出单量`, active: true };
    this.advertisingAccounts.push(account);
    return { account, message: `已新增演示广告账户“${accountName}”` };
  }
  async renameAdvertisingAccount(accountId: string, name: string): Promise<{ account: AdvertisingAccount; message: string }> {
    const account = this.advertisingAccounts.find((item) => item.id === accountId);
    if (!account) throw new Error("演示广告账户不存在");
    const accountName = normalizeAdvertisingAccountName(name);
    assertAdvertisingNameAvailable(this.advertisingAccounts.filter((item) => item.id !== accountId), accountName);
    Object.assign(account, { name: accountName, spendFieldName: `${accountName}广告花费`, orderFieldName: `${accountName}广告出单量` });
    return { account, message: `已改名为“${accountName}”` };
  }
  async removeAdvertisingAccount(accountId: string): Promise<{ message: string }> {
    const account = this.advertisingAccounts.find((item) => item.id === accountId);
    if (!account) throw new Error("演示广告账户不存在");
    account.active = false;
    return { message: `已移除“${account.name}”并保留演示数据` };
  }
  async restoreAdvertisingAccount(accountId: string): Promise<{ message: string }> {
    const account = this.advertisingAccounts.find((item) => item.id === accountId);
    if (!account) throw new Error("演示广告账户不存在");
    account.active = true;
    return { message: `已恢复“${account.name}”` };
  }
  async repairAdvertisingAccounts(): Promise<{ repairedCount: number; message: string }> {
    return { repairedCount: 0, message: "演示广告账户字段已经完整" };
  }
  subscribe(): () => void { return () => undefined; }
  async notify(): Promise<void> { return undefined; }
}

function normalizeWorkbenchConfig(value: Partial<WorkbenchConfig>): WorkbenchConfig {
  const clean = (input: unknown, fallback: string) => String(input ?? "").trim() || fallback;
  return {
    businessDisplayName: clean(value.businessDisplayName, DEFAULT_CONFIG.businessDisplayName),
    storeAggregateLabel: clean(value.storeAggregateLabel, DEFAULT_CONFIG.storeAggregateLabel),
    roiTableName: clean(value.roiTableName, DEFAULT_CONFIG.roiTableName),
  };
}

function validateAccountSideFieldMap(
  metas: IFieldMeta[],
  dimensionField: "商品" | "账号",
): Map<string, IFieldMeta> {
  const duplicateNames = [...new Set(metas.map((meta) => meta.name).filter((name, index, names) => names.indexOf(name) !== index))];
  if (duplicateNames.length) throw new Error(`${dimensionField}投产比存在重复字段名：${duplicateNames.join("、")}`);
  const byName = new Map(metas.map((meta) => [meta.name, meta]));
  const required = ["检查", "店铺", dimensionField, "日期", ...ACCOUNT_SIDE_AGGREGATE_METRICS.map((metric) => metric.fieldName), "数据状态"];
  const missing = required.filter((name) => !byName.has(name));
  if (missing.length) throw new Error(`${dimensionField}投产比缺少必需字段：${missing.join("、")}`);
  const wrongTypes = [
    ...(byName.get("日期")?.type === 5 ? [] : ["日期应为日期类型"]),
    ...ACCOUNT_SIDE_AGGREGATE_METRICS.flatMap((metric) => isAccountSideNumericFieldType(byName.get(metric.fieldName)?.type ?? 0)
      ? []
      : [`${metric.fieldName}应为数字类型`]),
  ];
  if (wrongTypes.length) throw new Error(`${dimensionField}投产比字段类型错误：${wrongTypes.join("、")}`);
  return byName;
}

function normalizeAdvertisingAccountName(value: string): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!normalized) throw new Error("广告账户名称不能为空");
  if (normalized.length > 70) throw new Error("广告账户名称请控制在70个字符以内");
  if (normalized === "总" || /广告(?:花费|出单量)$/.test(normalized)) {
    throw new Error("只填写广告账户名称，系统会自动添加“广告花费/广告出单量”后缀");
  }
  return normalized;
}

function assertAdvertisingNameAvailable(accounts: AdvertisingAccount[], name: string): void {
  const normalized = name.toLocaleLowerCase("zh-CN");
  if (accounts.some((account) => account.name.toLocaleLowerCase("zh-CN") === normalized)) {
    throw new Error(`广告账户“${name}”已存在；如已移除，请直接恢复`);
  }
}
