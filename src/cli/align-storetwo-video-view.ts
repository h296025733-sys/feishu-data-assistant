import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import { videoAnalysisConfig, type VideoAnalysisTenantId } from "../video-analysis/storeone-source.js";

const tenantFlag = process.argv.indexOf("--tenant");
const selectedTenant = tenantFlag < 0 ? "storetwo-formal" : process.argv[tenantFlag + 1];
if (selectedTenant !== "storetwo-formal" && selectedTenant !== "storetwo-botanical-care-formal") {
  throw new Error("View alignment supports Storetwo or Storetwo Botanical Care");
}
const tenantId: VideoAnalysisTenantId = selectedTenant;
const config = videoAnalysisConfig(tenantId);
const apply = process.argv.includes("--apply");
const confirmation = tenantId === "storetwo-formal" ? "--confirm=STORETWO-VIDEO-VIEW"
  : "--confirm=STORETWO-BOTANICAL-CARE-VIDEO-VIEW";
if (apply && !process.argv.includes(confirmation)) {
  throw new Error(`Apply requires ${confirmation}`);
}
const tenant = new TenantRegistry(getEnv()).byId(tenantId);
if (!tenant || tenant.env.FEISHU_BITABLE_APP_TOKEN !== config.appToken) {
  throw new Error(`${tenantId} formal Base mismatch`);
}
const client = createFeishuClient(tenant.env);
const tableId = config.tables.online;
const fieldResponse = await client.bitable.appTableField.list({
  path: { app_token: config.appToken, table_id: tableId },
  params: { page_size: 100 },
});
assertFeishuResponse(fieldResponse, "Read Storetwo online fields");
const fields = fieldResponse.data?.items ?? [];
const fieldId = (name: string) => fields.find((field) => field.field_name === name)?.field_id;
const hideIds = ["视频内容", "备注"].map((name) => {
  const id = fieldId(name);
  if (!id) throw new Error(`Missing ${name}`);
  return id;
});
for (const name of ["视频内容分析", "投广建议", "视频修改建议"]) {
  if (!fieldId(name)) throw new Error(`Missing new analysis field ${name}`);
}
const viewResponse = await client.bitable.appTableView.list({
  path: { app_token: config.appToken, table_id: tableId }, params: { page_size: 100 },
});
assertFeishuResponse(viewResponse, `Read ${tenantId} online views`);
const gridViews = (viewResponse.data?.items ?? []).filter((view) => view.view_name === "表格");
if (gridViews.length !== 1 || !gridViews[0]?.view_id) {
  throw new Error(`Expected exactly one 表格 view, got ${gridViews.length}`);
}
const viewId = gridViews[0].view_id;
async function readView() {
  const response = await client.bitable.appTableView.get({
    path: { app_token: config.appToken, table_id: tableId, view_id: viewId },
  });
  assertFeishuResponse(response, "Read Storetwo online view");
  if (response.data?.view?.view_name !== "表格") throw new Error("Target view changed");
  return response.data.view;
}
const before = await readView();
const previous = new Set(before.property?.hidden_fields ?? []);
const expected = new Set([...previous, ...hideIds]);
for (const name of ["视频内容分析", "投广建议", "视频修改建议"]) {
  if (expected.has(fieldId(name)!)) throw new Error(`New field ${name} is hidden`);
}
if (apply && hideIds.some((id) => !previous.has(id))) {
  const response = await client.bitable.appTableView.patch({
    path: { app_token: config.appToken, table_id: tableId, view_id: viewId },
    data: { view_name: "表格", property: { hidden_fields: [...expected] } },
  });
  assertFeishuResponse(response, "Hide old Storetwo columns without deletion");
}
const after = await readView();
const hidden = new Set(after.property?.hidden_fields ?? []);
const result = { at: new Date().toISOString(), mode: apply ? "formal-apply-readback" : "formal-read-only",
  tenantId, tableId, viewId, beforeHiddenCount: previous.size, afterHiddenCount: hidden.size,
  oldFieldsHidden: hideIds.every((id) => hidden.has(id)),
  newFieldsVisible: ["视频内容分析", "投广建议", "视频修改建议"].every((name) =>
    !hidden.has(fieldId(name)!)),
  filterUnchanged: JSON.stringify(before.property?.filter_info) === JSON.stringify(after.property?.filter_info),
  hierarchyUnchanged: JSON.stringify(before.property?.hierarchy_config) === JSON.stringify(after.property?.hierarchy_config),
};
console.log(JSON.stringify(result, null, 2));
if (apply && (!result.oldFieldsHidden || !result.newFieldsVisible
  || !result.filterUnchanged || !result.hierarchyUnchanged)) process.exitCode = 1;
