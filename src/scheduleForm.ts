import type { PlanDraft, Schedule } from "./api";

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function localDateTime(date: Date): string {
  return `${localDateKey(date)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function dateOffset(days: number, now = new Date()): string {
  return localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
}

export function scheduleDateLabel(date: string, now = new Date()): string {
  if (date === dateOffset(0, now)) return "今天";
  if (date === dateOffset(1, now)) return "明天";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${Number(match[1]) === now.getFullYear() ? "" : `${match[1]}年`}${Number(match[2])}月${Number(match[3])}日` : "选择日期";
}

export function scheduleMonthDays(year: number, month: number): (string | null)[] {
  const first = new Date(year, month, 1);
  const count = new Date(year, month + 1, 0).getDate();
  const result: (string | null)[] = Array(first.getDay()).fill(null);
  for (let day = 1; day <= count; day += 1) result.push(localDateKey(new Date(year, month, day)));
  while (result.length % 7) result.push(null);
  return result;
}

export type ScheduleRepeat = "once" | "daily" | "weekly" | "custom";
export function scheduleRepeat(interval: string): ScheduleRepeat {
  if (!interval.trim()) return "once";
  if (Number(interval) === 1440) return "daily";
  if (Number(interval) === 10080) return "weekly";
  return "custom";
}

export function scheduleIntervalLabel(seconds: number | null): string {
  if (seconds === null) return "仅一次";
  if (seconds === 86400) return "每天 · 每 24 小时";
  if (seconds === 604800) return "每周 · 每 7 天";
  return `每 ${seconds / 60} 分钟`;
}

export function scheduleTriggered(schedule: Schedule): boolean {
  return !schedule.enabled && schedule.interval_seconds === null && !!schedule.last_run_id;
}

export function scheduleDestination(draft: PlanDraft, currentId: string | null): string | null {
  return draft.pending?.conversation_id ?? draft.conversation_id ?? currentId;
}
