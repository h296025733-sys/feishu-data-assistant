export interface StoreInitializationCommand {
  days: number | null;
  force: boolean;
  resume?: boolean;
}

/** High-confidence navigation intent that should not be routed as a table query. */
export function isBusinessBaseLinkRequest(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, "");
  const namesTheWorkspace = /多维表格|多维表|(?:^|[^a-z])base(?:[^a-z]|$)|经营工作台|数据工作台/i.test(normalized);
  const asksToOpenOrSend = /链接|地址|网址|发(?:给|来)|给我|打开|进入|看看|看一下|瞅瞅/.test(normalized);
  return namesTheWorkspace && asksToOpenOrSend;
}

/** High-confidence request about the currently running or most recent background task. */
export function isTaskStatusRequest(text: string): boolean {
  const normalized = text
    .trim()
    .replace(/\s+/g, "")
    .replace(/[？?！!。]+$/g, "");
  if (/^(?:自动同步状态|同步状态|定时任务状态|今天同步了吗|更新状态|任务状态)$/.test(normalized)) {
    return true;
  }
  return /^(?:(?:你|机器人)?(?:现在|目前|此刻|刚刚|刚才)?(?:在)?(?:执行|处理|跑)(?:着)?(?:什么|哪个)?任务(?:呢|呀|啊)?|(?:刚刚|刚才|上次|当前|现在|目前)?(?:的)?(?:任务|补齐|初始化|同步)(?:状态|进度|情况)(?:怎么样|如何|到哪(?:儿|里)?了|呢|呀|啊)?|(?:这个|那个|当前|刚刚|刚才)?(?:任务|补齐|初始化|同步)(?:还在跑|还在执行|完成了吗|结束了吗|到哪(?:儿|里)?了|还在跑吗|还在执行吗))$/.test(normalized);
}

/** The most recent scheduled/automatic run, not a manual initialization/backfill task. */
export function isAutomaticSyncResultRequest(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, "").replace(/[？?！!。]+$/g, "");
  const namesAutomaticRun = /(?:自动|定时|每天|今日|今天|刚刚|刚才|上次|上一轮).*(?:同步|更新)/.test(normalized)
    || /(?:同步|更新).*(?:自动|定时|每天|今日|今天|刚刚|刚才|上次|上一轮)/.test(normalized);
  const asksResult = /(?:成功|失败|完成|结果|情况|状态|更新了什么|同步了什么|写了什么|改了什么|新增了什么|跑了什么|有没有跑)/.test(normalized);
  const mentionsScheduledTime = /(?:今天|今日).*(?:\d{1,2}(?::\d{2})?|[一二两三四五六七八九十]{1,3})点.*(?:同步|更新)/.test(normalized);
  return (namesAutomaticRun && asksResult) || mentionsScheduledTime;
}

/** A read-only request for the newest business values already present in the Base. */
export function isLatestBusinessDataRequest(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, "").replace(/[？?！!。]+$/g, "");
  if (!/(?:最新|刚更新|刚同步|最近更新|本次更新)/.test(normalized)) return false;
  if (!/(?:数据|经营情况|经营结果|销售|单量|销量)/.test(normalized)) return false;
  if (/(?:写入|填入|录入|导入|同步到|更新到|修改|删除).*(?:表|多维表)/.test(normalized)) return false;
  return /(?:发给我|给我|看看|看下|查询|查下|告诉我|汇报|展示|怎么样|是什么|有哪些)/.test(normalized);
}

/** Questions about the configured run time and which business date can be written next. */
export function isScheduleExpectationRequest(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, "").replace(/[？?！!。]+$/g, "");
  const asksTime = /(?:今天|明天|下次|自动)?(?:几点|什么时间|什么时候)(?:能|会|可以)?(?:更新|同步|跑)/.test(normalized)
    || /(?:更新|同步)(?:时间|是几点)/.test(normalized)
    || /(?:还有|再过|距离).*(?:多少分钟|多久|多长时间).*(?:更新|同步)/.test(normalized)
    || /(?:还有|再过).*(?:更新|同步).*(?:多少分钟|多久|多长时间)/.test(normalized);
  const asksBusinessDate = /(?:更新|同步|写入|补齐).*(?:几号|哪天|什么日期).*(?:数据)?/.test(normalized)
    || /(?:几号|哪天|什么日期)的?数据.*(?:更新|同步|写入)/.test(normalized);
  return asksTime || asksBusinessDate;
}

export function parseStoreInitializationCommand(text: string): StoreInitializationCommand | null {
  const normalized = text.trim().replace(/\s+/g, "");
  if (/^(?:初始化店铺继续|继续初始化(?:店铺)?|继续补齐(?:数据)?|继续上次(?:初始化|补齐|任务)|接着补齐)$/.test(normalized)) {
    return { days: null, force: true, resume: true };
  }
  if (/^(?:初始化店铺|初始化多维表格|初始化经营工作台|开始初始化)$/.test(normalized)) {
    return { days: null, force: false };
  }

  const action = /初始化|补齐|补全|回填|写入|更新|同步/.test(normalized);
  if (!action) return null;

  if (/(?:最近|近)(?:一|1|一个)个?月/.test(normalized)) {
    return { days: 30, force: true };
  }

  const dayText = normalized.match(/(?:最近|近)([0-9]{1,3}|[零〇一二两三四五六七八九十百]{1,5})天/);
  if (!dayText) return null;
  const days = parseNaturalNumber(dayText[1]);
  return days == null ? null : { days, force: true };
}

function parseNaturalNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (value === "十") return 10;
  if (value === "百") return 100;
  if (value.includes("百")) {
    const [hundredsText, remainderText = ""] = value.split("百", 2);
    const hundreds = digits[hundredsText] ?? 1;
    const remainder = remainderText ? parseNaturalNumber(remainderText) : 0;
    return remainder == null ? null : hundreds * 100 + remainder;
  }
  if (value.includes("十")) {
    const [tensText, onesText = ""] = value.split("十", 2);
    const tens = tensText ? digits[tensText] : 1;
    const ones = onesText ? digits[onesText] : 0;
    return tens == null || ones == null ? null : tens * 10 + ones;
  }
  return value.length === 1 ? digits[value] ?? null : null;
}
