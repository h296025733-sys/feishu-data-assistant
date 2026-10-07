import type { TikTokVideoRow } from "./types.js";

/**
 * Store-owned videos must stay out of the creator online table, but callers
 * that calculate ROI video counts deliberately do not use this filter.
 */
export function isStoreOwnedVideo(row: TikTokVideoRow, apiShopName: unknown): boolean {
  const authorType = String(row.creator_author_type ?? "").trim().toUpperCase();
  if (authorType === "MARKETING_ACCOUNTS") return true;

  const shopCore = normalizeAccountCore(apiShopName);
  const creatorCore = normalizeAccountCore(row.username ?? row.creator_username);
  if (!shopCore || !creatorCore || shopCore.length < 4) return false;
  if (creatorCore === shopCore) return true;

  // TikTok store accounts often append only digits or a conventional official
  // shop suffix to the visible shop name, for example `storefour248`,
  // `storetwo_shop` or `storetwoofficial2`. Keep this allow-list narrow so an
  // unrelated affiliate such as `storetwodeals` is not excluded by accident.
  if (creatorCore.startsWith(shopCore)) {
    return /^(?:\d+|(?:shop|store|official)\d*)$/.test(creatorCore.slice(shopCore.length));
  }
  if (shopCore.startsWith(creatorCore)) {
    return /^\d+$/.test(shopCore.slice(creatorCore.length));
  }
  return false;
}

export function normalizeAccountCore(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/^@+/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}
