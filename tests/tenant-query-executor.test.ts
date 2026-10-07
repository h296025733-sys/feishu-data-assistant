import { describe, expect, it } from "vitest";
import { TenantQueryExecutor } from "../src/bot/tenant-query-executor.js";

describe("TenantQueryExecutor", () => {
  it("enforces per-tenant limits while allowing another store to run", async () => {
    const executor = new TenantQueryExecutor(2);
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const task = (name: string) => executor.run(name[0], 1, async () => {
      started.push(name);
      await new Promise<void>((resolve) => releases.push(resolve));
      return name;
    });
    const first = task("a1");
    const second = task("a2");
    const third = task("b1");
    await Promise.resolve();
    expect(started).toEqual(["a1", "b1"]);
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["a1", "b1", "a2"]);
    releases.splice(0).forEach((release) => release());
    await expect(Promise.all([first, second, third])).resolves.toEqual(["a1", "a2", "b1"]);
  });
});
