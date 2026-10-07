import fs from "node:fs";
import path from "node:path";
import type { AppEnv } from "../config/env.js";

export interface ModelCallRecord {
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  success: boolean;
  estimatedCost: number;
}

const LOG_FILE = path.resolve("logs", "model-calls.jsonl");

export function estimateCost(env: AppEnv, inputTokens: number, outputTokens: number): number {
  return inputTokens / 1_000_000 * env.DEEPSEEK_INPUT_PRICE_PER_MILLION
    + outputTokens / 1_000_000 * env.DEEPSEEK_OUTPUT_PRICE_PER_MILLION;
}

export function logModelCall(record: ModelCallRecord): void {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readModelCalls(): ModelCallRecord[] {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs.readFileSync(LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as ModelCallRecord]; } catch { return []; }
  });
}
