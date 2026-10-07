/** Read a profile link without changing the source business cell. */
export function avatarProfileText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(avatarProfileText).join("");
  if (value && typeof value === "object") {
    const cell = value as { link?: unknown; text?: unknown };
    return typeof cell.link === "string" ? cell.link
      : typeof cell.text === "string" ? cell.text : "";
  }
  return "";
}

/** Only leading formatting after @ is tolerated; never guess or join handles. */
export function avatarProfileHandle(value: unknown): string | null {
  const url = avatarProfileText(value).trim().replace(/[\u200B-\u200D\u2060-\u206F\uFEFF]/g, "")
    // Rich-text paste may append an object-replacement marker after the URL.
    // Strip only a trailing formatting suffix, never join a split account name.
    .replace(/[\s\uFFFC]+$/u, "");
  return /^https?:\/\/(?:www\.)?tiktok\.com\/@\s*([A-Za-z0-9._]+)(?:\/?(?:\?[^#\s]*)?(?:#[^\s]*)?)$/i
    .exec(url)?.[1]?.toLowerCase() ?? null;
}
