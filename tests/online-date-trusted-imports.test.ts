import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  registerTrustedOnlineImport,
  trustedOnlineImportDate,
} from "../src/feishu/online-date-trusted-imports.js";

describe("trusted online imports", () => {
  it("returns an unexpired registered date", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trusted-online-"));
    const path = join(directory, "state.json");
    await registerTrustedOnlineImport("rec-1", 123, {
      path,
      now: 1_000,
      ttlMs: 500,
    });
    expect(await trustedOnlineImportDate("rec-1", { path, now: 1_499 })).toBe(123);
  });

  it("rejects expired entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trusted-online-"));
    const path = join(directory, "state.json");
    await registerTrustedOnlineImport("rec-1", 123, {
      path,
      now: 1_000,
      ttlMs: 500,
    });
    expect(await trustedOnlineImportDate("rec-1", { path, now: 1_501 })).toBeNull();
  });
});
