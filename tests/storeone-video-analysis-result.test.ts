import { describe, expect, it } from "vitest";
import { plainLanguageResult, validateVideoAnalysisResult } from "../src/video-analysis/storeone-result.js";
import type { VideoCandidate } from "../src/video-analysis/storeone-inventory.js";

const candidate: VideoCandidate = {
  tableId: "table", recordId: "record", videoId: "7684496481503431949",
  url: "https://www.tiktok.com/@shop/video/7684496481503431949",
  creator: "shop", product: "便携音箱", publishedAt: 1,
  key: "table:7684496481503431949",
};
const manifest = { status: "LOCAL_EVIDENCE_READY", source_unchanged_during_analysis: true,
  probe_summary: { duration_seconds: 30 } };
const result = {
  videoId: candidate.videoId,
  analysis: "【拍得好的地方】约2秒展示了音箱外观，观众能看清大小和颜色。".repeat(3)
    + "【最可惜的地方】虽然自动转录提到试听，但画面没有交代使用过程，观众无法判断怎么操作。".repeat(3)
    + "【现在要不要花钱推广】先补拍产品操作，再考虑小范围测试；这不是广告回报保证。",
  recommendation: "待选投广",
  suggestions: "1. 怎么改：在约6秒处补拍手指按键和设备反应。为什么：观众能看懂操作过程。".repeat(6),
  evidence: ["约2秒外观", "约6秒按键", "约8秒机身"], limitations: ["未听音"],
};

describe("STOREONE video analysis business copy guard", () => {
  it("converts tool wording without changing the Sol decision", () => {
    const cleaned = plainLanguageResult(result);
    expect(cleaned.analysis).toContain("口播可能提到试听");
    expect(cleaned.recommendation).toBe("待选投广");
    expect(() => validateVideoAnalysisResult(cleaned, candidate, manifest)).not.toThrow();
    const withRange = { ...cleaned,
      analysis: cleaned.analysis.replaceAll("约2秒", "约2至3秒")
        .replaceAll("口播可能提到", "转录提到")
        + "仅凭画面和自动转录不能判断音质。",
      suggestions: cleaned.suggestions.replaceAll("约6秒", "约6至8秒"),
    };
    const repaired = plainLanguageResult(withRange);
    expect(repaired.analysis).not.toContain("转录");
    expect(() => validateVideoAnalysisResult(repaired, candidate, manifest)).not.toThrow();
    const jargonRepaired = plainLanguageResult({ ...repaired,
      analysis: repaired.analysis + " RGB灯的差异点清楚。",
      suggestions: repaired.suggestions + " CTA可放在结尾，UGC风格要自然。" });
    expect(jargonRepaired.analysis).toContain("彩色灯光的不同之处");
    expect(jargonRepaired.suggestions).toContain("购买提示可放在结尾，普通用户实拍风格要自然");
    expect(() => validateVideoAnalysisResult(jargonRepaired, candidate, manifest)).not.toThrow();
  });

  it("holds impossible source timing and remaining jargon", () => {
    const cleaned = plainLanguageResult(result);
    expect(() => validateVideoAnalysisResult({ ...cleaned,
      suggestions: `${cleaned.suggestions} 约45秒继续展示。` }, candidate, manifest)).toThrow(/timing/);
    expect(() => validateVideoAnalysisResult({ ...cleaned,
      suggestions: `${cleaned.suggestions} 这里加强CTA。` }, candidate, manifest)).toThrow(/wording/);
  });

  it("translates frame tooling without claiming complete viewing or changing evidence", () => {
    const original = { ...result,
      analysis: result.analysis + "现有关键帧没有展示防水过程。",
      suggestions: result.suggestions + "接触表只能证明已检查的画面，不能证明防水。",
    };
    const cleaned = plainLanguageResult(original);
    expect(cleaned.analysis).toContain("现有已检查的画面没有展示防水过程");
    expect(cleaned.suggestions).toContain("画面总览只能证明已检查的画面");
    expect(cleaned.evidence).toBe(original.evidence);
    expect(cleaned.recommendation).toBe(original.recommendation);
    expect(() => validateVideoAnalysisResult(cleaned, candidate, manifest)).not.toThrow();
  });

  it("accepts exact timestamps without requiring the word approximately", () => {
    const cleaned = plainLanguageResult(result);
    for (const range of ["0—9秒", "0–9秒", "0-9秒", "0至9秒", "0到9秒", "2.7秒"]) {
      expect(() => validateVideoAnalysisResult({ ...cleaned,
        analysis: cleaned.analysis.replaceAll("约2秒", range),
        suggestions: cleaned.suggestions.replaceAll("约6秒", "12—16秒"),
      }, candidate, manifest)).not.toThrow();
    }
  });

  it("still rejects impossible range ends, reversed ranges and missing timestamps", () => {
    const cleaned = plainLanguageResult(result);
    for (const range of ["2—45秒", "约2至45秒", "9-2秒", "45秒"]) {
      expect(() => validateVideoAnalysisResult({ ...cleaned,
        analysis: cleaned.analysis.replaceAll("约2秒", range),
      }, candidate, manifest)).toThrow(/timing/);
    }
    expect(() => validateVideoAnalysisResult({ ...cleaned,
      analysis: cleaned.analysis.replaceAll("约2秒", "开头"),
      suggestions: cleaned.suggestions.replaceAll("约6秒", "中段"),
    }, candidate, manifest)).toThrow(/timing/);
  });
});
