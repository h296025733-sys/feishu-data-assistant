import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import type { DataRow, DataSource, TableData } from "../types/index.js";

const SUPPORTED_EXTENSIONS = new Set([".xlsx", ".xls", ".csv"]);

export function findInputFile(inputDir = path.resolve("input")): string {
  if (!fs.existsSync(inputDir)) throw new Error(`测试表目录不存在：${inputDir}`);
  const candidates = fs.readdirSync(inputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(inputDir, entry.name));
  if (candidates.length === 0) throw new Error(`input 目录中没有 .xlsx、.xls 或 .csv 测试表：${inputDir}`);
  if (candidates.length > 1) {
    throw new Error(`发现多个候选测试表，无法可靠判断：${candidates.map((item) => path.basename(item)).join("、")}`);
  }
  return candidates[0];
}

export function readLocalTable(filePath: string): TableData {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error(`表格没有工作表：${filePath}`);
  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true });
  if (matrix.length === 0) throw new Error(`工作表为空：${sheetName}`);
  const headerRowIndex = detectHeaderRow(matrix);
  const headerRow = matrix[headerRowIndex] ?? [];
  const headers = headerRow.map((value, index) => {
    const current = String(value ?? "").trim();
    const prior = matrix.slice(0, headerRowIndex).map((row) => String(row[index] ?? "").trim()).find(Boolean);
    const usePrior = prior && /\d/.test(current) && !/\d/.test(prior);
    return (usePrior ? prior : current) || `未命名字段${index + 1}`;
  });
  if (new Set(headers).size !== headers.length) throw new Error(`表头存在重名字段：${sheetName}`);
  const rows: DataRow[] = matrix.slice(headerRowIndex + 1)
    .filter((values) => values.some((value) => value !== null && String(value).trim() !== ""))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? null])));
  return {
    sourceName: path.basename(filePath),
    sheetName,
    headers,
    rows,
    updatedAt: fs.statSync(filePath).mtime,
  };
}

function detectHeaderRow(matrix: unknown[][]): number {
  const headerWords = /商品|产品|日期|时间|金额|数量|库存|成本|价格|售价|利润|佣金|运费|sku|链接/i;
  const candidates = matrix.slice(0, 20).map((row, index) => {
    const values = row.filter((value) => value !== null && String(value).trim() !== "");
    const strings = values.filter((value) => typeof value === "string");
    const keywordHits = strings.filter((value) => headerWords.test(value)).length;
    const unique = new Set(values.map(String)).size;
    return { index, score: values.length + strings.length * 1.5 + keywordHits * 3 + unique * 0.1 };
  });
  return candidates.reduce((best, current) => current.score > best.score ? current : best, candidates[0] ?? { index: 0, score: 0 }).index;
}

export class LocalFileDataSource implements DataSource {
  public constructor(private readonly filePath = findInputFile()) {}

  public async getTable(): Promise<TableData> {
    return readLocalTable(this.filePath);
  }
}
