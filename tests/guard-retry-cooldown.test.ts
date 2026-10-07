import { describe, expect, it, vi } from "vitest";
import { RoiRecordGuardService } from "../src/feishu/roi-record-guard.js";
import { CooperationOnlineProgressService } from "../src/feishu/cooperation-online-progress.js";
import type { BusinessProfile } from "../src/config/business-profile.js";

describe("persistent guard failures", () => {
  it("backs off both guards for at least five minutes rather than retrying a bad field every 800ms", async () => {
    const list = vi.fn(async () => { throw new Error("1254045 FieldNameNotFound"); });
    const env = { FEISHU_APP_ID: "guard-test", FEISHU_BITABLE_APP_TOKEN: "base" } as any;
    const client = { bitable: { appTableRecord: { list } } } as any;
    const profile = { businessDisplayName: "test", businessTimeZone: "Asia/Shanghai", cooperationDateField: "寄样日期" } as BusinessProfile;
    const roi = new RoiRecordGuardService(env, client, profile) as any;
    roi.tableIds = { roi: "roi", cooperation: "cooperation", online: "online" };
    const progress = new CooperationOnlineProgressService(env, client, profile) as any;
    progress.context = { tableIds: { cooperation: "cooperation", online: "online" } };
    for (const service of [roi, progress]) {
      try {
        await service.drain();
        expect(service.retryNotBefore - Date.now()).toBeGreaterThan(290_000);
        const count = list.mock.calls.length;
        clearTimeout(service.timer); service.timer = null;
        await service.drain();
        expect(list.mock.calls.length).toBe(count);
      } finally { clearTimeout(service.timer); }
    }
    const requested = list.mock.calls.map((call: any) => JSON.parse(call[0].params.field_names));
    expect(requested.some((names: string[]) => names.includes("寄样日期"))).toBe(true);
    expect(requested.some((names: string[]) => names.includes("合作时间"))).toBe(false);
  });
});
