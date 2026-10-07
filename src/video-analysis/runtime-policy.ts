import { isFeishuMonthlyQuotaExhausted, isRetryableFeishuError } from "../feishu/client.js";

/** Reserve 4 GiB plus a conservative 0.75 GiB admission margin per worker. */
export function videoWorkerCapacity(freeBytes: number): number {
  if (!Number.isFinite(freeBytes) || freeBytes < 0) return 0;
  return Math.max(0, Math.min(4, Math.floor((freeBytes / 1024 ** 3 - 4) / 0.75)));
}

/** Unknown 400s and quota exhaustion are not a licence to retry indefinitely. */
export function retryableVideoReadFailure(error: unknown): boolean {
  return !isFeishuMonthlyQuotaExhausted(error) && isRetryableFeishuError(error);
}

export function videoMediaProxyArgs(proxy: string | undefined): string[] {
  if (!proxy?.trim()) return [];
  const url = new URL(proxy);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported video proxy protocol");
  return ["--proxy", proxy];
}

export function isFreshVideoJob(status: { state?: unknown } | null): boolean {
  return !status || !status.state || status.state === "UNATTEMPTED";
}

/** Local scheduler clock only; it does not establish formal table completion. */
export function videoPendingRetryClock(statuses: Array<{ state?: unknown; retryAfter?: unknown }>, now: number):
  { remaining: number; due: number; next: number } {
  let remaining = 0, due = 0, next = Infinity;
  for (const status of statuses) {
    if (status.state === "WRITTEN" || status.state === "SOURCE_DELETED") continue;
    remaining++;
    const retryAt = typeof status.retryAfter === "string" ? Date.parse(status.retryAfter) : 0;
    if (!Number.isFinite(retryAt) || retryAt <= now) due++;
    else next = Math.min(next, retryAt);
  }
  return { remaining, due, next };
}
