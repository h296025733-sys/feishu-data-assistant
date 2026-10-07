import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BusinessProfile } from "../config/business-profile.js";
import { requireCanonicalProductName } from "../business/product-naming.js";
import type { BusinessProductOptionResult, StorefourDemoGateway } from "../feishu/storefour-demo-gateway.js";
import type { TikTokMachineContract } from "../realtime/types.js";

export interface ProductCatalogMap {
  shop: string;
  products: Record<string, string>;
  sourceTitles?: Record<string, string>;
}

export interface UnmappedCatalogProduct {
  id: string;
  sourceTitle: string;
}

export interface ProductCatalogPlan {
  canonicalNames: string[];
  observedMappedNames: string[];
  unmappedProducts: UnmappedCatalogProduct[];
}

export async function loadProductCatalogMap(profile: BusinessProfile): Promise<ProductCatalogMap> {
  const filePath = path.resolve(process.cwd(), profile.tiktok.productMapFile);
  const raw = JSON.parse(await readFile(filePath, "utf8")) as Partial<ProductCatalogMap>;
  const products = raw.products && typeof raw.products === "object" ? raw.products : {};
  const sourceTitles = raw.sourceTitles && typeof raw.sourceTitles === "object" ? raw.sourceTitles : {};
  if (!String(raw.shop ?? "").trim()) throw new Error(`商品映射缺少 shop：${filePath}`);
  return { shop: String(raw.shop).trim(), products, sourceTitles };
}

export function buildProductCatalogPlan(
  contract: TikTokMachineContract,
  productMap: ProductCatalogMap,
  titleContract?: TikTokMachineContract,
  includedCanonicalProducts?: readonly string[],
): ProductCatalogPlan {
  if (!contract.ok || contract.dataset !== "shop_product_performance") {
    throw new Error(`商品目录接口不可用：${contract.errors.join("；") || contract.dataset}`);
  }
  const actualShop = String(contract.shop?.name ?? "").trim();
  if (!sameShop(actualShop, productMap.shop)) {
    throw new Error(`TikTok API 当前店铺不是 ${productMap.shop}：${actualShop || "未知"}`);
  }

  const included = includedCanonicalProducts?.length
    ? new Set(includedCanonicalProducts.map((name) => requireCanonicalProductName(name)))
    : null;
  const canonicalNames = [...new Set(
    Object.values(productMap.products)
      .map((name) => String(name).trim())
      .filter((name) => Boolean(name) && (!included || included.has(requireCanonicalProductName(name)))),
  )].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const observedMappedNames = new Set<string>();
  const unmapped = new Map<string, UnmappedCatalogProduct>();
  const sourceDetails = productDetailsFromContract(titleContract);
  const hasOfficialDetails = titleContract?.dataset === "product_detail";
  for (const row of contract.rows) {
    const id = String(row.id ?? row.product_id ?? "").trim();
    if (!id) continue;
    const detail = sourceDetails.get(id);
    if (detail?.status && detail.status !== "ACTIVATE") continue;
    const mapped = String(productMap.products[id] ?? "").trim();
    if (mapped) {
      if (!included || included.has(requireCanonicalProductName(mapped))) observedMappedNames.add(mapped);
      continue;
    }
    // In strict allowlist mode, unknown listings are intentionally out of scope.
    if (included) continue;
    const sourceTitle = String(
      hasOfficialDetails
        ? detail?.title ?? row.name ?? row.product_name ?? row.title ?? "TikTok 未返回商品标题"
        : row.name ?? row.product_name ?? row.title ?? detail?.title ?? "TikTok 未返回商品标题",
    ).trim();
    unmapped.set(id, { id, sourceTitle });
  }
  return {
    canonicalNames,
    observedMappedNames: [...observedMappedNames].sort((a, b) => a.localeCompare(b, "zh-CN")),
    unmappedProducts: [...unmapped.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export async function syncProductCatalog(input: {
  contract: TikTokMachineContract;
  titleContract?: TikTokMachineContract;
  profile: BusinessProfile;
  gateway: Pick<StorefourDemoGateway, "ensureBusinessProductOptions">;
}): Promise<ProductCatalogPlan & BusinessProductOptionResult> {
  const productMap = await loadProductCatalogMap(input.profile);
  const plan = buildProductCatalogPlan(
    input.contract,
    productMap,
    input.titleContract,
    input.profile.tiktok.autoEnrollNewProducts
      ? Object.values(productMap.products)
      : input.profile.tiktok.includedCanonicalProducts,
  );
  const optionResult = await input.gateway.ensureBusinessProductOptions(plan.canonicalNames);
  return { ...plan, ...optionResult };
}

function productDetailsFromContract(
  contract: TikTokMachineContract | undefined,
): Map<string, { title: string; status: string }> {
  const details = new Map<string, { title: string; status: string }>();
  for (const row of contract?.rows ?? []) {
    const directId = String(row.id ?? row.product_id ?? "").trim();
    const directTitle = String(row.title ?? row.name ?? row.product_name ?? "").trim();
    const directStatus = String(row.status ?? row.product_status ?? "").trim();
    if (directId && !details.has(directId)) {
      details.set(directId, { title: directTitle, status: directStatus });
    }
    let products: unknown = row.products;
    if (typeof products === "string") {
      try { products = JSON.parse(products); } catch { products = []; }
    }
    if (!Array.isArray(products)) continue;
    for (const value of products) {
      if (!value || typeof value !== "object") continue;
      const product = value as Record<string, unknown>;
      const id = String(product.id ?? product.product_id ?? "").trim();
      const name = String(product.name ?? product.product_name ?? "").trim();
      if (id && name && !details.has(id)) details.set(id, { title: name, status: "" });
    }
  }
  return details;
}

function sameShop(actual: string, expected: string): boolean {
  const normalize = (value: string) => value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return Boolean(actual) && normalize(actual) === normalize(expected);
}
