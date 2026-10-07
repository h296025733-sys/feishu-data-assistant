import { getEnv, requireFeishuEnv } from "../config/env.js";
import { FeishuBitableDataSource } from "../feishu/data-source.js";

const env = requireFeishuEnv(getEnv());
const source = new FeishuBitableDataSource(env);
const tableNames = ["Tech-wave红人开发表", "Tech-wave红人合作表", "Tech-wave红人上线表", "投产比"];
const marker = /测试|演练|示例|\btest\b|\bdemo\b/i;
const result = [];

for (const name of tableNames) {
  const table = await source.getTable(name);
  const markerFields = table.rows.flatMap((row, rowIndex) => Object.entries(row).flatMap(([field, value]) => {
    const rendered = JSON.stringify(value ?? "");
    return marker.test(rendered) ? [{ rowIndex, field, value }] : [];
  }));
  result.push({ table: name, recordCount: table.rows.length, markerFields });
}

console.log(JSON.stringify(result, null, 2));
