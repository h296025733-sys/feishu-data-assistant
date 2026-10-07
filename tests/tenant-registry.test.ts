import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TenantRegistry } from "../src/config/tenant-registry.js";
import type { AppEnv } from "../src/config/env.js";

const priorToken = process.env.TEST_STORE_BASE_TOKEN;
const priorTokenA = process.env.TEST_STORE_BASE_TOKEN_A;
const priorTokenB = process.env.TEST_STORE_BASE_TOKEN_B;
afterEach(() => {
  if (priorToken == null) delete process.env.TEST_STORE_BASE_TOKEN;
  else process.env.TEST_STORE_BASE_TOKEN = priorToken;
  if (priorTokenA == null) delete process.env.TEST_STORE_BASE_TOKEN_A;
  else process.env.TEST_STORE_BASE_TOKEN_A = priorTokenA;
  if (priorTokenB == null) delete process.env.TEST_STORE_BASE_TOKEN_B;
  else process.env.TEST_STORE_BASE_TOKEN_B = priorTokenB;
});

describe("tenant registry", () => {
  it("routes a group to its store and keeps secrets in environment variables", () => {
    const root = mkdtempSync(path.join(tmpdir(), "tenant-registry-"));
    const profile = path.join(root, "profile.json");
    writeFileSync(profile, JSON.stringify({
      schemaVersion: 1,
      businessDisplayName: "Store A",
      businessTimeZone: "Asia/Shanghai",
      storeAggregateLabel: "Store A",
      tables: { development: "开发", cooperation: "合作", online: "上线", roi: "投产比" },
      tiktok: { shopAlias: "Shop A", shopTimeZone: "UTC", productMapFile: "map.json" },
    }));
    const registry = path.join(root, "registry.json");
    writeFileSync(registry, JSON.stringify({
      schemaVersion: 1,
      defaultTenantId: "store-a",
      globalQueryConcurrency: 8,
      tenants: [{
        id: "store-a", enabled: true, profileFile: profile,
        routing: { groupChatIds: ["oc_store_a"], allowPrivateFallback: true },
        base: { appTokenEnv: "TEST_STORE_BASE_TOKEN", tableIdEnv: "TEST_STORE_TABLE", baseUrlEnv: "TEST_STORE_URL" },
        ai: { apiKeyEnv: "DEEPSEEK_API_KEY", baseUrlEnv: "DEEPSEEK_BASE_URL", modelEnv: "DEEPSEEK_MODEL" },
        access: { groupMembersEqual: true, scheduleAdminUserIdsEnv: "BOT_ADMIN_USER_IDS" },
        queryConcurrency: 3,
      }],
    }));
    process.env.TEST_STORE_BASE_TOKEN = "app-token-a";
    const loaded = new TenantRegistry(baseEnv(), registry);
    expect(loaded.resolve("oc_store_a", "group").profile.storeAggregateLabel).toBe("Store A");
    expect(loaded.resolve("oc_store_a", "group").env.FEISHU_BITABLE_APP_TOKEN).toBe("app-token-a");
  });

  it("refuses an unregistered group instead of leaking the default store", () => {
    const root = mkdtempSync(path.join(tmpdir(), "tenant-registry-"));
    const profile = path.join(root, "profile.json");
    writeFileSync(profile, JSON.stringify({ schemaVersion: 1, businessDisplayName: "A", businessTimeZone: "UTC", storeAggregateLabel: "A", tables: { development: "D", cooperation: "C", online: "O", roi: "R" }, tiktok: { shopAlias: "A", shopTimeZone: "UTC", productMapFile: "m.json" } }));
    const registry = path.join(root, "registry.json");
    writeFileSync(registry, JSON.stringify({ schemaVersion: 1, defaultTenantId: "aa", globalQueryConcurrency: 2, tenants: [{ id: "aa", enabled: true, profileFile: profile, routing: { groupChatIds: [], allowPrivateFallback: true }, base: { appTokenEnv: "TEST_STORE_BASE_TOKEN", tableIdEnv: "TEST_STORE_TABLE", baseUrlEnv: "TEST_STORE_URL" }, ai: { apiKeyEnv: "DEEPSEEK_API_KEY", baseUrlEnv: "DEEPSEEK_BASE_URL", modelEnv: "DEEPSEEK_MODEL" }, access: { groupMembersEqual: true, scheduleAdminUserIdsEnv: "BOT_ADMIN_USER_IDS" }, queryConcurrency: 1 }] }));
    process.env.TEST_STORE_BASE_TOKEN = "token";
    expect(() => new TenantRegistry(baseEnv(), registry).resolve("unknown", "group")).toThrow("还没有绑定店铺");
  });

  it("persists an administrator group binding and reloads it after restart", () => {
    const root = mkdtempSync(path.join(tmpdir(), "tenant-registry-binding-"));
    const profile = path.join(root, "profile.json");
    const registry = path.join(root, "registry.json");
    const runtimeBindings = path.join(root, "runtime-bindings.json");
    writeFileSync(profile, JSON.stringify({
      schemaVersion: 1,
      businessDisplayName: "Store B",
      businessTimeZone: "Asia/Shanghai",
      storeAggregateLabel: "Store B",
      tables: { development: "开发", cooperation: "合作", online: "上线", roi: "投产比" },
      tiktok: { shopAlias: "Shop B", shopId: "shop-b", shopTimeZone: "UTC", productMapFile: "map.json" },
    }));
    writeFileSync(registry, JSON.stringify({
      schemaVersion: 1,
      defaultTenantId: "store-b",
      globalQueryConcurrency: 4,
      tenants: [{
        id: "store-b", enabled: true, profileFile: profile,
        routing: { groupChatIds: [], allowPrivateFallback: false },
        base: { appTokenEnv: "TEST_STORE_BASE_TOKEN", tableIdEnv: "TEST_STORE_TABLE", baseUrlEnv: "TEST_STORE_URL" },
        ai: { apiKeyEnv: "DEEPSEEK_API_KEY", baseUrlEnv: "DEEPSEEK_BASE_URL", modelEnv: "DEEPSEEK_MODEL" },
        access: { groupMembersEqual: true, scheduleAdminUserIdsEnv: "BOT_ADMIN_USER_IDS" },
        queryConcurrency: 2,
      }],
    }));
    process.env.TEST_STORE_BASE_TOKEN = "token-b";
    const first = new TenantRegistry(baseEnv(), registry, runtimeBindings);
    expect(first.bindGroup("oc_store_b", "store-b", "ou_admin")).toEqual({ tenantId: "store-b", source: "runtime" });
    expect(first.resolve("oc_store_b", "group").profile.businessDisplayName).toBe("Store B");
    expect(first.groupRoutesForTenant("store-b")).toEqual([{ chatId: "oc_store_b", source: "runtime" }]);
    expect(() => first.bindGroup("oc_store_b_second", "store-b", "ou_admin")).toThrow("另一个专属群");

    const restarted = new TenantRegistry(baseEnv(), registry, runtimeBindings);
    expect(restarted.groupRoute("oc_store_b")).toEqual({ tenantId: "store-b", source: "runtime" });
    expect(restarted.resolve("oc_store_b", "group").profile.tiktok.shopId).toBe("shop-b");
    expect(restarted.unbindGroup("oc_store_b", "ou_admin")).toEqual({ tenantId: "store-b", source: "runtime" });
    expect(restarted.groupRoute("oc_store_b")).toBeNull();
    const afterUnbind = new TenantRegistry(baseEnv(), registry, runtimeBindings);
    expect(afterUnbind.groupRoute("oc_store_b")).toBeNull();
  });

  it("never resolves a multi-store private chat to the default tenant", () => {
    const root = mkdtempSync(path.join(tmpdir(), "tenant-registry-private-"));
    const profile = (id: string) => {
      const file = path.join(root, `${id}.json`);
      writeFileSync(file, JSON.stringify({
        schemaVersion: 1,
        businessDisplayName: id,
        businessTimeZone: "UTC",
        storeAggregateLabel: "店铺汇总",
        tables: { development: "D", cooperation: "C", online: "O", roi: "R" },
        tiktok: { shopAlias: id, shopTimeZone: "UTC", productMapFile: `${id}.map.json` },
      }));
      return file;
    };
    const tenant = (id: string, tokenEnv: string) => ({
      id, enabled: true, profileFile: profile(id),
      routing: { groupChatIds: [], allowPrivateFallback: true, allowUnboundGroupFallback: false },
      base: { appTokenEnv: tokenEnv, tableIdEnv: "TEST_STORE_TABLE", baseUrlEnv: "TEST_STORE_URL" },
      ai: { apiKeyEnv: "DEEPSEEK_API_KEY", baseUrlEnv: "DEEPSEEK_BASE_URL", modelEnv: "DEEPSEEK_MODEL" },
      access: { groupMembersEqual: true, scheduleAdminUserIdsEnv: "BOT_ADMIN_USER_IDS" },
      queryConcurrency: 1,
    });
    const registry = path.join(root, "registry.json");
    writeFileSync(registry, JSON.stringify({
      schemaVersion: 1,
      defaultTenantId: "store-a",
      globalQueryConcurrency: 2,
      privateAccess: { enabled: true, userIdsEnv: "BOT_PRIVATE_USER_IDS" },
      tenants: [tenant("store-a", "TEST_STORE_BASE_TOKEN_A"), tenant("store-b", "TEST_STORE_BASE_TOKEN_B")],
    }));
    process.env.TEST_STORE_BASE_TOKEN_A = "token-a";
    process.env.TEST_STORE_BASE_TOKEN_B = "token-b";
    const loaded = new TenantRegistry(baseEnv(), registry);
    expect(() => loaded.resolve("private-chat", "p2p")).toThrow("还没有绑定店铺");
    expect(loaded.privateAccess).toEqual({ enabled: true, userIdsEnv: "BOT_PRIVATE_USER_IDS" });
  });
});

function baseEnv(): AppEnv {
  return {
    FEISHU_APP_ID: "app", FEISHU_APP_SECRET: "secret", FEISHU_BITABLE_URL: "", FEISHU_BITABLE_APP_TOKEN: "", FEISHU_BITABLE_TABLE_ID: "",
    BOT_ALLOWED_USER_IDS: "", MODEL_PROVIDER: "mock", DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com", DEEPSEEK_MODEL: "", DRY_RUN: "true", LOG_LEVEL: "info", DEEPSEEK_INPUT_PRICE_PER_MILLION: 0, DEEPSEEK_OUTPUT_PRICE_PER_MILLION: 0,
  };
}
