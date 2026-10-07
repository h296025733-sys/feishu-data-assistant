import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeText } from "../utils/value.js";

export interface StoreMemoryFact {
  id: string;
  text: string;
  source: "chat" | "document";
  createdAt: string;
  createdBy: string;
}

interface StoreMemoryFile {
  version: 1;
  facts: StoreMemoryFact[];
}

export type StoreMemoryAction =
  | { kind: "saved"; text: string }
  | { kind: "forgotten"; text: string }
  | { kind: "listed"; text: string };

export class StoreMemoryService {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(tenantId: string, runtimeRoot = path.resolve(".runtime", "tenants")) {
    this.filePath = path.join(runtimeRoot, tenantId, "store-memory.json");
  }

  public async handleMessage(text: string, userId: string): Promise<StoreMemoryAction | null> {
    const trimmed = text.trim();
    if (/^(?:店铺记忆|查看店铺记忆|你记住了什么|你对我们店了解多少|我们店的规则)$/i.test(trimmed)) {
      const facts = await this.list();
      return {
        kind: "listed",
        text: facts.length === 0
          ? "🧠 我还没有保存这家店的长期知识。\n\n你可以自然地说“记住：我们把……叫作……”或“以后按……口径”。表格实时数据不需要记，它每次都会重新读取。"
          : [
              `🧠 目前记住了 ${facts.length} 条店铺知识：`,
              "",
              ...facts.slice(-20).map((fact, index) => `${index + 1}. ${fact.text}`),
              facts.length > 20 ? `\n还有 ${facts.length - 20} 条较早记录未展开。` : null,
              "",
              "需要纠正时，直接说“忘记：关键词”，再告诉我新规则。",
            ].filter((line): line is string => line !== null).join("\n"),
      };
    }

    const forget = trimmed.match(/^(?:忘记|删除记忆|移除记忆|不要再记得)\s*[:：]?\s*(.{1,200})$/i);
    if (forget) {
      const removed = await this.forget(forget[1]);
      return {
        kind: "forgotten",
        text: removed > 0
          ? `🧹 已移除 ${removed} 条相关店铺记忆。表格原始数据没有改动。`
          : "没有找到匹配的店铺记忆，所以没有删除任何内容。",
      };
    }

    const remembered = extractMemoryFact(trimmed);
    if (!remembered) return null;
    const source = /^(?:学习文档|文档要点)/.test(trimmed) ? "document" : "chat";
    const result = await this.remember(remembered, userId, source);
    return {
      kind: "saved",
      text: result.created
        ? `🧠 记住了：${result.fact.text}\n\n以后这个店铺群提到相关问题时，我会把它作为理解背景；实时数字仍以多维表格为准。`
        : `这条店铺知识我已经记着：${result.fact.text}`,
    };
  }

  public async relevantFacts(question: string, limit = 8): Promise<string[]> {
    const facts = await this.list();
    if (facts.length === 0) return [];
    const questionTokens = tokenSet(question);
    return facts
      .map((fact, index) => ({
        fact,
        index,
        score: overlapScore(questionTokens, tokenSet(fact.text))
          + (/默认|统一|口径|简称|称为|指的是|规则|以后/.test(fact.text) ? 0.5 : 0),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.index - left.index)
      .slice(0, limit)
      .map((item) => item.fact.text);
  }

  public async learnDocument(fileName: string, content: string, userId: string): Promise<number> {
    const chunks = splitDocumentKnowledge(content).slice(0, 20);
    if (chunks.length === 0) throw new Error("文档里没有可保存的普通业务文字，或内容只有密钥等敏感信息");
    let created = 0;
    for (const chunk of chunks) {
      const result = await this.remember(`[文档 ${fileName}] ${chunk}`, userId, "document");
      if (result.created) created += 1;
    }
    return created;
  }

  public async list(): Promise<StoreMemoryFact[]> {
    const state = await this.read();
    return [...state.facts];
  }

  private async remember(
    text: string,
    userId: string,
    source: StoreMemoryFact["source"],
  ): Promise<{ fact: StoreMemoryFact; created: boolean }> {
    return this.serial(async () => {
      const state = await this.read();
      const normalized = normalizeText(text);
      const existing = state.facts.find((fact) => normalizeText(fact.text) === normalized);
      if (existing) return { fact: existing, created: false };
      const fact: StoreMemoryFact = {
        id: `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        text: text.trim().slice(0, 500),
        source,
        createdAt: new Date().toISOString(),
        createdBy: userId,
      };
      state.facts.push(fact);
      if (state.facts.length > 100) state.facts.splice(0, state.facts.length - 100);
      await this.write(state);
      return { fact, created: true };
    });
  }

  private async forget(keyword: string): Promise<number> {
    return this.serial(async () => {
      const state = await this.read();
      const needle = normalizeText(keyword);
      const before = state.facts.length;
      state.facts = state.facts.filter((fact) => !normalizeText(fact.text).includes(needle));
      const removed = before - state.facts.length;
      if (removed > 0) await this.write(state);
      return removed;
    });
  }

  private async read(): Promise<StoreMemoryFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<StoreMemoryFile>;
      return { version: 1, facts: Array.isArray(parsed.facts) ? parsed.facts.slice(-100) : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, facts: [] };
      throw error;
    }
  }

  private async write(state: StoreMemoryFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function extractMemoryFact(text: string): string | null {
  const explicit = text.match(/^(?:请?记住|帮我记住|店铺规则|以后记得|学习文档|文档要点)\s*[:：]?\s*(.{2,500})$/i);
  if (explicit) return explicit[1].trim();
  if (/^(?:以后|今后)(?:我们|本店|这个店|这个群)/.test(text) && text.length <= 500) return text;
  if (/^.{1,60}(?:我们叫|以后叫|简称是|指的是).{1,80}$/.test(text)) return text;
  return null;
}

function tokenSet(text: string): Set<string> {
  const normalized = normalizeText(text).replace(/[^\p{Script=Han}a-z0-9]+/giu, "");
  const tokens = new Set<string>();
  for (let length = 2; length <= 4; length += 1) {
    for (let index = 0; index + length <= normalized.length; index += 1) {
      tokens.add(normalized.slice(index, index + length));
    }
  }
  return tokens;
}

function overlapScore(left: Set<string>, right: Set<string>): number {
  let score = 0;
  for (const token of left) if (right.has(token)) score += token.length;
  return score;
}

function splitDocumentKnowledge(content: string): string[] {
  const safeLines = content
    .replace(/\r\n?/g, "\n")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 2)
    .filter((line) => !/(?:app[_\s-]*secret|client[_\s-]*secret|access[_\s-]*token|refresh[_\s-]*token|授权码|密码|密钥)\s*[:：=]/i.test(line));
  const chunks: string[] = [];
  let current = "";
  for (const line of safeLines) {
    const pieces = line.length > 450 ? line.match(/.{1,450}/g) ?? [] : [line];
    for (const piece of pieces) {
      if (current && current.length + piece.length + 1 > 450) {
        chunks.push(current);
        current = piece;
      } else {
        current = current ? `${current}；${piece}` : piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
