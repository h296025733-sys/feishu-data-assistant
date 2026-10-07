import { expect, it } from "vitest";
import { RISK_LAYOUTS, riskViewProperty, sameRiskViewProperty } from "../src/shop-risk/layout.js";
import { AUTO_FIELDS } from "../src/shop-risk/table.js";
const fields = [...AUTO_FIELDS, "人工处理", "备注"].map(field_name => ({field_name,field_id:field_name}));
it("separates violation, operational, health and resolved records without overlapping views", () => {
  const samples = [
    {"类型":"商品","级别":"明确违规","监测状态":"仍存在"},
    {"类型":"商品","级别":"需处理","监测状态":"仍存在"},
    {"类型":"履约","级别":"关注","监测状态":"待复核"},
    {"类型":"店铺体验分","级别":"信息","监测状态":"仍存在"},
    {"类型":"服务质量","级别":"关注","监测状态":"待复核"},
    {"类型":"商品","级别":"明确违规","监测状态":"已不再检出"},
  ];
  const viewNames = samples.map(row => RISK_LAYOUTS.filter(d => riskViewProperty(fields,d).filter_info.conditions.every(c => c.operator === "is" ? row[c.field_id as keyof typeof row] === JSON.parse(c.value)[0] : row[c.field_id as keyof typeof row] !== JSON.parse(c.value)[0])).map(d=>d.name));
  expect(viewNames).toEqual([["违规记录"],["经营异常"],["经营异常"],["店铺健康"],["店铺健康"],["历史记录"]]);
});
it("hides technical fields and keeps manual fields in actionable views", () => {
  for(const d of RISK_LAYOUTS) expect(riskViewProperty(fields,d).hidden_fields).toContain("核对键");
  for(const d of RISK_LAYOUTS.slice(0,2)) expect(riskViewProperty(fields,d).hidden_fields).not.toContain("人工处理");
  const p=riskViewProperty(fields,RISK_LAYOUTS[0]);
  expect(sameRiskViewProperty(p,{...p,filter_info:{...p.filter_info,conditions:p.filter_info.conditions.map(c=>({...c,condition_id:"server"}))}})).toBe(true);
});
