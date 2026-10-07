import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireCanonicalProductName } from "../business/product-naming.js";
import { includedProductNameSet } from "../business/product-scope.js";
import type { BusinessProfile } from "../config/business-profile.js";
import { shiftIsoDate } from "../realtime/business-time.js";
import {
  fetchTikTokPaidOrderReportSnapshot,
  tikTokRuntimeFromProfile,
  type TikTokPaidOrderSnapshotContract,
} from "../realtime/tiktok-cli.js";
import type { DailyReportPaidProductSnapshot } from "./daily-group-report.js";

export interface PeriodicReportProductMap {
  shop: string;
  products: Record<string, string>;
}

/**
 * One read-only Order API snapshot for the complete report period. It fills
 * missing report values only; the periodic report keeps every valid Base value
 * and never writes this snapshot back to Feishu.
 */
export async function loadPeriodicReportPaidSnapshot(
  profile: BusinessProfile,
  startDate: string,
  endDateInclusive: string,
): Promise<DailyReportPaidProductSnapshot[]> {
  const productMap = await loadProductMap(profile);
  const results: DailyReportPaidProductSnapshot[] = [];
  // The Order API lookup intentionally searches seven days before each paid
  // window because an order can be created before it is paid. Keep every API
  // request at 24 paid days or fewer so that paid window + lookup buffer stays
  // within the existing 31-day safety limit. A calendar month therefore uses
  // only two sequential reads, with non-overlapping paid dates.
  for (const chunk of periodicSnapshotChunks(startDate, endDateInclusive)) {
    const contract = await fetchTikTokPaidOrderReportSnapshot(
      chunk.startDate,
      shiftIsoDate(chunk.endDateInclusive, 1),
      profile.businessTimeZone,
      180_000,
      tikTokRuntimeFromProfile(profile),
    );
    results.push(...buildPeriodicReportPaidSnapshot(
      contract,
      profile,
      productMap,
      chunk.startDate,
      chunk.endDateInclusive,
    ));
  }
  return results;
}

export function periodicSnapshotChunks(
  startDate: string,
  endDateInclusive: string,
  maxPaidDaysPerRequest = 24,
): Array<{ startDate: string; endDateInclusive: string }> {
  if (!Number.isSafeInteger(maxPaidDaysPerRequest) || maxPaidDaysPerRequest < 1 || maxPaidDaysPerRequest > 24) {
    throw new Error("周期付款快照分段天数必须在1至24之间");
  }
  const dates = isoDateRange(startDate, endDateInclusive);
  const chunks: Array<{ startDate: string; endDateInclusive: string }> = [];
  for (let offset = 0; offset < dates.length; offset += maxPaidDaysPerRequest) {
    const slice = dates.slice(offset, offset + maxPaidDaysPerRequest);
    chunks.push({ startDate: slice[0], endDateInclusive: slice.at(-1)! });
  }
  return chunks;
}

export function buildPeriodicReportPaidSnapshot(
  contract: TikTokPaidOrderSnapshotContract,
  profile: BusinessProfile,
  productMap: PeriodicReportProductMap,
  startDate: string,
  endDateInclusive: string,
): DailyReportPaidProductSnapshot[] {
  if (contract.business_time_zone !== profile.businessTimeZone) {
    throw new Error(
      `周期付款快照时区${contract.business_time_zone}与经营时区${profile.businessTimeZone}不一致`,
    );
  }
  const requestedDates = isoDateRange(startDate, endDateInclusive);
  if (requestedDates.some((date) => !contract.paid_snapshot_dates.includes(date))) {
    throw new Error("周期付款快照日期覆盖不完整");
  }
  const actualShop = String(contract.shop?.name ?? "").trim().toLocaleLowerCase("en-US");
  if (!actualShop || actualShop !== productMap.shop.toLocaleLowerCase("en-US")) {
    throw new Error(`周期付款快照店铺不是${productMap.shop}：${contract.shop?.name ?? "空"}`);
  }
  const groups = groupProductIds(productMap.products, includedProductNameSet(profile));
  const rows = contract.paid_snapshot_rows;
  return requestedDates.flatMap((date) => [...groups.entries()].map(([name, productIds]) => {
    const matches = rows.filter((row) => (
      String(row.date ?? "") === date
      && productIds.includes(String(row.product_id ?? ""))
    ));
    const orderKeys = matches.flatMap((row) => (
      Array.isArray(row.total_order_keys) ? row.total_order_keys.map(String) : []
    ));
    if (orderKeys.some((key) => !/^[a-f0-9]{20}$/.test(key))) {
      throw new Error("周期付款快照包含非脱敏订单键，已拒绝使用");
    }
    const uniqueOrderKeys = [...new Set(orderKeys)];
    const declaredOrders = matches.reduce(
      (sum, row) => sum + nonnegativeInteger(row.total_orders, `${date}/${name}.total_orders`),
      0,
    );
    if (declaredOrders !== uniqueOrderKeys.length) {
      throw new Error(`${date}/${name}付款订单去重数与接口汇总不一致`);
    }
    const salesReady = matches.every((row) => (
      row.sales_ready === true
      && String(row.sales_currency ?? "") === String(profile.tiktok.currencyCode ?? "")
    ));
    return {
      date,
      name,
      orders: uniqueOrderKeys.length,
      items: matches.reduce(
        (sum, row) => sum + nonnegativeInteger(row.total_items, `${date}/${name}.total_items`),
        0,
      ),
      sales: salesReady
        ? roundCurrency(matches.reduce(
            (sum, row) => sum + nonnegativeNumber(row.sales_amount, `${date}/${name}.sales_amount`),
            0,
          ))
        : null,
    };
  }));
}

async function loadProductMap(profile: BusinessProfile): Promise<PeriodicReportProductMap> {
  const parsed = JSON.parse(await readFile(path.resolve(profile.tiktok.productMapFile), "utf8")) as {
    shop?: unknown;
    products?: unknown;
  };
  const shop = String(parsed.shop ?? "").trim();
  const rawProducts = parsed.products && typeof parsed.products === "object" && !Array.isArray(parsed.products)
    ? parsed.products as Record<string, unknown>
    : {};
  const products = Object.fromEntries(Object.entries(rawProducts).map(([id, name]) => [
    String(id).trim(),
    requireCanonicalProductName(String(name)),
  ]).filter(([id, name]) => Boolean(id && name)));
  if (!shop || Object.keys(products).length === 0) throw new Error("周期报告商品映射缺少店铺或商品");
  return { shop, products };
}

function groupProductIds(
  products: Record<string, string>,
  included: ReadonlySet<string> | null,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [rawId, rawName] of Object.entries(products)) {
    const id = String(rawId).trim();
    const name = requireCanonicalProductName(String(rawName));
    if (!id || (included && !included.has(name))) continue;
    const ids = groups.get(name) ?? [];
    if (!ids.includes(id)) ids.push(id);
    groups.set(name, ids);
  }
  if (groups.size === 0) throw new Error("周期报告没有已纳入经营范围的商品");
  return groups;
}

function isoDateRange(startDate: string, endDate: string): string[] {
  if (startDate > endDate) throw new Error(`周期付款快照日期倒置：${startDate} > ${endDate}`);
  const values: string[] = [];
  for (let cursor = startDate; cursor <= endDate; cursor = shiftIsoDate(cursor, 1)) values.push(cursor);
  if (values.length > 31) throw new Error("周期付款快照最多读取31天");
  return values;
}

function nonnegativeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label}不是非负整数`);
  return parsed;
}

function nonnegativeNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label}不是非负数`);
  return parsed;
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
