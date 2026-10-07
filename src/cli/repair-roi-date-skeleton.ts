import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadProductCatalogMap } from "../automation/product-catalog.js";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";
import { FeishuBitableDataSource } from "../feishu/data-source.js";
import { StorefourDemoGateway } from "../feishu/storefour-demo-gateway.js";

const CONFIRMATION = "REPAIR-ROI-DATE-SKELETON-CREATE-ONLY-20260817";
const dates = (argument("--dates") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const tenantId = argument("--tenant");
const apply = process.argv.includes("--apply");
if (dates.length === 0 || dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
  throw new Error("--dates 必须提供逗号分隔的YYYY-MM-DD日期");
}
if (apply && argument("--confirm") !== CONFIRMATION) {
  throw new Error(`正式创建必须提供 --apply --confirm ${CONFIRMATION}`);
}

const env = requireFeishuEnv(getEnv());
if (env.FEISHU_APP_ID !== "demo_ded47f35") throw new Error("不是指定正式应用，拒绝执行");
const registry = new TenantRegistry(env);
const selectedTenant = tenantId ? registry.byId(tenantId) : null;
if (tenantId && !selectedTenant) throw new Error(`店铺租户不存在或未启用：${tenantId}`);
const results = [];
for (const tenant of selectedTenant ? [selectedTenant] : registry.all()) {
  await assertDailyIdle(tenant.binding.id);
  const source = new FeishuBitableDataSource(
    tenant.env,
    createFeishuClient(tenant.env),
    tenant.profile,
  );
  const before = await snapshot(source, tenant.profile, dates);
  let changes: { created: number; updated: number; unchanged: number } | null = null;
  if (apply) {
    const products = tenant.profile.tiktok.autoEnrollNewProducts
      ? [...new Set(Object.values((await loadProductCatalogMap(tenant.profile)).products))]
      : tenant.profile.tiktok.includedCanonicalProducts ?? [];
    if (products.length === 0) throw new Error(`${tenant.binding.id}没有正式商品范围`);
    const gateway = new StorefourDemoGateway(
      tenant.env,
      createFeishuClient(tenant.env),
      tenant.profile,
    );
    await gateway.initialize(products[0]!, "roi");
    changes = await gateway.ensureRoiDateSkeleton(dates, products);
    await sleep(2_000);
  }
  const after = await snapshot(source, tenant.profile, dates);
  if (apply && after.some((item) => item.count !== 1)) {
    throw new Error(`${tenant.binding.id}日期骨架写后验证失败`);
  }
  results.push({
    tenantId: tenant.binding.id,
    store: tenant.profile.businessDisplayName,
    mode: apply ? "apply" : "dry-run",
    before,
    changes,
    after,
  });
}

console.log(JSON.stringify({
  ok: true,
  evidence: apply ? "正式飞书创建缺失键 + 写后回读" : "正式飞书只读预检",
  checkedAt: new Date().toISOString(),
  dates,
  results,
}, null, 2));

async function snapshot(
  source: FeishuBitableDataSource,
  profile: ReturnType<TenantRegistry["default"]>["profile"],
  targetDates: string[],
): Promise<Array<{ date: string; product: string; count: number }>> {
  const table = await source.getTable(profile.tables.roi);
  const targets = [profile.storeAggregateLabel, ...(
    profile.tiktok.autoEnrollNewProducts
      ? [...new Set(Object.values((await loadProductCatalogMap(profile)).products))]
      : profile.tiktok.includedCanonicalProducts ?? []
  )];
  return targetDates.flatMap((date) => targets.map((product) => ({
    date,
    product,
    count: table.rows.filter((row) => rowDate(row.日期, profile.businessTimeZone) === date
      && cellText(row.商品) === product).length,
  })));
}

async function assertDailyIdle(tenantId: string): Promise<void> {
  const status = JSON.parse(await readFile(path.resolve(
    ".runtime", "tenants", tenantId, "daily-automation", "status.json",
  ), "utf8")) as { running?: boolean };
  if (status.running !== false) throw new Error(`${tenantId}日更仍在运行`);
}

function rowDate(value: unknown, timeZone: string): string {
  if (typeof value === "number") return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(value));
  return cellText(value).slice(0, 10);
}

function cellText(value: unknown): string {
  if (Array.isArray(value)) return value.map(cellText).join("").trim();
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return cellText(object.text ?? object.name ?? object.value ?? "");
  }
  return String(value ?? "").trim();
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
  return value || null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
