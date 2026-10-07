import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

type Table = { table_id?: string; name?: string };
type Field = { field_id?: string; field_name?: string; type?: number };
type RecordItem = { record_id?: string; fields?: Record<string, unknown> };

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env) as any;
const appToken = env.FEISHU_BITABLE_APP_TOKEN;
const TABLE_NAME = "投产比";
const STAGING_NAME = "投产比_单表重构中";
const STORE = "TechWave";
const COOP_TABLE = "Tech-wave红人合作表";
const ONLINE_TABLE = "Tech-wave红人上线表";

function ok(response: any, action: string): void {
  if (response?.code && response.code !== 0) {
    throw new Error(`${action}失败（${response.code}）：${response.msg ?? "未知错误"}`);
  }
}

async function listTables(): Promise<Table[]> {
  const response = await client.bitable.appTable.list({
    path: { app_token: appToken },
    params: { page_size: 100 },
  });
  ok(response, "读取数据表");
  return response.data?.items ?? [];
}

async function listFields(tableId: string): Promise<Field[]> {
  const response = await client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: 100 },
  });
  ok(response, "读取字段");
  return response.data?.items ?? [];
}

async function listRecords(tableId: string): Promise<RecordItem[]> {
  const result: RecordItem[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 500, page_token: pageToken, automatic_fields: true },
    });
    ok(response, "读取记录");
    result.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return result;
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

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(text(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

const numberField = (field_name: string, formatter = "0") => ({
  field_name,
  type: 2,
  ui_type: "Number",
  property: { formatter },
});
const textField = (field_name: string) => ({ field_name, type: 1, ui_type: "Text" });

const fieldsInVisualOrder = [
  textField("商品"),
  {
    field_name: "日期",
    type: 5,
    ui_type: "DateTime",
    property: { date_formatter: "yyyy/MM/dd", auto_fill: false },
  },
  textField("月份"),
  textField("周"),
  textField("星期"),
  numberField("合作量"),
  numberField("上线量"),
  numberField("单量"),
  numberField("数量"),
  numberField("达人出单量"),
  numberField("达人出单数量"),
  numberField("商品卡出单量"),
  numberField("商品卡出单数量"),
  numberField("销售额", "0.00"),
  numberField("出单视频"),
  numberField("自孵化出单量"),
  numberField("自孵化上线量"),
  numberField("店铺浏览量"),
  numberField("总单量"),
  numberField("总数量"),
  numberField("店铺商品卡出单量"),
  numberField("店铺销售额", "0.00"),
  numberField("转化率", "0.00%"),
  numberField("总广告出单量"),
  numberField("总广告花费", "0.00"),
  numberField("雅岚广告花费", "0.00"),
  numberField("雅岚广告出单量"),
  numberField("金凯悦-10广告花费", "0.00"),
  numberField("金凯悦-10广告出单量"),
  numberField("金凯悦-11广告花费", "0.00"),
  numberField("金凯悦-11广告出单量"),
  numberField("GMV Max花费", "0.00"),
  numberField("GMV Max广告出单量"),
  numberField("退货量"),
  textField("备注"),
  textField("记录类型"),
  numberField("合作量源"),
  numberField("上线量源"),
  numberField("达人出单量源"),
  textField("排序键"),
] as const;

const manualNames = [
  "单量", "数量", "商品卡出单量", "商品卡出单数量", "销售额",
  "出单视频", "自孵化出单量", "自孵化上线量", "店铺浏览量",
  "雅岚广告花费", "雅岚广告出单量",
  "金凯悦-10广告花费", "金凯悦-10广告出单量",
  "金凯悦-11广告花费", "金凯悦-11广告出单量",
  "GMV Max花费", "GMV Max广告出单量", "退货量",
] as const;

function cloneRows(records: RecordItem[]): Array<{ fields: Record<string, unknown> }> {
  return records.map((record) => {
    const source = record.fields ?? {};
    const fields: Record<string, unknown> = {
      商品: text(source["商品"]),
      日期: timestamp(source["日期"]),
    };
    for (const name of manualNames) {
      const value = number(source[name]);
      if (value !== undefined) fields[name] = value;
    }
    const note = text(source["备注"]);
    if (note) fields["备注"] = note;
    return { fields };
  }).filter((row) => row.fields["商品"] && row.fields["日期"])
    .sort((a, b) => {
      const aStore = a.fields["商品"] === STORE ? 0 : 1;
      const bStore = b.fields["商品"] === STORE ? 0 : 1;
      return aStore - bStore
        || String(a.fields["商品"]).localeCompare(String(b.fields["商品"]), "zh-CN")
        || Number(b.fields["日期"]) - Number(a.fields["日期"]);
    });
}

function ids(fields: Field[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field.field_name, field.field_id]));
}

async function updateFormula(
  tableId: string,
  fieldIds: Record<string, string>,
  name: string,
  expression: string,
  formatter = "",
): Promise<void> {
  const response = await client.bitable.appTableField.update({
    path: { app_token: appToken, table_id: tableId, field_id: fieldIds[name] },
    data: {
      field_name: name,
      type: 20,
      ui_type: "Formula",
      property: { formatter, formula_expression: expression },
    },
  });
  ok(response, `更新公式“${name}”`);
}

async function installFormulas(
  tableId: string,
  coopTableId: string,
  onlineTableId: string,
): Promise<void> {
  const fieldIds = ids(await listFields(tableId));
  const ref = (name: string) => `bitable::$table[${tableId}].$field[${fieldIds[name]}]`;
  const table = `bitable::$table[${tableId}]`;
  const sameDate = `TEXT(CurrentValue.$column[${fieldIds["日期"]}],"YYYY-MM-DD")=TEXT(${ref("日期")},"YYYY-MM-DD")`;
  const productRows = `AND(CurrentValue.$column[${fieldIds["商品"]}]!="${STORE}",${sameDate})`;
  const sumProducts = (name: string) =>
    `SUM(${table}.FILTER(${productRows}).$column[${fieldIds[name]}])`;
  const sourceDefinitions = [
    { id: coopTableId, product: "寄样产品", date: "合作时间" },
    { id: onlineTableId, product: "挂车产品", date: "实上线日期(Ct)" },
  ];
  const sourceMaps: Record<string, Record<string, string>> = {};
  for (const source of sourceDefinitions) {
    sourceMaps[source.id] = ids(await listFields(source.id));
  }
  const countSource = (sourceId: string, product: string, date: string) => {
    const map = sourceMaps[sourceId];
    return `bitable::$table[${sourceId}].COUNTIF(AND(CurrentValue.$column[${map[product]}].CONTAIN(${ref("商品")}),TEXT(CurrentValue.$column[${map[date]}],"YYYY-MM-DD")=TEXT(${ref("日期")},"YYYY-MM-DD")))`;
  };
  const countSourceTotal = (sourceId: string, product: string, date: string) => {
    const map = sourceMaps[sourceId];
    return `bitable::$table[${sourceId}].COUNTIF(AND(CurrentValue.$column[${map[product]}]!="",TEXT(CurrentValue.$column[${map[date]}],"YYYY-MM-DD")=TEXT(${ref("日期")},"YYYY-MM-DD")))`;
  };
  const formulas: Array<[string, string, string?]> = [
    ["记录类型", `IF(${ref("商品")}="${STORE}","店铺","商品")`],
    ["月份", `IF(${ref("日期")}="","",TEXT(${ref("日期")},"YYYY-MM"))`],
    ["周", `IF(${ref("日期")}="","","第"&ROUNDUP(DATEDIF(DATE(2025,3,23),${ref("日期")},"D")/7,0)&"周")`],
    ["星期", `IF(${ref("日期")}="","",IF(WEEKDAY(${ref("日期")},2)=1,"星期一",IF(WEEKDAY(${ref("日期")},2)=2,"星期二",IF(WEEKDAY(${ref("日期")},2)=3,"星期三",IF(WEEKDAY(${ref("日期")},2)=4,"星期四",IF(WEEKDAY(${ref("日期")},2)=5,"星期五",IF(WEEKDAY(${ref("日期")},2)=6,"星期六","星期日")))))))`],
    ["合作量源", `IF(OR(${ref("商品")}="",${ref("日期")}="",${ref("商品")}="${STORE}"),"",${countSource(coopTableId, "寄样产品", "合作时间")})`, "0"],
    ["上线量源", `IF(OR(${ref("商品")}="",${ref("日期")}="",${ref("商品")}="${STORE}"),"",${countSource(onlineTableId, "挂车产品", "实上线日期(Ct)")})`, "0"],
    ["达人出单量源", `IF(${ref("商品")}="${STORE}","",IF(AND(${ref("单量")}="",${ref("商品卡出单量")}=""),"",IF(${ref("单量")}="",0,${ref("单量")})-IF(${ref("商品卡出单量")}="",0,${ref("商品卡出单量")})))`, "0"],
    ["合作量", `IF(${ref("商品")}="${STORE}",${countSourceTotal(coopTableId, "寄样产品", "合作时间")},${ref("合作量源")})`, "0"],
    ["上线量", `IF(${ref("商品")}="${STORE}",${countSourceTotal(onlineTableId, "挂车产品", "实上线日期(Ct)")},${ref("上线量源")})`, "0"],
    ["总单量", `IF(${ref("商品")}="${STORE}",${sumProducts("单量")},"")`, "0"],
    ["总数量", `IF(${ref("商品")}="${STORE}",${sumProducts("数量")},"")`, "0"],
    ["达人出单量", `IF(${ref("商品")}="${STORE}",${sumProducts("达人出单量源")},${ref("达人出单量源")})`, "0"],
    ["达人出单数量", `IF(${ref("商品")}="${STORE}","",IF(AND(${ref("数量")}="",${ref("商品卡出单数量")}=""),"",IF(${ref("数量")}="",0,${ref("数量")})-IF(${ref("商品卡出单数量")}="",0,${ref("商品卡出单数量")})))`, "0"],
    ["店铺商品卡出单量", `IF(${ref("商品")}="${STORE}",${sumProducts("商品卡出单量")},"")`, "0"],
    ["店铺销售额", `IF(${ref("商品")}="${STORE}",${sumProducts("销售额")},"")`, "0.00"],
    ["转化率", `IF(OR(${ref("商品")}!="${STORE}",${ref("店铺浏览量")}="",${ref("店铺浏览量")}=0),"",${ref("总单量")}/${ref("店铺浏览量")})`, "0.00%"],
    ["总广告出单量", `IF(${ref("商品")}!="${STORE}","",SUM(${ref("雅岚广告出单量")},${ref("金凯悦-10广告出单量")},${ref("金凯悦-11广告出单量")},${ref("GMV Max广告出单量")}))`, "0"],
    ["总广告花费", `IF(${ref("商品")}!="${STORE}","",SUM(${ref("雅岚广告花费")},${ref("金凯悦-10广告花费")},${ref("金凯悦-11广告花费")},${ref("GMV Max花费")}))`, "0.00"],
    ["排序键", `IF(${ref("商品")}="${STORE}","000000","100000"&${ref("商品")})`],
  ];
  for (const [name, expression, formatter] of formulas) {
    await updateFormula(tableId, fieldIds, name, expression, formatter);
  }
  for (const [name, expression, formatter] of formulas) {
    await updateFormula(tableId, fieldIds, name, expression, formatter);
  }
}

async function main(): Promise<void> {
  const tables = await listTables();
  const old = tables.find((table) => table.name === TABLE_NAME && table.table_id);
  const coop = tables.find((table) => table.name === COOP_TABLE && table.table_id);
  const online = tables.find((table) => table.name === ONLINE_TABLE && table.table_id);
  if (!old?.table_id || !coop?.table_id || !online?.table_id) {
    throw new Error("缺少投产比、红人合作表或红人上线表");
  }
  const stale = tables.find((table) => table.name === STAGING_NAME && table.table_id);
  if (stale?.table_id) {
    const deleted = await client.bitable.appTable.delete({
      path: { app_token: appToken, table_id: stale.table_id },
    });
    ok(deleted, "删除未完成的临时表");
  }
  const rows = cloneRows(await listRecords(old.table_id));
  const created = await client.bitable.appTable.create({
    path: { app_token: appToken },
    data: {
      table: {
        name: STAGING_NAME,
        default_view_name: "经营总览",
        fields: fieldsInVisualOrder,
      },
    },
  });
  ok(created, "创建单表重构");
  const newId = String(created.data?.table_id ?? "");
  if (!newId) throw new Error("未返回新表 ID");
  if (rows.length) {
    const inserted = await client.bitable.appTableRecord.batchCreate({
      path: { app_token: appToken, table_id: newId },
      data: { records: rows },
    });
    ok(inserted, "迁移人工数据");
  }
  await installFormulas(newId, coop.table_id, online.table_id);
  const formulaFields = (await listFields(newId)).filter((field) => field.type === 20);
  const finalRows = await listRecords(newId);
  if (finalRows.length !== rows.length || formulaFields.length !== 19) {
    throw new Error(`重构验证未通过：记录 ${finalRows.length}/${rows.length}，公式 ${formulaFields.length}/19`);
  }
  const renameOld = await client.bitable.appTable.patch({
    path: { app_token: appToken, table_id: old.table_id },
    data: { name: "投产比_待删除" },
  });
  ok(renameOld, "暂存旧表");
  const renameNew = await client.bitable.appTable.patch({
    path: { app_token: appToken, table_id: newId },
    data: { name: TABLE_NAME },
  });
  ok(renameNew, "启用新单表");
  const removeOld = await client.bitable.appTable.delete({
    path: { app_token: appToken, table_id: old.table_id },
  });
  ok(removeOld, "删除旧表");
  console.log(JSON.stringify({
    tableId: newId,
    records: finalRows.length,
    formulas: formulaFields.length,
  }, null, 2));
}

await main();
