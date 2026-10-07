import { describe, expect, it } from "vitest";
import {
  feishuErrorDetails,
  isFeishuMonthlyQuotaExhausted,
  isRetryableFeishuError,
  withFeishuRetry,
  withFeishuBitableQuotaCircuit,
  resetFeishuBitableQuotaCircuitsForTest,
} from "../src/feishu/client.js";

describe("Feishu transient retry", () => {
  it("retries native HTTP 400 Data-not-ready reads without opening the quota circuit", async () => {
    resetFeishuBitableQuotaCircuitsForTest();
    let attempts = 0;
    const result = await withFeishuRetry(() => withFeishuBitableQuotaCircuit("avatar-read-test", async () => {
      attempts += 1;
      if (attempts < 3) throw { response: { status: 400,
        data: { code: 1254607, msg: "Data not ready, please try again later" } } };
      return "readback";
    }), { attempts: 3, baseDelayMs: 0 });
    expect(result).toBe("readback");
    expect(attempts).toBe(3);
  });
  it("retries transient read/reply failures and then returns the successful result", async () => {
    let attempts = 0;
    const result = await withFeishuRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("socket hang up ECONNRESET");
      return "ok";
    }, { attempts: 3, baseDelayMs: 0 });
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("does not retry permission or schema failures", async () => {
    let attempts = 0;
    await expect(withFeishuRetry(async () => {
      attempts += 1;
      throw new Error("读取飞书字段失败（1254040）：Forbidden");
    }, { attempts: 3, baseDelayMs: 0 })).rejects.toThrow("Forbidden");
    expect(attempts).toBe(1);
    expect(isRetryableFeishuError(new Error("HTTP 503"))).toBe(true);
    expect(isRetryableFeishuError(new Error("Forbidden"))).toBe(false);
  });

  it("fails fast on the exhausted monthly API quota and preserves the native reason", async () => {
    let attempts = 0;
    const error = {
      response: {
        status: 429,
        data: { code: 99991403, msg: "This month's API call quota has been exceeded" },
      },
      message: "Request failed with status code 429",
    };
    await expect(withFeishuRetry(async () => {
      attempts += 1;
      throw error;
    }, { attempts: 4, baseDelayMs: 0 })).rejects.toBe(error);
    expect(attempts).toBe(1);
    expect(isFeishuMonthlyQuotaExhausted(error)).toBe(true);
    expect(isRetryableFeishuError(error)).toBe(false);
    expect(feishuErrorDetails(error).message).toContain("This month's API call quota has been exceeded");
  });
});
