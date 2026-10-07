import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { createFeishuClient } from "../feishu/client.js";
import { StorefourDemoGateway } from "../feishu/storefour-demo-gateway.js";
import { dateKeyInTimeZone } from "../realtime/business-time.js";
import { syncOnlineVideoProductClicks } from "../automation/online-product-clicks.js";

const tenantId = process.argv.find((arg) => arg.startsWith("--tenant="))?.slice(9);
if (!tenantId || !["storetwo-formal", "storeone-formal", "storetwo-botanical-care-formal"].includes(tenantId)) {
  throw new Error("只允许三家商品点击量店铺");
}
const tenant = new TenantRegistry(getEnv()).byId(tenantId);
if (!tenant) throw new Error("店铺绑定不存在");
const client = createFeishuClient(tenant.env);
const gateway = new StorefourDemoGateway(tenant.env, client, tenant.profile);
await gateway.initializeOnlineReadOnly();
const tables = await client.bitable.appTable.list({ path: { app_token: tenant.env.FEISHU_BITABLE_APP_TOKEN }, params: { page_size: 100 } });
const tableId = tables.data?.items?.find((item) => item.name === tenant.profile.tables.online)?.table_id;
if (!tableId) throw new Error("上线表不存在");
const response = await client.bitable.appTableRecord.list({
  path: { app_token: tenant.env.FEISHU_BITABLE_APP_TOKEN, table_id: tableId }, params: { page_size: 500 },
});
if (response.code !== 0 || response.data?.has_more) throw new Error("上线表第一页读取失败或分页未完整");
const sample = response.data?.items?.find((row) => {
  const link = (row.fields?.视频上线地址 as { link?: string } | undefined)?.link ?? "";
  return /\/video\/\d{10,}/.test(link) && Number(row.fields?.["实上线日期(Ct)"]) > 0;
});
if (!sample) throw new Error("没有可核对视频");
const link = (sample.fields?.视频上线地址 as { link: string }).link;
const id = link.match(/\/video\/(\d{10,})/)?.[1];
if (!id) throw new Error("样本视频ID无效");
const date = dateKeyInTimeZone(new Date(Number(sample.fields?.["实上线日期(Ct)"])), tenant.profile.businessTimeZone);
const result = await syncOnlineVideoProductClicks({
  candidates: [{ video: { id, date }, endExclusive: "2026-09-27" }],
  profile: tenant.profile, env: tenant.env, client, gateway,
});
console.log(JSON.stringify({ tenantId, videoId: id, sourceEndExclusive: "2026-09-27", result }));
