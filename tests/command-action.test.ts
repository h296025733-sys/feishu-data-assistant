import { describe, expect, it } from "vitest";
import { resolveCommandAction } from "../src/cli/command-action.js";

describe("resolveCommandAction", () => {
  it("never downgrades an explicitly confirmed apply command to the audit fallback", () => {
    expect(resolveCommandAction(
      ["--apply", "--confirm", "ACCOUNT-SIDE-FORMAL-TWO-EXISTING-BASES-20260814"],
      { applyFlag: "--apply", fallback: "--audit", ignoredFlags: ["--confirm"] },
    )).toBe("--apply");
  });

  it("keeps an explicit read-only command", () => {
    expect(resolveCommandAction(
      ["--prepare"],
      { applyFlag: "--apply", fallback: "--audit", ignoredFlags: ["--confirm"] },
    )).toBe("--prepare");
  });
});
