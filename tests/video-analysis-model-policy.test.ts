import { describe, expect, it } from "vitest";
import { VIDEO_ANALYSIS_MODEL, verifiedAnalysisRun, videoAnalysisModelArgs }
  from "../src/video-analysis/model-policy.js";

describe("video analysis model policy", () => {
  it("pins new calls to Sol medium and requests Fast service explicitly", () => {
    expect(VIDEO_ANALYSIS_MODEL).toEqual({ name: "gpt-5.6-sol", reasoning: "medium", fast: true });
    const args = videoAnalysisModelArgs();
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.6-sol");
    expect(args).toContain('model_reasoning_effort="medium"');
    expect(args).toContain('service_tier="fast"');
    expect(args[args.indexOf("fast_mode") - 1]).toBe("--enable");
    expect(args).not.toContain("gpt-6-astra");
  });
  it("accepts medium Sol evidence but does not relabel a high log", () => {
    const run = { model: "gpt-5.6-sol", reasoning: "medium", fast: true, exitCode: 0 };
    expect(verifiedAnalysisRun(run, "model: gpt-5.6-sol\nreasoning effort: medium")).toBe(true);
    expect(verifiedAnalysisRun(run, "model: gpt-5.6-sol\nreasoning effort: high")).toBe(false);
  });
  it("accepts a real matching Sol high result", () => {
    expect(verifiedAnalysisRun({ model: "gpt-5.6-sol", reasoning: "high", fast: false, exitCode: 0 },
      "model: gpt-5.6-sol\nreasoning effort: high")).toBe(true);
  });
  it("preserves historical Astra provenance without changing it", () => {
    const cached = { model: "gpt-6-astra", reasoning: "high", fast: true, exitCode: 0 };
    expect(verifiedAnalysisRun(cached, "model: gpt-6-astra\nreasoning effort: high")).toBe(true);
    expect(cached.model).toBe("gpt-6-astra");
    expect(cached.fast).toBe(true);
  });
  it("rejects missing provenance, failed or wrong-model/effort logs", () => {
    const run = { model: "gpt-5.6-sol", reasoning: "high", fast: false, exitCode: 0 };
    expect(verifiedAnalysisRun(run, "model: gpt-6-astra\nreasoning effort: high")).toBe(false);
    expect(verifiedAnalysisRun({ ...run, exitCode: 1 }, "model: gpt-5.6-sol\nreasoning effort: high")).toBe(false);
    expect(verifiedAnalysisRun(run, "model: gpt-5.6-sol\nreasoning effort: low")).toBe(false);
    expect(verifiedAnalysisRun({}, "model: gpt-5.6-sol\nreasoning effort: high")).toBe(false);
  });
});
