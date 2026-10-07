import type { VideoInventory } from "./storeone-inventory.js";

/** Local status is only used to explain a pending row from a fresh formal snapshot. */
export function inspectOnlinePhase(
  inventory: VideoInventory, onlineTable: string,
  stateFor: (key: string) => string | undefined,
) {
  const deferred: string[] = [];
  const blocked: Array<{ key: string; reason: string }> = [];
  for (const item of inventory.pending.filter(item => item.tableId === onlineTable)) {
    const state = stateFor(item.key);
    // A write error, model error, or review hold is not evidence of inaccessible media.
    if (state === "MEDIA_UNAVAILABLE") deferred.push(item.key);
    else blocked.push({ key: item.key, reason: state ?? "UNATTEMPTED" });
  }
  for (const item of inventory.partial.filter(item => item.tableId === onlineTable)) {
    blocked.push({ key: item.key, reason: "PARTIAL_ANALYSIS" });
  }
  for (const item of inventory.duplicates.filter(item => item.key.startsWith(`${onlineTable}:`))) {
    blocked.push({ key: item.key, reason: "DUPLICATE_VIDEO" });
  }
  return { ready: blocked.length === 0, deferred, blocked,
    invalidWithoutLink: inventory.invalid.filter(item => item.tableId === onlineTable).length };
}
