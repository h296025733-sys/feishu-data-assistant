import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";
import { RoiRecordGuardService } from "../feishu/roi-record-guard.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env);
const service = new RoiRecordGuardService(env, client);
const result = await service.start();
console.log(JSON.stringify(result, null, 2));
