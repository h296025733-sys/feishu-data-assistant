import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";
import { ContactDuplicateColorService } from "../feishu/contact-duplicate-colors.js";

const env = requireFeishuEnv(getEnv());
const service = new ContactDuplicateColorService(env, createFeishuClient(env));
const result = await service.sync("manual_cli");
console.log(JSON.stringify(result, null, 2));
