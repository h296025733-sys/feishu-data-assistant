import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBusinessProfileFile } from "../src/config/business-profile.js";
import {
  buildProductSpikeCard,
  productSpikeTier,
  ProductSpikeMonitorService,
  type ProductSpikeAlertItem,
} from "../src/bot/product-spike-monitor.js";
import type { ProductSpikeSnapshot } from "../src/bot/product-spike-snapshot.js";

const services: ProductSpikeMonitorService[] = [];
const profile = loadBusinessProfileFile("tests/fixtures/storeone.profile.json");

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
});

describe("product spike thresholds", () => {
  it("treats 3 orders as mild heat, not a burst", () => {
    expect([0, 2, 3, 5, 6, 11, 12, 23, 24].map(productSpikeTier)).toEqual([
      0, 0, 1, 1, 2, 2, 3, 3, 4,
    ]);
  });

  it("builds a concise tiered card", () => {
    const item: ProductSpikeAlertItem = {
      productName: "户外蓝牙音箱",
      tier: 1,
      windowOrders: 3,
      todayOrders: 11,
      todayItems: 12,
      todaySales: 32.01,
      salesCurrency: "USD",
      episodeId: "episode",
    };
    const rendered = JSON.stringify(buildProductSpikeCard({
      storeName: "STOREONE",
      businessDate: "2026-08-12",
      createdAt: new Date("2026-08-12T02:05:00.000Z"),
      timeZone: "Asia/Shanghai",
      items: [item],
    }));
    expect(rendered).toContain("STOREONE 商品热度提醒｜热度上升");
    expect(rendered).toContain("近30分钟：**3个付款订单**");
    expect(rendered).toContain("11单 / 12件｜$32.01");
    expect(rendered).toContain("<at id=all></at>");
    expect(rendered).not.toContain("爆单");
  });
});

describe("ProductSpikeMonitorService", () => {
  it("starts silently, alerts once, and only re-alerts when the tier rises", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "product-spike-"));
    let now = new Date("2026-08-12T02:00:00.000Z");
    let keys = [key(1), key(2)];
    const sent: Array<{ chatId: string; card: Record<string, unknown>; idempotencyKey: string }> = [];
    const service = new ProductSpikeMonitorService({
      tenantId: "storeone-formal",
      profile,
      pollMinutes: 30,
      groupChatIds: ["oc_storeone"],
      loadSnapshot: async () => snapshot(now, keys),
      sendCard: async (chatId, card, idempotencyKey) => {
        sent.push({ chatId, card, idempotencyKey });
        return `om_${sent.length}`;
      },
      statePath: path.join(directory, "state.json"),
      now: () => now,
    });
    services.push(service);

    const baseline = await service.start();
    expect(baseline.initializedBaseline).toBe(true);
    expect(sent).toHaveLength(0);

    now = new Date("2026-08-12T02:05:00.000Z");
    keys = [...keys, key(3), key(4), key(5)];
    const mild = await service.runOnce();
    expect(mild.productAlertsDelivered).toBe(1);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0].card)).toContain("热度上升");
    expect(JSON.stringify(sent[0].card)).not.toContain("商品热度提醒｜爆单");

    now = new Date("2026-08-12T02:10:00.000Z");
    keys = [...keys, key(6), key(7), key(8)];
    await service.runOnce();
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[1].card)).toContain("明显起量");

    now = new Date("2026-08-12T02:15:00.000Z");
    await service.runOnce();
    expect(sent).toHaveLength(2);
  });

  it("does not misreport orders first observed after a long outage", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "product-spike-stale-"));
    let now = new Date("2026-08-12T02:00:00.000Z");
    let keys: string[] = [];
    let sent = 0;
    const service = new ProductSpikeMonitorService({
      tenantId: "storeone-formal",
      profile,
      pollMinutes: 30,
      groupChatIds: ["oc_storeone"],
      loadSnapshot: async () => snapshot(
        keys.length > 0 ? new Date("2026-08-12T02:10:00.000Z") : now,
        keys,
      ),
      sendCard: async () => { sent += 1; return "om_unexpected"; },
      statePath: path.join(directory, "state.json"),
      now: () => now,
    });
    services.push(service);
    await service.start();

    now = new Date("2026-08-12T03:00:00.000Z");
    keys = [key(1), key(2), key(3), key(4), key(5), key(6)];
    const result = await service.runOnce();
    expect(result.trustedObservation).toBe(false);
    expect(sent).toBe(0);
  });

  it("refreshes a video only when three new orders have an exact video attribution", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "video-spike-"));
    let now = new Date("2026-08-12T02:00:00.000Z");
    let videoKeys: string[] = [];
    const refreshed: string[] = [];
    const service = new ProductSpikeMonitorService({
      tenantId: "storeone-formal",
      profile,
      pollMinutes: 30,
      groupChatIds: ["oc_storeone"],
      loadSnapshot: async () => snapshot(now, [], true, videoKeys),
      sendCard: async () => "om_unused",
      refreshVideoExposure: async (videoId) => { refreshed.push(videoId); },
      statePath: path.join(directory, "state.json"),
      now: () => now,
    });
    services.push(service);
    await service.start();
    expect(refreshed).toHaveLength(0);

    now = new Date("2026-08-12T02:05:00.000Z");
    videoKeys = [key(1), key(2), key(3)];
    const triggered = await service.runOnce();
    expect(triggered.videoRefreshes).toBe(1);
    expect(refreshed).toEqual(["7667000000000000001"]);

    now = new Date("2026-08-12T02:10:00.000Z");
    await service.runOnce();
    expect(refreshed).toHaveLength(1);
  });

});

function snapshot(
  now: Date,
  orderKeys: string[],
  videoAttributionAvailable = false,
  videoOrderKeys: string[] = [],
): ProductSpikeSnapshot {
  return {
    businessDate: "2026-08-12",
    fetchedAt: now.toISOString(),
    products: [{
      name: "户外蓝牙音箱",
      productIds: ["1732523630634439455"],
      orderKeys,
      paidAtByOrderKey: Object.fromEntries(orderKeys.map((key) => [key, now.getTime()])),
      orders: orderKeys.length,
      items: orderKeys.length,
      sales: orderKeys.length * 3.25,
      salesCurrency: "USD",
    }],
    unmappedOrderKeys: [],
    unmappedPaidAtByOrderKey: {},
    videoAttributionAvailable,
    videoAttributionErrors: videoAttributionAvailable ? [] : ["missing scope"],
    videos: videoAttributionAvailable ? [{
      videoId: "7667000000000000001",
      productName: "户外蓝牙音箱",
      productIds: ["1732523630634439455"],
      orderKeys: videoOrderKeys,
      paidAtByOrderKey: Object.fromEntries(videoOrderKeys.map((key) => [key, now.getTime()])),
      orders: videoOrderKeys.length,
      items: videoOrderKeys.length,
    }] : [],
    sourcePath: "normalized.json",
  };
}

function key(value: number): string {
  return value.toString(16).padStart(20, "0");
}
