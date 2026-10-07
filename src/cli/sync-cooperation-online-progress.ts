import { getEnv } from "../config/env.js";
import { TenantRegistry, type ResolvedTenant } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";
import { CooperationOnlineProgressService } from "../feishu/cooperation-online-progress.js";

const apply = process.argv.includes("--apply");
const requested = argumentValues("--tenant");
const registry = new TenantRegistry(getEnv());
const tenants = requested.length > 0
  ? requested.map((tenantId) => requireTenant(registry, tenantId))
  : registry.all();

for (const tenant of tenants) {
  const service = new CooperationOnlineProgressService(
    tenant.env,
    createFeishuClient(tenant.env),
    tenant.profile,
  );
  const result = apply
    ? await service.reconcileNow("cli_apply")
    : await service.preview("cli_preview");
  console.log(JSON.stringify({
    tenantId: tenant.binding.id,
    store: tenant.profile.businessDisplayName,
    mode: apply ? "apply" : "preview",
    ...result,
  }, null, 2));
}

function argumentValues(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]!);
  }
  return values;
}

function requireTenant(registry: TenantRegistry, tenantId: string): ResolvedTenant {
  const tenant = registry.byId(tenantId);
  if (!tenant) throw new Error(`租户不存在或未启用：${tenantId}`);
  return tenant;
}
