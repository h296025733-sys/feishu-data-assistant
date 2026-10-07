import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import { listRecords, listTables } from "../feishu/account-side-test.js";

const tenantId = process.argv[process.argv.indexOf("--tenant") + 1];
const apply = process.argv.includes("--apply");
if (apply && !process.argv.includes("REMOVE-ZERO-ACCOUNT-DUPLICATES")) throw new Error("修复必须确认 REMOVE-ZERO-ACCOUNT-DUPLICATES");
if (!process.argv.includes("--tenant")) throw new Error("必须指定 --tenant");
const registry = new TenantRegistry(requireFeishuEnv(getEnv()));
const tenant = registry.byId(tenantId!);
if (!tenant) throw new Error("店铺不存在");
const client = createFeishuClient(tenant.env);
const tables = await listTables(client, tenant.env.FEISHU_BITABLE_APP_TOKEN);
const directory = path.resolve("backups", "account-roi-duplicates", new Date().toISOString().replace(/[:.]/g, "-"), tenantId!);
await mkdir(directory, { recursive: true });
for (const name of ["产品投产比", "账号投产比"]) {
  const matches = tables.filter((table) => table.name === name);
  if (matches.length !== 1) throw new Error(`无法唯一定位${name}`);
  const records = await listRecords(client, tenant.env.FEISHU_BITABLE_APP_TOKEN, matches[0]!.tableId);
  await writeFile(path.join(directory, `${name}.json`), JSON.stringify({ tenantId, table: matches[0], records }, null, 2), { mode: 0o600 });
  const groups = new Map<string, typeof records>();
  for (const row of records) {
    const key = String(row.fields.检查 ?? "");
    if (key) groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  console.log(JSON.stringify({ tenantId, table: matches[0], totalRows: records.length, backup: directory,
    duplicates: [...groups].filter(([, rows]) => rows.length > 1).map(([key, rows]) => ({ key, rows })) }, null, 2));
  if (!apply || name !== "产品投产比") continue;
  const removable = [...groups].filter(([, rows]) => rows.length > 1).flatMap(([key, rows]) => {
    const metricFields = ["上线量", "出单视频", "单量", "数量", "视频曝光", "销售额"];
    const identityFields = ["检查", "商品", "店铺", "日期", "数据状态"];
    const isZero = (row: typeof rows[number]) => metricFields.every((field) => row.fields[field] !== undefined && Number(row.fields[field]) === 0);
    const nonZero = rows.filter((row) => !isZero(row));
    if (nonZero.length !== 1) throw new Error(`${key}不是一条有效记录加纯零副本，拒绝自动删除`);
    const kept = nonZero[0]!;
    return rows.filter((row) => row !== kept).map((row) => {
      if (!isZero(row) || identityFields.some((field) => JSON.stringify(row.fields[field]) !== JSON.stringify(kept.fields[field]))
        || Object.keys(row.fields).some((field) => ![...metricFields, ...identityFields, "TikTok商品ID"].includes(field))) {
        throw new Error(`${key}副本含不一致/人工字段，拒绝删除`);
      }
      return row;
    });
  });
  if (!removable.length) continue;
  // Compare every field of the complete table immediately before deletion.
  const fresh = await listRecords(client, tenant.env.FEISHU_BITABLE_APP_TOKEN, matches[0]!.tableId);
  if (JSON.stringify(fresh) !== JSON.stringify(records)) throw new Error("审计后表格发生变化，拒绝删除");
  const receipts = [];
  for (const row of removable) {
    const response = await client.bitable.appTableRecord.delete({ path: {
      app_token: tenant.env.FEISHU_BITABLE_APP_TOKEN, table_id: matches[0]!.tableId, record_id: row.recordId,
    } });
    assertFeishuResponse(response, "删除已留底的纯零重复行");
    receipts.push({ recordId: row.recordId, response });
    await writeFile(path.join(directory, "deletion-receipts.json"), JSON.stringify(receipts, null, 2), { mode: 0o600 });
  }
  const after = await listRecords(client, tenant.env.FEISHU_BITABLE_APP_TOKEN, matches[0]!.tableId);
  const expected = records.filter((row) => !removable.some((remove) => remove.recordId === row.recordId));
  if (JSON.stringify(after) !== JSON.stringify(expected)) throw new Error("删除后回读不一致，检查留底");
  await writeFile(path.join(directory, "after-verified.json"), JSON.stringify(after, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ table: name, removed: removable.map((row) => row.recordId), unchangedRemainingRows: after.length, verified: true }));
}
