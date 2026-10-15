import { Platform } from "react-native";
import { oneLocationFix } from "./deviceCapabilityLogic";
import { TodayContextError, type TodayPermission } from "./todayCalendar";
import type { TodayPlace } from "./todayTypes";

async function locationModule() {
  try { return await import("expo-location"); }
  catch { throw new TodayContextError("当前安装包未包含定位能力，请更新安装包。"); }
}
export async function todayLocationPermission(request = false): Promise<TodayPermission> {
  const location = await locationModule();
  const permission = request ? await location.requestForegroundPermissionsAsync() : await location.getForegroundPermissionsAsync();
  return { granted: permission.granted && permission.status === "granted", canAskAgain: permission.canAskAgain };
}
function check(signal: AbortSignal) { if (signal.aborted) throw new TodayContextError("定位已取消。"); }

// Reverse geocoding is optional and cannot cancel its native request. Bound its
// wait and discard every late result so leaving Home never updates private data.
async function placeLabel(task: Promise<Awaited<ReturnType<typeof import("expo-location").reverseGeocodeAsync>>>, signal: AbortSignal) {
  return new Promise<string>((resolve) => {
    let settled = false;
    const finish = (value: string) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(value); };
    const abort = () => finish("当前位置");
    const timer = setTimeout(abort, 3000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void task.then((rows) => {
      const row = rows[0];
      finish(row ? [...new Set([row.city || row.region, row.district || row.subregion].filter(Boolean))].join(" · ") || "当前位置" : "当前位置");
    }, abort);
  });
}
export async function readTodayPlace(signal: AbortSignal): Promise<TodayPlace> {
  const location = await locationModule(); check(signal);
  if (!await location.hasServicesEnabledAsync()) throw new TodayContextError("手机定位服务已关闭，请打开后重试。", "blocked");
  check(signal);
  const fix = await oneLocationFix((success, failure) => location.watchPositionAsync({ accuracy: location.Accuracy.High,
    timeInterval: 1000, distanceInterval: 0, mayShowUserSettingsDialog: false }, success, failure), signal).catch((error: unknown) => {
      throw new TodayContextError(error instanceof Error && /^(暂时未能获取当前位置|定位未完成|已取消定位)/.test(error.message)
        ? error.message : "定位未完成，请检查定位服务后重试。");
    });
  check(signal);
  const status = await location.getProviderStatusAsync().catch(() => null); check(signal);
  const label = await placeLabel(location.reverseGeocodeAsync(fix.coords), signal); check(signal);
  return { label, latitude: fix.coords.latitude, longitude: fix.coords.longitude,
    accuracy: fix.coords.accuracy !== null && Number.isFinite(fix.coords.accuracy) && fix.coords.accuracy >= 0 ? fix.coords.accuracy : null,
    timestamp: fix.timestamp, mocked: fix.mocked === true, networkAvailable: status?.networkAvailable ?? null };
}
export async function enableTodayNetworkLocation() {
  if (Platform.OS !== "android") throw new TodayContextError("系统网络辅助定位设置仅适用于安卓。");
  const location = await locationModule();
  try { await location.enableNetworkProviderAsync(); }
  catch { throw new TodayContextError("未启用系统网络辅助定位，仍可尝试 GPS 定位。"); }
}
