import * as lark from "@larksuiteoapi/node-sdk";
import type { AppEnv } from "../config/env.js";

const RETRYABLE_FEISHU_CODES = new Set([1254290, 1254291, 1254607, 99991400]);
const MONTHLY_QUOTA_EXHAUSTED_CODE = 99991403;
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_BITABLE_QUOTA_COOLDOWN_MS = 60_000;
const MAX_BITABLE_QUOTA_COOLDOWN_MS = 30 * 60_000;

interface BitableQuotaCircuitState {
  consecutiveFailures: number;
  blockedUntil: number;
  probeInFlight: boolean;
  generation: number;
}

const bitableQuotaCircuits = new Map<string, BitableQuotaCircuitState>();

export interface FeishuErrorDetails {
  status: number | null;
  code: number | null;
  message: string;
  retryAfterMs: number | null;
}

export class FeishuQuotaCircuitOpenError extends Error {
  public readonly retryAt: number;
  public readonly status: number | null;
  public readonly code: number | null;

  public constructor(retryAt: number, details: Pick<FeishuErrorDetails, "status" | "code"> = { status: 429, code: null }) {
    super(`飞书多维表格 API 已触发配额/限流保护，暂停请求至 ${new Date(retryAt).toISOString()}`);
    this.name = "FeishuQuotaCircuitOpenError";
    this.retryAt = retryAt;
    this.status = details.status;
    this.code = details.code;
  }
}

export interface FeishuRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
}

export function createFeishuClient(env: AppEnv): lark.Client {
  // Keep the SDK's response/token interceptors, but never let a hung socket
  // occupy a store's serial sync/report queue indefinitely.
  const httpInstance = new Proxy(lark.defaultHttpInstance, {
    get(target, property) {
      if (property === "request") {
        return (options: Record<string, any>) => target.request({
          ...options,
          timeout: options.timeout && options.timeout > 0 ? options.timeout : 30_000,
        });
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new lark.Client({
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
    httpInstance,
    loggerLevel: lark.LoggerLevel.fatal,
    logger: {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
    },
  });
}

export function assertFeishuResponse(response: { code?: number; msg?: string }, action: string): void {
  if (response.code && response.code !== 0) {
    throw Object.assign(new Error(`${action}失败（${response.code}）：${response.msg ?? "未知错误"}`), {
      code: response.code,
    });
  }
}

/**
 * Retry a Feishu operation only when the failure is transient. Callers that
 * perform writes must provide their own idempotency key (for example `uuid`).
 */
export async function withFeishuRetry<T>(
  operation: () => Promise<T>,
  options: FeishuRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.min(4, Math.trunc(options.attempts ?? 3)));
  const baseDelayMs = Math.max(0, Math.min(5_000, Math.trunc(options.baseDelayMs ?? 350)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || isFeishuMonthlyQuotaExhausted(error) || !isRetryableFeishuError(error)) throw error;
      await delay(feishuRetryDelayMs(error, baseDelayMs * attempt));
    }
  }
  throw lastError;
}

/**
 * Share one quota circuit across every Bitable consumer of the same Feishu app.
 * IM replies deliberately do not use this circuit: an exhausted Bitable quota
 * must not prevent the bot from returning a concise failure message.
 */
export async function withFeishuBitableQuotaCircuit<T>(
  appId: string | null | undefined,
  operation: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const key = String(appId ?? "").trim() || "__default__";
  const state = bitableQuotaCircuits.get(key) ?? {
    consecutiveFailures: 0,
    blockedUntil: 0,
    probeInFlight: false,
    generation: 0,
  };
  bitableQuotaCircuits.set(key, state);
  const current = now();
  if (state.blockedUntil > current) throw new FeishuQuotaCircuitOpenError(state.blockedUntil);
  const probing = state.consecutiveFailures > 0;
  if (probing && state.probeInFlight) {
    throw new FeishuQuotaCircuitOpenError(Math.max(state.blockedUntil, current + 1_000));
  }
  if (probing) state.probeInFlight = true;
  const generation = state.generation;
  try {
    const result = await operation();
    const response = result && typeof result === "object" ? result as Record<string, unknown> : {};
    if (isFeishuQuotaOrRateLimitError(response)) {
      throw quotaCircuitError(state, feishuErrorDetails(response), now(), generation);
    }
    // A successful request started BEFORE a concurrent 429 cannot reopen it.
    if (state.generation === generation) {
      state.consecutiveFailures = 0;
      state.blockedUntil = 0;
    }
    return result;
  } catch (error) {
    if (error instanceof FeishuQuotaCircuitOpenError) throw error;
    if (isFeishuQuotaOrRateLimitError(error)) {
      throw quotaCircuitError(state, feishuErrorDetails(error), now(), generation);
    }
    throw error;
  } finally {
    if (probing) state.probeInFlight = false;
  }
}

export function feishuErrorDetails(error: unknown): FeishuErrorDetails {
  const record = error && typeof error === "object" ? error as Record<string, any> : {};
  const response = record.response && typeof record.response === "object"
    ? record.response as Record<string, any>
    : {};
  const data = response.data && typeof response.data === "object"
    ? response.data as Record<string, any>
    : record;
  const headers = response.headers && typeof response.headers === "object"
    ? response.headers as Record<string, unknown>
    : {};
  const status = firstFiniteNumber(record.status, record.statusCode, response.status, response.statusCode);
  const code = firstFiniteNumber(data.code, record.code);
  const retryAfterMs = parseRetryAfterMs(headers["retry-after"] ?? headers["Retry-After"]);
  const primaryMessage = error instanceof Error ? error.message : String(record.message ?? error ?? "");
  const apiMessage = String(data.msg ?? data.message ?? record.msg ?? "").trim();
  const message = [primaryMessage, apiMessage]
    .map((item) => item.trim())
    .filter((item, index, all) => item && all.indexOf(item) === index)
    .join("；");
  return { status, code, message, retryAfterMs };
}

export function isFeishuMonthlyQuotaExhausted(error: unknown): boolean {
  const details = feishuErrorDetails(error);
  return details.code === MONTHLY_QUOTA_EXHAUSTED_CODE
    || /(?:this month'?s|monthly|本月).*(?:api.*quota|调用次数|额度).*(?:exceed|exhaust|耗尽|超限)/i.test(details.message);
}

export function isFeishuQuotaOrRateLimitError(error: unknown): boolean {
  if (error instanceof FeishuQuotaCircuitOpenError) return true;
  const details = feishuErrorDetails(error);
  return details.status === 429
    || details.code === MONTHLY_QUOTA_EXHAUSTED_CODE
    || details.code === 99991400
    || /(?:quota|rate.?limit|too many requests|调用次数|额度).*(?:exceed|exhaust|limit|耗尽|超限)?/i.test(details.message);
}

export function feishuRetryDelayMs(error: unknown, fallbackMs: number, now = Date.now()): number {
  if (error instanceof FeishuQuotaCircuitOpenError) {
    return Math.max(fallbackMs, error.retryAt - now);
  }
  const retryAfter = feishuErrorDetails(error).retryAfterMs;
  return Math.max(fallbackMs, retryAfter ?? 0);
}

/** Test-only reset; production callers must never manually reopen the circuit. */
export function resetFeishuBitableQuotaCircuitsForTest(): void {
  bitableQuotaCircuits.clear();
}

export function isRetryableFeishuError(error: unknown): boolean {
  if (error instanceof FeishuQuotaCircuitOpenError) return false;
  if (isFeishuMonthlyQuotaExhausted(error)) return false;
  const record = error && typeof error === "object" ? error as Record<string, any> : {};
  const response = record.response && typeof record.response === "object"
    ? record.response as Record<string, any>
    : {};
  const responseData = response.data && typeof response.data === "object"
    ? response.data as Record<string, any>
    : {};
  const numericCodes = [
    record.code,
    record.status,
    record.statusCode,
    response.status,
    response.statusCode,
    responseData.code,
  ].map(Number).filter(Number.isFinite);
  if (numericCodes.some((code) => RETRYABLE_FEISHU_CODES.has(code) || RETRYABLE_HTTP_STATUSES.has(code))) {
    return true;
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /(?:ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|socket hang up|network error|fetch failed|Data not ready|UND_ERR_(?:CONNECT_)?TIMEOUT|AbortError|TimeoutError)/i.test(message)
    || /(?:HTTP|status(?: code)?)\s*[:=]?\s*(?:429|500|502|503|504)\b/i.test(message)
    || /(?:1254290|1254291|1254607|99991400)/.test(message);
}

function quotaCircuitError(
  state: BitableQuotaCircuitState,
  details: FeishuErrorDetails,
  now: number,
  requestGeneration: number,
): FeishuQuotaCircuitOpenError {
  // One in-flight burst represents one failed probe generation, not N
  // consecutive probes. Still honor a later response's longer Retry-After.
  if (state.generation !== requestGeneration && state.blockedUntil > now) {
    if (details.retryAfterMs !== null) state.blockedUntil = Math.max(state.blockedUntil,
      now + Math.min(MAX_BITABLE_QUOTA_COOLDOWN_MS, details.retryAfterMs));
    return new FeishuQuotaCircuitOpenError(state.blockedUntil, details);
  }
  state.consecutiveFailures += 1;
  state.generation += 1;
  const exponential = DEFAULT_BITABLE_QUOTA_COOLDOWN_MS * (2 ** Math.min(4, state.consecutiveFailures - 1));
  const cooldown = Math.min(
    MAX_BITABLE_QUOTA_COOLDOWN_MS,
    Math.max(DEFAULT_BITABLE_QUOTA_COOLDOWN_MS, details.retryAfterMs ?? exponential),
  );
  state.blockedUntil = Math.max(state.blockedUntil, now + cooldown);
  return new FeishuQuotaCircuitOpenError(state.blockedUntil, details);
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseRetryAfterMs(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
