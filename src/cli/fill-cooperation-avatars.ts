import { randomUUID } from "node:crypto";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient, feishuErrorDetails,
  withFeishuRetry, withFeishuBitableQuotaCircuit } from "../feishu/client.js";
import { avatarProfileHandle } from "../creators/avatar-profile.js";

type Row = { record_id?: string; fields?: Record<string, any> };
async function main(): Promise<void> {
const apply = process.argv.includes("--apply");
const limitArg = process.argv.find(arg => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;
if (!Number.isFinite(limit) && limit !== Infinity || limit < 1) throw new Error("Invalid --limit");
const tenantArg = process.argv.find(arg => arg.startsWith("--tenant="))?.split("=")[1];
const imageDir = path.resolve(".runtime/cooperation-avatar/images");
const root = path.resolve(".runtime/cooperation-avatar");
const registry = new TenantRegistry(getEnv());
const targets = registry.all().filter(tenant => tenant.binding.id.endsWith("-formal")
  && (!tenantArg || tenant.binding.id === tenantArg));
if (!targets.length) throw new Error("No matching formal tenant");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(root, `fill-${stamp}`);
await mkdir(runDir, { recursive: true });

function cellText(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(cellText).join("");
  if (value && typeof value === "object") return String(value.link ?? value.text ?? "");
  return "";
}
function handleOf(row: Row): string | null {
  return avatarProfileHandle(row.fields?.主页);
}
function isBlank(value: any): boolean {
  return value == null || Array.isArray(value) && value.length === 0;
}
async function waitForMemory(): Promise<void> {
  while (os.freemem() < 4 * 1024 ** 3) await new Promise(resolve => setTimeout(resolve, 10_000));
}
const fileNames = await readdir(imageDir);
const files = new Map<string, string>();
for (const name of fileNames) {
  const match = name.match(/^([A-Za-z0-9._]+)\.(jpg|png|webp)$/i);
  if (match) files.set(match[1]!.toLowerCase(), path.join(imageDir, name));
}
let remaining = limit;
for (const tenant of targets) {
  const tenantId = tenant.binding.id;
  const client = createFeishuClient(tenant.env);
  const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
  async function readBitable<T extends { code?: number; msg?: string }>(
    operation: () => Promise<T>, action: string,
  ): Promise<T> {
    return withFeishuRetry(() => withFeishuBitableQuotaCircuit(tenant.env.FEISHU_APP_ID, async () => {
      const response = await operation();
      assertFeishuResponse(response, action);
      return response;
    }), { attempts: 3, baseDelayMs: 1_000 });
  }
  const tableList = await readBitable(() => client.bitable.appTable.list({
    path: { app_token: appToken }, params: { page_size: 100 },
  }), `${tenantId} tables`);
  const matches = (tableList.data?.items ?? []).filter(table => table.name === tenant.profile.tables.cooperation);
  if (matches.length !== 1 || !matches[0]?.table_id) throw new Error(`${tenantId} cooperation table ambiguous`);
  const tableId = matches[0].table_id;
  const tablePath = { app_token: appToken, table_id: tableId };
  const fieldList = await readBitable(() => client.bitable.appTableField.list({
    path: tablePath, params: { page_size: 100 },
  }), `${tenantId} fields`);
  if (fieldList.data?.has_more) throw new Error(`${tenantId} fields incomplete`);
  const fields = fieldList.data?.items ?? [];
  const nameIndex = fields.findIndex(field => field.field_name === "红人姓名");
  const avatar = fields.filter(field => field.field_name === "红人头像");
  if (avatar.length !== 1 || avatar[0]?.type !== 17 || fields[nameIndex - 1]?.field_id !== avatar[0]?.field_id) {
    throw new Error(`${tenantId} avatar field missing, wrong type, or not directly left of name`);
  }
  async function records(): Promise<Row[]> {
    const result: Row[] = [];
    let pageToken: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await readBitable(() => client.bitable.appTableRecord.list({ path: tablePath,
        params: { page_size: 500, page_token: pageToken } }), `${tenantId} records`);
      result.push(...(page.data?.items ?? []));
      if (!page.data?.has_more) break;
      pageToken = page.data.page_token;
      if (!pageToken || seen.has(pageToken)) throw new Error(`${tenantId} pagination loop`);
      seen.add(pageToken);
    } while (true);
    return result;
  }
  const before = await records();
  await writeFile(path.join(runDir, `${tenantId}-before.json`), JSON.stringify(before, null, 2));
  const candidates = before.flatMap(row => {
    const handle = handleOf(row);
    const file = handle ? files.get(handle) : null;
    return row.record_id && row.fields?.红人姓名 && isBlank(row.fields?.红人头像) && handle && file
      ? [{ recordId: row.record_id, handle, file, name: row.fields.红人姓名,
          profileUrl: cellText(row.fields.主页) }]
      : [];
  }).slice(0, remaining);
  const receipt: any = { tenantId, tableId, apply, candidateCount: candidates.length,
    totalRows: before.length, availableImages: files.size, written: 0, batches: [] as any[] };
  await writeFile(path.join(runDir, `${tenantId}-receipt.json`), JSON.stringify(receipt, null, 2));
  if (!apply) {
    console.log(JSON.stringify(receipt));
    remaining -= candidates.length;
    if (remaining <= 0) break;
    continue;
  }
  const tokenByHandle = new Map<string, string>();
  for (let offset = 0; offset < candidates.length; offset += 30) {
    await waitForMemory();
    const batch = candidates.slice(offset, offset + 30);
    const live = new Map((await records()).map(row => [row.record_id, row]));
    const updates: Array<{ record_id: string; fields: Record<string, any> }> = [];
    const expected = new Map<string, string>();
    for (const candidate of batch) {
      const row = live.get(candidate.recordId);
      if (!row || row.fields?.红人姓名 !== candidate.name ||
        cellText(row.fields?.主页) !== candidate.profileUrl || handleOf(row) !== candidate.handle) {
        throw new Error(`${tenantId} creator business key changed: ${candidate.recordId}`);
      }
      if (!isBlank(row.fields?.红人头像)) continue;
      let token = tokenByHandle.get(candidate.handle);
      if (!token) {
        const image = await readFile(candidate.file);
        if (image.length < 1500 || image.length > 5_000_000) throw new Error(`Image size invalid: ${candidate.handle}`);
        const uploaded = await client.drive.media.uploadAll({ data: {
          file_name: path.basename(candidate.file), parent_type: "bitable_image",
          parent_node: appToken, size: image.length, file: image,
        } }) as Record<string, any> | null;
        if (uploaded?.code && uploaded.code !== 0) throw new Error(`Upload failed ${tenantId}: ${uploaded.code}`);
        token = uploaded?.file_token ?? uploaded?.data?.file_token;
        if (!token) throw new Error(`Upload lacked token: ${tenantId}/${candidate.handle}`);
        tokenByHandle.set(candidate.handle, token);
      }
      updates.push({ record_id: candidate.recordId, fields: { 红人头像: [{ file_token: token }] } });
      expected.set(candidate.recordId, token);
    }
    if (updates.length) {
      const result = await client.bitable.appTableRecord.batchUpdate({ path: tablePath,
        params: { client_token: randomUUID() }, data: { records: updates } });
      assertFeishuResponse(result, `${tenantId} avatar batch`);
      if (result.data?.records?.length !== updates.length) throw new Error(`${tenantId} avatar batch receipt short`);
    }
    const after = await records();
    const afterMap = new Map(after.map(row => [row.record_id, row]));
    for (const row of live.values()) {
      if (!row.record_id) continue;
      const current = afterMap.get(row.record_id);
      if (!current) throw new Error(`${tenantId} record disappeared during avatar batch: ${row.record_id}`);
      for (const [field, value] of Object.entries(row.fields ?? {})) {
        if (field === "红人头像") continue;
        if (JSON.stringify(current.fields?.[field]) !== JSON.stringify(value)) {
          throw new Error(`${tenantId} protected cell changed during avatar batch: ${row.record_id}/${field}`);
        }
      }
    }
    for (const [recordId, token] of expected) {
      const avatarCells = afterMap.get(recordId)?.fields?.红人头像;
      if (!Array.isArray(avatarCells) || avatarCells.length !== 1 || avatarCells[0]?.file_token !== token) {
        throw new Error(`${tenantId} avatar readback mismatch: ${recordId}`);
      }
    }
    receipt.written += updates.length;
    receipt.batches.push({ offset, count: updates.length, readback: true });
    await writeFile(path.join(runDir, `${tenantId}-receipt.json`), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ tenantId, offset, written: receipt.written, total: candidates.length }));
  }
  remaining -= candidates.length;
  if (remaining <= 0) break;
}
console.log(`evidence=${runDir}`);
}

await main().catch(error => {
  // Axios errors contain authorization headers. Never print the raw object.
  const details = feishuErrorDetails(error);
  console.error(JSON.stringify({ event: "avatar_fill_failed", status: details.status,
    code: details.code, message: details.message, retryAfterMs: details.retryAfterMs }));
  process.exitCode = 1;
});
