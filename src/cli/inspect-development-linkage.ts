import { getEnv, requireFeishuEnv } from "../config/env.js";
import { loadBusinessProfile } from "../config/business-profile.js";
import { FeishuBitableDataSource } from "../feishu/data-source.js";

const env = requireFeishuEnv(getEnv());
const profile = loadBusinessProfile();
const source = new FeishuBitableDataSource(env);
const table = await source.getTable(profile.tables.development);

console.log(JSON.stringify(table.rows.map((row) => ({
  recordId: row.__recordId,
  handle: row.红人姓名 ?? null,
  developer1: row.开发人1 ?? null,
  developer2: row.开发人2 ?? null,
  finalOwner: row.最终归属 ?? null,
})), null, 2));
