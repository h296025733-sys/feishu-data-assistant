import { createHash } from "node:crypto";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { ResolvedTenant } from "../config/tenant-registry.js";
import { assertFeishuResponse, withFeishuBitableQuotaCircuit } from "../feishu/client.js";
import { formatTime, type RiskState } from "./model.js";
import { RISK_LAYOUTS, riskViewProperty, sameRiskViewProperty } from "./layout.js";

export const RISK_TABLE_NAME = "违规与异常提醒";
export const AUTO_FIELDS = ["事项", "类型", "级别", "首次发现", "本次检查", "商品/订单编号", "内容", "建议处理", "监测状态", "数据截至", "核对键"];
const FIELD_NAMES = [...AUTO_FIELDS.slice(0, 9), "人工处理", "备注", ...AUTO_FIELDS.slice(9)];
type Row = { record_id: string; fields: Record<string, any> };
export class RiskTable {
  constructor(private readonly client: Client, private readonly tenant: ResolvedTenant) {}
  private get app() { return this.tenant.env.FEISHU_BITABLE_APP_TOKEN; }
  private async request<T extends { code?: number; msg?: string }>(fn: () => Promise<T>): Promise<T> {
    return withFeishuBitableQuotaCircuit(this.tenant.env.FEISHU_APP_ID, async () => {
      let result: T;
      try { result = await fn(); }
      catch (e) {
        const native = e as { response?: { status?: number; data?: { code?: number; msg?: string; error?: unknown } } };
        if (native.response?.data) throw Object.assign(new Error(`飞书 HTTP ${native.response.status} / ${JSON.stringify(native.response.data)}`), { response: native.response });
        throw e;
      }
      assertFeishuResponse(result, "违规提醒表操作"); return result;
    });
  }
  private async paged(load: (token?: string) => Promise<any>): Promise<any[]> {
    let token: string | undefined;
    const seen = new Set<string>(), result: any[] = [];
    do {
      const r = await this.request(() => load(token));
      if (!Array.isArray(r.data?.items)) {
        if (!(r.data?.total === 0 && r.data?.has_more === false)) throw new Error(`飞书分页缺少 items：${JSON.stringify(r.data)}`);
      }
      result.push(...(r.data.items ?? []));
      token = r.data.has_more ? r.data.page_token : undefined;
      if (r.data.has_more && (!token || seen.has(token))) throw new Error("飞书分页不完整/重复");
      if (token) seen.add(token);
    } while (token);
    return result;
  }
  async install(): Promise<string> {
    const tables = await this.paged(token => this.client.bitable.appTable.list({ path: { app_token: this.app }, params: { page_size: 100, page_token: token } }));
    const matches = tables.filter(t => t.name === RISK_TABLE_NAME);
    if (matches.length > 1) throw new Error("存在重复违规提醒表，拒绝选择");
    let id = matches[0]?.table_id as string | undefined;
    if (!id) {
      // No blind retries of table creation. Next invocation discovers any
      // ambiguously created table by its unique name before creating another.
      const r = await this.request(() => this.client.bitable.appTable.create({ path: { app_token: this.app }, data: {
        table: { name: RISK_TABLE_NAME, default_view_name: "全部提醒", fields: FIELD_NAMES.map(field_name => ({ field_name, type: 1 })) },
      } }));
      id = r.data?.table_id;
    }
    if (!id) throw new Error("新表未返回编号");
    await this.verifySchema(id);
    return id;
  }
  async verifySchema(tableId: string): Promise<void> {
    const fields = await this.paged(token => this.client.bitable.appTableField.list({ path: { app_token: this.app, table_id: tableId }, params: { page_size: 100, page_token: token } }));
    for (const name of FIELD_NAMES) {
      const matches = fields.filter(f => f.field_name === name);
      if (matches.length !== 1 || matches[0].type !== 1) throw new Error(`提醒字段不匹配：${name}`);
    }
  }
  async hideTechnicalKey(tableId: string): Promise<void> {
    const fields = await this.paged(token => this.client.bitable.appTableField.list({ path: { app_token: this.app, table_id: tableId }, params: { page_size: 100, page_token: token } }));
    const fieldId = fields.find(f => f.field_name === "核对键")?.field_id;
    if (!fieldId) throw new Error("缺少核对键");
    const views = await this.paged(token => this.client.bitable.appTableView.list({ path: { app_token: this.app, table_id: tableId }, params: { page_size: 100, page_token: token } }));
    const matches = views.filter(v => v.view_name === "全部提醒");
    if (matches.length !== 1) return; // do not alter user-created/customized views
    const viewId = matches[0].view_id;
    const detail = await this.request(() => this.client.bitable.appTableView.get({ path: { app_token: this.app, table_id: tableId, view_id: viewId } }));
    const hidden = detail.data?.view?.property?.hidden_fields ?? [];
    if (hidden.includes(fieldId)) return;
    await this.request(() => this.client.bitable.appTableView.patch({ path: { app_token: this.app, table_id: tableId, view_id: viewId },
      data: { property: { hidden_fields: [...hidden, fieldId] } } }));
    const verified = await this.request(() => this.client.bitable.appTableView.get({ path: { app_token: this.app, table_id: tableId, view_id: viewId } }));
    if (!verified.data?.view?.property?.hidden_fields?.includes(fieldId)) throw new Error("核对键隐藏未通过回读");
  }
  url(tableId: string): string { return `https://example.feishu.cn/base/YOUR_BASE_TOKEN`; }
  async organizeViews(tableId: string) {
    await this.verifySchema(tableId);
    const path = { app_token: this.app, table_id: tableId };
    const fields = await this.paged(token => this.client.bitable.appTableField.list({ path, params: { page_size: 100, page_token: token } }));
    const views = await this.paged(token => this.client.bitable.appTableView.list({ path, params: { page_size: 100, page_token: token } }));
    const receipts = [];
    for (const definition of RISK_LAYOUTS) {
      let matches = views.filter(v => v.view_name === definition.name);
      if (!matches.length && definition.name === "经营异常") matches = views.filter(v => v.view_name === "全部提醒");
      if (matches.length > 1) throw new Error(`排版视图重复：${definition.name}`);
      let viewId: string | undefined = matches[0]?.view_id;
      if (!viewId) {
        const result = await this.request(() => this.client.bitable.appTableView.create({ path, data: { view_name: definition.name, view_type: "grid" } }));
        viewId = result.data?.view?.view_id;
      }
      if (!viewId) throw new Error(`未获得视图编号：${definition.name}`);
      const viewPath = { ...path, view_id: viewId };
      const before = await this.request(() => this.client.bitable.appTableView.get({ path: viewPath }));
      const desired = riskViewProperty(fields, definition);
      const changed = before.data?.view?.view_name !== definition.name || !sameRiskViewProperty(before.data?.view?.property, desired);
      if (changed) await this.request(() => this.client.bitable.appTableView.patch({ path: viewPath, data: { view_name: definition.name, property: desired } }));
      const after = await this.request(() => this.client.bitable.appTableView.get({ path: viewPath }));
      if (after.data?.view?.view_name !== definition.name || !sameRiskViewProperty(after.data?.view?.property, desired)) throw new Error(`视图排版回读失败：${definition.name}`);
      const rows = await this.paged(token => this.client.bitable.appTableRecord.list({ path, params: { view_id: viewId, page_size: 500, page_token: token } }));
      receipts.push({ name: definition.name, viewId, changed, rows: rows.length, recordIds: rows.map(r => r.record_id), visible: definition.visible, before: before.data?.view, after: after.data?.view });
    }
    return receipts;
  }
  rows(tableId: string): Promise<Row[]> {
    return this.paged(token => this.client.bitable.appTableRecord.list({ path: { app_token: this.app, table_id: tableId }, params: { page_size: 500, page_token: token } })) as Promise<Row[]>;
  }
  async sync(tableId: string, state: RiskState, previousRecordIds: Record<string, string>) {
    await this.verifySchema(tableId);
    const before = await this.rows(tableId);
    const byKey = indexRows(before);
    const recordIds = { ...previousRecordIds };
    const desired = Object.values(state.issues).map(issue => ({ key: issue.key, fields: {
      "事项": issue.title, "类型": issue.category, "级别": issue.level, "首次发现": formatTime(issue.firstSeen),
      "本次检查": formatTime(state.checkedAt), "商品/订单编号": issue.objectId, "内容": issue.content,
      "建议处理": issue.advice, "监测状态": issue.status, "数据截至": formatTime(issue.dataAt), "核对键": issue.key,
    } }));
    const creates: Array<{fields: Record<string, string>}> = [], updates: Row[] = [], skipped: string[] = [];
    for (const item of desired) {
      const prior = byKey.get(item.key);
      if (!prior && previousRecordIds[item.key]) { skipped.push(item.key); continue; } // human deletion is preserved
      if (prior) {
        recordIds[item.key] = prior.record_id;
        if (Object.entries(item.fields).some(([k, v]) => cellText(prior.fields[k]) !== v)) updates.push({ record_id: prior.record_id, fields: item.fields });
      } else creates.push({ fields: item.fields });
    }
    for (let i = 0; i < creates.length; i += 50) {
      const batch = creates.slice(i, i + 50);
      await this.request(() => this.client.bitable.appTableRecord.batchCreate({ path: { app_token: this.app, table_id: tableId },
        params: { client_token: uuid(`${this.app}:${tableId}:${JSON.stringify(batch)}`) }, data: { records: batch } }));
    }
    for (let i = 0; i < updates.length; i += 50) {
      const batch = updates.slice(i, i + 50);
      await this.request(() => this.client.bitable.appTableRecord.batchUpdate({ path: { app_token: this.app, table_id: tableId },
        data: { records: batch as never } }));
    }
    const after = await this.rows(tableId);
    const verified = indexRows(after);
    for (const item of desired.filter(d => !skipped.includes(d.key))) {
      const row = verified.get(item.key);
      if (!row || Object.entries(item.fields).some(([k, v]) => cellText(row.fields[k]) !== v)) throw new Error(`提醒写后回读不一致：${item.key}`);
      recordIds[item.key] = row.record_id;
    }
    // Only the eleven automation-owned fields are sent; manual notes/status are
    // never included in updates. Concurrent user edits are retained, not reverted.
    const manualChanges = before.flatMap(row => {
      const next = after.find(r => r.record_id === row.record_id);
      return next && ["人工处理", "备注"].some(f => cellText(row.fields[f]) !== cellText(next.fields[f])) ? [row.record_id] : [];
    });
    return { tableId, created: creates.length, updated: updates.length, skippedDeleted: skipped,
      recordIds, before, after, manualChangesObserved: manualChanges };
  }
}
function indexRows(rows: Row[]): Map<string, Row> {
  const result = new Map<string, Row>();
  for (const row of rows) {
    const key = cellText(row.fields["核对键"]);
    if (!key) continue; // user-owned additions are untouched
    if (result.has(key)) throw new Error(`提醒表业务键重复：${key}`);
    result.set(key, row);
  }
  return result;
}
export function cellText(value: any): string { return Array.isArray(value) ? value.map(v => v.text ?? "").join("") : String(value ?? ""); }
export function uuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
