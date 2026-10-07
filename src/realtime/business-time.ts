const SHOP_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

export function shopTimestampToBusinessDate(
  value: unknown,
  shopTimeZone: string,
  businessTimeZone: string,
): string {
  const instant = zonedWallTimeToInstant(String(value ?? "").trim(), shopTimeZone);
  return dateKeyInTimeZone(instant, businessTimeZone);
}

export function businessDateRangeToShopDateRange(
  startDate: string,
  endDateInclusive: string,
  businessTimeZone: string,
  shopTimeZone: string,
): { startDate: string; endDateExclusive: string } {
  const start = zonedWallTimeToInstant(`${startDate} 00:00:00`, businessTimeZone);
  const businessEndExclusive = zonedWallTimeToInstant(
    `${shiftIsoDate(endDateInclusive, 1)} 00:00:00`,
    businessTimeZone,
  );
  const sourceStartDate = dateKeyInTimeZone(start, shopTimeZone);
  const sourceEndInclusive = dateKeyInTimeZone(
    new Date(businessEndExclusive.getTime() - 1),
    shopTimeZone,
  );
  return {
    startDate: sourceStartDate,
    endDateExclusive: shiftIsoDate(sourceEndInclusive, 1),
  };
}

export function zonedWallTimeToInstant(value: string, timeZone: string): Date {
  const match = SHOP_TIMESTAMP_PATTERN.exec(value);
  if (!match) throw new Error(`时间格式无效：${value || "空值"}`);
  const expected = match.slice(1).map(Number);
  const [year, month, day, hour, minute, second] = expected;
  const expectedAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (
    new Date(expectedAsUtc).toISOString().slice(0, 19).replace("T", " ") !== value.replace("T", " ")
  ) {
    throw new Error(`时间数值无效：${value}`);
  }

  let instantMs = expectedAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = dateTimeParts(new Date(instantMs), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const correction = expectedAsUtc - actualAsUtc;
    if (correction === 0) break;
    instantMs += correction;
  }
  const instant = new Date(instantMs);
  const actual = dateTimeParts(instant, timeZone);
  if (expected.some((part, index) => part !== [
    actual.year, actual.month, actual.day, actual.hour, actual.minute, actual.second,
  ][index])) {
    throw new Error(`时间${value}在时区${timeZone}中不存在或无法唯一换算`);
  }
  return instant;
}

export function dateKeyInTimeZone(value: Date, timeZone: string): string {
  const parts = dateTimeParts(value, timeZone);
  return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

function dateTimeParts(value: Date, timeZone: string): Record<"year" | "month" | "day" | "hour" | "minute" | "second", number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]),
  );
  return values as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
}

export function shiftIsoDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`日期格式无效：${value}`);
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
