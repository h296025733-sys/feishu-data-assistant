import { getEnv, requireFeishuEnv } from "../config/env.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";
import {
  ROI_RECORD_ROLES,
  ROI_FIELD_NAMES,
  TECHWAVE_PRODUCT_METRICS,
  TECHWAVE_STORE_METRICS,
  TECHWAVE_STORE_NAME,
  buildRoiPivotPlan,
  type RoiFormulaInput,
} from "../feishu/roi-pivot-plan.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env);
const appToken = env.FEISHU_BITABLE_APP_TOKEN;
if (!appToken) throw new Error("缺少 FEISHU_BITABLE_APP_TOKEN");

const tableResponse = await client.bitable.appTable.list({
  path: { app_token: appToken },
  params: { page_size: 100 },
});
assertFeishuResponse(tableResponse, "只读发现投产比数据表");
const matches = (tableResponse.data?.items ?? [])
  .filter((table) => table.name === "投产比" && table.table_id);
if (matches.length !== 1) {
  throw new Error(`应恰好发现一张“投产比”表，实际 ${matches.length} 张`);
}
const tableId = String(matches[0]?.table_id ?? "");
const records: Array<{ recordId: string; fields: Record<string, unknown> }> = [];
let pageToken: string | undefined;
do {
  const response = await client.bitable.appTableRecord.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: 500, page_token: pageToken },
  });
  assertFeishuResponse(response, "只读预览投产比记录");
  for (const item of response.data?.items ?? []) {
    const recordId = String(item.record_id ?? "");
    if (recordId) records.push({ recordId, fields: item.fields ?? {} });
  }
  pageToken = response.data?.has_more ? response.data.page_token : undefined;
} while (pageToken);

const text = (value: unknown): string => (
  typeof value === "string" ? value.trim() : String(value ?? "").trim()
);
function multiTexts(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((item) => multiTexts(item)).filter(Boolean))];
  }
  return text(value) ? [text(value)] : [];
}
const formulaInputs: RoiFormulaInput[] = [];
for (const table of tableResponse.data?.items ?? []) {
  const tableName = String(table.name ?? "");
  const sourceTableId = String(table.table_id ?? "");
  const kind = /^Tech-wave红人合作表$/i.test(tableName)
    ? "cooperation"
    : /^Tech-wave红人上线表(?:[_\s-]?\d+)?$/i.test(tableName)
      ? "online"
      : "";
  if (!kind || !sourceTableId) continue;
  let sourcePageToken: string | undefined;
  do {
    const response = await client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: sourceTableId },
      params: { page_size: 500, page_token: sourcePageToken },
    });
    assertFeishuResponse(response, `只读预览公式来源（${tableName}）`);
    for (const item of response.data?.items ?? []) {
      const fields = item.fields ?? {};
      const date = kind === "cooperation"
        ? fields["合作时间"]
        : fields["实上线日期(Ct)"] ?? fields["实上线日期"];
      const products = multiTexts(
        kind === "cooperation" ? fields["寄样产品"] : fields["挂车产品"],
      );
      if (!date) continue;
      for (const product of products) {
        formulaInputs.push({
          product,
          metric: kind === "cooperation" ? "合作量" : "上线量",
          date,
          value: 1,
        });
      }
    }
    sourcePageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (sourcePageToken);
}
const plan = buildRoiPivotPlan(records, Date.now(), formulaInputs);
const metricText = (fields: Record<string, unknown>): string => (
  text(fields[ROI_FIELD_NAMES.metric]) || text(fields[ROI_FIELD_NAMES.metricDisplay])
);
const roleCounts = Object.fromEntries(
  Object.values(ROI_RECORD_ROLES).map((role) => [
    role,
    records.filter((record) => text(record.fields["记录角色"]) === role).length,
  ]),
);
const products = [...new Set(
  records.map((record) => text(record.fields["产品"])).filter(Boolean),
)].sort((left, right) => (
  left === TECHWAVE_STORE_NAME ? -1
    : right === TECHWAVE_STORE_NAME ? 1
      : left.localeCompare(right, "zh-CN")
));
const templateCoverage = products.map((product) => {
  const expected = product === TECHWAVE_STORE_NAME
    ? TECHWAVE_STORE_METRICS
    : TECHWAVE_PRODUCT_METRICS;
  const productRecords = records.filter(
    (record) => text(record.fields["产品"]) === product,
  );
  const counts = new Map<string, number>();
  for (const record of records) {
    if (
      text(record.fields["产品"]) !== product
      || text(record.fields["记录角色"]) !== ROI_RECORD_ROLES.inputTemplate
      || record.fields["日期"]
      || (
        record.fields["数值"] !== undefined
        && record.fields["数值"] !== null
        && record.fields["数值"] !== ""
      )
    ) {
      continue;
    }
    const metric = metricText(record.fields);
    counts.set(metric, (counts.get(metric) ?? 0) + 1);
  }
  return {
    product,
    records: productRecords.length,
    manualInputs: productRecords
      .filter((record) => text(record.fields["记录角色"]) === ROI_RECORD_ROLES.manualInput)
      .map((record) => ({
        metric: metricText(record.fields),
        date: record.fields["日期"] ?? null,
        value: record.fields["数值"] ?? null,
      })),
    unownedRecords: productRecords
      .filter((record) => !text(record.fields["记录角色"]))
      .map((record) => ({
        recordId: record.recordId,
        metric: metricText(record.fields),
        date: record.fields["日期"] ?? null,
        value: record.fields["数值"] ?? null,
        fields: record.fields,
      })),
    expected: expected.length,
    complete: expected.every((metric) => counts.get(metric) === 1),
    missing: expected.filter((metric) => !counts.has(metric)),
    duplicateTemplates: [...counts]
      .filter(([, count]) => count > 1)
      .map(([metric, count]) => ({ metric, count })),
  };
});
const computedRoles = new Set<string>([
  ROI_RECORD_ROLES.productRollup,
  ROI_RECORD_ROLES.formula,
]);
const computedDaily = records
  .filter((record) => computedRoles.has(text(record.fields["记录角色"])))
  .map((record) => ({
    product: text(record.fields["产品"]),
    metric: metricText(record.fields),
    date: record.fields["日期"] ?? null,
    value: record.fields["数值"] ?? null,
    role: text(record.fields["记录角色"]),
  }));
const createRoles = Object.fromEntries(
  [...new Set(plan.creates.map((item) => String(item.fields["记录角色"] ?? "未分类")))]
    .sort()
    .map((role) => [
      role,
      plan.creates.filter((item) => String(item.fields["记录角色"] ?? "未分类") === role).length,
    ]),
);
console.log(JSON.stringify({
  readOnly: true,
  tableId,
  records: records.length,
  updates: plan.updates.length,
  creates: plan.creates.length,
  deletes: plan.deleteRecordIds.length,
  createRoles,
  roleCounts,
  templateCoverage,
  computedDaily,
  stats: plan.stats,
  formulaInputs: formulaInputs.length,
}, null, 2));
