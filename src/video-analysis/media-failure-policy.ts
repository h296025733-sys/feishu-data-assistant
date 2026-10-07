export type MediaFailure = "rate_limited" | "login_required" | "ip_blocked" | "source_not_video" | "no_video_stream" | "network_transient" | "unknown";

/** Inspect every native downloader, including the official-player JSON, before shortening any wait. */
export function classifyMediaFailure(text: string): MediaFailure {
  if (/HTTP(?: Error|\/[^\s]+)?[^\r\n]{0,40}\b429\b|"(?:apiStatus|status)"\s*:\s*429|Too Many Requests/i.test(text)) return "rate_limited";
  if (/IP address is blocked|HTTP Error 403|"(?:apiStatus|status)"\s*:\s*403|Forbidden/i.test(text)) return "ip_blocked";
  if (/log in for access|requiring login|login_required|comfortable for some audiences|HTTP Error 401/i.test(text)) return "login_required";
  // Audio-only downloads prove a failed extraction, not the original post's type.
  if (/PHOTO_POST_WITH_BACKGROUND_AUDIO/.test(text)) return "source_not_video";
  if (/NO_VIDEO_STREAM/.test(text)) return "no_video_stream";
  if (/Failed to connect|Could not connect|TLS|WinError 10054|timed out|connection|handshake|reset by peer/i.test(text)) return "network_transient";
  return "unknown";
}

export const MEDIA_TRANSIENT_WAIT_MS = 30 * 60_000;
export const MEDIA_HOLD_WAIT_MS = 24 * 3600_000;

/** Honor a server-provided Retry-After even when it is longer than the conservative local hold. */
export function mediaRetryDelay(reason: MediaFailure, retryAfterHeader: unknown, now = Date.now()): number {
  const baseline = reason === "network_transient" ? MEDIA_TRANSIENT_WAIT_MS : MEDIA_HOLD_WAIT_MS;
  if (typeof retryAfterHeader !== "string") return baseline;
  const header = retryAfterHeader.trim();
  const delay = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.max(baseline, delay) : baseline;
}

/** This is a correction to our missed connection-error classifier, not an override of native rate/denial waits. */
export function correctedMediaRetryAfter(status: { state?: unknown; reason?: unknown; at?: unknown; retryAfter?: unknown },
  nativeLogs: string): string | null {
  if (status.state !== "MEDIA_UNAVAILABLE" || status.reason !== "unknown"
      || typeof status.at !== "string" || typeof status.retryAfter !== "string"
      || classifyMediaFailure(nativeLogs) !== "network_transient"
      || /retry[-_ ]?after/i.test(nativeLogs)) return null;
  const at = Date.parse(status.at), priorRetry = Date.parse(status.retryAfter);
  // Only migrate the exact old 24-hour application policy. Never shorten a different/native schedule.
  if (!Number.isFinite(at) || !Number.isFinite(priorRetry)
      || Math.abs(priorRetry - at - MEDIA_HOLD_WAIT_MS) > 5000) return null;
  return new Date(at + MEDIA_TRANSIENT_WAIT_MS).toISOString();
}
