import { describe, expect, it } from "vitest";
import { isReportDeliveryWindow, isVideoAnalysisSafetyWindow } from "../src/automation/report-priority.js";

describe("report resource priority", () => {
  it("only defers low-priority work in the bounded Beijing send window", () => {
    expect(isReportDeliveryWindow(new Date("2026-09-28T09:49:59Z"))).toBe(false);
    expect(isReportDeliveryWindow(new Date("2026-09-28T09:50:00Z"))).toBe(true);
    expect(isReportDeliveryWindow(new Date("2026-09-28T10:04:59Z"))).toBe(true);
    expect(isReportDeliveryWindow(new Date("2026-09-28T10:05:00Z"))).toBe(false);
  });
  it("protects all staggered main/catchup slots from future AI analysis", () => {
    expect(isVideoAnalysisSafetyWindow(16 * 60 + 14)).toBe(false);
    expect(isVideoAnalysisSafetyWindow(16 * 60 + 15)).toBe(true);
    expect(isVideoAnalysisSafetyWindow(20 * 60 + 59)).toBe(true);
    expect(isVideoAnalysisSafetyWindow(21 * 60)).toBe(false);
  });
});
