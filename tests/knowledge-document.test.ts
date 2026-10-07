import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { extractKnowledgeDocument } from "../src/bot/knowledge-document.js";

describe("店铺知识文件解析", () => {
  it("读取UTF-8文本并拒绝不支持的格式", () => {
    expect(extractKnowledgeDocument("规则.md", Buffer.from("默认按销售额排名", "utf8"))).toContain("销售额");
    expect(() => extractKnowledgeDocument("制度.pdf", Buffer.from("pdf"))).toThrow("PDF");
  });

  it("读取XLSX中的多个工作表", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["商品", "简称"], ["Electric Trimmer", "电动磨脚器"]]), "商品规则");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const text = extractKnowledgeDocument("商品知识.xlsx", buffer);
    expect(text).toContain("工作表：商品规则");
    expect(text).toContain("电动磨脚器");
  });
});
