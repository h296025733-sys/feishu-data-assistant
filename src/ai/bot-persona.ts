import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PERSONA_PATH = resolve("config", "bot-persona.json");

export async function loadBotPersona(): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(PERSONA_PATH, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("机器人表达人格配置不是有效对象");
  }
  return parsed as Record<string, unknown>;
}
