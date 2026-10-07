import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadBusinessProfile, type BusinessProfile } from "../config/business-profile.js";
import type {
  StorefourDemoGateway,
  DailySource,
  DailyOrderAttributionSource,
  DailyPaidOrderSnapshotSource,
} from "../feishu/storefour-demo-gateway.js";
import { requireCanonicalProductName } from "../business/product-naming.js";
import { includedProductNameSet } from "../business/product-scope.js";
import { enumerateDates, nextDate } from "./intent.js";
import {
  fetchTikTokAnalytics,
  fetchTikTokOrderAttribution,
  fetchTikTokVideoDay,
  tikTokRuntimeFromProfile,
  type TikTokRuntimeContext,
} from "./tiktok-cli.js";
import type { RealtimeResultSummary, TikTokMachineContract } from "./types.js";

function manualItems(_profile: BusinessProfile): string[] {
  return ["各广告账户的广告花费与广告出单量", "退货量"];
}

export interface RoiUpdatePlan {
  version: 1;
  jobId: string;
  generatedAt: string;
  sourceShop: string;
  product: { id: string; name: string; ids?: string[] };
  startDate: string;
  endDateInclusive: string;
  endDateExclusive: string;
  sources: DailySource[];
  sourceFiles: string[];
  requestIds: string[];
  missingItems: string[];
}

export interface RoiBulkUpdatePlan {
  version: 1;
  mode: "bulk";
  jobId: string;
  generatedAt: string;
  sourceShop: string;
  startDate: string;
  endDateInclusive: string;
  endDateExclusive: string;
  rowFilter: "all" | "orders_positive";
  scannedMappedProducts: number;
  skippedRows: number;
  skipSummary: {
    zeroOrders: number;
    productMissing: number;
    dateUnavailable: number;
  };
  skippedDetails: Array<{
    date: string;
    product: { id: string; name: string };
    reason: "zero_orders" | "product_missing" | "date_unavailable";
    latestAvailableDate: string | null;
  }>;
  unmappedPositiveProducts: Array<{ id: string; name: string }>;
  entries: Array<{
    product: { id: string; name: string };
    sources: DailySource[];
  }>;
  sourceFiles: string[];
  requestIds: string[];
  missingItems: string[];
}

export interface CanonicalProductGroup {
  product: { id: string; name: string };
  productIds: string[];
  sources: DailySource[];
}

export interface OrderAttributionUpdatePlan {
  version: 1;
  mode: "order_attribution";
  startDate: string;
  endDateInclusive: string;
  entries: Array<{
    product: { id: string; name: string };
    sources: DailyOrderAttributionSource[];
  }>;
  paidSnapshotEntries: Array<{
    product: { id: string; name: string };
    sources: DailyPaidOrderSnapshotSource[];
  }>;
  sourceFiles: string[];
  requestIds: string[];
  unmappedPositiveProductIds: string[];
  pendingDates: string[];
  missingItems: string[];
}

/** One workbench product can intentionally represent several TikTok listing IDs. */
export function groupMappedProductsByCanonicalName(
  products: ReadonlyArray<{ id: string; name: string }>,
): Map<string, CanonicalProductGroup> {
  const groups = new Map<string, CanonicalProductGroup>();
  for (const product of products) {
    const current = groups.get(product.name);
    if (current) {
      if (!current.productIds.includes(product.id)) current.productIds.push(product.id);
      continue;
    }
    groups.set(product.name, {
      product: { id: product.id, name: product.name },
      productIds: [product.id],
      sources: [],
    });
  }
  return groups;
}

export class RoiInputRequiredError extends Error {
  public constructor(
    message: string,
    public readonly missingItems: string[],
  ) {
    super(message);
  }
}

export async function prepareRoiUpdatePlan(input: {
  jobId: string;
  startDate: string;
  endDateInclusive: string;
  productName?: string;
  profile?: BusinessProfile;
}): Promise<RoiUpdatePlan> {
  const profile = input.profile ?? loadBusinessProfile();
  if (profile.tiktok.roiDateBasis === "business") {
    throw new Error("该店投产比按北京时间归日，禁止把TikTok店铺日Analytics写进同名北京时间日期行");
  }
  const runtime = tikTokRuntimeFromProfile(profile);
  const dates = enumerateDates(input.startDate, input.endDateInclusive);
  if (dates.length > 31) throw new Error("投产比单次预览最多31天，请按自然月分批");
  const productMap = await loadProductMap(profile);
  const product = resolveProduct(productMap.products, input.productName);
  const sources: DailySource[] = [];

  for (const date of dates) {
    const endDateExclusive = nextDate(date);
    const [productContract, shopContract, orderingVideos] = await Promise.all([
      fetchTikTokAnalytics("shop_product_performance", date, endDateExclusive, "", 180_000, runtime),
      fetchTikTokAnalytics("shop_performance_hourly", date, endDateExclusive, "", 180_000, runtime),
      fetchOrderingVideoCounts(date, endDateExclusive, runtime),
    ]);
    assertSourceShop(productContract.shop?.name, productMap.shop);
    assertSourceShop(shopContract.shop?.name, productMap.shop);
    logOrderingVideoDiagnostics(orderingVideos.warnings);
    const rows = product.ids
      .map((id) => ({ id, row: productContract.rows.find((item) => String(item.id ?? "") === id) }))
      .filter((item): item is { id: string; row: Record<string, any> } => Boolean(item.row));
    if (rows.length === 0) {
      throw new RoiInputRequiredError(
        `${date} 的商品表现接口没有返回“${product.name}”，本次未生成写入计划。`,
        [`确认商品在 ${date} 是否已上架并产生可查询数据`],
      );
    }
    const aggregated = aggregateMappedProductRows(date, rows);
    const overall = objectValue(objectValue(shopContract.rows[0]?.performance).overall);
    sources.push({
      date,
      ...aggregated,
      visitors: finiteNumber(overall.visitors, `${date}.visitors`),
      orderingVideos: new Set(product.ids.flatMap((id) => [...(orderingVideos.byProductId.get(id) ?? [])])).size,
      storeOrderingVideos: orderingVideos.storeVideoIds.size,
      sourceFiles: [
        ...(productContract.raw_source_paths ?? []),
        ...(shopContract.raw_source_paths ?? []),
        ...orderingVideos.sourceFiles,
      ],
      requestIds: [
        ...(productContract.request_ids ?? []),
        ...(shopContract.request_ids ?? []),
        ...orderingVideos.requestIds,
      ],
    });
  }

  return {
    version: 1,
    jobId: input.jobId,
    generatedAt: new Date().toISOString(),
    sourceShop: productMap.shop,
    product,
    startDate: dates[0],
    endDateInclusive: dates.at(-1)!,
    endDateExclusive: nextDate(dates.at(-1)!),
    sources,
    sourceFiles: [...new Set(sources.flatMap((source) => source.sourceFiles))],
    requestIds: [...new Set(sources.flatMap((source) => source.requestIds))],
    missingItems: manualItems(profile),
  };
}

function aggregateAttributionRows(rows: ReadonlyArray<Record<string, unknown>>) {
  const sum = (name: string) => rows.reduce((total, row) => total + finiteNumber(row[name], `order_attribution.${name}`), 0);
  const orderCount = (metric: string) => {
    const keyName = `${metric}_order_keys`;
    const keys = rows.flatMap((row) => Array.isArray(row[keyName]) ? row[keyName].map(String) : []);
    return keys.length > 0 ? new Set(keys).size : sum(`${metric}_orders`);
  };
  return {
    totalOrders: (() => {
      const keys = rows.flatMap((row) => Array.isArray(row.total_order_keys) ? row.total_order_keys.map(String) : []);
      return keys.length > 0 ? new Set(keys).size : sum("total_orders");
    })(),
    totalItems: sum("total_items"),
    productCardOrders: orderCount("product_card"),
    productCardItems: sum("product_card_items"),
    allianceVideoOrders: orderCount("alliance_video"),
    allianceVideoItems: sum("alliance_video_items"),
    allianceLiveOrders: orderCount("alliance_live"),
    allianceLiveItems: sum("alliance_live_items"),
    selfOperatedVideoOrders: orderCount("self_operated_video"),
    selfOperatedVideoItems: sum("self_operated_video_items"),
    selfOperatedLiveOrders: orderCount("self_operated_live"),
    selfOperatedLiveItems: sum("self_operated_live_items"),
  };
}

function aggregatePaidSnapshotRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  expectedCurrency: string | null,
) {
  const keys = rows.flatMap((row) => (
    Array.isArray(row.total_order_keys) ? row.total_order_keys.map(String) : []
  ));
  const salesReady = rows.every((row) => (
    row.sales_ready === true
    && String(row.sales_currency ?? "") === String(expectedCurrency ?? "")
  ));
  return {
    totalOrders: keys.length > 0
      ? new Set(keys).size
      : rows.reduce((total, row) => total + finiteNumber(row.total_orders, "paid_snapshot.total_orders"), 0),
    totalItems: rows.reduce(
      (total, row) => total + finiteNumber(row.total_items, "paid_snapshot.total_items"),
      0,
    ),
    sales: salesReady
      ? rows.reduce((total, row) => total + finiteNumber(row.sales_amount, "paid_snapshot.sales_amount"), 0)
      : undefined,
    salesCurrency: salesReady ? expectedCurrency ?? undefined : undefined,
  };
}

function storeAttributionForDate(
  rows: ReadonlyArray<Record<string, unknown>>,
  date: string,
) {
  const matches = rows.filter((row) => String(row.date ?? "") === date);
  if (matches.length > 1) {
    throw new Error(`${date} 的店铺订单归因汇总记录数=${matches.length}，拒绝猜测`);
  }
  return aggregateAttributionRows(matches);
}

function storeAttributionFields(store: ReturnType<typeof aggregateAttributionRows>) {
  return {
    storeAllianceVideoOrders: store.allianceVideoOrders,
    storeAllianceVideoItems: store.allianceVideoItems,
    storeAllianceLiveOrders: store.allianceLiveOrders,
    storeAllianceLiveItems: store.allianceLiveItems,
    storeSelfOperatedVideoOrders: store.selfOperatedVideoOrders,
    storeSelfOperatedVideoItems: store.selfOperatedVideoItems,
    storeSelfOperatedLiveOrders: store.selfOperatedLiveOrders,
    storeSelfOperatedLiveItems: store.selfOperatedLiveItems,
    storeCardOrders: store.productCardOrders,
    storeCardItems: store.productCardItems,
  };
}

export async function prepareOrderAttributionUpdatePlan(input: {
  startDate: string;
  endDateInclusive: string;
  profile?: BusinessProfile;
}): Promise<OrderAttributionUpdatePlan> {
  const profile = input.profile ?? loadBusinessProfile();
  if (!profile.tiktok.orderAttribution?.enabled) throw new Error("订单归因功能尚未启用");
  const dates = enumerateDates(input.startDate, input.endDateInclusive);
  if (dates.length > 7) throw new Error("订单归因实时校正单次最多7天");
  const productMap = await loadProductMap(profile);
  const mapped = Object.entries(productMap.products)
    .map(([id, name]) => ({ id: String(id).trim(), name: String(name).trim() }))
    .filter((item) => item.id && item.name);
  const groups = groupMappedProductsByCanonicalName(mapped);
  const contract = await fetchTikTokOrderAttribution(
    dates[0],
    nextDate(dates.at(-1)!),
    profile.tiktok.shopTimeZone,
    profile.tiktok.orderAttribution.targetCollaborationIsSelfOperated === true,
    180_000,
    tikTokRuntimeFromProfile(profile),
  );
  assertSourceShop(contract.shop?.name, productMap.shop);
  const writeReadyDateSet = new Set(contract.write_ready_dates);
  const writeDates = dates.filter((date) => writeReadyDateSet.has(date));
  const paidSnapshotDateSet = new Set(contract.paid_snapshot_dates);
  const paidSnapshotDates = dates.filter((date) => paidSnapshotDateSet.has(date));
  const mappedIds = new Set(mapped.map((item) => item.id));
  const positiveRows = [...contract.rows, ...contract.paid_snapshot_rows];
  const unmappedPositiveProductIds = productMap.strictScope ? [] : [...new Set(positiveRows
    .filter((row) => !mappedIds.has(String(row.product_id ?? "")) && finiteNumber(row.total_items, "order_attribution.total_items") > 0)
    .map((row) => String(row.product_id ?? ""))
    .filter(Boolean))];
  const scopedStoreByDate = new Map(writeDates.map((date) => [
    date,
    aggregateAttributionRows(contract.rows.filter((row) => (
      String(row.date ?? "") === date && mappedIds.has(String(row.product_id ?? ""))
    ))),
  ]));
  const entries = [...groups.values()].map((group) => ({
    product: group.product,
    sources: writeDates.map((date): DailyOrderAttributionSource => {
      const product = aggregateAttributionRows(contract.rows.filter((row) => (
        String(row.date ?? "") === date && group.productIds.includes(String(row.product_id ?? ""))
      )));
      const store = scopedStoreByDate.get(date) ?? aggregateAttributionRows([]);
      return {
        date,
        orders: product.totalOrders,
        items: product.totalItems,
        cardOrders: product.productCardOrders,
        cardItems: product.productCardItems,
        allianceVideoOrders: product.allianceVideoOrders,
        allianceVideoItems: product.allianceVideoItems,
        allianceLiveOrders: product.allianceLiveOrders,
        allianceLiveItems: product.allianceLiveItems,
        selfOperatedVideoOrders: product.selfOperatedVideoOrders,
        selfOperatedVideoItems: product.selfOperatedVideoItems,
        selfOperatedLiveOrders: product.selfOperatedLiveOrders,
        selfOperatedLiveItems: product.selfOperatedLiveItems,
        ...storeAttributionFields(store),
        sourceFiles: contract.normalized_source_path ? [contract.normalized_source_path] : [],
        requestIds: contract.request_ids,
      };
    }),
  })).filter((entry) => entry.sources.length > 0);
  const paidSnapshotEntries = [...groups.values()].map((group) => ({
    product: group.product,
    sources: paidSnapshotDates.map((date): DailyPaidOrderSnapshotSource => {
      const totals = aggregatePaidSnapshotRows(contract.paid_snapshot_rows.filter((row) => (
        String(row.date ?? "") === date && group.productIds.includes(String(row.product_id ?? ""))
      )), profile.tiktok.currencyCode ?? null);
      return {
        date,
        orders: totals.totalOrders,
        items: totals.totalItems,
        sales: totals.sales,
        salesCurrency: totals.salesCurrency,
        sourceFiles: contract.normalized_source_path ? [contract.normalized_source_path] : [],
        requestIds: contract.request_ids,
      };
    }),
  })).filter((entry) => entry.sources.length > 0);
  return {
    version: 1,
    mode: "order_attribution",
    startDate: dates[0],
    endDateInclusive: dates.at(-1)!,
    entries,
    paidSnapshotEntries,
    sourceFiles: contract.normalized_source_path ? [contract.normalized_source_path] : [],
    requestIds: contract.request_ids,
    unmappedPositiveProductIds,
    pendingDates: contract.pending_dates,
    missingItems: [
      ...(contract.missing_capabilities.includes("seller.affiliate_collaboration.read")
        ? ["TikTok正式授权缺少seller.affiliate_collaboration.read；渠道继续维持当前Analytics近似口径，精确标签归因暂不启用"]
        : []),
      ...((contract.paid_snapshot_sales_errors ?? []).length > 0
        ? ["部分订单行缺少可靠金额或币种；这些商品日只写单量/销量，不写销售额"]
        : []),
    ],
  };
}

export async function executeOrderAttributionUpdatePlan(
  plan: OrderAttributionUpdatePlan,
  gateway: StorefourDemoGateway,
): Promise<RealtimeResultSummary> {
  if (plan.entries.length === 0 && plan.paidSnapshotEntries.length === 0) {
    return {
      windowStart: plan.startDate,
      windowEndExclusive: nextDate(plan.endDateInclusive),
      sources: plan.sourceFiles,
      matched: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: plan.pendingDates.length,
      conflicts: 0,
      missingItems: [
        ...plan.missingItems,
        ...(plan.pendingDates.length > 0
          ? [`精确订单标签归因待就绪：${plan.pendingDates.join("、")}`]
          : []),
      ],
      backupPath: null,
      rollbackCommand: null,
    };
  }
  const firstProduct = plan.entries[0]?.product ?? plan.paidSnapshotEntries[0]?.product;
  if (!firstProduct) throw new Error("订单更新计划没有可初始化的商品");
  await gateway.initialize(firstProduct.name, "roi");
  const changes = { created: 0, updated: 0, unchanged: 0 };
  const attributionEntries = alignAttributionTotalsToPaidSnapshot(plan.entries, plan.paidSnapshotEntries);
  for (const entry of attributionEntries) {
    const current = await gateway.syncOrderAttribution(entry.sources, entry.product.name);
    changes.created += current.created;
    changes.updated += current.updated;
    changes.unchanged += current.unchanged;
  }
  for (const entry of plan.paidSnapshotEntries) {
    const current = await gateway.syncPaidOrderSnapshot(entry.sources, entry.product.name);
    changes.created += current.created;
    changes.updated += current.updated;
    changes.unchanged += current.unchanged;
  }
  if (plan.entries.length > 0) {
    const verification = await gateway.verifyOrderAttributionBulk(attributionEntries);
    if (!verification.ok) throw new Error(`订单归因写后验证失败：${verification.errors.join("；")}`);
  }
  if (plan.paidSnapshotEntries.length > 0) {
    const verification = await gateway.verifyPaidOrderSnapshotBulk(plan.paidSnapshotEntries);
    if (!verification.ok) throw new Error(`付款快照写后验证失败：${verification.errors.join("；")}`);
  }
  return {
    windowStart: plan.startDate,
    windowEndExclusive: nextDate(plan.endDateInclusive),
    sources: plan.sourceFiles,
    matched: plan.paidSnapshotEntries.reduce((total, entry) => total + entry.sources.length, 0),
    created: changes.created,
    updated: changes.updated,
    unchanged: changes.unchanged,
    skipped: 0,
    conflicts: 0,
    missingItems: [
      ...plan.missingItems,
      ...(plan.unmappedPositiveProductIds.length > 0
        ? [`订单中存在白名单外商品ID（已排除商品行）：${plan.unmappedPositiveProductIds.join("、")}`]
        : []),
      ...(plan.pendingDates.length > 0
        ? [`${plan.pendingDates.join("、")} 的北京时间单量/销量/可校验销售额已按订单快照写入；四路标签归因暂不写入`]
        : []),
    ],
    backupPath: null,
    rollbackCommand: null,
  };
}

/** Analytics channel attribution and paid-time orders can differ legitimately.
 * Total orders/items have one authority: the complete paid snapshot. Keep
 * channel fields unchanged and still verify paid totals EXACTLY afterwards.
 */
export function alignAttributionTotalsToPaidSnapshot(
  entries: OrderAttributionUpdatePlan["entries"],
  paidEntries: OrderAttributionUpdatePlan["paidSnapshotEntries"],
): OrderAttributionUpdatePlan["entries"] {
  const paid = new Map(paidEntries.flatMap((entry) => entry.sources.map((source) => [
    `${entry.product.name}\u0000${source.date}`, source,
  ] as const)));
  return entries.map((entry) => ({ ...entry, sources: entry.sources.map((source) => {
    const snapshot = paid.get(`${entry.product.name}\u0000${source.date}`);
    return snapshot ? { ...source, orders: snapshot.orders, items: snapshot.items } : source;
  }) }));
}

export async function prepareRoiBulkUpdatePlan(input: {
  jobId: string;
  startDate: string;
  endDateInclusive: string;
  rowFilter: "all" | "orders_positive";
  profile?: BusinessProfile;
  onProgress?: (progress: { date: string; completedDays: number; totalDays: number }) => void | Promise<void>;
}): Promise<RoiBulkUpdatePlan> {
  const profile = input.profile ?? loadBusinessProfile();
  if (profile.tiktok.roiDateBasis === "business") {
    throw new Error("该店投产比按北京时间归日，禁止把TikTok店铺日Analytics写进同名北京时间日期行");
  }
  const runtime = tikTokRuntimeFromProfile(profile);
  const dates = enumerateDates(input.startDate, input.endDateInclusive);
  if (dates.length > 31) throw new Error("投产比单次预览最多31天，请按自然月分批");
  const productMap = await loadProductMap(profile);
  const mappedProducts = Object.entries(productMap.products)
    .map(([id, name]) => ({ id: String(id).trim(), name: String(name).trim() }))
    .filter((item) => item.id && item.name);
  const byProductName = groupMappedProductsByCanonicalName(mappedProducts);
  const sourceFiles = new Set<string>();
  const requestIds = new Set<string>();
  const unmappedPositive = new Map<string, { id: string; name: string }>();
  const skippedDetails: RoiBulkUpdatePlan["skippedDetails"] = [];
  let skippedRows = 0;

  for (const [index, date] of dates.entries()) {
    await input.onProgress?.({ date, completedDays: index, totalDays: dates.length });
    const endDateExclusive = nextDate(date);
    const [productContract, shopContract, orderingVideos] = await Promise.all([
      fetchTikTokAnalytics("shop_product_performance", date, endDateExclusive, "", 180_000, runtime),
      fetchTikTokAnalytics("shop_performance_hourly", date, endDateExclusive, "", 180_000, runtime),
      fetchOrderingVideoCounts(date, endDateExclusive, runtime),
    ]);
    assertSourceShop(productContract.shop?.name, productMap.shop);
    assertSourceShop(shopContract.shop?.name, productMap.shop);
    logOrderingVideoDiagnostics(orderingVideos.warnings);
    for (const value of [
      ...(productContract.raw_source_paths ?? []),
      ...(shopContract.raw_source_paths ?? []),
      ...orderingVideos.sourceFiles,
    ]) sourceFiles.add(value);
    for (const value of [
      ...(productContract.request_ids ?? []),
      ...(shopContract.request_ids ?? []),
      ...orderingVideos.requestIds,
    ]) requestIds.add(value);
    const latestAvailableDate = productContract.latest_available_date ?? null;
    if (latestAvailableDate && date > latestAvailableDate) {
      for (const entry of byProductName.values()) {
        skippedRows += 1;
        skippedDetails.push({
          date,
          product: entry.product,
          reason: "date_unavailable",
          latestAvailableDate,
        });
      }
      continue;
    }
    const overall = objectValue(objectValue(shopContract.rows[0]?.performance).overall);
    const visitors = finiteNumber(overall.visitors, `${date}.visitors`);
    const rowsById = new Map(productContract.rows.map((row) => [String(row.id ?? ""), row]));

    for (const row of productContract.rows) {
      const id = String(row.id ?? "").trim();
      if (!id || productMap.products[id] || productMap.strictScope) continue;
      const orders = finiteNumber(objectValue(row.total_performance).orders, `${date}.${id}.orders`);
      if (orders > 0) {
        const name = String(row.name ?? row.product_name ?? row.title ?? "未命名商品").trim();
        unmappedPositive.set(id, { id, name });
      }
    }

    for (const entry of byProductName.values()) {
      const rows = entry.productIds
        .map((id) => ({ id, row: rowsById.get(id) }))
        .filter((item): item is { id: string; row: Record<string, any> } => Boolean(item.row));
      if (rows.length === 0) {
        skippedRows += 1;
        skippedDetails.push({
          date,
          product: entry.product,
          reason: "product_missing",
          latestAvailableDate,
        });
        continue;
      }
      const analyticsAggregated = aggregateMappedProductRows(date, rows);
      const aggregated = analyticsAggregated;
      const orders = aggregated.orders;
      if (input.rowFilter === "orders_positive" && orders <= 0) {
        skippedRows += 1;
        skippedDetails.push({
          date,
          product: entry.product,
          reason: "zero_orders",
          latestAvailableDate,
        });
        continue;
      }
      entry.sources.push({
        date,
        ...aggregated,
        visitors,
        orderingVideos: new Set(entry.productIds.flatMap((id) => (
          [...(orderingVideos.byProductId.get(id) ?? [])]
        ))).size,
        storeOrderingVideos: orderingVideos.storeVideoIds.size,
        sourceFiles: [...new Set([
          ...(productContract.raw_source_paths ?? []),
          ...(shopContract.raw_source_paths ?? []),
          ...orderingVideos.sourceFiles,
        ])],
        requestIds: [...new Set([
          ...(productContract.request_ids ?? []),
          ...(shopContract.request_ids ?? []),
          ...orderingVideos.requestIds,
        ])],
      });
    }
  }

  return {
    version: 1,
    mode: "bulk",
    jobId: input.jobId,
    generatedAt: new Date().toISOString(),
    sourceShop: productMap.shop,
    startDate: dates[0],
    endDateInclusive: dates.at(-1)!,
    endDateExclusive: nextDate(dates.at(-1)!),
    rowFilter: input.rowFilter,
    scannedMappedProducts: mappedProducts.length,
    skippedRows,
    skipSummary: {
      zeroOrders: skippedDetails.filter((item) => item.reason === "zero_orders").length,
      productMissing: skippedDetails.filter((item) => item.reason === "product_missing").length,
      dateUnavailable: skippedDetails.filter((item) => item.reason === "date_unavailable").length,
    },
    skippedDetails,
    unmappedPositiveProducts: [...unmappedPositive.values()],
    entries: [...byProductName.values()]
      .filter((entry) => entry.sources.length > 0)
      .map(({ product, sources }) => ({ product, sources })),
    sourceFiles: [...sourceFiles],
    requestIds: [...requestIds],
    missingItems: manualItems(profile),
  };
}

export async function executeRoiUpdatePlan(
  plan: RoiUpdatePlan,
  gateway: StorefourDemoGateway,
): Promise<RealtimeResultSummary> {
  await gateway.initialize(plan.product.name, "roi");
  const changes = await gateway.syncRoi(plan.sources, plan.product.name);
  const verification = await gateway.verifyRoi(plan.sources, plan.product.name);
  if (!verification.ok) {
    throw new Error(`投产比写后验证失败：${verification.errors.join("；")}`);
  }
  return {
    windowStart: plan.startDate,
    windowEndExclusive: plan.endDateExclusive,
    sources: plan.sourceFiles,
    matched: plan.sources.length * 2,
    created: changes.created,
    updated: changes.updated,
    unchanged: changes.unchanged,
    skipped: 0,
    conflicts: 0,
    missingItems: plan.missingItems,
    backupPath: null,
    rollbackCommand: null,
  };
}

export async function executeRoiBulkUpdatePlan(
  plan: RoiBulkUpdatePlan,
  gateway: StorefourDemoGateway,
  onStage?: (stage: "writing" | "verifying") => void | Promise<void>,
): Promise<RealtimeResultSummary> {
  if (plan.entries.length === 0) throw new Error("批量投产比计划没有可写入记录");
  await gateway.initialize(plan.entries[0].product.name, "roi");
  await onStage?.("writing");
  const changes = { created: 0, updated: 0, unchanged: 0 };
  for (const entry of plan.entries) {
    const current = await gateway.syncRoi(entry.sources, entry.product.name);
    changes.created += current.created;
    changes.updated += current.updated;
    changes.unchanged += current.unchanged;
  }
  await onStage?.("verifying");
  const verification = await gateway.verifyRoiBulk(plan.entries);
  if (!verification.ok) {
    throw new Error(`投产比批量写后验证失败：${verification.errors.join("；")}`);
  }
  const uniqueDates = new Set(plan.entries.flatMap((entry) => entry.sources.map((source) => source.date)));
  const productRows = plan.entries.reduce((total, entry) => total + entry.sources.length, 0);
  return {
    windowStart: plan.startDate,
    windowEndExclusive: plan.endDateExclusive,
    sources: plan.sourceFiles,
    matched: productRows + uniqueDates.size,
    created: changes.created,
    updated: changes.updated,
    unchanged: changes.unchanged,
    skipped: plan.skippedRows,
    conflicts: 0,
    missingItems: [
      ...plan.missingItems,
      ...(plan.unmappedPositiveProducts.length > 0
        ? [`有单但未映射商品：${plan.unmappedPositiveProducts.map((item) => `${item.name}(${item.id})`).join("、")}`]
        : []),
    ],
    backupPath: null,
    rollbackCommand: null,
  };
}

export function formatRoiPreview(plan: RoiUpdatePlan): string {
  const rows = plan.sources.map((source) => [
    source.date,
    `单量${source.orders}`,
    `数量${source.items}`,
    `商品卡${source.cardOrders}/${source.cardItems}`,
    `销售额$${source.gmv.toFixed(2)}`,
    `店铺访客${source.visitors}`,
    `商品出单视频${source.orderingVideos}`,
    `店铺出单视频${source.storeOrderingVideos}`,
  ].join("；"));
  return [
    `投产比写入预览：${plan.sourceShop} / ${plan.product.name}`,
    ...rows,
    "将写入：商品、日期、单量、数量、商品卡出单量/数量、销售额、店铺浏览量、出单视频。",
    "不会写：合作量、上线量、达人出单、店铺汇总、转化率等飞书公式字段。",
    `仍需人工：${plan.missingItems.join("、")}。`,
    "确认无误请回复：继续刚才的更新",
  ].join("\n");
}

export function formatRoiBulkPreview(plan: RoiBulkUpdatePlan): string {
  const rows = plan.entries.flatMap((entry) => entry.sources.map((source) => [
    `${source.date} / ${entry.product.name}`,
    `单量${source.orders}`,
    `数量${source.items}`,
    `商品卡${source.cardOrders}/${source.cardItems}`,
    `销售额$${source.gmv.toFixed(2)}`,
    `店铺访客${source.visitors}`,
    `商品出单视频${source.orderingVideos}`,
    `店铺出单视频${source.storeOrderingVideos}`,
  ].join("；")));
  const interpretation = `已理解为：扫描 ${plan.startDate} 至 ${plan.endDateInclusive}（上海时区、${windowTodayNote(plan)}），范围为全部已映射商品，${plan.rowFilter === "orders_positive" ? "只保留单量 > 0 的日期商品行" : "保留全部日期商品行"}。`;
  if (rows.length === 0) {
    const skipEvidence = formatBulkSkipEvidence(plan);
    return [
      interpretation,
      `扫描完成：${plan.scannedMappedProducts} 个已映射商品 × ${enumerateDates(plan.startDate, plan.endDateInclusive).length} 天，没有符合条件的数据。`,
      ...skipEvidence,
      plan.unmappedPositiveProducts.length > 0
        ? `发现有单但未映射商品：${plan.unmappedPositiveProducts.map((item) => `${item.name}(${item.id})`).join("、")}；未擅自写入。`
        : null,
      "本次没有生成写入计划，也没有修改飞书。",
    ].filter(Boolean).join("\n");
  }
  return [
    interpretation,
    `投产比批量写入预览：${plan.sourceShop}；共 ${rows.length} 个日期商品行。`,
    ...rows,
    "将写入：商品、日期、单量、数量、商品卡出单量/数量、销售额、店铺浏览量、出单视频。",
    "达人出单、店铺汇总和转化率继续由飞书公式自动计算，不由机器人硬写。",
    plan.unmappedPositiveProducts.length > 0
      ? `发现有单但未映射商品：${plan.unmappedPositiveProducts.map((item) => `${item.name}(${item.id})`).join("、")}；本批跳过。`
      : null,
    ...formatBulkSkipEvidence(plan),
    `仍需人工：${plan.missingItems.join("、")}。`,
    "确认无误请回复：继续刚才的更新",
  ].filter(Boolean).join("\n");
}

function formatBulkSkipEvidence(plan: RoiBulkUpdatePlan): string[] {
  const lines: string[] = [];
  const zeroDates = plan.skippedDetails
    .filter((item) => item.reason === "zero_orders")
    .map((item) => item.date);
  const missingDates = plan.skippedDetails
    .filter((item) => item.reason === "product_missing")
    .map((item) => item.date);
  const unavailable = plan.skippedDetails
    .filter((item) => item.reason === "date_unavailable");

  if (zeroDates.length > 0) {
    lines.push(`接口明确返回 0 单：${plan.skipSummary.zeroOrders} 个日期商品组合（${compactDates(zeroDates)}）。`);
  }
  if (missingDates.length > 0) {
    lines.push(`接口未返回已映射商品：${plan.skipSummary.productMissing} 个日期商品组合（${compactDates(missingDates)}）；不能据此判定为 0 单。`);
  }
  if (unavailable.length > 0) {
    const latestDates = [...new Set(unavailable.map((item) => item.latestAvailableDate).filter(Boolean))];
    const latestNote = latestDates.length === 1 ? `，接口最新可用日期为 ${latestDates[0]}` : "";
    lines.push(`数据尚未生成：${plan.skipSummary.dateUnavailable} 个日期商品组合（${compactDates(unavailable.map((item) => item.date))}${latestNote}）；不能按 0 单处理。`);
  }
  return lines;
}

function compactDates(values: string[]): string {
  return [...new Set(values)].join("、");
}

function windowTodayNote(plan: RoiBulkUpdatePlan): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(plan.generatedAt));
  return plan.endDateInclusive === today
    ? "包含今天；当天API数据可能尚未完整"
    : "不含今天，仅使用完整自然日";
}

export interface OrderingVideoCounts {
  storeVideoIds: Set<string>;
  byProductId: Map<string, Set<string>>;
  sourceFiles: string[];
  requestIds: string[];
  warnings: string[];
}

export async function fetchOrderingVideoCounts(
  date: string,
  endDateExclusive: string,
  runtime: TikTokRuntimeContext = {},
): Promise<OrderingVideoCounts> {
  const videoContract = await fetchTikTokVideoDay(date, endDateExclusive, 180_000, runtime);
  if (!videoContract.ok || videoContract.dataset !== "shop_video_performance") {
    throw new Error(videoContract.errors[0] ?? `${date} 出单视频列表获取失败`);
  }
  if (videoContract.pagination_truncated) throw new Error(`${date} 出单视频列表分页不完整`);
  if (videoContract.conflicting_duplicate_ids.length > 0) {
    throw new Error(`${date} 出单视频存在指标冲突ID：${videoContract.conflicting_duplicate_ids.join("、")}`);
  }
  if (videoContract.latest_available_date && date > videoContract.latest_available_date) {
    throw new RoiInputRequiredError(
      `${date} 的视频成交数据尚未生成，接口最新可用日期为 ${videoContract.latest_available_date}。`,
      [`${date} 的完整视频成交数据`],
    );
  }

  const positiveVideoIds = new Set<string>();
  for (const row of videoContract.rows) {
    const videoId = String(row.id ?? "").trim();
    if (!/^\d{10,}$/.test(videoId)) continue;
    const itemsSold = nonnegativeInteger(row.items_sold, `${date}.${videoId}.items_sold`);
    if (itemsSold > 0) positiveVideoIds.add(videoId);
  }
  const details = new Map<string, TikTokMachineContract>();
  for (const videoId of positiveVideoIds) {
    details.set(videoId, await fetchTikTokAnalytics(
      "shop_video_product_performance",
      date,
      endDateExclusive,
      videoId,
      180_000,
      runtime,
    ));
  }
  return summarizeOrderingVideoCounts(videoContract, details, date);
}

export function summarizeOrderingVideoCounts(
  videoContract: TikTokMachineContract,
  detailContracts: ReadonlyMap<string, TikTokMachineContract>,
  date: string,
): OrderingVideoCounts {
  const storeVideoIds = new Set<string>();
  const byProductId = new Map<string, Set<string>>();
  const sourceFiles = new Set(videoContract.raw_source_paths ?? []);
  const requestIds = new Set(videoContract.request_ids ?? []);
  const warnings = new Set<string>();

  for (const row of videoContract.rows) {
    const videoId = String(row.id ?? "").trim();
    if (!/^\d{10,}$/.test(videoId)) continue;
    const videoUnits = nonnegativeInteger(row.items_sold, `${date}.${videoId}.items_sold`);
    if (videoUnits === 0) continue;
    const detail = detailContracts.get(videoId);
    if (!detail) throw new Error(`${date}.${videoId} 缺少视频商品成交明细`);
    if (!detail.ok || detail.dataset !== "shop_video_product_performance") {
      throw new Error(detail.errors[0] ?? `${date}.${videoId} 视频商品成交明细无效`);
    }
    if (detail.pagination_truncated) throw new Error(`${date}.${videoId} 视频商品成交明细分页不完整`);
    if (detail.latest_available_date && date > detail.latest_available_date) {
      throw new Error(`${date}.${videoId} 视频商品成交明细尚未生成`);
    }
    for (const value of detail.raw_source_paths ?? []) sourceFiles.add(value);
    for (const value of detail.request_ids ?? []) requestIds.add(value);

    const unitsByProduct = new Map<string, number>();
    for (const product of detail.rows) {
      const productId = String(product.id ?? "").trim();
      if (!/^\d+$/.test(productId)) throw new Error(`${date}.${videoId} 返回无效商品ID`);
      const units = nonnegativeInteger(product.units_sold, `${date}.${videoId}.${productId}.units_sold`);
      const prior = unitsByProduct.get(productId);
      if (prior !== undefined && prior !== units) {
        throw new Error(`${date}.${videoId}.${productId} 返回冲突成交件数`);
      }
      unitsByProduct.set(productId, units);
    }
    const detailUnits = [...unitsByProduct.values()].reduce((total, value) => total + value, 0);
    let positiveProducts = [...unitsByProduct.entries()].filter(([, units]) => units > 0);
    const attachedProductIds = videoProductIds(row);
    const fallbackProductIds = unitsByProduct.size === 1
      ? [...unitsByProduct.keys()]
      : attachedProductIds;
    if (detailUnits !== videoUnits && positiveProducts.length === 0 && fallbackProductIds.length === 1) {
      // TikTok's per-video product attribution can arrive later than the video total.
      // When the detail response (or, secondarily, the video row) identifies
      // exactly one product, the counting result is deterministic: this
      // positive-order video belongs to that sole product.
      positiveProducts = [[fallbackProductIds[0], videoUnits]];
    } else if (detailUnits !== videoUnits && positiveProducts.length === 0) {
      warnings.add(
        `${date} 有1个出单视频的总成交件数为${videoUnits}，但逐商品明细合计为${detailUnits}；视频挂了${attachedProductIds.length}个商品，无法唯一归属，已只保留店铺出单视频`,
      );
    }
    storeVideoIds.add(videoId);
    for (const [productId] of positiveProducts) {
      const ids = byProductId.get(productId) ?? new Set<string>();
      ids.add(videoId);
      byProductId.set(productId, ids);
    }
  }
  return {
    storeVideoIds,
    byProductId,
    sourceFiles: [...sourceFiles],
    requestIds: [...requestIds],
    warnings: [...warnings],
  };
}

function videoProductIds(row: Record<string, unknown>): string[] {
  const products = Array.isArray(row.products) ? row.products : [];
  return [...new Set(products.map((product) => {
    const value = product && typeof product === "object" ? product as Record<string, unknown> : {};
    return String(value.id ?? "").trim();
  }).filter((id) => /^\d+$/.test(id)))];
}

function logOrderingVideoDiagnostics(warnings: readonly string[]): void {
  for (const warning of warnings) console.warn(`[roi-video-attribution] ${warning}`);
}

async function loadProductMap(profile: BusinessProfile = loadBusinessProfile()): Promise<{
  shop: string;
  products: Record<string, string>;
  strictScope: boolean;
}> {
  const productMapPath = resolve(profile.tiktok.productMapFile);
  const parsed = JSON.parse(await readFile(productMapPath, "utf8")) as {
    shop?: unknown;
    products?: unknown;
  };
  const shop = String(parsed.shop ?? "").trim();
  const included = includedProductNameSet(profile);
  const products = Object.fromEntries(Object.entries(objectValue(parsed.products))
    .map(([id, name]) => [id, requireCanonicalProductName(String(name))])
    .filter(([, name]) => !included || included.has(name)));
  if (!shop || Object.keys(products).length === 0) {
    throw new Error("TikTok商品映射缺少店铺或商品");
  }
  return { shop, products, strictScope: Boolean(included) };
}

function resolveProduct(
  products: Record<string, string>,
  requested?: string,
): { id: string; name: string; ids: string[] } {
  const entries = Object.entries(products)
    .map(([id, name]) => ({ id: String(id).trim(), name: String(name).trim() }))
    .filter((item) => item.id && item.name);
  if (!requested) {
    const groups = groupMappedProductsByCanonicalName(entries);
    if (groups.size === 1) {
      const group = [...groups.values()][0];
      return { ...group.product, ids: group.productIds };
    }
    throw new RoiInputRequiredError(
      `请在命令中写商品名。当前可选：${[...new Set(entries.map((item) => item.name))].join("、")}`,
      ["商品名"],
    );
  }
  const needle = requested.trim().toLocaleLowerCase("zh-CN");
  const exact = entries.filter((item) => (
    item.id === requested.trim()
    || item.name.toLocaleLowerCase("zh-CN") === needle
  ));
  const matches = exact.length > 0
    ? exact
    : entries.filter((item) => item.name.toLocaleLowerCase("zh-CN").includes(needle));
  if (matches.length === 0) {
    throw new RoiInputRequiredError(
      `商品“${requested}”尚未建立 TikTok ID 映射。`,
      ["唯一商品名或TikTok商品ID"],
    );
  }
  const matchedNames = [...new Set(matches.map((item) => item.name))];
  if (matchedNames.length > 1) {
    throw new RoiInputRequiredError(
      `“${requested}”能匹配多个商品：${matchedNames.join("、")}。请说完整商品名。`,
      ["完整商品名"],
    );
  }
  const selectedName = matches[0].name;
  const sameName = entries.filter((item) => item.name === selectedName);
  return { ...sameName[0], ids: sameName.map((item) => item.id) };
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function finiteNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} 不是有效数字`);
  return parsed;
}

/** TikTok omits a channel block when that channel contributed no activity for the day. */
export function sparseMetricNumber(value: unknown, label: string): number {
  if (value == null || value === "") return 0;
  return finiteNumber(value, label);
}

export function aggregateMappedProductRows(
  date: string,
  rows: ReadonlyArray<{ id: string; row: Record<string, any> }>,
): Pick<DailySource, "orders" | "items" | "gmv" | "cardOrders" | "cardItems"> {
  const totals = rows.map(({ id, row }) => ({ id, value: objectValue(row.total_performance) }));
  const cards = rows.map(({ id, row }) => ({ id, value: objectValue(row.seller_product_card_performance) }));
  return {
    orders: totals.reduce((sum, item) => sum + finiteNumber(item.value.orders, `${date}.${item.id}.orders`), 0),
    items: totals.reduce((sum, item) => sum + finiteNumber(item.value.items_sold, `${date}.${item.id}.items_sold`), 0),
    gmv: roundCurrency(totals.reduce(
      (sum, item) => sum + moneyValue(item.value.gmv, `${date}.${item.id}.gmv`),
      0,
    )),
    cardOrders: cards.reduce((sum, item) => sum + sparseMetricNumber(item.value.attributed_orders, `${date}.${item.id}.card_orders`), 0),
    cardItems: cards.reduce((sum, item) => sum + sparseMetricNumber(item.value.attributed_sold_items, `${date}.${item.id}.card_items`), 0),
  };
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function nonnegativeInteger(value: unknown, label: string): number {
  const parsed = finiteNumber(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} 不是非负整数`);
  return parsed;
}

function moneyValue(value: unknown, label: string): number {
  return finiteNumber(objectValue(value).amount, label);
}

function assertSourceShop(actual: unknown, expected: string): void {
  if (String(actual ?? "").toLocaleLowerCase("en-US") !== expected.toLocaleLowerCase("en-US")) {
    throw new Error(`TikTok API 当前店铺不是 ${expected}：${String(actual ?? "")}`);
  }
}
