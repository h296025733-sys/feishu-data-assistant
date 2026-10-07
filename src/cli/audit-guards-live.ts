import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";
import { RoiRecordGuardService } from "../feishu/roi-record-guard.js";
import { CooperationOnlineProgressService } from "../feishu/cooperation-online-progress.js";
const results = [];
for (const tenant of new TenantRegistry(getEnv()).all()) {
  const client = createFeishuClient(tenant.env);
  const roi = await new RoiRecordGuardService(tenant.env, client, tenant.profile).preview();
  const cooperation = await new CooperationOnlineProgressService(tenant.env, client, tenant.profile).preview();
  results.push({ tenant: tenant.binding.id, cooperationDateField: tenant.profile.cooperationDateField ?? "合作时间",
    roi: { records: roi.records, pendingProducts: roi.missingProductDates.length, pendingStore: roi.missingStoreDates.length,
      duplicateKeys: roi.duplicateKeys, created: roi.created },
    cooperation: { records: cooperation.cooperationRecords, online: cooperation.onlineRecords,
      pendingUpdates: cooperation.pendingUpdates, updated: cooperation.updated },
  });
}
const root = path.resolve(".runtime/schedule-repair-2026-09-28");
await mkdir(root, { recursive: true });
const evidence = { checkedAt: new Date().toISOString(), mode: "formal read-only; no timers, no writes", results };
await writeFile(path.join(root, "guard-live-preview.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
