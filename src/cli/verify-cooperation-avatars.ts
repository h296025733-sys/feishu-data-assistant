import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import { avatarProfileHandle } from "../creators/avatar-profile.js";

const root = path.resolve(".runtime/cooperation-avatar");
const resultArgs = process.argv.filter(arg => arg.startsWith("--result=")).map(arg => arg.slice(9));
if (!resultArgs.length) throw new Error("Usage: --result=<resolved-*.json> [--result=<retry.json>]");
const resultPaths = resultArgs.map(arg => path.resolve(arg));
const statusByHandle = new Map<string, string>();
for (const resultPath of resultPaths) {
  if (!resultPath.startsWith(root + path.sep)) throw new Error("Resolution result must be within avatar runtime");
  const resolution = JSON.parse(await readFile(resultPath, "utf8"));
  if (!Array.isArray(resolution)) throw new Error("Resolution result is not a complete array");
  for (const item of resolution) statusByHandle.set(String(item.handle).toLowerCase(), item.status);
}
const audit: any[] = [];
for (const tenant of new TenantRegistry(getEnv()).all().filter(value => value.binding.id.endsWith("-formal"))) {
  const client = createFeishuClient(tenant.env);
  const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
  const tables = await client.bitable.appTable.list({ path: { app_token: appToken }, params: { page_size: 100 } });
  assertFeishuResponse(tables, "Avatar final table list");
  const matches = (tables.data?.items ?? []).filter(table => table.name === tenant.profile.tables.cooperation);
  if (matches.length !== 1 || !matches[0]?.table_id) throw new Error(`${tenant.binding.id} table ambiguous`);
  const tableId = matches[0].table_id;
  const apiPath = { app_token: appToken, table_id: tableId };
  const schema = await client.bitable.appTableField.list({ path: apiPath, params: { page_size: 100 } });
  assertFeishuResponse(schema, "Avatar final fields");
  if (schema.data?.has_more) throw new Error("Avatar fields truncated");
  const fields = schema.data?.items ?? [];
  const nameIndex = fields.findIndex(field => field.field_name === "红人姓名");
  const avatarFields = fields.filter(field => field.field_name === "红人头像");
  const schemaOk = avatarFields.length === 1 && avatarFields[0]?.type === 17 &&
    fields[nameIndex - 1]?.field_id === avatarFields[0]?.field_id;
  if (!schemaOk) throw new Error(`${tenant.binding.id} avatar schema mismatch`);
  const rows: any[] = [];
  let pageToken: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await client.bitable.appTableRecord.list({ path: apiPath,
      params: { page_size: 500, page_token: pageToken } });
    assertFeishuResponse(page, "Avatar final records");
    rows.push(...(page.data?.items ?? []));
    if (!page.data?.has_more) break;
    pageToken = page.data.page_token;
    if (!pageToken || seen.has(pageToken)) throw new Error("Avatar final pagination loop");
    seen.add(pageToken);
  } while (true);
  const detail = { tenantId: tenant.binding.id, tableId, totalRows: rows.length,
    named: 0, linked: 0, filled: 0, missingButResolved: [] as string[],
    unavailableSource: [] as string[], unresolvedSource: [] as string[],
    missingHomepage: [] as string[], malformedAvatar: [] as string[] };
  for (const row of rows) {
    if (!row.fields?.红人姓名) continue;
    detail.named++;
    const handle = avatarProfileHandle(row.fields?.主页);
    const avatar = row.fields?.红人头像;
    if (avatar != null && (!Array.isArray(avatar) || avatar.length !== 1 || !avatar[0]?.file_token)) {
      detail.malformedAvatar.push(row.record_id);
    }
    if (Array.isArray(avatar) && avatar.length === 1 && avatar[0]?.file_token) detail.filled++;
    if (!handle) {
      detail.missingHomepage.push(row.record_id);
      continue;
    }
    detail.linked++;
    if (Array.isArray(avatar) && avatar.length) continue;
    const status = statusByHandle.get(handle);
    if (status === "RESOLVED" || status === "CACHED") detail.missingButResolved.push(row.record_id);
    else if (status === "UNAVAILABLE") detail.unavailableSource.push(row.record_id);
    else detail.unresolvedSource.push(row.record_id);
  }
  audit.push(detail);
  console.log(JSON.stringify({ tenantId: detail.tenantId, totalRows: detail.totalRows,
    named: detail.named, linked: detail.linked, filled: detail.filled,
    missingButResolved: detail.missingButResolved.length,
    unavailableSource: detail.unavailableSource.length,
    unresolvedSource: detail.unresolvedSource.length,
    missingHomepage: detail.missingHomepage.length, malformedAvatar: detail.malformedAvatar.length }));
}
const at = new Date().toISOString();
const file = path.join(root, `final-audit-${at.replace(/[:.]/g, "-")}.json`);
await mkdir(root, { recursive: true });
await writeFile(file, JSON.stringify({ at, resultPaths, audit }, null, 2));
console.log(`evidence=${file}`);
if (audit.some(item => item.missingButResolved.length || item.unresolvedSource.length || item.malformedAvatar.length)) {
  process.exitCode = 1;
}
