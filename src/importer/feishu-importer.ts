import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { AppEnv } from "../config/env.js";
import type { DataRow, TableData } from "../types/index.js";
import { canonicalRow } from "../utils/value.js";
import { assertFeishuResponse } from "../feishu/client.js";
import { convertRowForFeishu, createImportPlan, type ImportPlan } from "./plan.js";

interface ImportState {
  version: 1;
  sourceFingerprint: string;
  importedRowHashes: string[];
}

export interface ImportReport {
  planned: number;
  success: number;
  failed: number;
  skipped: number;
  beforeCount: number;
  afterCount: number;
}

const STATE_PATH = path.resolve(".import-state.json");

function rowHash(row: DataRow, headers: string[]): string {
  return createHash("sha256").update(canonicalRow(row, headers)).digest("hex");
}

function sourceFingerprint(table: TableData): string {
  return createHash("sha256").update(`${table.sourceName}\n${table.sheetName}\n${table.headers.join("\n")}`).digest("hex");
}

function loadState(table: TableData): ImportState {
  const fingerprint = sourceFingerprint(table);
  if (!fs.existsSync(STATE_PATH)) return { version: 1, sourceFingerprint: fingerprint, importedRowHashes: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as ImportState;
    if (parsed.version !== 1 || parsed.sourceFingerprint !== fingerprint || !Array.isArray(parsed.importedRowHashes)) {
      return { version: 1, sourceFingerprint: fingerprint, importedRowHashes: [] };
    }
    return parsed;
  } catch {
    throw new Error("本地导入状态文件损坏，请人工检查 .import-state.json；程序未执行写入");
  }
}

function saveState(state: ImportState): void {
  const temporary = `${STATE_PATH}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, STATE_PATH);
}

async function listFields(client: Client, env: AppEnv): Promise<Array<{ field_name?: string }>> {
  const fields: Array<{ field_name?: string }> = [];
  let pageToken: string | undefined;
  do {
    const response = await client.bitable.appTableField.list({
      path: { app_token: env.FEISHU_BITABLE_APP_TOKEN, table_id: env.FEISHU_BITABLE_TABLE_ID },
      params: { page_size: 100, page_token: pageToken },
    });
    assertFeishuResponse(response, "读取飞书字段");
    fields.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return fields;
}

async function ensureFields(client: Client, env: AppEnv, plan: ImportPlan): Promise<void> {
  const existing = new Set((await listFields(client, env)).map((field) => field.field_name).filter(Boolean));
  for (const field of plan.fields) {
    if (existing.has(field.name)) continue;
    const response = await client.bitable.appTableField.create({
      path: { app_token: env.FEISHU_BITABLE_APP_TOKEN, table_id: env.FEISHU_BITABLE_TABLE_ID },
      data: {
        field_name: field.name,
        type: field.feishuType,
        ...(field.type === "日期" ? { property: { date_formatter: "yyyy-MM-dd" } } : {}),
      },
    });
    assertFeishuResponse(response, `创建字段“${field.name}”`);
  }
}

async function countRecords(client: Client, env: AppEnv): Promise<number> {
  let count = 0;
  let pageToken: string | undefined;
  do {
    const response = await client.bitable.appTableRecord.list({
      path: { app_token: env.FEISHU_BITABLE_APP_TOKEN, table_id: env.FEISHU_BITABLE_TABLE_ID },
      params: { page_size: 500, page_token: pageToken },
    });
    assertFeishuResponse(response, "校验飞书记录数");
    count += response.data?.items?.length ?? 0;
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return count;
}

export async function importToFeishu(client: Client, env: AppEnv, table: TableData): Promise<ImportReport> {
  const plan = createImportPlan(table);
  const state = loadState(table);
  const imported = new Set(state.importedRowHashes);
  const seen = new Set(imported);
  const pending = table.rows.map((row) => ({ row, hash: rowHash(row, table.headers) })).filter((item) => {
    if (seen.has(item.hash)) return false;
    seen.add(item.hash);
    return true;
  });
  const skipped = table.rows.length - pending.length;
  await ensureFields(client, env, plan);
  const beforeCount = await countRecords(client, env);
  let success = 0;
  let failed = 0;
  for (let index = 0; index < pending.length; index += 500) {
    const batch = pending.slice(index, index + 500);
    try {
      const response = await client.bitable.appTableRecord.batchCreate({
        path: { app_token: env.FEISHU_BITABLE_APP_TOKEN, table_id: env.FEISHU_BITABLE_TABLE_ID },
        data: { records: batch.map((item) => ({ fields: convertRowForFeishu(item.row, plan.fields) })) },
      });
      assertFeishuResponse(response, `写入第 ${Math.floor(index / 500) + 1} 批记录`);
      for (const item of batch) imported.add(item.hash);
      success += response.data?.records?.length ?? batch.length;
      state.importedRowHashes = [...imported];
      saveState(state);
    } catch (error) {
      failed += batch.length;
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
  const afterCount = await countRecords(client, env);
  if (afterCount < beforeCount + success) {
    throw new Error(`导入后记录数校验失败：导入前 ${beforeCount}，成功 ${success}，导入后 ${afterCount}`);
  }
  return { planned: table.rows.length, success, failed, skipped, beforeCount, afterCount };
}
