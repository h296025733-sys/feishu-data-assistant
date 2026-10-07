import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { AppEnv } from "../config/env.js";
import { estimateCost, logModelCall } from "../ai/cost-log.js";
import { loadBusinessLanguageMemory } from "../ai/business-language-memory.js";
import { requireCanonicalProductName } from "../business/product-naming.js";
import { enumerateDates, nextDate } from "./intent.js";
import type { RealtimeIntent } from "./types.js";

const PRODUCT_MAP_PATH = resolve("config", "tiktok-product-map.json");
const WRITE_VERB = /(?:填(?:入|进|上)|录入|写(?:入|进|上)|同步|更新|刷新|导入|补(?:入|上|到|齐)|拉取|抓取)/;
const ROI_DATA_NOUN = /(?:单量|订单|销量|出单|商品|店铺|投产比|ROI|数据)/i;
const ONLINE_WORKFLOW_NOUN = /(?:合作表|合作记录|寄样|红人表|上线表|上线视频|达人视频)/i;

const modelResultSchema = z.object({
  isWriteIntent: z.boolean(),
  action: z.enum(["update_roi", "import_online_from_cooperations"]).nullable(),
  startDate: z.string().nullable(),
  endDateInclusive: z.string().nullable(),
  productScope: z.enum(["single", "all_mapped"]).nullable(),
  productName: z.string().nullable(),
  rowFilter: z.enum(["all", "orders_positive"]).nullable(),
  cooperationScope: z.enum(["latest", "all"]).nullable(),
}).strict();

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function parseKnownNaturalRoiIntent(
  text: string,
  now = new Date(),
  knownProducts: readonly string[] = [],
): RealtimeIntent | null {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!isNaturalWriteCandidate(normalized)) return null;
  if (ONLINE_WORKFLOW_NOUN.test(normalized) && !/(?:单量|订单|销量|出单|店铺|投产比|ROI)/i.test(normalized)) {
    return null;
  }
  const onlyOrders = /(?:有单量|有订单|有销量|有出单|出过单|单量\s*(?:大于|超过|>)\s*0)/.test(normalized);
  const window = knownDateWindow(normalized, now);
  if (!window) return null;
  const matchingProducts = knownProducts
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => normalized.includes(value))
    .sort((left, right) => right.length - left.length);
  const productName = matchingProducts[0];

  return {
    action: "update_roi",
    startDate: window.startDate,
    endDateInclusive: window.endDateInclusive,
    target: "roi",
    productScope: productName ? "single" : "all_mapped",
    ...(productName ? { productName } : {}),
    rowFilter: onlyOrders ? "orders_positive" : "all",
  };
}

function knownDateWindow(
  text: string,
  now: Date,
): { startDate: string; endDateInclusive: string } | null {
  const isoRange = text.match(/(\d{4}-\d{2}-\d{2})\s*(?:至|到|~|～)\s*(\d{4}-\d{2}-\d{2})/);
  if (isoRange) return validatedWindow(isoRange[1], isoRange[2]);

  const isoSingle = text.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoSingle) return validatedWindow(isoSingle, isoSingle);

  const chineseFull = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (chineseFull) {
    const date = `${chineseFull[1]}-${chineseFull[2].padStart(2, "0")}-${chineseFull[3].padStart(2, "0")}`;
    return validatedWindow(date, date);
  }

  const monthDay = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (monthDay) {
    const year = shanghaiDateKey(now).slice(0, 4);
    const date = `${year}-${monthDay[1].padStart(2, "0")}-${monthDay[2].padStart(2, "0")}`;
    return validatedWindow(date, date);
  }

  const rolling = rollingDateWindow(text, now);
  if (rolling) return rolling;

  if (/今天|今日/.test(text)) {
    const date = shanghaiDateKey(now);
    return validatedWindow(date, date);
  }
  if (/昨天|昨日/.test(text)) {
    const date = shiftIsoDate(shanghaiDateKey(now), -1);
    return validatedWindow(date, date);
  }

  return null;
}

function validatedWindow(
  startDate: string,
  endDateInclusive: string,
): { startDate: string; endDateInclusive: string } {
  enumerateDates(startDate, endDateInclusive);
  return { startDate, endDateInclusive };
}

function rollingDateWindow(
  text: string,
  now: Date,
): { startDate: string; endDateInclusive: string } | null {
  const match = text.match(/(?:近|最近|过去|前)\s*(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*(天|日|周|星期|个?月)/);
  if (!match) return null;
  const count = chineseNumber(match[1]);
  if (count == null || count < 1) return null;
  const days = /月/.test(match[2]) ? count * 30 : /周|星期/.test(match[2]) ? count * 7 : count;
  const today = shanghaiDateKey(now);
  const includesToday = /(?:含|包括|包含|算上?)今天|截至今天|到今天/.test(text);
  const endDateInclusive = includesToday ? today : shiftIsoDate(today, -1);
  return {
    startDate: shiftIsoDate(endDateInclusive, -(days - 1)),
    endDateInclusive,
  };
}

function chineseNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const digit: Record<string, number> = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (value === "十") return 10;
  if (value in digit) return digit[value];
  const teens = value.match(/^十([一二三四五六七八九])$/);
  if (teens) return 10 + digit[teens[1]];
  const tens = value.match(/^([二三四五六七八九])十([一二三四五六七八九])?$/);
  if (tens) return digit[tens[1]] * 10 + (tens[2] ? digit[tens[2]] : 0);
  return null;
}

export function isNaturalWriteCandidate(text: string): boolean {
  return WRITE_VERB.test(text) && (ROI_DATA_NOUN.test(text) || ONLINE_WORKFLOW_NOUN.test(text));
}

export class NaturalWriteIntentResolver {
  public constructor(private readonly env: AppEnv) {}

  public async resolve(text: string, now = new Date()): Promise<RealtimeIntent | null> {
    const products = await mappedProductNames();
    const local = parseKnownNaturalRoiIntent(text, now, products);
    if (local) return local;
    if (!isNaturalWriteCandidate(text) || this.env.MODEL_PROVIDER !== "deepseek") return null;
    try {
      return await this.resolveWithDeepSeek(text, now, products);
    } catch {
      return null;
    }
  }

  private async resolveWithDeepSeek(
    text: string,
    now: Date,
    products: readonly string[],
  ): Promise<RealtimeIntent | null> {
    const businessLanguageMemory = await loadBusinessLanguageMemory();
    const today = shanghaiDateKey(now);
    const system = [
      "你只把用户的写入要求翻译成受控业务意图，不执行写入，不补造数据。",
      `当前上海日期是 ${today}。相对日期均按 Asia/Shanghai 计算。`,
      "‘近一周/最近一周/过去7天’固定解释为不含今天的最近7个完整自然日。",
      "‘近一个月’固定按滚动30个自然日解释；用户明确说含今天时结束日为今天，否则只取完整日并在昨天结束。",
      "‘有单量/有订单/出过单’固定解释为 orders_positive；否则为 all。",
      "没有点名商品时只能使用 all_mapped；点名商品时必须逐字取自候选商品。",
      "用户要求根据合作表、寄样记录补全/复核红人上线视频时，action=import_online_from_cooperations；刚填写/刚才/最新一条用 cooperationScope=latest，否则用 all。该动作的日期和投产比字段全部为null。",
      "只有用户明确表达填入、录入、写入、同步、更新、导入等修改动作时，isWriteIntent 才能为 true。查询、询问、看看、统计不能判为写入。",
      "仅输出严格 JSON，字段为 isWriteIntent, action, startDate, endDateInclusive, productScope, productName, rowFilter, cooperationScope。非写入意图时 action 和其余业务字段均为 null。",
      `长期经营语言记忆：${JSON.stringify(businessLanguageMemory)}`,
    ].join("\n");
    const completion = await deepSeekJson(
      this.env,
      system,
      `候选商品：${JSON.stringify(products)}\n用户原话：${text}`,
    );
    const parsed = modelResultSchema.parse(JSON.parse(completion));
    if (!parsed.isWriteIntent || !parsed.action) return null;
    if (parsed.action === "import_online_from_cooperations") {
      if (!parsed.cooperationScope) return null;
      if (parsed.startDate || parsed.endDateInclusive || parsed.productScope || parsed.productName || parsed.rowFilter) return null;
      return {
        action: "import_online_from_cooperations",
        target: "online",
        scope: parsed.cooperationScope,
      };
    }
    if (!parsed.startDate || !parsed.endDateInclusive || !parsed.productScope || !parsed.rowFilter) {
      return null;
    }
    enumerateDates(parsed.startDate, parsed.endDateInclusive);
    if (enumerateDates(parsed.startDate, parsed.endDateInclusive).length > 31) return null;
    if (parsed.productScope === "single") {
      if (!parsed.productName || !products.includes(parsed.productName)) return null;
    } else if (parsed.productName) {
      return null;
    }
    return {
      action: "update_roi",
      startDate: parsed.startDate,
      endDateInclusive: parsed.endDateInclusive,
      target: "roi",
      productScope: parsed.productScope,
      productName: parsed.productName ?? undefined,
      rowFilter: parsed.rowFilter,
    };
  }
}

async function mappedProductNames(): Promise<string[]> {
  const parsed = JSON.parse(await readFile(PRODUCT_MAP_PATH, "utf8")) as {
    products?: Record<string, unknown>;
  };
  return Object.values(parsed.products ?? {}).map(String).map(requireCanonicalProductName).filter(Boolean);
}

async function deepSeekJson(env: AppEnv, system: string, user: string): Promise<string> {
  const started = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let success = false;
  try {
    const baseUrl = env.DEEPSEEK_BASE_URL.replace(/\/$/, "");
    const endpoint = `${baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`}/chat/completions`;
    const apiKey = env.DEEPSEEK_API_KEY.startsWith("sk-") ? env.DEEPSEEK_API_KEY : `sk-${env.DEEPSEEK_API_KEY}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: env.DEEPSEEK_MODEL,
        temperature: 0,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`DeepSeek 写入意图解析失败：HTTP ${response.status}`);
    const data = await response.json() as ChatResponse;
    inputTokens = data.usage?.prompt_tokens ?? 0;
    outputTokens = data.usage?.completion_tokens ?? 0;
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek 未返回写入意图");
    success = true;
    return content;
  } finally {
    logModelCall({
      timestamp: new Date().toISOString(),
      model: env.DEEPSEEK_MODEL,
      inputTokens,
      outputTokens,
      durationMs: Date.now() - started,
      success,
      estimatedCost: estimateCost(env, inputTokens, outputTokens),
    });
  }
}

function shanghaiDateKey(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function shiftIsoDate(value: string, days: number): string {
  const shifted = value;
  let current = shifted;
  const count = Math.abs(days);
  for (let index = 0; index < count; index += 1) {
    if (days >= 0) current = nextDate(current);
    else {
      const date = new Date(`${current}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() - 1);
      current = date.toISOString().slice(0, 10);
    }
  }
  return current;
}
