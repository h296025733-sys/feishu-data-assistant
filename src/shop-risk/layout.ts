export const RISK_LAYOUTS = [
  { name: "经营异常", visible: ["事项", "级别", "内容", "建议处理", "监测状态", "人工处理", "备注", "数据截至"],
    rules: [["级别", "isNot", "明确违规"], ["类型", "isNot", "店铺体验分"], ["类型", "isNot", "服务质量"], ["监测状态", "isNot", "已不再检出"]] },
  { name: "违规记录", visible: ["事项", "首次发现", "商品/订单编号", "内容", "建议处理", "监测状态", "人工处理", "备注"],
    rules: [["级别", "is", "明确违规"], ["监测状态", "isNot", "已不再检出"]] },
  { name: "店铺健康", visible: ["事项", "级别", "内容", "建议处理", "监测状态", "数据截至"],
    rules: [["类型", "isNot", "商品"], ["类型", "isNot", "履约"], ["监测状态", "isNot", "已不再检出"]] },
  { name: "历史记录", visible: ["事项", "类型", "首次发现", "本次检查", "商品/订单编号", "内容", "人工处理", "备注"],
    rules: [["监测状态", "is", "已不再检出"]] },
] as const;

export function riskViewProperty(fields: { field_id?: string; field_name: string }[], definition: typeof RISK_LAYOUTS[number]) {
  const id = (name: string) => {
    const matches = fields.filter(f => f.field_name === name && f.field_id);
    if (matches.length !== 1) throw new Error(`排版字段不唯一：${name}`);
    return matches[0]!.field_id!;
  };
  for (const name of definition.visible) id(name);
  return { hidden_fields: fields.filter(f => !(definition.visible as readonly string[]).includes(f.field_name)).map(f => id(f.field_name)),
    filter_info: { conjunction: "and" as const, conditions: definition.rules.map(([name, operator, value]) => ({ field_id: id(name), operator, value: JSON.stringify([value]) })) } };
}

export function sameRiskViewProperty(a: any, b: any): boolean {
  const normalize = (p: any) => ({ hidden: [...(p?.hidden_fields ?? [])].sort(), conjunction: p?.filter_info?.conjunction,
    conditions: (p?.filter_info?.conditions ?? []).map((c: any) => [c.field_id, c.operator, c.value]).sort((x: any, y: any) => JSON.stringify(x).localeCompare(JSON.stringify(y))) });
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
