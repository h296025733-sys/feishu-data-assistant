import { describe, expect, it } from "vitest";
import { selectTablesForQuestion, type TableMeta } from "../src/feishu/data-source.js";

const tables: TableMeta[] = [
  { tableId: "dev", name: "Tech-wave红人开发表", headers: ["红人姓名", "邮箱", "whatsapp"] },
  { tableId: "coop", name: "Tech-wave红人合作表", headers: ["红人姓名", "合作时间", "开发人", "粉丝数(K)", "寄样产品", "上线次数", "合作次数"] },
  { tableId: "on1", name: "Tech-wave红人上线表_1", headers: ["达人姓名", "实上线日期(Ct)", "视频上线地址", "挂车产品", "售出数量", "销售额"] },
  { tableId: "on2", name: "Tech-wave红人上线表_2", headers: ["达人姓名", "实上线日期(Ct)", "视频上线地址", "挂车产品", "售出数量", "销售额"] },
  { tableId: "roi", name: "投产比", headers: ["商品", "日期", "单量", "数量", "销售额", "店铺浏览量", "总单量"] },
  { tableId: "temp", name: "待删除_上线表_批次02_临时", headers: ["达人姓名"] },
];

describe("多表自动路由", () => {
  it("合作问题选择合作表", () => {
    const selected = selectTablesForQuestion("dailydigitalstore合作过几次", tables, "coop");
    expect(selected.map((item) => item.name)).toEqual(["Tech-wave红人合作表"]);
  });

  it("自然销量和销售额问法遍历全部上线分表", () => {
    expect(selectTablesForQuestion("浴室音响这个月卖了多少", tables, "coop").map((item) => item.name))
      .toEqual(["Tech-wave红人上线表_1", "Tech-wave红人上线表_2"]);
    expect(selectTablesForQuestion("销量最高的5个达人", tables, "coop").map((item) => item.name))
      .toEqual(["Tech-wave红人上线表_1", "Tech-wave红人上线表_2"]);
  });

  it("上下文数据域能让短追问继续查询原分表", () => {
    const selected = selectTablesForQuestion("这个月呢\n上下文数据域：上线", tables, "coop");
    expect(selected.map((item) => item.name)).toEqual(["Tech-wave红人上线表_1", "Tech-wave红人上线表_2"]);
  });

  it("邮箱和WhatsApp问题选择开发表", () => {
    expect(selectTablesForQuestion("查一下这个红人的邮箱", tables, "coop").map((item) => item.name))
      .toEqual(["Tech-wave红人开发表"]);
  });

  it("忽略临时、待删除和备用表", () => {
    const selected = selectTablesForQuestion("查询所有上线记录", tables, "coop");
    expect(selected.some((item) => item.name.includes("临时"))).toBe(false);
  });

  it("产品整体表现和趋势默认查询全部上线分表，不追问合作还是上线", () => {
    for (const question of ["香水这个产品整体表现怎么样？", "香水趋势怎么样？", "浴室音响销售表现如何？"]) {
      expect(selectTablesForQuestion(question, tables, "coop").map((item) => item.name))
        .toEqual(["Tech-wave红人上线表_1", "Tech-wave红人上线表_2"]);
    }
  });

  it("明确要求都看时同时选择合作表和上线分表", () => {
    expect(selectTablesForQuestion(`香水\n用户补充：都可以\n上下文数据域：合作和上线`, tables, "coop").map((item) => item.name))
      .toEqual(["Tech-wave红人合作表", "Tech-wave红人上线表_1", "Tech-wave红人上线表_2"]);
  });

  it("真正含糊的问题只追问关键数据域，不默默查默认表", () => {
    expect(() => selectTablesForQuestion("帮我看一下dailydigitalstore情况", tables, "coop"))
      .toThrow("合作情况，还是上线表现");
  });

  it("自然口语‘上线了几次’无需追问，直接遍历上线分表", () => {
    expect(selectTablesForQuestion("dailydigitalstore上线了几次？", tables, "coop").map((item) => item.name))
      .toEqual(["Tech-wave红人上线表_1", "Tech-wave红人上线表_2"]);
  });

  it("追问回复‘上线/上线数据/上线表现’都能进入上线分表", () => {
    for (const reply of ["上线", "上线数据", "上线表现"]) {
      const selected = selectTablesForQuestion(`dailydigitalstore上线了几次？\n用户补充：${reply}\n上下文数据域：上线`, tables, "coop");
      expect(selected.map((item) => item.name)).toEqual(["Tech-wave红人上线表_1", "Tech-wave红人上线表_2"]);
    }
  });

  it("明确说合作数据里的上线次数时仍选择合作表", () => {
    expect(selectTablesForQuestion("查合作数据里的上线次数", tables, "coop").map((item) => item.name))
      .toEqual(["Tech-wave红人合作表"]);
  });

  it("带日期范围的商品经营数据默认进入投产比，不再追问表名", () => {
    for (const question of [
      "查询一下表格中最近七天的电动磨脚器数据",
      "近30天电动磨脚器表现",
      "这个月商品经营数据怎么样",
    ]) {
      expect(selectTablesForQuestion(question, tables, "coop").map((item) => item.name))
        .toEqual(["投产比"]);
    }
  });

});
