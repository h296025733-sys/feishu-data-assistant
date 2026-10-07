import { getEnv, requireFeishuEnv } from "../config/env.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env);
const appToken = env.FEISHU_BITABLE_APP_TOKEN;
if (!appToken) throw new Error("缺少 FEISHU_BITABLE_APP_TOKEN");

interface TableItem { table_id?: string; name?: string }
interface FieldItem {
  field_id?: string;
  field_name?: string;
  type?: number;
  ui_type?: string;
  is_primary?: boolean;
  property?: unknown;
}

const tables: TableItem[] = [];
let tablePageToken: string | undefined;
do {
  const response = await client.bitable.appTable.list({
    path: { app_token: appToken },
    params: { page_size: 100, page_token: tablePageToken },
  });
  assertFeishuResponse(response, "只读发现数据表");
  tables.push(...(response.data?.items ?? []));
  tablePageToken = response.data?.has_more ? response.data.page_token : undefined;
} while (tablePageToken);

const selected = tables.filter((table) => (
  table.table_id
  && (
    table.name === "投产比"
    || /Tech-wave红人合作表/i.test(String(table.name ?? ""))
    || /Tech-wave红人上线表/i.test(String(table.name ?? ""))
  )
));

const result = [];
for (const table of selected) {
  const tableId = String(table.table_id);
  const fields: FieldItem[] = [];
  let fieldPageToken: string | undefined;
  do {
    const response = await client.bitable.appTableField.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100, page_token: fieldPageToken },
    });
    assertFeishuResponse(response, `只读读取字段（${table.name}）`);
    fields.push(...(response.data?.items ?? []));
    fieldPageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (fieldPageToken);

  const samples: Array<{ recordId: string; fields: Record<string, unknown> }> = [];
  const records = await client.bitable.appTableRecord.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: 10 },
  });
  assertFeishuResponse(records, `只读读取样例（${table.name}）`);
  for (const item of records.data?.items ?? []) {
    const relevantNames = table.name === "投产比"
      ? ["产品", "指标", "指标代码", "数值", "日期", "周期类型", "记录角色"]
      : /合作表/.test(String(table.name ?? ""))
        ? ["合作时间", "寄样产品", "红人姓名"]
        : ["实上线日期(Ct)", "挂车产品", "达人姓名"];
    samples.push({
      recordId: String(item.record_id ?? ""),
      fields: Object.fromEntries(
        Object.entries(item.fields ?? {}).filter(([name]) => relevantNames.includes(name)),
      ),
    });
  }

  result.push({
    tableId,
    name: table.name,
    fields: fields
      .filter((field) => (
        table.name === "投产比"
        || ["合作时间", "寄样产品", "实上线日期(Ct)", "挂车产品"].includes(
          String(field.field_name ?? ""),
        )
      ))
      .map((field) => ({
      fieldId: field.field_id,
      name: field.field_name,
      type: field.type,
      uiType: field.ui_type,
      isPrimary: field.is_primary,
      property: field.type === 20 || field.field_name === "指标" || field.field_name === "指标代码"
        ? field.property
        : undefined,
    })),
    samples,
  });
}

console.log(JSON.stringify({
  readOnly: true,
  tables: result,
}, null, 2));
