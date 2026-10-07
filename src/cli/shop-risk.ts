import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";
import { ShopRiskService } from "../shop-risk/service.js";
import { fetchTikTokShopRisks, tikTokRuntimeFromProfile } from "../realtime/tiktok-cli.js";
import { snapshotSchema, reconcile, buildRiskCard, beijingDate } from "../shop-risk/model.js";

const registry = new TenantRegistry(getEnv());
const id = process.argv.find(v => v.startsWith("--tenant="))?.split("=")[1];
const tenants = id ? [registry.byId(id)!] : registry.all();
if (tenants.some(t => !t)) throw new Error("未知店铺");
const apply = process.argv.includes("--apply");
for (const tenant of tenants) {
  const client = createFeishuClient(tenant.env);
  if (!apply) {
    const snapshot = snapshotSchema.parse(await fetchTikTokShopRisks(tikTokRuntimeFromProfile(tenant.profile)));
    if (snapshot.shop.id !== tenant.profile.tiktok.shopId) throw new Error("店铺身份不匹配");
    const next = reconcile(snapshot);
    console.log(JSON.stringify({ tenant: tenant.binding.id, mode: "read-only", evidence: snapshot.evidencePath,
      failures: next.failures, sourceCounts: Object.fromEntries(Object.entries(snapshot.sources).map(([k, v]) => [k, v.rows?.length ?? v.ok])),
      ...buildRiskCard(tenant.profile.businessDisplayName, beijingDate(), next.state, next.failures, tenant.env.FEISHU_BITABLE_URL || "") }, null, 2));
  } else {
    const service = new ShopRiskService({ tenant, client, groupChatIds: () => registry.groupRoutesForTenant(tenant.binding.id).map(r => r.chatId),
      sendCard: async () => { throw new Error("安装/预览入口禁止发送群消息"); } });
    console.log(JSON.stringify({ tenant: tenant.binding.id, ...await service.install(),
      ...await (process.argv.includes("--repair-table") ? service.repairFromSavedSnapshot() : service.prepare(process.argv.includes("--refresh"))) }, null, 2));
  }
}
