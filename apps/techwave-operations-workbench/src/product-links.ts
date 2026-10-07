export interface ProductLinkMapping {
  productName: string;
  tiktokProductId: string;
  updatedAt: string;
}

/**
 * Current formal mappings, verified against the tenant-isolated central maps
 * and TikTok Product Detail on 2026-08-13. Product IDs are public catalog
 * identifiers; credentials and shop ciphers never enter the workbench bundle.
 * Stored per-Base mappings still take precedence when a product is added or
 * remapped through the workbench.
 */
const VERIFIED_FORMAL_MAPPINGS: ProductLinkMapping[] = [
  {
    productName: "水杨酸沐浴露",
    tiktokProductId: "1732504520547078146",
    updatedAt: "2026-08-13T00:00:00.000Z",
  },
  {
    productName: "户外蓝牙音箱",
    tiktokProductId: "1732523630634439455",
    updatedAt: "2026-08-13T00:00:00.000Z",
  },
  {
    productName: "便携蓝牙音箱",
    tiktokProductId: "1732524646642062111",
    updatedAt: "2026-08-13T00:00:00.000Z",
  },
];

export function verifiedFormalProductMappings(): ProductLinkMapping[] {
  return VERIFIED_FORMAL_MAPPINGS.map((mapping) => ({ ...mapping }));
}

export function mergeProductMappings(
  defaults: readonly ProductLinkMapping[],
  stored: readonly ProductLinkMapping[],
): ProductLinkMapping[] {
  const byProduct = new Map<string, ProductLinkMapping>();
  for (const mapping of [...defaults, ...stored]) {
    const productName = mapping.productName.trim();
    const tiktokProductId = mapping.tiktokProductId.trim();
    if (!productName || !/^\d{8,32}$/.test(tiktokProductId)) continue;
    byProduct.set(productName, { ...mapping, productName, tiktokProductId });
  }
  return [...byProduct.values()];
}

export function buildTikTokProductUrl(productId: string): string | null {
  const normalized = productId.trim();
  if (!/^\d{8,32}$/.test(normalized)) return null;
  // TikTok Shop resolves the public PDP by the final product ID. The neutral
  // slug avoids coupling the link to mutable product titles.
  return `https://shop.tiktok.com/us/pdp/product/${normalized}`;
}

export function productUrlForName(
  productName: string,
  mappings: readonly ProductLinkMapping[],
): string | null {
  const matches = mappings.filter((mapping) => mapping.productName.trim() === productName.trim());
  if (matches.length !== 1) return null;
  return buildTikTokProductUrl(matches[0].tiktokProductId);
}
