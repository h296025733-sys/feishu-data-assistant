import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadLiveStoreVideoInventory, videoAnalysisConfig, type VideoAnalysisTenantId } from "../video-analysis/storeone-source.js";

const tenants: VideoAnalysisTenantId[] = ["storeone-formal", "storetwo-formal", "storethree-formal", "storetwo-llc-formal", "storetwo-botanical-care-formal"];
const result = [];
for (const tenant of tenants) {
  const { tables, inventory } = await loadLiveStoreVideoInventory(tenant);
  const config = videoAnalysisConfig(tenant);
  const gaps = inventory.invalid.map(gap => {
    const fields = tables[gap.tableId]!.find(row => row.record_id === gap.recordId)!.fields;
    const online = gap.tableId === config.tables.online;
    return { ...gap, sourceUrl: fields[online ? "视频上线地址" : "视频ID网址"] ?? null,
      videoId: fields["视频ID"] ?? null, creator: fields[online ? "达人姓名" : "达人昵称"] ?? null,
      product: fields[online ? "挂车产品" : "商品"] ?? null };
  });
  result.push({ tenant, gaps });
  console.log(JSON.stringify({ tenant, gaps }));
}
const root = path.resolve(".runtime/video-analysis-global/source-gaps");
await mkdir(root, { recursive: true });
const file = path.join(root, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(file, JSON.stringify({ at: new Date().toISOString(), result }, null, 2));
console.log(`evidence=${file}`);
