import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";
import { importToFeishu } from "../importer/feishu-importer.js";
import { LocalFileDataSource } from "../importer/local-file.js";
import { createImportPlan } from "../importer/plan.js";

const dryRun = process.argv.includes("--dry-run") || getEnv().DRY_RUN.toLowerCase() === "true";

try {
  const table = await new LocalFileDataSource().getTable();
  const plan = createImportPlan(table);
  if (dryRun) {
    console.log(JSON.stringify({
      模式: "只读预演，不调用飞书写入接口",
      文件: plan.source,
      工作表: plan.sheet,
      计划导入记录数: plan.recordCount,
      字段类型映射: plan.fields.map((field) => ({ 字段: field.name, 类型: field.type, 提示: field.warning })),
      可能失败的字段: plan.fields.filter((field) => field.warning).map((field) => field.name),
    }, null, 2));
  } else {
    const env = requireFeishuEnv();
    const report = await importToFeishu(createFeishuClient(env), env, table);
    console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
