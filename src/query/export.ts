export interface CsvExport {
  fileName: string;
  content: Buffer;
  rowCount: number;
}

export function buildCsvExport(
  records: Array<Record<string, unknown>>,
  now = new Date(),
  displayName = "TechWave",
): CsvExport {
  if (records.length === 0) throw new Error("没有可导出的记录");
  const headers = [...new Set(records.flatMap((record) => Object.keys(record)))];
  const lines = [
    headers.map(csvCell).join(","),
    ...records.map((record) => headers.map((header) => csvCell(record[header])).join(",")),
  ];
  const stamp = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now).replace(/\D/g, "");
  return {
    fileName: `${safeFilePrefix(displayName)}数据导出-${stamp}.csv`,
    content: Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8"),
    rowCount: records.length,
  };
}

function safeFilePrefix(value: string): string {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "").slice(0, 40);
  return cleaned || "经营";
}

function csvCell(value: unknown): string {
  let text = scalar(value).replace(/\r?\n/g, " ");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function scalar(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(scalar).join("、");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
