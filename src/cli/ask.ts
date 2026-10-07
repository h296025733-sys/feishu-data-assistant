import { getEnv } from "../config/env.js";
import { createModelProvider } from "../ai/providers.js";
import { answerQuestion } from "../bot/service.js";
import { FeishuBitableDataSource } from "../feishu/data-source.js";
import { LocalFileDataSource } from "../importer/local-file.js";

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  console.error('用法：npm run ask -- "<标准产品名>的利润合计是多少"');
  process.exitCode = 1;
} else {
  try {
    const env = getEnv();
    const hasFeishu = Boolean(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && env.FEISHU_BITABLE_APP_TOKEN && env.FEISHU_BITABLE_TABLE_ID);
    const dataSource = hasFeishu ? new FeishuBitableDataSource(env) : new LocalFileDataSource();
    console.log(await answerQuestion(dataSource, createModelProvider(env), question));
  } catch (error) {
    console.error(`无法回答：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
