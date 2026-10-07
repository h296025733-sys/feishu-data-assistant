import type { Client } from "@larksuiteoapi/node-sdk";
import { describe, expect, it } from "vitest";
import * as Vitest from "vitest";
import type { AppEnv } from "../src/config/env.js";
import type { RoiPivotApi } from "../src/feishu/roi-pivot-api.js";
import type {
  RoiApiRecord,
  RoiPivotPlan,
} from "../src/feishu/roi-pivot-plan.js";

const {
  afterEach,
  beforeEach,
  vitest: vi,
} = Vitest as unknown as {
  afterEach: (callback: () => void) => void;
  beforeEach: (callback: () => void) => void;
  vitest: any;
};
const buildRoiPivotPlan = vi.fn();

vi.doMock(
  "../src/feishu/roi-pivot-plan.js",
  async (importOriginal: () => Promise<Record<string, unknown>>) => ({
    ...await importOriginal(),
    buildRoiPivotPlan,
  }),
);

import type {
  RoiPivotSyncService as RoiPivotSyncServiceType,
  RoiPivotSyncResult,
} from "../src/feishu/roi-pivot-sync.js";

const { RoiPivotSyncService } = await import("../src/feishu/roi-pivot-sync.js");

const STARTED_AT = 1_000;

function plan(overrides: Partial<RoiPivotPlan> = {}): RoiPivotPlan {
  return {
    optionNames: ["合计全部", "合计2026年7月", "第71周"],
    updates: [],
    creates: [],
    deleteRecordIds: [],
    stats: {
      inputRecords: 0,
      detailRecords: 0,
      metricPairs: 0,
      weeks: 0,
      reusedTemplateRows: 0,
      ratioMetrics: 0,
    },
    ...overrides,
  };
}

function records(...recordIds: string[]): RoiApiRecord[] {
  return recordIds.map((recordId) => ({ recordId, fields: {} }));
}

class FakeRoiPivotApi {
  public readonly tableId = "roi-table";
  public readonly calls: Array<{ name: string; payload?: unknown }> = [];
  public failCreate = false;

  public constructor(private readonly readSnapshots: RoiApiRecord[][]) {}

  public async initialize(): Promise<void> {
    this.calls.push({ name: "initialize" });
  }

  public async readRecords(): Promise<RoiApiRecord[]> {
    this.calls.push({ name: "read" });
    return this.readSnapshots.shift() ?? [];
  }

  public async readFormulaInputs(): Promise<[]> {
    this.calls.push({ name: "read-formulas" });
    return [];
  }

  public isRelevantTableId(tableId: string): boolean {
    return tableId === this.tableId;
  }

  public async ensurePivotOptions(names: readonly string[]): Promise<void> {
    this.calls.push({ name: "ensure-options", payload: [...names] });
  }

  public async ensureMetricOptions(names: readonly string[]): Promise<void> {
    this.calls.push({ name: "ensure-metrics", payload: [...names] });
  }

  public async batchUpdate(updates: RoiPivotPlan["updates"]): Promise<void> {
    this.calls.push({ name: "update", payload: updates });
  }

  public async batchCreate(creates: RoiPivotPlan["creates"]): Promise<void> {
    this.calls.push({ name: "create", payload: creates });
    if (this.failCreate) throw new Error("create failed");
  }

  public async batchDelete(recordIds: readonly string[]): Promise<void> {
    this.calls.push({ name: "delete", payload: [...recordIds] });
  }

  public completeMutationCycle(): void {
    this.calls.push({ name: "complete" });
  }
}

function service(api: FakeRoiPivotApi): RoiPivotSyncServiceType {
  const now = vi.fn()
    .mockReturnValueOnce(STARTED_AT)
    .mockReturnValueOnce(STARTED_AT + 25);
  return new RoiPivotSyncService(
    { FEISHU_BITABLE_APP_TOKEN: "app-token" } as AppEnv,
    {} as Client,
    {
      api: api as unknown as RoiPivotApi,
      now,
      failedRetryMs: 60_000,
    },
  );
}

function reconcile(
  instance: RoiPivotSyncServiceType,
  reason: string,
): Promise<RoiPivotSyncResult> {
  return (instance as unknown as {
    reconcile(value: string): Promise<RoiPivotSyncResult>;
  }).reconcile(reason);
}

describe("RoiPivotSyncService safe mutation order", () => {
  beforeEach(() => {
    buildRoiPivotPlan.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("upserts before deleting and deletes only ids confirmed by the reread", async () => {
    const api = new FakeRoiPivotApi([
      records("detail", "stale", "edited-during-sync"),
      records("detail", "stale", "created"),
      records("detail", "created"),
    ]);
    const initial = plan({
      updates: [{ recordId: "detail", fields: { 值: 2 } }],
      creates: [{ fields: { 产品: "TechWave" } }],
      deleteRecordIds: ["stale", "edited-during-sync"],
    });
    const beforeDelete = plan({ deleteRecordIds: ["stale"] });
    const verified = plan({
      stats: {
        inputRecords: 2,
        detailRecords: 1,
        metricPairs: 1,
        weeks: 1,
        reusedTemplateRows: 0,
        ratioMetrics: 0,
      },
    });
    buildRoiPivotPlan
      .mockReturnValueOnce(initial)
      .mockReturnValueOnce(beforeDelete)
      .mockReturnValueOnce(verified);

    const result = await service(api).syncNow("unit_test");

    expect(api.calls.map((call) => call.name)).toEqual([
      "initialize",
      "read",
      "read-formulas",
      "ensure-options",
      "ensure-metrics",
      "update",
      "create",
      "read",
      "read-formulas",
      "delete",
      "read",
      "read-formulas",
      "complete",
    ]);
    expect(api.calls.find((call) => call.name === "delete")?.payload).toEqual(["stale"]);
    expect(result).toMatchObject({
      reason: "unit_test",
      recordsBefore: 3,
      recordsAfter: 2,
      deleted: 1,
      updated: 1,
      created: 1,
      verified: true,
      durationMs: 25,
    });
  });

  it("does not delete anything when creation fails", async () => {
    const api = new FakeRoiPivotApi([records("stale")]);
    api.failCreate = true;
    buildRoiPivotPlan.mockReturnValueOnce(plan({
      creates: [{ fields: { 产品: "TechWave" } }],
      deleteRecordIds: ["stale"],
    }));

    await expect(reconcile(service(api), "create_failure")).rejects.toThrow("create failed");

    expect(api.calls.map((call) => call.name)).toEqual([
      "read",
      "read-formulas",
      "ensure-options",
      "ensure-metrics",
      "create",
    ]);
    expect(api.calls.some((call) => call.name === "delete")).toBe(false);
    expect(api.calls.some((call) => call.name === "complete")).toBe(false);
  });

  it("does not delete when the post-upsert reread has not converged", async () => {
    const api = new FakeRoiPivotApi([
      records("detail", "stale"),
      records("detail", "stale"),
    ]);
    buildRoiPivotPlan
      .mockReturnValueOnce(plan({
        updates: [{ recordId: "detail", fields: { 值: 2 } }],
        deleteRecordIds: ["stale"],
      }))
      .mockReturnValueOnce(plan({
        updates: [{ recordId: "detail", fields: { 值: 3 } }],
        deleteRecordIds: ["stale"],
      }));

    await expect(reconcile(service(api), "not_converged")).rejects.toThrow(
      "为保护数据，本轮未执行删除",
    );

    expect(api.calls.map((call) => call.name)).toEqual([
      "read",
      "read-formulas",
      "ensure-options",
      "ensure-metrics",
      "update",
      "read",
      "read-formulas",
    ]);
    expect(api.calls.some((call) => call.name === "delete")).toBe(false);
    expect(api.calls.some((call) => call.name === "complete")).toBe(false);
  });

  it("does not delete newly discovered candidates until a later reconciliation", async () => {
    const api = new FakeRoiPivotApi([
      records("known-stale"),
      records("known-stale", "new-stale"),
    ]);
    buildRoiPivotPlan
      .mockReturnValueOnce(plan({ deleteRecordIds: ["known-stale"] }))
      .mockReturnValueOnce(plan({ deleteRecordIds: ["known-stale", "new-stale"] }));

    await expect(reconcile(service(api), "concurrent_change")).rejects.toThrow(
      "重读后新发现 1 条待删除记录",
    );

    expect(api.calls.map((call) => call.name)).toEqual([
      "read",
      "read-formulas",
      "ensure-options",
      "ensure-metrics",
      "read",
      "read-formulas",
    ]);
    expect(api.calls.some((call) => call.name === "delete")).toBe(false);
  });
});
