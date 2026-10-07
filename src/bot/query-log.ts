import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const FILE = path.resolve("logs", "queries.jsonl");

export interface QueryLogDetails {
  channel?: "message" | "card";
  mode?: "group" | "private" | "unknown";
  tenantId?: string | null;
  operation?: string | null;
  messageId?: string | null;
  error?: unknown;
}

export function logQuery(
  userId: string,
  success: boolean,
  durationMs: number,
  details: QueryLogDetails = {},
): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const userHash = shortHash(userId);
  const messageHash = details.messageId ? shortHash(details.messageId) : undefined;
  const diagnostic = details.error == null ? null : diagnosticError(details.error);
  fs.appendFileSync(FILE, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    userHash,
    success,
    durationMs,
    ...(details.channel ? { channel: details.channel } : {}),
    ...(details.mode ? { mode: details.mode } : {}),
    ...(details.tenantId ? { tenantId: details.tenantId } : {}),
    ...(details.operation ? { operation: details.operation } : {}),
    ...(messageHash ? { messageHash } : {}),
    ...(diagnostic ? { errorName: diagnostic.name, errorMessage: diagnostic.message } : {}),
  })}\n`, { encoding: "utf8", mode: 0o600 });
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function diagnosticError(error: unknown): { name: string; message: string } {
  const name = error instanceof Error ? error.name : "Error";
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw
    .replace(/(?:access|refresh)[_-]?token\s*[:=]\s*[^\s,;]+/gi, "token=[REDACTED]")
    .replace(/sk-[a-zA-Z0-9_-]+/g, "sk-[REDACTED]")
    .replace(/[A-Z]:\\[^\n；]+/g, "[LOCAL_PATH]")
    .replace(/https?:\/\/[^\s]+/gi, "[URL]")
    .slice(0, 800);
  return { name: name.slice(0, 80), message };
}
