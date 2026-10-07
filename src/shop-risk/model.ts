import { z } from "zod";

const source = z.object({ ok: z.boolean(), error: z.string().optional(), rows: z.array(z.record(z.string(), z.any())).optional(),
  response: z.object({ data: z.record(z.string(), z.any()), request_id: z.string().optional() }).passthrough().optional() }).passthrough();
export const snapshotSchema = z.object({ version: z.literal(1), shop: z.object({ id: z.string().min(1), name: z.string() }),
  fetchedAt: z.iso.datetime({ offset: true }), evidencePath: z.string(), evidenceSha256: z.string(),
  sources: z.object({ products: source, orders: source, sps_overview: source, sps_metrics: source }) });
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Source = keyof Snapshot["sources"];
export interface Issue {
  key: string; source: Source; category: string; level: "明确违规" | "需处理" | "关注" | "信息";
  title: string; objectId: string; content: string; advice: string; dataAt: string;
}
export interface TrackedIssue extends Issue {
  firstSeen: string; lastSeen: string; status: "仍存在" | "已不再检出" | "待复核";
  baseline: boolean; reopenedAt?: string;
}
export interface RiskState {
  version: 1; shopId: string; initializedSources: Source[]; issues: Record<string, TrackedIssue>;
  previousScore?: { value: number; at: string }; checkedAt: string;
}
export const SOURCE_NAMES: Record<Source, string> = {
  products: "商品状态", orders: "待发货/待揽收订单", sps_overview: "店铺体验分", sps_metrics: "体验分指标",
};
const metricNames: Record<string, [string, string]> = {
  NRR: ["差评率", "查看差评商品和评价，优先处理重复出现的质量、描述问题。"],
  NBFR: ["非买家责任退货退款率", "检查退货退款原因，优先处理商品质量或发错货问题。"],
  SFCR: ["卖家责任取消率", "核对库存和未处理订单，避免缺货或逾期取消。"],
  OTDR: ["准时送达率", "检查延迟发货与物流异常订单，联系仓库或承运商。"],
  AHT: ["售后处理时长", "优先处理等待审核的售后申请和退回商品。"],
  IM_DSAT: ["客服不满意率", "查看低评分咨询，改进回复速度和解决问题的方式。"],
};
const iso = (n: unknown): string => typeof n === "number" && n > 0 && Number.isFinite(n)
  ? new Date(n * 1000).toISOString() : "";
const nonempty = (v: unknown): string => typeof v === "string" ? v.trim() : "";

export function detectIssues(snapshot: Snapshot, previous?: RiskState): { issues: Issue[]; failures: Partial<Record<Source, string>> } {
  const issues: Issue[] = [];
  const failures: Partial<Record<Source, string>> = {};
  for (const [name, s] of Object.entries(snapshot.sources)) if (!s.ok) failures[name as Source] = s.error || "读取失败";
  const at = snapshot.fetchedAt;
  const products = snapshot.sources.products;
  if (products.ok) {
    if (!products.rows) failures.products = "商品列表缺失";
    for (const p of products.rows ?? []) {
      const id = nonempty(p.id);
      if (!id || !nonempty(p.status)) { failures.products = "商品编号或状态缺失"; continue; }
      const title = nonempty(p.title) || id;
      const base = { source: "products" as const, category: "商品", objectId: id, dataAt: at };
      if (p.status === "PLATFORM_DEACTIVATED" || p.status === "FREEZE") issues.push({ ...base,
        key: `product:${id}:restricted`, level: "需处理", title: `${title}：平台下架/冻结`,
        content: p.status === "FREEZE" ? "商品当前处于冻结状态。" : "商品当前被平台下架。",
        advice: "打开后台商品管理查看原因；如有误判，按页面提供的入口处理或申诉。" });
      if (p.audit?.status === "FAILED") issues.push({ ...base, key: `product:${id}:audit`, level: "需处理",
        title: `${title}：审核未通过或已取消`, content: "本次商品审核状态为未通过/取消。",
        advice: "查看审核原因；需要继续上架时，按后台要求修改并重新提交。" });
      for (const sku of p.skus ?? []) if (sku.status_info?.deactivation_source === "PLATFORM" && sku.status_info?.status === "DEACTIVATED") {
        if (!nonempty(sku.id)) { failures.products = "违规 SKU 缺少编号"; continue; }
        issues.push({ ...base, key: `sku:${id}:${sku.id}:violation`, objectId: `${id} / ${sku.id}`,
          level: "明确违规", title: `${title}：SKU 因违规被平台停用`,
          content: "平台明确返回：该商品规格因违规原因被停用。",
          advice: "前往商品管理/违规记录查看具体原因、处理要求及申诉期限。" });
      }
    }
  }
  const orders = snapshot.sources.orders;
  if (orders.ok) {
    if (!orders.rows) failures.orders = "待处理订单列表缺失";
    for (const o of orders.rows ?? []) {
      if (!nonempty(o.id) || !nonempty(o.status)) { failures.orders = "订单编号或状态缺失"; continue; }
      if (o.fulfillment_type === "FULFILLMENT_BY_TIKTOK") continue;
      const collection = o.status === "AWAITING_COLLECTION";
      if (!collection && o.status !== "AWAITING_SHIPMENT" && o.status !== "PARTIALLY_SHIPPING") continue;
      // Different deadlines have different meanings. Do not substitute auto-cancel
      // for dispatch SLA or warn on an already fulfilled lifecycle phase.
      const deadlines = collection
        ? [["揽收", o.tts_sla_time], ["自动取消前揽收", o.collection_due_time]]
        : [["发货", o.rts_sla_time], ["自动取消前发货", o.shipping_due_time]];
      const valid = deadlines.filter((d) => typeof d[1] === "number" && Number.isFinite(d[1]) && Number(d[1]) > 0);
      if (!valid.length) { failures.orders = "部分待处理订单未返回截止时间"; continue; }
      const nearest = valid.sort((a, b) => Number(a[1]) - Number(b[1]))[0]!;
      const due = iso(nearest[1]);
      const remaining = Date.parse(due) - Date.parse(at);
      if (remaining > 24 * 60 * 60_000) continue;
      const action = String(nearest[0]);
      issues.push({ key: `order:${o.id}:${collection ? "collection" : "dispatch"}`, source: "orders", category: "履约",
        level: remaining < 0 ? "需处理" : "关注", title: `订单 ${o.id}：${action}${remaining < 0 ? "已超时" : "即将到期"}`,
        objectId: o.id, content: `${action}截止：${formatTime(due)}（北京时间）。${remaining < 0 ? "当前仍未完成该环节。" : "剩余不足24小时。"}`,
        advice: collection ? "联系仓库/承运商确认包裹揽收和物流扫描。" : "优先核对库存并完成发货；已发货请核查物流信息。", dataAt: at });
    }
  }
  const overview = snapshot.sources.sps_overview;
  if (overview.ok) {
    const d = overview.response?.data;
    if (!d || typeof d.sps_tier !== "string") failures.sps_overview = "体验分响应缺少状态";
    else if (d.sps_tier !== "NIL") {
      const score = Number(d.sps_score), updated = iso(d.update_time);
      if (d.sps_score == null || d.sps_score === "" || !Number.isFinite(score) || score < 0 || score > 5 || !updated) failures.sps_overview = "体验分/数据日期无效";
      else {
        const old = previous?.previousScore;
        const sameDecline = old?.at === updated && previous?.issues["sps:score"]?.content.includes("下降");
        const decreased = old && updated > old.at && score < old.value;
        const poor = ["POOR", "CRITICAL"].includes(d.sps_tier);
        issues.push({ key: "sps:score", source: "sps_overview", category: "店铺体验分", level: poor || decreased || sameDecline ? "关注" : "信息",
          title: "店铺体验分", objectId: snapshot.shop.id, content: sameDecline ? previous!.issues["sps:score"]!.content : `当前 ${score.toFixed(1)} 分${decreased ? `，较上次 ${old.value.toFixed(1)} 分下降` : ""}。${poor ? "平台评级需要关注。" : ""}`,
          advice: poor || decreased || sameDecline ? "查看下方体验分指标，优先改进平台标记的薄弱环节。" : "继续保持商品、履约和客服质量。", dataAt: updated });
      }
    }
  }
  const metrics = snapshot.sources.sps_metrics;
  if (metrics.ok) {
    const rows = metrics.response?.data.metrics;
    if (!Array.isArray(rows)) failures.sps_metrics = "体验分指标列表缺失";
    for (const m of Array.isArray(rows) ? rows : []) {
      if (!metricNames[m.metric_code] || !["EXCELLENT", "GOOD", "POOR", "CRITICAL", "NIL"].includes(m.status)) {
        failures.sps_metrics = "存在未知体验分指标/状态"; continue;
      }
      if (!["POOR", "CRITICAL"].includes(m.status)) continue;
      const [name, advice] = metricNames[m.metric_code]!;
      const value = Number(m.value), end = iso(m.end_evaluation_time);
      if (m.value == null || m.value === "" || !Number.isFinite(value) || !end || !["PERCENT", "HOURS"].includes(m.value_unit)) {
        failures.sps_metrics = "异常指标数值或评价期缺失"; continue;
      }
      issues.push({ key: `sps:metric:${m.metric_code}`, source: "sps_metrics", category: "服务质量", level: "关注",
        title: `${name}需要关注`, objectId: m.metric_code,
        content: `${m.evaluate_duration_days || "本评价期"}${m.evaluate_duration_days ? "日" : ""}${name}：${value}${m.value_unit === "PERCENT" ? "%" : "小时"}；平台评级${m.status === "CRITICAL" ? "较差" : "偏弱"}。`,
        advice, dataAt: end });
    }
  }
  return { issues, failures };
}

export function reconcile(snapshot: Snapshot, previous?: RiskState): { state: RiskState; failures: Partial<Record<Source, string>> } {
  if (previous && previous.shopId !== snapshot.shop.id) throw new Error("风险状态店铺身份不匹配");
  const { issues, failures } = detectIssues(snapshot, previous);
  const state: RiskState = { version: 1, shopId: snapshot.shop.id, initializedSources: [...(previous?.initializedSources ?? [])],
    issues: { ...previous?.issues }, previousScore: previous?.previousScore, checkedAt: snapshot.fetchedAt };
  const seen = new Set<string>();
  for (const issue of issues) {
    if (seen.has(issue.key)) throw new Error(`风险业务键重复：${issue.key}`);
    seen.add(issue.key);
    const old = state.issues[issue.key];
    const reopened = old?.status === "已不再检出";
    state.issues[issue.key] = { ...issue, firstSeen: old?.firstSeen ?? snapshot.fetchedAt, lastSeen: snapshot.fetchedAt,
      baseline: old?.baseline ?? !state.initializedSources.includes(issue.source),
      reopenedAt: reopened ? snapshot.fetchedAt : old?.reopenedAt, status: "仍存在" };
  }
  for (const [key, issue] of Object.entries(state.issues)) if (!seen.has(key)) {
    state.issues[key] = { ...issue, status: failures[issue.source] ? "待复核" : "已不再检出" };
  }
  for (const name of Object.keys(snapshot.sources) as Source[]) if (!failures[name] && !state.initializedSources.includes(name)) state.initializedSources.push(name);
  if (!failures.sps_overview) {
    const d = snapshot.sources.sps_overview.response?.data;
    if (d && d.sps_tier !== "NIL" && iso(d.update_time)) state.previousScore = { value: Number(d.sps_score), at: iso(d.update_time) };
  }
  return { state, failures };
}

export function formatTime(isoDate: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(new Date(isoDate));
}
export function beijingDate(date = new Date()): string { return formatTime(date.toISOString()).slice(0, 10); }
export function buildRiskCard(store: string, date: string, state: RiskState, failures: Partial<Record<Source, string>>, url: string) {
  const current = Object.values(state.issues).filter(i => i.status === "仍存在" && i.level !== "信息");
  const isNew = (i: TrackedIssue) => (!i.baseline && beijingDate(new Date(i.firstSeen)) === date)
    || Boolean(i.reopenedAt && beijingDate(new Date(i.reopenedAt)) === date);
  const newCount = current.filter(isNew).length;
  const lines = [`**检查时间：${formatTime(state.checkedAt)}（北京时间）**`, ""];
  const failureNames = Object.keys(failures).map(s => SOURCE_NAMES[s as Source]);
  if (failureNames.length) lines.push(`未完成检查：${failureNames.join("、")}，请人工查看。`, "");
  if (!current.length) lines.push(failureNames.length === 4 ? "今天未取得可用检查结果，请直接查看店铺后台。" : failureNames.length ? "已完成的检查未发现异常。" : "本次已监测项目未发现新增异常。");
  else {
    lines.push(`新发现/再次出现 ${newCount} 项；仍需关注 ${current.length} 项。`, "");
    for (const [level, heading] of [["明确违规", "🔴 平台明确违规"], ["需处理", "🟠 需要处理"], ["关注", "🟡 风险提醒"]]) {
      const entries = current.filter(i => i.level === level);
      if (!entries.length) continue;
      lines.push(`**${heading}（${entries.length}项）**`);
      for (const issue of entries.slice(0, 5)) lines.push(`• ${clean(issue.title).slice(0, 110)}${isNew(issue) ? "【新发现】" : "【仍存在】"}\n${issue.category === "商品" ? `商品/规格编号：${issue.objectId}\n` : ""}${clean(issue.content)}\n建议：${issue.advice}`);
      if (entries.length > 5) lines.push(`其余 ${entries.length - 5} 项见表格。`);
      lines.push("");
    }
  }
  const score = state.issues["sps:score"];
  if (score?.status === "仍存在") lines.push(`店铺体验分：${score.content} 数据截至 ${formatTime(score.dataAt)}。`);
  lines.push("", `[查看并处理提醒](${url})`);
  const text = lines.join("\n");
  return { text, card: { config: { wide_screen_mode: true }, header: { template: current.length ? "orange" : "green",
    title: { tag: "plain_text", content: `⚠️ ${store}｜违规与异常提醒｜${date}` } },
    elements: [{ tag: "div", text: { tag: "lark_md", content: text } }] } };
}
function clean(text: string): string { return text.replace(/[<>*_\[\]`]/g, "").slice(0, 300); }
