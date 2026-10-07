import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const MEMORY_PATH = resolve("config", "business-language-memory.json");

export async function loadBusinessLanguageMemory(): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(MEMORY_PATH, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("经营语言记忆不是有效对象");
  }
  return parsed as Record<string, unknown>;
}
