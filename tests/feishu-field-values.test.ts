import { describe, expect, it } from "vitest";
import {
  dateValueForField,
  linkValueForField,
  numberValueForField,
} from "../src/feishu/field-values.js";

describe("linkValueForField", () => {
  it("writes plain URLs to Text fields", () => {
    expect(linkValueForField("https://example.com/a", 1, "A")).toBe("https://example.com/a");
  });

  it("writes structured links to Url fields", () => {
    expect(linkValueForField("https://example.com/a", 15, "A")).toEqual({
      text: "A",
      link: "https://example.com/a",
    });
  });

  it("adapts number and date values to Text fields", () => {
    expect(numberValueForField(12.5, 1)).toBe("12.5");
    expect(numberValueForField(12.5, 2)).toBe(12.5);
    expect(dateValueForField("2026-09-02", 1_788_307_200_000, 1)).toBe("2026-09-02");
    expect(dateValueForField("2026-09-02", 1_788_307_200_000, 5)).toBe(1_788_307_200_000);
  });
});
