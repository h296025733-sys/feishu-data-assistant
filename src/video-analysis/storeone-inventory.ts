export const STOREONE_VIDEO_ANALYSIS_BASE = "demo_1e0a6606";
export const STOREONE_VIDEO_TABLES = {
  online: "demo_2388c86c",
  account: "demo_a187eeeb",
} as const;
export const STORETWO_VIDEO_ANALYSIS_BASE = "demo_25d345f3";
export const STORETWO_VIDEO_TABLES = {
  online: "demo_14a52eda",
  account: "demo_c10e4c2f",
} as const;
export const STORETWO_BOTANICAL_CARE_VIDEO_ANALYSIS_BASE = "demo_d6641f6c";
export const STORETWO_BOTANICAL_CARE_VIDEO_TABLES = {
  online: "demo_47072db5",
  account: "demo_0f76c2ca",
} as const;
export type StoreVideoTables = { readonly online: string; readonly account: string };
export const ANALYSIS_FIELDS = ["视频内容分析", "投广建议", "视频修改建议"] as const;
export const ANALYSIS_GRADES = ["推荐投广", "待选投广", "不建议投广"] as const;

export interface VideoInventoryRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

export interface VideoCandidate {
  tableId: string;
  recordId: string;
  videoId: string;
  url: string;
  creator: string;
  product: unknown;
  publishedAt: number | null;
  key: string;
}

export interface VideoInventory {
  totalRows: number;
  completeRows: number;
  completeKeys: string[];
  pending: VideoCandidate[];
  partial: Array<{ tableId: string; recordId: string; videoId: string; key: string }>;
  duplicates: Array<{ key: string; recordIds: string[] }>;
  invalid: Array<{ tableId: string; recordId: string; reason: string }>;
}

export function prioritizeObservedVideos(
  pending: VideoCandidate[], firstSeen: Record<string, number>,
): VideoCandidate[] {
  return [...pending].sort((a, b) =>
    (firstSeen[b.key] ?? 0) - (firstSeen[a.key] ?? 0)
    || (b.publishedAt ?? 0) - (a.publishedAt ?? 0)
    || a.key.localeCompare(b.key));
}

export function excludePreviouslyComplete(
  pending: VideoCandidate[], everComplete: Record<string, string>,
): VideoCandidate[] {
  return pending.filter((candidate) => !everComplete[candidate.key]);
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value !== null && typeof value === "object" && "link" in value) {
    return typeof value.link === "string" ? value.link.trim() : "";
  }
  return "";
}

function plainString(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\u2060-\u206f]/g, "").trim() : "";
}

function timestamp(value: unknown): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function buildStoreoneVideoInventory(
  tables: Record<string, VideoInventoryRecord[]>,
): VideoInventory {
  return buildStoreVideoInventory(tables, STOREONE_VIDEO_TABLES);
}

export function buildStoreVideoInventory(
  tables: Record<string, VideoInventoryRecord[]>, tableIds: StoreVideoTables,
): VideoInventory {
  const result: VideoInventory = {
    totalRows: 0, completeRows: 0, completeKeys: [], pending: [], partial: [], duplicates: [], invalid: [],
  };
  const seen = new Map<string, string[]>();
  const candidates: VideoCandidate[] = [];
  for (const [kind, tableId] of Object.entries(tableIds)) {
    const rows = tables[tableId];
    if (!Array.isArray(rows)) throw new Error(`STOREONE table not loaded: ${tableId}`);
    for (const row of rows) {
      result.totalRows++;
      const fields = row.fields ?? {};
      const url = textValue(fields[kind === "online" ? "视频上线地址" : "视频ID网址"]);
      const match = /^https:\/\/(?:www\.)?tiktok\.com\/@[^/]+\/video\/(\d{19})(?:[/?#]|$)/i.exec(url);
      if (!match) {
        result.invalid.push({ tableId, recordId: row.record_id, reason: "缺少有效TikTok视频链接" });
        continue;
      }
      const videoId = match[1];
      const key = `${tableId}:${videoId}`;
      seen.set(key, [...(seen.get(key) ?? []), row.record_id]);
      const values = ANALYSIS_FIELDS.map((name) => fields[name]);
      const filled = values.map((v) => v !== null && v !== undefined && String(v).trim() !== "");
      if (filled.every(Boolean)) {
        result.completeRows++;
        result.completeKeys.push(key);
        continue;
      }
      if (filled.some(Boolean)) {
        result.partial.push({ tableId, recordId: row.record_id, videoId, key });
        continue;
      }
      candidates.push({
        tableId,
        recordId: row.record_id,
        videoId,
        url,
        creator: plainString(fields[kind === "online" ? "达人姓名" : "达人昵称"]),
        product: fields[kind === "online" ? "挂车产品" : "商品"],
        publishedAt: timestamp(fields[kind === "online" ? "实上线日期(Ct)" : "发布时间"]),
        key,
      });
    }
  }
  for (const [key, recordIds] of seen) {
    if (recordIds.length > 1) result.duplicates.push({ key, recordIds });
  }
  const duplicateKeys = new Set(result.duplicates.map((item) => item.key));
  result.pending = candidates.filter((item) => !duplicateKeys.has(item.key));
  result.pending.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0) || a.key.localeCompare(b.key));
  return result;
}
