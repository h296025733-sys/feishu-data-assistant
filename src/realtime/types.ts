export type RealtimeJobStatus =
  | "received"
  | "parsed"
  | "needs_input"
  | "planned"
  | "blocked"
  | "executing"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RealtimeIntent =
  | {
      action: "update_video";
      startDate: string;
      endDateInclusive: string;
      target: "online";
    }
  | {
      action: "import_online_videos";
      startDate: string;
      endDateInclusive: string;
      target: "online";
      creatorHandle?: string;
      videoId?: string;
    }
  | {
      action: "import_online_from_cooperations";
      target: "online";
      scope: "latest" | "all";
    }
  | {
      action: "clarify_online_import";
      target: "online";
      creatorHandle: string;
      reason: "missing_date";
    }
  | {
      action: "update_roi";
      startDate: string;
      endDateInclusive: string;
      target: "roi";
      productName?: string;
      productScope?: "single" | "all_mapped";
      rowFilter?: "all" | "orders_positive";
    }
  | {
      action: "delete_roi_product";
      target: "roi";
      productName?: string;
    }
  | {
      action: "update_all";
      startDate: string;
      endDateInclusive: string;
      target: "all";
    }
  | {
      action: "create_cooperation";
      details: string;
      target: "cooperation";
    }
  | {
      action: "modify_business";
      details: string;
      target: "development" | "cooperation" | "online" | "unknown";
    };

export type RealtimeControlAction =
  | "status"
  | "cancel"
  | "continue"
  | "rollback_preview"
  | "rollback_confirm";

export interface RollbackPreviewState {
  requestedByUserIdHash: string;
  requestedAt: string;
  expiresAt: string;
  messageId: string;
}

export interface RollbackResultState {
  completedAt: string;
  restored: number;
  skipped: number;
  resultPath: string;
}

export interface RealtimeJob {
  version: 1;
  jobId: string;
  userIdHash: string;
  messageId: string;
  idempotencyKey: string;
  taskKey: string;
  intent: RealtimeIntent;
  status: RealtimeJobStatus;
  createdAt: string;
  updatedAt: string;
  missingItems: string[];
  prompt: string | null;
  resultSummary: RealtimeResultSummary | null;
  error: string | null;
  rollbackPreview?: RollbackPreviewState | null;
  rollbackResult?: RollbackResultState | null;
}

export interface RealtimeResultSummary {
  windowStart: string | null;
  windowEndExclusive: string | null;
  sources: string[];
  matched: number;
  created: number;
  updated: number;
  deleted?: number;
  unchanged: number;
  skipped: number;
  conflicts: number;
  missingItems: string[];
  backupPath: string | null;
  rollbackCommand: string | null;
}

export interface TikTokVideoRow {
  id?: unknown;
  username?: unknown;
  views?: unknown;
  items_sold?: unknown;
  gmv_amount?: unknown;
  gmv_currency?: unknown;
  video_post_time?: unknown;
  [key: string]: unknown;
}

export interface TikTokMachineContract {
  ok: boolean;
  dataset: string;
  shop: { id?: string; name?: string } | null;
  window_start: string;
  window_end_exclusive: string;
  fetched_at: string;
  rows: TikTokVideoRow[];
  row_count: number;
  exact_duplicate_count: number;
  conflicting_duplicate_ids: string[];
  request_ids: string[];
  raw_source_paths: string[];
  normalized_source_path: string | null;
  required_scope: string[];
  granted_scope: string[];
  missing_capabilities: string[];
  errors: string[];
  raw_source_sha256?: Record<string, string>;
  raw_row_count?: number;
  pagination_truncated?: boolean;
  latest_available_date?: string | null;
}

export interface FeishuFieldMeta {
  fieldId: string;
  fieldName: string;
  type: number;
  uiType: string;
}

export interface FeishuTableMeta {
  tableId: string;
  name: string;
  fields: FeishuFieldMeta[];
}

export interface FeishuRecordSnapshot {
  tableId: string;
  tableName: string;
  recordId: string;
  fields: Record<string, unknown>;
  lastModifiedTime: number;
}

export interface VideoUpdateChange {
  tableId: string;
  tableName: string;
  recordId: string;
  uniqueKey: string;
  beforeFields: Record<string, unknown>;
  afterFields: Record<string, unknown>;
  lastModifiedTime: number;
  sourceField: string;
  sourceFiles: string[];
  requestIds: string[];
  reason: string;
}

export interface VideoUpdatePlan {
  version: 1;
  jobId: string;
  generatedAt: string;
  windowStart: string;
  windowEndExclusive: string;
  dataset: string;
  sourceFiles: string[];
  requestIds: string[];
  changes: VideoUpdateChange[];
  matched: number;
  unchanged: number;
  skipped: number;
  conflicts: Array<{ key: string; reason: string }>;
  missingItems: string[];
  exactDuplicateCount: number;
}
