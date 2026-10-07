import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";
import path from "node:path";
import { assertFeishuResponse, createFeishuClient, feishuErrorDetails } from "../feishu/client.js";
import type { ResolvedTenant } from "../config/tenant-registry.js";
import type { BitableRecordChangeEvent } from "../feishu/contact-duplicate-index.js";
import { ANALYSIS_FIELDS, buildStoreVideoInventory, type VideoInventoryRecord } from "./storeone-inventory.js";
import { videoAnalysisConfig, type VideoAnalysisTenantId } from "./storeone-source.js";
import { REALTIME_SIGNAL, realtimeReportWindow, relevantVideoRecordIds } from "./realtime-policy.js";

interface Job { tenant: string; recordId: string; videoId: string; queuedAt: number; nextAt: number;
  attempts: number; state: string; reason?: string; completedAt?: string; }
interface State { version: 1; seen: Record<string, Record<string, string>>; jobs: Record<string, Job>;
  reads: Record<string, { tenant: string; recordId: string; nextAt: number }>;
  reconciled: Record<string, string>; errors: Record<string, string>; active?: unknown; at?: string; }
const ROOT = ".runtime/video-analysis-global";
const STATE = `${ROOT}/realtime-state.json`;
const TENANTS: VideoAnalysisTenantId[] = ["storeone-formal", "storetwo-formal", "storethree-formal",
  "storetwo-llc-formal", "storetwo-botanical-care-formal"];
function videoId(row: VideoInventoryRecord): string {
  const v = row.fields.视频上线地址;
  const url = typeof v === "string" ? v : v && typeof v === "object" && "link" in v ? String(v.link) : "";
  return url.match(/^https:\/\/(?:www\.)?tiktok\.com\/@[^/]+\/video\/(\d{19})(?:[/?#]|$)/i)?.[1] ?? "";
}
export class RealtimeVideoAnalysisService {
  private state: State;
  private targets = new Map<string, { tenant: ResolvedTenant; config: ReturnType<typeof videoAnalysisConfig>;
    client: ReturnType<typeof createFeishuClient>; sourceFields: string[] }>();
  private ticking = false;
  private active = false;
  private ready = false;
  private reconcileRequests = new Set<string>();
  private nextReconcile = new Map<string, number>();
  constructor(tenants: ResolvedTenant[], private busy: () => boolean, private stateFile = STATE) {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    this.state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {
      version: 1, seen: {}, jobs: {}, reads: {}, reconciled: {}, errors: {},
    };
    // Interrupted jobs remain queued; the persisted per-tenant runner lock protects orphan children.
    for (const job of Object.values(this.state.jobs)) if (job.state === "running") job.state = "queued";
    delete this.state.active;
    for (const tenant of tenants) {
      const id = tenant.binding.id as VideoAnalysisTenantId;
      if (!TENANTS.includes(id)) continue;
      const config = videoAnalysisConfig(id);
      if (tenant.env.FEISHU_BITABLE_APP_TOKEN !== config.appToken) throw new Error(`Video tenant/base mismatch ${id}`);
      this.targets.set(id, { tenant, config, client: createFeishuClient(tenant.env), sourceFields: [] });
    }
  }
  private save(): void {
    this.state.at = new Date().toISOString();
    const temp = `${this.stateFile}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state, null, 2)); renameSync(temp, this.stateFile);
  }
  async start(): Promise<void> {
    for (const id of this.targets.keys()) this.reconcileRequests.add(id);
    this.ready = true;
    setInterval(() => { void this.tick(); }, 15_000).unref();
    await this.tick();
    console.log(`[video-realtime-start] ${JSON.stringify({ tenants: [...this.targets.keys()], debounceSeconds: 3,
      dispatchSeconds: 15, dailyReconciliation: "15:50 Asia/Shanghai", model: "gpt-5.6-sol/medium/fast",
      reportProtection: "17:45-18:05 + active daily sync", enabled: true })}`);
  }
  handleRecordChanged(event: BitableRecordChangeEvent): void {
    for (const [id, t] of this.targets) {
      if (event.file_token === t.config.appToken && event.table_id === t.config.tables.online) {
        for (const action of event.action_list ?? []) {
          if (!/delete/i.test(action.action ?? "") || !action.record_id) continue;
          delete this.state.reads[`${id}:${action.record_id}`];
          for (const job of Object.values(this.state.jobs)) if (job.tenant === id && job.recordId === action.record_id) {
            job.state = "source_deleted"; job.reason = "Source row deleted; never recreate it";
          }
          this.save();
        }
      }
      const ids = relevantVideoRecordIds(event, t.config.appToken, t.config.tables.online, t.sourceFields);
      for (const recordId of ids) this.state.reads[`${id}:${recordId}`] = { tenant: id, recordId, nextAt: Date.now() + 3000 };
      if (ids.length) { this.save(); console.log(`[video-realtime-event:${id}] ${JSON.stringify({ records: ids.length })}`); }
    }
  }
  requestReconciliation(id: string): void { if (this.targets.has(id)) this.reconcileRequests.add(id); }
  private observe(id: string, row: VideoInventoryRecord, baseline: boolean, sourceEvent = false): void {
    const t = this.targets.get(id)!;
    const vid = videoId(row);
    const known = this.state.seen[id] ??= {};
    const key = `${id}:${vid}`;
    const changed = known[row.record_id] !== vid;
    if (changed && known[row.record_id]) {
      const oldJob = this.state.jobs[`${id}:${known[row.record_id]}`];
      if (oldJob && oldJob.recordId === row.record_id) { oldJob.state = "source_changed"; oldJob.reason = "Video URL changed"; }
    }
    known[row.record_id] = vid;
    if (!vid) return;
    const filled = ANALYSIS_FIELDS.some(name => row.fields[name] != null && String(row.fields[name]).trim() !== "");
    if (filled) {
      if (this.state.jobs[key]) { this.state.jobs[key].state = "protected_or_complete"; this.state.jobs[key].reason = "Existing analysis preserved"; }
      return;
    }
    if (baseline || (!sourceEvent && !changed && !this.state.jobs[key])) return;
    const inventory = buildStoreVideoInventory({ [t.config.tables.online]: [row], [t.config.tables.account]: [] }, t.config.tables);
    if (!inventory.pending.length) return;
    const prior = this.state.jobs[key];
    if (prior?.state === "complete" || prior?.state === "protected_or_complete") return;
    if (!prior) this.state.jobs[key] = { tenant: id, recordId: row.record_id, videoId: vid,
      queuedAt: Date.now(), nextAt: Date.now(), attempts: 0, state: "queued" };
    else if (sourceEvent && prior.state === "queued") prior.nextAt = Date.now();
  }
  private async reconcile(id: string): Promise<void> {
    const t = this.targets.get(id)!;
    const p = { app_token: t.config.appToken, table_id: t.config.tables.online };
    if (!t.sourceFields.length) {
      const fields = await t.client.bitable.appTableField.list({ path: p, params: { page_size: 100 } });
      assertFeishuResponse(fields, "Realtime video fields");
      if (fields.data?.has_more) throw new Error("Incomplete realtime video schema");
      t.sourceFields = (fields.data?.items ?? []).filter(f => ["视频上线地址", "挂车产品"].includes(f.field_name ?? ""))
        .map(f => f.field_id!).filter(Boolean);
      if (t.sourceFields.length !== 2) throw new Error("Realtime URL/product fields missing");
    }
    const baseline = !this.state.seen[id];
    const rows: VideoInventoryRecord[] = [];
    const pages = new Set<string>(); let next: string | undefined;
    do {
      const page = await t.client.bitable.appTableRecord.list({ path: p, params: { page_size: 500, page_token: next } });
      assertFeishuResponse(page, "Realtime daily reconciliation");
      rows.push(...page.data?.items as VideoInventoryRecord[] ?? []);
      if (!page.data?.has_more) break;
      next = page.data.page_token;
      if (!next || pages.has(next)) throw new Error("Realtime pagination loop");
      pages.add(next);
    } while (true);
    this.state.seen[id] ??= {};
    const liveRecordIds = new Set(rows.map(row => row.record_id));
    for (const job of Object.values(this.state.jobs)) {
      if (job.tenant !== id || job.state !== "queued" || liveRecordIds.has(job.recordId)) continue;
      job.state = "source_deleted";
      job.reason = "Source row absent from complete reconciliation; never recreate it";
    }
    for (const row of rows) this.observe(id, row, baseline);
    this.state.reconciled[id] = new Date().toISOString(); this.save();
  }
  private locksBusy(id: string): boolean {
    const dir = `.runtime/${id.replace(/-formal$/, "")}-video-analysis`;
    if (!existsSync(dir)) return false;
    return readdirSync(dir).filter(f => /^runner.*\.lock$/.test(f)).some(f => {
      try { const pid = JSON.parse(readFileSync(path.join(dir, f), "utf8")).pid; process.kill(pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    });
  }
  private async run(job: Job): Promise<void> {
    this.active = true; job.state = "running"; job.attempts++;
    this.state.active = { tenant: job.tenant, videoId: job.videoId, startedAt: new Date().toISOString() }; this.save();
    const log = openSync(`${ROOT}/realtime-worker.log`, "a");
    try {
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "src/cli/run-storeone-video-analysis.ts",
          "--tenant", job.tenant, "--table", "online", "--realtime", "--video-ids", job.videoId,
          "--max-videos", "1", "--max-candidates", "1"], { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", log, log] });
        child.on("error", reject); child.on("close", value => resolve(value ?? 1));
      });
      const t = this.targets.get(job.tenant)!;
      const result = await t.client.bitable.appTableRecord.get({ path: { app_token: t.config.appToken,
        table_id: t.config.tables.online, record_id: job.recordId } });
      if (result.code === 1254043) {
        job.state = "source_deleted"; job.reason = "Source row deleted; never recreate it";
      } else {
        assertFeishuResponse(result, "Realtime video result readback");
        const row = result.data?.record as VideoInventoryRecord | undefined;
        if (!row || videoId(row) !== job.videoId) {
          job.state = "source_changed"; job.reason = "Record missing or video ID changed; no overwrite";
        } else if (ANALYSIS_FIELDS.every(f => row.fields[f] != null && String(row.fields[f]).trim())) {
          job.state = "complete"; job.completedAt = new Date().toISOString(); delete job.reason;
        } else if (ANALYSIS_FIELDS.some(f => row.fields[f] != null && String(row.fields[f]).trim())) {
          job.state = "protected_or_complete"; job.reason = "Partial manual analysis preserved";
        } else {
          const file = `.runtime/${job.tenant.replace(/-formal$/, "")}-video-analysis/jobs/${t.config.tables.online}-${job.videoId}/status.json`;
          const status = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
          job.state = "queued"; job.reason = status.reason ?? status.state ?? `worker exit ${code}`;
          job.nextAt = Math.max(Date.now() + (code === 2 ? 30_000 : Math.min(24 * 60, 5 * 3 ** Math.min(5, job.attempts - 1)) * 60_000), Date.parse(status.retryAfter) || 0);
        }
      }
      console.log(`[video-realtime-result:${job.tenant}] ${JSON.stringify({ videoId: job.videoId, state: job.state, reason: job.reason })}`);
    } catch (error) {
      if (job.state !== "source_deleted") {
        job.state = "queued"; job.reason = feishuErrorDetails(error).message; job.nextAt = Date.now() + 15 * 60_000;
      }
    } finally { closeSync(log); this.active = false; delete this.state.active; this.save(); }
  }
  async tick(): Promise<void> {
    if (!this.ready || this.ticking) return;
    this.ticking = true;
    try {
      const local = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
      const [h, m] = local.split(":").map(Number); const minute = h * 60 + m;
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
      const busy = this.busy() || realtimeReportWindow(minute) || existsSync(".runtime/bot-control/maintenance.pause");
      if (!busy) {
        for (const id of this.targets.keys()) {
          const last = this.state.reconciled[id];
          const lastDay = last ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(last)) : "";
          if (minute >= 15 * 60 + 50 && lastDay !== day) this.reconcileRequests.add(id);
          if (!this.reconcileRequests.has(id) || (this.nextReconcile.get(id) ?? 0) > Date.now()) continue;
          try { await this.reconcile(id); this.reconcileRequests.delete(id); delete this.state.errors[id]; }
          catch (error) { this.state.errors[id] = feishuErrorDetails(error).message; this.nextReconcile.set(id, Date.now() + 30 * 60_000); this.save(); }
        }
        for (const [key, read] of Object.entries(this.state.reads).filter(([, r]) => r.nextAt <= Date.now()).slice(0, 20)) {
          const t = this.targets.get(read.tenant)!;
          try {
            const result = await t.client.bitable.appTableRecord.get({ path: { app_token: t.config.appToken,
              table_id: t.config.tables.online, record_id: read.recordId } });
            if (result.code === 1254043) { delete this.state.reads[key]; continue; }
            assertFeishuResponse(result, "Realtime changed video");
            if (result.data?.record) this.observe(read.tenant, result.data.record as VideoInventoryRecord, false, true);
            delete this.state.reads[key];
          } catch (error) { read.nextAt = Date.now() + 15 * 60_000; this.state.errors[read.tenant] = feishuErrorDetails(error).message; }
          this.save();
        }
      }
      const due = Object.values(this.state.jobs).filter(j => j.state === "queued" && j.nextAt <= Date.now()).sort((a, b) => b.queuedAt - a.queuedAt);
      writeFileSync(`${REALTIME_SIGNAL}.tmp`, JSON.stringify({ until: (due.length || this.active) && !busy ? Date.now() + 90_000 : 0 }));
      renameSync(`${REALTIME_SIGNAL}.tmp`, REALTIME_SIGNAL);
      if (busy || this.active || freemem() < 5 * 1024 ** 3 || !due.length) return;
      // Wait for every backfill worker to yield, not merely this store's worker.
      if (TENANTS.some(id => this.locksBusy(id))) return;
      void this.run(due[0]);
    } catch (error) { console.error(`[video-realtime] ${feishuErrorDetails(error).message}`); }
    finally { this.ticking = false; }
  }
}
