import { describe, expect, it } from "vitest";
import { buildRiskCard, detectIssues, reconcile, type Snapshot } from "../src/shop-risk/model.js";

function snapshot(): Snapshot { return { version: 1, shop: { id: "1", name: "Shop" }, fetchedAt: "2026-09-30T07:00:00Z",
  evidencePath: "test", evidenceSha256: "abc", sources: { products: { ok: true, rows: [] }, orders: { ok: true, rows: [] },
    sps_overview: { ok: true, response: { data: { sps_tier: "GOOD", sps_score: "4.4", update_time: 1790748000 } } },
    sps_metrics: { ok: true, response: { data: { metrics: [] } } } } }; }
describe("shop risk evidence and delta", () => {
  it("only explicit SKU platform violation is red; seller deactivation ignored, audit FAILED is not violation", () => {
    const s = snapshot();
    s.sources.products.rows = [{ id: "1", title: "A", status: "SELLER_DEACTIVATED", skus: [{ id: "2", status_info: { status: "DEACTIVATED", deactivation_source: "SELLER" } }] },
      { id: "3", status: "PLATFORM_DEACTIVATED", audit: { status: "FAILED" }, skus: [{ id: "4", status_info: { status: "DEACTIVATED", deactivation_source: "PLATFORM" } }] }];
    const result = detectIssues(s);
    expect(result.issues.filter(i => i.level === "明确违规")).toHaveLength(1);
    expect(result.issues.filter(i => i.source === "products")).toHaveLength(3);
  });
  it("baselines old findings, deduplicates days and keeps failed source unresolved", () => {
    const s = snapshot(); s.sources.products.rows = [{ id: "3", status: "FREEZE" }];
    const first = reconcile(s).state;
    expect(first.issues["product:3:restricted"]?.baseline).toBe(true);
    s.fetchedAt = "2026-10-01T07:00:00Z";
    s.sources.products.rows!.push({ id: "4", status: "FREEZE" });
    const second = reconcile(s, first).state;
    expect(second.issues["product:4:restricted"]?.baseline).toBe(false);
    const card = buildRiskCard("Test", "2026-10-01", second, {}, "https://example.com");
    expect(card.text).toContain("新发现/再次出现 1 项");
    expect(card.text).not.toContain("不等同于后台全部违规");
    s.sources.products = { ok: false, error: "timeout" };
    const failed = reconcile(s, second);
    expect(failed.state.issues["product:4:restricted"]?.status).toBe("待复核");
    s.sources.products = { ok: true, rows: [] };
    expect(reconcile(s, failed.state).state.issues["product:4:restricted"]?.status).toBe("已不再检出");
  });
  it("does not infer zero from malformed source or missing order deadlines", () => {
    const s = snapshot(); s.sources.products = { ok: true };
    s.sources.orders.rows = [{ id: "5", status: "AWAITING_SHIPMENT" }];
    expect(Object.keys(detectIssues(s).failures)).toEqual(["products", "orders"]);
  });
  it("uses phase-specific deadline and excludes platform fulfillment", () => {
    const s = snapshot(); const now = Date.parse(s.fetchedAt) / 1000;
    s.sources.orders.rows = [
      { id: "1", status: "AWAITING_SHIPMENT", rts_sla_time: now - 1 },
      { id: "2", status: "AWAITING_COLLECTION", rts_sla_time: now - 1, tts_sla_time: now + 7200 },
      { id: "3", status: "AWAITING_COLLECTION", tts_sla_time: now + 172800 },
      { id: "4", status: "AWAITING_SHIPMENT", rts_sla_time: now - 1, fulfillment_type: "FULFILLMENT_BY_TIKTOK" },
    ];
    const result = detectIssues(s).issues.filter(i => i.source === "orders");
    expect(result).toHaveLength(2);
    expect(result.map(i => i.level)).toEqual(["需处理", "关注"]);
    expect(result[1]?.content).toContain("揽收");
  });
  it("SPS percentages use API percent units, not multiplied by 100", () => {
    const s = snapshot(); s.sources.sps_metrics.response!.data.metrics = [{ metric_code: "NRR", status: "POOR", value: "1.86", value_unit: "PERCENT", evaluate_duration_days: 60, end_evaluation_time: 1790748000 }];
    expect(detectIssues(s).issues.find(i => i.key === "sps:metric:NRR")?.content).toContain("1.86%");
  });
  it("rejects cross-store state and keeps a no-score shop unknown, not zero", () => {
    const s = snapshot(); const first = reconcile(s).state;
    s.shop.id = "2"; expect(() => reconcile(s, first)).toThrow("身份");
    s.sources.sps_overview.response!.data = { sps_tier: "NIL", sps_score: "" };
    expect(detectIssues(s).issues).toHaveLength(0);
  });
  it("detects real score decline only on newer source update", () => {
    const s = snapshot(); const first = reconcile(s).state;
    s.sources.sps_overview.response!.data.sps_score = "4.3";
    expect(detectIssues(s, first).issues[0]?.level).toBe("信息");
    s.sources.sps_overview.response!.data.update_time += 86400;
    expect(detectIssues(s, first).issues[0]?.content).toContain("下降");
  });
  it("does not say no issues when known ongoing findings exist", () => {
    const s = snapshot(); s.sources.products.rows = [{ id: "7", status: "FREEZE" }];
    const result = reconcile(s);
    const card = buildRiskCard("Test", "2026-09-30", result.state, {}, "https://example.com");
    expect(card.text).toContain("仍需关注 1 项");
    expect(card.text).not.toContain("未发现新增异常");
  });
});
