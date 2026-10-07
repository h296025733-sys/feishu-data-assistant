import { describe, expect, it } from "vitest";
import { KeyedSerialQueue } from "../src/automation/keyed-serial-queue.js";

describe("KeyedSerialQueue", () => {
  it("shares an identical in-flight request but preserves different ranges in order", async () => {
    const queue = new KeyedSerialQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = queue.run("7:true", async () => {
      events.push("7-start");
      await gate;
      events.push("7-end");
      return "seven";
    });
    const duplicate = queue.run("7:true", async () => "should-not-run");
    const month = queue.run("30:true", async () => {
      events.push("30-start");
      events.push("30-end");
      return "month";
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["7-start"]);
    expect(duplicate).toBe(first);
    releaseFirst();
    await expect(Promise.all([first, duplicate, month])).resolves.toEqual(["seven", "seven", "month"]);
    expect(events).toEqual(["7-start", "7-end", "30-start", "30-end"]);
  });
});
