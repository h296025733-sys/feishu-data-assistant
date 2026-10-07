const PACK_SUFFIX = /\s*[（(\[]\s*(\d+)\s*(?:PCS?|PIECES?|个装|件装|只装|套装)\s*[）)\]]\s*$/i;
const BARE_PACK_SUFFIX = /\s+(\d+)\s*(?:PCS?|PIECES?|个装|件装|只装|套装)\s*$/i;

export function canonicalizeProductName(input: string): string {
  const normalized = input.normalize("NFKC").replace(/\s+/g, " ").trim();
  const match = normalized.match(PACK_SUFFIX) ?? normalized.match(BARE_PACK_SUFFIX);
  if (!match) return normalized;
  const base = normalized.slice(0, match.index).trim();
  return `${base}（${Number(match[1])}PCS）`;
}

export function requireCanonicalProductName(input: string): string {
  const name = canonicalizeProductName(input);
  if (!name) throw new Error("商品名不能为空");
  if (name.length > 24 || /https?:\/\/|\n|\r/.test(name)) {
    throw new Error("商品名请使用精炼中文名；不要粘贴商品长标题、链接或促销文案");
  }
  return name;
}
