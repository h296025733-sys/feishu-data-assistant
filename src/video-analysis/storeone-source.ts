import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";
import { buildStoreVideoInventory, STOREONE_VIDEO_ANALYSIS_BASE, STOREONE_VIDEO_TABLES,
  STORETWO_VIDEO_ANALYSIS_BASE, STORETWO_VIDEO_TABLES, type StoreVideoTables,
  STORETWO_BOTANICAL_CARE_VIDEO_ANALYSIS_BASE, STORETWO_BOTANICAL_CARE_VIDEO_TABLES,
  type VideoInventoryRecord } from "./storeone-inventory.js";

const STORE_CONFIG = {
  "storeone-formal": { appToken: STOREONE_VIDEO_ANALYSIS_BASE, tables: STOREONE_VIDEO_TABLES },
  "storetwo-formal": { appToken: STORETWO_VIDEO_ANALYSIS_BASE, tables: STORETWO_VIDEO_TABLES },
  "storethree-formal": { appToken: "demo_084c0ed0",
    tables: { online: "demo_0dd072ec", account: "demo_d6032589" } },
  "storetwo-llc-formal": { appToken: "demo_55251eae",
    tables: { online: "demo_d80bbb83", account: "demo_89d5cd64" } },
  "storetwo-botanical-care-formal": {
    appToken: STORETWO_BOTANICAL_CARE_VIDEO_ANALYSIS_BASE,
    tables: STORETWO_BOTANICAL_CARE_VIDEO_TABLES,
  },
} as const;
export type VideoAnalysisTenantId = keyof typeof STORE_CONFIG;

export function videoAnalysisConfig(tenantId: VideoAnalysisTenantId): {
  appToken: string; tables: StoreVideoTables;
} {
  return STORE_CONFIG[tenantId];
}

export async function loadLiveStoreVideoInventory(tenantId: VideoAnalysisTenantId) {
  const config = videoAnalysisConfig(tenantId);
  const tenant = new TenantRegistry(getEnv()).byId(tenantId);
  if (!tenant || tenant.env.FEISHU_BITABLE_APP_TOKEN !== config.appToken) {
    throw new Error(`${tenantId} formal tenant/base binding changed`);
  }
  const client = createFeishuClient(tenant.env);
  const tables: Record<string, VideoInventoryRecord[]> = {};
  for (const tableId of Object.values(config.tables)) {
    const rows: VideoInventoryRecord[] = [];
    let pageToken: string | undefined;
    const seen = new Set<string>();
    do {
      const result = await client.bitable.appTableRecord.list({
        path: { app_token: config.appToken, table_id: tableId },
        params: { page_size: 500, page_token: pageToken },
      });
      if (result.code !== 0) throw new Error(`${tenantId} video inventory API ${result.code}: ${result.msg}`);
      rows.push(...(result.data?.items ?? []) as VideoInventoryRecord[]);
      if (!result.data?.has_more) break;
      pageToken = result.data.page_token;
      if (!pageToken || seen.has(pageToken)) throw new Error(`${tenantId} video inventory pagination loop`);
      seen.add(pageToken);
    } while (true);
    tables[tableId] = rows;
  }
  return { client, tables, inventory: buildStoreVideoInventory(tables, config.tables) };
}

export const loadLiveStoreoneVideoInventory = () => loadLiveStoreVideoInventory("storeone-formal");
