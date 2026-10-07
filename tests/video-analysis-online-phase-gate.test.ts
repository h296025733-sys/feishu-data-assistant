import { describe, expect, it } from "vitest";
import type { VideoInventory, VideoCandidate } from "../src/video-analysis/storeone-inventory.js";
import { inspectOnlinePhase } from "../src/video-analysis/online-phase-gate.js";

const row = (id: string, tableId = "online"): VideoCandidate => ({
  key: `${tableId}:${id}`, tableId, videoId: id, recordId: id, url: "", creator: "",
  product: "product", publishedAt: null,
});
const inventory = (pending: VideoCandidate[] = []): VideoInventory => ({
  totalRows: pending.length, completeRows: 0, completeKeys: [], pending,
  partial: [], duplicates: [], invalid: [],
});

describe("online phase gate", () => {
  it("does not mistake review or model/write failures for inaccessible media", () => {
    for (const state of ["REVIEW_REQUIRED", "MODEL_UNAVAILABLE", "EVIDENCE_UNAVAILABLE",
      "SOURCE_INCOMPLETE", "WRITTEN", undefined]) {
      expect(inspectOnlinePhase(inventory([row("1")]), "online", () => state).ready).toBe(false);
    }
  });
  it("allows only documented media holds and missing links to remain", () => {
    const value = inventory([row("1")]);
    value.invalid.push({ tableId: "online", recordId: "blank", reason: "no link" });
    expect(inspectOnlinePhase(value, "online", () => "MEDIA_UNAVAILABLE"))
      .toEqual({ ready: true, deferred: ["online:1"], blocked: [], invalidWithoutLink: 1 });
  });
  it("does not let account pending rows block the online gate", () => {
    expect(inspectOnlinePhase(inventory([row("2", "account")]), "online", () => undefined).ready)
      .toBe(true);
  });
  it("blocks partial and duplicate online rows without writing them", () => {
    const value = inventory();
    value.partial.push({ tableId: "online", recordId: "p", videoId: "3", key: "online:3" });
    value.duplicates.push({ key: "online:4", recordIds: ["a", "b"] });
    const before = JSON.stringify(value);
    expect(inspectOnlinePhase(value, "online", () => undefined).blocked).toHaveLength(2);
    expect(JSON.stringify(value)).toBe(before);
  });
});
