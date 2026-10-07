import { describe, expect, it } from "vitest";
import {
  buildDuplicateFlags,
  DEFAULT_DUPLICATE_TARGETS,
  DUPLICATE_CELL_MARKER,
  DUPLICATE_FLAG_VALUE,
  hasDuplicateCellMarker,
  isDuplicateFlagValue,
  markedDuplicateCellValue,
  normalizeDuplicateValue,
} from "../src/feishu/duplicate-cell-flags.js";

describe("duplicate cell flags", () => {
  it("covers every business-key cell that must be highlighted in place", () => {
    expect(DEFAULT_DUPLICATE_TARGETS.map((target) => [
      target.tableName,
      target.fieldName,
      target.flagFieldName,
    ])).toEqual([
      ["红人开发表", "红人姓名", "__重复_红人姓名"],
      ["红人开发表", "邮箱", "__重复_邮箱"],
      ["红人开发表", "whatsapp", "__重复_whatsapp"],
      ["红人合作表", "红人姓名", "__重复_红人姓名"],
      ["红人合作表", "联系方式（邮箱/WhatsApp）", "__重复_联系方式"],
      ["红人上线表", "达人姓名", "__重复_达人姓名"],
      ["红人上线表", "视频上线地址", "__重复_视频上线地址"],
      ["红人上线表", "AD CODE（没有要到的备注要码时间）", "__重复_AD CODE"],
    ]);
  });

  it("marks only the requested cooperation and online source cells", () => {
    expect(DEFAULT_DUPLICATE_TARGETS.filter((target) => target.markSourceCell).map((target) => [
      target.tableName,
      target.fieldName,
    ])).toEqual([
      ["红人合作表", "红人姓名"],
      ["红人合作表", "联系方式（邮箱/WhatsApp）"],
      ["红人上线表", "达人姓名"],
      ["红人上线表", "视频上线地址"],
      ["红人上线表", "AD CODE（没有要到的备注要码时间）"],
    ]);
  });

  it("observes one creator publishing multiple videos without changing video identity", () => {
    expect(DEFAULT_DUPLICATE_TARGETS.some((target) => (
      target.tableName === "红人上线表" && target.fieldName === "达人姓名"
    ))).toBe(true);

    const flags = buildDuplicateFlags([
      { recordId: "video-a", value: "creator" },
      { recordId: "video-b", value: "creator" },
    ], "text");
    expect(Object.fromEntries(flags)).toEqual({ "video-a": true, "video-b": true });
  });

  it("normalizes creator names without changing the original cell", () => {
    expect(normalizeDuplicateValue("  Creator\u200B  Name ", "text")).toBe("creator name");
  });

  it("stores duplicate state in an internal text flag for audit", () => {
    expect(isDuplicateFlagValue(DUPLICATE_FLAG_VALUE)).toBe(true);
    expect(isDuplicateFlagValue(true)).toBe(true);
    expect(isDuplicateFlagValue("")).toBe(false);
  });

  it("normalizes equivalent contact values", () => {
    expect(normalizeDuplicateValue(" Test@Example.COM ", "contact")).toBe("test@example.com");
    expect(normalizeDuplicateValue("WhatsApp: +1 (817) 266-1371", "contact"))
      .toBe("+18172661371");
  });

  it("ignores URL query strings and highlights every row in a duplicate group", () => {
    const flags = buildDuplicateFlags([
      {
        recordId: "a",
        value: { text: "A", link: "https://www.tiktok.com/@creator/video/123?foo=1" },
      },
      {
        recordId: "b",
        value: "https://www.tiktok.com/@creator/video/123?bar=2",
      },
      { recordId: "c", value: "https://www.tiktok.com/@creator/video/456" },
      { recordId: "d", value: "" },
    ], "url");

    expect(Object.fromEntries(flags)).toEqual({
      a: true,
      b: true,
      c: false,
      d: false,
    });
  });

  it("adds and removes an invisible marker without changing normalized text", () => {
    const marked = markedDuplicateCellValue("Creator Name", true);
    expect(marked).toBe(`${DUPLICATE_CELL_MARKER}Creator Name`);
    expect(hasDuplicateCellMarker(marked)).toBe(true);
    expect(normalizeDuplicateValue(marked, "text")).toBe("creator name");
    expect(markedDuplicateCellValue(marked, false)).toBe("Creator Name");
  });

  it("keeps URL links clickable while marking only their display text", () => {
    const original = {
      text: "https://www.tiktok.com/@creator/video/123",
      link: "https://www.tiktok.com/@creator/video/123",
    };
    const marked = markedDuplicateCellValue(original, true) as typeof original;
    expect(marked.link).toBe(original.link);
    expect(marked.text.startsWith(DUPLICATE_CELL_MARKER)).toBe(true);
    expect(normalizeDuplicateValue(marked, "url"))
      .toBe("https://www.tiktok.com/@creator/video/123");
  });
});
