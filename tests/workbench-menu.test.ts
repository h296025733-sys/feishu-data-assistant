import { describe, expect, it } from "vitest";
import {
  buildProductApprovalCard,
  buildPrivateWorkbenchCard,
  buildWorkbenchCard,
  isPrivateWorkbenchMenuText,
  parseCardAction,
  parseCardTenantId,
  parseProductApprovalAction,
  resolveMenuText,
  resolveWorkbenchAction,
} from "../src/bot/workbench-menu.js";
import type { BusinessProfile } from "../src/config/business-profile.js";

const profile = {
  schemaVersion: 1,
  businessDisplayName: "Demo",
  businessTimeZone: "Asia/Shanghai",
  storeAggregateLabel: "Demo Store",
  tables: { development: "开发", cooperation: "合作", online: "上线", roi: "经营" },
  tiktok: {
    shopAlias: "shop",
    shopTimeZone: "America/Los_Angeles",
    productMapFile: "map.json",
  },
} satisfies BusinessProfile;

describe("workbench menu", () => {
  it("builds a private store selector whose buttons remain tenant scoped", () => {
    const card = JSON.stringify(buildPrivateWorkbenchCard([
      { tenantId: "storetwo-formal", displayName: "Storetwo" },
      { tenantId: "storeone-formal", displayName: "STOREONE" },
    ]));
    expect(card).toContain("私聊经营工作区");
    expect(card).toContain("Storetwo");
    expect(card).toContain("STOREONE");
    expect(card).toContain('"tw_action":"root"');
    expect(card).toContain('"tenant_id":"storetwo-formal"');
    expect(card).toContain('"tenant_id":"storeone-formal"');
    expect(parseCardTenantId({ tenant_id: "storeone-formal" })).toBe("storeone-formal");
    expect(isPrivateWorkbenchMenuText("帮助")).toBe(true);
  });

  it("builds and parses a tenant-scoped product confirmation action", () => {
    const card = buildProductApprovalCard([{
      productId: "1732504520547078146",
      sourceTitle: "2% Salicylic Acid Body Wash",
      suggestedName: "水杨酸沐浴露",
      firstSeenDate: "2026-08-05",
      lastSeenDate: "2026-08-05",
    }], profile, "storetwo");
    expect(JSON.stringify(card)).toContain("确认“水杨酸沐浴露”");
    expect(JSON.stringify(card)).toContain("1 个经营商品");
    expect(JSON.stringify(card)).toContain("第2组改成二合一充电宝手电筒");
    expect(parseProductApprovalAction({
      tw_action: "confirm_product_name",
      tenant_id: "storetwo",
      product_id: "1732504520547078146",
      suggested_name: "水杨酸沐浴露",
    })).toEqual({ productIds: ["1732504520547078146"], suggestedName: "水杨酸沐浴露" });
  });

  it("groups same-name listing ids into one confirmation button", () => {
    const card = buildProductApprovalCard([
      {
        productId: "1732412103449023263",
        sourceTitle: "Trimmer Purple",
        suggestedName: "电动比基尼修剪器",
        firstSeenDate: "2026-08-03",
        lastSeenDate: "2026-08-03",
      },
      {
        productId: "1732412121991648031",
        sourceTitle: "Trimmer Blue",
        suggestedName: "电动比基尼修剪器",
        firstSeenDate: "2026-08-03",
        lastSeenDate: "2026-08-03",
      },
    ], profile, "storeone-formal");
    const encoded = JSON.stringify(card);
    expect(encoded).toContain("1 个经营商品");
    expect(encoded).toContain("关联 2 个 TikTok 商品 ID");
    expect(encoded.match(/确认“电动比基尼修剪器”/g)).toHaveLength(1);
    expect(parseProductApprovalAction({
      tw_action: "confirm_product_name",
      tenant_id: "storeone-formal",
      product_ids: ["1732412103449023263", "1732412121991648031"],
      suggested_name: "电动比基尼修剪器",
    })).toEqual({
      productIds: ["1732412103449023263", "1732412121991648031"],
      suggestedName: "电动比基尼修剪器",
    });
  });
  it("offers decision-oriented shortcuts instead of table-name navigation", () => {
    const card = JSON.stringify(buildWorkbenchCard("root", "admin", profile));
    expect(card).toContain("近7天经营简报");
    expect(card).toContain("近7天销售额榜");
    expect(card).toContain("最新上线视频");
    expect(card).toContain("自动同步状态");
    expect(card).not.toContain('"content":"填表"');
    expect(card).not.toContain("我的权限");
    expect(card).not.toContain('"content":"清除上下文"');
    expect(card).toContain("每个人的对话上下文相互独立");
    expect(card).toContain("初始化/补齐数据");
    expect(card).not.toContain("初始化/补齐近7天");
  });

  it("asks for the initialization range instead of hard-coding seven days", () => {
    const card = JSON.stringify(buildWorkbenchCard("initialize", "admin", profile));
    expect(card).toContain("最近7天");
    expect(card).toContain("最近15天");
    expect(card).toContain("最近30天");
    expect(card).toContain("自定义天数");
    expect(resolveWorkbenchAction("initialize_store")).toMatchObject({ kind: "menu", nextStage: "initialize" });
    expect(resolveMenuText("3", "initialize")).toBe("initialize_30");
  });

  it("does not expose robot write or delete controls", () => {
    expect(JSON.stringify(buildWorkbenchCard("write", "admin", profile))).not.toContain("删除投产比商品");
    expect(JSON.stringify(buildWorkbenchCard("write", "admin", profile))).toContain("只读查询入口");
  });

  it("maps buttons only through an allowlisted action id", () => {
    expect(parseCardAction({ tw_action: "write_online_latest" })).toBe("write_online_latest");
    expect(parseCardAction({ tw_action: "arbitrary_command", command: "delete all" })).toBeNull();
  });

  it("supports numeric text alternatives per user menu stage", () => {
    expect(resolveMenuText("1", "root")).toBe("query_menu");
    expect(resolveMenuText("2", "root")).toBe("automation_status");
    expect(resolveMenuText("1", "write")).toBe("write_online_latest");
    expect(resolveWorkbenchAction("write_online_all").message).toContain("每日自动同步");
  });

  it("uses an isolated fixed query for the latest-online button", () => {
    const resolution = resolveWorkbenchAction("query_recent_online");
    expect(resolution.kind).toBe("command");
    expect(resolution.command).toContain("【红人上线表固定查询】");
    expect(resolution.command).not.toContain("投产比");
  });

  it("shows the same useful query shortcuts to every group role", () => {
    const card = JSON.stringify(buildWorkbenchCard("query", "viewer", profile));
    expect(card).toContain("近7天经营简报");
    expect(card).toContain("近7天销售额榜");
    expect(card).toContain("经营");
  });
});
