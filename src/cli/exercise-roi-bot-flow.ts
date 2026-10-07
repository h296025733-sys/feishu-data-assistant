import { randomUUID } from "node:crypto";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";
import { RealtimeUpdateOrchestrator } from "../realtime/orchestrator.js";

try {
  const env = requireFeishuEnv(getEnv());
  const orchestrator = new RealtimeUpdateOrchestrator(env, createFeishuClient(env));
  const userId = `roi-e2e-${randomUUID()}`;
  const preview = await orchestrator.handle({
    text: "更新投产比 2026-07-23 电动磨脚器",
    messageId: `preview-${randomUUID()}`,
    userId,
  });
  if (!preview?.includes("投产比写入预览")) {
    throw new Error(`没有得到投产比预览：${String(preview)}`);
  }
  const result = await orchestrator.handle({
    text: "继续刚才的更新",
    messageId: `confirm-${randomUUID()}`,
    userId,
  });
  if (!result?.includes("任务状态：成功")) {
    throw new Error(`确认写入未成功：${String(result)}`);
  }
  process.stdout.write(`${JSON.stringify({ preview, result }, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`投产比机器人链路验证失败：${message}\n`);
  process.exitCode = 1;
}
