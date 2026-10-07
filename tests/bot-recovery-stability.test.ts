import { describe, expect, it } from "vitest";
import { acquireBotInstanceLock } from "../src/automation/bot-instance-lock.js";
import { shouldRecoverPrimaryRun, type DailyAutomationRun } from "../src/automation/daily-sync.js";
import { buildProductRows } from "../src/account-side/plan.js";
import type { BusinessProfile } from "../src/config/business-profile.js";
import { alignAttributionTotalsToPaidSnapshot } from "../src/realtime/roi-sync.js";

describe("bot recovery and product aggregation", () => {
  it("serializes guard startups and continues after one startup fails", async () => {
    const queue = new GuardStartupQueue(0);
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.run(async () => { events.push("first"); await gate; throw new Error("temporary"); });
    const second = queue.run(async () => { events.push("second"); return 2; });
    const failure = expect(first).rejects.toThrow("temporary");
    await Promise.resolve();
    expect(events).toEqual(["first"]);
    release();
    await failure;
    expect(await second).toBe(2);
    expect(events).toEqual(["first", "second"]);
  });
  it("uses strict paid totals for the same product/date, without changing approximate channel counts", () => {
    const entries = [{ product: { id: "p", name: "修脚器" }, sources: [{ date: "2026-09-02", orders: 4, items: 5, cardOrders: 5, cardItems: 5 }] }] as any;
    const paid = [{ product: { id: "p", name: "修脚器" }, sources: [{ date: "2026-09-02", orders: 4, items: 4 }] }] as any;
    const aligned = alignAttributionTotalsToPaidSnapshot(entries, paid);
    expect(aligned[0]!.sources[0]).toMatchObject({ orders: 4, items: 4, cardOrders: 5, cardItems: 5 });
    expect(entries[0].sources[0].items).toBe(5);
    expect(alignAttributionTotalsToPaidSnapshot(entries, [])).toEqual(entries);
  });
  it("uses an OS lock: refuses a concurrent instance, releases on close", async () => {
    const server = await acquireBotInstanceLock(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("port missing");
    await expect(acquireBotInstanceLock(address.port)).rejects.toThrow("第二实例");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const replacement = await acquireBotInstanceLock(address.port);
    await new Promise<void>((resolve) => replacement.close(() => resolve()));
  });

  it("recovers missed 17:35 runs on restart, but does not repeat completed runs or early/20:00 runs", () => {
    const check = (date: string, last: DailyAutomationRun | null = null) => shouldRecoverPrimaryRun(
      new Date(date), "Asia/Shanghai", "17:35", "20:00", last,
    );
    expect(check("2026-09-05T09:34:00Z")).toBe(false);
    expect(check("2026-09-05T09:40:00Z")).toBe(true);
    expect(check("2026-09-05T09:40:00Z", { startedAt: "2026-09-05T09:35:00Z" } as DailyAutomationRun)).toBe(false);
    expect(check("2026-09-05T12:01:00Z")).toBe(false);
  });

  it("merges listing IDs into one business product without double-counting a shared video", async () => {
    const video = { sourceDate: "2026-09-03", accountType: "OFFICIAL_ACCOUNTS" as const,
      videoId: "10000000000000001", accountName: "a", accountUid: "1", accountNickName: "A",
      postTime: "2026-09-03 10:00:00", publishedBusinessDate: "2026-09-04", productIds: ["sku-a", "sku-b"],
      views: 1000, orders: 3, items: 4, gmv: 20, currency: "USD" };
    const rows = await buildProductRows([video, { ...video, videoId: "10000000000000002", productIds: ["sku-b"], views: 500 }],
      ["2026-09-03"], { shop: "STOREONE", products: { "sku-a": "音箱", "sku-b": "音箱", "sku-c": "麦克风" } },
      { businessDisplayName: "STOREONE" } as BusinessProfile, new Set(), new Set(), new Set());
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
    expect(rows.find((row) => row.dimension === "音箱")).toMatchObject({ views: 1500, orders: 6, items: 8, gmv: 40, publishedVideos: 2 });
    expect(rows.find((row) => row.dimension === "STOREONE")).toMatchObject({ views: 1500, orders: 6 });
    expect(rows.find((row) => row.dimension === "麦克风")).toMatchObject({ views: 0, orders: 0 });
  });
});
import { GuardStartupQueue } from "../src/automation/guard-startup-queue.js";
