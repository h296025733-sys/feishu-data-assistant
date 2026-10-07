import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
const root = path.resolve(".runtime/schedule-repair-2026-09-28");
const supervisor = JSON.parse((await readFile(".runtime/bot-control/supervisor-state.json", "utf8")).replace(/^\uFEFF/, ""));
const log = await readFile(supervisor.stdout, "utf8");
const stderr = await readFile(supervisor.stderr, "utf8");
const tenants = [];
for (const tenant of new TenantRegistry(getEnv()).all()) {
  const id = tenant.binding.id;
  const status = JSON.parse(await readFile(path.resolve(".runtime/tenants", id, "daily-automation/status.json"), "utf8"));
  const report = log.split(/\r?\n/).find((line) => line.startsWith(`[prepared-group-report-start:${id}] `));
  tenants.push({ id, enabled: status.enabled, primary: status.localTime, catchUp: status.catchUpLocalTime,
    running: status.running, nextRunAt: status.nextRunAt,
    reportTimer: report ? JSON.parse(report.slice(report.indexOf("] ") + 2)) : null,
    roiGuardStarted: log.includes(`[roi-record-guard:${id}] {`),
    progressGuardStarted: log.includes(`[cooperation-online-progress:${id}] {`),
  });
}
const evidence = { checkedAt: new Date().toISOString(), botPid: supervisor.pid, stdout: supervisor.stdout, stderr: supervisor.stderr,
  wsReadyCount: log.split("ws client ready").length - 1, stderrBytes: Buffer.byteLength(stderr), tenants };
await writeFile(path.join(root, "runtime-final.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
