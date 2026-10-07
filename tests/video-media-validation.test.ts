import { describe, expect, it } from "vitest";
import { VIDEO_DOWNLOAD_FORMAT, validateDownloadedVideo } from "../src/video-analysis/media-validation.js";

const id = "7693346160194358541";
const probe = { streams: [{ codec_type: "video", width: 720, height: 1280 }], format: { duration: "70.082993" } };
describe("downloaded source identity and playable evidence", () => {
  it("requires a video codec in every download fallback, never bare best or audio-only", () => {
    expect(VIDEO_DOWNLOAD_FORMAT).toBe(
      "best[vcodec^=h264][ext=mp4]/best[vcodec!=none][ext=mp4]/best[vcodec!=none]",
    );
    for (const fallback of VIDEO_DOWNLOAD_FORMAT.split("/")) {
      expect(fallback).toMatch(/\[vcodec(?:\^=h264|!=none)\]/);
    }
  });
  it("accepts an exact-ID playable complete download", () => {
    expect(validateDownloadedVideo(probe, id, { id, duration: 70 })).toBeNull();
  });
  it("rejects audio-only, empty, and attached cover art", () => {
    expect(validateDownloadedVideo({ streams: [{ codec_type: "audio" }] }, id)).toBe("NO_VIDEO_STREAM");
    expect(validateDownloadedVideo(null, id)).toBe("INVALID_MEDIA_PROBE");
    expect(validateDownloadedVideo({ ...probe, streams: [{ ...probe.streams[0], disposition: { attached_pic: 1 } }] }, id)).toBe("NO_VIDEO_STREAM");
  });
  it("does not accept another video's media metadata", () => {
    expect(validateDownloadedVideo(probe, id, { id: "9999999999999999999" })).toBe("VIDEO_ID_MISMATCH");
  });
  it("rejects missing duration and truncated footage", () => {
    expect(validateDownloadedVideo({ ...probe, format: {} }, id)).toBe("INVALID_DURATION");
    expect(validateDownloadedVideo({ ...probe, format: { duration: 3 } }, id, { id, duration: 70 })).toBe("DURATION_MISMATCH");
  });
  it("allows pre-existing evidence with job-bound identity and no new info JSON", () => {
    expect(validateDownloadedVideo(probe, id)).toBeNull();
  });
});
