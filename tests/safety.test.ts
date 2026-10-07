import { describe, expect, it } from "vitest";
import { parseModelIntentJson } from "../src/query/schema.js";
import { filterSensitiveHeaders, isSensitiveField } from "../src/utils/security.js";
import { assertUserAllowed } from "../src/bot/auth.js";

describe("模型输出校验", () => {
  it("拒绝无效 AI JSON", () => expect(() => parseModelIntentJson("不是JSON")).toThrow("不是有效 JSON"));
  it("拒绝额外字段", () => expect(() => parseModelIntentJson(JSON.stringify({
    intent: "sum", metricField: "金额", entityField: null, entityValue: null,
    dateField: null, startDate: null, endDate: null, sortDirection: null, sortField: null,
    limit: 1, selectFields: [], responseStyle: "concise", sql: "DROP TABLE",
  }))).toThrow("结构无效"));
});

describe("敏感字段过滤", () => {
  it("识别要求中的敏感字段", () => {
    for (const field of ["客户姓名", "手机号", "收货地址", "身份证", "银行账号", "邮箱", "客户备注", "收件信息"]) {
      expect(isSensitiveField(field), field).toBe(true);
    }
  });
  it("保留普通经营字段", () => expect(filterSensitiveHeaders(["商品", "实付金额", "手机号"])).toEqual(["商品", "实付金额"]));
});

describe("机器人授权", () => {
  it("拒绝未授权用户", () => expect(() => assertUserAllowed("ou_bad", new Set(["ou_good"]))).toThrow("未被授权"));
  it("允许白名单用户", () => expect(() => assertUserAllowed("ou_good", new Set(["ou_good"]))).not.toThrow());
});
