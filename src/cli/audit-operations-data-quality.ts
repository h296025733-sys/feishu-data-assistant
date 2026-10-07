import { getEnv } from "../config/env.js";
import { TenantRegistry, type ResolvedTenant } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import { StorefourDemoGateway } from "../feishu/storefour-demo-gateway.js";

const F = {
  orders: "\u5355\u91cf",
  quantity: "\u6570\u91cf",
  allianceVideoOrders: "\u8054\u76df\u8fbe\u4eba\u89c6\u9891\u51fa\u5355\u91cf",
  allianceVideoQuantity: "\u8054\u76df\u8fbe\u4eba\u89c6\u9891\u51fa\u5355\u6570\u91cf",
  allianceLiveOrders: "\u8054\u76df\u8fbe\u4eba\u76f4\u64ad\u51fa\u5355\u91cf",
  allianceLiveQuantity: "\u8054\u76df\u8fbe\u4eba\u76f4\u64ad\u51fa\u5355\u6570\u91cf",
  selfVideoOrders: "\u81ea\u8425\u8fbe\u4eba\u89c6\u9891\u51fa\u5355\u91cf",
  selfVideoQuantity: "\u81ea\u8425\u8fbe\u4eba\u89c6\u9891\u51fa\u5355\u6570\u91cf",
  selfLiveOrders: "\u81ea\u8425\u8fbe\u4eba\u76f4\u64ad\u51fa\u5355\u91cf",
  selfLiveQuantity: "\u81ea\u8425\u8fbe\u4eba\u76f4\u64ad\u51fa\u5355\u6570\u91cf",
  cardOrders: "\u5546\u54c1\u5361\u51fa\u5355\u91cf",
  cardQuantity: "\u5546\u54c1\u5361\u51fa\u5355\u6570\u91cf",
  onlineCount: "\u4e0a\u7ebf\u91cf",
  actualOnlineDate: "\u5b9e\u4e0a\u7ebf\u65e5\u671f(Ct)",
  creator: "\u8fbe\u4eba\u59d3\u540d",
  product: "\u6302\u8f66\u4ea7\u54c1",
  videoUrl: "\u89c6\u9891\u4e0a\u7ebf\u5730\u5740",
  itemsSold: "\u552e\u51fa\u6570\u91cf",
  gmv: "\u9500\u552e\u989d",
} as const;

const tenantIds = valuesAfter("--tenant");
const startDate = argument("--start-date", "2026-08-01");
const registry = new TenantRegistry(getEnv());
const selected = tenantIds.length
  ? tenantIds.map((id) => registry.byId(id)).filter((tenant): tenant is ResolvedTenant => Boolean(tenant))
  : [registry.byId("storetwo-formal"), registry.byId("storeone-formal")]
    .filter((tenant): tenant is ResolvedTenant => Boolean(tenant));

for (const tenant of selected) {
  const client = createFeishuClient(tenant.env) as any;
  const gateway = new StorefourDemoGateway(tenant.env, client, tenant.profile);
  const products = tenant.profile.tiktok.includedCanonicalProducts ?? [];
  const roiRows: Array<Record<string, unknown>> = [];

  for (const product of products) {
    const records = await gateway.snapshotRoiProductRecords(product);
    for (const record of records.filter((item) => item.dateKey >= startDate)) {
      const fields = record.fields as Record<string, unknown>;
      roiRows.push({
        date: record.dateKey,
        product,
        total: pair(fields, F.orders, F.quantity),
        allianceVideo: pair(fields, F.allianceVideoOrders, F.allianceVideoQuantity),
        allianceLive: pair(fields, F.allianceLiveOrders, F.allianceLiveQuantity),
        selfVideo: pair(fields, F.selfVideoOrders, F.selfVideoQuantity),
        selfLive: pair(fields, F.selfLiveOrders, F.selfLiveQuantity),
        productCard: pair(fields, F.cardOrders, F.cardQuantity),
        onlineCount: finiteOrNull(fields[F.onlineCount]),
      });
    }
  }

  const appToken = tenant.env.FEISHU_BITABLE_APP_TOKEN;
  const tables = await listAllTables(client, appToken);
  const onlineTable = requireOneTable(tables, tenant.profile.tables.online);
  const roiTable = requireOneTable(tables, tenant.profile.tables.roi);
  const onlineRecords = await listAllRecords(client, appToken, onlineTable.table_id);
  const recentOnline = onlineRecords
    .map((record) => record.fields ?? {})
    .map((fields) => ({
      date: dateKey(fields[F.actualOnlineDate]),
      creator: textValue(fields[F.creator]),
      products: cellStrings(fields[F.product]),
      hasVideoUrl: Boolean(urlValue(fields[F.videoUrl])),
      itemsSold: finiteOrNull(fields[F.itemsSold]),
      gmv: finiteOrNull(fields[F.gmv]),
    }))
    .filter((row) => row.date >= startDate);

  const roiFields = await listAllFields(client, appToken, roiTable.table_id);
  const onlineMetric = roiFields.find((field) => field.field_name === F.onlineCount);

  console.log(JSON.stringify({
    tenantId: tenant.binding.id,
    shop: tenant.profile.businessDisplayName,
    startDate,
    includedProducts: products,
    roiRows: roiRows.sort((a, b) => String(a.date).localeCompare(String(b.date))),
    onlineTable: {
      tableId: onlineTable.table_id,
      totalRecords: onlineRecords.length,
      recentRecords: recentOnline.sort((a, b) => a.date.localeCompare(b.date)),
    },
    roiOnlineCountField: onlineMetric ? {
      fieldId: onlineMetric.field_id,
      type: onlineMetric.type,
      uiType: onlineMetric.ui_type,
      formula: onlineMetric.property?.formula_expression ?? null,
    } : null,
  }, null, 2));
}

function pair(fields: Record<string, unknown>, orderName: string, quantityName: string): Record<string, number | null> {
  return { orders: finiteOrNull(fields[orderName]), quantity: finiteOrNull(fields[quantityName]) };
}

async function listAllTables(client: any, appToken: string): Promise<any[]> {
  return listAll(async (pageToken) => {
    const response: any = await retry(() => client.bitable.appTable.list({
      path: { app_token: appToken },
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    }));
    assertFeishuResponse(response, "list tables for data-quality audit");
    return response;
  });
}

async function listAllFields(client: any, appToken: string, tableId: string): Promise<any[]> {
  return listAll(async (pageToken) => {
    const response: any = await retry(() => client.bitable.appTableField.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    }));
    assertFeishuResponse(response, "list fields for data-quality audit");
    return response;
  });
}

async function listAllRecords(client: any, appToken: string, tableId: string): Promise<any[]> {
  return listAll(async (pageToken) => {
    const response: any = await retry(() => client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 200, automatic_fields: true, ...(pageToken ? { page_token: pageToken } : {}) },
    }));
    assertFeishuResponse(response, "list records for data-quality audit");
    return response;
  });
}

async function listAll(fetchPage: (pageToken?: string) => Promise<any>): Promise<any[]> {
  const items: any[] = [];
  let pageToken: string | undefined;
  do {
    const response = await fetchPage(pageToken);
    items.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return items;
}

function requireOneTable(tables: any[], name: string): { table_id: string; name: string } {
  const matches = tables.filter((table) => table.name === name && table.table_id);
  if (matches.length !== 1) throw new Error(`Expected exactly one table named ${JSON.stringify(name)}, found ${matches.length}`);
  return { table_id: String(matches[0].table_id), name: String(matches[0].name) };
}

async function retry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { return await operation(); } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/1254607|429|5\d\d|Data not ready|ECONNRESET|socket hang up|ETIMEDOUT/i.test(message) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw lastError;
}

function finiteOrNull(value: unknown): number | null {
  const candidate = typeof value === "object" && value !== null && "value" in value
    ? (value as { value?: unknown }).value
    : value;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateKey(value: unknown): string {
  const candidate = finiteOrNull(value);
  if (candidate != null && candidate > 1_000_000_000) return new Date(candidate).toISOString().slice(0, 10);
  const text = textValue(value);
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? "";
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(", ");
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return String(object.text ?? object.name ?? object.value ?? "");
  }
  return value == null ? "" : String(value);
}

function urlValue(value: unknown): string {
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return String(object.link ?? object.url ?? object.text ?? "");
  }
  return textValue(value);
}

function cellStrings(value: unknown): string[] {
  return textValue(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function valuesAfter(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}
