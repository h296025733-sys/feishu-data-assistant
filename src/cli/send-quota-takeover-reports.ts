import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildQuotaTakeoverReports,
  validateQuotaTakeoverPayload,
} from "../bot/quota-takeover-report.js";
import { getEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import {
  assertFeishuResponse,
  createFeishuClient,
  feishuErrorDetails,
  withFeishuRetry,
} from "../feishu/client.js";

interface DeliveryState {
  version: 1;
  deliveries: Record<string, { tenantId: string; chatId: string; messageId: string; deliveredAt: string }>;
  updatedAt: string;
}

const payloadPath = path.resolve(argument("--payload"));
const apply = process.argv.includes("--send");
const confirm = optionalArgument("--confirm");
if (apply && confirm !== "QUOTA-TAKEOVER-REPORTS") {
  throw new Error("正式发送必须提供 --confirm QUOTA-TAKEOVER-REPORTS");
}

const registry = new TenantRegistry(getEnv());
const rawPayload = JSON.parse(await readFile(payloadPath, "utf8")) as {
  tenants?: Record<string, unknown>;
};
const requestedTenantIds = Object.keys(rawPayload.tenants ?? {});
const registeredTenants = registry.all();
const tenants = registeredTenants.filter((tenant) =>
  requestedTenantIds.includes(tenant.binding.id));
const missingTenantIds = requestedTenantIds.filter((tenantId) =>
  !tenants.some((tenant) => tenant.binding.id === tenantId));
if (missingTenantIds.length > 0) {
  throw new Error(`接管报告包含未注册租户：${missingTenantIds.join(",")}`);
}
const payload = validateQuotaTakeoverPayload(
  rawPayload,
  tenants.map((tenant) => tenant.binding.id),
);
const currentShanghaiDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
if (apply && payload.sendDate !== currentShanghaiDate) {
  throw new Error(`正式发送日期必须是今天：payload=${payload.sendDate} today=${currentShanghaiDate}`);
}
if (apply && shanghaiMinutes(new Date()) < 17 * 60 + 55) {
  throw new Error("正式报告不得早于北京时间17:55发送");
}
const ageMs = Date.now() - Date.parse(payload.generatedAt);
if (ageMs < -5 * 60_000 || ageMs > 90 * 60_000) {
  throw new Error(`接管报告数据包不是本轮新鲜数据：generatedAt=${payload.generatedAt}`);
}

const statePath = path.resolve(
  optionalArgument("--state-path") ?? ".runtime/quota-takeover-reports/state.json",
);
let state = await readState(statePath);
const preview: Array<Record<string, unknown>> = [];

for (const tenant of tenants) {
  const tenantId = tenant.binding.id;
  const routes = registry.groupRoutesForTenant(tenantId);
  if (routes.length !== 1) throw new Error(`${tenantId} 专属群数量=${routes.length}，拒绝发送`);
  const chatId = routes[0]!.chatId;
  const reports = buildQuotaTakeoverReports({
    tenantId,
    storeName: tenant.profile.businessDisplayName,
    currencyCode: tenant.profile.tiktok.currencyCode,
    sendDate: payload.sendDate,
    tenant: payload.tenants[tenantId]!,
  });
  for (const report of reports) {
    const deliveryKey = `${tenantId}:${report.reportKey}:${chatId}`;
    preview.push({
      tenantId,
      chatSuffix: chatId.slice(-6),
      reportKey: report.reportKey,
      text: report.text,
      atAll: JSON.stringify(report.card).includes("<at id=all></at>"),
      alreadyDelivered: Boolean(state.deliveries[deliveryKey]),
    });
    if (!apply || state.deliveries[deliveryKey]) continue;
    const client = createFeishuClient(tenant.env);
    const uuid = deterministicUuid(deliveryKey);
    let messageId: string;
    try {
      messageId = await withFeishuRetry(async () => {
        const response = await client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "interactive",
            content: JSON.stringify(report.card),
            uuid,
          },
        });
        assertFeishuResponse(response, `发送${tenant.profile.businessDisplayName}${report.scope === "store" ? "店铺端" : "账号端"}报告`);
        const id = String(response.data?.message_id ?? "").trim();
        if (!id) throw new Error(`${tenantId} 报告发送成功但没有返回 message_id`);
        return id;
      }, { attempts: 1 });
    } catch (error) {
      const details = feishuErrorDetails(error);
      throw new Error(
        `${tenantId} 报告 IM 发送未完成（status=${details.status ?? "unknown"}, code=${details.code ?? "unknown"}）：${details.message}`,
      );
    }
    state = {
      ...state,
      deliveries: {
        ...state.deliveries,
        [deliveryKey]: { tenantId, chatId, messageId, deliveredAt: new Date().toISOString() },
      },
      updatedAt: new Date().toISOString(),
    };
    await writeState(statePath, state);
    console.log(JSON.stringify({ tenantId, reportKey: report.reportKey, delivered: true, messageId }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
}

if (!apply) console.log(JSON.stringify({ mode: "preview", sendDate: payload.sendDate, reports: preview }, null, 2));

function argument(name: string): string {
  const value = optionalArgument(name);
  if (!value) throw new Error(`缺少参数 ${name}`);
  return value;
}

function optionalArgument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "").trim() || null : null;
}

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function shanghaiMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return read("hour") * 60 + read("minute");
}

async function readState(filePath: string): Promise<DeliveryState> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as DeliveryState;
    if (value.version !== 1 || !value.deliveries) throw new Error("状态版本无效");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { version: 1, deliveries: {}, updatedAt: new Date().toISOString() };
  }
}

async function writeState(filePath: string, state: DeliveryState): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}
