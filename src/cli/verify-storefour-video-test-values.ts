import { getEnv, requireFeishuEnv } from "../config/env.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

const ONLINE_TABLE_ID = "demo_edeae836";
const RECORD_ID = "demo_2be94bb2";
// Synthetic values selected by the user to verify manual-field preservation.
// The real Seller Center values for this video are currently both zero.
const EXPECTED_QUANTITY = 2;
const EXPECTED_SALES = 10;
const PRESERVED_FIELDS = ["投放状态", "视频内容", "红人类型", "备注"] as const;

type RecordItem = {
  fields?: Record<string, unknown>;
  last_modified_time?: number;
};

try {
  const env = requireFeishuEnv(getEnv());
  const client = createFeishuClient(env);
  const readRecord = async (): Promise<RecordItem> => {
    const response = await client.bitable.appTableRecord.get({
      path: {
        app_token: env.FEISHU_BITABLE_APP_TOKEN,
        table_id: ONLINE_TABLE_ID,
        record_id: RECORD_ID,
      },
    });
    assertFeishuResponse(response, "读取上线记录");
    if (!response.data?.record) throw new Error(`上线记录不存在：${RECORD_ID}`);
    return response.data.record;
  };

  const before = await readRecord();
  const beforePreserved = selectFields(before.fields, PRESERVED_FIELDS);
  const desired = {
    售出数量: EXPECTED_QUANTITY,
    销售额: EXPECTED_SALES,
  };
  const changed = Object.fromEntries(
    Object.entries(desired).filter(([name, value]) => (
      numberValue(before.fields?.[name]) !== value
    )),
  );

  if (Object.keys(changed).length > 0) {
    const current = await readRecord();
    if (
      before.last_modified_time
      && current.last_modified_time
      && Number(before.last_modified_time) !== Number(current.last_modified_time)
    ) {
      throw new Error("并发冲突：读取后该上线记录被其他人修改，本次未写入");
    }
    const response = await client.bitable.appTableRecord.update({
      path: {
        app_token: env.FEISHU_BITABLE_APP_TOKEN,
        table_id: ONLINE_TABLE_ID,
        record_id: RECORD_ID,
      },
      data: { fields: changed },
    });
    assertFeishuResponse(response, "写入视频成交测试值");
  }

  const after = await readRecord();
  const afterPreserved = selectFields(after.fields, PRESERVED_FIELDS);
  const quantity = numberValue(after.fields?.售出数量);
  const sales = numberValue(after.fields?.销售额);
  if (quantity !== EXPECTED_QUANTITY || sales !== EXPECTED_SALES) {
    throw new Error(`写后验证失败：售出数量=${quantity}，销售额=${sales}`);
  }
  if (JSON.stringify(beforePreserved) !== JSON.stringify(afterPreserved)) {
    throw new Error("写后验证失败：不应管理的人工字段发生变化");
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    recordId: RECORD_ID,
    changedFields: Object.keys(changed),
    quantity,
    sales,
    preservedFields: afterPreserved,
  }, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`测试值验证失败：${message}\n`);
  process.exitCode = 1;
}

function numberValue(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function selectFields(
  fields: Record<string, unknown> | undefined,
  names: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(names.map((name) => [name, normalize(fields?.[name])]));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value ?? null;
  const item = value as Record<string, unknown>;
  if ("text" in item) return item.text;
  if ("name" in item) return item.name;
  return Object.fromEntries(
    Object.entries(item).filter(([key]) => !["id", "avatar_url"].includes(key)),
  );
}
