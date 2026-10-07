import * as lark from "@larksuiteoapi/node-sdk";
import { acquireBotInstanceLock } from "../automation/bot-instance-lock.js";
import { ShopRiskService } from "../shop-risk/service.js";
import { RealtimeVideoAnalysisService } from "../video-analysis/realtime-service.js";
import { GuardStartupQueue } from "../automation/guard-startup-queue.js";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  allowedUserIds,
  getEnv,
  privateUserIds,
  requireFeishuEnv,
} from "../config/env.js";
import {
  TenantRegistry,
  tenantScheduleAdmins,
  type ResolvedTenant,
} from "../config/tenant-registry.js";
import {
  assertFeishuResponse,
  createFeishuClient,
  feishuRetryDelayMs,
  withFeishuRetry,
} from "../feishu/client.js";
import { formatFeishuFileUploadError } from "../feishu/file-upload-error.js";
import {
  DuplicateCellFlagService,
  duplicateTargetsForProfile,
} from "../feishu/duplicate-cell-flags.js";
import { FeishuBitableDataSource } from "../feishu/data-source.js";
import { ProcessingReactionService } from "../feishu/processing-reaction.js";
import { RoiRecordGuardService } from "../feishu/roi-record-guard.js";
import { OnlineLaunchDateGuardService } from "../feishu/online-date-guard.js";
import { CooperationOnlineProgressService } from "../feishu/cooperation-online-progress.js";
import { createModelProvider } from "../ai/providers.js";
import { assertUserAllowed } from "../bot/auth.js";
import {
  PrivateAccessRegistry,
  parsePrivateAccessCommand,
  type PrivateAccessCommand,
} from "../bot/private-access.js";
import {
  assertCanPerform,
  queryOperation,
  roleForUser,
  type BotRole,
} from "../bot/access-control.js";
import {
  buildWorkbenchCard,
  buildPrivateWorkbenchCard,
  buildProductApprovalCard,
  isPrivateWorkbenchMenuText,
  parseCardAction,
  parseProductApprovalAction,
  parseCardTenantId,
  resolveMenuText,
  resolveWorkbenchAction,
  type MenuStage,
  type WorkbenchAction,
} from "../bot/workbench-menu.js";
import { logQuery } from "../bot/query-log.js";
import { answerQuestionWithContext, emptyConversationContext } from "../bot/service.js";
import {
  isBasicConversationCandidate,
  resolveBasicConversationReply,
} from "../bot/basic-conversation.js";
import {
  isGroupChatType,
  privateConversationSessionKey,
  storeConversationSessionKey,
} from "../bot/conversation-scope.js";
import { isClarificationError } from "../query/errors.js";
import { mergeClarificationReply, sessionIsFresh, type PendingClarificationState } from "../bot/conversation.js";
import { StoreMemoryService } from "../bot/store-memory.js";
import { loadDailyReportPaidSnapshot } from "../bot/daily-report-paid-snapshot.js";
import { loadPeriodicReportPaidSnapshot } from "../bot/periodic-report-paid-snapshot.js";
import {
  PreparedGroupReportService,
  type PreparedGroupReportPreparationResult,
} from "../bot/prepared-group-reports.js";
import { ProductSpikeMonitorService } from "../bot/product-spike-monitor.js";
import { loadProductSpikeSnapshot } from "../bot/product-spike-snapshot.js";
import { redactMessageForModel, validateMessageUnderstanding } from "../bot/message-understanding.js";
import { extractKnowledgeDocument, readFeishuMessageFile } from "../bot/knowledge-document.js";
import { normalizeFeishuMessageText } from "../bot/message-text.js";
import { DailyAutomationService, summarizeAutomationError, summarizePendingItems } from "../automation/daily-sync.js";
import { isManualWriteRequest, QUERY_ONLY_WRITE_MESSAGE } from "../bot/query-only-policy.js";
import {
  isAutomaticSyncResultRequest,
  isBusinessBaseLinkRequest,
  isLatestBusinessDataRequest,
  isScheduleExpectationRequest,
  isTaskStatusRequest,
  parseStoreInitializationCommand,
} from "../bot/direct-intent.js";
import { TenantQueryExecutor } from "../bot/tenant-query-executor.js";
import { SharedCardDeduper } from "../bot/shared-card-deduper.js";
import { parseScheduleCommand } from "../bot/schedule-command.js";
import { isReportDeliveryWindow } from "../automation/report-priority.js";
import {
  CrossTenantQueryService,
  emptyCrossTenantContext,
  type CrossTenantConversationContext,
} from "../bot/cross-tenant-query.js";
import {
  PrivateStoreModeRegistry,
  resolvePrivateStoreMenuTarget,
  shouldUseSelectedPrivateStore,
  type PrivateStoreDescriptor,
} from "../bot/private-store-mode.js";
import type { MessageUnderstanding, ModelProvider } from "../ai/types.js";
import type { ConversationContext } from "../types/index.js";

await acquireBotInstanceLock();
console.log(`[bot-process-start] ${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}`);
process.on("exit", (code) => {
  console.log(`[bot-process-exit] ${JSON.stringify({ pid: process.pid, code, at: new Date().toISOString() })}`);
});
const env = requireFeishuEnv(getEnv());
const allowed = allowedUserIds(env);
const client = createFeishuClient(env);
const tenantRegistry = new TenantRegistry(env);
const configuredPrivateIds = String(process.env[tenantRegistry.privateAccess.userIdsEnv] ?? "").trim();
const bootstrapPrivateAdmins = configuredPrivateIds
  ? new Set(configuredPrivateIds.split(",").map((item) => item.trim()).filter(Boolean))
  : privateUserIds(env);
const privateAccess = new PrivateAccessRegistry(
  bootstrapPrivateAdmins,
  resolve(".runtime", "private-access.json"),
);
if (tenantRegistry.privateAccess.enabled && privateAccess.size === 0) {
  throw new Error(`${tenantRegistry.privateAccess.userIdsEnv} 为空；为避免未授权人员在私聊中读取全部店铺，机器人未启动`);
}
interface StoreRuntime {
  tenant: ResolvedTenant;
  dataSource: FeishuBitableDataSource;
  provider: ModelProvider;
  dailyAutomation: DailyAutomationService;
  preparedGroupReports: PreparedGroupReportService;
  shopRisk: ShopRiskService;
  productSpikeMonitor: ProductSpikeMonitorService | null;
  duplicateFlags: DuplicateCellFlagService;
  roiRecordGuard: RoiRecordGuardService;
  onlineDateGuard: OnlineLaunchDateGuardService;
  cooperationOnlineProgress: CooperationOnlineProgressService;
  storeMemory: StoreMemoryService;
  scheduleAdmins: ReadonlySet<string>;
}
const runtimes = new Map<string, StoreRuntime>();
let realtimeVideoAnalysis: RealtimeVideoAnalysisService | undefined;
for (const tenant of tenantRegistry.all()) {
  const scheduleAdmins = tenantScheduleAdmins(tenant);
  const provider = createModelProvider(tenant.env);
  const dataSource = new FeishuBitableDataSource(tenant.env, client, tenant.profile);
  const preparedGroupReports = new PreparedGroupReportService({
    tenantId: tenant.binding.id,
    profile: tenant.profile,
    dataSource,
    provider,
    groupChatIds: () => tenantRegistry.groupRoutesForTenant(tenant.binding.id).map((route) => route.chatId),
    sendCard: sendGroupCard,
    loadDailyPaidSnapshot: (reportDate) => loadDailyReportPaidSnapshot(tenant.profile, reportDate),
    loadPeriodicPaidSnapshot: (startDate, endDate) => (
      loadPeriodicReportPaidSnapshot(tenant.profile, startDate, endDate)
    ),
    loadLatestRun: () => dailyAutomation.latestAutomaticRun(),
  });
  const dailyAutomation = new DailyAutomationService(
    tenant.env,
    client,
    tenant.profile,
    tenant.binding.id,
    provider,
    async (run) => {
      realtimeVideoAnalysis?.requestReconciliation(tenant.binding.id);
      const prepared = await preparedGroupReports.prepareRun(run);
      logPreparedGroupReportResult(
        tenant.binding.id,
        run.runId,
        prepared,
      );
      const lateDelivery = await preparedGroupReports.deliverRunIfDue(run);
      if (lateDelivery) {
        console.log(`[prepared-group-report-late-delivery:${tenant.binding.id}] ${JSON.stringify({
          sendDate: lateDelivery.sendDate,
          delivered: lateDelivery.delivered.map((item) => ({
            reportKey: item.reportKey,
            chatSuffix: item.chatId.slice(-6),
            messageId: item.messageId,
          })),
          pendingReportKeys: lateDelivery.pendingReportKeys,
          preparationErrors: lateDelivery.preparationErrors,
        })}`);
      }
    },
  );
  const productSpikeMonitor = tenant.profile.productSpikeMonitor?.enabled
    ? new ProductSpikeMonitorService({
        tenantId: tenant.binding.id,
        profile: tenant.profile,
        pollMinutes: tenant.profile.productSpikeMonitor.pollMinutes,
        groupChatIds: () => tenantRegistry.groupRoutesForTenant(tenant.binding.id).map((route) => route.chatId),
        loadSnapshot: (businessDate) => loadProductSpikeSnapshot(tenant.profile, businessDate),
        sendCard: sendGroupCard,
        refreshVideoExposure: (videoId) => {
          if (isReportDeliveryWindow()) throw new Error("报告发送保护时段，视频详情回更延后；商品爆单监控继续");
          return dailyAutomation.refreshAttributedVideoExposure(videoId);
        },
      })
    : null;
  runtimes.set(tenant.binding.id, {
    tenant,
    dataSource,
    provider,
    dailyAutomation,
    preparedGroupReports,
    shopRisk: new ShopRiskService({ tenant, client,
      groupChatIds: () => tenantRegistry.groupRoutesForTenant(tenant.binding.id).map(route => route.chatId),
      sendCard: sendGroupCard,
    }),
    productSpikeMonitor,
    duplicateFlags: new DuplicateCellFlagService(
      tenant.env,
      client,
      duplicateTargetsForProfile(tenant.profile),
      () => dailyAutomation.isBusy() || isReportDeliveryWindow(),
    ),
    roiRecordGuard: new RoiRecordGuardService(
      tenant.env,
      client,
      tenant.profile,
      () => dailyAutomation.isBusy() || isReportDeliveryWindow(),
    ),
    onlineDateGuard: new OnlineLaunchDateGuardService(
      tenant.env,
      client,
      scheduleAdmins,
      resolve(".runtime", "tenants", tenant.binding.id, "online-date-guard-state.json"),
      tenant.profile,
    ),
    cooperationOnlineProgress: new CooperationOnlineProgressService(
      tenant.env,
      client,
      tenant.profile,
      () => dailyAutomation.isBusy() || isReportDeliveryWindow(),
    ),
    storeMemory: new StoreMemoryService(tenant.binding.id),
    scheduleAdmins,
  });
  console.log(`[tenant] ${JSON.stringify({
    id: tenant.binding.id,
    store: tenant.profile.businessDisplayName,
    groups: tenantRegistry.groupRoutesForTenant(tenant.binding.id).length,
    provider: provider.name,
    model: provider.name === "deepseek" ? tenant.env.DEEPSEEK_MODEL : null,
  })}`);
}
const queryExecutor = new TenantQueryExecutor(tenantRegistry.globalQueryConcurrency);
const crossTenantQuery = new CrossTenantQueryService(
  [...runtimes.values()].map((runtime) => ({
    id: runtime.tenant.binding.id,
    displayName: runtime.tenant.profile.businessDisplayName,
    aliases: [runtime.tenant.profile.tiktok.shopAlias],
    profile: runtime.tenant.profile,
    dataSource: runtime.dataSource,
    queryConcurrency: runtime.tenant.binding.queryConcurrency,
  })),
  runtimes.get(tenantRegistry.default().binding.id)!.provider,
  (tenantId, limit, operation) => queryExecutor.run(tenantId, limit, operation),
);
const privateStores: PrivateStoreDescriptor[] = [...runtimes.values()].map((runtime) => ({
  id: runtime.tenant.binding.id,
  displayName: runtime.tenant.profile.businessDisplayName,
  aliases: [runtime.tenant.profile.tiktok.shopAlias],
}));
const processingReactions = new ProcessingReactionService(client);
const handled = new Set<string>();
const sessions = new Map<string, UserSession>();
const crossTenantSessions = new Map<string, CrossTenantConversationContext>();
const SESSION_TTL_MS = 2 * 60 * 60_000;
const privateStoreModes = new PrivateStoreModeRegistry(SESSION_TTL_MS);
const sharedCardDeduper = new SharedCardDeduper();

interface UserSession {
  context: ConversationContext;
  pending: PendingClarificationState | null;
  pendingDocument: { fileName: string; content: string; createdAt: number } | null;
  pendingEntityLookup: boolean;
  menuStage: MenuStage;
  menuUpdatedAt: number;
  recentUserMessages: string[];
  recentAssistantMessages: string[];
  lastMessageAt: number;
}

const dispatcher = new lark.EventDispatcher({}).register({
  "card.action.trigger": async (event: any) => {
    const action = parseCardAction(event.action?.value);
    const productAction = parseProductApprovalAction(event.action?.value);
    const tenantId = parseCardTenantId(event.action?.value);
    const userId = String(event.operator?.open_id ?? event.open_id ?? "");
    const messageId = String(event.context?.open_message_id ?? event.open_message_id ?? "");
    const cardChatId = String(event.context?.open_chat_id ?? "");
    const cardChatType = cardChatId && tenantRegistry.groupRoute(cardChatId) ? "group" : "p2p";
    if ((!action && !productAction) || !userId || !messageId) {
      return { toast: { type: "error", content: "无法识别这个菜单操作，请重新发送“菜单”。" } };
    }
    const runtime = tenantId
      ? runtimes.get(tenantId)
      : runtimeForEvent(cardChatId, cardChatType);
    if (!runtime) {
      return { toast: { type: "error", content: "这个菜单所属的店铺配置已停用，请重新发送“菜单”。" } };
    }
    try {
      assertTenantUserAllowed(userId, runtime, cardChatType);
    } catch (error) {
      return { toast: { type: "error", content: error instanceof Error ? error.message : String(error) } };
    }
    if (action && cardChatId && isSharedCardAction(action)) {
      const scope = isPerUserCardAction(action) ? userId : "shared";
      const dedupKey = `${runtime.tenant.binding.id}:${cardChatId}:${messageId}:${action}:${scope}`;
      if (!sharedCardDeduper.accept(dedupKey)) {
        return { toast: { type: "info", content: "刚刚已有同事点过，结果正在群里生成，不重复刷屏啦。" } };
      }
    }
    if (productAction && cardChatId) {
      const groupedIds = [...productAction.productIds].sort().join(",");
      const dedupKey = `${runtime.tenant.binding.id}:${cardChatId}:${messageId}:confirm_product:${groupedIds}`;
      if (!sharedCardDeduper.accept(dedupKey)) {
        return { toast: { type: "info", content: "这组商品刚刚已有同事确认，正在处理，不会重复写入。" } };
      }
    }
    const cardStarted = Date.now();
    const operationName = productAction ? "confirm_product_name" : action!;
    const operation = productAction
      ? handleProductApprovalAction(productAction, userId, messageId, runtime)
      : handleCardAction(action!, userId, messageId, runtime, cardChatId, cardChatType);
    void operation.then(() => {
      logQuery(userId, true, Date.now() - cardStarted, {
        channel: "card",
        mode: isGroupChatType(cardChatType) ? "group" : "private",
        tenantId: runtime.tenant.binding.id,
        operation: operationName,
        messageId,
      });
    }).catch(async (error) => {
      logQuery(userId, false, Date.now() - cardStarted, {
        channel: "card",
        mode: isGroupChatType(cardChatType) ? "group" : "private",
        tenantId: runtime.tenant.binding.id,
        operation: operationName,
        messageId,
        error,
      });
      try {
        await reply(messageId, `⚠️ 这个菜单操作没能完成：${friendlyBotError(error)}\n\n错误已经按店铺和聊天模式记录；可以原样再点一次，不用换说法。`);
      } catch {}
    });
    return { toast: { type: "info", content: "已收到，正在处理。" } };
  },
  "drive.file.bitable_record_changed_v1": async (event: any) => {
    realtimeVideoAnalysis?.handleRecordChanged(event);
    for (const runtime of runtimes.values()) {
      runtime.duplicateFlags.handleRecordChanged(event);
      runtime.roiRecordGuard.handleRecordChanged(event);
      runtime.onlineDateGuard.handleRecordChanged(event);
      runtime.cooperationOnlineProgress.handleRecordChanged(event);
    }
  },
  "im.message.receive_v1": async (event: any) => {
    const messageId = String(event.message?.message_id ?? "");
    if (!messageId || handled.has(messageId)) return;
    handled.add(messageId);
    if (handled.size > 1_000) handled.delete(handled.values().next().value as string);
    const userId = String(event.sender?.sender_id?.open_id ?? "");
    const started = Date.now();
    let success = false;
    let processingReaction: Promise<string | null> | null = null;
    let queryMode: "group" | "private" | "unknown" = "unknown";
    let queryTenantId: string | null = null;
    let queryOperationName: string | null = "message";
    let queryError: unknown = null;
    try {
      const chatId = String(event.message?.chat_id ?? "");
      const chatType = String(event.message?.chat_type ?? "");
      queryMode = isGroupChatType(chatType) ? "group" : "private";
      const messageType = String(event.message?.message_type ?? "");
      let incomingFile: { fileKey: string; fileName: string } | null = null;
      let question = "";
      if (messageType === "text") {
        const content = JSON.parse(String(event.message?.content ?? "{}")) as { text?: string };
        question = normalizeFeishuMessageText(
          content.text ?? "",
          Array.isArray(event.message?.mentions) ? event.message.mentions : [],
        );
        if (!question) throw new Error("问题不能为空");
      } else if (messageType === "file") {
        const content = JSON.parse(String(event.message?.content ?? "{}")) as { file_key?: string; file_name?: string };
        incomingFile = {
          fileKey: String(content.file_key ?? "").trim(),
          fileName: String(content.file_name ?? "").trim(),
        };
        if (!incomingFile.fileKey || !incomingFile.fileName) throw new Error("飞书没有提供完整的文件信息");
      } else {
        throw new Error("目前支持文字问题，以及TXT、Markdown、CSV、JSON、XLSX/XLS知识文件");
      }

      if (/^(?:我的open_id|我的用户ID|我是谁)$/i.test(question.trim())) {
        await reply(messageId, `你的飞书 open_id：${userId}\n\n只把它交给本公司机器人管理员，用于私聊白名单；不要当作TikTok或飞书密钥。`);
        success = true;
        return;
      }

      const groupBinding = parseGroupBindingCommand(question);
      if (groupBinding.matched) {
        if (!isGroupChatType(chatType)) throw new Error("只能在需要绑定的店铺群里执行这个命令");
        if (!privateAccess.isAdmin(userId)) throw new Error("只有私聊工作区管理员可以绑定店铺群");
        const tenantId = groupBinding.target
          ? resolveTenantTarget(groupBinding.target)
          : (tenantRegistry.all().length === 1 ? tenantRegistry.default().binding.id : null);
        if (!tenantId) throw new Error(bindingHelpText());
        const targetRuntime = runtimes.get(tenantId);
        if (!targetRuntime) throw new Error("没找到这家店，看看店铺名有没有写错。" );
        const bootstrapSession = getSession(storeConversationSessionKey(
          targetRuntime.tenant.binding.id,
          chatId,
          chatType,
          userId,
        ));
        await understandFreeText(question, bootstrapSession, targetRuntime, false);
        bootstrapSession.recentUserMessages = [
          ...bootstrapSession.recentUserMessages,
          redactMessageForModel(question),
        ].slice(-8);
        bootstrapSession.lastMessageAt = Date.now();
        const priorRoute = tenantRegistry.groupRoute(chatId);
        tenantRegistry.bindGroup(chatId, tenantId, userId);
        const initialization = await targetRuntime.dailyAutomation.initializationStatus();
        const needsInitialization = Boolean(
          !priorRoute
          && !targetRuntime.tenant.profile.templateMode
          && !initialization?.completed,
        );
        await reply(messageId, [
          priorRoute ? "这个群已经绑好啦，不用重复操作。" : "好啦，这个群已经认领自己的店铺。🎉",
          `店铺：${targetRuntime.tenant.profile.businessDisplayName}`,
          targetRuntime.tenant.profile.templateMode
            ? "不过它现在还是空白模板，接好 TikTok 店铺后才能自动更新。"
            : "以后在这个群里查询和自动更新，都会只看这家店的数据。",
          needsInitialization
            ? "连接已经具备。发送“菜单”选择首次补齐范围；确认范围后才会写入。"
            : "连接已经就绪。发送“菜单”开始使用，想复核时发“店铺配置”。",
        ].join("\n"));
        success = true;
        return;
      }
      if (parseGroupUnbindingCommand(question)) {
        if (!isGroupChatType(chatType)) throw new Error("只能在已绑定的店铺群里解除绑定");
        if (!privateAccess.isAdmin(userId)) throw new Error("只有私聊工作区管理员可以解除店铺群绑定");
        const removed = tenantRegistry.unbindGroup(chatId, userId);
        const removedRuntime = runtimes.get(removed.tenantId);
        await reply(messageId, [
          "已解除这个群的店铺绑定。",
          removedRuntime ? `原店铺：${removedRuntime.tenant.profile.businessDisplayName}` : null,
          "多维表格、定时任务和店铺数据都没有删除；这里只移除了群聊路由。",
        ].filter((line): line is string => line !== null).join("\n"));
        success = true;
        return;
      }

      let privateRuntime: StoreRuntime | null = null;
      if (!isGroupChatType(chatType)) {
        if (!tenantRegistry.privateAccess.enabled) throw new Error("当前没有开启机器人私聊工作区");
        const privateCommand = parsePrivateAccessCommand(question);
        if (privateCommand) {
          await handlePrivateAccessCommand(messageId, userId, privateCommand);
          success = true;
          return;
        }
        if (!privateAccess.has(userId)) {
          await reply(messageId, [
            "🔒 这个私聊工作区只对已授权人员开放。",
            "",
            `你的飞书 open_id：${userId}`,
            "请把它发给机器人管理员，由管理员私聊机器人发送：",
            `授权私聊 ${userId}`,
          ].join("\n"));
          success = true;
          return;
        }
        if (incomingFile) {
          await reply(messageId, "私聊同时连接多家店，不能猜这份知识属于哪一家。请把文件发到对应店铺群，或先用文字明确店铺名后再学习。");
          success = true;
          return;
        }
        const privateSessionKey = privateConversationSessionKey(userId);
        if (isPrivateWorkbenchMenuText(question)) {
          queryOperationName = "private_menu";
          await replyCard(messageId, buildPrivateWorkbenchCard(privateStores.map((store) => ({
            tenantId: store.id,
            displayName: store.displayName,
          }))));
          success = true;
          return;
        }
        const privateMenuTenantId = resolvePrivateStoreMenuTarget(question, privateStores);
        if (privateMenuTenantId) {
          const menuRuntime = runtimes.get(privateMenuTenantId);
          if (!menuRuntime) throw new Error("指定店铺已停用，请先检查租户配置");
          privateStoreModes.select(privateSessionKey, privateMenuTenantId);
          queryTenantId = privateMenuTenantId;
          queryOperationName = "private_store_menu";
          const menuSession = getSession(storeConversationSessionKey(
            privateMenuTenantId,
            chatId,
            chatType,
            userId,
          ));
          menuSession.menuStage = "root";
          menuSession.menuUpdatedAt = Date.now();
          await replyCard(messageId, buildWorkbenchCard(
            "root",
            roleForTenantUser(userId, menuRuntime, chatType),
            menuRuntime.tenant.profile,
            privateMenuTenantId,
          ));
          success = true;
          return;
        }
        if (isBasicConversationCandidate(question)) {
          const languageRuntime = runtimes.get(tenantRegistry.default().binding.id)!;
          const languageSession = getSession(`private-workspace:${userId}`);
          const languageUnderstanding = await understandFreeText(question, languageSession, languageRuntime, false);
          const basicReply = resolveBasicConversationReply(
            question,
            languageUnderstanding,
            "private",
            privateStores.map((store) => store.displayName),
          );
          if (basicReply) {
            queryOperationName = "basic_conversation";
            await reply(messageId, basicReply);
            rememberAssistantReply(languageSession, basicReply);
            success = true;
            return;
          }
        }
        processingReaction = processingReactions.add(messageId);
        const crossContext = getCrossTenantSession(privateSessionKey);
        const selectedTenantId = privateStoreModes.current(privateSessionKey);
        if (selectedTenantId && shouldUseSelectedPrivateStore(question, crossContext, privateStores)) {
          privateRuntime = runtimes.get(selectedTenantId) ?? null;
          if (!privateRuntime) privateStoreModes.clear(privateSessionKey);
        }
        if (!privateRuntime) {
          queryOperationName = "private_router";
          const crossResolution = await crossTenantQuery.resolve(question, crossContext);
          crossTenantSessions.set(privateSessionKey, crossResolution.context);
          if (crossResolution.kind === "answer") {
            await reply(messageId, crossResolution.text);
            success = true;
            return;
          }
          privateRuntime = runtimes.get(crossResolution.tenantId) ?? null;
          if (!privateRuntime) throw new Error("指定店铺已停用，请先检查租户配置");
          privateStoreModes.select(privateSessionKey, crossResolution.tenantId);
          question = crossResolution.question;
        }
      }

      const runtime = privateRuntime ?? runtimeForEvent(chatId, chatType);
      if (!runtime) {
        const fallbackRuntime = runtimes.get(tenantRegistry.default().binding.id);
        if (fallbackRuntime && question) {
          const unboundSession = getSession(`unbound:${chatId || "private"}:${userId}`);
          await understandFreeText(question, unboundSession, fallbackRuntime, false);
          unboundSession.recentUserMessages = [
            ...unboundSession.recentUserMessages,
            redactMessageForModel(question),
          ].slice(-8);
          unboundSession.lastMessageAt = Date.now();
        }
        await reply(messageId, bindingHelpText());
        success = true;
        return;
      }
      assertTenantUserAllowed(userId, runtime, chatType);
      queryTenantId = runtime.tenant.binding.id;
      processingReaction ??= processingReactions.add(messageId);
      const role = roleForTenantUser(userId, runtime, chatType);
      const sessionKey = storeConversationSessionKey(
        runtime.tenant.binding.id,
        chatId,
        chatType,
        userId,
      );
      const session = getSession(sessionKey);

      if (incomingFile) {
        const buffer = await readFeishuMessageFile(client, messageId, incomingFile.fileKey);
        const documentContent = extractKnowledgeDocument(incomingFile.fileName, buffer);
        session.pendingDocument = { fileName: incomingFile.fileName, content: documentContent, createdAt: Date.now() };
        await reply(messageId, [
          `📄 我已经读到《${incomingFile.fileName}》。`,
          "",
          "为了避免把临时文件或错误内容污染成长期规则，我还没有自动保存。",
          "确认要让这个店铺以后参考它，请回复“学习刚才文档”；不需要就回复“取消学习”。",
        ].join("\n"));
        success = true;
        return;
      }

      const menuAction = resolveMenuText(question, session.menuStage);
      if (menuAction) {
        queryOperationName = `menu:${menuAction}`;
        const resolution = resolveWorkbenchAction(menuAction);
        const command = await handleWorkbenchResolution(
          resolution,
          sessionKey,
          messageId,
          role,
          runtime,
        );
        if (!command) {
          success = true;
          return;
        }
        question = command;
      }

      const rawQuestion = question;
      const understanding = menuAction
        ? null
        : await understandFreeText(rawQuestion, session, runtime);
      if (!menuAction && understanding?.intentHint) queryOperationName = understanding.intentHint;
      let semanticQuestion = understanding && redactMessageForModel(rawQuestion) === rawQuestion
        ? understanding.rewrittenQuestion
        : rawQuestion;
      if (!menuAction && session.pendingEntityLookup) {
        session.pendingEntityLookup = false;
        if (isBareLookupEntity(rawQuestion)) {
          semanticQuestion = `${rawQuestion.trim()}的开发、合作、上线和经营综合情况`;
        }
      }
      if (!menuAction) {
        session.recentUserMessages = [
          ...session.recentUserMessages,
          redactMessageForModel(rawQuestion),
        ].slice(-8);
        session.lastMessageAt = Date.now();
      }

      if (/^(?:学习|记住|保存)(?:刚才|上个)(?:文档|文件)$/.test(question)) {
        if (!session.pendingDocument || Date.now() - session.pendingDocument.createdAt > 30 * 60_000) {
          session.pendingDocument = null;
          await reply(messageId, "刚才没有待学习的文件，或文件已超过30分钟。请重新上传一次。");
          success = true;
          return;
        }
        const pendingDocument = session.pendingDocument;
        session.pendingDocument = null;
        const learned = await runtime.storeMemory.learnDocument(
          pendingDocument.fileName,
          pendingDocument.content,
          userId,
        );
        await reply(messageId, [
          `🧠 已从《${pendingDocument.fileName}》提炼并保存 ${learned} 条店铺知识。`,
          "",
          "以后问到相关内容时会辅助理解；实时经营数字仍以多维表格为准。",
        ].join("\n"));
        success = true;
        return;
      }
      if (/^(?:取消学习|不要学习刚才(?:文档|文件))$/.test(question) && session.pendingDocument) {
        session.pendingDocument = null;
        await reply(messageId, "好，刚才的文件没有进入店铺长期记忆。");
        success = true;
        return;
      }

      if (/^ping(?:[-_ ].*)?$/i.test(question)) {
        await reply(messageId, `PONG：机器人在线；时间 ${new Date().toLocaleString("zh-CN", { hour12: false })}`);
        success = true;
        return;
      }
      if (/^(?:tables?|table[-_ ]?list|表清单|数据表清单)$/i.test(question)) {
        const names = await runtime.dataSource.getTableNames();
        await reply(messageId, `当前可访问的数据表（${names.length}张）：\n${names.map((name, index) => `${index + 1}. ${name}`).join("\n")}`);
        success = true;
        return;
      }
      if (isBusinessBaseLinkRequest(question)
        || isBusinessBaseLinkRequest(semanticQuestion)
        || understanding?.intentHint === "base_link") {
        const url = runtime.tenant.env.FEISHU_BITABLE_URL.trim();
        await reply(messageId, url
          ? `当然可以，这是 ${runtime.tenant.profile.businessDisplayName} 的经营工作台：\n${url}`
          : "这家店的多维表格还没接好，所以我现在没有可用链接。接好后再问我一次就行。"
        );
        success = true;
        return;
      }
      if (/^(?:reset|清除上下文|重置上下文|重新开始)$/i.test(question)) {
        sessions.delete(sessionKey);
        if (!isGroupChatType(chatType)) {
          const privateSessionKey = privateConversationSessionKey(userId);
          privateStoreModes.clear(privateSessionKey);
          crossTenantSessions.delete(privateSessionKey);
        }
        await reply(messageId, "已清除本轮对话上下文。下一条问题会重新判断达人、产品和数据表。");
        success = true;
        return;
      }

      const memoryAction = await runtime.storeMemory.handleMessage(question, userId);
      if (memoryAction) {
        await reply(messageId, memoryAction.text);
        success = true;
        return;
      }
      if (/^(?:help|帮助|怎么问)$/i.test(question) || understanding?.intentHint === "help") {
        session.menuStage = "root";
        session.menuUpdatedAt = Date.now();
        await replyCard(messageId, buildWorkbenchCard(
          "root",
          role,
          runtime.tenant.profile,
          runtime.tenant.binding.id,
        ));
        success = true;
        return;
      }

      if (/^(?:取消|算了|不用了)$/i.test(question) && session.pending) {
        session.pending = null;
        await reply(messageId, "已取消刚才的追问。你可以直接问新的问题。");
        success = true;
        return;
      }

      if (isAutomaticSyncResultRequest(question)
        || isAutomaticSyncResultRequest(semanticQuestion)
        || understanding?.intentHint === "automatic_sync_result") {
        await reply(messageId, await runtime.dailyAutomation.automaticSyncResultText());
        success = true;
        return;
      }

      if (isLatestBusinessDataRequest(question)
        || isLatestBusinessDataRequest(semanticQuestion)
        || understanding?.intentHint === "latest_business_data") {
        const fixedQuestion = "查询最新完整日店铺经营数据，包括总单量、总销量、销售额、商品卡出单量、达人出单量和当天销售额最高商品";
        const storeKnowledge = await runtime.storeMemory.relevantFacts(fixedQuestion);
        const answer = await queryExecutor.run(
          runtime.tenant.binding.id,
          runtime.tenant.binding.queryConcurrency,
          () => answerQuestionWithContext(
            runtime.dataSource,
            runtime.provider,
            fixedQuestion,
            session.context,
            runtime.tenant.profile,
            storeKnowledge,
          ),
        );
        session.context = answer.context;
        await reply(messageId, answer.text);
        rememberAssistantReply(session, answer.text);
        success = true;
        return;
      }

      if (isTaskStatusRequest(question)
        || isTaskStatusRequest(semanticQuestion)
        || understanding?.intentHint === "task_status") {
        const text = await runtime.dailyAutomation.statusText("task");
        await reply(messageId, text);
        success = true;
        return;
      }

      if (isScheduleExpectationRequest(question)
        || isScheduleExpectationRequest(semanticQuestion)
        || understanding?.intentHint === "schedule_expectation") {
        const text = await runtime.dailyAutomation.scheduleExpectationText();
        await reply(messageId, text);
        success = true;
        return;
      }

      if (/^(?:待确认事项|待确认商品|还有什么没填|哪些没确认)$/i.test(question)
        || /^(?:待确认事项|待确认商品|还有什么没填|哪些没确认)$/i.test(semanticQuestion)
        || understanding?.intentHint === "pending_items") {
        const pendingProducts = await runtime.dailyAutomation.pendingProductApprovals();
        if (pendingProducts.length > 0) {
          await replyCard(messageId, buildProductApprovalCard(
            pendingProducts,
            runtime.tenant.profile,
            runtime.tenant.binding.id,
          ));
        } else {
          await reply(messageId, await runtime.dailyAutomation.pendingItemsText());
        }
        success = true;
        return;
      }

      const initializationCommand = parseStoreInitializationCommand(question);
      if (initializationCommand) {
        if (initializationCommand.days == null) {
          const initialization = await runtime.dailyAutomation.initializationStatus();
          if (initialization && !initialization.completed) {
            if (initialization.state === "running") {
              await reply(messageId, await runtime.dailyAutomation.statusText("task"));
              success = true;
              return;
            }
            const pendingProducts = await runtime.dailyAutomation.pendingProductApprovals();
            if (pendingProducts.length > 0) {
              await reply(messageId, await runtime.dailyAutomation.statusText("task"));
              await replyCard(messageId, buildProductApprovalCard(
                pendingProducts,
                runtime.tenant.profile,
                runtime.tenant.binding.id,
              ));
              success = true;
              return;
            }
            await reply(messageId, "收到，我现在接着上次的范围继续补齐。已有记录只复核，不会重复创建。⏳");
            void resumeStoreInitialization(messageId, runtime).catch(async (error) => {
              try { await reply(messageId, `这次没能继续：${friendlyBotError(error)}`); } catch {}
            });
            success = true;
            return;
          }
          if (initializationCommand.resume) {
            await reply(messageId, "目前没有中断中的补齐任务。请先选择最近7天、15天、30天，或直接说“补齐最近20天”。");
            success = true;
            return;
          }
          session.menuStage = "initialize";
          session.menuUpdatedAt = Date.now();
          await replyCard(messageId, buildWorkbenchCard(
            "initialize",
            role,
            runtime.tenant.profile,
            runtime.tenant.binding.id,
          ));
          success = true;
          return;
        }
        if (initializationCommand.days < 1 || initializationCommand.days > 31) {
          await reply(messageId, "为了避免一次改动太大，目前每次可以补齐1至31天。你可以说“补齐最近30天”。");
          success = true;
          return;
        }
        await reply(
          messageId,
          initializationCommand.force
            ? [
                `⏳ 已开始重新核对最近${initializationCommand.days}个完整日。`,
                "",
                "已有记录会原地复核，不会重复创建。期间可以继续查询或打开菜单，不会打断后台任务。",
                "想看进度时，直接问“任务状态”。",
              ].join("\n")
            : [
                `⏳ 已开始初始化最近${initializationCommand.days}个完整日。`,
                "",
                "期间可以继续查询或打开菜单，不会打断后台任务。",
                "想看进度时，直接问“任务状态”。",
              ].join("\n"),
        );
        void runStoreInitialization(
          messageId,
          runtime,
          initializationCommand.days,
          initializationCommand.force,
        ).catch(async (error) => {
          try { await reply(messageId, `这次没能完成：${friendlyBotError(error)}`); } catch {}
        });
        success = true;
        return;
      }

      const productNameCommand = parseProductNameCommand(question);
      if (productNameCommand) {
        const result = await confirmProductGroup(
          [productNameCommand.productId],
          productNameCommand.name,
          userId,
          runtime,
        );
        await finishProductConfirmation(messageId, runtime, result, 1);
        success = true;
        return;
      }

      const friendlyProductNameCommand = await parseFriendlyProductNameCommand(
        question,
        runtime.dailyAutomation,
      );
      if (friendlyProductNameCommand) {
        const result = await confirmProductGroup(
          friendlyProductNameCommand.productIds,
          friendlyProductNameCommand.name,
          userId,
          runtime,
        );
        await finishProductConfirmation(messageId, runtime, result, friendlyProductNameCommand.productIds.length);
        success = true;
        return;
      }

      if (/^(?:当前店铺|店铺配置|本群店铺|当前租户)$/i.test(question)
        || /^(?:当前店铺|店铺配置|本群店铺|当前租户)$/i.test(semanticQuestion)
        || understanding?.intentHint === "store_config") {
        const route = tenantRegistry.groupRoute(chatId);
        const bindingStatus = route
          ? "已经和本群专属绑定"
          : isGroupChatType(chatType)
            ? "还没有专属绑定"
            : "私聊默认店铺";
        await reply(messageId, [
          `这个群现在看的是：${runtime.tenant.profile.businessDisplayName}`,
          `群店关系：${bindingStatus}`,
          `多维表格：${runtime.tenant.env.FEISHU_BITABLE_APP_TOKEN ? "已连接" : "还没连接"}`,
          `TikTok：${runtime.tenant.profile.templateMode ? "还没接入" : runtime.tenant.profile.tiktok.shopAlias}`,
          `智能问答：${runtime.provider.name === "deepseek" ? "已连接" : "使用本地规则"}`,
          "自动更新情况可以直接问我：“今天同步了吗？”",
        ].join("\n"));
        success = true;
        return;
      }

      const scheduleCommand = parseScheduleCommand(question);
      if (scheduleCommand) {
        await runtime.dailyAutomation.updateSchedule(scheduleCommand, userId);
        await reply(messageId, `好嘞，设置改好了。\n${await runtime.dailyAutomation.statusText()}`);
        success = true;
        return;
      }

      if (isManualWriteRequest(question)) {
        await reply(messageId, QUERY_ONLY_WRITE_MESSAGE);
        success = true;
        return;
      }

      const basicConversationReply = resolveBasicConversationReply(
        rawQuestion,
        understanding,
        isGroupChatType(chatType) ? "group" : "private",
        privateStores.map((store) => store.displayName),
      );
      if (basicConversationReply) {
        queryOperationName = "basic_conversation";
        await reply(messageId, basicConversationReply);
        rememberAssistantReply(session, basicConversationReply);
        success = true;
        return;
      }

      let workingQuestion = semanticQuestion;
      let clarificationAttempts = 0;
      if (session.pending) {
        clarificationAttempts = session.pending.attempts;
        if (isLikelyClarificationReply(question, session.pending.options)) {
          workingQuestion = mergeClarificationReply(session.pending.question, semanticQuestion, session.pending.options);
        }
        session.pending = null;
      }

      try {
        assertCanPerform(role, queryOperation(workingQuestion));
        const storeKnowledge = await runtime.storeMemory.relevantFacts(workingQuestion);
        const answer = await queryExecutor.run(
          runtime.tenant.binding.id,
          runtime.tenant.binding.queryConcurrency,
          () => answerQuestionWithContext(
            runtime.dataSource,
            runtime.provider,
            workingQuestion,
            session.context,
            runtime.tenant.profile,
            storeKnowledge,
          ),
        );
        session.context = answer.context;
        await reply(messageId, answer.text);
        rememberAssistantReply(session, answer.text);
        if (answer.exportFile) {
          try {
            await replyFile(messageId, answer.exportFile.fileName, answer.exportFile.content);
          } catch (error) {
            await reply(messageId, `筛选已经完成，但CSV文件上传失败：${formatFeishuFileUploadError(error)}`);
          }
        }
        success = true;
      } catch (error) {
        if (isClarificationError(error)) {
          if (clarificationAttempts >= 2) {
            session.pending = null;
            await reply(messageId, "📌 我能想到不止一种业务口径，而不同口径会改变答案，所以这里需要你选一下。\n\n直接告诉我按销售额、销量还是单量看即可；不需要重写整句话。");
            success = true;
            return;
          }
          session.pending = {
            question: workingQuestion,
            options: error.options,
            createdAt: Date.now(),
            attempts: clarificationAttempts + 1,
          };
          const options = error.options.length > 0 ? `\n可直接回复：${error.options.join(" / ")}` : "";
          await reply(messageId, `${error.prompt}${options}`);
          success = true;
          return;
        }
        throw error;
      }
    } catch (error) {
      queryError = error;
      console.error(`[query] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      await reply(messageId, "⚠️ 这次是我处理查询时出了技术问题，不是你说得不够清楚。\n\n我没有拿不确定的数据凑答案，错误已经记进内部日志。你可以继续问别的问题，不需要照固定句式重说。\n\n🎯 如果同一个问题再次失败，我会按原问题继续排查，而不是让你反复换说法。");
    } finally {
      if (processingReaction) {
        const reactionId = await processingReaction;
        if (reactionId) await processingReactions.remove(messageId, reactionId);
      }
      logQuery(userId, success, Date.now() - started, {
        channel: "message",
        mode: queryMode,
        tenantId: queryTenantId,
        operation: queryOperationName,
        messageId,
        error: queryError,
      });
    }
  },
});

function isSharedCardAction(action: WorkbenchAction): boolean {
  return [
    "query_menu",
    "query_recent_online",
    "query_recent_cooperation",
    "query_product_rank",
    "query_creator_custom",
    "query_roi_recent",
    "query_export_help",
    "automation_status",
    "initialize_store",
    "initialize_7",
    "initialize_15",
    "initialize_30",
  ].includes(action);
}

function isPerUserCardAction(action: WorkbenchAction): boolean {
  return [
    "query_menu",
    "query_recent_online",
    "query_recent_cooperation",
    "query_product_rank",
    "query_creator_custom",
    "query_roi_recent",
    "query_export_help",
    "automation_status",
  ].includes(action);
}

function getSession(sessionKey: string): UserSession {
  const existing = sessions.get(sessionKey);
  // 追问发生在首次查询前时，context.updatedAt 仍为0。
  // 必须把 pending.createdAt 也视为会话活动时间，否则用户下一句回复会丢失待确认状态。
  if (existing && (
    sessionIsFresh(existing.context, existing.pending, Date.now(), SESSION_TTL_MS)
    || Date.now() - existing.menuUpdatedAt < SESSION_TTL_MS
    || Date.now() - existing.lastMessageAt < SESSION_TTL_MS
  )) return existing;
  const created: UserSession = {
    context: emptyConversationContext(),
    pending: null,
    pendingDocument: null,
    pendingEntityLookup: false,
    menuStage: "root",
    menuUpdatedAt: 0,
    recentUserMessages: [],
    recentAssistantMessages: [],
    lastMessageAt: 0,
  };
  sessions.set(sessionKey, created);
  return created;
}

function getCrossTenantSession(sessionKey: string): CrossTenantConversationContext {
  const existing = crossTenantSessions.get(sessionKey);
  if (existing && Date.now() - existing.updatedAt < SESSION_TTL_MS) return existing;
  const created = emptyCrossTenantContext();
  crossTenantSessions.set(sessionKey, created);
  return created;
}

async function understandFreeText(
  question: string,
  session: UserSession,
  runtime: StoreRuntime,
  includeStoreKnowledge = true,
): Promise<MessageUnderstanding | null> {
  if (!runtime.provider.understandMessage) return null;
  const safeQuestion = redactMessageForModel(question);
  try {
    const relevantFacts = includeStoreKnowledge
      ? await runtime.storeMemory.relevantFacts(safeQuestion)
      : [];
    const understood = await runtime.provider.understandMessage(safeQuestion, {
      recentUserMessages: session.recentUserMessages.map(redactMessageForModel),
      recentAssistantMessages: session.recentAssistantMessages.map(redactMessageForModel),
      lastBusinessQuestion: session.context.lastQuestion
        ? redactMessageForModel(session.context.lastQuestion)
        : null,
      recentDomain: session.context.lastTableHint,
      storeKnowledge: relevantFacts.map(redactMessageForModel),
    });
    return validateMessageUnderstanding(safeQuestion, understood);
  } catch (error) {
    console.warn(`[understanding] ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function rememberAssistantReply(session: UserSession, text: string): void {
  session.recentAssistantMessages = [
    ...session.recentAssistantMessages,
    redactMessageForModel(text).slice(0, 2_000),
  ].slice(-4);
  session.lastMessageAt = Date.now();
}

function isLikelyClarificationReply(text: string, options: string[]): boolean {
  if (text.length <= 40) return true;
  return options.some((option) => text.includes(option));
}

function parseGroupBindingCommand(text: string): { matched: boolean; target: string | null } {
  if (/^(?:绑定当前群|绑定本群)$/.test(text)) return { matched: true, target: null };
  const matched = text.match(/^(?:绑定当前群到|将当前群绑定到|绑定本群到)\s*[:：]?\s*(.{1,80})$/i);
  return matched
    ? { matched: true, target: matched[1].trim() }
    : { matched: false, target: null };
}

function parseGroupUnbindingCommand(text: string): boolean {
  return /^(?:解绑当前群|解除当前群绑定|解绑本群)$/.test(text.trim());
}

function resolveTenantTarget(target: string): string | null {
  const normalized = target.trim().toLowerCase();
  const exactId = tenantRegistry.byId(normalized);
  if (exactId) return exactId.binding.id;
  const names = tenantRegistry.all().filter((tenant) => (
    tenant.profile.businessDisplayName.trim().toLowerCase() === normalized
    || tenant.profile.tiktok.shopAlias.trim().toLowerCase() === normalized
  ));
  return names.length === 1 ? names[0].binding.id : null;
}

function bindingHelpText(): string {
  const stores = tenantRegistry.all();
  if (stores.length === 1) return `这个群还没选店铺。发“绑定当前群”就行，我会把它和 ${stores[0].profile.businessDisplayName} 绑在一起。`;
  return [
    "这个群还没选店铺，所以我先不乱查。",
    "直接按店铺名绑定即可：",
    ...stores.map((tenant) => `• 绑定当前群到 ${tenant.profile.businessDisplayName}`),
  ].join("\n");
}

async function handleWorkbenchResolution(
  resolution: ReturnType<typeof resolveWorkbenchAction>,
  sessionKey: string,
  messageId: string,
  role: BotRole,
  runtime: StoreRuntime,
): Promise<string | null> {
  const session = getSession(sessionKey);
  if (resolution.kind === "menu") {
    session.menuStage = resolution.nextStage ?? "root";
    session.menuUpdatedAt = Date.now();
    await replyCard(messageId, buildWorkbenchCard(
      session.menuStage,
      role,
      runtime.tenant.profile,
      runtime.tenant.binding.id,
    ));
    return null;
  }
  if (resolution.kind === "reset") {
    sessions.delete(sessionKey);
    await reply(messageId, "已清除你自己的菜单状态、查询对象和待追问内容；不会影响其他人的会话或任务。");
    return null;
  }
  if (resolution.kind === "status") {
    await reply(messageId, await runtime.dailyAutomation.statusText());
    return null;
  }
  if (resolution.kind === "message") {
    const initializationDays = resolution.message?.match(/^__INITIALIZE_DAYS__:(\d{1,2})$/);
    if (initializationDays) {
      const days = Number(initializationDays[1]);
      await reply(messageId, [
        `⏳ 已开始核对最近${days}个完整日。`,
        "",
        "已有记录会复核，不会重复创建。期间可以继续查询或打开菜单，不会打断后台任务。",
        "想看进度时，直接问“任务状态”。",
      ].join("\n"));
      void runStoreInitialization(messageId, runtime, days, true).catch(async (error) => {
        try { await reply(messageId, `这次没能完成：${friendlyBotError(error)}`); } catch {}
      });
      return null;
    }
    if (resolution.action === "query_creator_custom") {
      session.pendingEntityLookup = true;
      session.menuUpdatedAt = Date.now();
      session.lastMessageAt = Date.now();
    }
    const message = resolution.message ?? "";
    await reply(messageId, message);
    return null;
  }
  return resolution.command ?? null;
}

function isBareLookupEntity(text: string): boolean {
  const value = text.trim().replace(/^@/, "");
  if (!value || value.length > 60 || /[？?，,。！!\n]/.test(value)) return false;
  return !/(?:查询|查看|最近|近\d|怎么样|多少|哪个|什么|开发|合作|上线|销量|销售|单量|经营|投产|数据|表格)/.test(value);
}

async function runStoreInitialization(
  messageId: string,
  runtime: StoreRuntime,
  days: number,
  force: boolean,
): Promise<void> {
  const result = await runtime.dailyAutomation.initializeRecentDays(days, force);
  await reportStoreInitializationResult(messageId, runtime, result, days);
}

async function resumeStoreInitialization(
  messageId: string,
  runtime: StoreRuntime,
): Promise<void> {
  const result = await runtime.dailyAutomation.resumeIncompleteInitialization();
  const days = result.status.requestedDays ?? 0;
  await reportStoreInitializationResult(messageId, runtime, result, days);
}

async function reportStoreInitializationResult(
  messageId: string,
  runtime: StoreRuntime,
  result: Awaited<ReturnType<DailyAutomationService["initializeRecentDays"]>>,
  requestedDays: number,
): Promise<void> {
  if (result.alreadyInitialized) {
    await reply(messageId, [
      "这家店的基础初始化已经完成啦。✅",
      result.status.windowStart && result.status.windowEnd
        ? `基础范围：${result.status.windowStart} 至 ${result.status.windowEnd}`
        : null,
      requestedDays > 0 ? `如果想重新核对，发送“补齐最近${requestedDays}天”。` : null,
    ].filter(Boolean).join("\n"));
    return;
  }
  const run = result.run;
  if (!run) throw new Error("初始化没有返回执行结果");
  const pendingProducts = await runtime.dailyAutomation.pendingProductApprovals();
  if (pendingProducts.length > 0) {
    await reply(messageId, [
      `这次先暂停在商品命名：还有 ${pendingProducts.length} 个新商品待确认。`,
      "可以分别确认或改名；最后一个确认完成后，我会自动续跑同一范围，不用再发“初始化店铺”。",
      "没有确认前，我不会拿英文长标题写进正式表。",
    ].join("\n"));
    await replyCard(messageId, buildProductApprovalCard(
      pendingProducts,
      runtime.tenant.profile,
      runtime.tenant.binding.id,
    ));
    return;
  }
  const onlineChanged = run.online.created + run.online.updated;
  const roiChanged = run.roi.created + run.roi.updated;
  const errors = [run.catalog.error, run.online.error, run.roi.error]
    .filter((item): item is string => Boolean(item))
    .map(friendlyBotError);
  const pending = summarizePendingItems([
    ...run.catalog.missingItems,
    ...run.online.missingItems,
    ...run.roi.missingItems,
  ]);
  await reply(messageId, [
    result.status.completed
      ? requestedDays > 0
        ? `✅ 最近${requestedDays}个接口完整日已经补齐。`
        : "✅ 本次接口完整日已经补齐。"
      : "这次任务已经停止，只完成了一部分；它没有继续藏在后台运行。",
    run.windowStart && run.windowEnd ? `范围：${run.windowStart} 至 ${run.windowEnd}` : null,
    "",
    `🎬 上线表：核对 ${run.online.matched} 条；新增 ${run.online.created}，更新 ${run.online.updated}`,
    `📊 投产比：核对 ${run.roi.matched} 条；新增 ${run.roi.created}，更新 ${run.roi.updated}`,
    onlineChanged === 0 && roiChanged === 0 ? "表里的数据本来就是最新的，没有重复创建。" : null,
    "",
    errors.length > 0 ? `停止原因：${errors.join("；")}` : null,
    pending.manualFields.length > 0 ? `✍️ 仍需人工补录：${pending.manualFields.join("、")}` : null,
    pending.warningDates.length > 0
      ? `⚠️ ${pending.warningDates.join("、")}存在接口归属差异：店铺层有出单视频，但TikTok没有归到具体商品；已保留店铺总数，没有乱分商品。`
      : null,
    pending.otherItems.length > 0 ? `🔎 另外还有 ${pending.otherItems.length} 项需要确认，发送“待确认事项”查看。` : null,
    result.status.completed ? "🎯 总结：自动数据已完成；上面的人工字段和接口提醒不代表补齐失败。" : null,
    !result.status.completed ? "修正后可以发送“继续补齐”，会按原范围幂等重试。" : null,
  ].filter((line): line is string => line !== null).join("\n"));
}

function friendlyBotError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return summarizeAutomationError(text
    .replace(/\b(?:rt|daily)-[a-zA-Z0-9-]+\b/g, "本次任务")
    .replace(/[A-Z]:\\[^\n；]+/g, "本地数据文件")
    .slice(0, 2_000));
}

async function handleCardAction(
  action: WorkbenchAction,
  userId: string,
  messageId: string,
  runtime: StoreRuntime,
  chatId: string,
  chatType: string,
): Promise<void> {
  const role = roleForTenantUser(userId, runtime, chatType);
  if (!isGroupChatType(chatType)) {
    privateStoreModes.select(privateConversationSessionKey(userId), runtime.tenant.binding.id);
  }
  const sessionKey = storeConversationSessionKey(
    runtime.tenant.binding.id,
    chatId,
    chatType,
    userId,
  );
  const resolution = resolveWorkbenchAction(action);
  const command = await handleWorkbenchResolution(
    resolution,
    sessionKey,
    messageId,
    role,
    runtime,
  );
  if (!command) return;

  assertCanPerform(role, queryOperation(command));
  const session = getSession(sessionKey);
  const storeKnowledge = await runtime.storeMemory.relevantFacts(command);
  const answer = await queryExecutor.run(
    runtime.tenant.binding.id,
    runtime.tenant.binding.queryConcurrency,
    () => answerQuestionWithContext(
      runtime.dataSource,
      runtime.provider,
      command,
      session.context,
      runtime.tenant.profile,
      storeKnowledge,
    ),
  );
  session.context = answer.context;
  await reply(messageId, answer.text);
  rememberAssistantReply(session, answer.text);
  if (answer.exportFile) {
    try {
      await replyFile(messageId, answer.exportFile.fileName, answer.exportFile.content);
    } catch (error) {
      await reply(messageId, `筛选已经完成，但CSV文件上传失败：${formatFeishuFileUploadError(error)}`);
    }
  }
}

async function handleProductApprovalAction(
  action: NonNullable<ReturnType<typeof parseProductApprovalAction>>,
  userId: string,
  messageId: string,
  runtime: StoreRuntime,
): Promise<void> {
  const result = await confirmProductGroup(
    action.productIds,
    action.suggestedName,
    userId,
    runtime,
  );
  await finishProductConfirmation(messageId, runtime, result, action.productIds.length);
}

async function confirmProductGroup(
  productIds: string[],
  name: string,
  userId: string,
  runtime: StoreRuntime,
): Promise<Awaited<ReturnType<DailyAutomationService["confirmProductName"]>>> {
  const results: Array<Awaited<ReturnType<DailyAutomationService["confirmProductName"]>>> = [];
  for (const productId of [...new Set(productIds)]) {
    results.push(await runtime.dailyAutomation.confirmProductName(productId, name, userId));
  }
  const resumeResult = results.find((item) => item.shouldResumeInitialization);
  const lastResult = results.at(-1);
  if (!lastResult) throw new Error("没有可确认的商品 ID");
  return resumeResult ? { ...lastResult, shouldResumeInitialization: true } : lastResult;
}

function parseProductNameCommand(text: string): { productId: string; name: string } | null {
  const matched = text.match(/^(?:确认商品名|商品命名)\s+(\d{10,30})\s+(.{1,40})$/);
  return matched ? { productId: matched[1], name: matched[2].trim() } : null;
}

function productConfirmationText(
  result: Awaited<ReturnType<DailyAutomationService["confirmProductName"]>>,
  groupSize = 1,
): string {
  if (result.alreadyConfirmed) {
    return [
      `${groupSize > 1 ? `这 ${groupSize} 个商品 ID` : "这个商品"}已经归类过啦，统一名称是“${result.canonicalName}”。`,
      result.remainingPending > 0 ? `这一批还有 ${result.remainingPending} 个商品 ID 待归类。` : null,
    ].filter(Boolean).join("\n");
  }
  return [
    groupSize > 1
      ? `好，已把这 ${groupSize} 个同款商品 ID 统一归为“${result.canonicalName}”。✅`
      : `好，商品名定为“${result.canonicalName}”。✅`,
    "合作表和上线表的商品选项已经补上。",
    result.remainingPending > 0
      ? `这一批还剩 ${result.remainingPending} 个商品 ID；全部归类后会自动继续原来的补齐任务。`
      : result.shouldResumeInitialization
        ? "这一批商品已经全部确认，原来的补齐任务现在自动继续。⏳"
        : result.firstSeenDate
          ? `已记住首次发现日 ${result.firstSeenDate}，下次同步会从这里复核。`
          : "商品映射已经保存。",
  ].filter(Boolean).join("\n");
}

async function finishProductConfirmation(
  messageId: string,
  runtime: StoreRuntime,
  result: Awaited<ReturnType<DailyAutomationService["confirmProductName"]>>,
  groupSize = 1,
): Promise<void> {
  await reply(messageId, productConfirmationText(result, groupSize));
  if (!result.shouldResumeInitialization || !result.initializationDays) return;
  void resumeStoreInitialization(messageId, runtime).catch(async (error) => {
    try {
      await reply(messageId, `商品已经确认，但原任务续跑失败：${friendlyBotError(error)}\n发送“任务状态”可以看当前停在哪一步。`);
    } catch {}
  });
}

async function parseFriendlyProductNameCommand(
  text: string,
  service: DailyAutomationService,
): Promise<{ productIds: string[]; name: string } | null> {
  const pending = await service.pendingProductApprovals();
  if (pending.length === 0) return null;
  const grouped = groupPendingForNaming(pending);
  const normalized = text.trim();
  const indexed = normalized.match(/^(?:第)?([0-9一二两三四五六七八九十]+)(?:个|件|组)?(?:商品)?(?:改名为|改成|叫)\s*(.{1,40})$/);
  if (indexed) {
    const index = parseSmallOrdinal(indexed[1]);
    const group = index == null ? null : grouped[index - 1];
    return group ? { productIds: group.map((item) => item.productId), name: indexed[2].trim() } : null;
  }
  const named = normalized.match(/^(.{1,50}?)(?:改名为|改成)\s*(.{1,40})$/);
  if (!named) return null;
  const source = named[1].trim().toLocaleLowerCase("zh-CN");
  const matches = grouped.filter((group) => group.some((item) => (
    item.suggestedName?.toLocaleLowerCase("zh-CN") === source
    || item.sourceTitle.toLocaleLowerCase("zh-CN") === source
  )));
  return matches.length === 1
    ? { productIds: matches[0].map((item) => item.productId), name: named[2].trim() }
    : null;
}

function groupPendingForNaming(
  pending: Awaited<ReturnType<DailyAutomationService["pendingProductApprovals"]>>,
): Array<typeof pending> {
  const groups = new Map<string, typeof pending>();
  for (const item of pending) {
    const name = item.suggestedName?.trim();
    const key = name ? `name:${name.toLocaleLowerCase("zh-CN")}` : `id:${item.productId}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function parseSmallOrdinal(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };
  return digits[value] ?? null;
}

function runtimeForEvent(chatId: string, chatType: string): StoreRuntime | null {
  try {
    const tenant = tenantRegistry.resolve(chatId, chatType);
    return runtimes.get(tenant.binding.id) ?? null;
  } catch {
    return null;
  }
}

function assertTenantUserAllowed(
  userId: string,
  runtime: StoreRuntime,
  chatType: string,
): void {
  const groupLike = /group|chat/i.test(chatType) && !/p2p|private/i.test(chatType);
  if (groupLike && runtime.tenant.binding.access.groupMembersEqual) return;
  if (!groupLike && privateAccess.has(userId)) return;
  assertUserAllowed(userId, groupLike ? allowed : new Set());
}

function roleForTenantUser(
  userId: string,
  runtime: StoreRuntime,
  chatType: string,
): BotRole {
  const groupLike = /group|chat/i.test(chatType) && !/p2p|private/i.test(chatType);
  return (!groupLike && privateAccess.has(userId))
    ? "admin"
    : groupLike && runtime.tenant.binding.access.groupMembersEqual
    ? "admin"
    : roleForUser(userId, runtime.tenant.env);
}

async function handlePrivateAccessCommand(
  messageId: string,
  operatorId: string,
  command: PrivateAccessCommand,
): Promise<void> {
  if (!privateAccess.isAdmin(operatorId)) {
    await reply(messageId, "🔒 只有私聊工作区管理员可以管理授权名单。\n\n查询店铺数据不受影响；如需授权，请联系管理员。" );
    return;
  }
  if (command.kind === "list") {
    const members = privateAccess.all();
    await reply(messageId, [
      `👥 当前共有 ${members.length} 人可使用私聊工作区：`,
      "",
      ...members.map((userId, index) => `${index + 1}. ${userId}${privateAccess.isAdmin(userId) ? "（管理员）" : ""}`),
      "",
      "新增：授权私聊 ou_xxx",
      "移除：取消私聊权限 ou_xxx",
    ].join("\n"));
    return;
  }
  if (command.kind === "grant") {
    const result = privateAccess.grant(command.userId);
    await reply(messageId, result === "added"
      ? `✅ 已允许 ${command.userId} 使用私聊工作区，立即生效，不用重启机器人。`
      : `ℹ️ ${command.userId} 已经有私聊权限，不需要重复添加。`);
    return;
  }
  const result = privateAccess.revoke(command.userId);
  const text = result === "removed"
    ? `✅ 已移除 ${command.userId} 的私聊权限，立即生效。`
    : result === "bootstrap_admin"
      ? "⚠️ 这是启动白名单中的管理员，不能在聊天里移除；如需更换，请修改 BOT_PRIVATE_USER_IDS 后重启。"
      : `ℹ️ ${command.userId} 原本就不在私聊授权名单里。`;
  await reply(messageId, text);
}

async function reply(messageId: string, text: string): Promise<void> {
  const uuid = randomUUID();
  await withFeishuRetry(async () => {
    const response = await client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "text", content: JSON.stringify({ text }), uuid },
    });
    assertFeishuResponse(response, "回复飞书消息");
    return response;
  }, { attempts: 4, baseDelayMs: 1_000 });
}

async function replyCard(messageId: string, card: Record<string, unknown>): Promise<void> {
  const uuid = randomUUID();
  await withFeishuRetry(async () => {
    const response = await client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "interactive", content: JSON.stringify(card), uuid },
    });
    assertFeishuResponse(response, "回复飞书卡片");
    return response;
  }, { attempts: 4, baseDelayMs: 1_000 });
}

async function sendGroupCard(
  chatId: string,
  card: Record<string, unknown>,
  idempotencyKey: string,
): Promise<string> {
  const uuid = deterministicUuid(idempotencyKey);
  return withFeishuRetry(async () => {
    const response = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
        uuid,
      },
    });
    assertFeishuResponse(response, "发送店铺群卡片");
    const messageId = String(response.data?.message_id ?? "").trim();
    if (!messageId) throw new Error("飞书发送日报成功但没有返回 message_id");
    return messageId;
  }, { attempts: 4, baseDelayMs: 1_000 });
}

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function replyFile(messageId: string, fileName: string, content: Buffer): Promise<void> {
  if (content.length === 0 || content.length > 30 * 1024 * 1024) {
    throw new Error("导出文件为空或超过飞书30MB限制");
  }
  const uploaded = await client.im.file.create({
    data: { file_type: "stream", file_name: fileName, file: content },
  });
  const fileKey = uploaded?.file_key;
  if (!fileKey) throw new Error("飞书没有返回 file_key");
  const uuid = randomUUID();
  await withFeishuRetry(async () => {
    const response = await client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "file", content: JSON.stringify({ file_key: fileKey }), uuid },
    });
    assertFeishuResponse(response, "飞书回复文件");
    return response;
  });
}

const wsClient = new lark.WSClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, loggerLevel: lark.LoggerLevel.info });
const guardStartupQueue = new GuardStartupQueue();

function startOnlineDateGuardWithRetry(runtime: StoreRuntime, tenantId: string): void {
  void guardStartupQueue.run(() => runtime.onlineDateGuard.start()).then((result) => {
    console.log(`[online-date-guard:${tenantId}] ${JSON.stringify(result)}`);
  }).catch((error) => {
    console.error(
      `[online-date-guard:${tenantId}] 启动读取暂缓，将自动重试：`
      + `${error instanceof Error ? error.message : String(error)}`,
    );
    const timer = setTimeout(
      () => startOnlineDateGuardWithRetry(runtime, tenantId),
      feishuRetryDelayMs(error, 5_000),
    );
    timer.unref();
  });
}

function startDuplicateFlagsWithRetry(runtime: StoreRuntime, tenantId: string): void {
  void guardStartupQueue.run(() => runtime.duplicateFlags.start()).then((result) => {
    console.log(`[duplicate-flags:${tenantId}] ${JSON.stringify(result)}`);
  }).catch((error) => {
    console.error(
      `[duplicate-flags:${tenantId}] 启动读取暂缓，将自动重试：`
      + `${error instanceof Error ? error.message : String(error)}`,
    );
    const timer = setTimeout(
      () => startDuplicateFlagsWithRetry(runtime, tenantId),
      feishuRetryDelayMs(error, 5_000),
    );
    timer.unref();
  });
}

function startCooperationOnlineProgressWithRetry(runtime: StoreRuntime, tenantId: string): void {
  void guardStartupQueue.run(() => runtime.cooperationOnlineProgress.start()).then((result) => {
    console.log(`[cooperation-online-progress:${tenantId}] ${JSON.stringify(result)}`);
  }).catch((error) => {
    console.error(
      `[cooperation-online-progress:${tenantId}] 启动读取暂缓，将自动重试：`
      + `${error instanceof Error ? error.message : String(error)}`,
    );
    const timer = setTimeout(
      () => startCooperationOnlineProgressWithRetry(runtime, tenantId),
      feishuRetryDelayMs(error, 5 * 60_000),
    );
    timer.unref();
  });
}

for (const runtime of runtimes.values()) {
  const tenantId = runtime.tenant.binding.id;
  void guardStartupQueue.run(() => runtime.roiRecordGuard.start()).then((result) => {
    console.log(`[roi-record-guard:${tenantId}] ${JSON.stringify(result)}`);
  }).catch((error) => {
    console.error(`[roi-record-guard:${tenantId}] 启动同步暂缓，将自动重试：${error instanceof Error ? error.message : String(error)}`);
  });
  startOnlineDateGuardWithRetry(runtime, tenantId);
  const dailyAutomationStart = await runtime.dailyAutomation.start();
  void runtime.shopRisk.start()
    .then(result => console.log(`[shop-risk-start:${tenantId}] ${JSON.stringify(result)}`))
    .catch(error => console.error(`[shop-risk-start:${tenantId}] ${error instanceof Error ? error.message : String(error)}`));
  console.log(`[daily-automation-start:${tenantId}] ${JSON.stringify(dailyAutomationStart)}`);
  void runtime.preparedGroupReports.start(
    dailyAutomationStart.lastAutomaticRun ?? dailyAutomationStart.lastRun,
  )
    .then((result) => {
      console.log(`[prepared-group-report-start:${tenantId}] ${JSON.stringify(result)}`);
    })
    .catch((error) => {
      console.error(`[prepared-group-report-start:${tenantId}] 启动失败：${error instanceof Error ? error.message : String(error)}`);
    });
  startDuplicateFlagsWithRetry(runtime, tenantId);
  startCooperationOnlineProgressWithRetry(runtime, tenantId);
  if (runtime.productSpikeMonitor) {
    void runtime.productSpikeMonitor.start().then((result) => {
      console.log(`[product-spike-monitor-start:${tenantId}] ${JSON.stringify(result)}`);
    }).catch((error) => {
      console.error(
        `[product-spike-monitor-start:${tenantId}] 首次只读基线失败，已安排下一轮重试：`
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}
realtimeVideoAnalysis = new RealtimeVideoAnalysisService([...runtimes.values()].map(r => r.tenant),
  () => [...runtimes.values()].some(r => r.dailyAutomation.isBusy()));
void realtimeVideoAnalysis.start().catch(error => console.error(`[video-realtime-start] ${safeUnknownError(error)}`));
console.log(`飞书机器人长连接正在启动；已加载 ${runtimes.size} 个店铺租户，群聊按店铺隔离查询，API 数据按各店铺定时同步。`);
await wsClient.start({ eventDispatcher: dispatcher });

function logPreparedGroupReportResult(
  tenantId: string,
  runId: string,
  result: PreparedGroupReportPreparationResult,
): void {
  console.log(`[prepared-group-report:${tenantId}] ${JSON.stringify({
    runId,
    skipped: result.skipped,
    reason: result.reason,
    sendDate: result.sendDate,
    reports: result.reports.map((report) => ({
      reportKey: report.reportKey,
      audience: report.audience,
      kind: report.kind,
      sourcePeriod: `${report.sourceStartDate}..${report.sourceEndDate}`,
      dataReadOk: report.dataReadOk,
      dataComplete: report.dataComplete,
    })),
    errors: result.errors,
  })}`);
}

function safeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
