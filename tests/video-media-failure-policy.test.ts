import { describe, expect, it } from "vitest";
import { classifyMediaFailure, correctedMediaRetryAfter, mediaRetryDelay } from "../src/video-analysis/media-failure-policy.js";

describe("native media failure classification and narrow legacy repair", () => {
  const connection = "curl: (28) Failed to connect to www.tiktok.com port 443. Could not connect to server";
  const old = { state: "MEDIA_UNAVAILABLE", reason: "unknown", at: "2026-10-06T01:00:00.000Z", retryAfter: "2026-10-07T01:00:00.000Z" };
  it("recognizes curl connection failures and migrates only the old application 24h policy", () => {
    expect(classifyMediaFailure(connection)).toBe("network_transient");
    expect(correctedMediaRetryAfter(old, connection)).toBe("2026-10-06T01:30:00.000Z");
    expect(correctedMediaRetryAfter({ ...old, retryAfter: "2026-10-08T01:00:00.000Z" }, connection)).toBeNull();
  });
  it("never shortens a rate limit even when another attempt had connection errors", () => {
    for (const rate of ['{"error":"HTTP Error 429: "}', '{"apiStatus":429}', '{"attempts":[{"status":429}]}', "HTTP/2 429 Too Many Requests"]) {
      expect(classifyMediaFailure(connection + rate)).toBe("rate_limited");
      expect(correctedMediaRetryAfter(old, connection + rate)).toBeNull();
    }
  });
  it("preserves denial, login, unknown, explicit retry instructions and previously classified holds", () => {
    for (const denial of ["HTTP Error 403", "Forbidden", "IP address is blocked", "log in for access", "requiring login", "Retry-After: 3600"]) {
      expect(correctedMediaRetryAfter(old, connection + denial)).toBeNull();
    }
    expect(correctedMediaRetryAfter(old, "unknown response")).toBeNull();
    expect(correctedMediaRetryAfter({ ...old, reason: "ip_blocked" }, connection)).toBeNull();
    expect(correctedMediaRetryAfter({ ...old, at: "bad-date" }, connection)).toBeNull();
    expect(correctedMediaRetryAfter({ ...old, state: "WRITTEN" }, connection)).toBeNull();
  });
  it("honors native Retry-After without shortening the conservative rate-limit hold", () => {
    const now = Date.parse("2026-10-06T00:00:00.000Z");
    expect(mediaRetryDelay("rate_limited", "172800", now)).toBe(172800000);
    expect(mediaRetryDelay("rate_limited", "Thu, 08 Oct 2026 00:00:00 GMT", now)).toBe(172800000);
    expect(mediaRetryDelay("rate_limited", "60", now)).toBe(86400000);
    expect(mediaRetryDelay("ip_blocked", "172800", now)).toBe(172800000);
    expect(mediaRetryDelay("login_required", "172800", now)).toBe(172800000);
    expect(mediaRetryDelay("network_transient", undefined, now)).toBe(1800000);
  });
  it("recognizes native page-session denial and authentication without treating them as transient", () => {
    expect(classifyMediaFailure('HTTP Error 401: native page denial')).toBe("login_required");
    expect(classifyMediaFailure('login_required: PUBLIC_PAGE_AUTH_OR_CHALLENGE_REDIRECT')).toBe("login_required");
    expect(classifyMediaFailure('HTTP Error 403: native media denial')).toBe("ip_blocked");
    expect(classifyMediaFailure('HTTP Error 429: native page denial')).toBe("rate_limited");
  });
  it("keeps audio-only payloads distinct from successful videos and transport errors", () => {
    expect(classifyMediaFailure(connection + '{"validation":"NO_VIDEO_STREAM"}')).toBe("no_video_stream");
    expect(correctedMediaRetryAfter(old, connection + '{"validation":"NO_VIDEO_STREAM"}')).toBeNull();
    expect(classifyMediaFailure('NO_VIDEO_STREAM HTTP Error 429')).toBe("rate_limited");
    expect(classifyMediaFailure('NO_VIDEO_STREAM: PHOTO_POST_WITH_BACKGROUND_AUDIO')).toBe("source_not_video");
    expect(classifyMediaFailure('NO_VIDEO_STREAM: PUBLIC_POST_VIDEO_METADATA_MISSING')).toBe("no_video_stream");
    expect(classifyMediaFailure('PHOTO_POST_WITH_BACKGROUND_AUDIO HTTP Error 403')).toBe("ip_blocked");
  });
});
