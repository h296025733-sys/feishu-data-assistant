import { buildWorkbenchCard } from "../bot/workbench-menu.js";
import { roleForUser } from "../bot/access-control.js";
import { loadBusinessProfile } from "../config/business-profile.js";
import { allowedUserIds, getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

const env = requireFeishuEnv(getEnv());
const receiveId = process.argv[2]?.trim() || [...allowedUserIds(env)][0];
if (!receiveId) throw new Error("没有可投递菜单的机器人白名单用户");

const client = createFeishuClient(env);
const response = await client.im.message.create({
  params: { receive_id_type: "open_id" },
  data: {
    receive_id: receiveId,
    msg_type: "interactive",
    content: JSON.stringify(buildWorkbenchCard(
      "root",
      roleForUser(receiveId, env),
      loadBusinessProfile(),
    )),
  },
});

if (response.code && response.code !== 0) {
  throw new Error(`经营菜单投递失败（${response.code}）：${response.msg ?? "未知错误"}`);
}

console.log(JSON.stringify({
  delivered: Boolean(response.data?.message_id),
  role: roleForUser(receiveId, env),
}));
