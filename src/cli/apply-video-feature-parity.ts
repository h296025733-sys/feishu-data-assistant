import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

// Additive only: existing schemas and manual/analysis cells are never rewritten.
const root = ".runtime/video-feature-parity-2026-09-29";
const audit = JSON.parse(await readFile(`${root}/audit.json`, "utf8"));
const targets = audit.result.filter((x: any) => x.id !== "storeone-formal")
  .sort((a: any, b: any) => b.tables.reduce((n: number, t: any) => n + t.count, 0)
    - a.tables.reduce((n: number, t: any) => n + t.count, 0));
const apply = process.argv.includes("--apply");
if (apply && !process.argv.includes("--confirm=FORMAL-VIDEO-FEATURE-PARITY")) throw new Error("Explicit confirmation missing");
const registry = new TenantRegistry(getEnv());
const receipts: any[] = [];
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = `${root}/${stamp}`;
await mkdir(output, { recursive: true });
function text(value: any): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object") return String(value.link ?? value.text ?? "");
  return value === undefined || value === null ? "" : String(value);
}
for (const target of targets) {
  const tenant = registry.byId(target.id);
  if (!tenant || tenant.env.FEISHU_BITABLE_APP_TOKEN !== target.base) throw new Error("Tenant binding changed");
  const client = createFeishuClient(tenant.env);
  for (const table of target.tables) {
    const path = { app_token: target.base, table_id: table.tableId };
    async function read() {
      const schema = await client.bitable.appTableField.list({ path, params: { page_size: 100 } });
      assertFeishuResponse(schema, "parity fields");
      if (schema.data?.has_more) throw new Error("Field pagination incomplete");
      const records: any[] = [];
      const seen = new Set<string>();
      let next: string | undefined;
      do {
        const page = await client.bitable.appTableRecord.list({ path, params: { page_size: 500, page_token: next } });
        assertFeishuResponse(page, "parity records");
        records.push(...page.data?.items ?? []);
        if (!page.data?.has_more) break;
        next = page.data.page_token;
        if (!next || seen.has(next)) throw new Error("Record pagination loop");
        seen.add(next);
      } while (true);
      return { fields: schema.data?.items ?? [], records };
    }
    const before = await read();
    await writeFile(`${output}/${target.id}-${table.kind}-before.json`, JSON.stringify(before, null, 2));
    const definitions: any[] = [
      { field_name: "视频内容分析", type: 1, ui_type: "Text" },
      { field_name: "投广建议", type: 3, ui_type: "SingleSelect", property: { options: [
        { name: "推荐投广", color: 2 }, { name: "待选投广", color: 1 }, { name: "不建议投广", color: 0 }] } },
      { field_name: "视频修改建议", type: 1, ui_type: "Text" },
    ];
    if (table.kind === "online") {
      const source = before.fields.find(f => f.field_name === "视频上线地址");
      if (!source?.field_id) throw new Error("Video URL field missing");
      definitions.push({ field_name: "商品点击量", type: 2, ui_type: "Number", property: { formatter: "0" } },
        { field_name: "视频ID", type: 20, ui_type: "Formula", property: { formatter: "",
          formula_expression: `IFERROR(REGEXEXTRACT(bitable::$table[${table.tableId}].$field[${source.field_id}],"[0-9]{19}"),"")` } });
    }
    const missing: any[] = [];
    for (const def of definitions) {
      const prior = before.fields.find(f => f.field_name === def.field_name);
      if (prior && prior.type !== def.type) throw new Error(`Existing ${def.field_name} type differs; not overwriting`);
      if (!prior) missing.push(def);
    }
    for (const def of missing) {
      if (apply) assertFeishuResponse(await client.bitable.appTableField.create({ path, data: def }), `create ${def.field_name}`);
    }
    let after = apply ? await read() : before;
    const formulaMismatches = () => table.kind !== "online" ? [] : after.records.flatMap(row => {
      const expected = text(row.fields?.视频上线地址).match(/\/video\/([0-9]{19})(?:[/?#]|$)/)?.[1] ?? "";
      const actual = text(row.fields?.视频ID);
      return expected === actual ? [] : [{ recordId: row.record_id, expected, actual }];
    });
    if (apply && table.kind === "online") for (let i = 0; i < 3 && formulaMismatches().length; i++) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      after = await read();
    }
    const originals = new Map(before.records.map(r => [r.record_id, r]));
    const changedOriginalCells = after.records.flatMap(row => {
      const old = originals.get(row.record_id);
      return old ? Object.keys(old.fields).filter(name => JSON.stringify(old.fields[name]) !== JSON.stringify(row.fields[name]))
        .map(field => ({ recordId: row.record_id, field })) : [{ recordId: row.record_id, field: "NEW_RECORD" }];
    });
    const schemaChanges = before.fields.filter(old => {
      const fresh = after.fields.find(f => f.field_id === old.field_id);
      return !fresh || JSON.stringify(old) !== JSON.stringify(fresh);
    }).map(f => f.field_name);
    const receipt = { tenantId: target.id, kind: table.kind, tableId: table.tableId, apply,
      additions: missing.map(f => f.field_name), recordCount: after.records.length,
      countUnchanged: before.records.length === after.records.length, changedOriginalCells, schemaChanges,
      formulaMismatches: formulaMismatches() };
    receipts.push(receipt);
    await writeFile(`${output}/${target.id}-${table.kind}-after.json`, JSON.stringify(after, null, 2));
    await writeFile(`${output}/receipts.json`, JSON.stringify(receipts, null, 2));
    console.log(JSON.stringify(receipt));
    if (apply && (!receipt.countUnchanged || changedOriginalCells.length || schemaChanges.length || receipt.formulaMismatches.length)) {
      throw new Error("Readback changed or formula mismatch; receipt saved; no destructive rollback");
    }
  }
}
