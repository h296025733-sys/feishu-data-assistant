import { getEnv, requireFeishuEnv } from "../config/env.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

const ONLINE_TABLE_ID = "demo_edeae836";
const RECORD_ID = "demo_2be94bb2";
const EXPECTED_VIDEO_ID = "7665612776009780494";
const TEST_FIELDS = ["售出数量", "销售额", "投放状态", "视频内容"] as const;

const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env);

const readRecord = async () => {
  const response = await client.bitable.appTableRecord.get({
    path: { app_token: env.FEISHU_BITABLE_APP_TOKEN, table_id: ONLINE_TABLE_ID, record_id: RECORD_ID },
  });
  assertFeishuResponse(response, "读取 STOREFOUR 上线记录");
  if (!response.data?.record) throw new Error(`上线记录不存在：${RECORD_ID}`);
  return response.data.record;
};

function textValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => item && typeof item === "object" && "text" in item ? String((item as any).text) : String(item ?? "")).join("");
  return value === null || value === undefined ? "" : String(value);
}

function urlValue(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    return String(item.link ?? item.text ?? "");
  }
  return textValue(value);
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== "object") return value ?? null;
  const item = value as Record<string, unknown>;
  if ("text" in item) return item.text;
  if ("name" in item) return item.name;
  return Object.fromEntries(Object.entries(item).filter(([key]) => !["id", "avatar_url"].includes(key)).map(([key, val]) => [key, normalized(val)]));
}

const before = await readRecord();
if (!urlValue(before.fields?.["视频上线地址"]).includes(EXPECTED_VIDEO_ID)) {
  throw new Error("目标记录视频 ID 已变化，停止清理");
}
const actualTestValues = Object.fromEntries(TEST_FIELDS.map((name) => [name, normalized(before.fields?.[name])]));
const expectedTestValues = { 售出数量: "2", 销售额: "10", 投放状态: "投放中", 视频内容: ["开箱"] };
const equivalentExpected = { ...expectedTestValues, 售出数量: 2, 销售额: 10 };
if (JSON.stringify(actualTestValues) !== JSON.stringify(expectedTestValues) && JSON.stringify(actualTestValues) !== JSON.stringify(equivalentExpected)) {
  throw new Error(`测试字段当前值已变化，停止清理：${JSON.stringify(actualTestValues)}`);
}
const untouchedBefore = Object.fromEntries(Object.entries(before.fields ?? {}).filter(([name]) => !TEST_FIELDS.includes(name as any)).map(([name, value]) => [name, normalized(value)]));

const current = await readRecord();
if (before.last_modified_time && current.last_modified_time && Number(before.last_modified_time) !== Number(current.last_modified_time)) {
  throw new Error("并发冲突：读取后上线记录被其他人修改，本次未写入");
}
const response = await client.bitable.appTableRecord.update({
  path: { app_token: env.FEISHU_BITABLE_APP_TOKEN, table_id: ONLINE_TABLE_ID, record_id: RECORD_ID },
  data: { fields: Object.fromEntries(TEST_FIELDS.map((name) => [name, null])) as any },
});
assertFeishuResponse(response, "清空上线表合成测试值");

const after = await readRecord();
const cleared = Object.fromEntries(TEST_FIELDS.map((name) => [name, normalized(after.fields?.[name])]));
if (Object.values(cleared).some((value) => value !== null)) throw new Error(`清空后仍有测试值：${JSON.stringify(cleared)}`);
const untouchedAfter = Object.fromEntries(Object.entries(after.fields ?? {}).filter(([name]) => !TEST_FIELDS.includes(name as any)).map(([name, value]) => [name, normalized(value)]));
if (JSON.stringify(untouchedAfter) !== JSON.stringify(untouchedBefore)) throw new Error("清理后其他上线字段发生变化");

console.log(JSON.stringify({ ok: true, recordId: RECORD_ID, videoId: EXPECTED_VIDEO_ID, cleared, otherFieldsPreserved: true }, null, 2));
