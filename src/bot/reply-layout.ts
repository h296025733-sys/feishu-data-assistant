/**
 * Keeps model-written replies readable in Feishu even when the model returns a
 * single dense paragraph. This changes layout only; it never changes facts.
 */
export function formatReadableBotReply(text: string): string {
  let value = text
    .replace(/\r\n?/g, "\n")
    .trim()
    .replace(/\n?数据依据：[^\n]*(?:\n|$)/g, "")
    .replace(/([：:])\s*(?=[^，。\n]{1,50}(?:排第|并列第))/g, "$1\n\n")
    .replace(/([：:])\s*(?=\d+[）)])/g, "$1\n")
    .replace(/，\s*(?=[^，。\n]{1,50}(?:排第|并列第))/g, "\n")
    .replace(/[；;]\s*(?=第?[一二三四五六七八九十0-9]+名)/g, "\n")
    .replace(/([。！？])\s*(一句话总结|总结|重点|提醒|注意|不过|但目前|当前能确认)[:：]?/g, "$1\n\n$2：")
    .replace(/([。；])\s*(\d+[）)])\s*/g, "$1\n$2 ")
    .replace(/(^|\n)(\d+[）)])\s*/g, "$1$2 ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!value.includes("\n") && value.length >= 110) {
    const sentences = value.match(/[^。！？]+[。！？]?/g)?.map((item) => item.trim()).filter(Boolean) ?? [value];
    const paragraphs: string[] = [];
    let current = "";
    for (const sentence of sentences) {
      if (current && current.length + sentence.length > 72) {
        paragraphs.push(current);
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current) paragraphs.push(current);
    value = paragraphs.join("\n\n");
  }
  return value;
}
