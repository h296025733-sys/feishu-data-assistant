import { createHash } from "node:crypto";
import { normalizeTikTokHandle } from "./tiktok-identity.js";
import type { RealtimeControlAction, RealtimeIntent } from "./types.js";

export interface ParsedRealtimeMessage {
  control: RealtimeControlAction | null;
  intent: RealtimeIntent | null;
  jobId?: string | null;
}

export function parseRealtimeMessage(text: string, now = new Date()): ParsedRealtimeMessage {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (/^(?:更新状态|任务状态|同步状态)$/.test(normalized)) return { control: "status", intent: null };
  if (/^(?:取消更新|取消同步)$/.test(normalized)) return { control: "cancel", intent: null };
  if (/^(?:继续|继续更新|继续同步|继续刚才的更新|继续刚才的删除)$/.test(normalized)) return { control: "continue", intent: null };
  const rollbackConfirm = normalized.match(/^确认回滚\s+(rt-\d{14}-[a-f0-9]{8})$/i);
  if (rollbackConfirm) {
    return { control: "rollback_confirm", intent: null, jobId: rollbackConfirm[1].toLowerCase() };
  }
  if (/^确认回滚(?:\s|$)/.test(normalized)) {
    return { control: "rollback_confirm", intent: null, jobId: null };
  }
  const rollbackPreview = normalized.match(/^回滚任务\s+(rt-\d{14}-[a-f0-9]{8})$/i);
  if (rollbackPreview) {
    return { control: "rollback_preview", intent: null, jobId: rollbackPreview[1].toLowerCase() };
  }
  if (/^回滚任务(?:\s|$)/.test(normalized)) {
    return { control: "rollback_preview", intent: null, jobId: null };
  }

  const deleteProduct = normalized.match(/^(?:请)?(?:帮我)?删除(?:投产比(?:中|里|中的|里的)?(?:的)?商品|投产比商品|商品)\s*[：:]?\s*(.*)$/);
  if (deleteProduct) {
    const productName = deleteProduct[1]
      .replace(/(?:的)?(?:全部)?(?:投产比)?(?:日记录|记录|数据)$/g, "")
      .trim();
    return {
      control: null,
      intent: {
        action: "delete_roi_product",
        target: "roi",
        ...(productName ? { productName } : {}),
      },
    };
  }

  const cooperationDrivenImport = parseCooperationDrivenOnlineImport(normalized);
  if (cooperationDrivenImport) return { control: null, intent: cooperationDrivenImport };

  const onlineImport = parseOnlineImportIntent(normalized, now);
  if (onlineImport) return { control: null, intent: onlineImport };

  const isUpdate = /^(?:请)?(?:帮我)?(?:更新|同步|刷新)/.test(normalized);
  if (isUpdate) {
    const { startDate, endDateInclusive } = parseDateRange(normalized, now);
    if (/投产比|roi/i.test(normalized)) {
      return {
        control: null,
        intent: {
          action: "update_roi",
          startDate,
          endDateInclusive,
          target: "roi",
          productName: extractRoiProduct(normalized),
        },
      };
    }
    if (/全部可自动获取|全部自动|所有可自动获取|更新全部/.test(normalized)) {
      return {
        control: null,
        intent: { action: "update_all", startDate, endDateInclusive, target: "all" },
      };
    }
    if (/视频|上线表|上线数据|播放|曝光/.test(normalized)) {
      return {
        control: null,
        intent: { action: "update_video", startDate, endDateInclusive, target: "online" },
      };
    }
  }

  const create = normalized.match(/^(?:新增|新建|添加)(?:一条)?合作(?:记录)?[：:\s]*(.*)$/);
  if (create) {
    return {
      control: null,
      intent: { action: "create_cooperation", details: create[1]?.trim() ?? "", target: "cooperation" },
    };
  }

  const modify = normalized.match(/^(?:修改|更改|改一下)(.*)$/);
  if (modify) {
    const details = modify[1]?.trim() ?? "";
    const target = /视频|上线/.test(details)
      ? "online"
      : /合作/.test(details)
        ? "cooperation"
        : /开发/.test(details)
          ? "development"
          : "unknown";
    return {
      control: null,
      intent: { action: "modify_business", details, target },
    };
  }
  return { control: null, intent: null };
}

function parseCooperationDrivenOnlineImport(text: string): RealtimeIntent | null {
  const mentionsCooperation = /合作表|合作记录|寄样数据|寄样记录|刚合作/.test(text);
  const requestsCompletion = /补|同步|写入|导入|更新/.test(text);
  const targetsOnlineData = /红人表|上线表|视频|表格|表里|表中/.test(text);
  if (!mentionsCooperation || !requestsCompletion || !targetsOnlineData) return null;
  return {
    action: "import_online_from_cooperations",
    target: "online",
    scope: /刚填写|刚才|最新|最近一条|这条|刚合作/.test(text) ? "latest" : "all",
  };
}

function parseOnlineImportIntent(text: string, now: Date): RealtimeIntent | null {
  if (
    !/(?:写入|填入|录入|导入|同步到|新增到|添加到)/.test(text)
    || !/(?:红人上线表|达人上线表|上线表|表格|表里|表中)/.test(text)
    || /投产比|\broi\b/i.test(text)
  ) return null;

  const profileHandle = text.match(/tiktok\.com\/@([a-z0-9._]+)/i)?.[1];
  const labelledHandle = text.match(/(?:达人|红人|账号|TK号)\s*[：:]?\s*@?([a-z][a-z0-9._]{1,31})/i)?.[1];
  const objectHandle = text.match(/把\s*@?([a-z][a-z0-9._]{1,31})(?:\s|在|于)/i)?.[1];
  const leadingHandle = text.match(/^\s*@?([a-z][a-z0-9._]{1,31})(?=近|最近|过去|前|今|昨|写|填|录|导|同步|\s|\d)/i)?.[1];
  const creatorHandle = normalizeTikTokHandle(profileHandle ?? labelledHandle ?? objectHandle ?? leadingHandle);
  const videoId = text.match(/(?:\/video\/|视频(?:ID)?\s*[：:]?\s*)(\d{10,})/i)?.[1];
  if (!creatorHandle && !videoId) return null;
  const range = parseExplicitOnlineDateRange(text, now);
  if (!range) {
    if (!creatorHandle) return null;
    return {
      action: "clarify_online_import",
      target: "online",
      creatorHandle,
      reason: "missing_date",
    };
  }
  const { startDate, endDateInclusive } = range;
  return {
    action: "import_online_videos",
    startDate,
    endDateInclusive,
    target: "online",
    ...(creatorHandle ? { creatorHandle } : {}),
    ...(videoId ? { videoId } : {}),
  };
}

function parseExplicitOnlineDateRange(
  text: string,
  now: Date,
): { startDate: string; endDateInclusive: string } | null {
  const isoRange = text.match(/(\d{4}-\d{2}-\d{2})\s*(?:至|到|~|～)\s*(\d{4}-\d{2}-\d{2})/);
  if (isoRange) {
    assertIsoDate(isoRange[1]);
    assertIsoDate(isoRange[2]);
    if (isoRange[2] < isoRange[1]) throw new Error("更新结束日期不能早于开始日期");
    return { startDate: isoRange[1], endDateInclusive: isoRange[2] };
  }
  const isoSingle = text.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoSingle) {
    assertIsoDate(isoSingle);
    return { startDate: isoSingle, endDateInclusive: isoSingle };
  }
  const rolling = text.match(/(?:近|最近|过去|前)\s*(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*(天|日|周|星期|个?月)/);
  if (rolling) {
    const count = chineseNumber(rolling[1]);
    if (count == null || count < 1) return null;
    const days = /月/.test(rolling[2]) ? count * 30 : /周|星期/.test(rolling[2]) ? count * 7 : count;
    const today = shanghaiDateKey(now);
    const includesToday = /(?:含|包括|包含|算上?)今天|截至今天|到今天/.test(text);
    const endDateInclusive = includesToday ? today : shiftIsoDate(today, -1);
    return {
      startDate: shiftIsoDate(endDateInclusive, -(days - 1)),
      endDateInclusive,
    };
  }
  if (/今天|今日/.test(text)) {
    const date = shanghaiDateKey(now);
    return { startDate: date, endDateInclusive: date };
  }
  if (/昨天|昨日/.test(text)) {
    const date = shiftIsoDate(shanghaiDateKey(now), -1);
    return { startDate: date, endDateInclusive: date };
  }
  const monthDay = text.match(/(\d{1,2})\s*(?:月|\/)\s*(\d{1,2})\s*日?/);
  if (monthDay) {
    const date = `${shanghaiDateKey(now).slice(0, 4)}-${monthDay[1].padStart(2, "0")}-${monthDay[2].padStart(2, "0")}`;
    assertIsoDate(date);
    return { startDate: date, endDateInclusive: date };
  }
  return null;
}

function chineseNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === "十") return 10;
  if (value in digits) return digits[value];
  const teen = value.match(/^十([一二三四五六七八九])$/);
  if (teen) return 10 + digits[teen[1]];
  const tens = value.match(/^([二三四五六七八九])十([一二三四五六七八九])?$/);
  return tens ? digits[tens[1]] * 10 + (tens[2] ? digits[tens[2]] : 0) : null;
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
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function extractRoiProduct(text: string): string | undefined {
  const value = text
    .replace(/^(?:请)?(?:帮我)?(?:更新|同步|刷新)/, "")
    .replace(/投产比|roi/gi, "")
    .replace(/\d{4}-\d{2}-\d{2}\s*(?:至|到|~|～)\s*\d{4}-\d{2}-\d{2}/g, "")
    .replace(/\d{4}-\d{2}-\d{2}/g, "")
    .replace(/(?:的)?(?:数据|记录|日报)/g, "")
    .trim()
    .replace(/^[：:\s]+|[：:\s]+$/g, "");
  return value || undefined;
}

function parseDateRange(text: string, now: Date): { startDate: string; endDateInclusive: string } {
  const range = text.match(/(\d{4}-\d{2}-\d{2})\s*(?:至|到|~|～)\s*(\d{4}-\d{2}-\d{2})/);
  if (range) {
    assertIsoDate(range[1]);
    assertIsoDate(range[2]);
    if (range[2] < range[1]) throw new Error("更新结束日期不能早于开始日期");
    return { startDate: range[1], endDateInclusive: range[2] };
  }
  const single = text.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (single) {
    assertIsoDate(single);
    return { startDate: single, endDateInclusive: single };
  }
  const relative = new Date(now);
  if (/昨天|昨日/.test(text) || !/今天|今日/.test(text)) relative.setDate(relative.getDate() - 1);
  const date = localDateKey(relative);
  return { startDate: date, endDateInclusive: date };
}

function assertIsoDate(value: string): void {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`日期无效：${value}`);
  }
}

export function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function nextDate(value: string): string {
  assertIsoDate(value);
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function enumerateDates(start: string, endInclusive: string): string[] {
  assertIsoDate(start);
  assertIsoDate(endInclusive);
  if (endInclusive < start) throw new Error("结束日期不能早于开始日期");
  const values: string[] = [];
  for (let current = start; current <= endInclusive; current = nextDate(current)) {
    values.push(current);
    if (values.length > 366) throw new Error("单次更新日期范围不能超过 366 天");
  }
  return values;
}

export function canonicalIntent(intent: RealtimeIntent): string {
  return JSON.stringify(intent, Object.keys(intent).sort());
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
