import { getEnv, requireFeishuEnv } from "../config/env.js";
import { createFeishuClient } from "../feishu/client.js";

const TARGET_VIEWS = ["商品录入", "商品每日", "店铺每日", "商品月度", "店铺月度"] as const;
const ADMIN_VIEW_NAME = "管理员数据源";
const apply = process.argv.includes("--apply");
const env = requireFeishuEnv(getEnv());
const client = createFeishuClient(env) as any;
const appToken = env.FEISHU_BITABLE_APP_TOKEN;

function assertOk(response: any, action: string): void {
  if (response.code && response.code !== 0) {
    throw new Error(`${action}失败（${response.code}）：${response.msg}`);
  }
}

const tables = await client.bitable.appTable.list({
  path: { app_token: appToken },
  params: { page_size: 100 },
});
assertOk(tables, "读取数据表");
const table = (tables.data?.items ?? []).find((item: any) => item.name === "投产比");
if (!table?.table_id) throw new Error("未找到投产比数据表");
const tableId = table.table_id;

async function listViews(): Promise<any[]> {
  const response = await client.bitable.appTableView.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: 100 },
  });
  assertOk(response, "读取投产比视图");
  return response.data?.items ?? [];
}

async function tableShape(): Promise<{ fields: number; records: number }> {
  const [fields, records] = await Promise.all([
    client.bitable.appTableField.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100 },
    }),
    client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 1 },
    }),
  ]);
  assertOk(fields, "读取投产比字段");
  assertOk(records, "读取投产比记录数");
  return {
    fields: Number(fields.data?.total ?? fields.data?.items?.length ?? 0),
    records: Number(records.data?.total ?? records.data?.items?.length ?? 0),
  };
}

const beforeViews = await listViews();
const beforeShape = await tableShape();
const targets = beforeViews.filter((view) => TARGET_VIEWS.includes(view.view_name));

if (!apply) {
  console.log(JSON.stringify({
    mode: "preview",
    tableId,
    beforeShape,
    targets: targets.map((view) => ({ name: view.view_name, id: view.view_id, type: view.view_type })),
    existingAdminView: beforeViews.some((view) => view.view_name === ADMIN_VIEW_NAME),
    untouched: beforeViews.filter((view) => !TARGET_VIEWS.includes(view.view_name)).map((view) => ({
      name: view.view_name,
      type: view.view_type,
    })),
  }, null, 2));
  process.exit(0);
}

const deleted: Array<{ name: string; id: string }> = [];
const renamed: Array<{ from: string; to: string; id: string }> = [];

for (const target of targets) {
  const currentViews = await listViews();
  const current = currentViews.find((view) => view.view_id === target.view_id);
  if (!current) continue;
  const nativeGridViews = currentViews.filter((view) => view.view_type === "grid");

  if (current.view_type === "grid" && nativeGridViews.length === 1) {
    const response = await client.bitable.appTableView.patch({
      path: { app_token: appToken, table_id: tableId, view_id: current.view_id },
      data: { view_name: ADMIN_VIEW_NAME },
    });
    assertOk(response, `重命名最后一个原生视图${current.view_name}`);
    renamed.push({ from: current.view_name, to: ADMIN_VIEW_NAME, id: current.view_id });
    continue;
  }

  const response = await client.bitable.appTableView.delete({
    path: { app_token: appToken, table_id: tableId, view_id: current.view_id },
  });
  assertOk(response, `删除视图${current.view_name}`);
  deleted.push({ name: current.view_name, id: current.view_id });
}

const afterViews = await listViews();
const afterShape = await tableShape();
const remainingTargets = afterViews.filter((view) => TARGET_VIEWS.includes(view.view_name));
if (remainingTargets.length) {
  throw new Error(`处理后仍存在旧视图：${remainingTargets.map((view) => view.view_name).join("、")}`);
}
if (afterShape.fields !== beforeShape.fields || afterShape.records !== beforeShape.records) {
  throw new Error(`处理视图前后数据表形状变化：前=${JSON.stringify(beforeShape)}；后=${JSON.stringify(afterShape)}`);
}

console.log(JSON.stringify({
  mode: "applied",
  tableId,
  deleted,
  renamed,
  beforeShape,
  afterShape,
  remainingViews: afterViews.map((view) => ({ name: view.view_name, type: view.view_type })),
}, null, 2));
