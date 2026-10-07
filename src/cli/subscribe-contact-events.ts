import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";
import { ContactDuplicateColorService } from "../feishu/contact-duplicate-colors.js";

const env = requireFeishuEnv(getEnv());
const service = new ContactDuplicateColorService(env, createFeishuClient(env));
await service.subscribeToBaseEvents();
console.log(JSON.stringify({ ok: true, subscribed: true }, null, 2));
