import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { avatarProfileHandle, avatarProfileText } from "../creators/avatar-profile.js";

// Local audit reconciliation only: no network requests, credentials or business writes.
const root = path.resolve(".runtime/cooperation-avatar");
function input(flag: string): string {
  const arg = process.argv.find(value => value.startsWith(`--${flag}=`))?.split("=").slice(1).join("=");
  if (!arg) throw new Error(`Missing --${flag}=<audit path>`);
  const file = path.resolve(arg);
  if (!file.startsWith(root + path.sep)) throw new Error("Audit must be within avatar runtime");
  return file;
}
const finalFile = input("final");
const sourceFile = input("source");
const final = JSON.parse(await readFile(finalFile, "utf8"));
const source = JSON.parse(await readFile(sourceFile, "utf8"));
const result = final.audit.map((store: any) => {
  const original = source.result.find((item: any) => item.tenant === store.tenantId && item.tableId === store.tableId);
  if (!original) throw new Error(`Missing matching source audit: ${store.tenantId}`);
  const rows = new Map<string, any>(original.rows.map((row: any) => [row.record_id ?? row.id, row]));
  const pending = [...store.unavailableSource, ...store.unresolvedSource, ...store.missingHomepage, ...store.missingButResolved];
  return { tenantId: store.tenantId, tableId: store.tableId, count: new Set(pending).size,
    rows: [...new Set<string>(pending)].map(recordId => {
      const row = rows.get(recordId);
      if (!row) throw new Error(`Source record missing: ${recordId}`);
      const handle = avatarProfileHandle(row.fields?.主页);
      return { recordId, creator: avatarProfileText(row.fields?.红人姓名).trim(),
        homepage: handle ? `https://www.tiktok.com/@${handle}` : avatarProfileText(row.fields?.主页),
        reason: store.unavailableSource.includes(recordId) ? "本轮真实主页/头像来源读取失败，尚未补齐" : "需人工核对真实主页/头像来源",
        needed: "同一达人主页可核对的真实头像图片；不要用其他达人图片替代" };
    }) };
});
const at = new Date().toISOString();
const dir = path.join(root, "source-gaps");
await mkdir(dir, { recursive: true });
const file = path.join(dir, `${at.replace(/[:.]/g, "-")}.json`);
await writeFile(file, JSON.stringify({ at, auditAt: final.at, sourceAuditAt: source.at, result }, null, 2));
console.log(JSON.stringify({ totalMissing: result.reduce((sum: number, store: any) => sum + store.count, 0), evidence: file }));
