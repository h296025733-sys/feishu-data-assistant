import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readTenantRuntimeSettings,
  writeTenantRuntimeSettings,
} from "../src/config/tenant-runtime-settings.js";

const priorCwd = process.cwd();
let temporary = "";

afterEach(async () => {
  process.chdir(priorCwd);
  if (temporary) await rm(temporary, { recursive: true, force: true });
  temporary = "";
});

describe("tenant runtime settings", () => {
  it("persists an isolated per-store schedule atomically", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "tenant-settings-"));
    process.chdir(temporary);
    await writeTenantRuntimeSettings("store-a", {
      enabled: true,
      localTime: "14:30",
      updatedBy: "ou_admin",
    });
    expect(await readTenantRuntimeSettings("store-a")).toMatchObject({
      dailyAutomation: { enabled: true, localTime: "14:30" },
      updatedBy: "ou_admin",
    });
    expect(await readTenantRuntimeSettings("store-b")).toBeNull();
    expect(JSON.parse(await readFile(
      path.join(temporary, ".runtime", "tenants", "store-a", "settings.json"),
      "utf8",
    ))).toHaveProperty("version", 1);
  });
});
