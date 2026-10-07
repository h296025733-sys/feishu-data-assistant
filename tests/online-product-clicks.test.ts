import { describe, expect, it, vi } from "vitest";
import { listRecentOnlineProductClickCandidates, parseVideoProductClicksDetail, parseVideoDetailMetrics, syncOnlineVideoProductClicks } from "../src/automation/online-product-clicks.js";
import type { TikTokMachineContract } from "../src/realtime/types.js";
import type { BusinessProfile } from "../src/config/business-profile.js";
import type { AppEnv } from "../src/config/env.js";
import type { StorefourDemoGateway } from "../src/feishu/storefour-demo-gateway.js";

vi.mock("../src/realtime/tiktok-cli.js", () => ({
  fetchTikTokAnalytics: vi.fn(async (_dataset: string, start: string, endExclusive: string) => {
    const contract = detail(4);
    contract.rows[0] = { performance: { intervals: [{ start_date: start, end_date: endExclusive,
      traffic: { views: 3210 }, sales: { overall: { product_clicks: 4, items_sold: 2,
        gmv: { amount: "4.55", currency: "USD" } } } }] } };
    return contract;
  }),
  tikTokRuntimeFromProfile: vi.fn(() => ({})),
}));

function detail(clicks: unknown): TikTokMachineContract {
  return {
    ok: true,
    dataset: "shop_video_performance_detail",
    shop: { id: "shop-a" },
    window_start: "2026-09-01",
    window_end_exclusive: "2026-09-27",
    fetched_at: "2026-09-28T00:00:00Z",
    rows: [{ performance: { intervals: [{ start_date: "2026-09-01", end_date: "2026-09-27",
      sales: { overall: { product_clicks: clicks } } }] } }],
    row_count: 1,
    exact_duplicate_count: 0,
    conflicting_duplicate_ids: [],
    request_ids: ["native-request-id"],
    raw_source_paths: [],
    normalized_source_path: null,
    required_scope: [],
    granted_scope: [],
    missing_capabilities: [],
    errors: [],
    latest_available_date: "2026-09-26",
  };
}

describe("video product clicks detail", () => {
  it("uses views rather than product impressions and preserves real zero USD sales in detail fallback", () => {
    const sample = detail(58);
    sample.rows[0] = { performance: { intervals: [{ start_date: "2026-09-01", end_date: "2026-09-27",
      traffic: { views: 921 }, sales: { overall: { product_clicks: 58, product_impressions: 1033,
        items_sold: 0, gmv: { amount: "0.00", currency: "USD" } } } }] } };
    expect(parseVideoDetailMetrics(sample, "1234567890123456789", "2026-09-01", "2026-09-27"))
      .toEqual({ 商品点击量: 58, 视频曝光K: 0.921, 售出数量: 0, 销售额: 0 });
    expect(() => parseVideoDetailMetrics(detail(3), "1234567890123456789", "2026-09-01", "2026-09-27"))
      .toThrow("保留原值");
  });
  it("preserves a real zero and parses a positive integer", () => {
    expect(parseVideoProductClicksDetail(detail(0), "1234567890123456789", "2026-09-01", "2026-09-27")).toBe(0);
    expect(parseVideoProductClicksDetail(detail("23"), "1234567890123456789", "2026-09-01", "2026-09-27")).toBe(23);
  });

  it("does not fabricate zero from blank or accept CTR as a count", () => {
    expect(() => parseVideoProductClicksDetail(detail(null), "1234567890123456789", "2026-09-01", "2026-09-27")).toThrow("缺失");
    expect(() => parseVideoProductClicksDetail(detail(0.034), "1234567890123456789", "2026-09-01", "2026-09-27")).toThrow("非有效整数");
  });

  it("rejects the wrong interval or incomplete API response", () => {
    expect(() => parseVideoProductClicksDetail(detail(3), "1234567890123456789", "2026-09-02", "2026-09-27")).toThrow("日期区间");
    const missingRequest = detail(3);
    missingRequest.request_ids = [];
    expect(() => parseVideoProductClicksDetail(missingRequest, "1234567890123456789", "2026-09-01", "2026-09-27")).toThrow("不完整");
    const stale = detail(3);
    stale.latest_available_date = "2026-09-25";
    expect(() => parseVideoProductClicksDetail(stale, "1234567890123456789", "2026-09-01", "2026-09-27")).toThrow("未覆盖2026-09-26");
  });

  it.each([false, true])("preserves managed-only writes and readback with text columns=%s", async (textColumns: boolean) => {
    const id = "1234567890123456789";
    const fields: Record<string, unknown> = {
      视频上线地址: textColumns ? `https://www.tiktok.com/@test/video/${id}` : { link: `https://www.tiktok.com/@test/video/${id}` },
      商品点击量: 1,
      备注: "人工内容不变",
    };
    const gateway = { snapshotOnlineByVideoIds: vi.fn(async (ids: string[]) => new Map(ids.map((videoId) => [videoId, {
      recordId: "rec-1", tableId: "tbl-1", tableName: "红人上线表", fields: { ...fields }, lastModifiedTime: 1,
    }])) ) } as unknown as StorefourDemoGateway;
    const batchUpdate = vi.fn(async (input: { data: { records: Array<{ fields: Record<string, unknown> }> } }) => {
      Object.assign(fields, input.data.records[0]?.fields);
      return { code: 0, data: { records: input.data.records } };
    });
    const client = { bitable: {
      appTableField: { list: async () => ({ code: 0, data: { items: ["商品点击量", "视频曝光K", "售出数量", "销售额"]
        .map((field_name) => ({ field_name, type: textColumns && field_name === "视频曝光K" ? 1 : 2, property: { formatter: "0" } })) } }) },
      appTableRecord: { batchUpdate },
    } };
    const result = await syncOnlineVideoProductClicks({
      candidates: [{ video: { id, date: "2026-09-01" }, endExclusive: "2026-09-27" }],
      profile: { businessTimeZone: "Asia/Shanghai", tiktok: { shopTimeZone: "America/Los_Angeles", shopId: "shop-a" } } as BusinessProfile,
      env: { FEISHU_BITABLE_APP_TOKEN: "base-a" } as AppEnv,
      client: client as never,
      gateway,
    });
    expect(result).toMatchObject({ queried: 1, updated: 1, unchanged: 0 });
    expect(batchUpdate).toHaveBeenCalledOnce();
    expect(batchUpdate.mock.calls[0]?.[0].data.records[0]?.fields).toEqual({ 商品点击量: 4 });
    expect(fields.备注).toBe("人工内容不变");
    const fallbackInput = {
      candidates: [{ video: { id, date: "2026-09-01" }, endExclusive: "2026-09-27" }],
      profile: { businessTimeZone: "Asia/Shanghai", tiktok: { shopTimeZone: "America/Los_Angeles", shopId: "shop-a" } } as BusinessProfile,
      env: { FEISHU_BITABLE_APP_TOKEN: "base-a" } as AppEnv, client: client as never, gateway, refreshMetrics: true,
    };
    const fallback = await syncOnlineVideoProductClicks(fallbackInput);
    expect(fallback.updated).toBe(1);
    expect(batchUpdate.mock.calls[1]?.[0].data.records[0]?.fields)
      .toEqual({ 商品点击量: 4, 视频曝光K: textColumns ? "3.21" : 3.21, 售出数量: 2, 销售额: 4.55 });
    expect(fields.备注).toBe("人工内容不变");
    expect((await syncOnlineVideoProductClicks(fallbackInput)).unchanged).toBe(1);
    expect(batchUpdate.mock.calls).toHaveLength(2);
  });

  it("selects the same bounded 14-day publish cohort without the broken video-list API", async () => {
    const makeRow = (id: string, date: string) => ({ fields: {
      视频上线地址: { link: `https://www.tiktok.com/@creator/video/${id}` },
      "实上线日期(Ct)": Date.parse(`${date}T12:00:00Z`),
    } });
    const client = { bitable: {
      appTable: { list: async () => ({ code: 0, data: { items: [{ name: "红人上线表", table_id: "tbl-1" }] } }) },
      appTableRecord: { list: async () => ({ code: 0, data: { items: [
        makeRow("1111111111111111111", "2026-09-12"),
        makeRow("2222222222222222222", "2026-09-20"),
        makeRow("3333333333333333333", "2026-09-28"),
      ], has_more: false } }) },
    } };
    const result = await listRecentOnlineProductClickCandidates({
      latestCompleteShopDate: "2026-09-26", probeDays: 14,
      profile: { tables: { online: "红人上线表" }, businessTimeZone: "Asia/Shanghai" } as BusinessProfile,
      env: { FEISHU_BITABLE_APP_TOKEN: "base-a" } as AppEnv,
      client: client as never,
    });
    expect(result.map((item) => item.video.id)).toEqual(["2222222222222222222"]);
    expect(result[0]?.endExclusive).toBe("2026-09-27");
  });
});
