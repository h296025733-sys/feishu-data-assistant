import type { DataRow } from "../types/index.js";

export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u200B-\u200D\u2060\u2063\uFEFF]/g, "")
    .trim()
    .toLocaleLowerCase("zh-CN")
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function canonicalRow(row: DataRow, headers = Object.keys(row)): string {
  return JSON.stringify(headers.map((header) => normalizeCell(row[header])));
}

function normalizeCell(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    return value.replace(/[\u200B-\u200D\u2060\u2063\uFEFF]/g, "").trim();
  }
  return value ?? null;
}

export function deduplicateRows(rows: DataRow[], headers?: string[]): DataRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = canonicalRow(row, headers);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = value.trim().replace(/[,，￥¥$\s]/g, "");
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

export function toDateKey(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDate(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const absolute = Math.abs(value);
    const date = absolute >= 100_000_000_000
      ? new Date(value)
      : absolute >= 1_000_000_000
        ? new Date(value * 1_000)
        : new Date(Date.UTC(1899, 11, 30) + value * 86_400_000);
    return Number.isNaN(date.getTime()) ? null : formatDate(date);
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  const direct = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?/);
  if (direct) return `${direct[1]}-${direct[2].padStart(2, "0")}-${direct[3].padStart(2, "0")}`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : formatDate(parsed);
}

export function formatDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function shiftDate(date: Date, days: number): string {
  const shifted = new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  return formatDate(shifted);
}
