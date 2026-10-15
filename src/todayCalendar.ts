import { PermissionsAndroid, Platform } from "react-native";
import type { TodayCalendarEvent, TodayLoadState } from "./todayTypes";

export type TodayPermission = { granted: boolean; canAskAgain: boolean };
export class TodayContextError extends Error {
  constructor(message: string, readonly state: TodayLoadState = "error") { super(message); }
}

async function calendarModule() {
  try { return await import("expo-calendar"); }
  catch { throw new TodayContextError("当前安装包未包含日历读取能力，请更新安装包。"); }
}

// SDK 57's Android Calendar permission helper requests READ and WRITE together.
// Home only reads; the editor in deviceCapabilities keeps its existing legacy path.
export async function todayCalendarPermission(request = false): Promise<TodayPermission> {
  if (Platform.OS === "android") {
    const permission = PermissionsAndroid.PERMISSIONS.READ_CALENDAR;
    if (await PermissionsAndroid.check(permission)) return { granted: true, canAskAgain: true };
    if (!request) return { granted: false, canAskAgain: true };
    const result = await PermissionsAndroid.request(permission);
    return { granted: result === PermissionsAndroid.RESULTS.GRANTED,
      canAskAgain: result !== PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN };
  }
  if (Platform.OS === "ios") {
    const calendar = await calendarModule();
    const permission = request ? await calendar.requestCalendarPermissions(false) : await calendar.getCalendarPermissions(false);
    return { granted: permission.granted && permission.status === "granted", canAskAgain: permission.canAskAgain };
  }
  throw new TodayContextError("日历读取需要安卓或 iOS 原生安装包。");
}

export function todayWindow(now: number) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  return { start, end };
}

type CalendarRecord = {
  id: string; title?: string | null; startDate: string | Date; endDate: string | Date;
  allDay: boolean; location?: string | null; status?: string;
};
function eventTime(value: string | Date, allDay: boolean, android: boolean) {
  const date = new Date(value);
  // Android's all-day instants encode calendar dates in UTC, independent of the
  // current zone. Convert those dates to local midnight for day membership/UI.
  if (allDay && android && Number.isFinite(date.getTime())) {
    return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()).getTime();
  }
  return date.getTime();
}

export function selectTodayEvents(records: CalendarRecord[], now: number, android = false): TodayCalendarEvent[] {
  const { start, end } = todayWindow(now);
  const seen = new Set<string>();
  return records.flatMap((record) => {
    if (["canceled", "cancelled", "declined"].includes(record.status ?? "")) return [];
    const from = eventTime(record.startDate, record.allDay, android), to = eventTime(record.endDate, record.allDay, android);
    if (!record.id || !Number.isFinite(from) || !Number.isFinite(to) || to < from ||
        from >= end.getTime() || (to === from ? from < start.getTime() : to <= start.getTime())) return [];
    const key = `${record.id}:${from}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ id: record.id, title: record.title?.trim() || "未命名日程", startDate: new Date(from).toISOString(),
      endDate: new Date(to).toISOString(), allDay: record.allDay, location: record.location?.trim() || "" }];
  }).sort((a, b) => Number(b.allDay) - Number(a.allDay) || Date.parse(a.startDate) - Date.parse(b.startDate) || a.id.localeCompare(b.id));
}

function cancelled(signal: AbortSignal) { if (signal.aborted) throw new TodayContextError("日历读取已取消。"); }

async function readTodayCalendarRecords(now: number, signal: AbortSignal): Promise<TodayCalendarEvent[]> {
  cancelled(signal);
  const calendar = await calendarModule();
  cancelled(signal);
  const calendars = await calendar.getCalendars(calendar.EntityTypes.EVENT);
  cancelled(signal);
  const visible = calendars.filter((item) => item.isVisible !== false);
  if (!visible.length) return [];
  const { start, end } = todayWindow(now);
  const records = await calendar.listEvents(visible, start, end);
  cancelled(signal);
  const owners = new Map(visible.map((item) => [item.id, item.ownerAccount?.trim().toLowerCase()]));
  const selected = selectTodayEvents(records, now, Platform.OS === "android");
  const matching = new Set(selected.map((event) => `${event.id}:${event.startDate}`));
  const declined = new Set<string>();
  for (const record of records) {
    const from = eventTime(record.startDate, record.allDay, Platform.OS === "android");
    const key = Number.isFinite(from) ? `${record.id}:${new Date(from).toISOString()}` : "";
    if (!key || !matching.has(key)) continue;
    const attendees = await record.getAttendees();
    cancelled(signal);
    const owner = owners.get(record.calendarId);
    if (attendees.some((person) => person.status === calendar.AttendeeStatus.DECLINED &&
      (person.isCurrentUser === true || (owner && person.email?.trim().toLowerCase() === owner)))) declined.add(key);
  }
  return selected.filter((event) => !declined.has(`${event.id}:${event.startDate}`));
}

// Native calendar queries cannot be cancelled, but a deadline/abort immediately
// settles Home and prevents any subsequent query or late data from being used.
export async function readTodayCalendar(now: number, signal: AbortSignal): Promise<TodayCalendarEvent[]> {
  cancelled(signal);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => { controller.abort(); reject(new TodayContextError("日历读取已取消。")); };
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new TodayContextError("今日日历读取超时，请重试。")); }, 10000);
    if (signal.aborted) abort();
  });
  try { return await Promise.race([readTodayCalendarRecords(now, controller.signal), stopped]); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}

export async function openTodayCalendarEvent(event: TodayCalendarEvent) {
  if (!event.id) throw new TodayContextError("日程标识无效，请刷新后重试。");
  try {
    const calendar = await import("expo-calendar/legacy");
    await calendar.openEventInCalendarAsync({ id: event.id, instanceStartDate: event.startDate }, { allowsEditing: false, allowsCalendarPreview: true, startNewActivityTask: false });
  } catch { throw new TodayContextError("无法打开这条日程，请确认系统日历应用可用。"); }
}
