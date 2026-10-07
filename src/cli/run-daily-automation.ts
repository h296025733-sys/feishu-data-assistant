import { DailyAutomationService } from "../automation/daily-sync.js";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { loadBusinessProfile } from "../config/business-profile.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";

const rootEnv = requireFeishuEnv(getEnv());
const tenantId = argument("--tenant");
const tenant = tenantId ? new TenantRegistry(rootEnv).byId(tenantId) : null;
if (tenantId && !tenant) throw new Error(`店铺租户不存在或未启用：${tenantId}`);
const env = tenant?.env ?? rootEnv;
const profile = tenant?.profile ?? loadBusinessProfile();
const service = new DailyAutomationService(
  env,
  createFeishuClient(env),
  profile,
  tenant?.binding.id ?? "default",
);
await service.start();
const result = await service.run("manual_test");
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
  return value || null;
}
