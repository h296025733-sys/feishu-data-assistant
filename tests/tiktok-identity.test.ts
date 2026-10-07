import { describe, expect, it } from "vitest";
import {
  normalizeTikTokHandle,
  requireTikTokHandleFromVideoRow,
} from "../src/realtime/tiktok-identity.js";

describe("TikTok identity normalization", () => {
  it("normalizes @, whitespace and case", () => {
    expect(normalizeTikTokHandle(" @PrettyVee6_ ")).toBe("prettyvee6_");
  });

  it("extracts a handle from a TikTok profile URL", () => {
    expect(normalizeTikTokHandle("https://www.tiktok.com/@Storefour248/?lang=en"))
      .toBe("storefour248");
  });

  it("ignores legacy invisible duplicate markers", () => {
    expect(normalizeTikTokHandle("\u2063graceguitron")).toBe("graceguitron");
  });

  it("prefers creator_user_name over the fallback username", () => {
    expect(requireTikTokHandleFromVideoRow({
      creator_user_name: "Storefour248",
      username: "fallback_user",
      creator_nick_name: "STOREFOUR",
    })).toBe("storefour248");
  });

  it("never falls back to the display nickname", () => {
    expect(() => requireTikTokHandleFromVideoRow({
      creator_nick_name: "STOREFOUR",
    })).toThrow(/拒绝用展示昵称/);
  });

  it("does not read a creator ID as a username", () => {
    expect(() => requireTikTokHandleFromVideoRow({
      creator_id: "7491035096200287278",
    })).toThrow(/creator ID/);
  });

  it("keeps a numeric-only value when the API explicitly returns it as username", () => {
    expect(requireTikTokHandleFromVideoRow({ username: "12345678" }))
      .toBe("12345678");
  });
});
