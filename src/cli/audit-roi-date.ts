import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env) as any;
const appToken = env.FEISHU_BITABLE_APP_TOKEN;
const targetDate = process.argv[2] ?? "2026-07-31";
const targetMonth = targetDate.slice(0, 7);

if (!appToken) throw new Error("缺少 FEISHU_BITABLE_APP_TOKEN");

async function listAll<T>(
  request: (pageToken?: string) => Promise<any>,
): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const response = await request(pageToken);
    if (response.code && response.code !== 0) {
      throw new Error(`${response.code}: ${response.msg}`);
    }
    items.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more
      ? response.data?.page_token
      : undefined;
  } while (pageToken);
  return items;
}

function dateKey(value: unknown): string {
  if (typeof value !== "number") return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function textValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        typeof item === "object" && item && "text" in item
          ? String((item as { text: unknown }).text)
          : String(item),
      )
      .join("");
  }
  return value === null || value === undefined ? "" : String(value);
}

function numberValue(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sum(rows: any[], field: string): number {
  return rows.reduce(
    (total, row) => total + numberValue(row.fields?.[field]),
    0,
  );
}

function hasProduct(value: unknown, product: string): boolean {
  return Array.isArray(value)
    ? value.some((item) => textValue(item) === product)
    : textValue(value) === product;
}

const tables = await listAll<any>((pageToken) =>
  client.bitable.appTable.list({
    path: { app_token: appToken },
    params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
  }),
);
const byName = Object.fromEntries(
  tables.map((table) => [table.name, table.table_id]),
);
const roiTableId = byName["投产比"];
const coopTableId = byName["Tech-wave红人合作表"];
const onlineTableId = byName["Tech-wave红人上线表"];
if (!roiTableId || !coopTableId || !onlineTableId) {
  throw new Error("未找到投产比、合作表或上线表");
}

const listRecords = (tableId: string) =>
  listAll<any>((pageToken) =>
    client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: {
        page_size: 500,
        automatic_fields: true,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    }),
  );

const [roiRows, coopRows, onlineRows] = await Promise.all([
  listRecords(roiTableId),
  listRecords(coopTableId),
  listRecords(onlineTableId),
]);

const datedRows = roiRows.filter(
  (row) => dateKey(row.fields?.日期) === targetDate,
);
const productRows = datedRows.filter(
  (row) => textValue(row.fields?.商品) !== "TechWave",
);
const storeRows = datedRows.filter(
  (row) => textValue(row.fields?.商品) === "TechWave",
);
const duplicateKeys = Object.entries(
  datedRows.reduce<Record<string, number>>((counts, row) => {
    const key = `${textValue(row.fields?.商品)}|${dateKey(row.fields?.日期)}`;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {}),
).filter(([, count]) => count > 1);

const productDaily = productRows.map((row) => {
  const product = textValue(row.fields?.商品);
  const coopMatches = coopRows.filter(
    (item) =>
      dateKey(item.fields?.合作时间) === targetDate &&
      hasProduct(item.fields?.寄样产品, product),
  ).length;
  const onlineMatches = onlineRows.filter(
    (item) =>
      dateKey(item.fields?.["实上线日期(Ct)"]) === targetDate &&
      hasProduct(item.fields?.挂车产品, product),
  ).length;
  const expectedInfluencerOrders =
    numberValue(row.fields?.单量) - numberValue(row.fields?.商品卡出单量);
  const expectedInfluencerQuantity =
    numberValue(row.fields?.数量) - numberValue(row.fields?.商品卡出单数量);
  return {
    recordId: row.record_id,
    product,
    status: textValue(row.fields?.检查),
    cooperation: {
      actual: numberValue(row.fields?.合作量),
      expected: coopMatches,
    },
    online: {
      actual: numberValue(row.fields?.上线量),
      expected: onlineMatches,
    },
    orders: numberValue(row.fields?.单量),
    quantity: numberValue(row.fields?.数量),
    cardOrders: numberValue(row.fields?.商品卡出单量),
    cardQuantity: numberValue(row.fields?.商品卡出单数量),
    influencerOrders: {
      actual: numberValue(row.fields?.达人出单量),
      expected: expectedInfluencerOrders,
    },
    influencerQuantity: {
      actual: numberValue(row.fields?.达人出单数量),
      expected: expectedInfluencerQuantity,
    },
    sales: numberValue(row.fields?.销售额),
  };
});

const expectedStore = {
  cooperation: sum(productRows, "合作量源"),
  online: sum(productRows, "上线量源"),
  orders: sum(productRows, "单量"),
  quantity: sum(productRows, "数量"),
  influencerOrders: sum(productRows, "达人出单量源"),
  cardOrders: sum(productRows, "商品卡出单量"),
  sales: sum(productRows, "销售额"),
};
const storeDaily = storeRows.map((row) => ({
  recordId: row.record_id,
  status: textValue(row.fields?.检查),
  cooperation: numberValue(row.fields?.合作量),
  online: numberValue(row.fields?.上线量),
  totalOrders: numberValue(row.fields?.总单量),
  totalQuantity: numberValue(row.fields?.总数量),
  influencerOrders: numberValue(row.fields?.达人出单量),
  cardOrders: numberValue(row.fields?.店铺商品卡出单量),
  sales: numberValue(row.fields?.店铺销售额),
}));

const monthRows = roiRows.filter(
  (row) => textValue(row.fields?.月份) === targetMonth,
);
const monthProducts = [...new Set(
  monthRows.map((row) => textValue(row.fields?.商品)).filter(Boolean),
)].sort();
const monthly = monthProducts.map((product) => {
  const rows = monthRows.filter(
    (row) => textValue(row.fields?.商品) === product,
  );
  const store = product === "TechWave";
  return {
    product,
    rowCount: rows.length,
    cooperation: sum(rows, "合作量"),
    online: sum(rows, "上线量"),
    orders: sum(rows, store ? "总单量" : "单量"),
    quantity: sum(rows, store ? "总数量" : "数量"),
    influencerOrders: sum(rows, "达人出单量"),
    cardOrders: sum(rows, store ? "店铺商品卡出单量" : "商品卡出单量"),
    sales: sum(rows, store ? "店铺销售额" : "销售额"),
  };
});

const blankRows = roiRows
  .filter((row) => !dateKey(row.fields?.日期))
  .map((row) => {
    const nonEmptyManual = Object.entries(row.fields ?? {})
      .filter(([name]) => !["检查", "商品", "月份", "周", "星期"].includes(name))
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([name]) => name);
    return {
      recordId: row.record_id,
      product: textValue(row.fields?.商品),
      status: textValue(row.fields?.检查),
      nonEmptyManual,
    };
  });

const formulaErrors =
  JSON.stringify(roiRows).match(/#(?:ERROR|REF|VALUE|N\/A|DIV\/0)[^"]*/g) ?? [];
const dailyChecks = [
  ...productDaily.flatMap((row) => [
    row.cooperation.actual === row.cooperation.expected,
    row.online.actual === row.online.expected,
    row.influencerOrders.actual === row.influencerOrders.expected,
    row.influencerQuantity.actual === row.influencerQuantity.expected,
  ]),
  storeRows.length === 1,
  storeDaily[0]?.cooperation === expectedStore.cooperation,
  storeDaily[0]?.online === expectedStore.online,
  storeDaily[0]?.totalOrders === expectedStore.orders,
  storeDaily[0]?.totalQuantity === expectedStore.quantity,
  storeDaily[0]?.influencerOrders === expectedStore.influencerOrders,
  storeDaily[0]?.cardOrders === expectedStore.cardOrders,
  storeDaily[0]?.sales === expectedStore.sales,
];

console.log(JSON.stringify({
  ok:
    duplicateKeys.length === 0 &&
    formulaErrors.length === 0 &&
    dailyChecks.every(Boolean),
  targetDate,
  targetMonth,
  sourceTables: {
    cooperationRowsOnDate: coopRows.filter(
      (row) => dateKey(row.fields?.合作时间) === targetDate,
    ).length,
    onlineRowsOnDate: onlineRows.filter(
      (row) => dateKey(row.fields?.["实上线日期(Ct)"]) === targetDate,
    ).length,
  },
  productDaily,
  storeDaily,
  expectedStore,
  monthly,
  duplicateKeys,
  blankRows,
  formulaErrors,
}, null, 2));

if (!dailyChecks.every(Boolean) || duplicateKeys.length || formulaErrors.length) {
  process.exitCode = 1;
}
