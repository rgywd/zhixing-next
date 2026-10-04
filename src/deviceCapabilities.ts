import { AppState, Linking, Platform } from "react-native";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import { DevicePermissionError, oneLocationFix, requireDevicePermission } from "./deviceCapabilityLogic";

const NOTIFICATION_CHANNEL = "zhixing-updates";

function usableNotificationPermission(permission: Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>) {
  // Some Android SDK responses keep granted=true when notifications are disabled globally.
  return { ...permission, granted: permission.granted && permission.status === "granted",
    canAskAgain: permission.granted && permission.status !== "granted" ? false : permission.canAskAgain };
}

function requireAndroid() {
  if (Platform.OS !== "android") throw new Error("这项手机能力目前仅支持安卓。");
}

export async function notificationState() {
  requireAndroid();
  const [permission, channel] = await Promise.all([
    Notifications.getPermissionsAsync(),
    Notifications.getNotificationChannelAsync(NOTIFICATION_CHANNEL),
  ]);
  return { ...usableNotificationPermission(permission), channelBlocked: channel?.importance === Notifications.AndroidImportance.NONE };
}

export async function allowNotifications() {
  requireAndroid();
  // Android 13+ will not show its permission prompt before a channel exists.
  await Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL, {
    name: "知行通知", importance: Notifications.AndroidImportance.DEFAULT,
  });
  await requireDevicePermission("通知", async () => usableNotificationPermission(await Notifications.getPermissionsAsync()),
    async () => usableNotificationPermission(await Notifications.requestPermissionsAsync()));
  const state = await notificationState();
  if (state.channelBlocked) throw new DevicePermissionError("知行通知渠道已关闭，请在系统通知设置中打开。");
  return state;
}

export async function sendTestNotification() {
  await allowNotifications();
  Notifications.setNotificationHandler({ handleNotification: async () => ({
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false,
  }) });
  return Notifications.scheduleNotificationAsync({
    content: { title: "知行通知已就绪", body: "这是一条测试通知。你可以在系统设置中调整通知方式。" },
    trigger: { channelId: NOTIFICATION_CHANNEL },
  });
}

export async function locationState() {
  requireAndroid();
  const [permission, servicesEnabled] = await Promise.all([
    Location.getForegroundPermissionsAsync(), Location.hasServicesEnabledAsync(),
  ]);
  return { ...permission, servicesEnabled };
}

// Android's permission dialog can pause the activity. Wait for its return before
// starting the native watcher, while keeping explicit cancellation available.
function waitForLocationForeground(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("已取消定位。"));
  if (AppState.currentState === "active") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let finished = false;
    let listener: ReturnType<typeof AppState.addEventListener> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      listener?.remove();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new Error("已取消定位。"));
    signal.addEventListener("abort", abort, { once: true });
    listener = AppState.addEventListener("change", (state) => {
      if (state === "active") finish();
    });
    if (finished) { listener.remove(); return; }
    timer = setTimeout(() => finish(new Error("请返回知行后重新获取位置。")), 20000);
    if (AppState.currentState === "active") finish();
  });
}

export async function currentLocation(signal: AbortSignal, onWatchStart?: () => void) {
  requireAndroid();
  if (signal.aborted) throw new Error("已取消定位。");
  await requireDevicePermission("定位", Location.getForegroundPermissionsAsync, () => {
    if (signal.aborted) throw new Error("已取消定位。");
    return Location.requestForegroundPermissionsAsync();
  });
  if (signal.aborted) throw new Error("已取消定位。");
  const enabled = await Location.hasServicesEnabledAsync();
  if (signal.aborted) throw new Error("已取消定位。");
  if (!enabled) throw new DevicePermissionError("手机定位服务已关闭，请打开后重试。", "location");
  await waitForLocationForeground(signal);
  if (signal.aborted) throw new Error("已取消定位。");
  return oneLocationFix((onFix, onError) => {
    if (signal.aborted || AppState.currentState !== "active") throw new Error("已取消定位。");
    onWatchStart?.();
    return Location.watchPositionAsync({
      accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 0, mayShowUserSettingsDialog: false,
    }, onFix, onError);
  }, signal);
}

export async function openSystemCalendar(event: { title?: string; notes?: string; startDate?: Date; endDate?: Date } = {}) {
  requireAndroid();
  // SDK 57's default Calendar entry throws for the legacy editor API.
  // Import on demand so an unsupported development client can still open the app.
  let calendar: typeof import("expo-calendar/legacy");
  try { calendar = await import("expo-calendar/legacy"); }
  catch { throw new Error("当前安装包尚未包含日历能力，请安装新版安卓开发包。"); }
  try {
    await calendar.createEventInCalendarAsync(event, { startNewActivityTask: false });
  } catch {
    throw new Error("无法打开系统日历，请确认手机已安装支持新建日程的日历应用。");
  }
  // Android returns done/null even when the user cancels. Never claim it was saved.
  return "已返回知行；日程是否保存，请在系统日历中查看。";
}

export async function openDeviceSettings(target: "app" | "location" = "app") {
  if (target === "location" && Platform.OS === "android") await Linking.sendIntent("android.settings.LOCATION_SOURCE_SETTINGS");
  else await Linking.openSettings();
}
