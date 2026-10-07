import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

const appToken = "demo_1e0a6606";
const tableId = "demo_2388c86c";
const tenant = new TenantRegistry(getEnv()).byId("storeone-formal");
if (!tenant || tenant.env.FEISHU_BITABLE_APP_TOKEN !== appToken) throw new Error("STOREONE binding mismatch");
const client = createFeishuClient(tenant.env);
const apiPath = { app_token: appToken, table_id: tableId };
const apply = process.argv.includes("--apply");
if (apply && !process.argv.includes("--confirm=STOREONE-VIDEO-ID")) throw new Error("Confirmation missing");
async function read() {
  const fields = await client.bitable.appTableField.list({ path: apiPath, params: { page_size: 100 } });
  assertFeishuResponse(fields, "STOREONE fields");
  if (fields.data?.has_more) throw new Error("Unexpected field pagination");
  const records: any[] = [];
  let pageToken: string | undefined;
  const seen = new Set<string>();
  do {
    const response = await client.bitable.appTableRecord.list({ path: apiPath, params: { page_size: 500, page_token: pageToken } });
    assertFeishuResponse(response, "STOREONE records");
    records.push(...response.data?.items ?? []);
    if (!response.data?.has_more) break;
    pageToken = response.data.page_token;
    if (!pageToken || seen.has(pageToken)) throw new Error("Pagination loop");
    seen.add(pageToken);
  } while (true);
  return { fields: fields.data?.items ?? [], records };
}
function cellText(value: any): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(cellText).join("");
  if (typeof value === "object") return String(value.link ?? value.text ?? "");
  return String(value);
}
const before = await read();
const source = before.fields.find(f => f.field_name === "视频上线地址");
if (!source?.field_id) throw new Error("Source URL field missing");
const ref = `bitable::$table[${tableId}].$field[${source.field_id}]`;
const expression = `IFERROR(REGEXEXTRACT(${ref},"[0-9]{19}"),"")`;
const prior = before.fields.find(f => f.field_name === "视频ID");
const directory = path.resolve(".runtime/storeone-video-id");
await mkdir(directory, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(path.join(directory, `${stamp}-before.json`), JSON.stringify(before, null, 2));
const valid = before.records.filter(row => /\/video\/([0-9]{19})(?:[/?#]|$)/.test(cellText(row.fields?.["视频上线地址"])));
if (apply) {
  if (prior && (prior.type !== 20 || prior.property?.formula_expression !== expression)) {
    throw new Error("Existing 视频ID differs; refusing overwrite");
  }
  if (!prior) {
    const created = await client.bitable.appTableField.create({path:apiPath, data:{field_name:"视频ID", type:20, ui_type:"Formula", property:{formatter:"",formula_expression:expression}}});
    assertFeishuResponse(created, "Create STOREONE 视频ID");
  }
}
let after = apply ? await read() : before;
// Feishu computes newly-created formula cells asynchronously; do bounded readback.
if (apply) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const unfinished = after.records.some(row => {
      const expected = cellText(row.fields?.["视频上线地址"]).match(/\/video\/([0-9]{19})(?:[/?#]|$)/)?.[1] ?? "";
      return expected !== cellText(row.fields?.["视频ID"]);
    });
    if (!unfinished) break;
    await new Promise(resolve => setTimeout(resolve, 1500));
    after = await read();
  }
}
const target = after.fields.find(f => f.field_name === "视频ID");
const mismatches = target ? after.records.flatMap(row => {
  const expected = cellText(row.fields?.["视频上线地址"]).match(/\/video\/([0-9]{19})(?:[/?#]|$)/)?.[1] ?? "";
  const actual = cellText(row.fields?.["视频ID"]);
  return expected === actual ? [] : [{recordId:row.record_id,expected,actual}];
}) : [];
const changedOriginalCells: any[] = [];
if (apply) {
  const originals = new Map(before.records.map(r=>[r.record_id,r]));
  for (const row of after.records) {
    const old = originals.get(row.record_id);
    if (!old) continue;
    for (const name of Object.keys(old.fields)) {
      if (name !== "视频ID" && JSON.stringify(old.fields[name]) !== JSON.stringify(row.fields[name])) changedOriginalCells.push({recordId:row.record_id,field:name});
    }
  }
  await writeFile(path.join(directory, `${stamp}-after.json`), JSON.stringify(after, null, 2));
}
const report = {at:new Date().toISOString(),apply,appToken,tableId,recordCount:after.records.length,validUrls:valid.length,blankOrInvalid:before.records.length-valid.length,source,target,expression,mismatches,changedOriginalCells,recordCountUnchanged:before.records.length===after.records.length};
await writeFile(path.join(directory, `${stamp}-report.json`), JSON.stringify(report,null,2));
console.log(JSON.stringify({...report, mismatchCount:mismatches.length,mismatches:mismatches.slice(0,5)},null,2));
if (apply && (!target || mismatches.length || changedOriginalCells.length || before.records.length!==after.records.length)) process.exitCode=1;
