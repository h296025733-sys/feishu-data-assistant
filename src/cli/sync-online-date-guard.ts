import {
  getEnv,
  onlineDateAdminUserIds,
  requireFeishuEnv,
} from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";
import { OnlineLaunchDateGuardService } from "../feishu/online-date-guard.js";

const env = requireFeishuEnv(getEnv());
const service = new OnlineLaunchDateGuardService(
  env,
  createFeishuClient(env),
  onlineDateAdminUserIds(env),
);

console.log(JSON.stringify(await service.start(), null, 2));
