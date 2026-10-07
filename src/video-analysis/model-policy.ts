// User-selected policy, 2026-09-29. Preserve historical receipts unchanged.
export const VIDEO_ANALYSIS_MODEL = {
  name: "gpt-5.6-sol", reasoning: "medium", fast: true,
} as const;

export function videoAnalysisModelArgs(): string[] {
  return ["--model", VIDEO_ANALYSIS_MODEL.name, "-c", 'model_reasoning_effort="medium"',
    "-c", 'service_tier="fast"', "--enable", "respect_system_proxy", "--enable", "fast_mode"];
}

export function verifiedAnalysisRun(run: Record<string, unknown>, log: string): boolean {
  // Retain already-generated, source-validated results; never relabel an old
  // Astra/Fast receipt as Sol/standard or spend tokens recreating it needlessly.
  return (run.model === "gpt-5.6-sol" || run.model === "gpt-6-astra")
    && (run.reasoning === "high" || (run.model === "gpt-5.6-sol" && run.reasoning === "medium"))
    && run.exitCode === 0 && typeof run.fast === "boolean"
    && log.includes(`model: ${run.model}`) && log.includes(`reasoning effort: ${run.reasoning}`);
}
