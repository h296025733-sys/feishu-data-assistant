import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

type Field = {
  field_id?: string;
  field_name?: string;
  type?: number;
  ui_type?: string;
  is_primary?: boolean;
  property?: {
    formatter?: string;
    formula_expression?: string;
  };
};

type RecordItem = {
  record_id?: string;
  fields?: Record<string, unknown>;
};

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env) as any;
const appToken = env.FEISHU_BITABLE_APP_TOKEN;
const TABLE_NAME = "投产比";
const OLD_PRODUCT = "商品";
const TEMP_PRODUCT = "商品分组";
const PRIMARY_LABEL = "记录日期";

function assertOk(response: any, action: string): void {
  if (response?.code && response.code !== 0) {
    throw new Error(`${action}失败（${response.code}）：${response.msg ?? "未知错误"}`);
  }
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(text).join("").trim();
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return text(item.text ?? item.name ?? item.value ?? "");
  }
  return value == null ? "" : String(value).trim();
}

async function listFields(tableId: string): Promise<Field[]> {
  const response = await client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: 100 },
  });
  assertOk(response, "读取字段");
  return response.data?.items ?? [];
}

async function listRecords(tableId: string): Promise<RecordItem[]> {
  const records: RecordItem[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: {
        page_size: 500,
        page_token: pageToken,
        automatic_fields: true,
      },
    });
    assertOk(response, "读取记录");
    records.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return records;
}

async function updateTextField(
  tableId: string,
  fieldId: string,
  fieldName: string,
): Promise<void> {
  const response = await client.bitable.appTableField.update({
    path: { app_token: appToken, table_id: tableId, field_id: fieldId },
    data: {
      field_name: fieldName,
      type: 1,
      ui_type: "Text",
    },
  });
  assertOk(response, `更新字段“${fieldName}”`);
}

async function main(): Promise<void> {
  const tables = await client.bitable.appTable.list({
    path: { app_token: appToken },
    params: { page_size: 100 },
  });
  assertOk(tables, "读取数据表");
  const table = (tables.data?.items ?? []).find((item: any) => item.name === TABLE_NAME);
  if (!table?.table_id) throw new Error(`未找到数据表“${TABLE_NAME}”`);
  const tableId = String(table.table_id);

  let fields = await listFields(tableId);
  const primary = fields.find((field) => field.is_primary);
  if (!primary?.field_id) throw new Error("未找到索引列");
  const primaryId = primary.field_id;
  if (primary.field_name === PRIMARY_LABEL) {
    console.log("索引列已经优化，无需重复执行");
    return;
  }
  if (primary.field_name !== OLD_PRODUCT) {
    throw new Error(`索引列不是“${OLD_PRODUCT}”，当前为“${primary.field_name}”`);
  }
  if (fields.some((field) => field.field_name === TEMP_PRODUCT)) {
    throw new Error(`已存在临时字段“${TEMP_PRODUCT}”，请先核对上次执行状态`);
  }

  const created = await client.bitable.appTableField.create({
    path: { app_token: appToken, table_id: tableId },
    data: {
      field_name: TEMP_PRODUCT,
      type: 1,
      ui_type: "Text",
    },
  });
  assertOk(created, `创建字段“${TEMP_PRODUCT}”`);
  const productFieldId = String(created.data?.field?.field_id ?? created.data?.field_id ?? "");
  if (!productFieldId) throw new Error("创建商品分组字段后未返回字段 ID");

  const records = await listRecords(tableId);
  const updates = records
    .filter((record) => record.record_id && text(record.fields?.[OLD_PRODUCT]))
    .map((record) => ({
      record_id: record.record_id,
      fields: {
        [TEMP_PRODUCT]: text(record.fields?.[OLD_PRODUCT]),
      },
    }));
  if (updates.length) {
    const copied = await client.bitable.appTableRecord.batchUpdate({
      path: { app_token: appToken, table_id: tableId },
      data: { records: updates },
    });
    assertOk(copied, "复制商品名称");
  }

  await updateTextField(tableId, primaryId, PRIMARY_LABEL);
  await updateTextField(tableId, productFieldId, OLD_PRODUCT);

  fields = await listFields(tableId);
  const date = fields.find((field) => field.field_name === "日期");
  const product = fields.find((field) => field.field_name === OLD_PRODUCT);
  if (!date?.field_id || !product?.field_id) {
    throw new Error("重命名后未找到日期或商品字段");
  }

  for (const field of fields.filter((item) => item.type === 20)) {
    const expression = field.property?.formula_expression;
    if (!field.field_id || !field.field_name || !expression) continue;
    const nextExpression = expression.split(primary.field_id).join(product.field_id);
    if (nextExpression === expression) continue;
    const response = await client.bitable.appTableField.update({
      path: {
        app_token: appToken,
        table_id: tableId,
        field_id: field.field_id,
      },
      data: {
        field_name: field.field_name,
        type: 20,
        ui_type: "Formula",
        property: {
          formatter: field.property?.formatter ?? "",
          formula_expression: nextExpression,
        },
      },
    });
    assertOk(response, `迁移公式“${field.field_name}”`);
  }

  const dateRef = `bitable::$table[${tableId}].$field[${date.field_id}]`;
  const primaryFormula = await client.bitable.appTableField.update({
    path: {
      app_token: appToken,
      table_id: tableId,
      field_id: primaryId,
    },
    data: {
      field_name: PRIMARY_LABEL,
      type: 20,
      ui_type: "Formula",
      property: {
        formatter: "",
        formula_expression: `IF(${dateRef}="","",TEXT(${dateRef},"YYYY/MM/DD"))`,
      },
    },
  });
  assertOk(primaryFormula, "把索引列改为记录日期公式");

  const viewList = await client.bitable.appTableView.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: 100 },
  });
  assertOk(viewList, "读取视图");

  const compactOverviewHidden = [
    "日期",
    "商品",
    "月份",
    "周",
    "达人出单数量",
    "商品卡出单数量",
    "出单视频",
    "自孵化出单量",
    "自孵化上线量",
    "雅岚广告花费",
    "雅岚广告出单量",
    "金凯悦-10广告花费",
    "金凯悦-10广告出单量",
    "金凯悦-11广告花费",
    "金凯悦-11广告出单量",
    "GMV Max花费",
    "GMV Max广告出单量",
    "备注",
  ];
  const compactByView: Record<string, string[]> = {
    经营总览: compactOverviewHidden,
    店铺每日: ["日期", "商品", "月份", "周"],
    商品每日: ["日期", "商品", "月份", "周"],
    月度汇总: ["日期", "商品"],
  };
  const latestFields = await listFields(tableId);
  const ids = Object.fromEntries(
    latestFields
      .filter((field) => field.field_name && field.field_id)
      .map((field) => [field.field_name as string, field.field_id as string]),
  );

  for (const view of viewList.data?.items ?? []) {
    if (!view.view_id || !view.view_name) continue;
    const detail = await client.bitable.appTableView.get({
      path: {
        app_token: appToken,
        table_id: tableId,
        view_id: view.view_id,
      },
    });
    assertOk(detail, `读取视图“${view.view_name}”`);
    const property = detail.data?.view?.property ?? {};
    const hidden = new Set<string>(property.hidden_fields ?? []);
    for (const name of compactByView[view.view_name] ?? []) {
      if (ids[name]) hidden.add(ids[name]);
    }
    const filter = property.filter_info
      ? {
          ...property.filter_info,
          conditions: (property.filter_info.conditions ?? []).map((condition: any) =>
            condition.field_id === primaryId
              ? { ...condition, field_id: product.field_id, field_type: 1 }
              : condition
          ),
        }
      : undefined;
    const patched = await client.bitable.appTableView.patch({
      path: {
        app_token: appToken,
        table_id: tableId,
        view_id: view.view_id,
      },
      data: {
        view_name: view.view_name,
        property: {
          hidden_fields: [...hidden],
          ...(filter ? { filter_info: filter } : {}),
        },
      },
    });
    assertOk(patched, `优化视图“${view.view_name}”`);
  }

  const verifiedFields = await listFields(tableId);
  const verifiedPrimary = verifiedFields.find((field) => field.is_primary);
  const verifiedProduct = verifiedFields.find((field) => field.field_name === OLD_PRODUCT);
  const staleFormulas = verifiedFields.filter((field) =>
    field.type === 20
    && field.field_id !== primaryId
    && field.property?.formula_expression?.includes(primaryId)
  );
  const verifiedRecords = await listRecords(tableId);
  const missingProducts = verifiedRecords.filter((record) => !text(record.fields?.[OLD_PRODUCT]));
  if (
    verifiedPrimary?.field_name !== PRIMARY_LABEL
    || verifiedPrimary.type !== 20
    || !verifiedProduct?.field_id
    || staleFormulas.length
    || missingProducts.length
  ) {
    throw new Error(JSON.stringify({
      primary: verifiedPrimary,
      product: verifiedProduct,
      staleFormulas: staleFormulas.map((field) => field.field_name),
      missingProducts: missingProducts.map((record) => record.record_id),
    }));
  }

  console.log(JSON.stringify({
    tableId,
    records: verifiedRecords.length,
    primary: {
      id: verifiedPrimary.field_id,
      name: verifiedPrimary.field_name,
      type: verifiedPrimary.type,
    },
    product: {
      id: verifiedProduct.field_id,
      name: verifiedProduct.field_name,
      type: verifiedProduct.type,
    },
    formulaReferencesMigrated: true,
    filtersMigrated: true,
    remainingUiActions: [
      "经营总览：分组改为商品",
      "商品每日：分组改为商品",
      "月度汇总：第一层分组改为商品，第二层保留月份",
      "经营总览和月度汇总：TechWave 浅蓝填色条件字段改为商品",
    ],
  }, null, 2));
}

await main();
