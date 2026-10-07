import { describe, expect, it } from "vitest";
import { FieldType, type IFieldMeta, type IRecord } from "@lark-opdev/block-bitable-api";
import {
  FIELD_IDS,
  ACCOUNT_SIDE_AGGREGATE_METRICS,
  ACCOUNT_SIDE_METRICS,
  PRODUCT_METRICS,
  SHOP_METRICS,
  SHOP_NAME,
  buildShopMetrics,
  advertisingFieldRepairPlan,
  discoverAdvertisingAccounts,
  applyFormulaFallbacks,
  aggregateMetric,
  dateKeyToTimestamp,
  enumerateDateKeys,
  formatMetricValue,
  getFormulaIssues,
  getWeekInfo,
  hasAnomaly,
  indexRecords,
  isMetricManuallyEditable,
  monthBounds,
  rollingDateBounds,
  needsManualInput,
  normalizeRecords,
  normalizeAccountSideRecords,
  orderAttributionSchemaIssues,
  recordKey,
  resolveFieldMap,
  validateFieldMap,
  setRuntimeStoreAggregateLabel,
  type FieldName,
  type NormalizedRecord,
} from "../src/domain";

function meta(name: FieldName): IFieldMeta {
  return {
    id: FIELD_IDS[name],
    name,
    type: name === "日期" ? FieldType.DateTime : name === "商品" ? FieldType.Text : FieldType.Number,
    isPrimary: name === "检查",
    description: { content: null },
    property: null,
  } as IFieldMeta;
}

const metas = (Object.keys(FIELD_IDS) as FieldName[]).map(meta);

describe("投产比领域规则", () => {
  it("账号端按产品或账号归一化，并让出单视频和曝光按有值日平均", () => {
    const names = ["检查", "店铺", "账号", "日期", "数据状态", ...ACCOUNT_SIDE_AGGREGATE_METRICS.map((metric) => metric.fieldName)];
    const accountMetas = [...new Set(names)].map((name) => ({
      id: `account-${name}`,
      name,
      type: name === "日期" ? FieldType.DateTime : ACCOUNT_SIDE_AGGREGATE_METRICS.some((metric) => metric.fieldName === name) ? FieldType.Number : FieldType.Text,
      isPrimary: name === "检查",
      description: { content: null },
      property: null,
    })) as IFieldMeta[];
    const byName = new Map(accountMetas.map((item) => [item.name, item]));
    const row = (id: string, date: string, videos: number, views: number): IRecord => ({
      recordId: id,
      fields: {
        [byName.get("检查")!.id]: `STOREONE|tjtj0028t22|${date}`,
        [byName.get("店铺")!.id]: "STOREONE",
        [byName.get("账号")!.id]: "tjtj0028t22",
        [byName.get("日期")!.id]: dateKeyToTimestamp(date),
        [byName.get("出单视频")!.id]: videos,
        [byName.get("视频曝光")!.id]: views,
        [byName.get("单量")!.id]: 0,
        [byName.get("数量")!.id]: 0,
        [byName.get("上线量")!.id]: 1,
        [byName.get("销售额")!.id]: 0,
        [byName.get("数据状态")!.id]: "完整",
      },
    });
    const normalized = normalizeAccountSideRecords([
      row("a", "2026-08-11", 0, 100),
      row("b", "2026-08-12", 2, 300),
    ], byName, "账号");
    expect(normalized.map((item) => item.product)).toEqual(["tjtj0028t22", "tjtj0028t22"]);
    expect(aggregateMetric(normalized, "tjtj0028t22", ACCOUNT_SIDE_METRICS.find((metric) => metric.fieldName === "出单视频")!)).toBe(1);
    expect(aggregateMetric(normalized, "tjtj0028t22", ACCOUNT_SIDE_METRICS.find((metric) => metric.fieldName === "视频曝光")!)).toBe(200);
    expect(aggregateMetric(normalized, "tjtj0028t22", ACCOUNT_SIDE_METRICS.find((metric) => metric.fieldName === "上线量")!)).toBe(2);
    expect(ACCOUNT_SIDE_AGGREGATE_METRICS.map((metric) => metric.fieldName)).toContain("广告花费");
    expect(ACCOUNT_SIDE_AGGREGATE_METRICS.map((metric) => metric.fieldName)).toContain("广告出单量");
    expect(ACCOUNT_SIDE_METRICS.map((metric) => metric.fieldName)).not.toContain("广告花费");
    expect(ACCOUNT_SIDE_METRICS.map((metric) => metric.fieldName)).not.toContain("广告出单量");
    expect(ACCOUNT_SIDE_AGGREGATE_METRICS.filter(isMetricManuallyEditable).map((metric) => metric.fieldName))
      .toEqual(["广告花费", "广告出单量"]);
    expect(ACCOUNT_SIDE_METRICS.some(isMetricManuallyEditable)).toBe(false);
    setRuntimeStoreAggregateLabel("TechWave");
  });

  it("账号端两项广告总计仅作为店铺总览指标按有值日求和", () => {
    const names = ["检查", "店铺", "账号", "日期", "数据状态", ...ACCOUNT_SIDE_AGGREGATE_METRICS.map((metric) => metric.fieldName)];
    const accountMetas = [...new Set(names)].map((name) => ({
      id: `account-spend-${name}`,
      name,
      type: name === "日期" ? FieldType.DateTime : ACCOUNT_SIDE_AGGREGATE_METRICS.some((metric) => metric.fieldName === name) ? FieldType.Number : FieldType.Text,
      isPrimary: name === "检查",
      description: { content: null },
      property: null,
    })) as IFieldMeta[];
    const byName = new Map(accountMetas.map((item) => [item.name, item]));
    const row = (id: string, date: string, spend: number | null, orders: number | null): IRecord => ({
      recordId: id,
      fields: {
        [byName.get("检查")!.id]: `STOREONE|STOREONE|${date}`,
        [byName.get("店铺")!.id]: "STOREONE",
        [byName.get("账号")!.id]: "STOREONE",
        [byName.get("日期")!.id]: dateKeyToTimestamp(date),
        [byName.get("广告花费")!.id]: spend,
        [byName.get("广告出单量")!.id]: orders,
        [byName.get("数据状态")!.id]: "完整",
      },
    });
    const normalized = normalizeAccountSideRecords([
      row("a", "2026-08-11", 0, 0),
      row("b", "2026-08-12", 12.5, 3),
      row("c", "2026-08-13", null, null),
    ], byName, "账号");
    const metric = ACCOUNT_SIDE_AGGREGATE_METRICS.find((item) => item.fieldName === "广告花费")!;
    expect(aggregateMetric(normalized, "STOREONE", metric)).toBe(12.5);
    expect(normalized.map((item) => item.values.广告花费)).toEqual([0, 12.5, null]);
    const orderMetric = ACCOUNT_SIDE_AGGREGATE_METRICS.find((item) => item.fieldName === "广告出单量")!;
    expect(aggregateMetric(normalized, "STOREONE", orderMetric)).toBe(3);
    expect(normalized.map((item) => item.values.广告出单量)).toEqual([0, 3, null]);
  });
  it("按稳定ID与正式字段名建立映射", () => {
    const map = validateFieldMap(metas);
    expect(map.get("商品")?.id).toBe(FIELD_IDS.商品);
    expect(map.get("总广告花费")?.name).toBe("总广告花费");
  });

  it("只把缺失或类型错误的渠道归因字段列为无损升级项", () => {
    const missingName = "店铺商品卡出单数量";
    const wrongTypeName = "店铺自营达人直播出单数量";
    const incomplete = metas
      .filter((item) => item.name !== missingName)
      .map((item) => item.name === wrongTypeName ? { ...item, type: FieldType.Text } : item) as IFieldMeta[];
    expect(orderAttributionSchemaIssues(incomplete)).toEqual({
      missing: [missingName],
      wrongType: [wrongTypeName],
    });
  });

  it("按稳定ID接纳每家店独立的长广告字段名", () => {
    const longName = "MAX-LUHENGCHANG COMPANY LIMITED-6061-1广告花费";
    const runtimeMetas = metas.map((item) => item.id === FIELD_IDS.广告花费 ? { ...item, name: longName } : item) as IFieldMeta[];
    const map = validateFieldMap(runtimeMetas);
    expect(map.get("广告花费")?.id).toBe(FIELD_IDS.广告花费);
    expect(map.get("广告花费")?.name).toBe(longName);
  });

  it("按广告账户成对发现动态字段，并跳过已移除账户的界面行", () => {
    const accountMetas = [
      ...metas,
      { ...meta("广告花费"), id: "spend-2", name: "Meta US广告花费" },
      { ...meta("广告出单量"), id: "orders-2", name: "Meta US广告出单量" },
    ] as IFieldMeta[];
    const accounts = discoverAdvertisingAccounts(accountMetas);
    expect(accounts).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Meta US", spendFieldId: "spend-2", orderFieldId: "orders-2", active: true })]));
    const archived = discoverAdvertisingAccounts(accountMetas, new Set(["spend-2"]));
    expect(archived.find((account) => account.name === "Meta US")?.active).toBe(false);
    expect(buildShopMetrics(archived).some((metric) => metric.fieldName === "Meta US广告花费")).toBe(false);
  });

  it("为只有单边字段的广告账户生成精确修复计划", () => {
    const incomplete = [
      ...metas,
      { ...meta("广告花费"), id: "spend-only", name: "GMV Max广告花费" },
      { ...meta("广告出单量"), id: "orders-only", name: "Spark Ads广告出单量" },
    ] as IFieldMeta[];
    expect(advertisingFieldRepairPlan(incomplete)).toEqual([
      { accountName: "GMV Max", missing: "orders" },
      { accountName: "Spark Ads", missing: "spend" },
    ]);
  });

  it("动态广告字段参与记录归一化而不是只认一个写死账户", () => {
    const accountMetas = [
      ...metas,
      { ...meta("广告花费"), id: "spend-2", name: "Meta US广告花费" },
      { ...meta("广告出单量"), id: "orders-2", name: "Meta US广告出单量" },
    ] as IFieldMeta[];
    const record: IRecord = {
      recordId: "dynamic-ad",
      fields: {
        [FIELD_IDS.商品]: "店铺汇总",
        [FIELD_IDS.日期]: new Date("2026-08-08T00:00:00+08:00").getTime(),
        "spend-2": 15.75,
        "orders-2": 3,
      },
    };
    const [normalized] = normalizeRecords([record], resolveFieldMap(accountMetas));
    expect(normalized.values["Meta US广告花费"]).toBe(15.75);
    expect(normalized.values["Meta US广告出单量"]).toBe(3);
  });

  it("缺少核心字段时拒绝静默猜测", () => {
    expect(() => validateFieldMap(metas.filter((item) => item.name !== "日期"))).toThrow("投产比缺少必需字段：日期");
  });

  it("正确解析飞书文本分段、日期、数字和空白", () => {
    const record: IRecord = {
      recordId: "rec1",
      fields: {
        [FIELD_IDS.商品]: [{ type: "text", text: "电动磨脚器" }] as never,
        [FIELD_IDS.日期]: new Date("2026-07-23T00:00:00+08:00").getTime(),
        [FIELD_IDS.检查]: [{ type: "text", text: "✓" }] as never,
        [FIELD_IDS.单量]: 6,
        [FIELD_IDS.销售额]: null,
      },
    };
    const [normalized] = normalizeRecords([record], validateFieldMap(metas));
    expect(normalized.product).toBe("电动磨脚器");
    expect(normalized.dateKey).toBe("2026-07-23");
    expect(normalized.values.单量).toBe(6);
    expect(normalized.values.销售额).toBeNull();
  });

  it("把飞书公式的 number[] 与文本分段结果归一为数字，并保持空数组为空白", () => {
    const record: IRecord = {
      recordId: "formula-shapes",
      fields: {
        [FIELD_IDS.商品]: [{ type: "text", text: "电动磨脚器" }] as never,
        [FIELD_IDS.日期]: new Date("2026-08-03T00:00:00+08:00").getTime(),
        [FIELD_IDS.检查]: [{ type: "text", text: "✓" }] as never,
        [FIELD_IDS.达人出单量]: [10] as never,
        [FIELD_IDS.达人出单数量]: [{ type: "text", text: "53" }] as never,
        [FIELD_IDS.合作量]: [] as never,
      },
    };
    const [normalized] = normalizeRecords([record], validateFieldMap(metas));
    expect(normalized.values.达人出单量).toBe(10);
    expect(normalized.values.达人出单数量).toBe(53);
    expect(normalized.values.合作量).toBeNull();
  });

  it("把待补与真正异常分开，且低频可选字段为空不误判", () => {
    const completed: NormalizedRecord = {
      recordId: "done", product: "A", dateKey: "2026-08-03", timestamp: 0, status: "✓",
      values: { 单量: 50, 数量: 100, 商品卡出单量: 40, 商品卡出单数量: 47, 销售额: 1234 },
    };
    const pending: NormalizedRecord = { recordId: "pending", product: "A", dateKey: "2026-08-04", timestamp: 0, status: "待补数据", values: {} };
    expect(needsManualInput(completed, "A")).toBe(false);
    expect(needsManualInput(pending, "A")).toBe(true);
    expect(hasAnomaly(pending, false)).toBe(false);
    expect(hasAnomaly({ ...completed, status: "⚠ 商品卡超过总数" }, false)).toBe(true);
  });

  it("按权威公式检查商品减法与店铺同日汇总", () => {
    const product: NormalizedRecord = {
      recordId: "p", product: "A", dateKey: "2026-08-03", timestamp: 0, status: "✓",
      values: { 单量: 50, 数量: 100, 商品卡出单量: 40, 商品卡出单数量: 47, 达人出单量: 10, 达人出单数量: 53, 销售额: 1234, 合作量: 0, 上线量: 0 },
    };
    const store: NormalizedRecord = {
      recordId: "s", product: SHOP_NAME, dateKey: "2026-08-03", timestamp: 0, status: "✓",
      values: { 合作量: 0, 上线量: 0, 店铺浏览量: 200, 总单量: 50, 总数量: 100, 达人出单量: 10, 店铺商品卡出单量: 40, 店铺销售额: 1234, 转化率: 0.25, 总广告出单量: 0, 总广告花费: 0 },
    };
    expect(getFormulaIssues([product, store], product)).toEqual([]);
    expect(getFormulaIssues([product, store], store)).toEqual([]);
    const brokenStore = { ...store, values: { ...store.values, 总数量: null } };
    expect(getFormulaIssues([product, brokenStore], brokenStore)).toContain("总数量应为100，当前为空白");
  });

  it("宿主批量读取暂缺公式值时按原表公式补齐界面且不制造空日期异常", () => {
    const product: NormalizedRecord = {
      recordId: "p", product: "A", dateKey: "2026-08-04", timestamp: 0, status: "✓",
      values: { 单量: 50, 数量: 100, 商品卡出单量: 40, 商品卡出单数量: 47, 销售额: 1234 },
    };
    const store: NormalizedRecord = {
      recordId: "s", product: SHOP_NAME, dateKey: "2026-08-04", timestamp: 0, status: "✓",
      values: {},
    };
    const emptyStore: NormalizedRecord = {
      recordId: "empty", product: SHOP_NAME, dateKey: "2026-08-02", timestamp: 0, status: "✓",
      values: {},
    };
    const records = applyFormulaFallbacks([product, store, emptyStore]);
    expect(product.values).toMatchObject({ 达人出单量: 10, 达人出单数量: 53 });
    expect(store.values).toMatchObject({ 总单量: 50, 总数量: 100, 达人出单量: 10, 店铺商品卡出单量: 40, 店铺销售额: 1234 });
    expect(getFormulaIssues(records, product)).toEqual([]);
    expect(getFormulaIssues(records, store)).toEqual([]);
    expect(getFormulaIssues(records, emptyStore)).toEqual([]);
  });

  it("识别同一商品与日期重复键", () => {
    const rows: NormalizedRecord[] = ["a", "b"].map((recordId) => ({ recordId, product: "A", dateKey: "2026-07-23", timestamp: 0, status: "✓", values: {} }));
    const index = indexRecords(rows);
    expect(index.duplicateKeys.has(recordKey("A", "2026-07-23"))).toBe(true);
    expect(index.byKey.get(recordKey("A", "2026-07-23"))).toHaveLength(2);
  });

  it("出单视频按有值日平均，自孵化两项保持空白", () => {
    const rows: NormalizedRecord[] = [
      { recordId: "a", product: "A", dateKey: "2026-07-01", timestamp: 0, status: "✓", values: { 单量: 2, 出单视频: 3 } },
      { recordId: "b", product: "A", dateKey: "2026-07-02", timestamp: 0, status: "✓", values: { 单量: 4, 出单视频: 2 } },
    ];
    expect(aggregateMetric(rows, "A", PRODUCT_METRICS.find((item) => item.fieldName === "单量")!, "2026-07")).toBe(6);
    expect(aggregateMetric(rows, "A", PRODUCT_METRICS.find((item) => item.fieldName === "出单视频")!, "2026-07")).toBe(2.5);
    expect(aggregateMetric(rows, "A", PRODUCT_METRICS.find((item) => item.fieldName === "自孵化出单量")!, "2026-07")).toBeNull();
  });

  it("店铺转化率、浏览量和出单视频按有值日平均", () => {
    const rows: NormalizedRecord[] = [
      { recordId: "a", product: SHOP_NAME, dateKey: "2026-07-01", timestamp: 0, status: "✓", values: { 转化率: 0.1, 店铺浏览量: 100, 出单视频: 1 } },
      { recordId: "b", product: SHOP_NAME, dateKey: "2026-07-02", timestamp: 0, status: "✓", values: { 转化率: 0.2, 店铺浏览量: 300, 出单视频: 3 } },
      { recordId: "c", product: SHOP_NAME, dateKey: "2026-08-01", timestamp: 0, status: "✓", values: { 转化率: 0.5 } },
    ];
    expect(aggregateMetric(rows, SHOP_NAME, SHOP_METRICS.find((item) => item.fieldName === "转化率")!, "2026-07")).toBeCloseTo(0.15);
    expect(aggregateMetric(rows, SHOP_NAME, SHOP_METRICS.find((item) => item.fieldName === "店铺浏览量")!, "2026-07")).toBe(200);
    expect(aggregateMetric(rows, SHOP_NAME, SHOP_METRICS.find((item) => item.fieldName === "出单视频")!, "2026-07")).toBe(2);
  });

  it("生成自然月日期并正确识别周末", () => {
    expect(monthBounds("2026-02")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(enumerateDateKeys("2026-07-31", "2026-08-02")).toEqual(["2026-07-31", "2026-08-01", "2026-08-02"]);
    expect(getWeekInfo("2026-08-01")).toMatchObject({ weekday: "星期六", weekend: true });
    expect(getWeekInfo("2026-08-03")).toMatchObject({ weekday: "星期一", weekend: false, key: "2026-08-03" });
  });

  it("滚动日期固定以今天结束，不继承自然月的未来月末", () => {
    expect(rollingDateBounds("2026-08-05", 30)).toEqual({ start: "2026-07-07", end: "2026-08-05" });
    expect(monthBounds("2026-08")).toEqual({ start: "2026-08-01", end: "2026-08-31" });
  });

  it("无数据在普通格与合计格都呈现为空白", () => {
    expect(formatMetricValue(null, PRODUCT_METRICS[0])).toBe("");
  });
});
