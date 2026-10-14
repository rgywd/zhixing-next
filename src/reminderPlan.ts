import type { HealthMeal, HealthReminders } from "./serviceApi";

function parts(value: Date, zone: string) {
  const result: Record<string, string> = {};
  for (const item of new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(value)) result[item.type] = item.value;
  return result;
}

export function dateInZone(value: Date, zone: string) {
  const p = parts(value, zone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localReminderTime(day: string, time: string, zone: string): Date | null {
  const [y, m, d] = day.split("-").map(Number), [h, min] = time.split(":").map(Number);
  const desired = Date.UTC(y, m - 1, d, h, min);
  let candidate = desired;
  for (let pass = 0; pass < 4; pass++) {
    const p = parts(new Date(candidate), zone);
    const actual = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const delta = desired - actual;
    if (!delta) return new Date(candidate);
    candidate += delta;
  }
  // A wall time inside a daylight-saving gap does not exist; never roll it over.
  return null;
}

function quiet(time: string, start: string | null, end: string | null) {
  if (!start || !end || start === end) return false;
  return start < end ? time >= start && time < end : time >= start || time < end;
}

export type PlannedHealthReminder = {
  identifier: string; date: Date; day: string; slotId: string; mealType: string;
  kind: "meal" | "review"; planKey: string;
};

export function planHealthReminders(settings: HealthReminders, meals: HealthMeal[], now: Date, scope: string, horizonDays = 14): PlannedHealthReminder[] {
  if (!settings.enabled) return [];
  const today = dateInZone(now, settings.timezone);
  const [year, month, day] = today.split("-").map(Number);
  const completed = new Set(meals.map((meal) => `${dateInZone(new Date(meal.occurred_at), settings.timezone)}:${meal.meal_type}`));
  const result: PlannedHealthReminder[] = [];
  for (let offset = 0; offset < horizonDays; offset++) {
    const calendar = new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
    if (settings.paused_dates.includes(calendar)) continue;
    let count = 0;
    for (const slot of [...settings.slots].sort((a, b) => a.time.localeCompare(b.time))) {
      if (count >= settings.max_per_day || quiet(slot.time, settings.quiet_start, settings.quiet_end)) continue;
      // Reserve this day's slots before removing elapsed/completed ones. Re-sync
      // must not replenish the daily cap and create later replacement nudges.
      count++;
      if (slot.kind === "meal" && completed.has(`${calendar}:${slot.meal_type}`)) continue;
      const date = localReminderTime(calendar, slot.time, settings.timezone);
      if (!date || date.getTime() <= now.getTime()) continue;
      result.push({ identifier: `zhixing.health.${scope}.${calendar}.${slot.id}`, date, day: calendar,
        slotId: slot.id, mealType: slot.meal_type, kind: slot.kind,
        planKey: `${settings.revision}:${settings.timezone}:${date.toISOString()}:${slot.kind}` });
    }
  }
  return result;
}
