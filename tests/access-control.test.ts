import { describe, expect, it } from "vitest";
import { canPerform, queryOperation, roleForUser } from "../src/bot/access-control.js";
import type { AppEnv } from "../src/config/env.js";

const env = {
  BOT_ALLOWED_USER_IDS: "admin,editor,viewer",
  BOT_ADMIN_USER_IDS: "admin",
  BOT_EDITOR_USER_IDS: "editor",
  BOT_VIEWER_USER_IDS: "viewer",
} as AppEnv;

describe("bot access control", () => {
  it("separates users without shared conversational authority", () => {
    expect(roleForUser("admin", env)).toBe("admin");
    expect(roleForUser("editor", env)).toBe("editor");
    expect(roleForUser("viewer", env)).toBe("viewer");
  });

  it("allows editors to fill but reserves sensitive queries and rollback for admins", () => {
    expect(canPerform("editor", "write")).toBe(true);
    expect(canPerform("editor", "query_sensitive")).toBe(false);
    expect(canPerform("editor", "rollback")).toBe(false);
    expect(canPerform("editor", "admin")).toBe(false);
    expect(canPerform("admin", "admin")).toBe(true);
  });

  it("classifies contact and financial questions as sensitive", () => {
    expect(queryOperation("查看红人邮箱和付款情况")).toBe("query_sensitive");
    expect(queryOperation("近七天上线了多少视频")).toBe("query_basic");
  });
});
