import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { AppEnv } from "../config/env.js";
import { assertCanPerform, roleForUser } from "../bot/access-control.js";
import {
  buildVideoUpdatePlan,
  executeRollback,
  executeVideoUpdatePlan,
  FeishuRealtimeGateway,
  inspectRollback,
} from "./feishu-video-sync.js";
import { enumerateDates, nextDate, parseRealtimeMessage } from "./intent.js";
import { NaturalWriteIntentResolver } from "./natural-write-intent.js";
import { hashUserId, RealtimeJobStore } from "./job-store.js";
import { StorefourDemoGateway } from "../feishu/storefour-demo-gateway.js";
import {
  executeRoiUpdatePlan,
  executeRoiBulkUpdatePlan,
  formatRoiBulkPreview,
  formatRoiPreview,
  prepareRoiBulkUpdatePlan,
  prepareRoiUpdatePlan,
  RoiInputRequiredError,
  type RoiBulkUpdatePlan,
  type RoiUpdatePlan,
} from "./roi-sync.js";
import { fetchTikTokVideoDay } from "./tiktok-cli.js";
import {
  executeOnlineImportPlan,
  formatOnlineImportPreview,
  OnlineImportInputRequiredError,
  prepareCooperationDrivenOnlineImportPlan,
  prepareOnlineImportPlan,
  type OnlineImportPlan,
} from "./online-import.js";
import {
  executeRoiProductDeletePlan,
  formatRoiProductDeletePreview,
  prepareRoiProductDeletePlan,
  RoiProductDeleteInputRequiredError,
  type RoiProductDeletePlan,
} from "./roi-product-delete.js";
import type {
  RealtimeControlAction,
  RealtimeJob,
  RealtimeResultSummary,
  TikTokMachineContract,
} from "./types.js";

const ROLLBACK_CONFIRMATION_TTL_MS = 10 * 60_000;

export class RealtimeUpdateOrchestrator {
  private readonly store = new RealtimeJobStore();
  private readonly gateway: FeishuRealtimeGateway;
  private readonly roiGateway: StorefourDemoGateway;
  private readonly naturalWriteIntent: NaturalWriteIntentResolver;
  private roiQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly env: AppEnv, client: Client) {
    this.gateway = new FeishuRealtimeGateway(env, client);
    this.roiGateway = new StorefourDemoGateway(env, client);
    this.naturalWriteIntent = new NaturalWriteIntentResolver(env);
  }

  public async handle(input: {
    text: string;
    messageId: string;
    userId: string;
  }): Promise<string | null> {
    const direct = parseRealtimeMessage(input.text);
    const parsed = direct.control || direct.intent
      ? direct
      : { control: null, intent: await this.naturalWriteIntent.resolve(input.text) };
    if (!parsed.control && !parsed.intent) return null;
    if (parsed.control) {
      return this.handleControl(
        parsed.control,
        input.userId,
        input.messageId,
        parsed.jobId ?? null,
      );
    }

    if (parsed.intent?.action === "delete_roi_product") {
      assertCanPerform(roleForUser(input.userId, this.env), "admin");
    }

    const { job, reused } = await this.store.createOrReuse({
      userId: input.userId,
      messageId: input.messageId,
      intent: parsed.intent!,
    });
    if (reused) return formatJob(job, true);
    const parsedJob = await this.store.setStatus(job, "parsed");
    return this.run(parsedJob, false);
  }

  private async handleControl(
    control: RealtimeControlAction,
    userId: string,
    messageId: string,
    jobId: string | null,
  ): Promise<string> {
    if (control === "rollback_preview") {
      return this.previewRollback(jobId, userId, messageId);
    }
    if (control === "rollback_confirm") {
      return this.confirmRollback(jobId, userId);
    }
    const job = await this.store.latestForUser(userId);
    if (!job) return "目前没有可查询的更新任务。";
    if (job.intent.action === "delete_roi_product") {
      assertCanPerform(roleForUser(userId, this.env), "admin");
    }
    if (control === "status") return formatJob(job, false);
    if (control === "cancel") {
      if (["succeeded", "failed", "cancelled"].includes(job.status)) {
        return `任务 ${job.jobId} 已是 ${statusLabel(job.status)}，无法再取消。`;
      }
      const cancelled = await this.store.setStatus(job, "cancelled");
      return `已取消更新任务 ${cancelled.jobId}；未继续执行写入。`;
    }
    if (!["needs_input", "blocked", "failed"].includes(job.status)) {
      return `任务 ${job.jobId} 当前为${statusLabel(job.status)}，无需继续命令。`;
    }
    return this.run(await this.store.setStatus(job, "parsed"), true);
  }

  private async previewRollback(
    jobId: string | null,
    userId: string,
    messageId: string,
  ): Promise<string> {
    if (!jobId) return "命令格式：回滚任务 <job_id>";
    const job = await this.store.getForUser(jobId, userId);
    if (!job) return "找不到该任务，或该任务不属于当前用户。";
    if (job.rollbackResult) {
      return `任务 ${jobId} 已完成回滚：恢复 ${job.rollbackResult.restored} 条，跳过 ${job.rollbackResult.skipped} 条；不会重复执行。`;
    }
    let inspection;
    try {
      inspection = await inspectRollback(jobId);
    } catch (error) {
      return `任务 ${jobId} 没有可安全使用的回滚备份：${safeError(error)}`;
    }
    if (inspection.completedResult) {
      const completedAt = new Date().toISOString();
      await this.store.update(job, {
        rollbackResult: { completedAt, ...inspection.completedResult },
        rollbackPreview: null,
      });
      return `任务 ${jobId} 已完成回滚：恢复 ${inspection.completedResult.restored} 条，跳过 ${inspection.completedResult.skipped} 条；不会重复执行。`;
    }
    if (inspection.operationCount === 0) {
      return `任务 ${jobId} 没有实际写入记录，无需回滚。`;
    }
    const requestedAt = new Date();
    const expiresAt = new Date(requestedAt.getTime() + ROLLBACK_CONFIRMATION_TTL_MS);
    await this.store.update(job, {
      rollbackPreview: {
        requestedByUserIdHash: hashUserId(userId),
        requestedAt: requestedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        messageId,
      },
    });
    return [
      `回滚预览：任务 ${jobId}`,
      `将尝试恢复 ${inspection.operationCount} 条记录。`,
      `涉及表：${inspection.tableNames.join("、") || "未知"}`,
      `涉及字段：${inspection.fieldNames.join("、") || "未知"}`,
      "写前备份 SHA256：验证通过。",
      "如果记录在本任务后被人工修改，回滚时会跳过，不会覆盖新值。",
      `请在 10 分钟内发送：确认回滚 ${jobId}`,
    ].join("\n");
  }

  private async confirmRollback(jobId: string | null, userId: string): Promise<string> {
    if (!jobId) return "命令格式：确认回滚 <job_id>";
    const job = await this.store.getForUser(jobId, userId);
    if (!job) return "找不到该任务，或该任务不属于当前用户。";
    if (job.rollbackResult) {
      return `任务 ${jobId} 已完成回滚：恢复 ${job.rollbackResult.restored} 条，跳过 ${job.rollbackResult.skipped} 条；不会重复执行。`;
    }
    const preview = job.rollbackPreview;
    if (
      !preview
      || preview.requestedByUserIdHash !== hashUserId(userId)
      || Date.parse(preview.expiresAt) <= Date.now()
    ) {
      return `回滚确认不存在或已过期。请先发送：回滚任务 ${jobId}`;
    }
    try {
      const result = await executeRollback(jobId, `ROLLBACK-${jobId}`, this.gateway);
      const completedAt = new Date().toISOString();
      await this.store.update(job, {
        rollbackPreview: null,
        rollbackResult: {
          completedAt,
          restored: result.restored,
          skipped: result.skipped,
          resultPath: result.resultPath,
        },
      });
      return [
        result.alreadyCompleted ? "检测到该任务此前已经回滚，未重复写入。" : "回滚完成并已逐条复读验证。",
        `恢复 ${result.restored} 条；跳过 ${result.skipped} 条。`,
        result.skipped > 0 ? "跳过项表示当前值已被后续修改，系统没有覆盖它们。" : null,
        `job_id：${jobId}`,
      ].filter(Boolean).join("\n");
    } catch (error) {
      return `回滚失败并已停止：${safeError(error)}\njob_id：${jobId}`;
    }
  }

  private async run(job: RealtimeJob, explicitlyContinued: boolean): Promise<string> {
    try {
      if (job.intent.action === "delete_roi_product") return this.runRoiProductDelete(job, explicitlyContinued);
      if (job.intent.action === "update_roi") return this.runRoi(job, explicitlyContinued);
      if (
        job.intent.action === "import_online_videos"
        || job.intent.action === "import_online_from_cooperations"
      ) {
        return this.runOnlineImport(job, explicitlyContinued);
      }
      if (job.intent.action === "clarify_online_import") {
        return this.collectOnlineImportDate(job);
      }
      if (job.intent.action === "create_cooperation") return this.collectCooperation(job);
      if (job.intent.action === "modify_business") return this.collectModification(job);

      const dates = enumerateDates(job.intent.startDate, job.intent.endDateInclusive);
      if (dates.length > 1) {
        const prompt = [
          `已识别 ${dates.length} 个逐日窗口（${dates[0]} 至 ${dates.at(-1)}）。`,
          "当前两张上线表只有“视频曝光K”，没有可证明口径的“指标日期”字段；连续写入会让后一天覆盖前一天。",
          "请改为单日更新，或先明确允许记录每日指标的现有日期字段。不会自动改表结构。",
        ].join("\n");
        await this.store.update(job, {
          status: "needs_input",
          missingItems: ["上线表中可证明口径的指标日期字段"],
          prompt,
        });
        return `${prompt}\njob_id：${job.jobId}`;
      }

      const startDate = dates[0];
      const contract = await fetchTikTokVideoDay(startDate, nextDate(startDate));
      if (!contract.ok) return this.handleTikTokFailure(job, contract);
      const plan = await buildVideoUpdatePlan(job.jobId, contract, this.gateway);
      if (
        contract.row_count === 0
        && contract.latest_available_date
        && contract.latest_available_date < startDate
      ) {
        plan.missingItems.push(
          `TikTok 日报尚未生成到 ${startDate}；接口最新可用日期为 ${contract.latest_available_date}`,
        );
      }
      await writeFile(
        path.join(this.store.jobDirectory(job.jobId), "plan.json"),
        `${JSON.stringify(plan, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await this.store.setStatus(job, "planned");
      if (plan.changes.length > 100 && !explicitlyContinued) {
        const prompt = `计划修改 ${plan.changes.length} 条，超过安全阈值 100 条。请回复“继续刚才的更新”明确授权本批计划；执行前仍会复读并发校验。`;
        await this.store.update(job, { status: "needs_input", prompt, missingItems: [] });
        return `${prompt}\njob_id：${job.jobId}`;
      }

      await this.store.setStatus(job, "executing");
      const summary = await executeVideoUpdatePlan(
        plan,
        this.gateway,
        explicitlyContinued ? Number.MAX_SAFE_INTEGER : undefined,
      );
      if (job.intent.action === "update_all") {
        summary.missingItems.push(
          "Shop Ads/GMV Max：请从 Seller Center → Marketing → Shop Ads，或 TikTok Ads Manager → Campaign/GMV Max 导出，并提供日期范围和广告账户名称",
          "Orders：Seller Center → Orders → Manage Orders → Export",
          "Return/Refund：Seller Center → Orders → Manage Returns；无 Export 时提供 Finance 结算报告",
          "Finance：Seller Center → Finances → Statements/Payouts → Export；未结算为 On hold → Export",
          "Affiliate/样品：Affiliate Center → Manage Creators / Open or Target Collaboration / Sample Requests / Affiliate Orders",
        );
      }
      const completed = await this.store.setResult(job, summary);
      return formatJob(completed, false);
    } catch (error) {
      const message = safeError(error);
      const failed = await this.store.update(job, { status: "failed", error: message });
      const taskName = job.intent.action === "delete_roi_product" ? "删除任务" : "更新任务";
      return `${taskName}失败并已停止后续批次：${message}\n可发送“更新状态”查看详情。\njob_id：${failed.jobId}`;
    }
  }

  private async runRoiProductDelete(job: RealtimeJob, explicitlyContinued: boolean): Promise<string> {
    const planPath = path.join(this.store.jobDirectory(job.jobId), "roi-product-delete-plan.json");
    if (!explicitlyContinued) {
      const intent = job.intent.action === "delete_roi_product" ? job.intent : null;
      if (!intent) throw new Error("商品删除任务类型不匹配");
      let plan: RoiProductDeletePlan;
      try {
        plan = await prepareRoiProductDeletePlan({
          jobId: job.jobId,
          productName: intent.productName,
          gateway: this.roiGateway,
        });
      } catch (error) {
        if (!(error instanceof RoiProductDeleteInputRequiredError)) throw error;
        await this.store.update(job, {
          status: "needs_input",
          missingItems: error.missingItems,
          prompt: error.message,
          error: null,
        });
        return `${error.message}\n示例：删除投产比商品 电动磨脚器\njob_id：${job.jobId}`;
      }
      await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      const prompt = formatRoiProductDeletePreview(plan);
      if (!plan.records.length) {
        const completed = await this.store.setResult(job, {
          windowStart: null,
          windowEndExclusive: null,
          sources: ["飞书投产比原生记录"],
          matched: 0,
          created: 0,
          updated: 0,
          deleted: 0,
          unchanged: 0,
          skipped: 0,
          conflicts: 0,
          missingItems: [],
          backupPath: null,
          rollbackCommand: null,
        });
        await this.store.update(completed, { prompt });
        return `${prompt}\njob_id：${job.jobId}`;
      }
      await this.store.update(job, { status: "needs_input", missingItems: [], prompt, error: null });
      return `${prompt}\njob_id：${job.jobId}`;
    }

    const plan = JSON.parse(await readFile(planPath, "utf8")) as RoiProductDeletePlan;
    if (plan.jobId !== job.jobId || plan.version !== 1) throw new Error("商品删除计划与当前任务不匹配");
    await this.store.setStatus(job, "executing");
    const summary = await this.enqueueRoi(() => executeRoiProductDeletePlan(plan, this.roiGateway));
    await this.store.setResult(job, summary);
    return [
      "删除完成并已复读验证。",
      `商品：${plan.productName}`,
      `删除投产比日记录：${summary.deleted ?? 0} 条`,
      "未删除店铺汇总，也未改红人开发、合作或上线表。",
      `job_id：${job.jobId}`,
    ].join("\n");
  }

  private async handleTikTokFailure(job: RealtimeJob, contract: TikTokMachineContract): Promise<string> {
    const missing = [...contract.missing_capabilities];
    if (missing.length === 0 && contract.errors.length > 0) missing.push(...contract.errors);
    const prompt = missing.some((item) => item.includes("data.shop_analytics.public.read"))
      ? "当前 TikTok Seller Token 缺少 data.shop_analytics.public.read；请在 Partner Center 补充授权后回复“继续刚才的更新”。"
      : `TikTok 只读 API 暂未取得数据：${missing.join("；") || "未知错误"}。修复授权/网络后可回复“继续刚才的更新”。`;
    await this.store.update(job, { status: "needs_input", missingItems: missing, prompt });
    return `${prompt}\njob_id：${job.jobId}`;
  }

  private async runRoi(job: RealtimeJob, explicitlyContinued: boolean): Promise<string> {
    const planPath = path.join(this.store.jobDirectory(job.jobId), "roi-plan.json");
    try {
      if (!explicitlyContinued) {
        const intent = job.intent.action === "update_roi" ? job.intent : null;
        if (!intent) throw new Error("投产比任务类型不匹配");
        const plan = intent.productScope === "all_mapped"
          ? await prepareRoiBulkUpdatePlan({
              jobId: job.jobId,
              startDate: intent.startDate,
              endDateInclusive: intent.endDateInclusive,
              rowFilter: intent.rowFilter ?? "all",
            })
          : await prepareRoiUpdatePlan({
              jobId: job.jobId,
              startDate: intent.startDate,
              endDateInclusive: intent.endDateInclusive,
              productName: intent.productName,
            });
        await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        const prompt = "mode" in plan ? formatRoiBulkPreview(plan) : formatRoiPreview(plan);
        if ("mode" in plan && plan.entries.length === 0) {
          const completed = await this.store.setResult(job, {
            windowStart: plan.startDate,
            windowEndExclusive: plan.endDateExclusive,
            sources: plan.sourceFiles,
            matched: 0,
            created: 0,
            updated: 0,
            unchanged: 0,
            skipped: plan.skippedRows,
            conflicts: 0,
            missingItems: plan.unmappedPositiveProducts.length > 0
              ? [`有单但未映射商品：${plan.unmappedPositiveProducts.map((item) => `${item.name}(${item.id})`).join("、")}`]
              : [],
            backupPath: null,
            rollbackCommand: null,
          });
          await this.store.update(completed, { prompt });
          return `${prompt}\njob_id：${job.jobId}`;
        }
        await this.store.update(job, {
          status: "needs_input",
          missingItems: plan.missingItems,
          prompt,
          error: null,
        });
        return `${prompt}\njob_id：${job.jobId}`;
      }

      const plan = JSON.parse(await readFile(planPath, "utf8")) as RoiUpdatePlan | RoiBulkUpdatePlan;
      if (plan.jobId !== job.jobId || plan.version !== 1) {
        throw new Error("投产比计划与当前任务不匹配");
      }
      await this.store.setStatus(job, "executing");
      const summary = await this.enqueueRoi(
        () => "mode" in plan
          ? executeRoiBulkUpdatePlan(plan, this.roiGateway)
          : executeRoiUpdatePlan(plan, this.roiGateway),
      );
      const completed = await this.store.setResult(job, summary);
      return formatJob(completed, false);
    } catch (error) {
      if (error instanceof RoiInputRequiredError) {
        await this.store.update(job, {
          status: "needs_input",
          missingItems: error.missingItems,
          prompt: error.message,
          error: null,
        });
        return `${error.message}\n请重新发送包含完整商品名和日期的更新命令。\njob_id：${job.jobId}`;
      }
      throw error;
    }
  }

  private async runOnlineImport(job: RealtimeJob, explicitlyContinued: boolean): Promise<string> {
    const planPath = path.join(this.store.jobDirectory(job.jobId), "online-import-plan.json");
    if (!explicitlyContinued) {
      let plan: OnlineImportPlan | null;
      try {
        plan = job.intent.action === "import_online_videos"
        ? await prepareOnlineImportPlan({
            jobId: job.jobId,
            intent: job.intent,
            gateway: this.roiGateway,
          })
        : job.intent.action === "import_online_from_cooperations"
          ? await prepareCooperationDrivenOnlineImportPlan({
              jobId: job.jobId,
              intent: job.intent,
              gateway: this.roiGateway,
            })
          : null;
      } catch (error) {
        if (!(error instanceof OnlineImportInputRequiredError)) throw error;
        await this.store.update(job, {
          status: "needs_input",
          missingItems: error.missingItems,
          prompt: error.message,
          error: null,
        });
        return `${error.message}\njob_id：${job.jobId}`;
      }
      if (!plan) throw new Error("上线视频导入任务类型不匹配");
      await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      const prompt = formatOnlineImportPreview(plan);
      if (plan.videos.length === 0) {
        const completed = await this.store.setResult(job, {
          windowStart: plan.startDate,
          windowEndExclusive: plan.endDateExclusive,
          sources: plan.sourceFiles,
          matched: 0,
          created: 0,
          updated: 0,
          unchanged: 0,
          skipped: plan.skipped,
          conflicts: plan.conflicts.length,
          missingItems: plan.missingItems,
          backupPath: null,
          rollbackCommand: null,
        });
        await this.store.update(completed, { prompt });
        return `${prompt}\njob_id：${job.jobId}`;
      }
      await this.store.update(job, {
        status: "needs_input",
        missingItems: plan.missingItems,
        prompt,
        error: null,
      });
      return `${prompt}\njob_id：${job.jobId}`;
    }

    const plan = JSON.parse(await readFile(planPath, "utf8")) as OnlineImportPlan;
    if (plan.jobId !== job.jobId || plan.version !== 1) {
      throw new Error("上线视频计划与当前任务不匹配");
    }
    await this.store.setStatus(job, "executing");
    const summary = await executeOnlineImportPlan(plan, this.roiGateway);
    const completed = await this.store.setResult(job, summary);
    return formatJob(completed, false);
  }

  private enqueueRoi<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.roiQueue.then(operation, operation);
    this.roiQueue = current.then(() => undefined, () => undefined);
    return current;
  }

  private async collectCooperation(job: RealtimeJob): Promise<string> {
    const details = job.intent.action === "create_cooperation" ? job.intent.details : "";
    const prompt = [
      "已识别新增合作任务。首版请用一条文字补齐最少字段：红人姓名（填写 TikTok 号，不带 @）、合作时间、开发人、寄样产品/合作方式。",
      "主页、联系方式、付款、备注属于人工保护字段；只有你在本任务中明确提供时才会纳入计划，且不会覆盖已有人工值。",
      details ? `已收到内容：${details}` : "当前尚未收到字段内容。",
    ].join("\n");
    await this.store.update(job, {
      status: "needs_input",
      missingItems: ["红人姓名（TikTok号，不带@）", "合作时间", "开发人", "寄样产品或合作方式"],
      prompt,
    });
    return `${prompt}\njob_id：${job.jobId}`;
  }

  private async collectOnlineImportDate(job: RealtimeJob): Promise<string> {
    const handle = job.intent.action === "clarify_online_import" ? job.intent.creatorHandle : "";
    const prompt = [
      `已识别达人 ${handle}，但没有识别到日期范围，所以没有查询API、也没有写表。`,
      "请选择一种短说法重新发送：",
      `1. ${handle}近七天写入表格`,
      `2. ${handle}近三十天写入表格`,
      `3. ${handle} 7月27日写入表格`,
      "机器人仍会先展示具体日期和视频预览，回复“继续刚才的更新”后才写入。",
    ].join("\n");
    await this.store.update(job, {
      status: "needs_input",
      missingItems: ["日期范围"],
      prompt,
    });
    return `${prompt}\njob_id：${job.jobId}`;
  }

  private async collectModification(job: RealtimeJob): Promise<string> {
    const prompt = [
      "已识别修改任务，但需要可确定的目标和字段。",
      "请用文字提供：目标达人或视频链接/ID、要修改的现有字段名、新值。",
      "公式字段、系统创建时间、主页、联系方式、付款和备注不会被自动覆盖；多候选时不会猜。",
    ].join("\n");
    await this.store.update(job, {
      status: "needs_input",
      missingItems: ["唯一目标", "现有字段名", "新值"],
      prompt,
    });
    return `${prompt}\njob_id：${job.jobId}`;
  }
}

function formatJob(job: RealtimeJob, reused: boolean): string {
  const prefix = reused ? "这件事刚做过，我没有重复写一遍。🙂" : job.status === "succeeded" ? "搞定啦。" : `目前状态：${statusLabel(job.status)}。`;
  const rollbackStatus = job.rollbackResult
    ? `回滚状态：已完成；恢复 ${job.rollbackResult.restored} 条，跳过 ${job.rollbackResult.skipped} 条。`
    : job.rollbackPreview
      ? `回滚状态：等待二次确认，有效期至 ${new Date(job.rollbackPreview.expiresAt).toLocaleString("zh-CN", { hour12: false })}。`
      : null;
  if (!job.resultSummary) {
    return [
      prefix,
      rollbackStatus,
      job.prompt,
      job.error ? `没完成的原因：${job.error}` : null,
      job.missingItems.length > 0 ? `还需要：${job.missingItems.join("；")}` : null,
    ].filter(Boolean).join("\n");
  }
  const result = job.resultSummary;
  const changed = result.created + result.updated + (result.deleted ?? 0);
  return [
    prefix,
    result.windowStart && result.windowEndExclusive ? `看的是 ${result.windowStart} 到 ${result.windowEndExclusive} 之前的数据。` : null,
    changed > 0
      ? `这次新增 ${result.created} 条、更新 ${result.updated} 条${result.deleted ? `、删除 ${result.deleted} 条` : ""}。`
      : "这次没有需要改动的数据。",
    result.skipped > 0 || result.conflicts > 0 ? `有 ${result.skipped} 条跳过、${result.conflicts} 条冲突，我没有硬写。` : null,
    result.missingItems.length > 0 ? `还需要人工看看：${result.missingItems.slice(0, 5).join("；")}` : null,
    rollbackStatus,
  ].filter(Boolean).join("\n");
}

function statusLabel(status: RealtimeJob["status"]): string {
  const labels: Record<RealtimeJob["status"], string> = {
    received: "已接收",
    parsed: "已解析",
    needs_input: "等待补充",
    planned: "已计划",
    blocked: "已阻塞",
    executing: "执行中",
    verifying: "验证中",
    succeeded: "成功",
    failed: "失败",
    cancelled: "已取消",
  };
  return labels[status];
}

function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/(?i:app[_ -]?secret|access[_ -]?token|refresh[_ -]?token|shop_cipher|sign)(\s*[:=]\s*)[^\s,;&]+/g, "$1$2****")
    .slice(0, 2_000);
}
