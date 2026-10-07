export function parseScheduleCommand(
  text: string,
): { enabled?: boolean; localTime?: string } | null {
  const normalized = text.trim();
  if (!/(?:自动同步|定时任务|自动填表)/.test(normalized)) return null;
  if (/(?:开启|启用|恢复|打开)/.test(normalized)) return { enabled: true };
  if (/(?:关闭|停用|暂停|停止)/.test(normalized)) return { enabled: false };
  const clock = normalized.match(/(?:时间|每天|改为|设置)[^\d]{0,12}([01]?\d|2[0-3])[:：]([0-5]\d)/);
  if (clock) return { localTime: `${clock[1].padStart(2, "0")}:${clock[2]}` };
  const chineseClock = normalized.match(/(上午|下午|晚上)?\s*(\d{1,2})\s*点(?:\s*(\d{1,2})\s*分?)?/);
  if (chineseClock) {
    let hour = Number(chineseClock[2]);
    const minute = Number(chineseClock[3] ?? 0);
    if (minute > 59 || hour > 23) return null;
    if ((chineseClock[1] === "下午" || chineseClock[1] === "晚上") && hour < 12) hour += 12;
    if (chineseClock[1] === "上午" && hour === 12) hour = 0;
    return { localTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
  }
  return null;
}
