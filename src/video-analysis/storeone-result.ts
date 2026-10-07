import { ANALYSIS_GRADES, type VideoCandidate } from "./storeone-inventory.js";

export function plainLanguageResult(result: any): any {
  if (typeof result.analysis !== "string" || typeof result.suggestions !== "string") return result;
  return {
    ...result,
    analysis: result.analysis.replaceAll("自动转录提到", "口播可能提到")
      .replaceAll("自动转录显示", "口播可能提到")
      .replaceAll("自动转录中的", "片中可能提到的")
      .replaceAll("转录提到", "口播可能提到")
      .replaceAll("自动转录", "可能的口播")
      .replaceAll("转录", "可能的口播")
      .replaceAll("RGB灯", "彩色灯光")
      .replaceAll("RGB", "彩色灯光")
      .replaceAll("差异点", "不同之处")
      .replaceAll("关键帧", "已检查的画面")
      .replaceAll("接触表", "画面总览")
      .replaceAll("CTA", "购买提示")
      .replaceAll("UGC", "普通用户实拍"),
    suggestions: result.suggestions.replaceAll("自动转录提到", "口播可能提到")
      .replaceAll("自动转录显示", "口播可能提到")
      .replaceAll("自动转录中的", "片中可能提到的")
      .replaceAll("转录提到", "口播可能提到")
      .replaceAll("自动转录", "可能的口播")
      .replaceAll("转录", "可能的口播")
      .replaceAll("RGB灯", "彩色灯光")
      .replaceAll("RGB", "彩色灯光")
      .replaceAll("差异点", "不同之处")
      .replaceAll("关键帧", "已检查的画面")
      .replaceAll("接触表", "画面总览")
      .replaceAll("CTA", "购买提示")
      .replaceAll("UGC", "普通用户实拍"),
  };
}

export function validateVideoAnalysisResult(
  result: any, candidate: VideoCandidate, manifest: any,
): void {
  if (result.videoId !== candidate.videoId || !ANALYSIS_GRADES.includes(result.recommendation)) {
    throw new Error("Model identity or recommendation mismatch");
  }
  if (manifest.status !== "LOCAL_EVIDENCE_READY" || manifest.source_unchanged_during_analysis !== true) {
    throw new Error("Video evidence incomplete or changed");
  }
  if (typeof result.analysis !== "string" || typeof result.suggestions !== "string"
      || result.analysis.length < 120 || result.suggestions.length < 180
      || result.analysis.length > 1000 || result.suggestions.length > 1500) {
    throw new Error("Analysis text incomplete or oversized");
  }
  if (!Array.isArray(result.evidence) || result.evidence.length < 3) throw new Error("Missing visual evidence");
  const duration = Number(manifest.probe_summary?.duration_seconds);
  // Exact timestamps such as "0—9秒" are just as valid as "约2秒".
  // Keep both range endpoints so a valid start cannot hide an impossible end.
  const timeMentions = [...(result.analysis + result.suggestions).matchAll(
    /(?:约\s*)?(\d+(?:\.\d+)?)(?:\s*[—–\-至到]\s*(\d+(?:\.\d+)?))?\s*秒/g,
  )].map((match) => [Number(match[1]), Number(match[2] ?? match[1])]);
  if (!Number.isFinite(duration) || duration <= 0 || timeMentions.length < 2
      || timeMentions.some(([start, end]) => end < start || start > duration + 2 || end > duration + 2)) {
    throw new Error("Video timing needs review against source duration");
  }
  if (!result.analysis.includes("【拍得好的地方】") || !result.analysis.includes("【最可惜的地方】")
      || !result.analysis.includes("【现在要不要花钱推广】") || !result.suggestions.includes("为什么：")) {
    throw new Error("Required plain-language structure missing");
  }
  if (/UGC|RGB|CTA|钩子|首屏|转化收口|差异点|用户心智|自动转录|转录|接触表|关键帧/.test(result.analysis + result.suggestions)) {
    throw new Error("Business wording requires review");
  }
}
