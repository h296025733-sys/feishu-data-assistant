import { videoAnalysisConfig, loadLiveStoreVideoInventory,
  type VideoAnalysisTenantId } from "../video-analysis/storeone-source.js";

const flag = process.argv.indexOf("--tenant");
const tenantId = flag < 0 ? "storeone-formal" : process.argv[flag + 1];
if (tenantId !== "storeone-formal" && tenantId !== "storetwo-formal"
    && tenantId !== "storethree-formal" && tenantId !== "storetwo-llc-formal"
    && tenantId !== "storetwo-botanical-care-formal") {
  throw new Error("Unsupported video-analysis tenant");
}
const config = videoAnalysisConfig(tenantId as VideoAnalysisTenantId);
const { tables, inventory } = await loadLiveStoreVideoInventory(tenantId as VideoAnalysisTenantId);
console.log(JSON.stringify({
  at: new Date().toISOString(),
  tenantId,
  counts: {
    totalRows: inventory.totalRows,
    completeRows: inventory.completeRows,
    pending: inventory.pending.length,
    partial: inventory.partial.length,
    duplicates: inventory.duplicates.length,
    invalid: inventory.invalid.length,
    pendingWithoutProduct: inventory.pending.filter((item) => item.product == null
      || (typeof item.product === "string" && !item.product.trim())
      || (Array.isArray(item.product) && item.product.length === 0)).length,
  },
  byTable: Object.fromEntries(Object.values(config.tables).map((id) => [id, {
    rows: tables[id].length,
    pending: inventory.pending.filter((item) => item.tableId === id).length,
  }])),
  newestPending: inventory.pending.slice(0, 10).map(({ key, publishedAt }) => ({ key, publishedAt })),
  partial: inventory.partial,
  duplicates: inventory.duplicates,
  invalid: inventory.invalid.map(({ tableId, recordId, reason }) => {
    const fields = tables[tableId].find((row) => row.record_id === recordId)?.fields ?? {};
    const raw = fields[tableId === config.tables.online ? "视频上线地址" : "视频ID网址"];
    return { tableId, recordId, reason, rawVideoLink: raw,
      creator: fields[tableId === config.tables.online ? "达人姓名" : "达人昵称"] };
  }),
}, null, 2));
