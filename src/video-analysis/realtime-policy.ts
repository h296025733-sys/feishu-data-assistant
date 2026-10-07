import { existsSync, readFileSync } from "node:fs";
import type { BitableRecordChangeEvent } from "../feishu/contact-duplicate-index.js";

export const REALTIME_SIGNAL = ".runtime/video-analysis-global/realtime-priority.json";
export function realtimePriorityActive(): boolean {
  if (!existsSync(REALTIME_SIGNAL)) return false;
  try { return JSON.parse(readFileSync(REALTIME_SIGNAL, "utf8")).until > Date.now(); }
  catch { return false; }
}
export function realtimeReportWindow(minute: number): boolean {
  return minute >= 17 * 60 + 45 && minute < 18 * 60 + 5;
}
export function relevantVideoRecordIds(event: BitableRecordChangeEvent, base: string, table: string,
  sourceFieldIds: readonly string[]): string[] {
  if (event.file_token !== base || event.table_id !== table) return [];
  return [...new Set((event.action_list ?? []).filter(a => {
    if (/delete/i.test(a.action ?? "")) return false;
    return /add|create/i.test(a.action ?? "") || [...a.before_value ?? [], ...a.after_value ?? []]
      .some(f => sourceFieldIds.includes(f.field_id ?? ""));
  }).map(a => a.record_id).filter((id): id is string => !!id))];
}
