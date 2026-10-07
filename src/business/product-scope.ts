import type { BusinessProfile } from "../config/business-profile.js";
import { requireCanonicalProductName } from "./product-naming.js";

/**
 * A configured list is a strict store-level allowlist. Products outside it stay
 * invisible to catalog provisioning, online imports, and ROI writes.
 */
export function includedProductNameSet(profile: BusinessProfile): ReadonlySet<string> | null {
  // Auto-enrollment keeps the durable allowlist in the per-tenant product map.
  // Returning null here means "all mapped products", never "all TikTok rows".
  if (profile.tiktok.autoEnrollNewProducts) return null;
  const configured = profile.tiktok.includedCanonicalProducts ?? [];
  if (configured.length === 0) return null;
  return new Set(configured.map((name) => requireCanonicalProductName(name)));
}

export function productNameIsIncluded(
  profile: BusinessProfile,
  canonicalName: string,
): boolean {
  const included = includedProductNameSet(profile);
  return !included || included.has(requireCanonicalProductName(canonicalName));
}
