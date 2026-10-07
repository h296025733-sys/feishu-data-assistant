import { randomUUID } from "node:crypto";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";
import { RealtimeUpdateOrchestrator } from "../realtime/orchestrator.js";

const text = process.argv.slice(2).join(" ").trim();
if (!text) throw new Error("请提供要预览的自然语言命令");
const env = requireFeishuEnv(getEnv());
const orchestrator = new RealtimeUpdateOrchestrator(env, createFeishuClient(env));
const answer = await orchestrator.handle({
  text,
  messageId: `natural-preview-${randomUUID()}`,
  userId: `natural-preview-${randomUUID()}`,
});
if (!answer) throw new Error("该文字没有被识别为实时更新任务");
process.stdout.write(`${answer}\n`);
