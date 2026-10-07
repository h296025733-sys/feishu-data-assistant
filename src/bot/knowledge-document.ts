import * as XLSX from "xlsx";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_LENGTH = 50_000;

export async function readFeishuMessageFile(
  client: any,
  messageId: string,
  fileKey: string,
): Promise<Buffer> {
  const resource = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type: "file" },
  });
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of resource.getReadableStream()) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_FILE_BYTES) throw new Error("文件超过2MB，暂时不自动学习；请提炼关键段落后再发");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function extractKnowledgeDocument(fileName: string, buffer: Buffer): string {
  const extension = fileName.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  if ([".txt", ".md", ".csv", ".json", ".log"].includes(extension)) {
    const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
    if (!text.trim()) throw new Error("文件内容是空的");
    return text.slice(0, MAX_TEXT_LENGTH);
  }
  if ([".xlsx", ".xls"].includes(extension)) {
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
    const text = workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      return `工作表：${sheetName}\n${XLSX.utils.sheet_to_csv(sheet, { blankrows: false })}`;
    }).join("\n\n");
    if (!text.trim()) throw new Error("表格文件里没有可读取的单元格");
    return text.slice(0, MAX_TEXT_LENGTH);
  }
  throw new Error("目前可学习 TXT、Markdown、CSV、JSON、XLSX/XLS 文件；PDF、Word和飞书云文档链接暂未直接解析");
}
