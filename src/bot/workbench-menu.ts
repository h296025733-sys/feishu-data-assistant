import type { BotRole } from "./access-control.js";
import type { BusinessProfile } from "../config/business-profile.js";
import type { PendingProductApproval } from "../automation/product-approval.js";

export type MenuStage = "root" | "query" | "initialize" | "write";
export type WorkbenchAction =
  | "root"
  | "query_menu"
  | "automation_status"
  | "initialize_store"
  | "initialize_7"
  | "initialize_15"
  | "initialize_30"
  | "initialize_custom"
  | "write_menu"
  | "query_recent_online"
  | "query_recent_cooperation"
  | "query_product_rank"
  | "query_creator_custom"
  | "query_roi_recent"
  | "query_export_help"
  | "write_online_latest"
  | "write_online_all"
  | "write_roi_7"
  | "write_roi_30"
  | "write_custom"
  | "write_requirements"
  | "delete_roi_product"
  | "job_status"
  | "my_role"
  | "reset_context";

export interface WorkbenchResolution {
  kind: "menu" | "command" | "message" | "reset" | "status";
  action: WorkbenchAction;
  nextStage?: MenuStage;
  command?: string;
  message?: string;
}

export interface ProductApprovalAction {
  productIds: string[];
  suggestedName: string;
}

export interface PrivateWorkbenchStore {
  tenantId: string;
  displayName: string;
}

export function buildPrivateWorkbenchCard(
  stores: PrivateWorkbenchStore[],
): Record<string, unknown> {
  const available = stores.filter((store) => store.tenantId && store.displayName).slice(0, 10);
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: { template: "purple", title: plain("私聊经营工作区") },
    elements: [
      markdown("先选择要进入的店铺。选中后，菜单按钮和后续文字会继续使用同一家店；需要跨店时仍可直接用自然语言比较。"),
      ...chunk(available, 5).map((row) => actions(row.map((store, index) => button(
        store.displayName,
        "root",
        index === 0 ? "primary" : "default",
        store.tenantId,
      )))),
      note("示例：比较所有店最近7天销售额；或点击店铺后问“最近哪个商品卖得最好”。店铺选择2小时后自动失效。"),
    ],
  };
}

export function buildProductApprovalCard(
  items: PendingProductApproval[],
  profile: BusinessProfile,
  tenantId: string,
): Record<string, unknown> {
  const groups = groupPendingProducts(items);
  const shown = groups.slice(0, 5);
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: { template: "yellow", title: plain(`${profile.businessDisplayName} · 新商品确认`) },
    elements: [
      markdown(`这一批识别出 **${groups.length} 个经营商品**，关联 ${items.length} 个 TikTok 商品 ID。颜色变体和重复上架已合并，不需要逐个确认。`),
      ...shown.flatMap((group, index) => {
        const sample = group.items[0];
        const title = sample.sourceTitle.length > 100 ? `${sample.sourceTitle.slice(0, 100)}…` : sample.sourceTitle;
        const mergedNote = group.items.length > 1 ? `\n已合并：${group.items.length} 个同款商品 ID` : "";
        const description = `**${index + 1}. ${group.suggestedName ?? "暂时没想好简称"}**${mergedNote}\n标题示例：${title}\n首次发现：${group.firstSeenDate}`;
        const elements: Array<Record<string, unknown>> = [markdown(description)];
        if (group.suggestedName) {
          elements.push(actions([productApprovalButton(
            `确认“${group.suggestedName}”`, group.productIds, group.suggestedName, tenantId,
          )]));
        }
        return elements;
      }),
      note("想换名可以直接说“第2组改成二合一充电宝手电筒”；机器人会把这一组的全部商品 ID 一起归到新名称。"),
      groups.length > shown.length
        ? note(`当前先显示5组；还有 ${groups.length - shown.length} 组，处理完后发送“待确认商品”查看下一批。`)
        : note("多人可分别确认不同商品组；同一组以最先成功的名称为准，重复点击不会重复创建。"),
    ],
  };
}

export function buildWorkbenchCard(
  stage: MenuStage,
  role: BotRole,
  profile: BusinessProfile,
  tenantId?: string,
): Record<string, unknown> {
  if (stage === "query") return buildQueryCard(role, profile, tenantId);
  if (stage === "initialize") return buildInitializationCard(profile, tenantId);
  if (stage === "write") return buildWriteCard(role, profile, tenantId);
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: { template: "indigo", title: plain(`${profile.businessDisplayName} 经营机器人`) },
    elements: [
      markdown("直接点高频经营问题，或像和同事聊天一样自由提问。每个人的对话上下文相互独立。"),
      actions([
        button("近7天经营简报", "query_roi_recent", "primary", tenantId),
        button("近7天销售额榜", "query_product_rank", "default", tenantId),
        button("最新上线视频", "query_recent_online", "default", tenantId),
      ]),
      actions([
        button("查达人/商品", "query_creator_custom", "default", tenantId),
        button("自动同步状态", "automation_status", "default", tenantId),
        button("初始化/补齐数据", "initialize_store", "default", tenantId),
      ]),
      note("按钮采用固定统计口径，适合快速看经营重点；复杂问题直接说人话即可。上下文2小时自动失效。"),
    ],
  };
}

function buildQueryCard(_role: BotRole, profile: BusinessProfile, tenantId?: string): Record<string, unknown> {
  const queryButtons = [
    button("近7天经营简报", "query_roi_recent", "primary", tenantId),
    button("近7天销售额榜", "query_product_rank", "default", tenantId),
    button("最新上线视频", "query_recent_online", "default", tenantId),
    button("查达人/商品", "query_creator_custom", "default", tenantId),
    button("条件导出", "query_export_help", "default", tenantId),
  ];
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: { template: "blue", title: plain("查询") },
    elements: [
      markdown(`查询只读，不改表。可查 ${profile.tables.development}、${profile.tables.cooperation}、${profile.tables.online} 和 ${profile.tables.roi}。`),
      actions(queryButtons),
      actions([button("返回主菜单", "root", "default", tenantId)]),
      note("这些按钮只覆盖高频固定口径；其他问题直接自然语言提问。"),
    ],
  };
}

function buildInitializationCard(profile: BusinessProfile, tenantId?: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: { template: "yellow", title: plain(`${profile.businessDisplayName} · 初始化/补齐`) },
    elements: [
      markdown("你想核对并补齐多久的数据？已有记录会原地复核，不会重复创建。"),
      actions([
        button("最近7天", "initialize_7", "default", tenantId),
        button("最近15天", "initialize_15", "default", tenantId),
        button("最近30天", "initialize_30", "primary", tenantId),
        button("自定义天数", "initialize_custom", "default", tenantId),
      ]),
      actions([button("返回主菜单", "root", "default", tenantId)]),
      note("自定义可直接说：补齐最近20天。一次支持1至31天。"),
    ],
  };
}

function buildWriteCard(_role: BotRole, profile: BusinessProfile, tenantId?: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: { template: "indigo", title: plain("填表") },
    elements: [
      markdown(`聊天机器人现为只读查询入口。${profile.tables.online} 与 ${profile.tables.roi} 的 API 数据每天自动同步；API 没有的业务事实请在工作台人工填写。`),
      actions([
        button("自动同步状态", "automation_status", "primary", tenantId),
        button("返回主菜单", "root", "default", tenantId),
      ]),
    ],
  };
}

export function resolveWorkbenchAction(action: WorkbenchAction): WorkbenchResolution {
  switch (action) {
    case "root": return { kind: "menu", action, nextStage: "root" };
    case "query_menu": return { kind: "menu", action, nextStage: "query" };
    case "automation_status": return { kind: "status", action };
    case "initialize_store": return { kind: "menu", action, nextStage: "initialize" };
    case "initialize_7": return { kind: "message", action, message: "__INITIALIZE_DAYS__:7" };
    case "initialize_15": return { kind: "message", action, message: "__INITIALIZE_DAYS__:15" };
    case "initialize_30": return { kind: "message", action, message: "__INITIALIZE_DAYS__:30" };
    case "initialize_custom": return {
      kind: "message", action,
      message: "直接告诉我天数就行，例如：补齐最近20天。一次支持1至31天。",
    };
    case "write_menu": return legacyWriteMessage(action);
    case "query_recent_online": return {
      kind: "command",
      action,
      command: "【红人上线表固定查询】按实上线日期倒序显示最近5条上线视频",
    };
    case "query_recent_cooperation": return { kind: "command", action, command: "最近10条合作记录整理成表格" };
    case "query_product_rank": return { kind: "command", action, command: "近七天商品销售额最高前5名" };
    case "query_roi_recent": return {
      kind: "command",
      action,
      command: "【投产比固定经营简报】汇总最近7个完整日的店铺经营数据",
    };
    case "query_creator_custom": return {
      kind: "message", action,
      message: "🔎 把达人TK号或商品名发给我，再说你想看什么。\n\n例如：\n• graceguitron最近合作和上线怎么样？\n• 电动磨脚器近7天卖得怎么样？\n\n不用照抄，按平时说话就行。",
    };
    case "query_export_help": return {
      kind: "message", action,
      message: "直接说范围、字段、比较条件即可，例如：\n• 近30天店铺浏览量大于200的数据导出\n• 近7天单量大于0的商品数据导出\n阈值可以换成任意阿拉伯数字。",
    };
    case "write_online_latest": return legacyWriteMessage(action);
    case "write_online_all": return legacyWriteMessage(action);
    case "write_roi_7": return legacyWriteMessage(action);
    case "write_roi_30": return legacyWriteMessage(action);
    case "write_custom": return legacyWriteMessage(action);
    case "write_requirements": return {
      kind: "message", action,
      message: [
        "上线表补全需要：合作表有TK号、合作时间、寄样产品；TikTok API能查到同账号、合作当天或之后、且挂车商品相同的视频。",
        "投产比补全需要：日期范围内有已映射店铺商品和视频成交API数据。出单视频按商品+当天对出单视频ID去重自动填写；广告花费、广告出单、退货和自孵化数据仍需人工。",
        "查不到时会明确告诉你缺哪个字段、哪个商品未映射，或确实没有符合条件的视频/订单，不会生成假数据。",
      ].join("\n"),
    };
    case "delete_roi_product": return legacyWriteMessage(action);
    case "job_status": return { kind: "status", action };
    case "my_role": return {
      kind: "message", action,
      message: "这个店铺群里的成员使用相同功能。每个人的查询上下文独立，补齐任务按店铺排队执行。",
    };
    case "reset_context": return { kind: "reset", action };
  }
}

export function parseCardAction(value: unknown): WorkbenchAction | null {
  if (!value || typeof value !== "object") return null;
  const action = String((value as Record<string, unknown>).tw_action ?? "");
  return WORKBENCH_ACTIONS.has(action as WorkbenchAction) ? action as WorkbenchAction : null;
}

export function parseProductApprovalAction(value: unknown): ProductApprovalAction | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.tw_action !== "confirm_product_name") return null;
  const rawProductIds = Array.isArray(record.product_ids)
    ? record.product_ids.map(String)
    : [String(record.product_id ?? "")];
  const productIds = [...new Set(rawProductIds.filter((id) => /^\d{10,30}$/.test(id)))];
  const suggestedName = String(record.suggested_name ?? "").trim();
  if (productIds.length === 0 || productIds.length > 30 || !suggestedName || suggestedName.length > 40) return null;
  return { productIds, suggestedName };
}

export function parseCardTenantId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const tenantId = String((value as Record<string, unknown>).tenant_id ?? "");
  return /^[a-z0-9][a-z0-9_-]{1,39}$/.test(tenantId) ? tenantId : null;
}

export function resolveMenuText(text: string, stage: MenuStage): WorkbenchAction | null {
  const normalized = text.trim();
  if (/^(?:菜单|工作台|开始|操作|返回主菜单)$/.test(normalized)) return "root";
  if (/^(?:查询|查数据)$/.test(normalized)) return "query_menu";
  if (/^(?:填表|补表|写表)$/.test(normalized)) return "write_menu";
  if (/^(?:自动同步状态|同步状态|定时任务状态|今天同步了吗)$/.test(normalized)) return "automation_status";
  if (stage === "root") return normalized === "1" ? "query_menu" : normalized === "2" ? "automation_status" : null;
  if (stage === "query") {
    return ({ "1": "query_roi_recent", "2": "query_product_rank", "3": "query_recent_online", "4": "query_creator_custom", "5": "query_export_help" } as const)[normalized] ?? null;
  }
  if (stage === "initialize") {
    return ({ "1": "initialize_7", "2": "initialize_15", "3": "initialize_30", "4": "initialize_custom" } as const)[normalized] ?? null;
  }
  return ({ "1": "write_online_latest", "2": "write_online_all", "3": "write_roi_7", "4": "write_roi_30", "5": "write_custom" } as const)[normalized] ?? null;
}

export function isPrivateWorkbenchMenuText(text: string): boolean {
  return /^(?:菜单|工作台|开始|操作|返回主菜单|帮助|help|怎么问)$/i.test(text.trim());
}

const WORKBENCH_ACTIONS = new Set<WorkbenchAction>([
  "root", "query_menu", "automation_status", "initialize_store", "initialize_7", "initialize_15", "initialize_30", "initialize_custom", "write_menu", "query_recent_online", "query_recent_cooperation", "query_product_rank",
  "query_creator_custom", "query_roi_recent", "query_export_help", "write_online_latest",
  "write_online_all", "write_roi_7", "write_roi_30", "write_custom", "write_requirements",
  "delete_roi_product", "job_status", "my_role", "reset_context",
]);

function legacyWriteMessage(action: WorkbenchAction): WorkbenchResolution {
  return {
    kind: "message",
    action,
    message: "填表已改为每日自动同步，聊天机器人只提供查询。API 未提供的字段请在经营工作台人工补充；可发送“自动同步状态”查看进度。",
  };
}

function plain(content: string): Record<string, string> {
  return { tag: "plain_text", content };
}

function markdown(content: string): Record<string, unknown> {
  return { tag: "markdown", content };
}

function note(content: string): Record<string, unknown> {
  return { tag: "note", elements: [{ tag: "plain_text", content }] };
}

function actions(items: Array<Record<string, unknown>>): Record<string, unknown> {
  return { tag: "action", actions: items };
}

function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

function button(
  content: string,
  action: WorkbenchAction,
  type: "default" | "primary" = "default",
  tenantId?: string,
): Record<string, unknown> {
  return {
    tag: "button",
    text: plain(content),
    type,
    value: { tw_action: action, version: 1, ...(tenantId ? { tenant_id: tenantId } : {}) },
  };
}

function productApprovalButton(
  content: string,
  productIds: string[],
  suggestedName: string,
  tenantId: string,
): Record<string, unknown> {
  return {
    tag: "button",
    text: plain(content),
    type: "primary",
    value: {
      tw_action: "confirm_product_name",
      version: 1,
      tenant_id: tenantId,
      product_ids: productIds,
      suggested_name: suggestedName,
    },
  };
}

interface PendingProductGroup {
  suggestedName: string | null;
  productIds: string[];
  items: PendingProductApproval[];
  firstSeenDate: string;
}

function groupPendingProducts(items: PendingProductApproval[]): PendingProductGroup[] {
  const groups = new Map<string, PendingProductGroup>();
  for (const item of items) {
    const suggestedName = item.suggestedName?.trim() || null;
    const key = suggestedName ? `name:${suggestedName.toLocaleLowerCase("zh-CN")}` : `id:${item.productId}`;
    const current = groups.get(key);
    if (current) {
      current.items.push(item);
      current.productIds.push(item.productId);
      if (item.firstSeenDate < current.firstSeenDate) current.firstSeenDate = item.firstSeenDate;
      continue;
    }
    groups.set(key, {
      suggestedName,
      productIds: [item.productId],
      items: [item],
      firstSeenDate: item.firstSeenDate,
    });
  }
  return [...groups.values()];
}
