import { describe, expect, it } from "vitest";
import type { ModelContext, ModelProvider } from "../src/ai/types.js";
import { answerQuestionWithContext, emptyConversationContext } from "../src/bot/service.js";
import type { BusinessProfile } from "../src/config/business-profile.js";
import type { QueryIntent, TableData } from "../src/types/index.js";

const profile = {
  schemaVersion: 1,
  businessDisplayName: "Demo",
  businessTimeZone: "Asia/Shanghai",
  storeAggregateLabel: "店铺汇总",
  tables: { development: "开发", cooperation: "合作", online: "上线", roi: "投产比" },
  tiktok: { shopAlias: "demo", shopTimeZone: "America/Los_Angeles", currencyCode: "USD", productMapFile: "map.json" },
} satisfies BusinessProfile;

const roi: TableData = {
  sourceName: "飞书多维表格",
  sheetName: "投产比",
  headers: ["商品", "日期", "单量", "数量", "销售额", "记录类型", "排序键"],
  updatedAt: new Date("2026-08-03T00:00:00Z"),
  rows: [
    { 商品: "电动磨脚器", 日期: "2026-08-01", 单量: 6, 数量: 6, 销售额: 108.52, 记录类型: "商品", 排序键: "100000" },
    { 商品: "电动磨脚器", 日期: "2026-08-02", 单量: 11, 数量: 12, 销售额: 114.67, 记录类型: "商品", 排序键: "100000" },
  ],
};

describe("DeepSeek参与自然语言对话主链路", () => {
  it("先语义路由，再把含糊口语交给模型理解和二次表达", async () => {
    let routed = 0;
    let parsed = 0;
    let refined = 0;
    let capturedEvidence: unknown = null;
    let capturedTableQuestion = "";
    let capturedModelQuestion = "";
    const routeQuestion = async () => { routed += 1; return { domain: "roi" as const, confidence: 0.98 }; };
    const parseIntent = async (_question: string, _context: ModelContext, fallback: QueryIntent) => {
      parsed += 1;
      capturedModelQuestion = _question;
      return {
      intent: fallback,
      trace: { source: "deepseek" as const, model: "test", durationMs: 1, fallbackReason: null },
      };
    };
    const refineAnswer: NonNullable<ModelProvider["refineAnswer"]> = async (_question, evidence) => {
      refined += 1;
      capturedEvidence = evidence;
      return {
        text: "电动磨脚器近7天有2个完整日数据，合计17单、销售额223.19。",
        trace: { source: "deepseek" as const, model: "test", durationMs: 1, fallbackReason: null },
      };
    };
    const provider: ModelProvider = { name: "deepseek", routeQuestion, parseIntent, refineAnswer };
    const getTable = async (question?: string) => { capturedTableQuestion = question ?? ""; return roi; };

    const answer = await answerQuestionWithContext(
      { getTable },
      provider,
      "查询一下表格中最近七天的电动磨脚器数据",
      emptyConversationContext(),
      profile,
      ["我们把电动磨脚器简称为磨脚器"],
    );

    expect(capturedTableQuestion).toContain("上下文数据域：投产比");
    expect(routed).toBe(1);
    expect(parsed).toBe(1);
    expect(refined).toBe(1);
    expect(capturedModelQuestion).toContain("店铺长期知识");
    expect(capturedModelQuestion).toContain("简称为磨脚器");
    expect(refined).toBe(1);
    expect(answer.text).toContain("数据概览");
    expect(answer.text).not.toContain("17单");
    expect(JSON.stringify(capturedEvidence)).toContain("2026-07-27 至 2026-08-02");
    expect(JSON.stringify(capturedEvidence)).not.toContain("排序键");
    expect(JSON.stringify(capturedEvidence)).not.toContain("记录类型");
  });

  it("投产比怎么样会直接形成经营分析，不再追问单个指标", async () => {
    const provider: ModelProvider = {
      name: "deepseek",
      async routeQuestion() { return { domain: "roi", confidence: 0.99 }; },
      async parseIntent(_question, _context, fallback) {
        return { intent: fallback, trace: { source: "deepseek", model: "test", durationMs: 1, fallbackReason: null } };
      },
      async analyze() {
        return {
          text: "这两天电动磨脚器共17单，8月2日单量更高。",
          trace: { source: "deepseek", model: "test", durationMs: 1, fallbackReason: null },
        };
      },
    };
    const answer = await answerQuestionWithContext(
      { async getTable() { return roi; } },
      provider,
      "投产比怎么样？",
      emptyConversationContext(),
      profile,
    );
    expect(answer.text).toContain("共17单");
    expect(answer.text).not.toContain("你想统计哪个指标");
  });
});

const trendRoi: TableData = {
  sourceName: "飞书多维表格",
  sheetName: "投产比",
  headers: ["商品", "日期", "单量", "数量", "达人出单量", "达人出单数量", "商品卡出单量", "商品卡出单数量", "销售额"],
  updatedAt: new Date("2026-08-03T00:00:00Z"),
  rows: [
    ...Array.from({ length: 14 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 6, 20 + index)).toISOString().slice(0, 10);
      const recent = index >= 7;
      return {
        商品: "电动磨脚器",
        日期: date,
        单量: recent ? 4 : 2,
        数量: recent ? 5 : 2,
        达人出单量: recent ? 1 : 1,
        达人出单数量: recent ? 1 : 1,
        商品卡出单量: recent ? 3 : 1,
        商品卡出单数量: recent ? 4 : 1,
        销售额: recent ? 30 : 12,
      };
    }),
    ...Array.from({ length: 7 }, (_, index) => ({
      商品: "店铺汇总",
      日期: new Date(Date.UTC(2026, 6, 27 + index)).toISOString().slice(0, 10),
      单量: 10,
      数量: 12,
      达人出单量: 2,
      达人出单数量: 2,
      商品卡出单量: 8,
      商品卡出单数量: 10,
      销售额: 100,
    })),
    { 商品: "水杨酸沐浴露", 日期: "2026-08-02", 单量: 1, 数量: 1, 达人出单量: 0, 达人出单数量: 0, 商品卡出单量: 1, 商品卡出单数量: 1, 销售额: 22.99 },
  ],
};

const specializedProvider: ModelProvider = {
  name: "deepseek",
  async routeQuestion() { return { domain: "online", confidence: 0.99 }; },
  async parseIntent(_question, _context, fallback) {
    return { intent: fallback, trace: { source: "deepseek", model: "test", durationMs: 1, fallbackReason: null } };
  },
  async resolveMetricComparison() {
    return {
      leftField: "商品卡出单量",
      rightField: "达人出单量",
      leftLabel: "商品卡",
      rightLabel: "达人",
      confidence: 0.99,
    };
  },
};

describe("经营追问与趋势比较", () => {
  it("固定近7天简报拒绝模型扩大成14天", async () => {
    const provider: ModelProvider = {
      name: "deepseek",
      async routeQuestion() { return { domain: "roi", confidence: 0.99 }; },
      async analyze() {
        return {
          text: "📌 近14天（2026-07-20 至 2026-08-02）经营表现平淡。",
          trace: { source: "deepseek", model: "test", durationMs: 1, fallbackReason: null },
        };
      },
      async parseIntent(_question, _context, fallback) {
        return { intent: fallback, trace: { source: "deepseek", model: "test", durationMs: 1, fallbackReason: null } };
      },
    };
    const answer = await answerQuestionWithContext(
      { async getTable() { return trendRoi; } },
      provider,
      "近七天店铺经营表现怎么样？请给我简洁经营简报",
      emptyConversationContext(),
      profile,
    );
    expect(answer.text).not.toContain("近14天");
    expect(answer.text).not.toContain("2026-07-20 至 2026-08-02");
    expect(answer.text).toContain("2026-07-27 至 2026-08-02");
  });

  it("月份上线统计排除空占位记录，追问哪几次会给明细而不是重复计数", async () => {
    const online: TableData = {
      sourceName: "飞书多维表格",
      sheetName: "红人上线表",
      headers: ["达人姓名", "挂车产品", "实上线日期(Ct)", "售出数量", "视频上线地址"],
      updatedAt: new Date("2026-08-06T00:00:00Z"),
      rows: [
        { 达人姓名: "", 挂车产品: "", "实上线日期(Ct)": "2026-08-05", 售出数量: 0, 视频上线地址: "" },
        { 达人姓名: "", 挂车产品: "", "实上线日期(Ct)": "2026-08-02", 售出数量: 0, 视频上线地址: "" },
        { 达人姓名: "_miguelc88shop", 挂车产品: "电动磨脚器", "实上线日期(Ct)": "2026-07-30", 售出数量: 0, 视频上线地址: "https://example.com/1" },
        { 达人姓名: "mariarroyo10", 挂车产品: "电动磨脚器", "实上线日期(Ct)": "2026-07-17", 售出数量: 1, 视频上线地址: "https://example.com/2" },
      ],
    };
    const first = await answerQuestionWithContext(
      { async getTable(question) {
        expect(question).toContain("上下文数据域：上线");
        return online;
      } },
      specializedProvider,
      "八月份有上线视频吗",
      emptyConversationContext(),
      profile,
    );
    expect(first.text).toContain("2026年8月：有效上线视频 0 条");
    expect(first.text).toContain("2 条只有日期");
    expect(first.text).not.toContain("共上线 4 次");

    const follow = await answerQuestionWithContext(
      { async getTable(question) {
        expect(question).toContain("上一轮用户问题：八月份有上线视频吗");
        expect(question).toContain("上下文数据域：上线");
        return online;
      } },
      specializedProvider,
      "哪四次?",
      first.context,
      profile,
    );
    expect(follow.text).toContain("有效上线视频 0 条");
    expect(follow.text).toContain("不能把空占位行算成上线次数");
  });

  it("达人视频售出数量排名读取上线表全部有效记录，不误用投产比总销量", async () => {
    const online: TableData = {
      sourceName: "飞书多维表格",
      sheetName: "红人上线表",
      headers: ["达人姓名", "挂车产品", "实上线日期(Ct)", "售出数量", "视频上线地址"],
      updatedAt: new Date("2026-08-06T00:00:00Z"),
      rows: [
        { 达人姓名: "", 挂车产品: "", "实上线日期(Ct)": "2026-08-05", 售出数量: 999, 视频上线地址: "" },
        { 达人姓名: "_miguelc88shop", 挂车产品: "电动磨脚器", "实上线日期(Ct)": "2026-07-30", 售出数量: 0, 视频上线地址: "https://example.com/1" },
        { 达人姓名: "mariarroyo10", 挂车产品: "电动磨脚器", "实上线日期(Ct)": "2026-07-17", 售出数量: 1, 视频上线地址: "https://example.com/2" },
      ],
    };
    const answer = await answerQuestionWithContext(
      { async getTable(question) {
        expect(question).toContain("上下文数据域：上线");
        return online;
      } },
      specializedProvider,
      "已有记录里面达人售出数量最多的商品是什么",
      emptyConversationContext(),
      profile,
    );
    expect(answer.text).toContain("电动磨脚器：1件");
    expect(answer.text).toContain("有效视频：2条");
    expect(answer.text).toContain("2026-07-17 至 2026-07-30");
    expect(answer.text).toContain("没有拿投产比里的总销量替代");

    const follow = await answerQuestionWithContext(
      { async getTable() { return online; } },
      specializedProvider,
      "我说的是从表格有数据开始算起",
      answer.context,
      profile,
    );
    expect(follow.text).toContain("电动磨脚器：1件");
    expect(follow.text).toContain("全部有效记录");
  });

  it("达人卖了多少件固定读取投产比达人出单数量，并继承商品和全历史范围", async () => {
    const inherited = {
      ...emptyConversationContext(),
      lastEntityValue: "电动磨脚器",
      lastEntityField: "挂车产品",
      lastMetricField: "售出数量",
      lastDateField: "实上线日期(Ct)",
      lastStartDate: "2026-07-17",
      lastEndDate: "2026-07-30",
      lastTableHint: "online" as const,
      lastQuestion: "我说的是从表格有数据开始算起",
      updatedAt: Date.now(),
    };
    const answer = await answerQuestionWithContext(
      { async getTable(question) {
        expect(question).toContain("上下文数据域：投产比");
        return trendRoi;
      } },
      specializedProvider,
      "跟达人有关的售卖量是多少",
      inherited,
      profile,
    );
    expect(answer.text).toContain("电动磨脚器的达人归因销量：14件");
    expect(answer.text).toContain("2026-07-20 至 2026-08-02");
    expect(answer.text).toContain("达人出单数量");
    expect(answer.text).not.toContain("此前7天");

    const explicit = await answerQuestionWithContext(
      { async getTable() { return trendRoi; } },
      specializedProvider,
      "磨脚器中达人售卖了多少数量",
      emptyConversationContext(),
      profile,
    );
    expect(explicit.text).toContain("电动磨脚器的达人归因销量：7件");
    expect(explicit.text).toContain("2026-07-27 至 2026-08-02");
    expect(explicit.text).not.toContain("技术问题");
  });

  it("把中文和短横线单日日期严格解释成同一天，并能纠正上一轮范围", async () => {
    const table: TableData = {
      sourceName: "飞书多维表格",
      sheetName: "投产比",
      headers: ["商品", "日期", "数量", "销售额"],
      updatedAt: new Date("2026-08-03T00:00:00Z"),
      rows: [
        { 商品: "电动磨脚器", 日期: "2026-08-02", 数量: 5, 销售额: 100 },
        { 商品: "水杨酸沐浴露", 日期: "2026-08-02", 数量: 2, 销售额: 50 },
        { 商品: "电动磨脚器", 日期: "2026-08-03", 数量: 1, 销售额: 9 },
        { 商品: "水杨酸沐浴露", 日期: "2026-08-03", 数量: 3, 销售额: 30 },
      ],
    };
    const first = await answerQuestionWithContext(
      { async getTable() { return table; } },
      specializedProvider,
      "8月3号哪个卖的最好",
      emptyConversationContext(),
      profile,
    );
    expect(first.text).toContain("2026-08-03 至 2026-08-03");
    expect(first.text).toContain("水杨酸沐浴露");
    expect(first.text).toContain("30.00 美元（USD）");
    expect(first.text).not.toContain("2026-08-02");

    const prior = await answerQuestionWithContext(
      { async getTable() { return table; } },
      specializedProvider,
      "最近哪个商品卖得最好",
      emptyConversationContext(),
      profile,
    );
    const corrected = await answerQuestionWithContext(
      { async getTable() { return table; } },
      specializedProvider,
      "我说的是8.3号这一天啊",
      prior.context,
      profile,
    );
    expect(corrected.text).toContain("2026-08-03 至 2026-08-03");
    expect(corrected.text).toContain("水杨酸沐浴露");
  });

  it("最新更新的数据返回最新完整日经营摘要而不是写表提示", async () => {
    const table: TableData = {
      sourceName: "飞书多维表格",
      sheetName: "投产比",
      headers: ["商品", "日期", "总单量", "总数量", "销售额", "店铺商品卡出单量", "达人出单量"],
      updatedAt: new Date("2026-08-03T00:00:00Z"),
      rows: [
        { 商品: "店铺汇总", 日期: "2026-08-03", 总单量: 12, 总数量: 14, 销售额: 99, 店铺商品卡出单量: 10, 达人出单量: 2 },
        { 商品: "电动磨脚器", 日期: "2026-08-03", 销售额: 69 },
        { 商品: "水杨酸沐浴露", 日期: "2026-08-03", 销售额: 30 },
      ],
    };
    const answer = await answerQuestionWithContext(
      { async getTable() { return table; } },
      specializedProvider,
      "查询最新完整日店铺经营数据，包括总单量和销售额",
      emptyConversationContext(),
      profile,
    );
    expect(answer.text).toContain("最新完整日：2026-08-03");
    expect(answer.text).toContain("总单量：12单");
    expect(answer.text).toContain("99.00 美元（USD）");
    expect(answer.text).toContain("电动磨脚器");
  });

  it("菜单最新上线固定读取上线表并输出达人而非商品日报", async () => {
    const online: TableData = {
      sourceName: "飞书多维表格",
      sheetName: "红人上线表",
      headers: ["达人姓名", "挂车产品", "实上线日期(Ct)", "视频VV", "售出数量", "销售额", "视频上线地址"],
      updatedAt: new Date("2026-08-03T00:00:00Z"),
      rows: [
        { 达人姓名: "creator_a", 挂车产品: "电动磨脚器", "实上线日期(Ct)": "2026-08-03", 视频VV: 1200, 售出数量: 2, 销售额: 19.98, 视频上线地址: { link: "https://example.com/a" } },
        { 达人姓名: "creator_b", 挂车产品: "水杨酸沐浴露", "实上线日期(Ct)": "2026-08-02", 视频VV: 300, 售出数量: 0, 销售额: 0, 视频上线地址: { link: "https://example.com/b" } },
      ],
    };
    let requested = "";
    const answer = await answerQuestionWithContext(
      { async getTable(question) { requested = question ?? ""; return online; } },
      specializedProvider,
      "【红人上线表固定查询】按实上线日期倒序显示最近5条上线视频",
      emptyConversationContext(),
      profile,
    );
    expect(requested).toBe(profile.tables.online);
    expect(answer.text).toContain("creator_a");
    expect(answer.text).toContain("https://example.com/a");
    expect(answer.text).toContain("只读“上线”");
    expect(answer.text).not.toContain("店铺汇总");
  });

  it("菜单固定经营简报只汇总7个完整日且不重复商品与店铺行", async () => {
    const roiBrief: TableData = {
      sourceName: "飞书多维表格",
      sheetName: "投产比",
      headers: ["商品", "日期", "记录类型", "单量", "数量", "销售额", "总单量", "总数量", "店铺销售额", "店铺商品卡出单量", "达人出单量", "店铺浏览量"],
      updatedAt: new Date("2026-08-08T00:00:00Z"),
      rows: [
        ...Array.from({ length: 7 }, (_, index) => ({
          商品: "店铺汇总",
          日期: `2026-08-0${index + 2}`,
          记录类型: "店铺",
          总单量: 10,
          总数量: 12,
          店铺销售额: 100,
          店铺商品卡出单量: 8,
          达人出单量: 2,
          店铺浏览量: 50,
        })),
        ...Array.from({ length: 7 }, (_, index) => ({
          商品: "电动磨脚器",
          日期: `2026-08-0${index + 2}`,
          记录类型: "商品",
          单量: 10,
          数量: 12,
          销售额: 60,
        })),
      ],
    };
    const answer = await answerQuestionWithContext(
      { async getTable(question) {
        expect(question).toBe(profile.tables.roi);
        return roiBrief;
      } },
      specializedProvider,
      "【投产比固定经营简报】汇总最近7个完整日的店铺经营数据",
      emptyConversationContext(),
      profile,
    );
    expect(answer.text).toContain("2026-08-02 至 2026-08-08（7个完整日）");
    expect(answer.text).toContain("总单量：70单");
    expect(answer.text).toContain("总销量：84件");
    expect(answer.text).toContain("700.00 美元（USD）");
    expect(answer.text).toContain("电动磨脚器（420.00 美元（USD））");
    expect(answer.text).not.toContain("140单");
  });

  it("菜单最新上线遇到空占位表时返回正常空结果而不是抛错", async () => {
    const online: TableData = {
      sourceName: "飞书多维表格",
      sheetName: "红人上线表",
      headers: ["达人姓名", "挂车产品", "实上线日期(Ct)", "视频上线地址"],
      updatedAt: new Date("2026-08-03T00:00:00Z"),
      rows: [
        { 达人姓名: "", 挂车产品: "", "实上线日期(Ct)": "2026-08-03", 视频上线地址: "" },
      ],
    };
    const answer = await answerQuestionWithContext(
      { async getTable() { return online; } },
      specializedProvider,
      "【红人上线表固定查询】按实上线日期倒序显示最近5条上线视频",
      emptyConversationContext(),
      profile,
    );
    expect(answer.text).toContain("当前 0 条");
    expect(answer.text).toContain("空占位不会被算作上线视频");
    expect(answer.text).not.toContain("技术问题");
  });

  it("商品卡和达人比较会继承商品与日期上下文", async () => {
    const context = {
      ...emptyConversationContext(),
      lastEntityValue: "电动磨脚器",
      lastEntityField: "商品",
      lastMetricField: "销售额",
      lastDateField: "日期",
      lastStartDate: "2026-07-27",
      lastEndDate: "2026-08-02",
      lastTableHint: "roi" as const,
    };
    const answer = await answerQuestionWithContext(
      { async getTable(question) {
        expect(question).toContain("上下文数据域：投产比");
        return trendRoi;
      } },
      specializedProvider,
      "磨脚器是商品卡销售多一点还是达人销售多一点？",
      context,
      profile,
    );
    expect(answer.text).toContain("商品卡");
    expect(answer.text).toContain("21单");
    expect(answer.text).toContain("达人");
    expect(answer.text).toContain("7单");
    expect(answer.text).toContain("比较的是出单量");
  });

  it("比较全店渠道时使用店铺商品卡字段，不误拿逐商品字段", async () => {
    const aggregateTable: TableData = {
      sourceName: "飞书多维表格",
      sheetName: "投产比",
      headers: ["商品", "日期", "总单量", "商品卡出单量", "店铺商品卡出单量", "达人出单量"],
      updatedAt: new Date("2026-08-03T00:00:00Z"),
      rows: Array.from({ length: 30 }, (_, index) => ({
        商品: "店铺汇总",
        日期: new Date(Date.UTC(2026, 6, 4 + index)).toISOString().slice(0, 10),
        总单量: 11,
        商品卡出单量: 0,
        店铺商品卡出单量: 10,
        达人出单量: 1,
      })),
    };
    const answer = await answerQuestionWithContext(
      { async getTable() { return aggregateTable; } },
      specializedProvider,
      "最近商品是靠我们自己店铺售卖，还是靠达人宣传售卖的？",
      emptyConversationContext(),
      profile,
    );
    expect(answer.text).toContain("商品卡：70单");
    expect(answer.text).toContain("达人：7单");
    expect(answer.text).toContain("商品卡更多");

    const followUp = await answerQuestionWithContext(
      { async getTable(question) {
        expect(question).toContain("上一轮用户问题：最近商品是靠我们自己店铺售卖");
        return aggregateTable;
      } },
      specializedProvider,
      "那最近一个月呢",
      answer.context,
      profile,
    );
    expect(followUp.text).toContain("2026-07-04 至 2026-08-02");
    expect(followUp.text).toContain("商品卡：300单");
    expect(followUp.text).toContain("达人：30单");

    const rewrittenFollowUp = await answerQuestionWithContext(
      { async getTable() { return aggregateTable; } },
      specializedProvider,
      "最近一个月东西有没有依靠达人卖出？还是说靠我们自己商店卖的更多",
      answer.context,
      profile,
    );
    expect(rewrittenFollowUp.text).toContain("2026-07-04 至 2026-08-02");
    expect(rewrittenFollowUp.text).toContain("商品卡：300单");
    expect(rewrittenFollowUp.text).toContain("达人：30单");
  });

  it("销量趋势比较最近7天和此前7天，不会误查上线表", async () => {
    const answer = await answerQuestionWithContext(
      { async getTable(question) {
        expect(question).toContain("上下文数据域：投产比");
        return trendRoi;
      } },
      specializedProvider,
      "最近磨脚器的销量算增加吗？还是平淡。",
      emptyConversationContext(),
      profile,
    );
    expect(answer.text).toContain("最近7天");
    expect(answer.text).toContain("35件");
    expect(answer.text).toContain("此前7天");
    expect(answer.text).toContain("14件");
  });

  it("卖得最好默认按销售额并明确美元单位", async () => {
    const answer = await answerQuestionWithContext(
      { async getTable() { return trendRoi; } },
      specializedProvider,
      "最近哪个商品卖的最好啊",
      emptyConversationContext(),
      profile,
    );
    expect(answer.text).toContain("电动磨脚器");
    expect(answer.text).toContain("美元（USD）");
    expect(answer.text).toContain("默认按销售额");
  });

  it("能把个护电器纳入洗浴用品、返回完整前五名，并在短追问中保持连续上下文", async () => {
    const categoryRoi: TableData = {
      sourceName: "飞书多维表格",
      sheetName: "投产比",
      headers: ["商品", "日期", "数量", "销售额"],
      updatedAt: new Date("2026-08-05T00:00:00Z"),
      rows: [
        { 商品: "栗棕色染发洗发水", 日期: "2026-08-05", 数量: 12, 销售额: 120 },
        { 商品: "黑色染发洗发水", 日期: "2026-08-05", 数量: 8, 销售额: 80 },
        { 商品: "水杨酸沐浴露", 日期: "2026-08-05", 数量: 5, 销售额: 50 },
        { 商品: "电动磨脚器", 日期: "2026-08-05", 数量: 99, 销售额: 990 },
        { 商品: "电动比基尼修剪器", 日期: "2026-08-05", 数量: 1, 销售额: 20 },
        { 商品: "二合一充电宝手电筒", 日期: "2026-08-05", 数量: 999, 销售额: 9990 },
      ],
    };
    let selectedByModel = 0;
    const provider: ModelProvider = {
      name: "deepseek",
      async routeQuestion() { return { domain: "online", confidence: 0.99 }; },
      async parseIntent(_question, _context, fallback) {
        return { intent: fallback, trace: { source: "deepseek", model: "test", durationMs: 1, fallbackReason: null } };
      },
      async selectEntityCandidates(_question, candidates) {
        selectedByModel += 1;
        expect(candidates).toContain("电动磨脚器");
        return {
          selected: ["栗棕色染发洗发水", "黑色染发洗发水", "水杨酸沐浴露"],
          label: "洗浴用品",
          confidence: 0.98,
        };
      },
    };
    const first = await answerQuestionWithContext(
      { async getTable(question) {
        expect(question).toContain("上下文数据域：投产比");
        return categoryRoi;
      } },
      provider,
      "查一下所有洗浴用品最近销量前五名",
      emptyConversationContext(),
      profile,
    );
    expect(first.text).toContain("🥇 电动磨脚器：99件");
    expect(first.text).toContain("🥈 栗棕色染发洗发水：12件");
    expect(first.text).toContain("🥉 黑色染发洗发水：8件");
    expect(first.text).toContain("水杨酸沐浴露：5件");
    expect(first.text).toContain("电动比基尼修剪器：1件");
    expect(first.text).not.toContain("二合一充电宝手电筒");

    const followUp = await answerQuestionWithContext(
      { async getTable(question) {
        expect(question).toContain("上一轮用户问题：查一下所有洗浴用品最近销量前五名");
        expect(question).toContain("上下文数据域：投产比");
        return categoryRoi;
      } },
      provider,
      "把名字说出来",
      first.context,
      profile,
    );
    expect(followUp.text).toContain("栗棕色染发洗发水");
    expect(followUp.text).toContain("黑色染发洗发水");
    expect(followUp.text).toContain("水杨酸沐浴露");
    expect(followUp.text).toContain("电动磨脚器");
    expect(followUp.text).toContain("电动比基尼修剪器");
    expect(selectedByModel).toBe(2);
  });

  it("把‘货跑得快’理解成销量排名，并拒绝模型虚构商品和数字", async () => {
    const categoryRoi: TableData = {
      sourceName: "飞书多维表格",
      sheetName: "投产比",
      headers: ["商品", "日期", "数量", "销售额"],
      updatedAt: new Date("2026-08-05T00:00:00Z"),
      rows: [
        { 商品: "电动磨脚器", 日期: "2026-08-05", 数量: 99, 销售额: 990 },
        { 商品: "栗棕色染发洗发水", 日期: "2026-08-05", 数量: 12, 销售额: 120 },
        { 商品: "二合一充电宝手电筒", 日期: "2026-08-05", 数量: 999, 销售额: 9990 },
      ],
    };
    const provider: ModelProvider = {
      ...specializedProvider,
      async refineAnswer() {
        return {
          text: "商品A 120件、商品B 95件、商品C 80件，日期是7/30到8/5。",
          trace: { source: "deepseek", model: "test", durationMs: 1, fallbackReason: null },
        };
      },
    };
    const answer = await answerQuestionWithContext(
      { async getTable() { return categoryRoi; } },
      provider,
      "最近哪个货跑得最快？给我前三个就行",
      emptyConversationContext(),
      profile,
    );
    expect(answer.text).toContain("二合一充电宝手电筒：999件");
    expect(answer.text).toContain("电动磨脚器：99件");
    expect(answer.text).toContain("栗棕色染发洗发水：12件");
    expect(answer.text).not.toContain("商品A");
    expect(answer.text).not.toContain("7/30");

    const expanded = await answerQuestionWithContext(
      { async getTable() { return categoryRoi; } },
      provider,
      "把上一问商品销量前三名中的第二名（电动磨脚器）展开说说",
      answer.context,
      profile,
    );
    expect(expanded.text).toContain("📦 电动磨脚器 · 最近7天");
    expect(expanded.text).toContain("🛍️ 销量：99件");
    expect(expanded.text).not.toContain("二合一充电宝手电筒：999件");
  });

  it("能同时判断销量表现和达人视频关联，并明确不把相关性说成因果", async () => {
    const relationshipRoi: TableData = {
      sourceName: "飞书多维表格",
      sheetName: "投产比",
      headers: ["商品", "日期", "上线量", "总单量", "总数量", "达人出单量"],
      updatedAt: new Date("2026-08-03T00:00:00Z"),
      rows: Array.from({ length: 14 }, (_, index) => ({
        商品: "店铺汇总",
        日期: new Date(Date.UTC(2026, 6, 20 + index)).toISOString().slice(0, 10),
        上线量: index >= 7 ? index - 7 : 0,
        总单量: index >= 7 ? 10 : 5,
        总数量: index >= 7 ? 10 + (index - 7) : 5,
        达人出单量: index >= 7 ? 2 : 0,
      })),
    };
    const answer = await answerQuestionWithContext(
      { async getTable(question) {
        expect(question).toContain("上下文数据域：投产比");
        return relationshipRoi;
      } },
      specializedProvider,
      "最近销量是不是还可以？跟达人出视频有关系吗",
      emptyConversationContext(),
      profile,
    );
    expect(answer.text).toContain("最近7天");
    expect(answer.text).toContain("91件");
    expect(answer.text).toContain("此前7天");
    expect(answer.text).toContain("35件");
    expect(answer.text).toContain("达人上线：21条");
    expect(answer.text).toContain("达人渠道确实带来 14 单");
    expect(answer.text).toContain("不能单凭相关性证明");
  });
});
