import { describe, expect, it } from "vitest";
import { isFreshVideoJob, videoMediaProxyArgs } from "../src/video-analysis/runtime-policy.js";

describe("backfill recovery routing and fresh-first policy", () => {
  it("explicitly supplies the existing configured HTTP route to the main downloader", () => {
    expect(videoMediaProxyArgs("http://127.0.0.1:9567")).toEqual(["--proxy", "http://127.0.0.1:9567"]);
    expect(videoMediaProxyArgs(undefined)).toEqual([]);
    expect(() => videoMediaProxyArgs("file:///tmp/a")).toThrow();
  });
  it("does not clear or override held job cooldowns in the fresh phase", () => {
    expect(isFreshVideoJob(null)).toBe(true);
    expect(isFreshVideoJob({ state: "UNATTEMPTED" })).toBe(true);
    for (const state of ["MEDIA_UNAVAILABLE", "EVIDENCE_UNAVAILABLE", "REVIEW_REQUIRED", "MODEL_UNAVAILABLE", "WRITTEN"]) {
      expect(isFreshVideoJob({ state })).toBe(false);
    }
  });
});
