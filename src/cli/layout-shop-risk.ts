import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";
import { RiskTable } from "../shop-risk/table.js";

const registry = new TenantRegistry(getEnv());
const selected = process.argv.find(v => v.startsWith("--tenant="))?.slice(9);
const tenants = selected ? [registry.byId(selected)!] : registry.all();
if (tenants.some(t => !t)) throw new Error("未知租户");
if (!process.argv.includes("--apply")) throw new Error("需显式 --apply；本入口仅调整视图，不写业务记录、不推送、不重启。");
const hash = (rows: any[]) => createHash("sha256").update(JSON.stringify(rows.map(r => ({ id: r.record_id, fields: Object.entries(r.fields).sort(([a], [b]) => a.localeCompare(b)) })).sort((a,b) => a.id.localeCompare(b.id)))).digest("hex");
for (const tenant of tenants) {
  const root = path.resolve(".runtime/tenants", tenant.binding.id, "shop-risk");
  const state = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"));
  if (state.tenantId !== tenant.binding.id || state.appToken !== tenant.env.FEISHU_BITABLE_APP_TOKEN) throw new Error("租户与Base不匹配");
  const table = new RiskTable(createFeishuClient(tenant.env), tenant);
  const before = await table.rows(state.tableId);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await mkdir(root, {recursive:true});
  await writeFile(path.join(root, `layout-before-${stamp}.json`), JSON.stringify(before, null, 2));
  const views = await table.organizeViews(state.tableId);
  const after = await table.rows(state.tableId);
  const unchanged = hash(before) === hash(after);
  await writeFile(path.join(root, `layout-readback-${stamp}.json`), JSON.stringify({tenant:tenant.binding.id, tableId:state.tableId, unchanged, beforeHash:hash(before), afterHash:hash(after), views}, null, 2));
  console.log(JSON.stringify({tenant:tenant.binding.id, tableId:state.tableId, unchanged, views:views.map(v=>({name:v.name,viewId:v.viewId,rows:v.rows,changed:v.changed}))}));
  if (!unchanged) throw new Error("排版前后记录变化，已保存证据，请核对并发修改；本入口没有记录写入操作。");
}
