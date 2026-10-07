import { describe, expect, it } from "vitest";
import { isStoreOwnedVideo, normalizeAccountCore } from "../src/realtime/video-owner.js";

describe("store-owned video classifier", () => {
  it("uses the API author type when TikTok identifies a marketing account", () => {
    expect(isStoreOwnedVideo({ username: "anything", creator_author_type: "MARKETING_ACCOUNTS" }, "Storefour"))
      .toBe(true);
  });

  it("recognizes a normalized shop-name core with a numeric account suffix", () => {
    expect(isStoreOwnedVideo({ username: "@storefour248", creator_author_type: "AFFILIATE_ACCOUNTS" }, "Store-Four"))
      .toBe(true);
  });

  it("recognizes conventional official shop suffixes", () => {
    expect(isStoreOwnedVideo({ username: "storetwo_shop", creator_author_type: "AFFILIATE_ACCOUNTS" }, "Storetwo"))
      .toBe(true);
    expect(isStoreOwnedVideo({ username: "storetwoofficial2", creator_author_type: "AFFILIATE_ACCOUNTS" }, "Storetwo"))
      .toBe(true);
  });

  it("does not treat an arbitrary matching prefix as the shop account", () => {
    expect(isStoreOwnedVideo({ username: "storetwodeals", creator_author_type: "AFFILIATE_ACCOUNTS" }, "Storetwo"))
      .toBe(false);
    expect(isStoreOwnedVideo({ username: "storetwofan", creator_author_type: "AFFILIATE_ACCOUNTS" }, "Storetwo"))
      .toBe(false);
  });

  it("does not exclude an unrelated affiliate creator", () => {
    expect(isStoreOwnedVideo({ username: "graceguitron", creator_author_type: "AFFILIATE_ACCOUNTS" }, "Storefour"))
      .toBe(false);
  });

  it("normalizes case, punctuation and unicode width", () => {
    expect(normalizeAccountCore("＠Ｓｔｏｒｅ－Ｆｏｕｒ ")).toBe("storefour");
  });
});
