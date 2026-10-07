import { describe, expect, it } from "vitest";
import { relevantVideoRecordIds, realtimeReportWindow } from "../src/video-analysis/realtime-policy.js";

describe("new online video event policy", () => {
  const event = { file_token: "base-a", table_id: "online-a", action_list: [
    { action: "record_added", record_id: "record-1" },
    { action: "record_added", record_id: "record-1" },
    { action: "record_edited", record_id: "record-2", after_value: [{ field_id: "video-url" }] },
    { action: "record_edited", record_id: "record-3", after_value: [{ field_id: "product" }] },
    { action: "record_edited", record_id: "record-4", after_value: [{ field_id: "analysis" }] },
    { action: "record_edited", record_id: "record-5", after_value: [{ field_id: "views" }] },
    { action: "record_deleted", record_id: "record-6" },
  ] };
  it("deduplicates additions and URL/product edits but ignores analysis and metric echoes", () => {
    expect(relevantVideoRecordIds(event, "base-a", "online-a", ["video-url", "product"]))
      .toEqual(["record-1", "record-2", "record-3"]);
  });
  it("isolates Base and table and rejects missing Base identity", () => {
    expect(relevantVideoRecordIds(event, "base-b", "online-a", ["video-url"])).toEqual([]);
    expect(relevantVideoRecordIds(event, "base-a", "account-a", ["video-url"])).toEqual([]);
    expect(relevantVideoRecordIds({ ...event, file_token: undefined }, "base-a", "online-a", ["video-url"])).toEqual([]);
  });
  it("protects report delivery without postponing every afternoon video to 21:00", () => {
    expect(realtimeReportWindow(16 * 60 + 30)).toBe(false);
    expect(realtimeReportWindow(17 * 60 + 44)).toBe(false);
    expect(realtimeReportWindow(17 * 60 + 45)).toBe(true);
    expect(realtimeReportWindow(17 * 60 + 55)).toBe(true);
    expect(realtimeReportWindow(18 * 60 + 5)).toBe(false);
  });
});
