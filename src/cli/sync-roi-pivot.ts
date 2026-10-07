import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";
import { RoiPivotSyncService } from "../feishu/roi-pivot-sync.js";

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env);
const service = new RoiPivotSyncService(env, client);
const result = await service.syncNow("manual_install");

console.log(JSON.stringify(result, null, 2));
