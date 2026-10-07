import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";
import { StorefourDemoGateway } from "../feishu/storefour-demo-gateway.js";
import {
  executeOrderAttributionUpdatePlan,
  prepareOrderAttributionUpdatePlan,
} from "../realtime/roi-sync.js";

const tenantId = argument("--tenant");
const startDate = argument("--start-date");
const endDateInclusive = argument("--end-date-inclusive");
const apply = process.argv.includes("--apply");
const registry = new TenantRegistry(getEnv());
const tenant = registry.byId(tenantId);
if (!tenant) throw new Error(`店铺租户不存在或未启用：${tenantId}`);

const plan = await prepareOrderAttributionUpdatePlan({
  startDate,
  endDateInclusive,
  profile: tenant.profile,
});
const preview = {
  tenant: tenantId,
  mode: apply ? "apply" : "dry-run",
  policy: "店铺时区paid_time订单快照；有Affiliate权限时用原生标签精确归因，否则维持Analytics近似渠道口径",
  range: `${plan.startDate} 至 ${plan.endDateInclusive}`,
  writeReadyDates: [...new Set(plan.entries.flatMap((entry) => entry.sources.map((source) => source.date)))],
  paidSnapshotDates: [...new Set(plan.paidSnapshotEntries.flatMap((entry) => entry.sources.map((source) => source.date)))],
  pendingDates: plan.pendingDates,
  products: plan.entries.map((entry) => ({
    name: entry.product.name,
    dates: entry.sources.length,
  })),
  paidSnapshotProducts: plan.paidSnapshotEntries.map((entry) => ({
    name: entry.product.name,
    values: entry.sources.map((source) => ({
      date: source.date,
      orders: source.orders,
      items: source.items,
      sales: source.sales ?? null,
      currency: source.salesCurrency ?? null,
    })),
  })),
  missingItems: plan.missingItems,
  unmappedPositiveProductIds: plan.unmappedPositiveProductIds,
};
if (!apply) {
  console.log(JSON.stringify(preview, null, 2));
  process.exit(0);
}

const gateway = new StorefourDemoGateway(
  tenant.env,
  createFeishuClient(tenant.env),
  tenant.profile,
);
const result = await executeOrderAttributionUpdatePlan(plan, gateway);
console.log(JSON.stringify({ ...preview, result }, null, 2));

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
  if (!value) throw new Error(`缺少参数 ${name}`);
  return value;
}
