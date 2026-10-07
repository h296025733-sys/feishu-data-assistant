import { spawn } from "node:child_process";
import { z } from "zod";
import type { BusinessProfile } from "../config/business-profile.js";
import type { TikTokMachineContract } from "./types.js";

const TIKTOK_ROOT = (process.env.TIKTOK_PIPELINE_ROOT || "../tiktok-shop-data-pipeline");
const PYTHON = process.env.TIKTOK_PIPELINE_PYTHON || `${TIKTOK_ROOT}\\.venv\\Scripts\\python.exe`;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface TikTokRuntimeContext {
  credentialProfile?: string;
  shopId?: string;
  shopName?: string;
}

export function tikTokRuntimeFromProfile(profile: BusinessProfile): TikTokRuntimeContext {
  return {
    credentialProfile: profile.tiktok.credentialProfile,
    shopId: profile.tiktok.shopId,
    shopName: profile.tiktok.shopAlias,
  };
}

const contractSchema = z.object({
  ok: z.boolean(),
  dataset: z.string(),
  shop: z.object({ id: z.string().optional(), name: z.string().optional() }).nullable(),
  window_start: z.string(),
  window_end_exclusive: z.string(),
  fetched_at: z.string(),
  rows: z.array(z.record(z.string(), z.unknown())),
  row_count: z.number().int().nonnegative(),
  exact_duplicate_count: z.number().int().nonnegative(),
  conflicting_duplicate_ids: z.array(z.string()),
  request_ids: z.array(z.string()),
  raw_source_paths: z.array(z.string()),
  normalized_source_path: z.string().nullable(),
  required_scope: z.array(z.string()),
  granted_scope: z.array(z.string()),
  missing_capabilities: z.array(z.string()),
  errors: z.array(z.string()),
  raw_source_sha256: z.record(z.string(), z.string()).optional(),
  raw_row_count: z.number().int().nonnegative().optional(),
  pagination_truncated: z.boolean().optional(),
  latest_available_date: z.string().nullable().optional(),
}).passthrough();

const productDetailSchema = z.object({
  ok: z.boolean(),
  dataset: z.literal("product_detail"),
  shop: z.object({ id: z.string().optional(), name: z.string().optional() }).nullable(),
  fetched_at: z.string(),
  product: z.record(z.string(), z.unknown()),
  raw_source_path: z.string(),
  normalized_source_path: z.string().nullable(),
  required_scope: z.array(z.string()),
  granted_scope: z.array(z.string()),
  errors: z.array(z.string()),
}).passthrough();

const productCatalogSchema = z.object({
  ok: z.boolean(),
  dataset: z.literal("product_catalog"),
  shop: z.object({ id: z.string().optional(), name: z.string().optional() }).nullable(),
  fetched_at: z.string(),
  rows: z.array(z.record(z.string(), z.unknown())),
  row_count: z.number().int().nonnegative(),
  exact_duplicate_count: z.number().int().nonnegative(),
  conflicting_duplicate_ids: z.array(z.string()),
  raw_source_paths: z.array(z.string()),
  normalized_source_path: z.string().nullable(),
  required_scope: z.array(z.string()),
  granted_scope: z.array(z.string()),
  errors: z.array(z.string()),
  pagination_truncated: z.boolean().optional(),
}).passthrough();

const orderAttributionSchema = z.object({
  ok: z.boolean(),
  dataset: z.literal("order_attribution"),
  shop: z.object({ id: z.string().optional(), name: z.string().optional() }).nullable(),
  window_start: z.string(),
  window_end_exclusive: z.string(),
  fetched_at: z.string(),
  rows: z.array(z.record(z.string(), z.unknown())),
  row_count: z.number().int().nonnegative(),
  store_rows: z.array(z.record(z.string(), z.unknown())),
  store_row_count: z.number().int().nonnegative(),
  request_ids: z.array(z.string()),
  raw_source_paths: z.array(z.string()),
  normalized_source_path: z.string().nullable(),
  required_scope: z.array(z.string()),
  granted_scope: z.array(z.string()),
  missing_capabilities: z.array(z.string()),
  errors: z.array(z.string()),
  pagination_truncated: z.boolean(),
  write_ready: z.boolean(),
  classification_policy: z.enum([
    "seller_affiliate_order_tags_exact_v1",
    "affiliate_non_live_as_video",
  ]),
  approximation_acknowledged: z.boolean(),
  business_time_zone: z.string().min(1),
  latest_available_date: z.string().nullable().optional(),
  write_ready_dates: z.array(z.string()),
  pending_dates: z.array(z.string()),
  unclassified_items: z.number().int().nonnegative().optional(),
  reconciliation_errors: z.array(z.string()).optional(),
  reconciliation_warnings: z.array(z.string()).optional(),
  paid_snapshot_policy: z.literal("paid_positive_non_sample_local_day_exact_v2"),
  paid_snapshot_dates: z.array(z.string()),
  paid_snapshot_rows: z.array(z.record(z.string(), z.unknown())),
  paid_snapshot_store_rows: z.array(z.record(z.string(), z.unknown())),
  paid_snapshot_sales_errors: z.array(z.string()).optional(),
  paid_snapshot_ready: z.boolean(),
}).passthrough();

const paidOrderSnapshotSchema = z.object({
  ok: z.boolean(),
  dataset: z.literal("paid_order_snapshot"),
  shop: z.object({ id: z.string().optional(), name: z.string().optional() }).nullable(),
  window_start: z.string(),
  window_end_exclusive: z.string(),
  fetched_at: z.string(),
  business_time_zone: z.string().min(1),
  paid_snapshot_policy: z.literal("paid_positive_non_sample_local_day_exact_v2"),
  paid_snapshot_dates: z.array(z.string()),
  paid_snapshot_rows: z.array(z.record(z.string(), z.unknown())),
  paid_snapshot_store_rows: z.array(z.record(z.string(), z.unknown())),
  paid_snapshot_sales_errors: z.array(z.string()).optional(),
  paid_snapshot_ready: z.boolean(),
  video_attribution_policy: z.literal("affiliate_content_id_exact_v1"),
  video_attribution_ready: z.boolean(),
  video_order_rows: z.array(z.record(z.string(), z.unknown())),
  video_attribution_errors: z.array(z.string()),
  request_ids: z.array(z.string()),
  raw_source_paths: z.array(z.string()),
  normalized_source_path: z.string().nullable(),
  required_scope: z.array(z.string()),
  granted_scope: z.array(z.string()),
  missing_capabilities: z.array(z.string()),
  errors: z.array(z.string()),
  pagination_truncated: z.boolean(),
}).passthrough();

export type TikTokPaidOrderSnapshotContract = z.infer<typeof paidOrderSnapshotSchema>;

export async function fetchTikTokOrderAttribution(
  startDate: string,
  endDateExclusive: string,
  timeZone: string,
  targetCollaborationIsSelfOperated: boolean,
  timeoutMs = 180_000,
  runtime: TikTokRuntimeContext = {},
): Promise<z.infer<typeof orderAttributionSchema>> {
  const args = [
    "-m", "src.cli", "tiktok", "order-attribution",
    "--start-date", startDate,
    "--end-date-exclusive", endDateExclusive,
    "--time-zone", timeZone,
    ...(targetCollaborationIsSelfOperated ? ["--target-collaboration-is-self-operated"] : []),
    "--page-size", "100",
    "--max-pages", "100",
    "--machine-json",
  ];
  const result = await spawnJson(PYTHON, args, timeoutMs, runtime);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(`TikTok 订单归因 stdout 不是单一 JSON：${safeDiagnostic(error)}`);
  }
  const validated = orderAttributionSchema.safeParse(parsed);
  if (!validated.success) throw new Error(`TikTok 订单归因 JSON 合同校验失败：${z.prettifyError(validated.error)}`);
  if (result.exitCode !== 0 || !validated.data.ok) {
    throw new Error(`TikTok 订单归因查询失败：${validated.data.errors.join("；") || result.stderr || result.exitCode}`);
  }
  if (!validated.data.write_ready && !validated.data.paid_snapshot_ready) {
    throw new Error([
      `TikTok 订单归因存在 ${validated.data.unclassified_items ?? 0} 件未归类数据`,
      ...(validated.data.reconciliation_errors ?? []),
    ].join("；"));
  }
  return validated.data;
}

export async function fetchTikTokPaidOrderSnapshot(
  startDate: string,
  endDateExclusive: string,
  timeZone: string,
  timeoutMs = 120_000,
  runtime: TikTokRuntimeContext = {},
): Promise<TikTokPaidOrderSnapshotContract> {
  return fetchTikTokPaidSnapshotCommand(
    "paid-order-snapshot",
    startDate,
    endDateExclusive,
    timeZone,
    timeoutMs,
    runtime,
  );
}

export async function fetchTikTokPaidOrderReportSnapshot(
  startDate: string,
  endDateExclusive: string,
  timeZone: string,
  timeoutMs = 180_000,
  runtime: TikTokRuntimeContext = {},
): Promise<TikTokPaidOrderSnapshotContract> {
  return fetchTikTokPaidSnapshotCommand(
    "paid-order-report-snapshot",
    startDate,
    endDateExclusive,
    timeZone,
    timeoutMs,
    runtime,
  );
}

async function fetchTikTokPaidSnapshotCommand(
  command: "paid-order-snapshot" | "paid-order-report-snapshot",
  startDate: string,
  endDateExclusive: string,
  timeZone: string,
  timeoutMs: number,
  runtime: TikTokRuntimeContext,
): Promise<TikTokPaidOrderSnapshotContract> {
  const args = [
    "-m", "src.cli", "tiktok", command,
    "--start-date", startDate,
    "--end-date-exclusive", endDateExclusive,
    "--time-zone", timeZone,
    "--page-size", "100",
    "--max-pages", "100",
    "--machine-json",
  ];
  const result = await spawnJson(PYTHON, args, timeoutMs, runtime);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(`TikTok 付款快照 stdout 不是单一 JSON：${safeDiagnostic(error)}`);
  }
  const validated = paidOrderSnapshotSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`TikTok 付款快照 JSON 合同校验失败：${z.prettifyError(validated.error)}`);
  }
  if (result.exitCode !== 0 || !validated.data.ok) {
    throw new Error(
      `TikTok 付款快照查询失败：${validated.data.errors.join("；") || result.stderr || result.exitCode}`,
    );
  }
  if (validated.data.pagination_truncated) {
    throw new Error("TikTok 付款快照分页不完整，拒绝用于爆量监测");
  }
  if (!validated.data.paid_snapshot_ready) {
    throw new Error("TikTok 付款快照发现未知订单状态，拒绝用于爆量监测");
  }
  return validated.data;
}

export async function fetchTikTokVideoDay(
  startDate: string,
  endDateExclusive: string,
  timeoutMs = 180_000,
  runtime: TikTokRuntimeContext = {},
  accountType: "ALL" | "OFFICIAL_ACCOUNTS" | "MARKETING_ACCOUNTS" | "AFFILIATE_ACCOUNTS" = "ALL",
  apiVersion: "202605" | "202509" = "202605",
  pageSize = 100,
): Promise<TikTokMachineContract> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("视频分页大小必须为1至100");
  const args = [
    "-m",
    "src.cli",
    "tiktok",
    "video-performance",
    "--start-date",
    startDate,
    "--end-date-exclusive",
    endDateExclusive,
    "--page-size",
    String(pageSize),
    "--max-pages",
    "100",
    "--api-version",
    apiVersion,
    "--account-type",
    accountType,
    "--machine-json",
  ];
  const result = await spawnJson(PYTHON, args, timeoutMs, runtime);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(
      `TikTok CLI stdout 不是单一 JSON（退出码 ${result.exitCode}）：`
      + `${safeDiagnostic(error)}；stderr=${result.stderr || "空"}`,
    );
  }
  const validated = contractSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`TikTok CLI JSON 合同校验失败：${z.prettifyError(validated.error)}`);
  }
  if (result.exitCode !== 0 && validated.data.ok) {
    throw new Error(`TikTok CLI 退出码 ${result.exitCode} 与 ok=true 冲突`);
  }
  if (validated.data.pagination_truncated) {
    throw new Error("TikTok API 分页达到安全上限，拒绝使用不完整结果");
  }
  return validated.data as TikTokMachineContract;
}

export async function fetchTikTokAnalytics(
  dataset: string,
  startDate: string,
  endDateExclusive: string,
  resourceId = "",
  timeoutMs = 180_000,
  runtime: TikTokRuntimeContext = {},
): Promise<TikTokMachineContract> {
  const args = [
    "-m",
    "src.cli",
    "tiktok",
    "analytics",
    "--dataset",
    dataset,
    "--start-date",
    startDate,
    "--end-date-exclusive",
    endDateExclusive,
    "--page-size",
    "100",
    "--max-pages",
    "100",
    ...(resourceId ? ["--resource-id", resourceId] : []),
    "--machine-json",
  ];
  const result = await spawnJson(PYTHON, args, timeoutMs, runtime);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(
      `TikTok Analytics stdout 不是单一 JSON（退出码 ${result.exitCode}）：`
      + `${safeDiagnostic(error)}；stderr=${result.stderr || "空"}`,
    );
  }
  const validated = contractSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`TikTok Analytics JSON 合同校验失败：${z.prettifyError(validated.error)}`);
  }
  if (result.exitCode !== 0 || !validated.data.ok) {
    throw new Error(
      `TikTok Analytics 查询失败：${validated.data.errors.join("；") || result.stderr || result.exitCode}`,
    );
  }
  if (validated.data.pagination_truncated) {
    throw new Error("TikTok Analytics 分页达到安全上限，拒绝使用不完整结果");
  }
  return validated.data as TikTokMachineContract;
}

export async function fetchTikTokProductDetail(
  productId: string,
  timeoutMs = 60_000,
  runtime: TikTokRuntimeContext = {},
): Promise<TikTokMachineContract> {
  if (!/^\d+$/.test(productId)) throw new Error("TikTok 商品 ID 必须是纯数字");
  const args = [
    "-m",
    "src.cli",
    "tiktok",
    "product",
    "--product-id",
    productId,
    "--machine-json",
  ];
  const result = await spawnJson(PYTHON, args, timeoutMs, runtime);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(
      `TikTok 商品详情 stdout 不是单一 JSON（退出码 ${result.exitCode}）：`
      + `${safeDiagnostic(error)}；stderr=${result.stderr || "空"}`,
    );
  }
  const validated = productDetailSchema.safeParse(parsed);
  if (!validated.success) {
    const failed = parsed as { errors?: unknown };
    const errors = Array.isArray(failed?.errors) ? failed.errors.map(String).join("；") : "";
    if (result.exitCode !== 0 && errors) throw new Error(`TikTok 商品详情查询失败：${errors}`);
    throw new Error(`TikTok 商品详情 JSON 合同校验失败：${z.prettifyError(validated.error)}`);
  }
  if (result.exitCode !== 0 || !validated.data.ok) {
    throw new Error(`TikTok 商品详情查询失败：${validated.data.errors.join("；") || result.stderr || result.exitCode}`);
  }
  return {
    ok: true,
    dataset: "product_detail",
    shop: validated.data.shop,
    window_start: "",
    window_end_exclusive: "",
    fetched_at: validated.data.fetched_at,
    rows: [validated.data.product],
    row_count: 1,
    exact_duplicate_count: 0,
    conflicting_duplicate_ids: [],
    request_ids: [],
    raw_source_paths: [validated.data.raw_source_path],
    normalized_source_path: validated.data.normalized_source_path,
    required_scope: validated.data.required_scope,
    granted_scope: validated.data.granted_scope,
    missing_capabilities: [],
    errors: [],
    latest_available_date: null,
  };
}

export async function fetchTikTokProductCatalog(
  timeoutMs = 180_000,
  runtime: TikTokRuntimeContext = {},
): Promise<z.infer<typeof productCatalogSchema>> {
  const result = await spawnJson(PYTHON, [
    "-m", "src.cli", "tiktok", "products",
    "--page-size", "100",
    "--max-pages", "100",
    "--machine-json",
  ], timeoutMs, runtime);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(`TikTok 商品目录 stdout 不是单一 JSON：${safeDiagnostic(error)}`);
  }
  const validated = productCatalogSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`TikTok 商品目录 JSON 合同校验失败：${z.prettifyError(validated.error)}`);
  }
  if (result.exitCode !== 0 || !validated.data.ok) {
    throw new Error(`TikTok 商品目录查询失败：${validated.data.errors.join("；") || result.stderr || result.exitCode}`);
  }
  if (validated.data.pagination_truncated) {
    throw new Error("TikTok 商品目录分页达到安全上限，拒绝使用不完整结果");
  }
  return validated.data;
}

export async function fetchTikTokShopRisks(runtime: TikTokRuntimeContext): Promise<unknown> {
  const result = await spawnJson(PYTHON, ["-m", "src.tiktok.shop_risks"], 240_000, runtime);
  if (result.exitCode !== 0) throw new Error(`TikTok 风险检查失败：${safeDiagnostic(result.stdout || result.stderr)}`);
  return JSON.parse(result.stdout.trim());
}

async function spawnJson(
  command: string,
  args: string[],
  timeoutMs: number,
  runtime: TikTokRuntimeContext,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: TIKTOK_ROOT,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...isolatedChildEnvironment(),
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        ...(runtime.credentialProfile ? { TTS_CREDENTIAL_PROFILE: runtime.credentialProfile } : {}),
        ...(runtime.shopId ? { TTS_SHOP_ID: runtime.shopId } : {}),
        ...(runtime.shopName ? { TTS_SHOP_NAME: runtime.shopName } : {}),
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) child.kill();
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) child.kill();
      else stderr.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 TikTok CLI：${safeDiagnostic(error)}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`TikTok CLI 超时（${timeoutMs}ms）`));
        return;
      }
      if (outputBytes > MAX_OUTPUT_BYTES) {
        reject(new Error("TikTok CLI 输出超过 64 MiB 安全上限"));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8").replace(/^\uFEFF/, ""),
        stderr: safeDiagnostic(Buffer.concat(stderr).toString("utf8")),
        exitCode: code ?? -1,
      });
    });
  });
}

export function isolatedChildEnvironment(): NodeJS.ProcessEnv {
  const blocked = [
    /^FEISHU_/i,
    /^BOT_/i,
    /^MODEL_/i,
    /^DEEPSEEK_/i,
    /^TTS_/i,
    /^TIKTOK_/i,
    /^SAFE_MODE$/i,
    /^DRY_RUN$/i,
    /^LOG_LEVEL$/i,
    /^ALLOW_PII$/i,
    /^BROWSER_AUTOMATION_ENABLED$/i,
  ];
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !blocked.some((pattern) => pattern.test(key))),
  );
}

function safeDiagnostic(value: unknown): string {
  return String(value)
    .replace(/(?i:app[_ -]?secret|access[_ -]?token|refresh[_ -]?token|shop_cipher|sign)(\s*[:=]\s*)[^\s,;&]+/g, "$1$2****")
    .replace(/https:\/\/[^\s]+[?&](?:sign|shop_cipher|access_token)=[^\s&]+/gi, "[已脱敏URL]")
    .slice(0, 2_000);
}
