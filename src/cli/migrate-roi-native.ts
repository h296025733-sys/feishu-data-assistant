import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

type Table = { table_id?: string; name?: string };
type Field = {
  field_id?: string;
  field_name?: string;
  type?: number;
  is_primary?: boolean;
  property?: { formula_expression?: string };
};
type RecordItem = { record_id?: string; fields?: Record<string, unknown> };

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env) as any;
const appToken = env.FEISHU_BITABLE_APP_TOKEN;
const OLD_NAME = "投产比";
const NEW_NAME = "投产比_原生迁移中";
const STORE = "TechWave";
const COOP_TABLE = "Tech-wave红人合作表";
const ONLINE_TABLE = "Tech-wave红人上线表";

function ok(response: any, action: string): void {
  if (response?.code && response.code !== 0) {
    throw new Error(`${action}失败（${response.code}）：${response.msg ?? "未知错误"}`);
  }
}

async function listTables(): Promise<Table[]> {
  const result: Table[] = [];
  let page: string | undefined;
  do {
    const response = await client.bitable.appTable.list({
      path: { app_token: appToken },
      params: { page_size: 100, page_token: page },
    });
    ok(response, "读取数据表");
    result.push(...(response.data?.items ?? []));
    page = response.data?.has_more ? response.data.page_token : undefined;
  } while (page);
  return result;
}

async function listFields(tableId: string): Promise<Field[]> {
  const result: Field[] = [];
  let page: string | undefined;
  do {
    const response = await client.bitable.appTableField.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100, page_token: page },
    });
    ok(response, `读取字段 ${tableId}`);
    result.push(...(response.data?.items ?? []));
    page = response.data?.has_more ? response.data.page_token : undefined;
  } while (page);
  return result;
}

async function listRecords(tableId: string): Promise<RecordItem[]> {
  const result: RecordItem[] = [];
  let page: string | undefined;
  do {
    const response = await client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 500, page_token: page, automatic_fields: true },
    });
    ok(response, `读取记录 ${tableId}`);
    result.push(...(response.data?.items ?? []));
    page = response.data?.has_more ? response.data.page_token : undefined;
  } while (page);
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

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(text(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dateKey(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

const numberField = (name: string, formatter = "0") => ({
  field_name: name,
  type: 2,
  ui_type: "Number",
  property: { formatter },
});

const baseFields = [
  { field_name: "商品", type: 1, ui_type: "Text" },
  {
    field_name: "日期",
    type: 5,
    ui_type: "DateTime",
    property: { date_formatter: "yyyy/MM/dd", auto_fill: false },
  },
  numberField("单量"),
  numberField("数量"),
  numberField("商品卡出单量"),
  numberField("商品卡出单数量"),
  numberField("销售额", "0.00"),
  numberField("出单视频"),
  numberField("自孵化出单量"),
  numberField("自孵化上线量"),
  numberField("店铺浏览量"),
  numberField("雅岚广告花费", "0.00"),
  numberField("雅岚广告出单量"),
  numberField("金凯悦-10广告花费", "0.00"),
  numberField("金凯悦-10广告出单量"),
  numberField("金凯悦-11广告花费", "0.00"),
  numberField("金凯悦-11广告出单量"),
  numberField("GMV Max花费", "0.00"),
  numberField("GMV Max广告出单量"),
  numberField("退货量"),
  { field_name: "备注", type: 1, ui_type: "Text" },
] as const;

const productInput = new Set([
  "单量", "数量", "商品卡出单量", "商品卡出单数量", "销售额",
  "出单视频", "自孵化出单量", "自孵化上线量",
]);
const storeInput = new Set([
  "店铺浏览量", "出单视频", "雅岚广告花费", "雅岚广告出单量",
  "金凯悦-10广告花费", "金凯悦-10广告出单量",
  "金凯悦-11广告花费", "金凯悦-11广告出单量",
  "GMV Max花费", "GMV Max广告出单量", "退货量",
]);

function migrateRows(oldRecords: RecordItem[]): Array<{ fields: Record<string, unknown> }> {
  const rows = new Map<string, Record<string, unknown>>();
  for (const record of oldRecords) {
    const fields = record.fields ?? {};
    const product = text(fields["产品"]);
    const metric = text(fields["指标代码"]) || text(fields["指标"]);
    const date = timestamp(fields["日期"]);
    const value = numeric(fields["数值"]);
    const role = text(fields["记录角色"]);
    if (!product || !metric || !date || value === undefined) continue;
    if (role && role !== "明细输入") continue;
    if (product === STORE ? !storeInput.has(metric) : !productInput.has(metric)) continue;
    const key = `${product}\u0000${dateKey(date)}`;
    const row = rows.get(key) ?? { 商品: product, 日期: date };
    row[metric] = value;
    rows.set(key, row);
  }
  const dates = new Set([...rows.values()].map((row) => dateKey(Number(row["日期"]))));
  if (dates.size === 0) dates.add("2026-07-30");
  for (const key of dates) {
    const date = Date.parse(`${key}T00:00:00+08:00`);
    const id = `${STORE}\u0000${key}`;
    if (!rows.has(id)) rows.set(id, { 商品: STORE, 日期: date });
  }
  const hasProduct = [...rows.values()].some((row) => row["商品"] !== STORE);
  if (!hasProduct) {
    const date = Date.parse("2026-07-30T00:00:00+08:00");
    rows.set(`示例商品A\u00002026-07-30`, {
      商品: "示例商品A", 日期: date, 单量: 4, 数量: 5,
      商品卡出单量: 1, 商品卡出单数量: 1, 销售额: 100,
      备注: "公式迁移验证示例，可删除",
    });
    rows.set(`示例商品B\u00002026-07-30`, {
      商品: "示例商品B", 日期: date, 单量: 6, 数量: 7,
      商品卡出单量: 2, 商品卡出单数量: 2, 销售额: 200,
      备注: "公式迁移验证示例，可删除",
    });
    const storeKey = `${STORE}\u00002026-07-30`;
    if (!rows.has(storeKey)) rows.set(storeKey, { 商品: STORE, 日期: date });
  }
  return [...rows.values()]
    .sort((a, b) => String(a["商品"]).localeCompare(String(b["商品"]), "zh-CN")
      || Number(a["日期"]) - Number(b["日期"]))
    .map((fields) => ({ fields }));
}

function requireIds(fields: Field[]): Record<string, string> {
  return Object.fromEntries(
    fields.map((field) => [field.field_name, field.field_id]),
  ) as Record<string, string>;
}

async function createFormula(
  tableId: string,
  name: string,
  expression: string,
  formatter = "",
): Promise<void> {
  const response = await client.bitable.appTableField.create({
    path: { app_token: appToken, table_id: tableId },
    data: {
      field_name: name,
      type: 20,
      ui_type: "Formula",
      property: { formatter, formula_expression: expression },
    },
  });
  ok(response, `创建公式“${name}”`);
}

async function installFormulas(
  tableId: string,
  coop: { table_id: string },
  online: { table_id: string },
): Promise<void> {
  let ids = requireIds(await listFields(tableId));
  const ref = (name: string) => `bitable::$table[${tableId}].$field[${ids[name]}]`;
  const table = `bitable::$table[${tableId}]`;
  const sameDate = `TEXT(CurrentValue.$column[${ids["日期"]}],\"YYYY-MM-DD\")=TEXT(${ref("日期")},\"YYYY-MM-DD\")`;
  const productRows = `AND(CurrentValue.$column[${ids["商品"]}]!=\"${STORE}\",${sameDate})`;
  const sumProducts = (name: string) =>
    `SUM(${table}.FILTER(${productRows}).$column[${ids[name]}])`;

  await createFormula(tableId, "记录类型", `IF(${ref("商品")}=\"${STORE}\",\"店铺\",\"商品\")`);
  await createFormula(tableId, "月份", `IF(${ref("日期")}=\"\",\"\",TEXT(${ref("日期")},\"YYYY-MM\"))`);
  await createFormula(tableId, "周", `IF(${ref("日期")}=\"\",\"\",\"第\"&ROUNDUP(DATEDIF(DATE(2025,3,23),${ref("日期")},\"D\")/7,0)&\"周\")`);
  await createFormula(tableId, "星期", `IF(${ref("日期")}=\"\",\"\",WEEKDAY(${ref("日期")},2))`, "0");

  const sourceFields = new Map<string, Record<string, string>>();
  for (const source of [
    { id: coop.table_id, product: "寄样产品", date: "合作时间", key: "合作" },
    { id: online.table_id, product: "挂车产品", date: "实上线日期(Ct)", key: "上线" },
  ]) {
    const map = requireIds(await listFields(source.id));
    sourceFields.set(source.key, map);
  }
  const countSource = (sourceId: string, map: Record<string, string>, productName: string, dateName: string) =>
    `bitable::$table[${sourceId}].COUNTIF(AND(CurrentValue.$column[${map[productName]}].CONTAIN(${ref("商品")}),TEXT(CurrentValue.$column[${map[dateName]}],\"YYYY-MM-DD\")=TEXT(${ref("日期")},\"YYYY-MM-DD\")))`;
  await createFormula(
    tableId,
    "商品合作量（自动）",
    `IF(OR(${ref("商品")}=\"\",${ref("日期")}=\"\",${ref("商品")}=\"${STORE}\"),\"\",${countSource(coop.table_id, sourceFields.get("合作")!, "寄样产品", "合作时间")})`,
    "0",
  );
  await createFormula(
    tableId,
    "商品上线量（自动）",
    `IF(OR(${ref("商品")}=\"\",${ref("日期")}=\"\",${ref("商品")}=\"${STORE}\"),\"\",${countSource(online.table_id, sourceFields.get("上线")!, "挂车产品", "实上线日期(Ct)")})`,
    "0",
  );
  await createFormula(
    tableId,
    "商品达人出单量（自动）",
    `IF(${ref("商品")}=\"${STORE}\",\"\",IF(AND(${ref("单量")}=\"\",${ref("商品卡出单量")}=\"\"),\"\",IF(${ref("单量")}=\"\",0,${ref("单量")})-IF(${ref("商品卡出单量")}=\"\",0,${ref("商品卡出单量")})))`,
    "0",
  );
  ids = requireIds(await listFields(tableId));
  const ref2 = (name: string) => `bitable::$table[${tableId}].$field[${ids[name]}]`;
  const sameDate2 = `TEXT(CurrentValue.$column[${ids["日期"]}],\"YYYY-MM-DD\")=TEXT(${ref2("日期")},\"YYYY-MM-DD\")`;
  const productRows2 = `AND(CurrentValue.$column[${ids["商品"]}]!=\"${STORE}\",${sameDate2})`;
  const sumProducts2 = (name: string) =>
    `SUM(${table}.FILTER(${productRows2}).$column[${ids[name]}])`;
  const storeOrProduct = (helper: string) =>
    `IF(${ref2("商品")}=\"${STORE}\",${sumProducts2(helper)},${ref2(helper)})`;
  await createFormula(tableId, "合作量", storeOrProduct("商品合作量（自动）"), "0");
  await createFormula(tableId, "上线量", storeOrProduct("商品上线量（自动）"), "0");
  await createFormula(tableId, "总单量", `IF(${ref2("商品")}=\"${STORE}\",${sumProducts2("单量")},\"\")`, "0");
  await createFormula(tableId, "总数量", `IF(${ref2("商品")}=\"${STORE}\",${sumProducts2("数量")},\"\")`, "0");
  await createFormula(tableId, "达人出单量", storeOrProduct("商品达人出单量（自动）"), "0");
  await createFormula(tableId, "达人出单数量", `IF(${ref2("商品")}=\"${STORE}\",\"\",IF(AND(${ref2("数量")}=\"\",${ref2("商品卡出单数量")}=\"\"),\"\",IF(${ref2("数量")}=\"\",0,${ref2("数量")})-IF(${ref2("商品卡出单数量")}=\"\",0,${ref2("商品卡出单数量")})))`, "0");
  await createFormula(tableId, "店铺商品卡出单量", `IF(${ref2("商品")}=\"${STORE}\",${sumProducts2("商品卡出单量")},\"\")`, "0");
  await createFormula(tableId, "店铺销售额", `IF(${ref2("商品")}=\"${STORE}\",${sumProducts2("销售额")},\"\")`, "0.00");
  await createFormula(tableId, "转化率", `IF(OR(${ref2("商品")}!=\"${STORE}\",${ref2("店铺浏览量")}=\"\",${ref2("店铺浏览量")}=0),\"\",${ref2("总单量")}/${ref2("店铺浏览量")})`, "0.00%");
  await createFormula(tableId, "总广告出单量", `IF(${ref2("商品")}!=\"${STORE}\",\"\",SUM(${ref2("雅岚广告出单量")},${ref2("金凯悦-10广告出单量")},${ref2("金凯悦-11广告出单量")},${ref2("GMV Max广告出单量")}))`, "0");
  await createFormula(tableId, "总广告花费", `IF(${ref2("商品")}!=\"${STORE}\",\"\",SUM(${ref2("雅岚广告花费")},${ref2("金凯悦-10广告花费")},${ref2("金凯悦-11广告花费")},${ref2("GMV Max花费")}))`, "0.00");
}

async function main(): Promise<void> {
  const tables = await listTables();
  const old = tables.find((table) => table.name === OLD_NAME && table.table_id);
  const coop = tables.find((table) => table.name === COOP_TABLE && table.table_id);
  const online = tables.find((table) => table.name === ONLINE_TABLE && table.table_id);
  if (!old?.table_id || !coop?.table_id || !online?.table_id) {
    throw new Error("缺少投产比、红人合作表或红人上线表");
  }
  const stale = tables.find((table) => table.name === NEW_NAME && table.table_id);
  if (stale?.table_id) {
    const response = await client.bitable.appTable.delete({
      path: { app_token: appToken, table_id: stale.table_id },
    });
    ok(response, "删除上次未完成的迁移表");
  }
  const oldRecords = await listRecords(old.table_id);
  const rows = migrateRows(oldRecords);
  const create = await client.bitable.appTable.create({
    path: { app_token: appToken },
    data: {
      table: {
        name: NEW_NAME,
        default_view_name: "每日经营",
        fields: baseFields,
      },
    },
  });
  ok(create, "创建原生投产比表");
  const newId = String(create.data?.table_id ?? "");
  if (!newId) throw new Error("创建表后未返回 table_id");
  for (let offset = 0; offset < rows.length; offset += 500) {
    const response = await client.bitable.appTableRecord.batchCreate({
      path: { app_token: appToken, table_id: newId },
      data: { records: rows.slice(offset, offset + 500) },
    });
    ok(response, "迁移投产比人工数据");
  }
  await installFormulas(newId, { table_id: coop.table_id }, { table_id: online.table_id });
  const renameOld = await client.bitable.appTable.patch({
    path: { app_token: appToken, table_id: old.table_id },
    data: { name: "投产比_旧结构待删除" },
  });
  ok(renameOld, "临时重命名旧投产比");
  const renameNew = await client.bitable.appTable.patch({
    path: { app_token: appToken, table_id: newId },
    data: { name: OLD_NAME },
  });
  ok(renameNew, "启用原生投产比");
  const removeOld = await client.bitable.appTable.delete({
    path: { app_token: appToken, table_id: old.table_id },
  });
  ok(removeOld, "删除旧投产比结构");
  const finalRecords = await listRecords(newId);
  console.log(JSON.stringify({
    status: "migrated",
    tableId: newId,
    migratedRecords: rows.length,
    finalRecords: finalRecords.length,
    formulas: (await listFields(newId)).filter((field) => field.type === 20).length,
  }, null, 2));
}

await main();
