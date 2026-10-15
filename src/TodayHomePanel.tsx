import { useState } from "react";
import { Linking, ScrollView, Text, View } from "react-native";
import type { Connection, ServiceStatus } from "./api";
import { BottomSheet } from "./BottomSheet";
import { HomePanel } from "./OverviewPanels";
import type { useTodayDeviceContext } from "./useTodayDeviceContext";
import { useTodayServices } from "./useTodayServices";
import { buildTodayHome, localToday, nextTodayEvent, todayChatPrompt, todayStatus } from "./todayHomeLogic";
import { TODAY_WEATHER_CREDIT, TODAY_WEATHER_URL } from "./todayWeather";
import { openDeviceSettings } from "./deviceCapabilities";
import { ActionLink, Button, CardHeader, humanError, useUi } from "./ui";
import { useNotice } from "./Notice";

type Props = Parameters<typeof HomePanel>[0] & {
  device: ReturnType<typeof useTodayDeviceContext>;
  connection?: Connection; refreshKey?: number; status?: ServiceStatus | null;
  loading?: boolean; syncFailed?: boolean; onPrompt?: (text: string) => void;
};

export function TodayHomePanel({ device, connection, refreshKey = 0, status, loading = false, syncFailed = false, onPrompt, ...homeProps }: Props) {
  const { s } = useUi();
  const { show } = useNotice();
  const snapshot = device.snapshot;
  const services = useTodayServices(connection, localToday(snapshot.now), refreshKey);
  const view = buildTodayHome(snapshot, services, todayStatus(status, !!connection, loading, syncFailed), !!connection);
  const [contextOpen, setContextOpen] = useState(false);
  const busy = snapshot.locationState === "loading" || snapshot.weatherState === "loading";
  const locationNeedsPermission = snapshot.locationState === "denied" || snapshot.locationState === "blocked";
  const calendarNeedsPermission = snapshot.calendarState === "denied" || snapshot.calendarState === "blocked";
  const run = (action: () => Promise<unknown> | void) => { void Promise.resolve().then(action).catch((error) => show({ message: humanError(error), tone: "warning" })); };
  function openCalendar() {
    const next = snapshot.calendarState === "ready" ? nextTodayEvent(snapshot.events, snapshot.now) : null;
    if (next) run(() => device.openEvent(next));
    else setContextOpen(true);
  }
  function begin(text: string) {
    if (homeProps.promptReady === false) return;
    if (onPrompt) onPrompt(todayChatPrompt(text, snapshot));
    else homeProps.onChat();
  }
  return <>
    <HomePanel {...homeProps} today={view} onTodaySettings={() => setContextOpen(true)} onTodayCalendar={openCalendar} onTodayPrompt={begin} />
    <BottomSheet visible={contextOpen} title="今日信息" subtitle="按需启用，帮助安排今天。" onClose={() => setContextOpen(false)}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24, gap: 16 }}>
        {snapshot.preferenceError ? <View style={s.stack}><Text accessibilityRole="alert" style={s.error}>{snapshot.preferenceError}</Text><ActionLink icon="refresh-outline" onPress={device.retryPreferences}>重新读取开关</ActionLink></View> : null}
        <View style={s.card}>
          <CardHeader icon="location-outline" title="位置与天气" tone="gold" description={snapshot.locationEnabled ? "仅在首页前台按需更新" : "启用后查看当地天气"} />
          <Text style={s.description}>由系统融合 GPS、Wi-Fi 和基站辅助定位，允许只提供大概位置。天气查询会向 Open-Meteo 发送约 1 公里精度的位置。</Text>
          {snapshot.place ? <>
            <Text style={s.text}>{snapshot.place.label}{snapshot.place.mocked ? " · 模拟位置" : ""}</Text>
            <Text style={s.muted}>{snapshot.place.accuracy != null ? `定位精度约 ${Math.ceil(snapshot.place.accuracy)} 米` : "定位精度未知"}{snapshot.place.networkAvailable ? " · 系统网络辅助已开启" : ""}</Text>
          </> : null}
          {snapshot.weather ? <Text style={s.text}>{Math.round(snapshot.weather.temperature)}°C · {snapshot.weather.condition} · {new Date(snapshot.weather.observedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 更新</Text> : null}
          {snapshot.locationError || snapshot.weatherError ? <Text accessibilityRole="alert" style={s.error}>{snapshot.locationError || snapshot.weatherError}</Text> : null}
          <Button disabled={!snapshot.preferencesReady || busy} onPress={() => run(snapshot.locationEnabled && !locationNeedsPermission ? device.refreshLocation : device.enableLocation)}>{busy ? "正在更新" : locationNeedsPermission ? "重新允许位置与天气" : snapshot.locationEnabled ? "刷新位置与天气" : "启用位置与天气"}</Button>
          {busy ? <ActionLink icon="close" onPress={device.cancelLocation}>取消更新</ActionLink> : null}
          {snapshot.locationEnabled && !busy ? <View style={s.wrap}>
            <ActionLink icon="locate-outline" onPress={() => run(device.enableNetworkLocation)}>增强网络辅助定位</ActionLink>
            <ActionLink onPress={device.disableLocation}>停止位置天气</ActionLink>
          </View> : null}
          {snapshot.locationState === "blocked" || snapshot.locationState === "denied" || snapshot.locationError ? <ActionLink icon="settings-outline" onPress={() => run(() => openDeviceSettings(snapshot.locationError.includes("定位服务") ? "location" : "app"))}>打开定位设置</ActionLink> : null}
          <ActionLink onPress={() => run(() => Linking.openURL(TODAY_WEATHER_URL))}>{TODAY_WEATHER_CREDIT}</ActionLink>
        </View>
        <View style={s.card}>
          <CardHeader icon="calendar-outline" title="手机日历" tone="gold" description="只读取今天的日程，不自动新建或修改" />
          <Text style={s.description}>连接后展示下一项日程；点击日程可到系统日历查看。日程和地区信息不会自动发送到服务端，点击首页“开始”才会放入可编辑的聊天草稿，仍需自己发送。</Text>
          {snapshot.calendarError ? <Text accessibilityRole="alert" style={s.error}>{snapshot.calendarError}</Text> : null}
          <Button disabled={!snapshot.preferencesReady || snapshot.calendarState === "loading"} onPress={() => run(snapshot.calendarEnabled && !calendarNeedsPermission ? device.refreshCalendar : device.enableCalendar)}>{snapshot.calendarState === "loading" ? "正在读取" : calendarNeedsPermission ? "重新允许读取日程" : snapshot.calendarEnabled ? "刷新今日日程" : "读取今日日程"}</Button>
          {snapshot.calendarEnabled ? <ActionLink onPress={device.disableCalendar}>断开手机日历</ActionLink> : null}
          {snapshot.calendarState === "blocked" || snapshot.calendarState === "denied" ? <ActionLink icon="settings-outline" onPress={() => run(() => openDeviceSettings())}>打开日历权限设置</ActionLink> : null}
        </View>
        <Text style={s.muted}>时间跟随手机时钟与时区，无需额外授权。关闭以上开关后，不再自动获取相应信息。</Text>
      </ScrollView>
    </BottomSheet>
  </>;
}
