import { requireCanonicalProductName } from "../business/product-naming.js";
import type { RoiProductRecordSnapshot } from "../feishu/storefour-demo-gateway.js";
import { nextDate } from "./intent.js";
import type { RealtimeResultSummary } from "./types.js";

export interface RoiProductDeleteGateway {
  listRoiProductNames(): Promise<string[]>;
  snapshotRoiProductRecords(productName: string): Promise<RoiProductRecordSnapshot[]>;
  deleteRoiProductRecords(input: {
    productName: string;
    expected: readonly Pick<RoiProductRecordSnapshot, "recordId" | "lastModifiedTime">[];
    operationId: string;
  }): Promise<number>;
}

export interface RoiProductDeletePlan {
  version: 1;
  jobId: string;
  generatedAt: string;
  productName: string;
  records: RoiProductRecordSnapshot[];
}

export class RoiProductDeleteInputRequiredError extends Error {
  public constructor(
    message: string,
    public readonly missingItems: string[],
  ) {
    super(message);
  }
}

export async function prepareRoiProductDeletePlan(input: {
  jobId: string;
  productName?: string;
  gateway: RoiProductDeleteGateway;
}): Promise<RoiProductDeletePlan> {
  if (!input.productName?.trim()) {
    const names = await input.gateway.listRoiProductNames();
    throw new RoiProductDeleteInputRequiredError(
      `请说出要删除的完整商品名。当前商品：${names.length ? names.join("、") : "无"}`,
      ["完整商品名"],
    );
  }
  const productName = requireCanonicalProductName(input.productName);
  const names = await input.gateway.listRoiProductNames();
  if (!names.includes(productName)) {
    const close = names.filter((name) => name.includes(productName) || productName.includes(name));
    const choices = (close.length ? close : names).slice(0, 12);
    throw new RoiProductDeleteInputRequiredError(
      `投产比里没有完全同名商品“${productName}”，所以没有删除。${choices.length ? `可选商品：${choices.join("、")}` : "当前没有商品记录。"}`,
      ["与工作台完全一致的商品名"],
    );
  }
  return {
    version: 1,
    jobId: input.jobId,
    generatedAt: new Date().toISOString(),
    productName,
    records: await input.gateway.snapshotRoiProductRecords(productName),
  };
}

export function formatRoiProductDeletePreview(plan: RoiProductDeletePlan): string {
  const dates = plan.records.map((record) => record.dateKey).filter(Boolean).sort();
  if (!plan.records.length) {
    return `商品“${plan.productName}”当前没有投产比日记录，未执行删除。`;
  }
  return [
    "删除预览（尚未删除）：",
    `商品：${plan.productName}`,
    `投产比日记录：${plan.records.length} 条`,
    `日期范围：${dates[0] ?? "日期为空"}${dates.length > 1 ? ` 至 ${dates.at(-1)}` : ""}`,
    "只删除投产比表中商品名完全一致的记录；不删除店铺汇总，也不改红人开发、合作或上线表。",
    "机器人不会自动回滚本次删除；误删需由多维表格管理员使用飞书自身的恢复能力处理。",
    "确认无误请回复：继续刚才的删除",
  ].join("\n");
}

export async function executeRoiProductDeletePlan(
  plan: RoiProductDeletePlan,
  gateway: RoiProductDeleteGateway,
): Promise<RealtimeResultSummary> {
  if (plan.version !== 1 || !plan.jobId || !plan.productName) throw new Error("商品删除计划无效");
  const deleted = await gateway.deleteRoiProductRecords({
    productName: plan.productName,
    expected: plan.records,
    operationId: plan.jobId,
  });
  if (deleted !== plan.records.length) {
    throw new Error(`删除数量与预览不一致：预览 ${plan.records.length} 条，实际 ${deleted} 条`);
  }
  const dates = plan.records.map((record) => record.dateKey).filter(Boolean).sort();
  return {
    windowStart: dates[0] ?? null,
    windowEndExclusive: dates.at(-1) ? nextDate(dates.at(-1)!) : null,
    sources: ["飞书投产比原生记录"],
    matched: plan.records.length,
    created: 0,
    updated: 0,
    deleted,
    unchanged: 0,
    skipped: 0,
    conflicts: 0,
    missingItems: [],
    backupPath: null,
    rollbackCommand: null,
  };
}
