import { normalizeText } from "../utils/value.js";

export type EntityMatch =
  | { status: "matched"; value: string; mode: "exact" | "normalized" | "fuzzy" }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "not_found" };

export function matchEntityValue(input: string, candidates: string[]): EntityMatch {
  const unique = [...new Set(candidates.filter(Boolean))];
  const trimmed = input.trim();
  const exact = unique.filter((item) => item === trimmed);
  if (exact.length === 1) return { status: "matched", value: exact[0], mode: "exact" };

  const normalizedInput = normalizeText(trimmed);
  const normalized = unique.filter((item) => normalizeText(item) === normalizedInput);
  if (normalized.length === 1) return { status: "matched", value: normalized[0], mode: "normalized" };

  const fuzzy = unique.filter((item) => {
    const candidate = normalizeText(item);
    return normalizedInput.length >= 2 && (candidate.includes(normalizedInput) || normalizedInput.includes(candidate));
  });
  if (fuzzy.length === 1) return { status: "matched", value: fuzzy[0], mode: "fuzzy" };
  if (fuzzy.length > 1) return { status: "ambiguous", candidates: fuzzy.slice(0, 20) };
  return { status: "not_found" };
}
