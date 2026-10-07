import { getEnv, requireFeishuEnv } from "../config/env.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

const TABLE_NAME = "Tech-wave红人上线表";
const FIELD_NAME = "实上线日期(Ct)";

interface TableItem {
  table_id?: string;
  name?: string;
}

interface FieldItem {
  field_id?: string;
  field_name?: string;
  type?: number;
  ui_type?: string;
  property?: {
    date_formatter?: string;
    auto_fill?: boolean;
    [key: string]: unknown;
  };
}

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env);
const appToken = env.FEISHU_BITABLE_APP_TOKEN;
if (!appToken) throw new Error("缺少 FEISHU_BITABLE_APP_TOKEN");

const tables: TableItem[] = [];
let tablePageToken: string | undefined;
do {
  const response = await client.bitable.appTable.list({
    path: { app_token: appToken },
    params: { page_size: 100, page_token: tablePageToken },
  });
  assertFeishuResponse(response, "读取数据表");
  tables.push(...(response.data?.items ?? []));
  tablePageToken = response.data?.has_more ? response.data.page_token : undefined;
} while (tablePageToken);

const table = tables.find((item) => item.name === TABLE_NAME && item.table_id);
if (!table?.table_id) throw new Error(`未找到数据表：${TABLE_NAME}`);

const listFields = async (): Promise<FieldItem[]> => {
  const fields: FieldItem[] = [];
  let fieldPageToken: string | undefined;
  do {
    const response = await client.bitable.appTableField.list({
      path: { app_token: appToken, table_id: table.table_id! },
      params: { page_size: 100, page_token: fieldPageToken },
    });
    assertFeishuResponse(response, `读取字段（${TABLE_NAME}）`);
    fields.push(...(response.data?.items ?? []));
    fieldPageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (fieldPageToken);
  return fields;
};

const beforeFields = await listFields();
const target = beforeFields.find((item) => item.field_name === FIELD_NAME && item.field_id);
if (!target?.field_id) throw new Error(`未找到字段：${TABLE_NAME}.${FIELD_NAME}`);
if (target.type !== 5) {
  throw new Error(
    `${TABLE_NAME}.${FIELD_NAME} 当前类型为 ${String(target.type)}，不是日期字段（5），已停止修改。`,
  );
}

const before = {
  fieldId: target.field_id,
  type: target.type,
  uiType: target.ui_type,
  property: target.property ?? null,
};

if (target.property?.auto_fill !== true) {
  const response = await client.bitable.appTableField.update({
    path: {
      app_token: appToken,
      table_id: table.table_id,
      field_id: target.field_id,
    },
    data: {
      field_name: FIELD_NAME,
      type: 5,
      property: {
        date_formatter: target.property?.date_formatter ?? "yyyy/MM/dd",
        auto_fill: true,
      },
    },
  });
  assertFeishuResponse(response, `开启${FIELD_NAME}新增记录自动填入创建日期`);
}

const afterFields = await listFields();
const verified = afterFields.find((item) => item.field_id === target.field_id);
if (
  !verified
  || verified.field_name !== FIELD_NAME
  || verified.type !== 5
  || verified.property?.auto_fill !== true
) {
  throw new Error("写后验证失败：上线日期字段未保持为原字段或 auto_fill 未生效。");
}

console.log(JSON.stringify({
  changedScope: `${TABLE_NAME}.${FIELD_NAME}`,
  before,
  after: {
    fieldId: verified.field_id,
    type: verified.type,
    uiType: verified.ui_type,
    property: verified.property ?? null,
  },
  note: "仅开启新记录自动填入创建日期；历史记录和其他数据表未修改。",
}, null, 2));
