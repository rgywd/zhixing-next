import type { Schedule } from "./api.ts";

export type DevicePermission = { granted: boolean; canAskAgain: boolean; status: string };

export class DevicePermissionError extends Error {
  readonly settings: "app" | "location";
  constructor(message: string, settings: "app" | "location" = "app") {
    super(message);
    this.settings = settings;
  }
}

// Permission checks never trigger a prompt; only the explicit action requests it.
export async function requireDevicePermission(
  name: string,
  get: () => Promise<DevicePermission>,
  request: () => Promise<DevicePermission>,
) {
  let permission = await get();
  if (!permission.granted && permission.canAskAgain) permission = await request();
  if (!permission.granted) {
    throw new DevicePermissionError(permission.canAskAgain
      ? `未允许${name}，需要时可以再试。`
      : `${name}权限已关闭，请在系统设置中允许后重试。`);
  }
  return permission;
}

export type LocationFix = {
  coords: { latitude: number; longitude: number; accuracy: number | null };
  timestamp: number;
  mocked?: boolean;
};
type LocationSubscription = { remove: () => void };
type LocationWatch = (onFix: (fix: LocationFix) => void, onError: (message: string) => void) => Promise<LocationSubscription>;

// Remove the native watcher even if its registration finishes after cancellation.
export function oneLocationFix(watch: LocationWatch, signal: AbortSignal, timeoutMs = 20000, now = Date.now): Promise<LocationFix> {
  return new Promise((resolve, reject) => {
    let subscription: LocationSubscription | undefined;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fix?: LocationFix, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      subscription?.remove();
      if (fix) resolve(fix);
      else reject(error);
    };
    const abort = () => finish(undefined, new Error("已取消定位。"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish(undefined, new Error("暂时未能获取当前位置，请到信号较好的地方重试。")), timeoutMs);
    Promise.resolve().then(() => {
      if (finished) return;
      return watch((fix) => {
        const { latitude, longitude } = fix.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return;
        if (!Number.isFinite(fix.timestamp) || Math.abs(now() - fix.timestamp) > 30000) return;
        finish(fix);
      }, () => finish(undefined, new Error("定位未完成，请检查定位服务后重试。")));
    }).then((registered) => {
      if (!registered) return;
      if (finished) registered.remove();
      else subscription = registered;
    }).catch((error: unknown) => finish(undefined, error instanceof Error ? error : new Error("定位未完成，请重试。")));
  });
}

export function locationText(fix: LocationFix) {
  const accuracy = fix.coords.accuracy;
  return `手机定位${fix.mocked ? "（模拟位置）" : ""}：纬度 ${fix.coords.latitude.toFixed(6)}，经度 ${fix.coords.longitude.toFixed(6)}。${accuracy !== null && Number.isFinite(accuracy) && accuracy >= 0 ? `估计精度约 ${Math.ceil(accuracy)} 米。` : "精度未知。"}获取时间：${new Date(fix.timestamp).toLocaleString("zh-CN")}。`;
}

export function scheduleCalendarEvent(schedule: Pick<Schedule, "prompt" | "next_run_at" | "interval_seconds">) {
  const startDate = new Date(schedule.next_run_at);
  if (!Number.isFinite(startDate.getTime())) throw new Error("计划时间无效，无法打开日历。请先检查计划。");
  const prompt = schedule.prompt.trim();
  if (!prompt) throw new Error("计划内容为空，无法打开日历。");
  return {
    title: [...prompt.split(/\r?\n/)[0]].slice(0, 60).join(""),
    notes: `${prompt}\n\n知行定时计划的本次执行时间。${schedule.interval_seconds ? "重复规则请在系统日历中设置。" : ""}修改日历不会修改知行中的执行计划。`,
    startDate,
    endDate: startDate,
  };
}
