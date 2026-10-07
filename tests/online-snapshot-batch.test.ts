import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StorefourDemoGateway, type VideoSource } from "../src/feishu/storefour-demo-gateway.js";
import type { AppEnv } from "../src/config/env.js";
import type { BusinessProfile } from "../src/config/business-profile.js";
import { registerTrustedOnlineImport, trustedOnlineImportDate } from "../src/feishu/online-date-trusted-imports.js";

describe("online snapshot batch", () => {
  it("serializes concurrent date registrations without coalescing away different stores' entries", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "trusted-dates-"));
    try {
      const options = { path: path.join(directory, "dates.json"), now: 1000 };
      await Promise.all(Array.from({ length: 5 }, (_, n) => registerTrustedOnlineImport(`store-${n}`, 100 + n, options)));
      for (let n = 0; n < 5; n += 1) expect(await trustedOnlineImportDate(`store-${n}`, options)).toBe(100 + n);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  const ids = Array.from({ length: 50 }, (_, n) => `700000000000000${String(n).padStart(4, "0")}`);
  const records = ids.map((id) => ({ record_id: `rec_${id}`, fields: { 视频上线地址: { link: `https://www.tiktok.com/@creator/video/${id}` }, 备注: "手填不变" } }));
  function gateway(rows = records) {
    let calls = 0;
    const list = async () => { calls += 1; return { code: 0, data: { items: rows, has_more: false } }; };
    const client = { bitable: { appTableRecord: { list } } };
    const instance = new StorefourDemoGateway({ FEISHU_BITABLE_APP_TOKEN: "isolated-test" } as AppEnv, client as never,
      { tables: { online: "红人上线表" } } as BusinessProfile);
    return { instance, calls: () => calls };
  }
  it("reads a 50-video plan in one page and preserves the full snapshot", async () => {
    const { instance, calls } = gateway();
    const result = await instance.snapshotOnlineByVideoIds(ids);
    expect(calls()).toBe(1);
    expect(result.size).toBe(50);
    expect(result.get(ids[0]!)?.fields.备注).toBe("手填不变");
    await instance.snapshotOnlineByVideoIds([]);
    expect(calls()).toBe(1);
  });
  it("rejects duplicates and does not match ID substrings", async () => {
    await expect(gateway([...records, records[0]!]).instance.snapshotOnlineByVideoIds(ids)).rejects.toThrow("出现多次");
    expect((await gateway().instance.snapshotOnlineByVideoId(ids[0]!.slice(0, -1)))).toBeNull();
  });
  it("updates 50 existing videos in one batch, preserves manual fields and reuses the retry token", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "online-batch-"));
    try {
      let reads = 0;
      const calls: any[] = [];
      const client = { bitable: { appTableRecord: {
        list: async () => { reads += 1; return { code: 0, data: { items: records, has_more: false } }; },
        batchUpdate: async (input: any) => {
          calls.push(input);
          if (calls.length === 1) throw { status: 503 };
          return { code: 0, data: { records: input.data.records } };
        },
      } } };
      const instance = new StorefourDemoGateway({ FEISHU_BITABLE_APP_TOKEN: "isolated-test" } as AppEnv, client as never,
        { tables: { online: "红人上线表" } } as BusinessProfile, { trustedImportPath: path.join(directory, "trusted.json") });
      const before = await instance.snapshotOnlineByVideoIds(ids);
      const items = ids.map((id) => ({ before: before.get(id)!, video: {
        id, creator: "creator", date: "2026-09-03", products: ["音箱"], url: `https://www.tiktok.com/@creator/video/${id}`,
        viewsK: 2, itemsSold: 3, gmv: 9, gmvCurrency: "USD", metricWindowStart: "2026-08-01", metricWindowEndExclusive: "2026-09-04",
      } as VideoSource }));
      await instance.syncExistingOnlineBatch(items);
      expect(reads).toBe(2);
      expect(calls).toHaveLength(2);
      expect(calls[0].params.client_token).toBe(calls[1].params.client_token);
      expect(calls[1].data.records).toHaveLength(50);
      for (const row of calls[1].data.records) {
        expect(row.fields).not.toHaveProperty("备注");
        expect(row.fields).not.toHaveProperty("粉丝量");
        expect(row.fields).not.toHaveProperty("登记日期");
        expect(row.fields.视频曝光K).toBe(2);
      }
      await expect(instance.syncExistingOnlineBatch([{ ...items[0]!, before: { ...items[0]!.before, fields: { 备注: "stale" } } }]))
        .rejects.toThrow("写前发生变化");
      expect(calls).toHaveLength(2);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
