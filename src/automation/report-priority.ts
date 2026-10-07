/** Non-critical work yields around report delivery; no metrics are fabricated. */
export function isReportDeliveryWindow(now = new Date(), timeZone = "Asia/Shanghai"): boolean {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(now);
  return time >= "17:50" && time < "18:05";
}

export function isVideoAnalysisSafetyWindow(minute: number): boolean {
  return minute >= 16 * 60 + 15 && minute < 21 * 60;
}
