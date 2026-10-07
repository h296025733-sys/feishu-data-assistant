import { describe, expect, it } from "vitest";
import { retryableVideoReadFailure, videoPendingRetryClock, videoWorkerCapacity } from "../src/video-analysis/runtime-policy.js";

describe("video runtime admission and read failure policy", () => {
  it("keeps the 4 GiB reserve and stops admission with insufficient headroom", () => {
    for (const gib of [0, 3.92, 4, 4.7]) expect(videoWorkerCapacity(gib * 1024 ** 3)).toBe(0);
    expect(videoWorkerCapacity(4.75 * 1024 ** 3)).toBe(1);
    expect(videoWorkerCapacity(5.5 * 1024 ** 3)).toBe(2);
    expect(videoWorkerCapacity(7 * 1024 ** 3)).toBe(4);
    expect(videoWorkerCapacity(32 * 1024 ** 3)).toBe(4);
    expect(videoWorkerCapacity(NaN)).toBe(0);
  });
  it("recognizes a native transient data-not-ready 400", () => {
    expect(retryableVideoReadFailure({ response: { status: 400, data: { code: 1254607 } } })).toBe(true);
  });
  it("does not turn unknown/bad-parameter 400s or monthly quota into retries", () => {
    expect(retryableVideoReadFailure({ response: { status: 400 } })).toBe(false);
    expect(retryableVideoReadFailure({ response: { status: 400, data: { code: 1254002 } } })).toBe(false);
    expect(retryableVideoReadFailure({ response: { status: 429, data: { code: 99991403 } } })).toBe(false);
  });
  it("keeps a local wait alive without treating cooling pending jobs as completed", () => {
    const now = Date.parse("2026-10-06T06:00:00Z");
    expect(videoPendingRetryClock([
      { state: "MEDIA_UNAVAILABLE", retryAfter: "2026-10-06T09:00:00Z" },
      { state: "REVIEW_REQUIRED", retryAfter: "2026-10-06T08:00:00Z" },
      { state: "WRITTEN" },
    ], now)).toEqual({ remaining: 2, due: 0, next: Date.parse("2026-10-06T08:00:00Z") });
    expect(videoPendingRetryClock([{ state: "MEDIA_UNAVAILABLE", retryAfter: "2026-10-06T05:00:00Z" }], now).due).toBe(1);
  });
  it("handles fresh/malformed dates and known terminal local states without making a formal completion claim", () => {
    expect(videoPendingRetryClock([{}, { retryAfter: "bad" }], Date.now())).toEqual({ remaining: 2, due: 2, next: Infinity });
    expect(videoPendingRetryClock([{ state: "WRITTEN" }, { state: "SOURCE_DELETED" }], Date.now()).remaining).toBe(0);
  });
});
