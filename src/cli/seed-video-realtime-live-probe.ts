import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import { ANALYSIS_FIELDS } from "../video-analysis/storeone-inventory.js";
import { videoAnalysisConfig } from "../video-analysis/storeone-source.js";

// Before first deployment only; uses an already-authorized real pending video.
if (!process.argv.includes("--confirm=ONE-REAL-QUEUE-PROBE")) throw new Error("Confirmation required");
const file = ".runtime/video-analysis-global/realtime-state.json";
if (existsSync(file)) throw new Error("Existing realtime state must not be overwritten");
const id = "storethree-formal";
const recordId = "demo_43439b5e";
const videoId = "7688777690286935310";
const tenant = new TenantRegistry(getEnv()).byId(id)!;
const config = videoAnalysisConfig(id);
if (tenant.env.FEISHU_BITABLE_APP_TOKEN !== config.appToken) throw new Error("Tenant/Base mismatch");
const response = await createFeishuClient(tenant.env).bitable.appTableRecord.get({ path: {
  app_token: config.appToken, table_id: config.tables.online, record_id: recordId,
} });
assertFeishuResponse(response, "Read real queue probe");
const row = response.data?.record;
if (!row || !String(row.fields.视频上线地址).includes(`/video/${videoId}`)
  || ANALYSIS_FIELDS.some(f => row.fields[f] != null && String(row.fields[f]).trim())) throw new Error("Probe row identity/empty analysis changed");
mkdirSync(".runtime/video-analysis-global", { recursive: true });
const now = Date.now();
writeFileSync(file, JSON.stringify({ version: 1, seen: {}, reads: {}, reconciled: {}, errors: {}, jobs: {
  [`${id}:${videoId}`]: { tenant: id, recordId, videoId, queuedAt: now, nextAt: now, attempts: 0, state: "queued",
    reason: "One real existing candidate queue probe; not a synthetic Feishu event" },
} }, null, 2), { flag: "wx" });
console.log(JSON.stringify({ tenant: id, recordId, videoId, scope: "real candidate seeded for queue execution; not yet analyzed" }));
