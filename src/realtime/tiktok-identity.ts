const TIKTOK_PROFILE_PREFIX = /^https?:\/\/(?:www\.)?tiktok\.com\/@/i;
const TIKTOK_HANDLE_PATTERN = /^[a-z0-9._]+$/;
const INVISIBLE_CHARACTERS = /[\u200B-\u200D\u2060\u2063\uFEFF]/g;

/**
 * Canonical value used by every Feishu field named 红人姓名 / 达人姓名.
 * It is a TikTok username without @, never a display nickname or numeric creator ID.
 */
export function normalizeTikTokHandle(value: unknown): string {
  let handle = String(value ?? "").replace(INVISIBLE_CHARACTERS, "").trim();
  if (!handle) return "";

  handle = handle.replace(TIKTOK_PROFILE_PREFIX, "");
  handle = (handle.split(/[/?#]/, 1)[0] ?? "")
    .replace(/^@+/, "")
    .trim()
    .toLowerCase();

  if (!handle || !TIKTOK_HANDLE_PATTERN.test(handle)) return "";
  return handle;
}

export function requireTikTokHandleFromVideoRow(
  row: Record<string, unknown>,
): string {
  for (const candidate of [row.creator_user_name, row.username]) {
    const handle = normalizeTikTokHandle(candidate);
    if (handle) return handle;
  }

  throw new Error(
    "TikTok 视频缺少可用的 creator_user_name/username；拒绝用展示昵称或 creator ID 填写达人姓名",
  );
}
