import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AppState, Platform, Text, View } from "react-native";
import { allowNotifications, currentLocation, locationState, notificationState, openDeviceSettings, openSystemCalendar, sendTestNotification } from "./deviceCapabilities";
import { DevicePermissionError, locationText, type LocationFix } from "./deviceCapabilityLogic";
import { ActionLink, Button, CardHeader, humanError, PageHeading, PageScrollView, useUi } from "./ui";
import { useNotice } from "./Notice";

export function DeviceCapabilitiesPanel({ onUseLocation }: { onUseLocation?: (text: string) => void }) {
  const { s } = useUi();
  const { show, dismiss } = useNotice();
  const noticeId = useId();
  const [notifications, setNotifications] = useState<Awaited<ReturnType<typeof notificationState>> | null>(null);
  const [location, setLocation] = useState<Awaited<ReturnType<typeof locationState>> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fix, setFix] = useState<LocationFix | null>(null);
  const alive = useRef(false);
  const working = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const watchingLocation = useRef(false);
  const refresh = useCallback(async () => {
    if (Platform.OS !== "android") return;
    const results = await Promise.allSettled([notificationState(), locationState()]);
    if (!alive.current) return;
    if (results[0].status === "fulfilled") setNotifications(results[0].value);
    else { setNotifications(null); show({ id: noticeId, message: humanError(results[0].reason), tone: "error", duration: 8000 }); }
    if (results[1].status === "fulfilled") setLocation(results[1].value);
    else { setLocation(null); show({ id: noticeId, message: humanError(results[1].reason), tone: "error", duration: 8000 }); }
  }, [show, noticeId]);
  useEffect(() => {
    alive.current = true;
    void Promise.resolve().then(refresh);
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
      if (state === "background") {
        if (watchingLocation.current) controller.current?.abort();
        setFix(null);
      }
    });
    return () => { alive.current = false; watchingLocation.current = false; controller.current?.abort(); listener.remove(); dismiss(noticeId); };
  }, [refresh, dismiss, noticeId]);
  async function perform(name: string, action: () => Promise<string>) {
    if (working.current) return;
    working.current = true;
    setBusy(name); dismiss(noticeId);
    try {
      const result = await action();
      if (alive.current) show({ id: noticeId, message: result, tone: "success" });
    } catch (e) {
      if (alive.current) {
        show({ id: noticeId, message: humanError(e), tone: "warning", duration: 8000,
          ...(e instanceof DevicePermissionError ? { duration: null, action: { label: "打开系统设置", icon: "settings-outline" as const,
            onPress: () => { void perform("settings", async () => { await openDeviceSettings(e.settings); return "系统设置已打开，返回后可重试刚才的操作。"; }); } } } : {}),
        });
      }
    } finally {
      working.current = false;
      controller.current = null;
      watchingLocation.current = false;
      if (alive.current) { setBusy(null); void refresh(); }
    }
  }
  return <PageScrollView>
    <PageHeading title="手机能力" description="在需要时使用通知、日历和当前位置。" />
    {Platform.OS !== "android" ? <Text style={s.muted}>这些手机能力目前先支持安卓。</Text> : <>
      <View style={s.card}>
        <CardHeader icon="notifications-outline" title="通知" tone="gold" />
        <Text style={s.description}>{notifications ? notifications.channelBlocked ? "知行通知渠道已关闭" : notifications.granted ? "系统已允许通知" : notifications.status === "undetermined" ? "尚未申请通知权限" : "系统未允许通知" : "正在读取通知状态…"}</Text>
        <Text style={s.muted}>先发送一条测试通知，确认通知栏可以收到。当前尚不支持 App 关闭后的任务结果通知。</Text>
        {!notifications?.granted ? <Button small style={{ alignSelf: "flex-start" }} disabled={!!busy} onPress={() => { void perform("notification", async () => { await allowNotifications(); return "系统已允许通知。"; }); }}>允许通知</Button> : null}
        <ActionLink icon="notifications-outline" disabled={!!busy} onPress={() => { void perform("notification", async () => { await sendTestNotification(); return "已提交测试通知，可在通知栏查看。"; }); }}>发送测试通知</ActionLink>
        <ActionLink icon="settings-outline" disabled={!!busy} tone="neutral" onPress={() => { void perform("settings", async () => { await openDeviceSettings(); return "系统设置已打开，返回后可重新检查通知状态。"; }); }}>系统通知与权限设置</ActionLink>
      </View>
      <View style={s.card}>
        <CardHeader icon="calendar-outline" title="系统日历" tone="blue" />
        <Text style={s.description}>打开手机日历，由你选择提醒并保存。</Text>
        <Text style={s.muted}>无需允许知行读取全部日程。也可以在定时计划中，把下一次执行时间带入日历。</Text>
        <ActionLink icon="add" disabled={!!busy} onPress={() => { void perform("calendar", () => openSystemCalendar()); }}>新建系统日程</ActionLink>
      </View>
      <View style={s.card}>
        <CardHeader icon="location-outline" title="当前位置" tone="blue" />
        <Text style={s.description}>{location ? !location.servicesEnabled ? "手机定位服务已关闭" : location.granted ? "已允许使用时定位" : "尚未允许使用时定位" : "正在读取定位状态…"}</Text>
        <Text style={s.muted}>点击后获取一次位置，不在后台持续定位。位置先留在本页，带入对话并发送后才会交给知行。</Text>
        {fix ? <Text selectable style={s.text}>{locationText(fix)}</Text> : null}
        <Button small icon="locate-outline" style={{ alignSelf: "flex-start" }} disabled={!!busy} onPress={() => {
          setFix(null);
          void perform("location", async () => {
            const request = new AbortController(); controller.current = request;
            watchingLocation.current = false;
            const result = await currentLocation(request.signal, () => { watchingLocation.current = true; });
            if (request.signal.aborted || AppState.currentState !== "active") throw new Error("已取消定位。");
            if (alive.current) setFix(result);
            return "已获取这一次位置。";
          });
        }}>{busy === "location" ? "正在获取位置…" : "获取当前位置"}</Button>
        {busy === "location" ? <ActionLink icon="close" onPress={() => controller.current?.abort()}>取消定位</ActionLink> : null}
        {fix && onUseLocation ? <ActionLink icon="chatbubble-outline" disabled={!!busy} onPress={() => onUseLocation(locationText(fix))}>带入对话</ActionLink> : null}
        {location && !location.servicesEnabled ? <ActionLink icon="settings-outline" disabled={!!busy} onPress={() => { void perform("settings", async () => { await openDeviceSettings("location"); return "定位设置已打开，返回后可重试。"; }); }}>打开定位服务设置</ActionLink> : null}
      </View>
    </>}
  </PageScrollView>;
}
