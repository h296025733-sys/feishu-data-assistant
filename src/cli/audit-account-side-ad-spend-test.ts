import path from "node:path";
import { buildAccountGroupReports } from "../bot/account-group-report.js";
import { loadBusinessProfileFile } from "../config/business-profile.js";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import {
  assertTestEnterpriseEnv,
  listRecords,
  listTables,
} from "../feishu/account-side-test.js";
import { createFeishuClient } from "../feishu/client.js";
import type { DataSource, TableData } from "../types/index.js";

const PROJECT_ROOT = process.cwd();
const profile = loadBusinessProfileFile(path.join(PROJECT_ROOT, "config", "tenants", "storeone-formal.profile.json"));
const env = requireFeishuEnv(getEnv());
assertTestEnterpriseEnv(env);
const client = createFeishuClient(env);
const tables = await listTables(client, env.FEISHU_BITABLE_APP_TOKEN);
const one = (name: string) => {
  const matches = tables.filter((table) => table.name === name);
  if (matches.length !== 1) throw new Error(`测试Base无法唯一定位“${name}”`);
  return matches[0]!;
};

const productRows = await listRecords(
  client,
  env.FEISHU_BITABLE_APP_TOKEN,
  one("产品投产比").tableId,
  ["检查", "店铺", "商品", "TikTok商品ID", "日期", "上线量", "单量", "销售额", "广告花费", "广告出单量", "数据状态"],
);
const accountRows = await listRecords(
  client,
  env.FEISHU_BITABLE_APP_TOKEN,
  one("账号投产比").tableId,
  ["检查", "店铺", "账号", "账号UID", "日期", "上线量", "单量", "销售额", "广告花费", "广告出单量", "数据状态"],
);

const productStoreRows = productRows.filter((row) => (
  cellText(row.fields.商品) === profile.businessDisplayName && !cellText(row.fields.TikTok商品ID)
));
const accountStoreRows = accountRows.filter((row) => (
  cellText(row.fields.账号) === profile.businessDisplayName && !cellText(row.fields.账号UID)
));
const productStoreDates = new Set(productStoreRows.map((row) => dateKey(row.fields.日期, profile.businessTimeZone)));
const accountStoreDates = new Set(accountStoreRows.map((row) => dateKey(row.fields.日期, profile.businessTimeZone)));
const requestedDate = process.env.ACCOUNT_AD_AUDIT_DATE?.trim();
const auditDate = requestedDate || [...productStoreDates].filter((date) => accountStoreDates.has(date)).sort().at(-1);
if (!auditDate) throw new Error("测试Base没有可用于账号端两张投产比在线核对的共同店铺总览日");
const productStore = exactlyOne(productStoreRows.filter((row) => (
  cellText(row.fields.商品) === profile.businessDisplayName
  && !cellText(row.fields.TikTok商品ID)
  && dateKey(row.fields.日期, profile.businessTimeZone) === auditDate
)), `产品投产比 ${auditDate} 店铺总览`);
const accountStore = exactlyOne(accountStoreRows.filter((row) => (
  cellText(row.fields.账号) === profile.businessDisplayName
  && !cellText(row.fields.账号UID)
  && dateKey(row.fields.日期, profile.businessTimeZone) === auditDate
)), `账号投产比 ${auditDate} 店铺总览`);
const productSpend = numberValue(productStore.fields.广告花费);
const accountSpend = numberValue(accountStore.fields.广告花费);
const productOrders = numberValue(productStore.fields.广告出单量);
const accountOrders = numberValue(accountStore.fields.广告出单量);
const productDetailWithSpend = productRows.filter((row) => (
  cellText(row.fields.TikTok商品ID)
  && numberValue(row.fields.广告花费) !== null
));
const accountDetailWithSpend = accountRows.filter((row) => (
  cellText(row.fields.账号UID)
  && numberValue(row.fields.广告花费) !== null
));
const productDetailWithOrders = productRows.filter((row) => (
  cellText(row.fields.TikTok商品ID)
  && numberValue(row.fields.广告出单量) !== null
));
const accountDetailWithOrders = accountRows.filter((row) => (
  cellText(row.fields.账号UID)
  && numberValue(row.fields.广告出单量) !== null
));
if (productDetailWithSpend.length || accountDetailWithSpend.length || productDetailWithOrders.length || accountDetailWithOrders.length) {
  throw new Error(
    `账号端明细行不应写广告总计：花费(产品${productDetailWithSpend.length}、账号${accountDetailWithSpend.length})，`
    + `出单量(产品${productDetailWithOrders.length}、账号${accountDetailWithOrders.length})`,
  );
}

const accountTable: TableData = {
  sourceName: "飞书测试企业真实Base",
  sheetName: "账号投产比",
  headers: ["检查", "店铺", "账号", "账号UID", "日期", "上线量", "单量", "销售额", "广告花费", "广告出单量", "数据状态"],
  updatedAt: new Date(),
  rows: accountRows.map((row) => row.fields),
};
const dataSource: DataSource = { getTable: async () => accountTable };
const reports = await buildAccountGroupReports({
  tenantId: "storeone-test",
  profile,
  dataSource,
  sendDate: auditDate,
  periodicPeriods: [
    { kind: "weekly", startDate: auditDate, endDate: auditDate, previousStartDate: auditDate, previousEndDate: auditDate },
    { kind: "monthly", startDate: auditDate, endDate: auditDate, previousStartDate: auditDate, previousEndDate: auditDate },
  ],
});
if (reports.length !== 3 || reports.some((report) => (
  !report.text.includes("广告花费") || !report.text.includes("广告出单量")
))) {
  throw new Error("测试企业真实账号行未能生成含两项广告数据的日/周/月三类报告内容");
}

console.log(JSON.stringify({
  evidence: "real-feishu-test-enterprise-readback-plus-local-report-render-no-message-sent",
  checkedAt: new Date().toISOString(),
  auditDate,
  contract: {
    ownership: "账号端两张投产比店铺总览分别人工填写",
    automaticOverwrite: false,
    storeSideAdvertisingIsIndependent: true,
  },
  targets: {
    productRoiStoreOverview: { 广告花费: productSpend, 广告出单量: productOrders },
    accountRoiStoreOverview: { 广告花费: accountSpend, 广告出单量: accountOrders },
    productDetailRowsWithSpend: productDetailWithSpend.length,
    accountDetailRowsWithSpend: accountDetailWithSpend.length,
    productDetailRowsWithOrders: productDetailWithOrders.length,
    accountDetailRowsWithOrders: accountDetailWithOrders.length,
  },
  reports: reports.map((report) => ({ kind: report.kind, startDate: report.startDate, endDate: report.endDate, text: report.text })),
  limitation: "这里只读回查账号端人工值并渲染报告；周报/月报使用同一真实在线日做单日核对，多日周期累计另由本地单元测试覆盖。未发送任何飞书消息。",
}, null, 2));

function exactlyOne<T>(values: T[], label: string): T {
  if (values.length !== 1) throw new Error(`${label}记录数=${values.length}`);
  return values[0]!;
}

function cellText(value: unknown): string {
  if (Array.isArray(value)) return value.map(cellText).join("").trim();
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return cellText(object.text ?? object.name ?? object.value ?? object.content ?? "");
  }
  return String(value ?? "").trim();
}

function numberValue(value: unknown): number | null {
  const text = cellText(value).replace(/[$,\s]/g, "");
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : null;
}

function dateKey(value: unknown, timeZone: string): string {
  const numeric = typeof value === "number" ? value : Number(cellText(value));
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(numeric));
  }
  return cellText(value).match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}
