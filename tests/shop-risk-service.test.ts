import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RiskTable, AUTO_FIELDS, uuid } from "../src/shop-risk/table.js";
import { ShopRiskService } from "../src/shop-risk/service.js";
import { reconcile, type Snapshot } from "../src/shop-risk/model.js";
import type { ResolvedTenant } from "../src/config/tenant-registry.js";

const tenant = { binding: { id: "storeone-formal" }, env: { FEISHU_BITABLE_APP_TOKEN: "base", FEISHU_APP_ID: "app" },
  profile: { businessDisplayName: "STOREONE", tiktok: { shopId: "1" } } } as unknown as ResolvedTenant;
const snapshot: Snapshot = { version: 1, shop: { id: "1", name: "STOREONE" }, fetchedAt: "2026-09-30T07:00:00Z", evidencePath: "e", evidenceSha256: "h",
  sources: { products: { ok: true, rows: [{ id: "2", status: "FREEZE" }] }, orders: { ok: true, rows: [] },
    sps_overview: { ok: true, response: { data: { sps_tier: "NIL" } } }, sps_metrics: { ok: true, response: { data: { metrics: [] } } } } };
afterEach(() => vi.restoreAllMocks());
describe("risk table safety", () => {
  function fake() {
    let rows: any[] = [];
    const clone = (v: any) => JSON.parse(JSON.stringify(v));
    const client = { bitable: {
      appTableField: { list: async () => ({code: 0, data: { items: [...AUTO_FIELDS, "人工处理", "备注"].map(field_name => ({ field_name, type: 1 })), has_more: false }}) },
      appTableRecord: {
        list: async () => ({ code: 0, data: rows.length ? {items: clone(rows), has_more: false, total: rows.length} : {has_more: false, total: 0} }),
        batchCreate: vi.fn(async (request: any) => { expect(request.params.client_token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); rows.push(...request.data.records.map((r: any, i: number) => ({ record_id: `r${rows.length + i}`, fields: r.fields }))); return {code:0}; }),
        batchUpdate: vi.fn(async (request: any) => { for (const update of request.data.records) {
          expect(update.fields).not.toHaveProperty("备注"); expect(update.fields).not.toHaveProperty("人工处理");
          const r = rows.find(r => r.record_id === update.record_id); r.fields = {...r.fields, ...update.fields};
        } return {code:0}; }),
      },
    } };
    return {client, get: () => rows, set: (value: any[]) => { rows = value; }};
  }
  it("accepts native empty table, creates once, preserves human fields and human deletion", async () => {
    const f = fake(); const table = new RiskTable(f.client as never, tenant);
    const state = reconcile(snapshot).state;
    const first = await table.sync("table", state, {});
    expect(first.created).toBe(1);
    f.get()[0].fields["备注"] = "人工备注"; f.get()[0].fields["人工处理"] = "已提交申诉";
    const second = await table.sync("table", state, first.recordIds);
    expect(second.created).toBe(0); expect(second.updated).toBe(0);
    expect(second.after[0]?.fields["备注"]).toBe("人工备注");
    state.checkedAt = "2026-10-01T07:00:00Z";
    const third = await table.sync("table", state, first.recordIds);
    expect(third.updated).toBe(1); expect(third.manualChangesObserved).toEqual([]);
    f.set([]); const deleted = await table.sync("table", state, first.recordIds);
    expect(deleted.created).toBe(0); expect(deleted.skippedDeleted).toHaveLength(1);
  });
  it("refuses duplicate business keys", async () => {
    const f = fake(); f.set([{record_id:"a",fields:{"核对键":"x"}}, {record_id:"b",fields:{"核对键":"x"}}]);
    await expect(new RiskTable(f.client as never, tenant).sync("t", reconcile(snapshot).state, {})).rejects.toThrow("重复");
  });
  it("deterministic create idempotency token has UUID v4 format", () => {
    expect(uuid("a")).toBe(uuid("a")); expect(uuid("a")).not.toBe(uuid("b"));
  });
});
describe("daily risk service", () => {
  async function setup() {
    vi.spyOn(RiskTable.prototype, "install").mockResolvedValue("table");
    vi.spyOn(RiskTable.prototype, "verifySchema").mockResolvedValue();
    vi.spyOn(RiskTable.prototype, "hideTechnicalKey").mockResolvedValue();
    const sync = vi.spyOn(RiskTable.prototype, "sync").mockResolvedValue({ tableId:"table", created:1, updated:0,
      recordIds:{"product:2:restricted":"r1"}, before:[], after:[], manualChangesObserved:[], skippedDeleted:[] });
    const root = await mkdtemp(path.join(tmpdir(), "shop-risk-test-"));
    let now = new Date("2026-09-30T07:00:00Z"), chats = ["chat-storeone"];
    const sendCard = vi.fn(async () => "real-shaped-test-id"); const collect = vi.fn(async () => structuredClone(snapshot));
    const input = { tenant, client:{} as never, groupChatIds:()=>chats, sendCard, root, now:()=>now, collect };
    const service = new ShopRiskService(input); await service.install();
    return {service, input, root, collect, sync, sendCard, time:(v:string)=>{now=new Date(v);}, chats:(v:string[])=>{chats=v;}};
  }
  it("prepares once, persists receipts across restart and serializes concurrent delivery", async () => {
    const f=await setup(); await f.service.prepare(); await f.service.prepare(); expect(f.collect).toHaveBeenCalledTimes(1);
    f.time("2026-09-30T09:56:00Z");
    await Promise.all([f.service.deliver("2026-09-30"), f.service.deliver("2026-09-30")]);
    await new ShopRiskService(f.input).deliver("2026-09-30");
    expect(f.sendCard).toHaveBeenCalledTimes(1);
    expect(f.sendCard.mock.calls[0]?.[0]).toBe("chat-storeone");
  });
  it("never routes unbound tenant or reuses yesterday's snapshot", async () => {
    const f=await setup(); await f.service.prepare(); f.chats([]);
    await expect(f.service.deliver("2026-09-30")).rejects.toThrow("未唯一绑定");
    f.chats(["chat"]); f.time("2026-10-01T09:56:00Z");
    await expect(f.service.deliver("2026-09-30")).rejects.toThrow("拒绝发送旧数据");
    expect(f.sendCard).not.toHaveBeenCalled();
  });
  it("source failure produces explicit unavailable status instead of all clear", async () => {
    const f=await setup(); f.collect.mockRejectedValueOnce(new Error("network unavailable"));
    await f.service.prepare();
    const file=JSON.parse(await readFile(path.join(f.root,"tenants/storeone-formal/shop-risk/state.json"),"utf8"));
    expect(Object.keys(file.prepared["2026-09-30"].failures)).toHaveLength(4);
    expect(file.prepared["2026-09-30"].text).toContain("未完成检查");
    expect(file.prepared["2026-09-30"].text).not.toContain("本次已监测项目未发现新增异常");
  });
  it("table failure does not discard the actual findings and cached retry uses no TikTok calls", async () => {
    const f=await setup(); f.sync.mockRejectedValueOnce(new Error("quota"));
    await f.service.prepare(); await f.service.prepare();
    expect(f.collect).toHaveBeenCalledTimes(1); expect(f.sync).toHaveBeenCalledTimes(2);
    const file=JSON.parse(await readFile(path.join(f.root,"tenants/storeone-formal/shop-risk/state.json"),"utf8"));
    expect(file.prepared["2026-09-30"].tableSynced).toBe(true);
    expect(file.prepared["2026-09-30"].text).not.toContain("更新未完成");
  });
});
