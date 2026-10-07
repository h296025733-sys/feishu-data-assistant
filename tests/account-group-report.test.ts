import { describe, expect, it } from "vitest";
import { buildAccountGroupReports } from "../src/bot/account-group-report.js";
import { periodForKind } from "../src/bot/periodic-group-report.js";
import type { BusinessProfile } from "../src/config/business-profile.js";
import type { DataSource, TableData } from "../src/types/index.js";

describe("account-side group reports", () => {
  it("uses the latest complete account-side data date instead of pretending it is real-time", async () => {
    const reports = await buildAccountGroupReports({
      tenantId: "storeone-formal",
      profile,
      dataSource: accountSource(),
      sendDate: "2026-08-17",
      periodicPeriods: [],
    });

    expect(reports).toHaveLength(1);
    expect(reports[0].kind).toBe("daily");
    expect(reports[0].latestAvailableDate).toBe("2026-08-15");
    expect(reports[0].text).toContain("账号端日报｜8月15日");
    expect(reports[0].text).toContain("真实数据日期：8月15日");
    expect(reports[0].text).toContain("上线量：**2**");
    expect(reports[0].text).toContain("单量：**3**");
    expect(reports[0].text).toContain("销售额：**$29.90**");
    expect(reports[0].text).toContain("广告花费：**$4.50**");
    expect(reports[0].text).toContain("广告出单量：**2**");
    expect(JSON.stringify(reports[0].card)).toContain("<at id=all></at>");
  });

  it("builds the Sunday weekly account report only through the latest complete data day", async () => {
    const reports = await buildAccountGroupReports({
      tenantId: "storeone-formal",
      profile,
      dataSource: accountSource(),
      sendDate: "2026-08-16",
      periodicPeriods: [periodForKind("weekly", "2026-08-16")],
    });
    const weekly = reports.find((report) => report.kind === "weekly")!;
    expect(weekly.startDate).toBe("2026-08-10");
    expect(weekly.endDate).toBe("2026-08-15");
    expect(weekly.text).toContain("账号端周报｜8月10日–8月15日");
    expect(weekly.text).toContain("真实数据周期：8月10日–8月15日");
    expect(weekly.text).toContain("上线量：**7**");
    expect(weekly.text).toContain("单量：**8**");
    expect(weekly.text).toContain("销售额：**$79.70**");
    expect(weekly.text).toContain("广告花费：**$10.75**");
    expect(weekly.text).toContain("广告出单量：**7**");
  });

  it("sums the same actual-date window for the monthly account advertising spend", async () => {
    const reports = await buildAccountGroupReports({
      tenantId: "storeone-formal",
      profile,
      dataSource: accountSource(),
      sendDate: "2026-09-01",
      periodicPeriods: [periodForKind("monthly", "2026-09-01")],
    });
    const monthly = reports.find((report) => report.kind === "monthly")!;
    expect(monthly.startDate).toBe("2026-08-09");
    expect(monthly.endDate).toBe("2026-08-15");
    expect(monthly.text).toContain("广告花费：**$12.00**");
    expect(monthly.text).toContain("广告出单量：**8**");
  });

  it("keeps explicit zero advertising metrics valid and renders blanks as pending", async () => {
    const table = await accountSource().getTable("账号投产比");
    const zero: DataSource = {
      getTable: async () => ({
        ...table,
        rows: table.rows.map((row) => row.日期 === "2026-08-15" ? { ...row, 广告花费: 0, 广告出单量: 0 } : row),
      }),
    };
    const reports = await buildAccountGroupReports({
      tenantId: "storeone-formal",
      profile,
      dataSource: zero,
      sendDate: "2026-08-17",
    });
    expect(reports[0].text).toContain("广告花费：**$0.00**");
    expect(reports[0].text).toContain("广告出单量：**0**");

    const blank: DataSource = {
      getTable: async () => ({
        ...table,
        rows: table.rows.map((row) => {
          if (row.日期 !== "2026-08-15") return row;
          const { 广告花费: _removedSpend, 广告出单量: _removedOrders, ...withoutAdvertising } = row;
          return withoutAdvertising;
        }),
      }),
    };
    const blankReports = await buildAccountGroupReports({
      tenantId: "storeone-formal",
      profile,
      dataSource: blank,
      sendDate: "2026-08-17",
    });
    expect(blankReports[0].text).toContain("广告花费：**待录入**");
    expect(blankReports[0].text).toContain("广告出单量：**待录入**");
    expect(blankReports[0].dataComplete).toBe(true);
  });

  it("does not emit partial weekly advertising sums when one day is blank", async () => {
    const table = await accountSource().getTable("账号投产比");
    const partlyBlank: DataSource = {
      getTable: async () => ({
        ...table,
        rows: table.rows.map((row) => row.日期 === "2026-08-13" ? { ...row, 广告花费: null, 广告出单量: null } : row),
      }),
    };
    const reports = await buildAccountGroupReports({
      tenantId: "storeone-formal",
      profile,
      dataSource: partlyBlank,
      sendDate: "2026-08-16",
      periodicPeriods: [periodForKind("weekly", "2026-08-16")],
    });
    expect(reports.find((report) => report.kind === "weekly")?.text)
      .toContain("广告花费：**待录入**");
    expect(reports.find((report) => report.kind === "weekly")?.text)
      .toContain("广告出单量：**待录入**");
  });

  it("fails closed on a missing store summary date instead of emitting a dash", async () => {
    const table = await accountSource().getTable("账号投产比");
    const broken: DataSource = {
      getTable: async () => ({
        ...table,
        rows: table.rows.filter((row) => row.日期 !== "2026-08-13"),
      }),
    };
    await expect(buildAccountGroupReports({
      tenantId: "storeone-formal",
      profile,
      dataSource: broken,
      sendDate: "2026-08-16",
      periodicPeriods: [periodForKind("weekly", "2026-08-16")],
    })).rejects.toThrow("2026-08-13");
  });
});

const profile: BusinessProfile = {
  schemaVersion: 1,
  templateMode: false,
  businessDisplayName: "STOREONE",
  businessTimeZone: "Asia/Shanghai",
  storeAggregateLabel: "店铺汇总",
  tables: { development: "红人开发表", cooperation: "红人合作表", online: "红人上线表", roi: "投产比" },
  tiktok: {
    shopAlias: "STOREONE",
    shopId: "7494514159832827679",
    credentialProfile: "storeone-formal-store",
    shopTimeZone: "America/Los_Angeles",
    currencyCode: "USD",
    productMapFile: "config/tenants/storeone-formal.products.json",
    includedCanonicalProducts: ["户外蓝牙音箱", "便携蓝牙音箱"],
    roiDateBasis: "shop_registered",
  },
  dailyAutomation: {
    enabled: true,
    localTime: "17:35",
    reportLocalTime: "17:55",
    catchUpLocalTime: "20:00",
    integrationStartDate: "2026-08-06",
    reconciliationDays: 1,
    probeDays: 14,
    runOnStartup: false,
  },
};

function accountSource(): DataSource {
  const rows: Record<string, unknown>[] = [];
  for (let date = "2026-08-09", index = 0; date <= "2026-08-15"; index += 1) {
    rows.push({
      检查: `STOREONE|STOREONE|${date}`,
      店铺: "STOREONE",
      账号: "STOREONE",
      账号UID: "",
      日期: date,
      上线量: index === 6 ? 2 : 1,
      单量: index === 6 ? 3 : 1,
      销售额: index === 6 ? 29.9 : 9.96,
      广告花费: index === 6 ? 4.5 : 1.25,
      广告出单量: index === 6 ? 2 : 1,
      数据状态: "完整",
    });
    if (date === "2026-08-15") break;
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + 1);
    date = value.toISOString().slice(0, 10);
  }
  const table: TableData = {
    sourceName: "飞书多维表格",
    sheetName: "账号投产比",
    headers: ["检查", "店铺", "账号", "账号UID", "日期", "上线量", "单量", "销售额", "广告花费", "广告出单量", "数据状态"],
    updatedAt: new Date("2026-08-17T01:00:00Z"),
    rows,
  };
  return { getTable: async () => table };
}
