/** Reject audio-only extraction even when yt-dlp's incomplete-format fallback accepts it. */
export const VIDEO_DOWNLOAD_FORMAT =
  "best[vcodec^=h264][ext=mp4]/best[vcodec!=none][ext=mp4]/best[vcodec!=none]";

/** Local evidence validation only; does not establish a business-table write or video-content analysis. */
export function validateDownloadedVideo(probe: unknown, expectedId: string, info?: unknown): string | null {
  if (!/^\d{19}$/.test(expectedId)) return "INVALID_EXPECTED_ID";
  if (info != null && (typeof info !== "object" || String((info as { id?: unknown }).id) !== expectedId)) {
    return "VIDEO_ID_MISMATCH";
  }
  if (!probe || typeof probe !== "object") return "INVALID_MEDIA_PROBE";
  const value = probe as { streams?: Array<{ codec_type?: unknown; width?: unknown; height?: unknown;
    disposition?: { attached_pic?: unknown } }>; format?: { duration?: unknown } };
  if (!Array.isArray(value.streams) || !value.streams.some(stream => stream.codec_type === "video"
      && Number(stream.width) > 0 && Number(stream.height) > 0 && !stream.disposition?.attached_pic)) {
    return "NO_VIDEO_STREAM";
  }
  const duration = Number(value.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) return "INVALID_DURATION";
  // A playable first fragment is not necessarily the complete video.
  const expectedDuration = info && typeof info === "object" ? Number((info as { duration?: unknown }).duration) : NaN;
  if (Number.isFinite(expectedDuration) && expectedDuration > 0
      && Math.abs(duration - expectedDuration) > Math.max(2, expectedDuration * 0.05)) return "DURATION_MISMATCH";
  return null;
}
