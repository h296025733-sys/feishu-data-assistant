import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient, assertFeishuResponse } from "../feishu/client.js";

const APPLY = process.argv.includes("--apply");
const confirmationIndex = process.argv.indexOf("--confirm");
const CONFIRMATION = confirmationIndex >= 0 ? process.argv[confirmationIndex + 1] : "";
const REQUIRED_CONFIRMATION = "PREPARE-GENERIC-TEMPLATE";
const baseNameIndex = process.argv.indexOf("--base-name");
const BASE_NAME = baseNameIndex >= 0
  ? String(process.argv[baseNameIndex + 1] ?? "").trim()
  : "店铺经营工作台模板";
const AGGREGATE_FROM = "TechWave";
const AGGREGATE_TO = "店铺汇总";
const TABLES = [
  { aliases: ["Tech-wave红人开发表", "红人开发表"], target: "红人开发表" },
  { aliases: ["Tech-wave红人合作表", "红人合作表"], target: "红人合作表" },
  { aliases: ["Tech-wave红人上线表", "红人上线表"], target: "红人上线表" },
  { aliases: ["投产比"], target: "投产比" },
] as const;

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env);
const appToken = env.FEISHU_BITABLE_APP_TOKEN;

if (APPLY && CONFIRMATION !== REQUIRED_CONFIRMATION) {
  throw new Error(`正式执行必须同时提供 --confirm ${REQUIRED_CONFIRMATION}`);
}
if (!BASE_NAME) throw new Error("--base-name 不能为空");

const appBefore = await client.bitable.app.get({ path: { app_token: appToken } });
assertFeishuResponse(appBefore, "读取多维表格名称");
const listedTables = await listTables();
const targets = TABLES.map((definition) => {
  const matches = listedTables.filter((table) => definition.aliases.includes(table.name as never));
  if (matches.length !== 1 || !matches[0].table_id) {
    throw new Error(`无法唯一定位“${definition.target}”：找到 ${matches.length} 张候选表`);
  }
  return { ...definition, current: matches[0].name ?? definition.target, tableId: matches[0].table_id };
});

const snapshots = [];
for (const table of targets) {
  const [records, fields] = await Promise.all([listRecords(table.tableId), listFields(table.tableId)]);
  snapshots.push({
    ...table,
    recordIds: records.map((record) => String(record.record_id ?? "")).filter(Boolean),
    formulaFields: fields.filter((field) => (
      field.type === 20 && String(field.property?.formula_expression ?? "").includes(AGGREGATE_FROM)
    )),
  });
}
const roiSnapshot = snapshots.find((table) => table.target === "投产比")!;
const roiViews = await listViews(roiSnapshot.tableId);
const customView = roiViews.find((view) => view.view_name === "TechWave经营工作台");

const preview = {
  mode: APPLY ? "apply" : "dry-run",
  base: { current: appBefore.data?.app?.name ?? null, target: BASE_NAME },
  tables: snapshots.map((table) => ({
    tableId: table.tableId,
    currentName: table.current,
    targetName: table.target,
    recordsToDelete: table.recordIds.length,
    formulasToRewrite: table.formulaFields.length,
  })),
  totalRecordsToDelete: snapshots.reduce((sum, table) => sum + table.recordIds.length, 0),
  totalFormulasToRewrite: snapshots.reduce((sum, table) => sum + table.formulaFields.length, 0),
  manualCustomViewRename: customView ? { current: customView.view_name, target: "店铺经营工作台", reason: "飞书开放API不支持修改自定义插件视图名称" } : null,
};
console.log(JSON.stringify(preview, null, 2));
if (!APPLY) process.exit(0);

for (const table of snapshots) {
  for (const field of table.formulaFields) {
    const expression = String(field.property?.formula_expression ?? "").replaceAll(AGGREGATE_FROM, AGGREGATE_TO);
    const response = await client.bitable.appTableField.update({
      path: { app_token: appToken, table_id: table.tableId, field_id: field.field_id! },
      data: {
        field_name: field.field_name ?? "",
        type: 20,
        ui_type: "Formula",
        property: {
          formatter: field.property?.formatter ?? "",
          formula_expression: expression,
        },
      },
    });
    assertFeishuResponse(response, `改写公式“${field.field_name}”`);
  }
}

for (const table of snapshots) {
  if (table.current === table.target) continue;
  const response = await client.bitable.appTable.patch({
    path: { app_token: appToken, table_id: table.tableId },
    data: { name: table.target },
  });
  assertFeishuResponse(response, `重命名数据表“${table.current}”`);
}

const appUpdated = await client.bitable.app.update({
  path: { app_token: appToken },
  data: { name: BASE_NAME },
});
assertFeishuResponse(appUpdated, "重命名多维表格");

for (const table of snapshots) {
  for (let index = 0; index < table.recordIds.length; index += 500) {
    const records = table.recordIds.slice(index, index + 500);
    if (records.length === 0) continue;
    const response = await client.bitable.appTableRecord.batchDelete({
      path: { app_token: appToken, table_id: table.tableId },
      data: { records },
    });
    assertFeishuResponse(response, `清空“${table.target}”测试记录`);
  }
}

const [appAfter, tablesAfter] = await Promise.all([
  client.bitable.app.get({ path: { app_token: appToken } }),
  listTables(),
]);
assertFeishuResponse(appAfter, "复核多维表格名称");
if (appAfter.data?.app?.name !== BASE_NAME) throw new Error("多维表格名称写后复读不一致");

const verification = [];
for (const table of snapshots) {
  const current = tablesAfter.find((item) => item.table_id === table.tableId);
  if (current?.name !== table.target) throw new Error(`数据表“${table.target}”名称写后复读不一致`);
  const [records, fields] = await Promise.all([listRecords(table.tableId), listFields(table.tableId)]);
  const oldFormulas = fields.filter((field) => String(field.property?.formula_expression ?? "").includes(AGGREGATE_FROM));
  if (records.length !== 0) throw new Error(`数据表“${table.target}”仍有 ${records.length} 条记录`);
  if (oldFormulas.length !== 0) throw new Error(`数据表“${table.target}”仍有旧店铺名公式`);
  verification.push({ table: table.target, recordCount: records.length, oldFormulaCount: oldFormulas.length });
}
console.log(JSON.stringify({ ok: true, baseName: appAfter.data?.app?.name, verification }, null, 2));

async function listTables(): Promise<Array<{ table_id?: string; name?: string }>> {
  const items: Array<{ table_id?: string; name?: string }> = [];
  let pageToken: string | undefined;
  do {
    const response = await client.bitable.appTable.list({
      path: { app_token: appToken },
      params: { page_size: 100, page_token: pageToken },
    });
    assertFeishuResponse(response, "读取数据表清单");
    items.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return items;
}

async function listRecords(tableId: string): Promise<Array<{ record_id?: string }>> {
  const items: Array<{ record_id?: string }> = [];
  let pageToken: string | undefined;
  do {
    const response = await client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 500, page_token: pageToken },
    });
    assertFeishuResponse(response, "读取记录清单");
    items.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return items;
}

async function listFields(tableId: string): Promise<Array<{
  field_id?: string;
  field_name?: string;
  type?: number;
  property?: { formatter?: string; formula_expression?: string };
}>> {
  const items: Array<{
    field_id?: string;
    field_name?: string;
    type?: number;
    property?: { formatter?: string; formula_expression?: string };
  }> = [];
  let pageToken: string | undefined;
  do {
    const response = await client.bitable.appTableField.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100, page_token: pageToken },
    });
    assertFeishuResponse(response, "读取字段清单");
    items.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return items;
}

async function listViews(tableId: string): Promise<Array<{ view_id?: string; view_name?: string; view_type?: string }>> {
  const items: Array<{ view_id?: string; view_name?: string; view_type?: string }> = [];
  let pageToken: string | undefined;
  do {
    const response = await client.bitable.appTableView.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100, page_token: pageToken },
    });
    assertFeishuResponse(response, "读取投产比视图清单");
    items.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return items;
}
