export type FeishuMessageMention = {
  key?: unknown;
  name?: unknown;
};

/** Remove the leading bot mention that Feishu keeps in group-message text. */
export function normalizeFeishuMessageText(
  text: string,
  mentions: readonly FeishuMessageMention[] = [],
): string {
  let normalized = text.trim();
  const prefixes = new Set<string>();
  for (const mention of mentions) {
    const key = String(mention.key ?? "").trim();
    const name = String(mention.name ?? "").trim();
    if (key) prefixes.add(key);
    if (name) prefixes.add(name.startsWith("@") ? name : `@${name}`);
  }

  let changed = true;
  while (changed && normalized) {
    changed = false;
    const placeholder = normalized.match(/^@_user_\d+(?:[\s,，:：]+|$)/i);
    if (placeholder) {
      normalized = normalized.slice(placeholder[0].length).trim();
      changed = true;
      continue;
    }
    for (const prefix of prefixes) {
      const matched = normalized.match(new RegExp(`^${escapeRegex(prefix)}(?:[\\s,，:：]+|$)`, "i"));
      if (!matched) continue;
      normalized = normalized.slice(matched[0].length).trim();
      changed = true;
      break;
    }
  }
  return normalized;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
