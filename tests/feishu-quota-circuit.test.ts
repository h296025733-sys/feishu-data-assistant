import { describe, expect, it } from "vitest";
import {
  FeishuQuotaCircuitOpenError,
  isFeishuQuotaOrRateLimitError,
  resetFeishuBitableQuotaCircuitsForTest,
  withFeishuBitableQuotaCircuit,
} from "../src/feishu/client.js";

describe("Feishu Bitable quota circuit", () => {
  it("counts simultaneous failures as one probe generation rather than a 16-minute cooldown", async () => {
    resetFeishuBitableQuotaCircuitsForTest();
    const now = 5_000_000;
    const releases: Array<(value: unknown) => void> = [];
    const requests = Array.from({ length: 12 }, () => withFeishuBitableQuotaCircuit("burst",
      () => new Promise((_, reject) => { releases.push(reject); }), () => now).catch((error) => error));
    releases.forEach((reject) => reject({ status: 429 }));
    const errors = await Promise.all(requests);
    expect(errors.every((error) => error instanceof FeishuQuotaCircuitOpenError && error.retryAt === now + 60_000)).toBe(true);
  });
  it("does not reopen a newer 429 circuit when an older concurrent request succeeds", async () => {
    resetFeishuBitableQuotaCircuitsForTest();
    let complete!: (value: string) => void;
    const old = withFeishuBitableQuotaCircuit("race", () => new Promise<string>((resolve) => { complete = resolve; }));
    await expect(withFeishuBitableQuotaCircuit("race", async () => { throw { status: 429 }; }))
      .rejects.toBeInstanceOf(FeishuQuotaCircuitOpenError);
    complete("old success");
    await old;
    let called = false;
    await expect(withFeishuBitableQuotaCircuit("race", async () => { called = true; }))
      .rejects.toBeInstanceOf(FeishuQuotaCircuitOpenError);
    expect(called).toBe(false);
  });
  it("opens immediately on HTTP 429, respects Retry-After, and performs no blocked network calls", async () => {
    resetFeishuBitableQuotaCircuitsForTest();
    let now = 1_000_000;
    let calls = 0;
    const limited = async () => {
      calls += 1;
      throw {
        response: {
          status: 429,
          headers: { "retry-after": "120" },
          data: { message: "quota exhausted secret-token-must-not-leak" },
        },
      };
    };
    const first = await withFeishuBitableQuotaCircuit("app-a", limited, () => now).catch((error) => error);
    expect(first).toBeInstanceOf(FeishuQuotaCircuitOpenError);
    expect(first.retryAt).toBe(now + 120_000);
    expect(first.message).not.toContain("secret-token");

    await Promise.all(Array.from({ length: 10 }, () => (
      withFeishuBitableQuotaCircuit("app-a", async () => { calls += 1; return "unexpected"; }, () => now)
        .then(() => "unexpected", (error) => error)
    )));
    expect(calls).toBe(1);
    now += 119_999;
    await expect(withFeishuBitableQuotaCircuit("app-a", async () => { calls += 1; }, () => now))
      .rejects.toBeInstanceOf(FeishuQuotaCircuitOpenError);
    expect(calls).toBe(1);
  });

  it("allows only one half-open probe and resets after success", async () => {
    resetFeishuBitableQuotaCircuitsForTest();
    let now = 2_000_000;
    await withFeishuBitableQuotaCircuit("app-b", async () => {
      throw { response: { status: 429 } };
    }, () => now).catch(() => undefined);
    now += 60_000;

    let release!: (value: string) => void;
    let calls = 0;
    const probe = withFeishuBitableQuotaCircuit("app-b", () => {
      calls += 1;
      return new Promise<string>((resolve) => { release = resolve; });
    }, () => now);
    await expect(withFeishuBitableQuotaCircuit("app-b", async () => {
      calls += 1;
      return "unexpected";
    }, () => now)).rejects.toBeInstanceOf(FeishuQuotaCircuitOpenError);
    expect(calls).toBe(1);
    release("ok");
    await expect(probe).resolves.toBe("ok");
    await expect(withFeishuBitableQuotaCircuit("app-b", async () => {
      calls += 1;
      return "normal";
    }, () => now)).resolves.toBe("normal");
    expect(calls).toBe(2);
  });

  it("does not classify ordinary permission and schema errors as quota exhaustion", () => {
    resetFeishuBitableQuotaCircuitsForTest();
    expect(isFeishuQuotaOrRateLimitError({ response: { status: 400 } })).toBe(false);
    expect(isFeishuQuotaOrRateLimitError({ response: { status: 403 } })).toBe(false);
    expect(isFeishuQuotaOrRateLimitError({ response: { status: 429 } })).toBe(true);
    expect(isFeishuQuotaOrRateLimitError({ code: 99991400 })).toBe(true);
  });
});
