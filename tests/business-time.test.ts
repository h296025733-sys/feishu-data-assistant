import { describe, expect, it } from "vitest";
import {
  businessDateRangeToShopDateRange,
  shopTimestampToBusinessDate,
} from "../src/realtime/business-time.js";

describe("TikTok shop time to business time", () => {
  it("converts Pacific daylight time across the Shanghai date boundary", () => {
    expect(shopTimestampToBusinessDate(
      "2026-07-26 11:03:06",
      "America/Los_Angeles",
      "Asia/Shanghai",
    )).toBe("2026-07-27");
    expect(shopTimestampToBusinessDate(
      "2026-07-27 10:15:05",
      "America/Los_Angeles",
      "Asia/Shanghai",
    )).toBe("2026-07-28");
  });

  it("uses DST-aware winter offsets instead of a fixed 15-hour offset", () => {
    expect(shopTimestampToBusinessDate(
      "2026-12-01 08:30:00",
      "America/Los_Angeles",
      "Asia/Shanghai",
    )).toBe("2026-12-02");
  });

  it("expands a Shanghai business range to every overlapping shop date", () => {
    expect(businessDateRangeToShopDateRange(
      "2026-07-26",
      "2026-08-02",
      "Asia/Shanghai",
      "America/Los_Angeles",
    )).toEqual({ startDate: "2026-07-25", endDateExclusive: "2026-08-03" });
  });

  it("rejects malformed or nonexistent local timestamps", () => {
    expect(() => shopTimestampToBusinessDate(
      "2026-03-08 02:30:00",
      "America/Los_Angeles",
      "Asia/Shanghai",
    )).toThrow();
  });
});
