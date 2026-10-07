import { describe, expect, it } from "vitest";
import {
  buildQuotaTakeoverReports,
  validateQuotaTakeoverPayload,
} from "../src/bot/quota-takeover-report.js";

describe("quota takeover reports", () => {
  it("builds separate store/account daily cards with @all and keeps blank advertising totals pending", () => {
    const payload = validateQuotaTakeoverPayload(dailyPayload("2026-08-20"), ["storetwo-formal", "storeone-formal"]);
    const reports = buildQuotaTakeoverReports({
      tenantId: "storetwo-formal",
      storeName: "Storetwo",
      currencyCode: "USD",
      sendDate: payload.sendDate,
      tenant: payload.tenants["storetwo-formal"]!,
    });
    expect(reports.map((report) => `${report.scope}:${report.kind}`)).toEqual(["store:daily", "account:daily"]);
    expect(reports.every((report) => JSON.stringify(report.card).includes("<at id=all></at>"))).toBe(true);
    expect(reports[0].text).toContain("日报日期：8月20日");
    expect(reports[0].text).toContain("总广告花费：**待录入**");
    expect(reports[0].text).toContain("总广告出单量：**待录入**");
    expect(reports[1].text).toContain("真实数据日期：8月18日");
    expect(reports[1].text).toContain("广告花费：**待录入**");
    expect(reports[1].text).toContain("广告出单量：**待录入**");
  });

  it("requires both weekly reports on Sunday and orders store before account", () => {
    const raw = dailyPayload("2026-08-23");
    for (const tenant of Object.values(raw.tenants)) {
      tenant.periodic = [{
        kind: "weekly" as const,
        startDate: "2026-08-17",
        endDate: "2026-08-23",
        store: tenant.store,
        account: tenant.account,
      }];
    }
    const payload = validateQuotaTakeoverPayload(raw, ["storetwo-formal", "storeone-formal"]);
    const reports = buildQuotaTakeoverReports({
      tenantId: "storeone-formal",
      storeName: "STOREONE",
      currencyCode: "USD",
      sendDate: payload.sendDate,
      tenant: payload.tenants["storeone-formal"]!,
    });
    expect(reports.map((report) => `${report.scope}:${report.kind}`)).toEqual([
      "store:daily", "account:daily", "store:weekly", "account:weekly",
    ]);
  });

  it("rejects a Sunday payload that silently omits the weekly report", () => {
    expect(() => validateQuotaTakeoverPayload(
      dailyPayload("2026-08-23"),
      ["storetwo-formal", "storeone-formal"],
    )).toThrow("缺少周报");
  });
});

function dailyPayload(sendDate: string) {
  type Store = {
    sourceDate: string;
    orders: number;
    items: number;
    sales: number;
    cooperation: number;
    online: number;
    adSpend: number | null;
    adOrders: number | null;
    products: Array<{ name: string; orders: number; items: number; sales: number; cooperation: number; online: number }>;
  };
  type Account = { sourceDate: string; online: number; orders: number; sales: number; adSpend: number | null; adOrders: number | null };
  type Tenant = {
    store: Store;
    account: Account;
    periodic: Array<{
      kind: "weekly" | "monthly";
      startDate: string;
      endDate: string;
      store: Store;
      account: Account;
    }>;
  };
  const tenant = (name: string): Tenant => ({
    store: {
      sourceDate: sendDate,
      orders: 0,
      items: 0,
      sales: 0,
      cooperation: name === "STOREONE" ? 1 : 0,
      online: 0,
      adSpend: null,
      adOrders: null,
      products: [{ name: `${name}商品`, orders: 0, items: 0, sales: 0, cooperation: 0, online: 0 }],
    },
    account: { sourceDate: "2026-08-18", online: 2, orders: 0, sales: 0, adSpend: null, adOrders: null },
    periodic: [],
  });
  return {
    schemaVersion: 1 as const,
    sendDate,
    generatedAt: "2026-08-20T08:30:00.000Z",
    tenants: {
      "storetwo-formal": tenant("Storetwo"),
      "storeone-formal": tenant("STOREONE"),
    },
  };
}
