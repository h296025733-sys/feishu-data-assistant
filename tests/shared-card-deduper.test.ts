import { describe, expect, it } from "vitest";
import { SharedCardDeduper } from "../src/bot/shared-card-deduper.js";

describe("shared group card deduplication", () => {
  it("lets the first member run a shared action and suppresses near-simultaneous duplicates", () => {
    const deduper = new SharedCardDeduper(10_000);
    expect(deduper.accept("tenant:group:card:business-brief", 100_000)).toBe(true);
    expect(deduper.accept("tenant:group:card:business-brief", 100_500)).toBe(false);
    expect(deduper.accept("tenant:group:card:business-brief", 110_001)).toBe(true);
  });

  it("does not mix different cards, actions, groups or stores", () => {
    const deduper = new SharedCardDeduper(10_000);
    expect(deduper.accept("store-a:group-1:card-1:brief", 100_000)).toBe(true);
    expect(deduper.accept("store-a:group-1:card-1:rank", 100_001)).toBe(true);
    expect(deduper.accept("store-a:group-2:card-1:brief", 100_002)).toBe(true);
    expect(deduper.accept("store-b:group-1:card-1:brief", 100_003)).toBe(true);
  });
});
