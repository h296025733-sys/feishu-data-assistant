import { randomUUID } from "node:crypto";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import {
  ROI_FIELD_NAMES,
  ROI_RECORD_ROLES,
  TECHWAVE_PRODUCT_METRICS,
} from "../feishu/roi-pivot-plan.js";
import { RoiPivotSyncService } from "../feishu/roi-pivot-sync.js";

const TEST_PRODUCT = "__模板自动验收__";
const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env);
const appToken = env.FEISHU_BITABLE_APP_TOKEN;
if (!appToken) throw new Error("缺少 FEISHU_BITABLE_APP_TOKEN");

const tables = await client.bitable.appTable.list({
  path: { app_token: appToken },
  params: { page_size: 100 },
});
assertFeishuResponse(tables, "发现投产比表");
const matches = (tables.data?.items ?? [])
  .filter((table) => table.name === "投产比" && table.table_id);
if (matches.length !== 1) throw new Error(`应恰好发现一张投产比表，实际 ${matches.length} 张`);
const tableId = String(matches[0]?.table_id ?? "");

async function productRecords(): Promise<Array<{
  recordId: string;
  fields: Record<string, unknown>;
}>> {
  const result = [];
  let pageToken: string | undefined;
  do {
    const response = await client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 500, page_token: pageToken },
    });
    assertFeishuResponse(response, "读取模板验收记录");
    for (const item of response.data?.items ?? []) {
      if (String(item.fields?.[ROI_FIELD_NAMES.product] ?? "") !== TEST_PRODUCT) continue;
      result.push({
        recordId: String(item.record_id ?? ""),
        fields: item.fields ?? {},
      });
    }
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return result;
}

async function cleanup(): Promise<number> {
  const records = await productRecords();
  if (records.length === 0) return 0;
  const response = await (client.bitable.appTableRecord as any).batchDelete({
    path: { app_token: appToken, table_id: tableId },
    params: { client_token: randomUUID() },
    data: { records: records.map((record) => record.recordId) },
  });
  assertFeishuResponse(response, "清理模板验收记录");
  return records.length;
}

await cleanup();
const create = await (client.bitable.appTableRecord as any).create({
  path: { app_token: appToken, table_id: tableId },
  params: { client_token: randomUUID() },
  data: { fields: { [ROI_FIELD_NAMES.product]: TEST_PRODUCT } },
});
assertFeishuResponse(create, "创建只含商品名的验收记录");

const service = new RoiPivotSyncService(env, client);
let createdBlock: Array<{ recordId: string; fields: Record<string, unknown> }> = [];
try {
  await service.syncNow("product_template_acceptance");
  createdBlock = await productRecords();
  const templates = createdBlock
    .filter((record) => (
      record.fields[ROI_FIELD_NAMES.recordRole] === ROI_RECORD_ROLES.inputTemplate
    ))
    .map((record) => String(record.fields[ROI_FIELD_NAMES.metric] ?? ""));
  if (templates.length !== TECHWAVE_PRODUCT_METRICS.length) {
    throw new Error(`商品模板应为 12 行，实际 ${templates.length} 行`);
  }
  for (const metric of TECHWAVE_PRODUCT_METRICS) {
    if (templates.filter((value) => value === metric).length !== 1) {
      throw new Error(`固定指标“${metric}”未恰好出现一次`);
    }
  }
} finally {
  const deleted = await cleanup();
  await service.syncNow("product_template_acceptance_cleanup");
  const remaining = await productRecords();
  if (remaining.length > 0) throw new Error(`临时验收商品仍残留 ${remaining.length} 条记录`);
  console.log(JSON.stringify({
    verified: true,
    productNameOnly: true,
    fixedTemplates: TECHWAVE_PRODUCT_METRICS.length,
    totalGeneratedRecords: createdBlock.length,
    deleted,
    remaining: remaining.length,
  }, null, 2));
}
