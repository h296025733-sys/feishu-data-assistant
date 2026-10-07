import { getEnv, requireFeishuEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";
import { executeRollback, FeishuRealtimeGateway } from "../realtime/feishu-video-sync.js";

const args = parseArgs(process.argv.slice(2));
const jobId = String(args["job-id"] ?? "");
const confirmation = String(args.confirm ?? "");
const tenantId = String(args.tenant ?? "").trim();
if (!jobId || !confirmation) {
  throw new Error("用法：--job-id <job_id> --confirm ROLLBACK-<job_id> [--tenant <tenant_id>]");
}
const rootEnv = getEnv();
const env = tenantId
  ? (() => {
      const tenant = new TenantRegistry(rootEnv).byId(tenantId);
      if (!tenant) throw new Error(`店铺租户不存在或未启用：${tenantId}`);
      return requireFeishuEnv(tenant.env);
    })()
  : requireFeishuEnv(rootEnv);
const gateway = new FeishuRealtimeGateway(env, createFeishuClient(env));
const result = await executeRollback(jobId, confirmation, gateway);
console.log(JSON.stringify(result, null, 2));

function parseArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.replace(/^--/, "");
    const value = values[index + 1];
    if (!key || value == null) throw new Error(`参数格式无效：${values[index] ?? ""}`);
    parsed[key] = value;
  }
  return parsed;
}
