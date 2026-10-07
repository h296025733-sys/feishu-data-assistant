import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { getEnv, requireFeishuEnv } from "../config/env.js";
import { TenantRegistry } from "../config/tenant-registry.js";
import { assertFeishuResponse, createFeishuClient } from "../feishu/client.js";

async function main(): Promise<void> {
  const date = argument("--send-date");
  const preflightOnly = process.argv.includes("--preflight-only");
  const skipHistory = process.argv.includes("--skip-history");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("必须指定有效 --send-date");
  const registry = new TenantRegistry(requireFeishuEnv(getEnv()));
  const rows = [];
  for (const tenant of registry.all()) {
    const state = JSON.parse(await readFile(path.resolve(".runtime", "tenants", tenant.binding.id, "prepared-group-reports", "state.json"), "utf8"));
    const chats = registry.groupRoutesForTenant(tenant.binding.id).map((route) => route.chatId);
    if (chats.length !== 1) throw new Error(`${tenant.binding.id}群绑定不唯一`);
    const client = createFeishuClient(tenant.env);
    const bundle = state.bundles[date];
    if (!bundle?.reports?.length) throw new Error(`${tenant.binding.id}没有${date}报告载荷`);
    const history: any[] = [];
    let pageToken: string | undefined;
    for (let page = 0; !skipHistory && page < 10; page += 1) {
      const response = await client.im.message.list({ params: {
        container_id_type: "chat", container_id: chats[0]!, page_size: 50,
        start_time: String(Math.floor(Date.parse(`${date}T00:00:00+08:00`) / 1000)),
        sort_type: "ByCreateTimeDesc", ...(pageToken ? { page_token: pageToken } : {}),
      } });
      assertFeishuResponse(response, "回读目标经营群报告");
      history.push(...response.data?.items ?? []);
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
      if (!pageToken) break;
    }
    for (const report of bundle.reports) {
      const receipt = state.deliveries[report.reportKey]?.[chats[0]!];
      const title = String(report.card?.header?.title?.content ?? "");
      const sameTitle = history.filter((item) => !item.deleted && String(item.body?.content ?? "").includes(title));
      if (preflightOnly) {
        rows.push({ tenantId: tenant.binding.id, store: tenant.profile.businessDisplayName, reportKey: report.reportKey,
          title, chatId: chats[0], sourceStartDate: report.sourceStartDate, sourceEndDate: report.sourceEndDate,
          historyChecked: !skipHistory, historyTruncated: Boolean(pageToken), sameTitleCount: skipHistory ? null : sameTitle.length,
          receiptPresent: Boolean(receipt?.messageId),
          ok: Boolean(!skipHistory && title && !pageToken && sameTitle.length === 0 && !receipt?.messageId) });
        continue;
      }
      if (!receipt?.messageId) throw new Error(`${tenant.binding.id} ${report.reportKey}缺少message_id`);
      const response = await client.im.message.get({ path: { message_id: receipt.messageId } });
      assertFeishuResponse(response, "按message_id回读正式报告");
      const message = response.data?.items?.find((item) => item.message_id === receipt.messageId);
      const content = String(message?.body?.content ?? "");
      const ok = Boolean(message && !message.deleted && message.chat_id === chats[0] && title && content.includes(title)
        && (skipHistory || (!pageToken && sameTitle.length === 1)));
      rows.push({ tenantId: tenant.binding.id, store: tenant.profile.businessDisplayName, reportKey: report.reportKey,
        title, messageId: receipt.messageId, chatId: message?.chat_id, createTime: message?.create_time,
        sourceStartDate: report.sourceStartDate, sourceEndDate: report.sourceEndDate,
        historyChecked: !skipHistory, historyTruncated: Boolean(pageToken), sameTitleCount: skipHistory ? null : sameTitle.length,
        bodySha256: createHash("sha256").update(content).digest("hex"), ok });
    }
  }
  const output = { checkedAt: new Date().toISOString(), sendDate: date, mode: preflightOnly ? "preflight-no-send" : "sent-message-readback",
    historyChecked: !skipHistory, limitation: skipHistory ? "应用缺少im:message.group_msg；本轮只按message_id回读，不声称已遍历群历史排重" : null,
    ok: rows.every((row) => row.ok), rows };
  const destination = argument("--output");
  if (destination) {
    await mkdir(path.dirname(path.resolve(destination)), { recursive: true });
    await writeFile(destination, JSON.stringify(output, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) process.exitCode = 1;
}
function argument(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}
main().catch((error) => {
  console.error(JSON.stringify({ message: error instanceof Error ? error.message : "报告回读失败",
    status: error?.response?.status ?? null, code: error?.response?.data?.code ?? null,
    native: error?.response?.data?.msg ?? null, details: error?.response?.data?.error ?? null }));
  process.exitCode = 1;
});
