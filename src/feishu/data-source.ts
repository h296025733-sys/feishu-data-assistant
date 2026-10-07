import type { Client } from "@larksuiteoapi/node-sdk";
import type { AppEnv } from "../config/env.js";
import { loadBusinessProfile, type BusinessProfile } from "../config/business-profile.js";
import type { DataRow, DataSource, TableData } from "../types/index.js";
import { ClarificationError } from "../query/errors.js";
import { normalizeText } from "../utils/value.js";
import {
  assertFeishuResponse,
  createFeishuClient,
  withFeishuBitableQuotaCircuit,
  withFeishuRetry,
} from "./client.js";

export interface TableMeta {
  tableId: string;
  name: string;
  headers: string[];
}

const IGNORED_TABLE_MARKERS = ["临时", "待删除", "备用", "备份"];
const META_CACHE_MS = 5 * 60_000;

export class FeishuBitableDataSource implements DataSource {
  private readonly client: Client;
  private metaCache: { expiresAt: number; tables: TableMeta[] } | null = null;

  public constructor(
    private readonly env: AppEnv,
    client?: Client,
    private readonly profile: BusinessProfile = loadBusinessProfile(),
  ) {
    this.client = client ?? createFeishuClient(env);
  }

  public async getTableNames(): Promise<string[]> {
    return (await this.listTablesWithHeaders()).map((table) => table.name);
  }

  public async getTable(question = ""): Promise<TableData> {
    const allTables = await this.listTablesWithHeaders();
    const selected = selectTablesForQuestion(
      question,
      allTables,
      this.env.FEISHU_BITABLE_TABLE_ID,
      this.profile.tables,
    );
    if (selected.length === 0) throw new ClarificationError("你想查开发、合作还是上线数据？", ["开发", "合作", "上线"]);

    const loaded = await Promise.all(selected.map((meta) => this.readTable(meta)));
    const headers = [...new Set(loaded.flatMap((table) => table.headers))];
    const rows = loaded.flatMap((table) => table.rows.map((row) => ({ ...row, __sourceTable: table.sheetName })));
    const updatedAt = loaded.reduce((latest, table) => table.updatedAt > latest ? table.updatedAt : latest, new Date(0));
    return {
      sourceName: "飞书多维表格",
      sheetName: loaded.map((table) => table.sheetName).join(" + "),
      headers,
      rows,
      updatedAt: updatedAt.getTime() > 0 ? updatedAt : new Date(),
    };
  }

  private async listTablesWithHeaders(): Promise<TableMeta[]> {
    if (this.metaCache && this.metaCache.expiresAt > Date.now()) return this.metaCache.tables;

    const tables: Array<{ tableId: string; name: string }> = [];
    try {
      let pageToken: string | undefined;
      do {
        const response = await withFeishuRetry(() => this.bitableRequest(async () => {
          const current = await (this.client.bitable.appTable as any).list({
            path: { app_token: this.env.FEISHU_BITABLE_APP_TOKEN },
            params: { page_size: 100, page_token: pageToken },
          });
          assertFeishuResponse(current, "读取多维表格数据表列表");
          return current;
        }));
        for (const item of response.data?.items ?? []) {
          const tableId = String(item.table_id ?? "");
          const name = String(item.name ?? tableId);
          if (tableId) tables.push({ tableId, name });
        }
        pageToken = response.data?.has_more ? response.data.page_token : undefined;
      } while (pageToken);
    } catch (error) {
      // 多表发现权限不足时保留旧版单表可用性。
      if (!this.env.FEISHU_BITABLE_TABLE_ID) throw error;
    }

    if (tables.length === 0 && this.env.FEISHU_BITABLE_TABLE_ID) {
      tables.push({ tableId: this.env.FEISHU_BITABLE_TABLE_ID, name: this.env.FEISHU_BITABLE_TABLE_ID });
    }

    const result = await Promise.all(tables.map(async (table) => ({ ...table, headers: await this.readHeaders(table.tableId) })));
    this.metaCache = { expiresAt: Date.now() + META_CACHE_MS, tables: result };
    return result;
  }

  private async readHeaders(tableId: string): Promise<string[]> {
    const headers: string[] = [];
    let pageToken: string | undefined;
    do {
      const response = await withFeishuRetry(() => this.bitableRequest(async () => {
        const current = await this.client.bitable.appTableField.list({
          path: { app_token: this.env.FEISHU_BITABLE_APP_TOKEN, table_id: tableId },
          params: { page_size: 100, page_token: pageToken },
        });
        assertFeishuResponse(current, `读取飞书字段（${tableId}）`);
        return current;
      }));
      headers.push(...(response.data?.items ?? []).map((field: { field_name?: string }) => field.field_name).filter((field: string | undefined): field is string => Boolean(field)));
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    return headers;
  }

  private async readTable(meta: TableMeta): Promise<TableData> {
    const rows: DataRow[] = [];
    let latestModified = 0;
    let pageToken: string | undefined;
    do {
      const response = await withFeishuRetry(() => this.bitableRequest(async () => {
        const current = await this.client.bitable.appTableRecord.list({
          path: { app_token: this.env.FEISHU_BITABLE_APP_TOKEN, table_id: meta.tableId },
          params: { page_size: 500, page_token: pageToken },
        });
        assertFeishuResponse(current, `读取飞书记录（${meta.name}）`);
        return current;
      }));
      for (const item of response.data?.items ?? []) {
        rows.push(item.fields ?? {});
        latestModified = Math.max(latestModified, item.last_modified_time ?? 0);
      }
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    return {
      sourceName: "飞书多维表格",
      sheetName: meta.name,
      headers: meta.headers,
      rows,
      updatedAt: latestModified ? new Date(latestModified) : new Date(),
    };
  }

  private bitableRequest<T>(operation: () => Promise<T>): Promise<T> {
    return withFeishuBitableQuotaCircuit(this.env.FEISHU_APP_ID, operation);
  }
}

export function selectTablesForQuestion(
  question: string,
  tables: TableMeta[],
  fallbackTableId = "",
  businessTables: BusinessProfile["tables"] = loadBusinessProfile().tables,
): TableMeta[] {
  const active = tables.filter((table) => !IGNORED_TABLE_MARKERS.some((marker) => table.name.includes(marker)));
  const text = normalizeText(question);
  const onlineTablePattern = new RegExp(`^(?:${escapeRegExp(businessTables.online)}|Tech-wave红人上线表|红人上线表)[_\\s-]?\\d+$`, "i");
  const legacyOnlineTablePattern = new RegExp(`^(?:${escapeRegExp(businessTables.online)}|Tech-wave红人上线表|红人上线表)$`, "i");

  const exactNames = active.filter((table) => text.includes(normalizeText(table.name)));
  if (exactNames.length > 0) return sortOnlineTables(exactNames);

  const onlineTables = active.filter((table) => onlineTablePattern.test(table.name) || legacyOnlineTablePattern.test(table.name));
  const developmentTables = active.filter((table) => [businessTables.development, "Tech-wave红人开发表", "红人开发表"].includes(table.name));
  const cooperationTables = active.filter((table) => [businessTables.cooperation, "Tech-wave红人合作表", "红人合作表"].includes(table.name));
  const roiTables = active.filter((table) => table.name === businessTables.roi || /投产比|roi/i.test(table.name));

  // 先识别明确的数据域回答，尤其用于机器人上一轮追问后的短回复。
  // 不能只识别“上线记录/上线表”，还必须识别“上线”“上线数据”“上线表现”等自然回复。
  const explicitCooperation = /上下文数据域合作|用户(?:补充|选择)(?:数据域)?(?:合作|合作数据|合作情况)|合作表|合作数据|合作记录|合作情况|寄样|mcn|付款|paypal|粉丝|联系方式|主页|合作方式/.test(text);
  const explicitOnline = /上下文数据域上线|用户(?:补充|选择)(?:数据域)?(?:上线|上线数据|上线表现)|上线表|上线数据|上线记录|上线明细|上线表现|视频|挂车|曝光|播放|销量|售出|卖了|卖出|卖得|带货|销售额|成交额|gmv|adcode|投放|红人类型|视频内容/.test(text);
  const explicitDevelopment = /上下文数据域开发|用户(?:补充|选择)(?:数据域)?(?:开发|开发数据)|开发记录|开发表|开发数据|开发人|邮箱|whatsapp|联盟|最终归属/.test(text);
  const explicitRoi = /上下文数据域投产比|投产比|roi|经营数据|经营表现|店铺经营|广告花费|店铺浏览|商品卡|转化率|总单量|总数量/.test(text);

  const comprehensive = /上下文数据域(?:开发、)?合作和上线|合作和上线|合作及上线|合作与上线|综合情况|综合表现/.test(text);
  if (comprehensive) {
    return [...developmentTables.filter(() => /开发/.test(text)), ...cooperationTables, ...sortOnlineTables(onlineTables)];
  }

  // “某产品整体表现/趋势怎么样”默认就是上线、曝光、销量、销售额等表现分析。
  // 这类问题不应再追问合作还是上线。
  const performanceQuestion = /整体表现|表现怎么样|表现如何|趋势怎么样|趋势如何|趋势|走势|销售表现|带货表现|效果怎么样|整体数据|卖得怎么样|好不好/.test(text);
  if (performanceQuestion && onlineTables.length > 0 && !explicitCooperation && !explicitDevelopment && !explicitRoi) {
    return sortOnlineTables(onlineTables);
  }

  // 明确说“合作数据里的上线次数”时，应优先查合作表，而不是因为出现“上线次数”误路由到上线表。
  if (explicitCooperation && cooperationTables.length > 0) return cooperationTables;
  if (explicitOnline && onlineTables.length > 0) return sortOnlineTables(onlineTables);
  if (explicitDevelopment && developmentTables.length > 0) return developmentTables;
  if (explicitRoi && roiTables.length > 0) return roiTables;

  // “最近N天/某月 + 某商品数据”通常问的是按日经营数据，而不是合作联系人或视频明细。
  // DeepSeek不可用时也要有这一层确定性兜底。
  const datedBusinessData = /(?:最近|近|过去)\s*(?:\d{1,3}|[一二两三四五六七八九十]+)\s*(?:天|日)|本月|这个月|上月|上个月|\d{1,2}月/.test(text)
    && /数据|情况|表现|单量|销量|销售额|浏览量/.test(text);
  if (datedBusinessData && roiTables.length > 0 && !explicitCooperation && !explicitOnline && !explicitDevelopment) {
    return roiTables;
  }

  // 处理自然口语动作：某达人“上线了几次/上线了吗”，以及追问时只回复一个“上线”。
  if ((/^上线$|上线(?:了|过|几次|多少次|吗|没有|情况)|(?:几次|多少次).*上线/.test(text)) && onlineTables.length > 0) {
    return sortOnlineTables(onlineTables);
  }
  if ((/^合作$|合作(?:了|过|几次|多少次|吗|没有|情况)|(?:几次|多少次).*合作/.test(text)) && cooperationTables.length > 0) {
    return cooperationTables;
  }
  if (/^开发$/.test(text) && developmentTables.length > 0) {
    return developmentTables;
  }
  if (/上下文数据域投产比|投产比|roi|经营数据|广告花费|店铺浏览|商品卡/.test(text) && roiTables.length > 0) {
    return roiTables;
  }

  // 根据问题中真实出现的表头打分。字段名越长，权重越高。
  const scored = active.map((table) => {
    const matches = table.headers.filter((header) => {
      const normalized = normalizeText(header);
      return normalized.length >= 2 && text.includes(normalized);
    });
    const score = matches.reduce((sum, header) => sum + Math.max(2, normalizeText(header).length), 0);
    return { table, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  if (scored.length > 0) {
    const max = scored[0].score;
    const winners = scored.filter((item) => item.score === max).map((item) => item.table);
    const winnerOnline = winners.filter((table) => onlineTablePattern.test(table.name) || legacyOnlineTablePattern.test(table.name));
    return winnerOnline.length > 0 ? sortOnlineTables(onlineTables) : winners;
  }

  if (/情况|怎么样|查一下|看一下|帮我查|了解一下/.test(text) && active.length > 1) {
    throw new ClarificationError("你主要想看合作情况，还是上线表现？", ["合作情况", "上线表现"]);
  }

  // 只有Base里确实只有一张表时才无条件选择，避免默默回退到错误业务表。
  if (active.length === 1) return active;
  const fallback = active.find((table) => table.tableId === fallbackTableId);
  if (fallback && /当前表|当前数据表/.test(text)) return [fallback];
  throw new ClarificationError("你想查开发、合作还是上线数据？", ["开发", "合作", "上线"]);
}

function sortOnlineTables(tables: TableMeta[]): TableMeta[] {
  return [...tables].sort((a, b) => onlineIndex(a.name) - onlineIndex(b.name));
}

function onlineIndex(name: string): number {
  const match = name.match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
