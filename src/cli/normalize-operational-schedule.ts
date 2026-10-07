import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { readTenantRuntimeSettings, writeTenantRuntimeSettings } from "../config/tenant-runtime-settings.js";

const apply = process.argv.includes("--apply");
if (apply && !process.argv.includes("--confirm=STAGGER-REPORT-SCHEDULE")) throw new Error("Missing schedule confirmation");
const registry = new TenantRegistry(getEnv());
const rows = [];
for (const tenant of registry.all()) {
  const id = tenant.binding.id;
  const profile = tenant.profile.dailyAutomation;
  if (!profile?.reportPreparationLocalTime) throw new Error(`${id}: missing explicit schedule`);
  if (!(profile.localTime < profile.reportPreparationLocalTime
    && profile.reportPreparationLocalTime < (profile.reportLocalTime ?? "17:55")
    && (profile.catchUpLocalTime ?? "") > (profile.reportLocalTime ?? "17:55"))) throw new Error(`${id}: invalid ordering`);
  const previous = await readTenantRuntimeSettings(id);
  const state = JSON.parse(await readFile(path.resolve(".runtime", "tenants", id, "daily-automation/status.json"), "utf8"));
  if (apply && state.running) throw new Error(`${id}: live sync is busy; do not reconfigure`);
  rows.push({ id, previous, enabled: previous?.dailyAutomation.enabled ?? profile.enabled,
    primary: profile.localTime, preflight: profile.reportPreparationLocalTime,
    delivery: profile.reportLocalTime, catchUp: profile.catchUpLocalTime, running: state.running });
}
if (new Set(rows.map((r) => r.primary)).size !== rows.length) throw new Error("Primary schedules are not staggered");
if (apply) {
  const root = path.resolve(".runtime/schedule-repair-2026-09-28");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, `before-${Date.now()}.json`), JSON.stringify(rows, null, 2));
  for (const row of rows) {
    await writeTenantRuntimeSettings(row.id, { enabled: row.enabled, localTime: row.primary,
      updatedBy: "user-authorized-stagger-report-schedule-2026-09-28" });
  }
}
console.log(JSON.stringify({ applied: apply, changesRequireSingletonReload: apply, rows }, null, 2));
