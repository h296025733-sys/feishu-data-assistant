import { getEnv, requireFeishuEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { dateKeyInTimeZone } from "../realtime/business-time.js";
import { loadProductSpikeSnapshot } from "../bot/product-spike-snapshot.js";

const env = requireFeishuEnv(getEnv());
const registry = new TenantRegistry(env);
const rows = [];
for (const tenant of registry.all()) {
  const businessDate = dateKeyInTimeZone(new Date(), tenant.profile.businessTimeZone);
  const snapshot = await loadProductSpikeSnapshot(tenant.profile, businessDate);
  rows.push({
    tenantId: tenant.binding.id,
    store: tenant.profile.businessDisplayName,
    businessDate,
    pollMinutes: tenant.profile.productSpikeMonitor?.pollMinutes ?? null,
    enabled: tenant.profile.productSpikeMonitor?.enabled === true,
    groupCount: registry.groupRoutesForTenant(tenant.binding.id).length,
    groupSuffixes: registry.groupRoutesForTenant(tenant.binding.id).map((route) => route.chatId.slice(-6)),
    products: snapshot.products.map((product) => ({
      name: product.name,
      orders: product.orders,
      items: product.items,
      sales: product.sales,
      orderKeyCount: product.orderKeys.length,
    })),
    excludedCurrentOrders: snapshot.unmappedOrderKeys.filter((key) => (
      snapshot.unmappedPaidAtByOrderKey[key] >= Date.now() - 30 * 60_000
      && snapshot.unmappedPaidAtByOrderKey[key] <= Date.now()
    )).length,
    videoAttributionAvailable: snapshot.videoAttributionAvailable,
    videoAttributionErrors: snapshot.videoAttributionErrors,
    exactVideoRows: snapshot.videos.length,
    normalizedSourcePath: snapshot.sourcePath,
  });
}
console.log(JSON.stringify({
  ok: true,
  evidence: "真实TikTok只读付款快照；未调用飞书消息发送接口",
  rows,
}, null, 2));
