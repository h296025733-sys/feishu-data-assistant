import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env) as any;
const appToken = env.FEISHU_BITABLE_APP_TOKEN;

const ROI_TABLE_ID = "demo_d17bebf1";
const COOP_TABLE_ID = "demo_9a2034c6";
const ONLINE_TABLE_ID = "demo_edeae836";
const TARGET_PRODUCT = "杯子";
const TARGET_DATE = "2026-07-23";
const TARGET_MONTH = "2026-07";

function assertOk(response: any, action: string): void {
  if (response?.code && response.code !== 0) {
    throw new Error(
      `${action}失败（${response.code}）：${response.msg ?? "未知错误"}`,
    );
  }
}

async function listAllRecords(tableId: string): Promise<any[]> {
  const items: any[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: {
        page_size: 500,
        automatic_fields: true,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    assertOk(response, `读取数据表 ${tableId}`);
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

function numberValue(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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

function sum(rows: any[], field: string): number {
  return rows.reduce(
    (total, row) => total + numberValue(row.fields?.[field]),
    0,
  );
}

function hasSelectValue(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.some((item) => item === expected);
}

function closeEnough(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < 0.000001;
}

function check(
  checks: Array<{ name: string; actual: unknown; expected: unknown; ok: boolean }>,
  name: string,
  actual: unknown,
  expected: unknown,
): void {
  const normalizedActual =
    Array.isArray(actual) ? textValue(actual) : actual;
  const ok =
    typeof normalizedActual === "number" && typeof expected === "number"
      ? closeEnough(normalizedActual, expected)
      : normalizedActual === expected;
  checks.push({ name, actual: normalizedActual, expected, ok });
}

const [roiRecords, coopRecords, onlineRecords] = await Promise.all([
  listAllRecords(ROI_TABLE_ID),
  listAllRecords(COOP_TABLE_ID),
  listAllRecords(ONLINE_TABLE_ID),
]);

const productRows = roiRecords.filter(
  (row) =>
    row.fields?.商品 === TARGET_PRODUCT &&
    dateKey(row.fields?.日期) === TARGET_DATE,
);
const storeRows = roiRecords.filter(
  (row) =>
    row.fields?.商品 === "TechWave" &&
    dateKey(row.fields?.日期) === TARGET_DATE,
);
const allProductsOnDate = roiRecords.filter(
  (row) =>
    row.fields?.商品 &&
    row.fields?.商品 !== "TechWave" &&
    dateKey(row.fields?.日期) === TARGET_DATE,
);
const coopMatches = coopRecords.filter(
  (row) =>
    dateKey(row.fields?.合作时间) === TARGET_DATE &&
    hasSelectValue(row.fields?.寄样产品, TARGET_PRODUCT),
);
const onlineMatches = onlineRecords.filter(
  (row) =>
    dateKey(row.fields?.["实上线日期(Ct)"]) === TARGET_DATE &&
    hasSelectValue(row.fields?.挂车产品, TARGET_PRODUCT),
);

if (productRows.length !== 1 || storeRows.length !== 1) {
  console.log(
    JSON.stringify(
      {
        ok: false,
        blocker: "目标日期的商品或店铺记录数量不是 1",
        productRows: productRows.length,
        storeRows: storeRows.length,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} else {
  const product = productRows[0];
  const store = storeRows[0];
  const checks: Array<{
    name: string;
    actual: unknown;
    expected: unknown;
    ok: boolean;
  }> = [];

  check(checks, "杯子月份", product.fields?.月份, TARGET_MONTH);
  check(checks, "杯子周", product.fields?.周, "第70周");
  check(checks, "杯子星期", product.fields?.星期, "星期四");
  check(checks, "杯子合作量", numberValue(product.fields?.合作量), coopMatches.length);
  check(checks, "杯子上线量", numberValue(product.fields?.上线量), onlineMatches.length);
  check(
    checks,
    "杯子达人出单量",
    numberValue(product.fields?.达人出单量),
    numberValue(product.fields?.单量) -
      numberValue(product.fields?.商品卡出单量),
  );
  check(
    checks,
    "杯子达人出单数量",
    numberValue(product.fields?.达人出单数量),
    numberValue(product.fields?.数量) -
      numberValue(product.fields?.商品卡出单数量),
  );

  check(checks, "TechWave合作量", numberValue(store.fields?.合作量), sum(allProductsOnDate, "合作量源"));
  check(checks, "TechWave上线量", numberValue(store.fields?.上线量), sum(allProductsOnDate, "上线量源"));
  check(checks, "TechWave总单量", numberValue(store.fields?.总单量), sum(allProductsOnDate, "单量"));
  check(checks, "TechWave总数量", numberValue(store.fields?.总数量), sum(allProductsOnDate, "数量"));
  check(
    checks,
    "TechWave达人出单量",
    numberValue(store.fields?.达人出单量),
    sum(allProductsOnDate, "达人出单量源"),
  );
  check(
    checks,
    "TechWave商品卡出单量",
    numberValue(store.fields?.店铺商品卡出单量),
    sum(allProductsOnDate, "商品卡出单量"),
  );
  check(
    checks,
    "TechWave销售额",
    numberValue(store.fields?.店铺销售额),
    sum(allProductsOnDate, "销售额"),
  );

  const expectedConversion =
    numberValue(store.fields?.店铺浏览量) === 0
      ? 0
      : numberValue(store.fields?.总单量) /
        numberValue(store.fields?.店铺浏览量);
  check(
    checks,
    "TechWave转化率",
    numberValue(store.fields?.转化率),
    expectedConversion,
  );
  check(
    checks,
    "TechWave总广告花费",
    numberValue(store.fields?.总广告花费),
    numberValue(store.fields?.雅岚广告花费) +
      numberValue(store.fields?.["金凯悦-10广告花费"]) +
      numberValue(store.fields?.["金凯悦-11广告花费"]) +
      numberValue(store.fields?.["GMV Max花费"]),
  );
  check(
    checks,
    "TechWave总广告出单量",
    numberValue(store.fields?.总广告出单量),
    numberValue(store.fields?.雅岚广告出单量) +
      numberValue(store.fields?.["金凯悦-10广告出单量"]) +
      numberValue(store.fields?.["金凯悦-11广告出单量"]) +
      numberValue(store.fields?.["GMV Max广告出单量"]),
  );

  const cupMonthRows = roiRecords.filter(
    (row) =>
      row.fields?.商品 === TARGET_PRODUCT &&
      textValue(row.fields?.月份) === TARGET_MONTH,
  );
  const storeMonthRows = roiRecords.filter(
    (row) =>
      row.fields?.商品 === "TechWave" &&
      textValue(row.fields?.月份) === TARGET_MONTH,
  );
  const formulaErrors =
    JSON.stringify([...productRows, ...storeRows]).match(
      /#(?:ERROR|REF|VALUE|N\/A|DIV\/0)[^"]*/g,
    ) ?? [];

  console.log(
    JSON.stringify(
      {
        ok: checks.every((item) => item.ok) && formulaErrors.length === 0,
        target: {
          product: TARGET_PRODUCT,
          date: TARGET_DATE,
          productRecordId: product.record_id,
          storeRecordId: store.record_id,
        },
        sourceMatches: {
          cooperation: coopMatches.length,
          online: onlineMatches.length,
        },
        actualInputs: {
          cup: {
            检查: textValue(product.fields?.检查),
            单量: product.fields?.单量,
            数量: product.fields?.数量,
            商品卡出单量: product.fields?.商品卡出单量,
            商品卡出单数量: product.fields?.商品卡出单数量,
            销售额: product.fields?.销售额,
            出单视频: product.fields?.出单视频,
            自孵化出单量: product.fields?.自孵化出单量,
            自孵化上线量: product.fields?.自孵化上线量,
          },
          store: {
            检查: textValue(store.fields?.检查),
            店铺浏览量: store.fields?.店铺浏览量,
            雅岚广告花费: store.fields?.雅岚广告花费,
            雅岚广告出单量: store.fields?.雅岚广告出单量,
            "金凯悦-10广告花费": store.fields?.["金凯悦-10广告花费"],
            "金凯悦-10广告出单量": store.fields?.["金凯悦-10广告出单量"],
            "金凯悦-11广告花费": store.fields?.["金凯悦-11广告花费"],
            "金凯悦-11广告出单量": store.fields?.["金凯悦-11广告出单量"],
            "GMV Max花费": store.fields?.["GMV Max花费"],
            "GMV Max广告出单量": store.fields?.["GMV Max广告出单量"],
            退货量: store.fields?.退货量,
          },
        },
        checks,
        monthTotals: {
          cup: {
            records: cupMonthRows.length,
            合作量: sum(cupMonthRows, "合作量"),
            上线量: sum(cupMonthRows, "上线量"),
            单量: sum(cupMonthRows, "单量"),
            数量: sum(cupMonthRows, "数量"),
            达人出单量: sum(cupMonthRows, "达人出单量"),
            达人出单数量: sum(cupMonthRows, "达人出单数量"),
            商品卡出单量: sum(cupMonthRows, "商品卡出单量"),
            商品卡出单数量: sum(cupMonthRows, "商品卡出单数量"),
            销售额: sum(cupMonthRows, "销售额"),
          },
          store: {
            records: storeMonthRows.length,
            合作量: sum(storeMonthRows, "合作量"),
            上线量: sum(storeMonthRows, "上线量"),
            总单量: sum(storeMonthRows, "总单量"),
            总数量: sum(storeMonthRows, "总数量"),
            达人出单量: sum(storeMonthRows, "达人出单量"),
            店铺商品卡出单量: sum(storeMonthRows, "店铺商品卡出单量"),
            店铺销售额: sum(storeMonthRows, "店铺销售额"),
            总广告花费: sum(storeMonthRows, "总广告花费"),
            总广告出单量: sum(storeMonthRows, "总广告出单量"),
          },
        },
        formulaErrors,
      },
      null,
      2,
    ),
  );
  if (checks.some((item) => !item.ok) || formulaErrors.length > 0) {
    process.exitCode = 1;
  }
}
