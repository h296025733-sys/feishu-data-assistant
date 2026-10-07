import { createModelProvider } from "../ai/providers.js";
import { DailyAutomationService } from "../automation/daily-sync.js";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const registry = new TenantRegistry(env);
const client = createFeishuClient(env);
const requestedTenantIds = process.argv.slice(2).map((value) => value.trim()).filter(Boolean);
const tenantIds = requestedTenantIds.length > 0
  ? requestedTenantIds
  : registry.all().map((tenant) => tenant.binding.id);

let failed = false;
for (const tenantId of tenantIds) {
  const tenant = registry.all().find((item) => item.binding.id === tenantId);
  if (!tenant) {
    console.log(JSON.stringify({ tenantId, phase: "failed", ok: false, error: "tenant_not_found" }));
    failed = true;
    continue;
  }

  console.log(JSON.stringify({ tenantId, phase: "starting_resume", at: new Date().toISOString() }));
  try {
    const service = new DailyAutomationService(
      tenant.env,
      client,
      tenant.profile,
      tenantId,
      createModelProvider(tenant.env),
    );
    await service.start();
    const result = await service.resumeIncompleteInitialization();
    const run = result.run;
    console.log(JSON.stringify({
      tenantId,
      phase: "completed",
      ok: Boolean(result.status.completed),
      state: result.status.state,
      range: [result.status.windowStart, result.status.windowEnd],
      online: run ? summarize(run.online) : null,
      roi: run ? summarize(run.roi) : null,
      missingItems: run
        ? [...run.catalog.missingItems, ...run.online.missingItems, ...run.roi.missingItems]
        : [],
    }));
    if (!result.status.completed) failed = true;
  } catch (error) {
    console.log(JSON.stringify({
      tenantId,
      phase: "failed",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    failed = true;
  }
}

process.exitCode = failed ? 1 : 0;

function summarize(result: {
  matched: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  error: string | null;
}): Record<string, number | string | null> {
  return {
    matched: result.matched,
    created: result.created,
    updated: result.updated,
    unchanged: result.unchanged,
    skipped: result.skipped,
    error: result.error,
  };
}
