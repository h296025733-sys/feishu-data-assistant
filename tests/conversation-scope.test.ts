import { describe, expect, it } from "vitest";
import {
  isGroupChatType,
  privateConversationSessionKey,
  storeConversationSessionKey,
} from "../src/bot/conversation-scope.js";
import {
  PrivateStoreModeRegistry,
  resolvePrivateStoreMenuTarget,
  shouldUseSelectedPrivateStore,
} from "../src/bot/private-store-mode.js";
import { emptyCrossTenantContext } from "../src/bot/cross-tenant-query.js";

const stores = [
  { id: "storetwo-formal", displayName: "Storetwo", aliases: ["Storetwo Shop"] },
  { id: "storeone-formal", displayName: "STOREONE", aliases: ["STOREONE Shop"] },
];

describe("group/private conversation scopes", () => {
  it("keeps group chats isolated and gives private cards the same per-store key as private text", () => {
    expect(isGroupChatType("group")).toBe(true);
    expect(isGroupChatType("p2p")).toBe(false);
    expect(storeConversationSessionKey("storeone-formal", "oc_a", "group", "ou_1"))
      .toBe("storeone-formal:oc_a:ou_1");
    expect(storeConversationSessionKey("storeone-formal", "oc_private", "p2p", "ou_1"))
      .toBe("storeone-formal:private:ou_1");
    expect(storeConversationSessionKey("storeone-formal", "", "p2p", "ou_1"))
      .toBe("storeone-formal:private:ou_1");
    expect(privateConversationSessionKey("ou_1")).toBe("private:ou_1");
  });

  it("expires private store selection and switches stores explicitly", () => {
    const registry = new PrivateStoreModeRegistry(1_000);
    registry.select("private:ou_1", "storetwo-formal", 10_000);
    expect(registry.current("private:ou_1", 10_999)).toBe("storetwo-formal");
    expect(registry.current("private:ou_1", 11_000)).toBeNull();
    registry.select("private:ou_1", "storeone-formal", 12_000);
    expect(registry.current("private:ou_1", 12_001)).toBe("storeone-formal");
  });

  it("continues the clicked private store unless the user explicitly asks for another or cross-store", () => {
    const context = emptyCrossTenantContext();
    expect(shouldUseSelectedPrivateStore("graceguitron", context, stores)).toBe(true);
    expect(shouldUseSelectedPrivateStore("最近哪个商品卖得最好", context, stores)).toBe(true);
    expect(shouldUseSelectedPrivateStore("STOREONE最近销量怎么样", context, stores)).toBe(false);
    expect(shouldUseSelectedPrivateStore("比较所有店最近7天销售额", context, stores)).toBe(false);
    expect(shouldUseSelectedPrivateStore("最近7天哪家销售额最高", context, stores)).toBe(false);

    const crossContext = { ...context, lastIntent: "store_ranking" as const };
    expect(shouldUseSelectedPrivateStore("那销量呢", crossContext, stores)).toBe(false);
    expect(resolvePrivateStoreMenuTarget("STOREONE 菜单", stores)).toBe("storeone-formal");
    expect(resolvePrivateStoreMenuTarget("进入 Storetwo", stores)).toBe("storetwo-formal");
  });
});
