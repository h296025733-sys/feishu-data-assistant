import { getEnv, requireFeishuEnv } from "../config/env.js";
import { loadBusinessProfile } from "../config/business-profile.js";
import { createFeishuClient } from "../feishu/client.js";
import { assertFeishuResponse } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const profile = loadBusinessProfile();
const client = createFeishuClient(env);
const tableNames = [
  profile.tables.development,
  profile.tables.cooperation,
  profile.tables.online,
  profile.tables.roi,
];

const tables: Array<{ table_id?: string; name?: string }> = [];
let tablePageToken: string | undefined;
do {
  const response = await client.bitable.appTable.list({
    path: { app_token: env.FEISHU_BITABLE_APP_TOKEN },
    params: { page_size: 100, page_token: tablePageToken },
  });
  assertFeishuResponse(response, "读取四表清单");
  tables.push(...(response.data?.items ?? []));
  tablePageToken = response.data?.has_more ? response.data.page_token : undefined;
} while (tablePageToken);

const result = [];
for (const tableName of tableNames) {
  const table = tables.find((item) => item.name === tableName);
  if (!table?.table_id) throw new Error(`没有找到表“${tableName}”`);

  const fields: Array<Record<string, any>> = [];
  let fieldPageToken: string | undefined;
  do {
    const response = await client.bitable.appTableField.list({
      path: {
        app_token: env.FEISHU_BITABLE_APP_TOKEN,
        table_id: table.table_id,
      },
      params: { page_size: 100, page_token: fieldPageToken },
    });
    assertFeishuResponse(response, `读取字段（${tableName}）`);
    fields.push(...(response.data?.items ?? []));
    fieldPageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (fieldPageToken);

  const records: Array<Record<string, any>> = [];
  let recordPageToken: string | undefined;
  do {
    const response = await client.bitable.appTableRecord.list({
      path: {
        app_token: env.FEISHU_BITABLE_APP_TOKEN,
        table_id: table.table_id,
      },
      params: {
        page_size: 500,
        page_token: recordPageToken,
        automatic_fields: true,
      },
    });
    assertFeishuResponse(response, `读取记录（${tableName}）`);
    records.push(...(response.data?.items ?? []));
    recordPageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (recordPageToken);

  result.push({
    table: tableName,
    tableId: table.table_id,
    recordCount: records.length,
    fields: fields.map((field) => ({
      name: field.field_name,
      fieldId: field.field_id,
      type: field.type,
      uiType: field.ui_type,
      formula: field.property?.formula_expression ?? null,
      nonBlankRecords: records.filter((record) => {
        const value = record.fields?.[String(field.field_name ?? "")];
        if (value === null || value === undefined || value === "") return false;
        if (Array.isArray(value)) return value.length > 0;
        return true;
      }).length,
    })),
  });
}

console.log(JSON.stringify(result, null, 2));
