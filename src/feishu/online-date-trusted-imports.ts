import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
const writes = new Map<string, Promise<void>>();

const STATE_VERSION = 1;
export const DEFAULT_TRUSTED_IMPORT_PATH = resolve(
  ".runtime",
  "online-date-trusted-imports.json",
);

interface TrustedImportEntry {
  expectedDate: number;
  expiresAt: number;
}

interface TrustedImportState {
  version: number;
  entries: Record<string, TrustedImportEntry>;
}

export async function registerTrustedOnlineImport(
  recordId: string,
  expectedDate: number,
  options: {
    path?: string;
    now?: number;
    ttlMs?: number;
  } = {},
): Promise<void> {
  return registerTrustedOnlineImports([{ recordId, expectedDate }], options);
}

export async function registerTrustedOnlineImports(
  entries: readonly { recordId: string; expectedDate: number }[],
  options: { path?: string; now?: number; ttlMs?: number } = {},
): Promise<void> {
  const statePath = options.path ?? DEFAULT_TRUSTED_IMPORT_PATH;
  const write = (writes.get(statePath) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const now = options.now ?? Date.now();
    // Exact record/date allowlist, not permission to write arbitrary dates.
    // Keep it across a long offline import and the following bot restart.
    const ttlMs = options.ttlMs ?? 24 * 60 * 60_000;
    const state = await readState(statePath, now);
    for (const { recordId, expectedDate } of entries) {
      state.entries[recordId] = { expectedDate, expiresAt: now + ttlMs };
    }
    await writeState(statePath, state);
  });
  writes.set(statePath, write);
  try { await write; } finally { if (writes.get(statePath) === write) writes.delete(statePath); }
}

export async function trustedOnlineImportDate(
  recordId: string,
  options: { path?: string; now?: number } = {},
): Promise<number | null> {
  const statePath = options.path ?? DEFAULT_TRUSTED_IMPORT_PATH;
  const now = options.now ?? Date.now();
  const state = await readState(statePath, now);
  const entry = state.entries[recordId];
  return entry && entry.expiresAt >= now ? entry.expectedDate : null;
}

export async function trustedOnlineImportDates(
  recordIds: readonly string[],
  options: { path?: string; now?: number } = {},
): Promise<Map<string, number>> {
  const now = options.now ?? Date.now();
  const state = await readState(options.path ?? DEFAULT_TRUSTED_IMPORT_PATH, now);
  return new Map(recordIds.flatMap((id) => state.entries[id] ? [[id, state.entries[id]!.expectedDate] as const] : []));
}

async function readState(path: string, now: number): Promise<TrustedImportState> {
  let parsed: TrustedImportState = { version: STATE_VERSION, entries: {} };
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<TrustedImportState>;
    if (value.version === STATE_VERSION && value.entries && typeof value.entries === "object") {
      parsed = {
        version: STATE_VERSION,
        entries: value.entries as Record<string, TrustedImportEntry>,
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  parsed.entries = Object.fromEntries(
    Object.entries(parsed.entries).filter(([, entry]) => (
      Number.isFinite(entry.expectedDate)
      && Number.isFinite(entry.expiresAt)
      && entry.expiresAt >= now
    )),
  );
  return parsed;
}

async function writeState(path: string, state: TrustedImportState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}
