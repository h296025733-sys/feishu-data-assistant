import fs from "node:fs";
import path from "node:path";
import * as lark from "@larksuiteoapi/node-sdk";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env);
let completed = false;

const dispatcher = new lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (event: any) => {
    if (completed) return;
    const openId = String(event.sender?.sender_id?.open_id ?? "");
    const messageId = String(event.message?.message_id ?? "");
    if (!openId || !messageId) return;
    completed = true;
    const outputPath = path.resolve("logs", "bound-user.json");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify({ openId }, null, 2), { encoding: "utf8", mode: 0o600 });
    await client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "text", content: JSON.stringify({ text: "测试用户绑定成功，可以返回 Codex 继续。" }) },
    });
    console.log("BIND_SUCCESS");
    setTimeout(() => process.exit(0), 300);
  },
});

const wsClient = new lark.WSClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, loggerLevel: lark.LoggerLevel.info });
console.log("BIND_READY：请在飞书中向机器人发送任意一条文本消息。");
await wsClient.start({ eventDispatcher: dispatcher });
