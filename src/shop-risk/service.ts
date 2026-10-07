import { mkdir, readFile, writeFile, rename, open, unlink } from "node:fs/promises";
import path from "node:path";
import type { ResolvedTenant } from "../config/tenant-registry.js";
import type { Client } from "@larksuiteoapi/node-sdk";
import { nextDailyRunAt } from "../automation/daily-sync.js";
import { fetchTikTokShopRisks, tikTokRuntimeFromProfile } from "../realtime/tiktok-cli.js";
import { beijingDate, buildRiskCard, reconcile, snapshotSchema, type RiskState, type Source } from "./model.js";
import { RiskTable } from "./table.js";

interface StoreFile {
  version: 1; tenantId: string; appToken: string; tableId: string; enabled: boolean;
  state?: RiskState; recordIds: Record<string, string>;
  prepared: Record<string, { card: Record<string, unknown>; text: string; checkedAt: string; failures: Partial<Record<Source, string>>; tableSynced: boolean }>;
  deliveries: Record<string, Record<string, { messageId: string; at: string }>>;
}
export class ShopRiskService {
  private readonly file: string;
  private readonly table: RiskTable;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private preparationTimer?: NodeJS.Timeout;
  private preparationRetryTimer?: NodeJS.Timeout;
  constructor(private readonly input: {
    tenant: ResolvedTenant; client: Client; groupChatIds: () => readonly string[];
    sendCard: (chat: string, card: Record<string, unknown>, key: string) => Promise<string>;
    now?: () => Date; root?: string; collect?: () => Promise<unknown>;
  }) {
    this.file = path.resolve(input.root ?? ".runtime", "tenants", input.tenant.binding.id, "shop-risk", "state.json");
    this.table = new RiskTable(input.client, input.tenant);
  }
  private now() { return this.input.now?.() ?? new Date(); }
  async install(): Promise<{tableId: string; url: string}> {
    return this.serial(async () => {
      const old = await this.load();
      const tableId = old?.tableId ?? await this.table.install();
      await this.table.verifySchema(tableId);
      await this.table.hideTechnicalKey(tableId);
      await this.save(old ?? { version: 1, tenantId: this.input.tenant.binding.id, appToken: this.input.tenant.env.FEISHU_BITABLE_APP_TOKEN,
        tableId, enabled: true, recordIds: {}, prepared: {}, deliveries: {} });
      return { tableId, url: this.table.url(tableId) };
    });
  }
  async prepare(force = false) {
    return this.serial(async () => {
      const file = await this.load();
      if (!file?.enabled) return { skipped: true, reason: "尚未启用" };
      const date = beijingDate(this.now());
      if (!force && file.prepared[date]?.tableSynced) return { skipped: true, reason: "复用今日已核验快照" };
      if (Object.keys(file.deliveries[date] ?? {}).length) return { skipped: true, reason: "今日已经发送，不改动已发送快照" };
      const cached = file.prepared[date] && !force
        ? JSON.parse(await readFile(path.join(path.dirname(this.file), `snapshot-${date}.json`), "utf8")) : null;
      let raw: unknown;
      try { raw = cached ?? await (this.input.collect?.() ?? fetchTikTokShopRisks(tikTokRuntimeFromProfile(this.input.tenant.profile))); }
      catch (e) {
        const failed = { ok: false, error: errorText(e) };
        raw = { version: 1, shop: { id: this.input.tenant.profile.tiktok.shopId, name: this.input.tenant.profile.businessDisplayName },
          fetchedAt: this.now().toISOString(), evidencePath: "", evidenceSha256: "",
          sources: { products: failed, orders: failed, sps_overview: failed, sps_metrics: failed } };
      }
      const snapshot = snapshotSchema.parse(raw);
      if (snapshot.shop.id !== this.input.tenant.profile.tiktok.shopId) throw new Error("TikTok 风险快照店铺ID不匹配");
      if (beijingDate(new Date(snapshot.fetchedAt)) !== date) throw new Error("风险快照不是本次检查日期");
      const next = reconcile(snapshot, file.state);
      // Persist the baseline before external writes, so a retry cannot reclassify
      // existing findings as newly occurring violations.
      file.state = next.state;
      await this.save(file);
      await this.evidence(`snapshot-${date}`, snapshot);
      let tableSynced = false;
      try {
        const receipt = await this.table.sync(file.tableId, next.state, file.recordIds);
        file.recordIds = receipt.recordIds;
        tableSynced = true;
        await this.evidence(`write-readback-${date}`, receipt);
      } catch (e) {
        await this.evidence(`table-error-${date}`, { error: errorText(e), at: this.now().toISOString() });
        console.error(`[shop-risk-table:${this.input.tenant.binding.id}] ${errorText(e)}`);
      }
      const report = buildRiskCard(this.input.tenant.profile.businessDisplayName, date, next.state, next.failures, this.table.url(file.tableId));
      if (!tableSynced) {
        report.text += "\n提醒表本次更新未完成，请先按本条消息处理。";
        (report.card.elements[0]!.text).content = report.text;
      }
      file.prepared[date] = { ...report, checkedAt: snapshot.fetchedAt, failures: next.failures, tableSynced };
      await this.save(file);
      return { skipped: false, date, tableSynced, issueCount: Object.keys(next.state.issues).length,
        failures: next.failures, text: report.text, evidence: snapshot.evidencePath };
    });
  }
  async repairFromSavedSnapshot() {
    return this.serial(async () => {
      const file = await this.load(); const date = beijingDate(this.now());
      if (!file?.state || !file.prepared[date]) throw new Error("无当日可复用快照");
      if (Object.keys(file.deliveries[date] ?? {}).length) throw new Error("已有送达回执，不修改当日载荷");
      const receipt = await this.table.sync(file.tableId, file.state, file.recordIds);
      file.recordIds = receipt.recordIds;
      await this.evidence(`write-readback-repair-${date}`, receipt);
      const report = buildRiskCard(this.input.tenant.profile.businessDisplayName, date, file.state, file.prepared[date]!.failures, this.table.url(file.tableId));
      file.prepared[date] = { ...file.prepared[date]!, ...report, tableSynced: true };
      await this.save(file);
      return { tableId: file.tableId, created: receipt.created, updated: receipt.updated,
        recordCount: receipt.after.length, manualChangesObserved: receipt.manualChangesObserved,
        skippedDeleted: receipt.skippedDeleted, tableSynced: true };
    });
  }
  async deliver(date: string) {
    return this.serial(async () => {
      const file = await this.load();
      if (!file?.enabled) return { skipped: true };
      const prepared = file.prepared[date];
      if (!prepared || beijingDate(this.now()) !== date) throw new Error("没有当日风险检查快照，拒绝发送旧数据");
      if (this.now().getTime() - Date.parse(prepared.checkedAt) > 8 * 60 * 60_000) throw new Error("风险检查快照已超过8小时，拒绝发送");
      const chats = [...new Set(this.input.groupChatIds())];
      if (chats.length !== 1) throw new Error("未唯一绑定店铺群，拒绝回退发送");
      const chat = chats[0]!;
      const receipts = file.deliveries[date] ?? {};
      if (receipts[chat]) return { skipped: true, ...receipts[chat] };
      const messageId = await this.input.sendCard(chat, prepared.card, `shop-risk:${this.input.tenant.binding.id}:${date}:${chat}`);
      if (!messageId?.trim()) throw new Error("提醒发送没有返回message_id");
      receipts[chat] = { messageId, at: this.now().toISOString() };
      file.deliveries[date] = receipts;
      await this.save(file);
      return { skipped: false, ...receipts[chat] };
    });
  }
  async start() {
    const file = await this.load();
    if (!file?.enabled) return { enabled: false };
    this.schedulePreparation(); this.schedulePreparationRetry(); this.scheduleDelivery();
    const now = this.now(); const minute = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now).replace(":", ""));
    // Recover once after an afternoon restart. Not a high-frequency scanner.
    if (minute >= 1500 && minute < 1750 && !file.prepared[beijingDate(now)]) void this.prepare().catch(e => this.log(e));
    if (minute >= 1756 && minute < 2100) void this.deliverWithRetry(beijingDate(now), 0);
    return { enabled: true, preparationTime: this.preparationTime(), deliveryTime: "17:56", tableId: file.tableId };
  }
  private preparationTime() {
    const ids = ["storetwo-formal", "storeone-formal", "storethree-formal", "storetwo-llc-formal", "storetwo-botanical-care-formal"];
    const i = ids.indexOf(this.input.tenant.binding.id);
    if (i < 0) throw new Error("风险定时未配置该店");
    return `15:${String(i * 5).padStart(2, "0")}`;
  }
  private schedulePreparation() {
    if (this.preparationTimer) clearTimeout(this.preparationTimer);
    const next = nextDailyRunAt(this.now(), this.preparationTime(), "Asia/Shanghai");
    this.preparationTimer = setTimeout(() => {
      this.schedulePreparation();
      void this.prepare(true).then(result => console.log(`[shop-risk-prepare:${this.input.tenant.binding.id}] ${JSON.stringify(result)}`)).catch(e => this.log(e));
    }, Math.max(1000, +next - +this.now()));
    this.preparationTimer.unref();
  }
  private scheduleDelivery() {
    if (this.timer) clearTimeout(this.timer);
    const next = nextDailyRunAt(this.now(), "17:56", "Asia/Shanghai");
    this.timer = setTimeout(() => {
      this.scheduleDelivery();
      void this.deliverWithRetry(beijingDate(this.now()), 0);
    }, Math.max(1000, +next - +this.now()));
    this.timer.unref();
  }
  private schedulePreparationRetry() {
    if (this.preparationRetryTimer) clearTimeout(this.preparationRetryTimer);
    const minute = 40 + Number(this.preparationTime().slice(3)) / 5 * 2;
    const next = nextDailyRunAt(this.now(), `15:${minute}`, "Asia/Shanghai");
    this.preparationRetryTimer = setTimeout(() => {
      this.schedulePreparationRetry();
      void (async () => {
        const file = await this.load(); const prepared = file?.prepared[beijingDate(this.now())];
        // One bounded recovery before business-sync protection, not polling.
        if (!prepared || !prepared.tableSynced || Object.keys(prepared.failures).length) await this.prepare(true);
      })().catch(e => this.log(e));
    }, Math.max(1000, +next - +this.now()));
    this.preparationRetryTimer.unref();
  }
  private async deliverWithRetry(date: string, attempt: number) {
    try { console.log(`[shop-risk-delivery:${this.input.tenant.binding.id}] ${JSON.stringify(await this.deliver(date))}`); }
    catch (e) {
      this.log(e);
      if (attempt < 3 && beijingDate(this.now()) === date) {
        this.retryTimer = setTimeout(() => { void this.deliverWithRetry(date, attempt + 1); }, 5 * 60_000);
        this.retryTimer.unref();
      }
    }
  }
  private log(e: unknown) { console.error(`[shop-risk:${this.input.tenant.binding.id}] ${errorText(e)}`); }
  private async load(): Promise<StoreFile | null> {
    try {
      const file = JSON.parse(await readFile(this.file, "utf8")) as StoreFile;
      if (file.version !== 1 || file.tenantId !== this.input.tenant.binding.id || file.appToken !== this.input.tenant.env.FEISHU_BITABLE_APP_TOKEN) throw new Error("风险状态租户/Base身份不匹配");
      return file;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }
  private async save(value: StoreFile) { await this.atomic(this.file, value); }
  private async evidence(name: string, value: unknown) { await this.atomic(path.join(path.dirname(this.file), `${name}.json`), value); }
  private async atomic(file: string, value: unknown) {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(temp, file);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const lock = `${this.file}.lock`;
      const handle = await acquireRiskLock(lock);
      try { await handle.writeFile(String(process.pid)); return await fn(); }
      finally { await handle.close(); await unlink(lock); }
    });
    this.queue = next.then(() => undefined, () => undefined); return next;
  }
}
function errorText(e: unknown) { return (e instanceof Error ? e.message : String(e)).slice(0, 1500); }

async function acquireRiskLock(lock: string) {
  try { return await open(lock, "wx"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const owner = await readFile(lock, "utf8");
    const pid = Number(owner);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("风险任务锁正在建立或损坏，拒绝并发");
    try { process.kill(pid, 0); throw new Error(`风险任务仍在运行：${pid}`); }
    catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe; }
    if (await readFile(lock, "utf8") !== owner) throw new Error("风险锁身份改变，拒绝清理");
    await unlink(lock);
    return open(lock, "wx");
  }
}
