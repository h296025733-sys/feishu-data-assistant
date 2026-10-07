import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PrivateAccessRegistry, parsePrivateAccessCommand } from "../src/bot/private-access.js";

describe("private access registry", () => {
  it("persists runtime members while keeping the bootstrap admin protected", () => {
    const path = join(mkdtempSync(join(tmpdir(), "private-access-")), "members.json");
    const registry = new PrivateAccessRegistry(["ou_admin"], path);
    expect(registry.grant("ou_member")).toBe("added");
    expect(registry.has("ou_member")).toBe(true);
    expect(registry.revoke("ou_admin")).toBe("bootstrap_admin");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ members: ["ou_member"] });

    const reloaded = new PrivateAccessRegistry(["ou_admin"], path);
    expect(reloaded.all()).toEqual(["ou_admin", "ou_member"]);
    expect(reloaded.revoke("ou_member")).toBe("removed");
    expect(reloaded.has("ou_member")).toBe(false);
  });

  it("parses only explicit access-management commands", () => {
    expect(parsePrivateAccessCommand("授权私聊 ou_member-1")).toEqual({ kind: "grant", userId: "ou_member-1" });
    expect(parsePrivateAccessCommand("取消私聊权限 ou_member-1")).toEqual({ kind: "revoke", userId: "ou_member-1" });
    expect(parsePrivateAccessCommand("私聊权限名单")).toEqual({ kind: "list" });
    expect(parsePrivateAccessCommand("帮我看看谁销售最好")).toBeNull();
  });
});
