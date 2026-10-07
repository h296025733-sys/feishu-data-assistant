import { randomUUID } from "node:crypto";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { AppEnv } from "../config/env.js";
import { assertFeishuResponse } from "./client.js";
import {
  ROI_ALL_METRICS,
  ROI_RECORD_ROLES,
  type RoiFormulaInput,
} from "./roi-pivot-plan.js";

export const ROI_TABLE_NAME = "投产比";
export const PIVOT_COLUMN_FIELD = "透视列";
export const PIVOT_DATE_FIELD = "透视日期";
export const PIVOT_SECTION_FIELD = "透视分区";
export const ROI_RECORD_ROLE_FIELD = "记录角色";
export const ROI_MAIN_VIEW_NAME = "表格";

const ROI_PERIOD_FIELD = "周期类型";
const ROI_METRIC_DISPLAY_FIELD = "指标";
const ROI_METRIC_CODE_FIELD = "指标代码";
const COOPERATION_TABLE_PATTERN = /^Tech-wave红人合作表$/i;
const ONLINE_TABLE_PATTERN = /^Tech-wave红人上线表(?:[_\s-]?\d+)?$/i;
const ROI_MAIN_VIEW_HIDDEN_FIELDS = [
  ROI_PERIOD_FIELD,
  ROI_METRIC_CODE_FIELD,
  "月份",
  "周",
  "星期",
  PIVOT_COLUMN_FIELD,
  PIVOT_DATE_FIELD,
  PIVOT_SECTION_FIELD,
  ROI_RECORD_ROLE_FIELD,
] as const;

const BATCH_SIZE = 500;
const NEW_OPTION_COLORS = [49, 47, 46, 45, 44, 50] as const;
const VIEW_WRITE_RETRY_DELAYS_MS = [150, 350, 700] as const;

export class RoiPivotClientTokens {
  private readonly tokens = new Map<string, string>();

  public get(scope: string, value: unknown): string {
    const key = `${scope}\u0000${stableSerialize(value)}`;
    const existing = this.tokens.get(key);
    if (existing) return existing;
    const created = randomUUID();
    this.tokens.set(key, created);
    return created;
  }

  public clear(): void {
    this.tokens.clear();
  }
}

export interface RoiPivotRecord { recordId: string; fields: Record<string, unknown>; lastModifiedTime: number }
export interface RoiPivotUpdate { recordId: string; fields: Record<string, unknown> }
export interface RoiPivotCreate { fields: Record<string, unknown> }
export interface RoiPivotInitialization {
  tableId: string; pivotColumnFieldId: string; pivotDateFieldId: string; records: RoiPivotRecord[];
}
interface SelectOption { id?: string; name?: string; color?: number }
interface FieldState {
  field_id?: string; field_name?: string; type?: number; ui_type?: string; is_primary?: boolean;
  property?: { options?: SelectOption[]; [key: string]: unknown };
}
interface ViewFilterCondition {
  field_id?: string;
  operator?: string;
  value?: string | null;
}
interface ViewFilterInfo {
  conjunction?: "or" | "and";
  conditions?: ViewFilterCondition[];
}
interface ViewState {
  view_id?: string;
  view_name?: string;
  view_type?: string;
  property?: {
    hidden_fields?: string[];
    filter_info?: ViewFilterInfo | null;
  };
}
interface SourceTableState {
  tableId: string;
  name: string;
  kind: "cooperation" | "online";
}

export class RoiPivotApi {
  private roiTableId: string | null = null;
  private pivotColumnFieldId: string | null = null;
  private pivotDateFieldId: string | null = null;
  private sourceTables: SourceTableState[] = [];
  private readonly clientTokens = new RoiPivotClientTokens();

  public constructor(private readonly env: AppEnv, private readonly client: Client) {}

  public get tableId(): string {
    if (!this.roiTableId) throw new Error("RoiPivotApi 尚未 initialize");
    return this.roiTableId;
  }

  public async initialize(initialOptions: readonly string[] = []): Promise<RoiPivotInitialization> {
    const tables = await this.listTables();
    this.roiTableId = discoverUniqueTable(tables, ROI_TABLE_NAME);
    this.sourceTables = discoverSourceTables(tables);
    let fields = await this.ensurePivotFields();
    this.pivotColumnFieldId = requireFieldId(fields, PIVOT_COLUMN_FIELD);
    this.pivotDateFieldId = requireFieldId(fields, PIVOT_DATE_FIELD);
    await this.ensureOrderedSelectOptions(
      PIVOT_SECTION_FIELD,
      ["汇总", "明细"],
      "roi-pivot-section-options",
    );
    await this.ensureOrderedSelectOptions(
      ROI_RECORD_ROLE_FIELD,
      Object.values(ROI_RECORD_ROLES),
      "roi-record-role-options",
    );
    await this.ensureMetricOptions(ROI_ALL_METRICS);
    await this.ensureFixedMetricDisplay();
    fields = await this.listFields();
    if (initialOptions.length > 0) await this.ensurePivotOptions(initialOptions);
    await this.configureMainGridView(fields);
    return {
      tableId: this.tableId, pivotColumnFieldId: this.pivotColumnFieldId,
      pivotDateFieldId: this.pivotDateFieldId, records: await this.readRecords(),
    };
  }

  public completeMutationCycle(): void {
    this.clientTokens.clear();
  }

  public async readRecords(): Promise<RoiPivotRecord[]> {
    const records: RoiPivotRecord[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.client.bitable.appTableRecord.list({
        path: { app_token: this.appToken(), table_id: this.tableId },
        params: { page_size: BATCH_SIZE, page_token: pageToken },
      });
      assertFeishuResponse(response, "分页读取投产比记录");
      for (const item of response.data?.items ?? []) {
        const recordId = String(item.record_id ?? "");
        if (!recordId) continue;
        records.push({ recordId, fields: item.fields ?? {}, lastModifiedTime: Number(item.last_modified_time ?? 0) });
      }
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    return records;
  }

  public isRelevantTableId(tableId: string): boolean {
    return tableId === this.tableId
      || this.sourceTables.some((table) => table.tableId === tableId);
  }

  public async readFormulaInputs(): Promise<RoiFormulaInput[]> {
    const inputs: RoiFormulaInput[] = [];
    for (const table of this.sourceTables) {
      let pageToken: string | undefined;
      do {
        const response = await this.client.bitable.appTableRecord.list({
          path: { app_token: this.appToken(), table_id: table.tableId },
          params: { page_size: BATCH_SIZE, page_token: pageToken },
        });
        assertFeishuResponse(response, `读取投产比公式来源（${table.name}）`);
        for (const item of response.data?.items ?? []) {
          const fields = item.fields ?? {};
          const date = table.kind === "cooperation"
            ? fields["合作时间"]
            : fields["实上线日期(Ct)"] ?? fields["实上线日期"];
          const products = multiTexts(
            table.kind === "cooperation" ? fields["寄样产品"] : fields["挂车产品"],
          );
          if (!date) continue;
          for (const product of products) {
            inputs.push({
              product,
              metric: table.kind === "cooperation" ? "合作量" : "上线量",
              date,
              value: 1,
            });
          }
        }
        pageToken = response.data?.has_more ? response.data.page_token : undefined;
      } while (pageToken);
    }
    return inputs;
  }

  public async ensurePivotOptions(names: readonly string[]): Promise<void> {
    await this.ensureOrderedSelectOptions(
      PIVOT_COLUMN_FIELD,
      names,
      "roi-pivot-options",
      this.pivotColumnFieldId,
    );
  }

  public async ensureMetricOptions(names: readonly string[]): Promise<void> {
    await this.ensureOrderedSelectOptions(
      ROI_METRIC_CODE_FIELD,
      names,
      "roi-metric-options",
    );
  }

  private async ensureOrderedSelectOptions(
    fieldName: string,
    names: readonly string[],
    tokenScope: string,
    knownFieldId: string | null = null,
  ): Promise<void> {
    const requested = uniqueNames(names);
    const fields = await this.listFields();
    const field = fields.find((item) => item.field_id === knownFieldId)
      ?? fields.find((item) => item.field_name === fieldName);
    if (!field?.field_id || field.type !== 3) {
      throw new Error(`字段“${fieldName}”不存在或不是单选字段`);
    }
    if (fieldName === PIVOT_COLUMN_FIELD) this.pivotColumnFieldId = field.field_id;
    const existing = field.property?.options ?? [];
    const byName = new Map(existing.map((option) => [String(option.name ?? ""), option]));
    const requestedSet = new Set(requested);
    const order = [
      ...requested,
      ...existing.map((option) => String(option.name ?? "").trim())
        .filter((name) => name && !requestedSet.has(name)),
    ];
    const options = order.map((name, index) => {
      const current = byName.get(name);
      return current
        ? { ...(current.id ? { id: current.id } : {}), name, color: current.color ?? colorAt(index) }
        : { name, color: colorAt(index) };
    });
    if (sameOptionOrder(existing, options)) return;
    const response = await (this.client.bitable.appTableField as any).update({
      path: { app_token: this.appToken(), table_id: this.tableId, field_id: field.field_id },
      params: { client_token: this.clientTokens.get(tokenScope, options) },
      data: { field_name: fieldName, type: 3, ui_type: "SingleSelect", property: { options } },
    });
    assertFeishuResponse(response, `更新“${fieldName}”选项顺序`);
    const verified = (await this.listFields()).find((item) => item.field_id === field.field_id);
    if (!verified || !sameOptionOrder(verified.property?.options ?? [], options, true)) {
      throw new Error(`“${fieldName}”选项写后重读校验失败`);
    }
  }

  public async batchUpdate(updates: readonly RoiPivotUpdate[]): Promise<RoiPivotRecord[]> {
    assertUniqueRecordIds(updates.map((item) => item.recordId));
    for (let offset = 0; offset < updates.length; offset += BATCH_SIZE) {
      const batch = updates.slice(offset, offset + BATCH_SIZE);
      const response = await (this.client.bitable.appTableRecord as any).batchUpdate({
        path: { app_token: this.appToken(), table_id: this.tableId },
        params: { client_token: this.clientTokens.get("roi-pivot-update", [offset, batch]) },
        data: { records: batch.map((item) => ({ record_id: item.recordId, fields: item.fields })) },
      });
      assertFeishuResponse(response, `批量更新投产比记录 ${offset + 1}-${offset + batch.length}`);
    }
    return this.readRecords();
  }

  public async batchCreate(creates: readonly RoiPivotCreate[]): Promise<RoiPivotRecord[]> {
    for (let offset = 0; offset < creates.length; offset += BATCH_SIZE) {
      const batch = creates.slice(offset, offset + BATCH_SIZE);
      const response = await (this.client.bitable.appTableRecord as any).batchCreate({
        path: { app_token: this.appToken(), table_id: this.tableId },
        params: { client_token: this.clientTokens.get("roi-pivot-create", [offset, batch]) },
        data: { records: batch.map((item) => ({ fields: item.fields })) },
      });
      assertFeishuResponse(response, `批量创建投产比记录 ${offset + 1}-${offset + batch.length}`);
    }
    return this.readRecords();
  }

  public async batchDelete(ids: readonly string[]): Promise<RoiPivotRecord[]> {
    const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    for (let offset = 0; offset < uniqueIds.length; offset += BATCH_SIZE) {
      const batch = uniqueIds.slice(offset, offset + BATCH_SIZE);
      const response = await (this.client.bitable.appTableRecord as any).batchDelete({
        path: { app_token: this.appToken(), table_id: this.tableId },
        params: { client_token: this.clientTokens.get("roi-pivot-delete", [offset, batch]) },
        data: { records: batch },
      });
      assertFeishuResponse(response, `批量删除投产比记录 ${offset + 1}-${offset + batch.length}`);
    }
    return this.readRecords();
  }

  private async listTables(): Promise<Array<{ table_id?: string; name?: string }>> {
    const tables: Array<{ table_id?: string; name?: string }> = [];
    let pageToken: string | undefined;
    do {
      const response = await this.client.bitable.appTable.list({
        path: { app_token: this.appToken() },
        params: { page_size: 100, page_token: pageToken },
      });
      assertFeishuResponse(response, "发现投产比及公式来源数据表");
      tables.push(...(response.data?.items ?? []));
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    return tables;
  }

  private async ensurePivotFields(): Promise<FieldState[]> {
    let fields = await this.listFields();
    const definitions = [
      {
        name: ROI_METRIC_CODE_FIELD,
        type: 3,
        uiType: "SingleSelect",
        property: { options: [] },
      },
      { name: PIVOT_COLUMN_FIELD, type: 3, uiType: "SingleSelect", property: { options: [] } },
      { name: PIVOT_DATE_FIELD, type: 5, uiType: "DateTime", property: { date_formatter: "yyyy/MM/dd", auto_fill: false } },
      {
        name: PIVOT_SECTION_FIELD,
        type: 3,
        uiType: "SingleSelect",
        property: {
          options: [
            { name: "汇总", color: 46 },
            { name: "明细", color: 44 },
          ],
        },
      },
      {
        name: ROI_RECORD_ROLE_FIELD,
        type: 3,
        uiType: "SingleSelect",
        property: {
          options: Object.values(ROI_RECORD_ROLES).map((name, index) => ({
            name,
            color: colorAt(index),
          })),
        },
      },
    ] as const;
    for (const definition of definitions) {
      const field = fields.find((item) => item.field_name === definition.name);
      if (!field) {
        const response = await (this.client.bitable.appTableField as any).create({
          path: { app_token: this.appToken(), table_id: this.tableId },
          data: { field_name: definition.name, type: definition.type, ui_type: definition.uiType, property: definition.property },
        });
        assertFeishuResponse(response, `创建字段“${definition.name}”`);
      } else if (field.type !== definition.type || field.ui_type !== definition.uiType) {
        if (!field.field_id) throw new Error(`字段“${definition.name}”缺少 field_id`);
        const response = await (this.client.bitable.appTableField as any).update({
          path: { app_token: this.appToken(), table_id: this.tableId, field_id: field.field_id },
          data: { field_name: definition.name, type: definition.type, ui_type: definition.uiType, property: definition.property },
        });
        assertFeishuResponse(response, `修正字段“${definition.name}”类型`);
      }
      fields = await this.listFields();
    }
    return fields;
  }

  private async ensureFixedMetricDisplay(): Promise<void> {
    let fields = await this.listFields();
    const codeField = fields.find((field) => field.field_name === ROI_METRIC_CODE_FIELD);
    const displayField = fields.find((field) => field.field_name === ROI_METRIC_DISPLAY_FIELD);
    if (!codeField?.field_id || codeField.type !== 3) {
      throw new Error(`字段“${ROI_METRIC_CODE_FIELD}”不存在或不是单选字段`);
    }
    if (!displayField?.field_id) {
      throw new Error(`字段“${ROI_METRIC_DISPLAY_FIELD}”不存在`);
    }

    if (displayField.type !== 20 || displayField.ui_type !== "Formula") {
      const records = await this.readRecords();
      const copies = records.flatMap((record) => {
        const display = cellText(record.fields[ROI_METRIC_DISPLAY_FIELD]);
        const code = cellText(record.fields[ROI_METRIC_CODE_FIELD]);
        return display && !code
          ? [{ recordId: record.recordId, fields: { [ROI_METRIC_CODE_FIELD]: display } }]
          : [];
      });
      if (copies.length > 0) await this.batchUpdate(copies);
      const verified = await this.readRecords();
      const mismatched = verified.filter((record) => (
        cellText(record.fields[ROI_METRIC_DISPLAY_FIELD])
        && cellText(record.fields[ROI_METRIC_CODE_FIELD])
          !== cellText(record.fields[ROI_METRIC_DISPLAY_FIELD])
      ));
      if (mismatched.length > 0) {
        throw new Error(
          `迁移“${ROI_METRIC_CODE_FIELD}”后仍有 ${mismatched.length} 条不一致，已停止字段转换`,
        );
      }
    }

    const formulaExpression = fixedMetricFormulaExpression(this.tableId, codeField.field_id);
    fields = await this.listFields();
    const current = fields.find((field) => field.field_id === displayField.field_id);
    if (
      current?.type !== 20
      || current.ui_type !== "Formula"
      || current.property?.formula_expression !== formulaExpression
    ) {
      const response = await (this.client.bitable.appTableField as any).update({
        path: {
          app_token: this.appToken(),
          table_id: this.tableId,
          field_id: displayField.field_id,
        },
        params: {
          client_token: this.clientTokens.get("roi-fixed-metric-display", formulaExpression),
        },
        data: {
          field_name: ROI_METRIC_DISPLAY_FIELD,
          type: 20,
          ui_type: "Formula",
          property: {
            formatter: "",
            formula_expression: formulaExpression,
          },
        },
      });
      assertFeishuResponse(response, `将“${ROI_METRIC_DISPLAY_FIELD}”转换为只读固定显示`);
    }
    const verifiedField = (await this.listFields())
      .find((field) => field.field_id === displayField.field_id);
    if (
      verifiedField?.type !== 20
      || verifiedField.ui_type !== "Formula"
      || verifiedField.property?.formula_expression !== formulaExpression
    ) {
      throw new Error(`“${ROI_METRIC_DISPLAY_FIELD}”只读公式写后校验失败`);
    }
  }

  private async listFields(): Promise<FieldState[]> {
    const fields: FieldState[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.client.bitable.appTableField.list({
        path: { app_token: this.appToken(), table_id: this.tableId },
        params: { page_size: 100, page_token: pageToken },
      });
      assertFeishuResponse(response, "读取投产比字段");
      fields.push(...(response.data?.items ?? []));
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    return fields;
  }

  private async configureMainGridView(fields: readonly FieldState[]): Promise<void> {
    const hiddenIds = ROI_MAIN_VIEW_HIDDEN_FIELDS.map((name) => requireFieldId(fields, name))
      .filter((id) => !fields.find((field) => field.field_id === id)?.is_primary);
    const roleField = fields.find((field) => field.field_name === ROI_RECORD_ROLE_FIELD);
    if (!roleField?.field_id || roleField.type !== 3) {
      throw new Error(`字段“${ROI_RECORD_ROLE_FIELD}”不存在或不是单选字段`);
    }
    const optionIds = Object.fromEntries(
      (roleField.property?.options ?? [])
        .filter((option): option is SelectOption & { id: string; name: string } => (
          Boolean(option.id) && Boolean(option.name)
        ))
        .map((option) => [option.name, option.id]),
    );
    const templateRole = ROI_RECORD_ROLES.inputTemplate;
    if (!optionIds[templateRole]) {
      throw new Error(`字段“${ROI_RECORD_ROLE_FIELD}”缺少选项“${templateRole}”`);
    }
    const desiredFilter: ViewFilterInfo = {
      conjunction: "or",
      conditions: [
        { field_id: roleField.field_id, operator: "isEmpty" },
        {
          field_id: roleField.field_id,
          operator: "is",
          value: JSON.stringify([optionIds[templateRole]]),
        },
      ],
    };
    const views: ViewState[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.client.bitable.appTableView.list({
        path: { app_token: this.appToken(), table_id: this.tableId },
        params: { page_size: 100, page_token: pageToken },
      });
      assertFeishuResponse(response, "读取投产比视图");
      views.push(...((response.data?.items ?? []) as ViewState[]));
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);

    const selected = selectMainGridView(views);
    if (!selected.view_id) throw new Error("投产比主表格视图缺少 view_id");
    const current = await this.readView(selected.view_id);
    const hidden = [...new Set([...(current.property?.hidden_fields ?? []), ...hiddenIds])];
    if (
      sameStringSet(hidden, current.property?.hidden_fields ?? [])
      && sameViewFilter(current.property?.filter_info, desiredFilter)
    ) {
      return;
    }

    await this.patchViewWithRetry(selected.view_id, selected.view_name ?? ROI_MAIN_VIEW_NAME, {
      hidden_fields: hidden,
      filter_info: desiredFilter,
    });
    const verified = await this.readView(selected.view_id);
    if (
      !sameStringSet(hidden, verified.property?.hidden_fields ?? [])
      || !sameViewFilter(verified.property?.filter_info, desiredFilter)
    ) {
      throw new Error("投产比主表格视图写后重读校验失败");
    }
  }

  private async readView(viewId: string): Promise<ViewState> {
    const response = await (this.client.bitable.appTableView as any).get({
      path: { app_token: this.appToken(), table_id: this.tableId, view_id: viewId },
    });
    assertFeishuResponse(response, "读取投产比主表格视图");
    const view = response.data?.view as ViewState | undefined;
    if (!view) throw new Error("读取投产比主表格视图后没有返回 view");
    return view;
  }

  private async patchViewWithRetry(
    viewId: string,
    viewName: string,
    property: { hidden_fields: string[]; filter_info: ViewFilterInfo },
  ): Promise<void> {
    for (let attempt = 0; attempt <= VIEW_WRITE_RETRY_DELAYS_MS.length; attempt += 1) {
      const response = await this.client.bitable.appTableView.patch({
        path: { app_token: this.appToken(), table_id: this.tableId, view_id: viewId },
        data: { view_name: viewName, property: property as any },
      });
      if (response.code !== 1254291) {
        assertFeishuResponse(response, `更新投产比主表格视图“${viewName}”`);
        return;
      }
      const delay = VIEW_WRITE_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        assertFeishuResponse(response, `更新投产比主表格视图“${viewName}”`);
      }
      await sleep(delay);
    }
  }

  private appToken(): string {
    if (!this.env.FEISHU_BITABLE_APP_TOKEN) throw new Error("缺少 FEISHU_BITABLE_APP_TOKEN");
    return this.env.FEISHU_BITABLE_APP_TOKEN;
  }
}

export function selectMainGridView(views: readonly ViewState[]): ViewState {
  const grids = views.filter((view) => view.view_type === "grid");
  const named = grids.filter((view) => view.view_name === ROI_MAIN_VIEW_NAME);
  const candidates = named.length > 0 ? named : grids;
  if (candidates.length !== 1) {
    throw new Error(
      `应恰好发现一个投产比主表格视图，实际 ${candidates.length} 个`,
    );
  }
  return candidates[0];
}

export function sameViewFilter(
  actual: ViewFilterInfo | null | undefined,
  expected: ViewFilterInfo,
): boolean {
  if (!actual || actual.conjunction !== expected.conjunction) return false;
  const actualFilter = actual;
  const normalize = (conditions: readonly ViewFilterCondition[] | undefined): string[] => (
    (conditions ?? []).map((condition) => [
      condition.field_id ?? "",
      condition.operator ?? "",
      condition.value ?? "",
    ].join("\u0000")).sort()
  );
  return JSON.stringify(normalize(actualFilter.conditions))
    === JSON.stringify(normalize(expected.conditions));
}

export function fixedMetricFormulaExpression(tableId: string, codeFieldId: string): string {
  return `bitable::$table[${tableId}].$field[${codeFieldId}]`;
}

function discoverUniqueTable(
  tables: ReadonlyArray<{ table_id?: string; name?: string }>,
  name: string,
): string {
  const matches = tables.filter((table) => table.name === name && table.table_id);
  if (matches.length !== 1) {
    throw new Error(`应恰好发现一张“${name}”表，实际 ${matches.length} 张`);
  }
  return String(matches[0]?.table_id ?? "");
}

function discoverSourceTables(
  tables: ReadonlyArray<{ table_id?: string; name?: string }>,
): SourceTableState[] {
  const sources = tables.flatMap((table): SourceTableState[] => {
    const tableId = String(table.table_id ?? "");
    const name = String(table.name ?? "");
    if (!tableId) return [];
    if (COOPERATION_TABLE_PATTERN.test(name)) {
      return [{ tableId, name, kind: "cooperation" }];
    }
    if (ONLINE_TABLE_PATTERN.test(name)) {
      return [{ tableId, name, kind: "online" }];
    }
    return [];
  });
  if (!sources.some((table) => table.kind === "cooperation")) {
    throw new Error("未找到 Tech-wave红人合作表，无法计算商品合作量");
  }
  if (!sources.some((table) => table.kind === "online")) {
    throw new Error("未找到 Tech-wave红人上线表，无法计算商品上线量");
  }
  return sources.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

function requireFieldId(fields: readonly FieldState[], name: string): string {
  const id = fields.find((field) => field.field_name === name)?.field_id;
  if (!id) throw new Error(`字段“${name}”创建后仍未找到`);
  return id;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value) => right.includes(value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueNames(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

function colorAt(index: number): number {
  return NEW_OPTION_COLORS[index % NEW_OPTION_COLORS.length];
}

function sameOptionOrder(
  actual: readonly SelectOption[],
  expected: readonly SelectOption[],
  verifyIds = false,
): boolean {
  if (actual.length !== expected.length) return false;
  return expected.every((option, index) => {
    const current = actual[index];
    if (!current || current.name !== option.name || current.color !== option.color) return false;
    return !verifyIds || !option.id || current.id === option.id;
  });
}

function assertUniqueRecordIds(ids: readonly string[]): void {
  if (ids.some((id) => !id.trim())) throw new Error("批量更新包含空 recordId");
  if (new Set(ids).size !== ids.length) throw new Error("同一批更新包含重复 recordId");
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return "\"__undefined__\"";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
    .join(",")}}`;
}

function cellText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(cellText).join("").trim();
  if (value && typeof value === "object") {
    if ("text" in value) return String((value as { text?: unknown }).text ?? "").trim();
    if ("name" in value) return String((value as { name?: unknown }).name ?? "").trim();
  }
  return value === null || value === undefined ? "" : String(value).trim();
}

function multiTexts(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((item) => multiTexts(item)).filter(Boolean))];
  }
  const text = cellText(value);
  return text ? [text] : [];
}
