import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireCanonicalProductName } from "../business/product-naming.js";
import { includedProductNameSet } from "../business/product-scope.js";
import type { BusinessProfile } from "../config/business-profile.js";
import { shiftIsoDate } from "../realtime/business-time.js";
import {
  fetchTikTokPaidOrderSnapshot,
  tikTokRuntimeFromProfile,
  type TikTokPaidOrderSnapshotContract,
} from "../realtime/tiktok-cli.js";

export interface ProductSpikeProductSnapshot {
  name: string;
  productIds: string[];
  orderKeys: string[];
  paidAtByOrderKey: Record<string, number>;
  orders: number;
  items: number;
  sales: number | null;
  salesCurrency: string | null;
}

export interface ProductSpikeVideoSnapshot {
  videoId: string;
  productName: string;
  productIds: string[];
  orderKeys: string[];
  paidAtByOrderKey: Record<string, number>;
  orders: number;
  items: number;
}

export interface ProductSpikeSnapshot {
  businessDate: string;
  fetchedAt: string;
  products: ProductSpikeProductSnapshot[];
  unmappedOrderKeys: string[];
  unmappedPaidAtByOrderKey: Record<string, number>;
  videoAttributionAvailable: boolean;
  videoAttributionErrors: string[];
  videos: ProductSpikeVideoSnapshot[];
  sourcePath: string | null;
}

interface ProductMap {
  shop: string;
  products: Record<string, string>;
}

export async function loadProductSpikeSnapshot(
  profile: BusinessProfile,
  businessDate: string,
): Promise<ProductSpikeSnapshot> {
  const contract = await fetchTikTokPaidOrderSnapshot(
    shiftIsoDate(businessDate, -1),
    shiftIsoDate(businessDate, 1),
    profile.businessTimeZone,
    120_000,
    tikTokRuntimeFromProfile(profile),
  );
  const productMap = await loadProductMap(profile);
  return buildProductSpikeSnapshot(contract, profile, productMap, businessDate);
}

export function buildProductSpikeSnapshot(
  contract: TikTokPaidOrderSnapshotContract,
  profile: BusinessProfile,
  productMap: ProductMap,
  businessDate: string,
): ProductSpikeSnapshot {
  if (contract.business_time_zone !== profile.businessTimeZone) {
    throw new Error(
      `付款快照时区${contract.business_time_zone}与店铺业务时区${profile.businessTimeZone}不一致`,
    );
  }
  if (!contract.paid_snapshot_dates.includes(businessDate)) {
    throw new Error(`付款快照没有覆盖${businessDate}`);
  }
  const actualShop = String(contract.shop?.name ?? "").trim().toLocaleLowerCase("en-US");
  if (!actualShop || actualShop !== productMap.shop.toLocaleLowerCase("en-US")) {
    throw new Error(`付款快照店铺不是${productMap.shop}：${contract.shop?.name ?? "空"}`);
  }
  const grouped = groupProductIds(productMap.products, includedProductNameSet(profile));
  const monitorRows = contract.paid_snapshot_rows.filter((row) => (
    String(row.date ?? "") === businessDate
    || String(row.date ?? "") === shiftIsoDate(businessDate, -1)
  ));
  const rows = monitorRows.filter((row) => String(row.date ?? "") === businessDate);
  const mappedProductIds = new Set([...grouped.values()].flat());
  const unmappedRows = monitorRows.filter((row) => (
    !mappedProductIds.has(String(row.product_id ?? ""))
  ));
  const unmappedEvidence = orderEvidence(unmappedRows);
  const scopedEvidence = orderEvidence(monitorRows.filter((row) => (
    mappedProductIds.has(String(row.product_id ?? ""))
  )));
  const storeEvidence = orderEvidence(contract.paid_snapshot_store_rows.filter((row) => (
    String(row.date ?? "") === businessDate
    || String(row.date ?? "") === shiftIsoDate(businessDate, -1)
  )));
  const residualStoreKeys = storeEvidence.orderKeys.filter((key) => (
    !scopedEvidence.orderKeys.includes(key) && !unmappedEvidence.orderKeys.includes(key)
  ));
  if (residualStoreKeys.length > 0) {
    for (const key of residualStoreKeys) {
      unmappedEvidence.orderKeys.push(key);
      unmappedEvidence.paidAtByOrderKey[key] = storeEvidence.paidAtByOrderKey[key];
    }
    unmappedEvidence.orderKeys.sort();
  }
  const products = [...grouped.entries()].map(([name, productIds]) => {
    const matches = rows.filter((row) => productIds.includes(String(row.product_id ?? "")));
    const currentEvidence = orderEvidence(matches);
    const evidence = orderEvidence(monitorRows.filter((row) => (
      productIds.includes(String(row.product_id ?? ""))
    )));
    const salesReady = matches.every((row) => (
      row.sales_ready === true
      && String(row.sales_currency ?? "") === String(profile.tiktok.currencyCode ?? "")
    ));
    return {
      name,
      productIds,
      orderKeys: evidence.orderKeys,
      paidAtByOrderKey: evidence.paidAtByOrderKey,
      orders: currentEvidence.orderKeys.length,
      items: matches.reduce(
        (sum, row) => sum + nonnegativeInteger(row.total_items, `${name}.total_items`),
        0,
      ),
      sales: salesReady
        ? roundCurrency(matches.reduce(
            (sum, row) => sum + nonnegativeNumber(row.sales_amount, `${name}.sales_amount`),
            0,
          ))
        : null,
      salesCurrency: salesReady ? profile.tiktok.currencyCode ?? null : null,
    };
  });

  const videos: ProductSpikeVideoSnapshot[] = [];
  if (contract.video_attribution_ready) {
    for (const [name, productIds] of grouped.entries()) {
      const matches = contract.video_order_rows.filter((row) => (
        (String(row.date ?? "") === businessDate
          || String(row.date ?? "") === shiftIsoDate(businessDate, -1))
        && productIds.includes(String(row.product_id ?? ""))
      ));
      const videoIds = [...new Set(matches.map((row) => String(row.video_id ?? "").trim()))];
      for (const videoId of videoIds) {
        if (!/^\d{10,}$/.test(videoId)) throw new Error(`视频归因返回无效video_id：${videoId || "空"}`);
        const videoRows = matches.filter((row) => String(row.video_id ?? "").trim() === videoId);
        const evidence = orderEvidence(videoRows);
        videos.push({
          videoId,
          productName: name,
          productIds,
          orderKeys: evidence.orderKeys,
          paidAtByOrderKey: evidence.paidAtByOrderKey,
          orders: evidence.orderKeys.length,
          items: videoRows.reduce(
            (sum, row) => sum + nonnegativeInteger(row.total_items, `${videoId}.total_items`),
            0,
          ),
        });
      }
    }
  }
  return {
    businessDate,
    fetchedAt: contract.fetched_at,
    products,
    unmappedOrderKeys: unmappedEvidence.orderKeys,
    unmappedPaidAtByOrderKey: unmappedEvidence.paidAtByOrderKey,
    videoAttributionAvailable: contract.video_attribution_ready,
    videoAttributionErrors: [...contract.video_attribution_errors],
    videos: videos.sort((left, right) => left.videoId.localeCompare(right.videoId)),
    sourcePath: contract.normalized_source_path,
  };
}

async function loadProductMap(profile: BusinessProfile): Promise<ProductMap> {
  const configured = path.resolve(profile.tiktok.productMapFile);
  const parsed = JSON.parse(await readFile(configured, "utf8")) as {
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
  if (!shop || Object.keys(products).length === 0) throw new Error("爆量监测商品映射缺少店铺或商品");
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
  if (groups.size === 0) throw new Error("爆量监测没有已纳入经营范围的商品");
  return groups;
}

function orderEvidence(rows: ReadonlyArray<Record<string, unknown>>): {
  orderKeys: string[];
  paidAtByOrderKey: Record<string, number>;
} {
  const keys = rows.flatMap((row) => (
    Array.isArray(row.total_order_keys) ? row.total_order_keys.map(String) : []
  ));
  const paidAtByOrderKey: Record<string, number> = {};
  if (keys.length === 0) return { orderKeys: [], paidAtByOrderKey };
  for (const key of keys) {
    if (!/^[a-f0-9]{20}$/.test(key)) {
      throw new Error("付款快照包含非脱敏订单键，已拒绝载入");
    }
  }
  for (const row of rows) {
    const raw = row.total_order_paid_at;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("付款快照缺少脱敏订单键对应的paid_time，无法严谨计算30分钟窗口");
    }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!/^[a-f0-9]{20}$/.test(key)) throw new Error("付款时间映射包含非脱敏订单键");
      const seconds = Number(value);
      if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("付款时间不是有效Unix秒时间戳");
      const milliseconds = seconds * 1000;
      const existing = paidAtByOrderKey[key];
      if (existing !== undefined && existing !== milliseconds) {
        throw new Error("同一脱敏订单键出现冲突付款时间");
      }
      paidAtByOrderKey[key] = milliseconds;
    }
  }
  const orderKeys = [...new Set(keys)].sort();
  if (orderKeys.some((key) => paidAtByOrderKey[key] === undefined)) {
    throw new Error("部分脱敏订单键缺少paid_time，无法严谨计算30分钟窗口");
  }
  return { orderKeys, paidAtByOrderKey };
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
