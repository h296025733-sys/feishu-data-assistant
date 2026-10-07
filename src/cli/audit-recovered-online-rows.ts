import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";
import { StorefourDemoGateway } from "../feishu/storefour-demo-gateway.js";
import type { OnlineImportPlan, PlannedOnlineVideo } from "../realtime/online-import.js";
import { registerTrustedOnlineImports } from "../feishu/online-date-trusted-imports.js";

const jobs: Record<string, string[]> = {
  "storetwo-formal": ["rt-20260905015228-5346cb06", "rt-20260905015228-d11d78d9", "rt-20260905015228-ef63141f"],
  "storeone-formal": ["rt-20260905015233-277c7978", "rt-20260905015233-0d88b7b2"],
  "storethree-formal": ["rt-20260905015852-e0b796c0"],
  "storetwo-llc-formal": ["rt-20260905020431-cd57837c"],
  "storetwo-botanical-care-formal": ["rt-20260905020427-05680bab"],
};
async function main(): Promise<void> {
  const registry = new TenantRegistry(requireFeishuEnv(getEnv()));
  const results = [];
  const trustedRows: Array<{ recordId: string; expectedDate: number }> = [];
  const manual = ["登记日期", "开发人", "开发人员", "粉丝量", "AD CODE", "佣金", "投放状态", "红人类型", "视频内容", "备注"];
  for (const [tenantId, jobIds] of Object.entries(jobs)) {
    const tenant = registry.byId(tenantId)!;
    const status = JSON.parse(await readFile(path.resolve(".runtime", "tenants", tenantId, "daily-automation", "status.json"), "utf8"));
    if (status.running) throw new Error(`${tenantId}日更尚未空闲`);
    const items = new Map<string, PlannedOnlineVideo>();
    for (const jobId of jobIds) {
      const plan: OnlineImportPlan = JSON.parse(await readFile(path.resolve("backups", "realtime-sync", jobId, "plan.json"), "utf8"));
      const result = JSON.parse(await readFile(path.resolve("backups", "realtime-sync", jobId, "result.json"), "utf8"));
      if (result.concurrencyConflicts?.length) throw new Error(`${jobId}存在并发冲突`);
      for (const item of plan.videos) items.set(item.video.id, item);
    }
    const gateway = new StorefourDemoGateway(tenant.env, createFeishuClient(tenant.env), tenant.profile);
    await gateway.initializeOnlineReadOnly();
    const started = Date.now();
    const after = await gateway.snapshotOnlineByVideoIds([...items.keys()]);
    const errors: string[] = [];
    let protectedExisting = 0;
    for (const [id, item] of items) {
      const actual = after.get(id);
      if (!actual) { errors.push(`${id}:记录缺失`); continue; }
      if (item.before && (item.before.tableId !== actual.tableId || item.before.recordId !== actual.recordId)) {
        errors.push(`${id}:记录归属不一致`); continue;
      }
      const verification = await gateway.verifyOnline(item.video, actual.recordId, actual);
      errors.push(...verification.errors.map((error) => `${id}:${error}`));
      // The date-only column can store noon UTC or Shanghai midnight. Preserve
      // the exact verified wire value rather than inventing a timestamp anchor.
      const verifiedDateValue = Number(actual.fields["实上线日期(Ct)"]);
      if (!Number.isFinite(verifiedDateValue)) errors.push(`${id}:无法登记精确日期基线`);
      else trustedRows.push({ recordId: actual.recordId, expectedDate: verifiedDateValue });
      if (item.before) {
        protectedExisting += 1;
        for (const field of manual) {
          if (JSON.stringify(item.before.fields[field] ?? null) !== JSON.stringify(actual.fields[field] ?? null)) {
            errors.push(`${id}:人工字段“${field}”与留底不同`);
          }
        }
      }
    }
    results.push({ tenantId, videos: items.size, protectedExisting, readAndVerifyMs: Date.now() - started, errors, ok: !errors.length });
  }
  const refreshTrust = process.argv.includes("--refresh-trust") && results.every((row) => row.ok);
  if (refreshTrust) await registerTrustedOnlineImports(trustedRows);
  const evidence = { checkedAt: new Date().toISOString(), evidence: "正式五店上线表只读回查；对照本次写前留底和TikTok确定性计划", refreshedLocalTrustedDates: refreshTrust ? trustedRows.length : 0, ok: results.every((row) => row.ok), results };
  await mkdir(path.resolve("reports", "2026-09-05-bot-recovery"), { recursive: true });
  await writeFile(path.resolve("reports", "2026-09-05-bot-recovery", "online-readback.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.ok) process.exitCode = 1;
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "上线回查失败"); process.exitCode = 1; });
