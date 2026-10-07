import { mkdir, writeFile } from "node:fs/promises";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import { buildStoreVideoInventory } from "../video-analysis/storeone-inventory.js";

const registry = new TenantRegistry(getEnv());
const ids = ["storeone-formal", "storetwo-formal", "storetwo-botanical-care-formal", "storetwo-llc-formal", "storethree-formal"];
const result: any[] = [];
for (const id of ids) {
  const tenant = registry.byId(id);
  if (!tenant) throw new Error(`Missing tenant ${id}`);
  const client = createFeishuClient(tenant.env);
  const base = tenant.env.FEISHU_BITABLE_APP_TOKEN;
  const list = await client.bitable.appTable.list({ path: { app_token: base }, params: { page_size: 100 } });
  assertFeishuResponse(list, `${id} tables`);
  if (list.data?.has_more) throw new Error("Incomplete table list");
  const tables: any[] = [];
  const rows: Record<string, any[]> = {};
  const tableIds = { online: "", account: "" };
  for (const [kind, name] of [["online", tenant.profile.tables.online], ["account", "短视频数据表"]] as const) {
    const matches = list.data?.items?.filter(t => t.name === name) ?? [];
    if (matches.length !== 1 || !matches[0].table_id) throw new Error(`Ambiguous table ${id}/${name}`);
    const tableId = matches[0].table_id;
    tableIds[kind] = tableId;
    const path = { app_token: base, table_id: tableId };
    const schema = await client.bitable.appTableField.list({ path, params: { page_size: 100 } });
    assertFeishuResponse(schema, `${id} fields`);
    if (schema.data?.has_more) throw new Error("Incomplete fields");
    const fields = schema.data?.items ?? [];
    rows[tableId] = [];
    let next: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.bitable.appTableRecord.list({ path, params: { page_size: 500, page_token: next } });
      assertFeishuResponse(page, `${id} video records`);
      rows[tableId].push(...page.data?.items ?? []);
      if (!page.data?.has_more) break;
      next = page.data.page_token;
      if (!next || seen.has(next)) throw new Error("Record pagination loop");
      seen.add(next);
    } while (true);
    const views = await client.bitable.appTableView.list({ path, params: { page_size: 100 } });
    assertFeishuResponse(views, `${id} views`);
    tables.push({ kind, tableId, name, count: rows[tableId].length, fields, views: views.data?.items ?? [] });
  }
  const inventory = buildStoreVideoInventory(rows, tableIds);
  const report = { id, base, tables, inventory };
  result.push(report);
  console.log(JSON.stringify({ id, base, tables: tables.map(t => ({ kind: t.kind, tableId: t.tableId, count: t.count,
    missing: (t.kind === "online" ? ["视频ID", "商品点击量", "视频内容分析", "投广建议", "视频修改建议"] : ["视频内容分析", "投广建议", "视频修改建议"])
      .filter(name => !t.fields.some((f: any) => f.field_name === name)) })),
    complete: inventory.completeRows, pending: inventory.pending.length, invalid: inventory.invalid.length, duplicates: inventory.duplicates.length }));
}
await mkdir(".runtime/video-feature-parity-2026-09-29", { recursive: true });
await writeFile(".runtime/video-feature-parity-2026-09-29/audit.json", JSON.stringify({ at: new Date().toISOString(), result }, null, 2));
