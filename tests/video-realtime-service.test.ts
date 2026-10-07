import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RealtimeVideoAnalysisService } from "../src/video-analysis/realtime-service.js";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "video-realtime-test-")); temporary.push(dir);
  const file = path.join(dir, "state.json");
  const service: any = new RealtimeVideoAnalysisService([], () => false, file);
  service.targets.set("tenant", { config: { appToken: "base", tables: { online: "online", account: "account" } }, sourceFields: ["url", "product"] });
  const row = (id = "1234567890123456789", fields = {}) => ({ record_id: "rec", fields: {
    视频上线地址: `https://www.tiktok.com/@creator/video/${id}`, 挂车产品: "商品", ...fields,
  } });
  return { service, row, file };
}
describe("realtime video durable queue (isolated, no live API/model)", () => {
  it("seeds old rows without recharging; detects a later new URL exactly once", () => {
    const { service, row } = fixture();
    service.observe("tenant", row(), true);
    expect(Object.keys(service.state.jobs)).toHaveLength(0);
    service.observe("tenant", row("2234567890123456789"), false);
    service.observe("tenant", row("2234567890123456789"), false);
    expect(Object.keys(service.state.jobs)).toHaveLength(1);
    expect(service.state.jobs["tenant:2234567890123456789"].state).toBe("queued");
  });
  it("preserves completed and partial manual analyses", () => {
    const { service, row } = fixture();
    service.observe("tenant", row("1234567890123456789", { 视频内容分析: "人工" }), false);
    expect(Object.keys(service.state.jobs)).toHaveLength(0);
    service.observe("tenant", row("2234567890123456789", { 视频内容分析: "完成", 投广建议: "待选投广", 视频修改建议: "已有" }), false);
    expect(Object.keys(service.state.jobs)).toHaveLength(0);
  });
  it("cancels stale video identity, and source edits can wake deferred new jobs", () => {
    const { service, row } = fixture();
    service.observe("tenant", row(), false);
    service.state.jobs["tenant:1234567890123456789"].nextAt = Date.now() + 3600_000;
    service.observe("tenant", row(), false, true);
    expect(service.state.jobs["tenant:1234567890123456789"].nextAt).toBeLessThanOrEqual(Date.now());
    service.observe("tenant", row("2234567890123456789"), false);
    expect(service.state.jobs["tenant:1234567890123456789"].state).toBe("source_changed");
    expect(service.state.jobs["tenant:2234567890123456789"].state).toBe("queued");
  });
  it("persists queued work and recovers interrupted work without discarding it", () => {
    const { service, row, file } = fixture();
    service.observe("tenant", row(), false);
    service.state.jobs["tenant:1234567890123456789"].state = "running";
    service.save();
    const restored: any = new RealtimeVideoAnalysisService([], () => false, file);
    expect(restored.state.jobs["tenant:1234567890123456789"].state).toBe("queued");
    expect(restored.state.seen.tenant.rec).toBe("1234567890123456789");
  });
  it("catches an add notification received during baseline seeding without duplicating its job", () => {
    const { service, row } = fixture();
    service.observe("tenant", row(), true);
    service.observe("tenant", row(), false, true);
    service.observe("tenant", row(), false, true);
    expect(Object.keys(service.state.jobs)).toHaveLength(1);
  });
  it("cancels a deleted row instead of recreating it or retrying forever", () => {
    const { service, row } = fixture();
    service.observe("tenant", row(), false);
    service.handleRecordChanged({ file_token: "base", table_id: "online", action_list: [{ action: "record_deleted", record_id: "rec" }] });
    expect(service.state.jobs["tenant:1234567890123456789"].state).toBe("source_deleted");
  });
  it("drops a queued job when a complete reconciliation no longer contains its source row", async () => {
    const { service, row } = fixture();
    service.observe("tenant", row(), false);
    service.targets.get("tenant").client = { bitable: { appTableRecord: {
      list: async () => ({ code: 0, data: { items: [], has_more: false } }),
    } } };
    await service.reconcile("tenant");
    const job = service.state.jobs["tenant:1234567890123456789"];
    expect(job.state).toBe("source_deleted");
    expect(job.reason).toContain("absent from complete reconciliation");
  });
});
