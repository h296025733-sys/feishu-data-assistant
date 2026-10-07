import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProvider } from "../src/ai/types.js";
import { ProductApprovalService } from "../src/automation/product-approval.js";
import type { BusinessProfile } from "../src/config/business-profile.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("product approval", () => {
  it("stages an AI suggestion and confirms it idempotently", async () => {
    const fixture = await createFixture();
    const service = new ProductApprovalService(fixture.profile, "approval-test", suggestionProvider("亮色水枪"));
    const staged = await service.stage([
      { id: "1732504520547078999", sourceTitle: "Bright Water Blaster" },
    ], "2026-08-05");
    expect(staged.pending).toMatchObject([{ suggestedName: "亮色水枪", firstSeenDate: "2026-08-05" }]);

    const confirmed = await service.confirm("1732504520547078999", "水枪喷头", "ou_test");
    expect(confirmed).toMatchObject({ canonicalName: "水枪喷头", alreadyConfirmed: false });
    expect(await service.confirm("1732504520547078999", "另一个名字", "ou_other"))
      .toMatchObject({ canonicalName: "水枪喷头", alreadyConfirmed: true });
    expect(await service.listPending()).toEqual([]);
    expect(await service.requiredBackfillStartDate()).toBe("2026-08-05");
    await service.markBackfillCompletedThrough("2026-08-06");
    expect(await service.requiredBackfillStartDate()).toBeNull();

    const saved = JSON.parse(await readFile(fixture.mapPath, "utf8")) as { products: Record<string, string> };
    expect(saved.products["1732504520547078999"]).toBe("水枪喷头");
  });

  it("reuses a confirmed name only when the official source title matches exactly", async () => {
    const fixture = await createFixture({
      products: { "1732504520547078001": "透明收纳箱" },
      sourceTitles: { "1732504520547078001": "Clear Storage Box" },
    });
    const service = new ProductApprovalService(fixture.profile, "approval-reuse");
    const staged = await service.stage([
      { id: "1732504520547078002", sourceTitle: " clear   storage box " },
    ], "2026-08-05");
    expect(staged.pending).toEqual([]);
    expect(staged.autoConfirmed).toEqual([
      { productId: "1732504520547078002", canonicalName: "透明收纳箱" },
    ]);
  });

  it("serializes multiple people confirming different products and keeps the first name per product", async () => {
    const fixture = await createFixture();
    const service = new ProductApprovalService(fixture.profile, "approval-concurrent");
    await service.stage([
      { id: "1732504520547078101", sourceTitle: "Bikini Trimmer" },
      { id: "1732504520547078102", sourceTitle: "Power Bank Flashlight" },
    ], "2026-08-05");

    const [first, second] = await Promise.all([
      service.confirm("1732504520547078101", "电动比基尼修剪器", "ou_first"),
      service.confirm("1732504520547078102", "二合一充电宝手电筒", "ou_second"),
    ]);
    expect(first.canonicalName).toBe("电动比基尼修剪器");
    expect(second.canonicalName).toBe("二合一充电宝手电筒");
    expect(await service.listPending()).toEqual([]);

    const repeated = await Promise.all([
      service.confirm("1732504520547078101", "另一个名字", "ou_third"),
      service.confirm("1732504520547078101", "再换一个名字", "ou_fourth"),
    ]);
    expect(repeated.every((item) => item.canonicalName === "电动比基尼修剪器")).toBe(true);
    expect(repeated.every((item) => item.alreadyConfirmed)).toBe(true);
  });

  it("baselines existing listings and auto-enrolls only later active product ids", async () => {
    const fixture = await createFixture({
      products: { "1732504520547078001": "现有商品" },
      autoEnrollNewProducts: true,
    });
    const tenantId = `approval-auto-${randomUUID()}`;
    roots.push(path.resolve(".runtime", "tenants", tenantId));
    const service = new ProductApprovalService(fixture.profile, tenantId, suggestionProvider("自动新品"));
    const baseline = await service.autoEnrollCatalog([
      { id: "1732504520547078001", title: "Existing", status: "ACTIVATE" },
      { id: "1732504520547078002", title: "Historical", status: "ACTIVATE" },
    ], "2026-08-20");
    expect(baseline).toEqual({ baselineInitialized: true, autoConfirmed: [] });

    const enrolled = await service.autoEnrollCatalog([
      { id: "1732504520547078001", title: "Existing", status: "ACTIVATE" },
      { id: "1732504520547078002", title: "Historical", status: "ACTIVATE" },
      { id: "1732504520547078003", title: "New draft", status: "DRAFT" },
      { id: "1732504520547078004", title: "New active", status: "ACTIVATE" },
    ], "2026-08-21");
    expect(enrolled.autoConfirmed).toEqual([
      { productId: "1732504520547078004", canonicalName: "自动新品" },
    ]);
    expect(await service.requiredBackfillStartDate()).toBe("2026-08-21");

    const repeated = await service.autoEnrollCatalog([
      { id: "1732504520547078004", title: "New active", status: "ACTIVATE" },
    ], "2026-08-21");
    expect(repeated.autoConfirmed).toEqual([]);
    const saved = JSON.parse(await readFile(fixture.mapPath, "utf8")) as { products: Record<string, string> };
    expect(saved.products).toEqual({
      "1732504520547078001": "现有商品",
      "1732504520547078004": "自动新品",
    });
  });

  it("gives different automatic names to different product ids", async () => {
    const fixture = await createFixture({ autoEnrollNewProducts: true });
    const tenantId = `approval-auto-unique-${randomUUID()}`;
    roots.push(path.resolve(".runtime", "tenants", tenantId));
    const service = new ProductApprovalService(fixture.profile, tenantId, suggestionProvider("同名新品"));
    await service.autoEnrollCatalog([], "2026-08-20");
    const enrolled = await service.autoEnrollCatalog([
      { id: "1732504520547078111", title: "First", status: "ACTIVATE" },
      { id: "1732504520547078222", title: "Second", status: "ACTIVATE" },
    ], "2026-08-21");
    expect(enrolled.autoConfirmed).toEqual([
      { productId: "1732504520547078111", canonicalName: "同名新品" },
      { productId: "1732504520547078222", canonicalName: "同名新品(7078222)" },
    ]);
  });
});

async function createFixture(
  initial: {
    products?: Record<string, string>;
    sourceTitles?: Record<string, string>;
    autoEnrollNewProducts?: boolean;
  } = {},
): Promise<{ profile: BusinessProfile; mapPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "product-approval-"));
  roots.push(root);
  const mapPath = path.join(root, "products.json");
  await writeFile(mapPath, JSON.stringify({
    shop: "Demo",
    products: initial.products ?? {},
    sourceTitles: initial.sourceTitles ?? {},
  }), "utf8");
  return {
    mapPath,
    profile: {
      schemaVersion: 1,
      templateMode: false,
      businessDisplayName: "Demo",
      businessTimeZone: "Asia/Shanghai",
      storeAggregateLabel: "店铺汇总",
      tables: { development: "开发", cooperation: "合作", online: "上线", roi: "投产比" },
      tiktok: {
        shopAlias: "Demo",
        shopTimeZone: "America/Los_Angeles",
        productMapFile: mapPath,
        autoEnrollNewProducts: initial.autoEnrollNewProducts ?? false,
      },
    },
  };
}

function suggestionProvider(name: string): ModelProvider {
  return {
    name: "mock",
    async parseIntent(_question, _context, fallback) {
      return { intent: fallback, trace: { source: "local", model: null, durationMs: 0, fallbackReason: null } };
    },
    async suggestProductName() {
      return { name, trace: { source: "local", model: null, durationMs: 0, fallbackReason: null } };
    },
  };
}
