import { describe, expect, it } from "vitest";
import type { QueryIntent, TableData } from "../src/types/index.js";
import type { ModelProvider } from "../src/ai/types.js";
import { answerQuestion } from "../src/bot/service.js";
import { executeQuery } from "../src/query/engine.js";
import { matchEntityValue } from "../src/query/match.js";
import { parseQuestion } from "../src/query/parser.js";
import { inferFieldRoles } from "../src/importer/inspect.js";
import { parseModelIntentJson } from "../src/query/schema.js";

const table: TableData = {
  sourceName: "fixture.csv",
  sheetName: "Sheet1",
  headers: ["日期", "商品", "实付金额", "数量"],
  updatedAt: new Date("2026-07-22T00:00:00Z"),
  rows: [
    { 日期: "2026-07-20", 商品: "A商品", 实付金额: 10, 数量: 2 },
    { 日期: "2026-07-20", 商品: "A商品", 实付金额: 10, 数量: 2 },
    { 日期: "2026-07-21", 商品: "A商品", 实付金额: "20", 数量: 3 },
    { 日期: "2026-07-21", 商品: "B商品", 实付金额: "坏数据", 数量: 1 },
    { 日期: "2026-07-21", 商品: "B商品", 实付金额: 5, 数量: 1 },
    { 日期: "2026-07-21", 商品: "A咖啡30ml", 实付金额: "", 数量: 1 },
    { 日期: "2026-07-22", 商品: "A咖啡50ml", 实付金额: "无效", 数量: 2 },
  ],
};

function intent(overrides: Partial<QueryIntent> = {}): QueryIntent {
  return {
    intent: "sum",
    metricField: "实付金额",
    entityField: "商品",
    entityValue: null,
    dateField: "日期",
    startDate: null,
    endDate: null,
    sortDirection: null,
    sortField: null,
    limit: 10,
    selectFields: [],
    responseStyle: "concise",
    ...overrides,
  };
}

const online: TableData = {
  sourceName: "飞书多维表格",
  sheetName: "Tech-wave红人上线表_1 + Tech-wave红人上线表_2",
  headers: ["实上线日期(Ct)", "开发人", "达人姓名", "挂车产品", "视频上线地址", "视频曝光K", "售出数量", "销售额"],
  updatedAt: new Date("2026-07-24T00:00:00Z"),
  rows: [
    { __sourceTable: "Tech-wave红人上线表_1", "实上线日期(Ct)": "2026-07-01", 达人姓名: "dailydigitalstore", 挂车产品: "浴室音响", 视频上线地址: "v1", 视频曝光K: 10, 售出数量: 2, 销售额: 20 },
    { __sourceTable: "Tech-wave红人上线表_1", "实上线日期(Ct)": "2026-07-20", 达人姓名: "dailydigitalstore", 挂车产品: "浴室音响", 视频上线地址: "v2", 视频曝光K: 20, 售出数量: 3, 销售额: 30 },
    { __sourceTable: "Tech-wave红人上线表_2", "实上线日期(Ct)": "2026-07-23", 达人姓名: "dailydigitalstore", 挂车产品: "浴室音响", 视频上线地址: "v3", 视频曝光K: 30, 售出数量: 4, 销售额: 40 },
    { __sourceTable: "Tech-wave红人上线表_2", "实上线日期(Ct)": "2026-05-01", 达人姓名: "a", 挂车产品: "香水", 视频上线地址: "v4", 视频曝光K: 50, 售出数量: 10, 销售额: 100 },
    { __sourceTable: "Tech-wave红人上线表_2", "实上线日期(Ct)": "2026-06-01", 达人姓名: "b", 挂车产品: "香水", 视频上线地址: "v5", 视频曝光K: 60, 售出数量: 4, 销售额: 30 },
    { __sourceTable: "Tech-wave红人上线表_2", "实上线日期(Ct)": "2026-06-02", 达人姓名: "c", 挂车产品: "香水", 视频上线地址: "v6", 视频曝光K: 30, 售出数量: 2, 销售额: 10 },
  ],
};

const fixedNow = new Date(2026, 6, 24);

describe("确定性查询", () => {
  it("不擅自删除字段完全相同的业务记录", () => {
    const result = executeQuery(table, intent({ entityValue: "A商品" }));
    expect(result.value).toBe(40);
    expect(result.matchedRows).toBe(3);
    expect(result.duplicateRowsDetected).toBe(1);
  });

  it("数量求和", () => {
    expect(executeQuery(table, intent({ metricField: "数量", entityValue: "A商品" })).value).toBe(7);
  });

  it("按闭区间过滤日期", () => {
    const result = executeQuery(table, intent({ startDate: "2026-07-21", endDate: "2026-07-21" }));
    expect(result.value).toBe(25);
    expect(result.matchedRows).toBe(4);
    expect(result.invalidNumericRows).toBe(1);
  });

  it("支持平均值和去重计数", () => {
    expect(executeQuery(table, intent({ intent: "average", metricField: "数量" })).value).toBeCloseTo(12 / 7);
    expect(executeQuery(table, intent({ intent: "distinct_count", metricField: null, entityField: "商品" })).value).toBe(4);
  });

  it("记录明细能按日期倒序", () => {
    const parsed = parseQuestion("dailydigitalstore最近2条视频", online, inferFieldRoles(online.headers), fixedNow);
    const result = executeQuery(online, parsed.intent);
    expect((result.value as Array<Record<string, unknown>>).map((row) => row.视频上线地址)).toEqual(["v3", "v2"]);
  });

  it("没有匹配记录时拒绝生成答案", () => {
    expect(() => executeQuery(table, intent({ entityValue: "不存在" }))).toThrow("没有匹配记录");
  });
});

describe("自然语言理解", () => {
  const roles = inferFieldRoles(online.headers);

  it("随口问上线次数会按原始记录计数", () => {
    const parsed = parseQuestion("dailydigitalstore上线了几次？", online, roles, fixedNow);
    expect(parsed.intent).toMatchObject({ intent: "count", entityField: "达人姓名", entityValue: "dailydigitalstore" });
    expect(executeQuery(online, parsed.intent).value).toBe(3);
  });

  it("产品整体表现无需追问，会生成多指标和月份趋势概览", () => {
    const parsed = parseQuestion("香水这个产品整体表现怎么样？", online, roles, fixedNow);
    expect(parsed.intent).toMatchObject({ intent: "summary", entityField: "挂车产品", entityValue: "香水" });
    const result = executeQuery(online, parsed.intent);
    expect(result.value).toMatchObject({
      __kind: "online_overview",
      records: 3,
      distinctCreators: 3,
      quantity: 16,
      sales: 140,
      peakSalesMonth: { month: "2026-05" },
      peakRecordMonth: { month: "2026-06" },
    });
  });

  it("固定近七天经营简报保留七个完整日而不是退回全表", () => {
    const parsed = parseQuestion(
      "近七天店铺经营表现怎么样？请给我简洁经营简报",
      table,
      inferFieldRoles(table.headers),
      fixedNow,
    );
    expect(parsed.intent).toMatchObject({
      intent: "summary",
      dateField: "日期",
      startDate: "2026-07-17",
      endDate: "2026-07-23",
    });
  });

  it("保守合并常见产品别名，但不把组合商品并入单一产品", () => {
    const aliasTable: TableData = {
      ...online,
      rows: [
        { 达人姓名: "a", 挂车产品: "尾插充电宝", 售出数量: 1, 销售额: 10 },
        { 达人姓名: "b", 挂车产品: "尾插充电宝（2个装）", 售出数量: 2, 销售额: 20 },
        { 达人姓名: "c", 挂车产品: "尾插充电宝,香水", 售出数量: 100, 销售额: 1000 },
      ],
    };
    const parsed = parseQuestion("尾插充电宝卖了多少件", aliasTable, inferFieldRoles(aliasTable.headers), fixedNow);
    expect(executeQuery(aliasTable, parsed.intent).value).toBe(3);
  });

  it("卖了多少默认是售出数量，卖了多少钱是销售额", () => {
    const quantity = parseQuestion("浴室音响这个月卖了多少？", online, roles, fixedNow).intent;
    expect(quantity).toMatchObject({ intent: "sum", metricField: "售出数量", entityField: "挂车产品", entityValue: "浴室音响", startDate: "2026-07-01", endDate: "2026-07-31" });
    expect(executeQuery(online, quantity).value).toBe(9);

    const amount = parseQuestion("浴室音响这个月卖了多少钱？", online, roles, fixedNow).intent;
    expect(amount.metricField).toBe("销售额");
    expect(executeQuery(online, amount).value).toBe(90);
  });

  it("这个月上线了多少达人会做去重计数", () => {
    const parsed = parseQuestion("这个月上线了多少达人？", online, roles, fixedNow);
    expect(parsed.intent).toMatchObject({ intent: "distinct_count", entityField: "达人姓名" });
    expect(executeQuery(online, parsed.intent).value).toBe(1);
  });

  it("销量最高的达人自动选择达人和售出数量", () => {
    const parsed = parseQuestion("销量最高的2个达人", online, roles, fixedNow);
    expect(parsed.intent).toMatchObject({ intent: "rank", entityField: "达人姓名", metricField: "售出数量", limit: 2, sortDirection: "desc" });
  });

  it("谁上线最多会按原始记录数排名，不依赖缓存次数字段", () => {
    const parsed = parseQuestion("谁上线最多？", online, roles, fixedNow);
    expect(parsed.intent).toMatchObject({ intent: "rank_count", entityField: "达人姓名", metricField: null, sortDirection: "desc", limit: 1 });
    expect(executeQuery(online, parsed.intent).value).toEqual([
      { entity: "dailydigitalstore", value: 3 },
    ]);
  });

  it("最近谁上线最多会按最近7个完整日排名，不会误当明细查询", () => {
    const parsed = parseQuestion("最近谁上线最多？", online, roles, fixedNow);
    expect(parsed.intent).toMatchObject({
      intent: "rank_count",
      entityField: "达人姓名",
      startDate: "2026-07-17",
      endDate: "2026-07-23",
      limit: 1,
    });
    expect(executeQuery(online, parsed.intent).value).toEqual([
      { entity: "dailydigitalstore", value: 2 },
    ]);
  });

  it("最近什么产品销量最好默认使用最近7个完整日并只返回第一名", () => {
    const parsed = parseQuestion("最近什么产品销量最好？", table, inferFieldRoles(table.headers), fixedNow);
    expect(parsed.intent).toMatchObject({
      intent: "rank",
      entityField: "商品",
      metricField: "数量",
      startDate: "2026-07-17",
      endDate: "2026-07-23",
      limit: 1,
    });
  });

  it("表格、详细和默认简洁格式可识别", () => {
    expect(parseQuestion("最近5条视频整理成表格", online, roles, fixedNow).intent.responseStyle).toBe("table");
    expect(parseQuestion("详细告诉我上线次数", online, roles, fixedNow).intent.responseStyle).toBe("detailed");
    expect(parseQuestion("dailydigitalstore上线几次", online, roles, fixedNow).intent.responseStyle).toBe("concise");
  });
});

describe("对象匹配", () => {
  const candidates = ["A商品", "A咖啡30ml", "A咖啡50ml", "月光茶"];

  it("优先精确匹配", () => expect(matchEntityValue("A商品", candidates)).toMatchObject({ status: "matched", mode: "exact" }));
  it("支持忽略空格和符号的规范化匹配", () => expect(matchEntityValue("月 光-茶", candidates)).toMatchObject({ status: "matched", value: "月光茶" }));
  it("唯一模糊匹配可接受", () => expect(matchEntityValue("30ml", candidates)).toMatchObject({ status: "matched", value: "A咖啡30ml", mode: "fuzzy" }));
  it("多个模糊候选时拒绝猜测", () => expect(matchEntityValue("A咖啡", candidates)).toMatchObject({ status: "ambiguous" }));
});

describe("AI 查询意图", () => {
  it("模型用limit=0表示全部时安全归一化", () => {
    const parsed = parseModelIntentJson(JSON.stringify({
      intent: "count", metricField: null, entityField: "商品", entityValue: "A商品", dateField: null,
      startDate: null, endDate: null, sortDirection: null, sortField: null, limit: 0, selectFields: [], responseStyle: "concise",
    }));
    expect(parsed.limit).toBe(100);
  });

  it("默认回答简洁，不输出工程调试字段", async () => {
    const provider: ModelProvider = {
      name: "deepseek",
      async parseIntent(_question, _context, fallback) {
        return {
          intent: { ...fallback, intent: "rank", metricField: "实付金额", entityField: "商品", sortDirection: "desc", sortField: "实付金额", limit: 2 },
          trace: { source: "deepseek", model: "test-model", durationMs: 12, fallbackReason: null },
        };
      },
    };
    const answer = await answerQuestion({ async getTable() { return table; } }, provider, "实付金额最高的2个商品");
    expect(answer).toContain("实付金额最高前 2 名");
    expect(answer).not.toContain("问题解析");
  });

  it("本地规则仍是概览时，即使问题含表名提示也交给模型判断", async () => {
    let called = false;
    const provider: ModelProvider = {
      name: "deepseek",
      async parseIntent(_question, _context, fallback) {
        called = true;
        return {
          intent: {
            ...fallback,
            intent: "rank",
            metricField: "实付金额",
            entityField: "商品",
            sortDirection: "desc",
            sortField: "实付金额",
            limit: 1,
          },
          trace: { source: "deepseek", model: "test-model", durationMs: 12, fallbackReason: null },
        };
      },
    };

    const answer = await answerQuestion(
      { async getTable() { return table; } },
      provider,
      "合作数据里，给我一个重点判断",
    );

    expect(called).toBe(true);
    expect(answer).toContain("A商品的实付金额最高，为40");
  });

  it("分析请求返回业务结论，不返回旧的数据概览模板", async () => {
    const provider: ModelProvider = {
      name: "deepseek",
      async parseIntent() {
        throw new Error("分析请求不应再先调用意图解析");
      },
      async analyze(_question, evidence) {
        expect(evidence.recordCount).toBe(table.rows.length);
        return {
          text: "结论：A商品贡献更集中。\n1. A商品有3条记录。\n建议：继续核对重复记录。",
          trace: { source: "deepseek", model: "test-model", durationMs: 12, fallbackReason: null },
        };
      },
    };

    const answer = await answerQuestion(
      { async getTable() { return table; } },
      provider,
      "请分析当前数据并告诉我重点",
    );

    expect(answer).toContain("结论：A商品贡献更集中");
    expect(answer).not.toContain("数据依据：Sheet1");
    expect(answer).not.toContain("字段数");
    expect(answer).not.toContain("执行方式");
  });
});
