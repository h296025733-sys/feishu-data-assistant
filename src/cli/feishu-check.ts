import { getEnv, requireFeishuEnv } from "../config/env.js";
import { FeishuBitableDataSource } from "../feishu/data-source.js";

try {
  const env = requireFeishuEnv(getEnv());
  const table = await new FeishuBitableDataSource(env).getTable("Tech-wave红人合作表");
  console.log(JSON.stringify({
    飞书认证: "成功",
    多维表格AppToken: env.FEISHU_BITABLE_APP_TOKEN,
    自动路由数据表: table.sheetName,
    字段数: table.headers.length,
    记录数: table.rows.length,
    数据更新时间: table.updatedAt.toISOString(),
  }, null, 2));
} catch (error) {
  console.error(`飞书只读检查失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
