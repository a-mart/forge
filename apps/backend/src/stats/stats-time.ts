import type { StatsRange } from "@forge/protocol";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const SERVER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const dayKeyFormatters = new Map<string, Intl.DateTimeFormat>();
const dateTimePartFormatters = new Map<string, Intl.DateTimeFormat>();

export function normalizeTimezone(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return SERVER_TIMEZONE;
  }

  const timezone = value.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return SERVER_TIMEZONE;
  }
}

export function toDayKey(timestampMs: number, timezone: string): string {
  const formatter = getDayKeyFormatter(timezone);
  const parts = formatter.formatToParts(new Date(timestampMs));

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    const fallbackDate = new Date(timestampMs);
    const fallbackYear = fallbackDate.getUTCFullYear();
    const fallbackMonth = `${fallbackDate.getUTCMonth() + 1}`.padStart(2, "0");
    const fallbackDay = `${fallbackDate.getUTCDate()}`.padStart(2, "0");
    return `${fallbackYear}-${fallbackMonth}-${fallbackDay}`;
  }

  return `${year}-${month}-${day}`;
}

export function dayKeyToStartMs(dayKey: string, timezone: string): number {
  const baseMs = dayKeyToMs(dayKey);
  if (baseMs <= 0) {
    return 0;
  }

  const [yearRaw, monthRaw, dayRaw] = dayKey.split("-");
  const year = Number.parseInt(yearRaw ?? "", 10);
  const month = Number.parseInt(monthRaw ?? "", 10);
  const day = Number.parseInt(dayRaw ?? "", 10);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return 0;
  }

  const localMidnightAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let adjusted = localMidnightAsUtc;

  for (let index = 0; index < 3; index += 1) {
    const offsetMs = getTimeZoneOffsetMs(adjusted, timezone);
    const next = localMidnightAsUtc - offsetMs;
    if (next === adjusted) {
      break;
    }
    adjusted = next;
  }

  return adjusted;
}

export function shiftDayKey(dayKey: string, offsetDays: number): string {
  const ms = dayKeyToMs(dayKey);
  if (!Number.isFinite(ms) || ms <= 0) {
    return dayKey;
  }

  const date = new Date(ms);
  date.setUTCDate(date.getUTCDate() + offsetDays);

  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getRangeStartMs(
  range: StatsRange,
  nowMs: number,
  earliestUsageDayKey: string | null,
  timezone: string
): number {
  const todayKey = toDayKey(nowMs, timezone);

  if (range === "7d") {
    return dayKeyToStartMs(shiftDayKey(todayKey, -6), timezone);
  }

  if (range === "30d") {
    return dayKeyToStartMs(shiftDayKey(todayKey, -29), timezone);
  }

  return dayKeyToStartMs(earliestUsageDayKey ?? todayKey, timezone);
}

export function computeRangeDayCount(range: StatsRange, todayDayKey: string, rangeStartDayKey: string): number {
  if (range === "7d") {
    return 7;
  }

  if (range === "30d") {
    return 30;
  }

  const todayOrdinal = dayKeyToOrdinal(todayDayKey);
  const rangeStartOrdinal = dayKeyToOrdinal(rangeStartDayKey);
  if (todayOrdinal === null || rangeStartOrdinal === null) {
    return 1;
  }

  const count = todayOrdinal - rangeStartOrdinal + 1;
  return Math.max(1, count);
}

export function rangePeriodLabel(range: StatsRange): string {
  if (range === "7d") {
    return "Last 7 days";
  }

  if (range === "30d") {
    return "Last 30 days";
  }

  return "All time";
}

export function computeLongestStreak(activeDays: string[]): number {
  if (activeDays.length === 0) {
    return 0;
  }

  const sorted = activeDays.slice().sort((left, right) => left.localeCompare(right));
  let longest = 1;
  let current = 1;

  for (let index = 1; index < sorted.length; index += 1) {
    const prev = dayKeyToMs(sorted[index - 1]);
    const next = dayKeyToMs(sorted[index]);

    if (next - prev === DAY_MS) {
      current += 1;
      if (current > longest) {
        longest = current;
      }
      continue;
    }

    current = 1;
  }

  return longest;
}

export function buildDayRange(rangeStartDayKey: string, rangeEndDayKey: string): string[] {
  const startOrdinal = dayKeyToOrdinal(rangeStartDayKey);
  const endOrdinal = dayKeyToOrdinal(rangeEndDayKey);

  if (startOrdinal === null || endOrdinal === null || endOrdinal < startOrdinal) {
    return [];
  }

  const days: string[] = [];
  for (let ordinal = startOrdinal; ordinal <= endOrdinal; ordinal += 1) {
    days.push(ordinalToDayKey(ordinal));
  }

  return days;
}

export function formatDayLabel(dayKey: string): string {
  const ms = dayKeyToMs(dayKey);
  if (!Number.isFinite(ms) || ms <= 0) {
    return dayKey;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(ms));
}

export function formatUptime(uptimeMs: number): string {
  const days = Math.floor(uptimeMs / DAY_MS);
  const hours = Math.floor((uptimeMs % DAY_MS) / (60 * 60 * 1000));
  const minutes = Math.floor((uptimeMs % (60 * 60 * 1000)) / (60 * 1000));

  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0 || days > 0) {
    parts.push(`${hours}h`);
  }
  parts.push(`${minutes}m`);

  return parts.join(" ");
}

function getDayKeyFormatter(timezone: string): Intl.DateTimeFormat {
  const existing = dayKeyFormatters.get(timezone);
  if (existing) {
    return existing;
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  dayKeyFormatters.set(timezone, formatter);
  return formatter;
}

function getTimeZoneOffsetMs(timestampMs: number, timezone: string): number {
  const formatter = getDateTimePartFormatter(timezone);
  const parts = formatter.formatToParts(new Date(timestampMs));

  const year = Number.parseInt(parts.find((part) => part.type === "year")?.value ?? "", 10);
  const month = Number.parseInt(parts.find((part) => part.type === "month")?.value ?? "", 10);
  const day = Number.parseInt(parts.find((part) => part.type === "day")?.value ?? "", 10);
  const hour = Number.parseInt(parts.find((part) => part.type === "hour")?.value ?? "", 10);
  const minute = Number.parseInt(parts.find((part) => part.type === "minute")?.value ?? "", 10);
  const second = Number.parseInt(parts.find((part) => part.type === "second")?.value ?? "", 10);

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return 0;
  }

  const utcEquivalent = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const roundedTimestampMs = Math.floor(timestampMs / 1000) * 1000;
  return utcEquivalent - roundedTimestampMs;
}

function getDateTimePartFormatter(timezone: string): Intl.DateTimeFormat {
  const existing = dateTimePartFormatters.get(timezone);
  if (existing) {
    return existing;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  dateTimePartFormatters.set(timezone, formatter);
  return formatter;
}

function dayKeyToOrdinal(dayKey: string): number | null {
  const dayMs = dayKeyToMs(dayKey);
  if (!Number.isFinite(dayMs) || dayMs <= 0) {
    return null;
  }

  return Math.floor(dayMs / DAY_MS);
}

function ordinalToDayKey(ordinal: number): string {
  if (!Number.isFinite(ordinal)) {
    return "1970-01-01";
  }

  const date = new Date(ordinal * DAY_MS);
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayKeyToMs(dayKey: string): number {
  const [yearRaw, monthRaw, dayRaw] = dayKey.split("-");
  const year = Number.parseInt(yearRaw ?? "", 10);
  const month = Number.parseInt(monthRaw ?? "", 10);
  const day = Number.parseInt(dayRaw ?? "", 10);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return 0;
  }

  return Date.UTC(year, month - 1, day);
}
