import { describe, expect, it } from "vitest";
import {
  buildCooperationOnlineProgressPlan,
  type CooperationProgressRecord,
  type OnlineProgressEvidence,
} from "../src/feishu/cooperation-online-progress.js";

const OPTIONS = ["待寄样", "已寄样", "已收货", "已上线", "已结算"];

function cooperation(
  recordId: string,
  cooperationDate: string,
  products: string[],
  progress = "已寄样",
  creatorHandle = "creator_a",
): CooperationProgressRecord {
  return { recordId, creatorHandle, cooperationDate, products, progress };
}

function online(
  recordId: string,
  onlineDate: string,
  products: string[],
  creatorHandle = "creator_a",
): OnlineProgressEvidence {
  return { recordId, creatorHandle, onlineDate, products };
}

describe("buildCooperationOnlineProgressPlan", () => {
  it("advances the unique cooperation matching creator, product and date", () => {
    const plan = buildCooperationOnlineProgressPlan(
      [cooperation("coop-1", "2026-08-01", ["商品A"])],
      [online("online-1", "2026-08-05", ["商品A"])],
      OPTIONS,
    );
    expect(plan.matchedOnlineRecords).toBe(1);
    expect(plan.updates).toEqual([expect.objectContaining({
      cooperationRecordId: "coop-1",
      previousProgress: "已寄样",
      targetProgress: "已上线",
      onlineRecordIds: ["online-1"],
    })]);
    expect(plan.ambiguousOnline).toEqual([]);
  });

  it("uses the latest eligible cooperation when one creator collaborates repeatedly", () => {
    const plan = buildCooperationOnlineProgressPlan(
      [
        cooperation("older", "2026-07-01", ["商品A"]),
        cooperation("latest", "2026-08-01", ["商品A"]),
        cooperation("future", "2026-08-20", ["商品A"]),
      ],
      [online("online-1", "2026-08-05", ["商品A"])],
      OPTIONS,
    );
    expect(plan.updates.map((item) => item.cooperationRecordId)).toEqual(["latest"]);
  });

  it("never guesses when the latest creator/product/date still has two cooperation rows", () => {
    const plan = buildCooperationOnlineProgressPlan(
      [
        cooperation("duplicate-a", "2026-08-01", ["商品A"]),
        cooperation("duplicate-b", "2026-08-01", ["商品A"]),
      ],
      [online("online-1", "2026-08-05", ["商品A"])],
      OPTIONS,
    );
    expect(plan.updates).toEqual([]);
    expect(plan.ambiguousOnline).toEqual([expect.objectContaining({
      onlineRecordId: "online-1",
      candidateRecordIds: ["duplicate-a", "duplicate-b"],
    })]);
  });

  it("uses product selection to disambiguate same creator collaborations", () => {
    const plan = buildCooperationOnlineProgressPlan(
      [
        cooperation("product-a", "2026-08-01", ["商品A"]),
        cooperation("product-b", "2026-08-01", ["商品B"]),
      ],
      [online("online-1", "2026-08-05", ["商品B"])],
      OPTIONS,
    );
    expect(plan.updates.map((item) => item.cooperationRecordId)).toEqual(["product-b"]);
  });

  it("accepts one online product inside a multi-product cooperation", () => {
    const plan = buildCooperationOnlineProgressPlan(
      [cooperation("multi", "2026-08-01", ["商品A", "商品B"])],
      [online("online-1", "2026-08-05", ["商品B"])],
      OPTIONS,
    );
    expect(plan.updates.map((item) => item.cooperationRecordId)).toEqual(["multi"]);
  });

  it("coalesces multiple videos into one idempotent cooperation update", () => {
    const plan = buildCooperationOnlineProgressPlan(
      [cooperation("coop-1", "2026-08-01", ["商品A"])],
      [
        online("online-2", "2026-08-05", ["商品A"]),
        online("online-1", "2026-08-04", ["商品A"]),
      ],
      OPTIONS,
    );
    expect(plan.matchedOnlineRecords).toBe(2);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]?.onlineRecordIds).toEqual(["online-1", "online-2"]);
  });

  it("does not downgrade later or terminal progress", () => {
    const plan = buildCooperationOnlineProgressPlan(
      [
        cooperation("settled", "2026-08-01", ["商品A"], "已结算", "settled_creator"),
        cooperation("cancelled", "2026-08-01", ["商品A"], "已取消", "cancelled_creator"),
      ],
      [
        online("online-1", "2026-08-05", ["商品A"], "settled_creator"),
        online("online-2", "2026-08-05", ["商品A"], "cancelled_creator"),
      ],
      OPTIONS,
    );
    expect(plan.updates).toEqual([]);
    expect(plan.protectedRecordIds).toEqual(["cancelled", "settled"]);
  });

  it("leaves incomplete and unmatched online rows untouched with diagnostics", () => {
    const plan = buildCooperationOnlineProgressPlan(
      [cooperation("coop-1", "2026-08-01", ["商品A"])],
      [
        online("blank", "", [], ""),
        online("wrong-product", "2026-08-05", ["商品B"]),
      ],
      OPTIONS,
    );
    expect(plan.updates).toEqual([]);
    expect(plan.incompleteOnline).toHaveLength(1);
    expect(plan.unmatchedOnline).toHaveLength(1);
  });
});
