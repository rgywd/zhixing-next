import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { openTodayCalendarEvent, readTodayCalendar, TodayContextError, todayCalendarPermission, type TodayPermission } from "./todayCalendar";
import { enableTodayNetworkLocation, readTodayPlace, todayLocationPermission } from "./todayLocation";
import { fetchTodayWeather } from "./todayWeather";
import type { TodayCalendarEvent, TodayDeviceSnapshot, TodayPlace, TodayWeather } from "./todayTypes";

export const TODAY_PREFERENCES_KEY = "zhixing.today-device.v1";
export const TODAY_WEATHER_INTERVAL = 15 * 60 * 1000;
export const TODAY_CALENDAR_INTERVAL = 60 * 1000;
type Preferences = { locationEnabled: boolean; calendarEnabled: boolean };
type Domain = "location" | "calendar";
type Dependencies = {
  getPreferences: () => Promise<string | null>; setPreferences: (value: string) => Promise<void>;
  locationPermission: (request?: boolean) => Promise<TodayPermission>;
  calendarPermission: (request?: boolean) => Promise<TodayPermission>;
  readPlace: (signal: AbortSignal) => Promise<TodayPlace>;
  readCalendar: (now: number, signal: AbortSignal) => Promise<TodayCalendarEvent[]>;
  weather: (place: TodayPlace, signal: AbortSignal) => Promise<TodayWeather>;
  networkLocation: () => Promise<void>; openEvent: (event: TodayCalendarEvent) => Promise<void>; now: () => number;
};
export function parseTodayPreferences(value: string | null): Preferences {
  if (value === null) return { locationEnabled: false, calendarEnabled: false };
  const saved: unknown = JSON.parse(value);
  if (!saved || typeof saved !== "object" || typeof (saved as Preferences).locationEnabled !== "boolean" ||
      typeof (saved as Preferences).calendarEnabled !== "boolean") throw new Error("首页开关读取失败。");
  return { locationEnabled: (saved as Preferences).locationEnabled, calendarEnabled: (saved as Preferences).calendarEnabled };
}
function initial(now: number): TodayDeviceSnapshot {
  return { now, place: null, weather: null, events: [], locationEnabled: false, calendarEnabled: false,
    preferencesReady: false, locationState: "idle", calendarState: "idle", weatherState: "idle",
    locationError: "", calendarError: "", weatherError: "", preferenceError: "" };
}
const day = (now: number) => { const value = new Date(now); return `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`; };

/** One Home instance owns all work; injected native boundaries make cancellation observable in tests. */
export class TodayDeviceController {
  snapshot: TodayDeviceSnapshot;
  private listeners = new Set<(snapshot: TodayDeviceSnapshot) => void>();
  private visible = false;
  private foreground = true;
  private alive = true;
  private readVersion = 0;
  private writeVersion = 0;
  private writes = Promise.resolve();
  private locationRequest: AbortController | null = null;
  private calendarRequest: AbortController | null = null;
  private lastLocation = -Infinity;
  private lastCalendar = -Infinity;
  private enabling = { location: false, calendar: false };
  constructor(private readonly deps: Dependencies) { this.snapshot = initial(deps.now()); }
  subscribe(listener: (snapshot: TodayDeviceSnapshot) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private patch(change: Partial<TodayDeviceSnapshot>) {
    if (!this.alive) return;
    this.snapshot = { ...this.snapshot, ...change }; this.listeners.forEach((listener) => listener(this.snapshot));
  }
  private get active() { return this.alive && this.visible && this.foreground && this.snapshot.preferencesReady; }
  private enabled(domain: Domain) { return domain === "location" ? this.snapshot.locationEnabled : this.snapshot.calendarEnabled; }
  async initialize() {
    this.alive = true;
    const version = ++this.readVersion;
    try {
      const saved = parseTodayPreferences(await this.deps.getPreferences());
      if (!this.alive || version !== this.readVersion) return;
      this.patch({ ...saved, preferencesReady: true, preferenceError: "" });
      void this.refreshLocation(); void this.refreshCalendar();
    } catch { if (this.alive && version === this.readVersion) this.patch({ preferencesReady: false, preferenceError: "首页开关暂时无法读取，请重试。" }); }
  }
  private persist() {
    const value = JSON.stringify({ locationEnabled: this.snapshot.locationEnabled, calendarEnabled: this.snapshot.calendarEnabled });
    const version = ++this.writeVersion;
    const task = this.writes.catch(() => undefined).then(() => this.deps.setPreferences(value));
    this.writes = task;
    return task.then(() => { if (version === this.writeVersion) this.patch({ preferenceError: "" }); }, () => {
      if (version === this.writeVersion) this.patch({ preferenceError: "首页开关尚未保存，请重试。" });
    });
  }
  retryPreferences = () => { if (this.snapshot.preferencesReady) void this.persist(); else void this.initialize(); };
  setVisibility(visible: boolean) { this.visible = visible; this.activityChanged(); }
  setForeground(foreground: boolean) { this.foreground = foreground; this.activityChanged(); }
  private activityChanged() {
    if (!this.active) { this.cancelLocation(); this.cancelCalendar(); return; }
    this.tick();
  }
  tick = () => {
    if (!this.active) return;
    const now = this.deps.now();
    const midnight = day(now) !== day(this.snapshot.now);
    this.patch({ now, ...(midnight ? { events: [] } : {}) });
    if (midnight) this.lastCalendar = -Infinity;
    void this.refreshLocation(); void this.refreshCalendar();
  };
  cancelLocation = () => {
    this.locationRequest?.abort(); this.locationRequest = null;
    if (this.snapshot.locationState === "loading" || this.snapshot.weatherState === "loading") this.patch({
      locationState: this.snapshot.place ? "ready" : "idle", weatherState: this.snapshot.weather ? "ready" : "idle" });
  };
  private cancelCalendar() {
    this.calendarRequest?.abort(); this.calendarRequest = null;
    if (this.snapshot.calendarState === "loading") this.patch({ calendarState: "idle" });
  }
  private permissionDenied(domain: Domain, permission: TodayPermission) {
    const name = domain === "location" ? "定位" : "日历";
    const state = permission.canAskAgain ? "denied" : "blocked";
    const message = permission.canAskAgain ? `未允许${name}，需要时可点击启用。` : `${name}权限已关闭，请在系统设置中允许。`;
    if (domain === "location") this.patch({ place: null, weather: null, locationState: state, weatherState: "idle", locationError: message, weatherError: "" });
    else this.patch({ events: [], calendarState: state, calendarError: message });
  }
  private async enable(domain: Domain) {
    if (!this.active || this.enabling[domain]) return;
    this.enabling[domain] = true;
    this.patch(domain === "location" ? { locationEnabled: true } : { calendarEnabled: true });
    await this.persist();
    try {
      if (!this.active || !this.enabled(domain)) return;
      // This is the only path that may open an OS permission prompt.
      const permission = await (domain === "location" ? this.deps.locationPermission(true) : this.deps.calendarPermission(true));
      if (!this.active || !this.enabled(domain)) return;
      if (!permission.granted) { this.permissionDenied(domain, permission); return; }
      if (domain === "location") await this.refreshLocation(true);
      else await this.refreshCalendar(true);
    } catch (error) { if (this.alive && this.enabled(domain) && this.active) this.failed(domain, error); }
    finally { this.enabling[domain] = false; }
  }
  enableLocation = () => this.enable("location");
  enableCalendar = () => this.enable("calendar");
  disableLocation = () => {
    this.cancelLocation(); this.lastLocation = -Infinity;
    this.patch({ locationEnabled: false, place: null, weather: null, locationState: "idle", weatherState: "idle", locationError: "", weatherError: "" });
    if (this.snapshot.preferencesReady) void this.persist();
  };
  disableCalendar = () => {
    this.cancelCalendar(); this.lastCalendar = -Infinity;
    this.patch({ calendarEnabled: false, events: [], calendarState: "idle", calendarError: "" });
    if (this.snapshot.preferencesReady) void this.persist();
  };
  private failed(domain: Domain, error: unknown) {
    const message = error instanceof TodayContextError ? error.message : domain === "location" ? "定位暂不可用，请检查权限和定位服务后重试。" : "日历暂不可用，请检查权限和日历应用后重试。";
    const state = error instanceof TodayContextError ? error.state : "error";
    // Native failures can be permission revocation races; remove previous data.
    if (domain === "location") this.patch({ place: null, weather: null, locationState: state, locationError: message, weatherState: "idle", weatherError: "" });
    else this.patch({ events: [], calendarState: state, calendarError: message });
  }
  refreshLocation = async (force = false) => {
    if (!this.active || !this.snapshot.locationEnabled || this.locationRequest) return;
    const controller = new AbortController(); this.locationRequest = controller;
    const valid = () => this.active && this.snapshot.locationEnabled && !controller.signal.aborted && this.locationRequest === controller;
    try {
      const permission = await this.deps.locationPermission(false);
      if (!valid()) return;
      if (!permission.granted) { this.permissionDenied("location", permission); return; }
      if (!force && this.deps.now() - this.lastLocation < TODAY_WEATHER_INTERVAL) return;
      this.patch({ locationState: "loading", locationError: "", weatherState: "loading", weatherError: "" });
      const place = await this.deps.readPlace(controller.signal);
      if (!valid()) return;
      this.patch({ place, weather: null, locationState: "ready" });
      try {
        const weather = await this.deps.weather(place, controller.signal);
        if (!valid()) return;
        this.lastLocation = this.deps.now();
        this.patch({ weather, weatherState: "ready", weatherError: "" });
      } catch (error) {
        if (valid()) this.patch({ weather: null, weatherState: "error", weatherError: error instanceof Error && /^天气/.test(error.message) ? error.message : "天气暂不可用，请检查网络后刷新。" });
        // Avoid retrying a failed network request on every minute tick.
        if (valid()) this.lastLocation = this.deps.now();
      }
    } catch (error) { if (valid()) this.failed("location", error); }
    finally { if (this.locationRequest === controller) this.locationRequest = null; }
  };
  refreshCalendar = async (force = false) => {
    if (!this.active || !this.snapshot.calendarEnabled || this.calendarRequest) return;
    const controller = new AbortController(); this.calendarRequest = controller;
    const valid = () => this.active && this.snapshot.calendarEnabled && !controller.signal.aborted && this.calendarRequest === controller;
    try {
      const permission = await this.deps.calendarPermission(false);
      if (!valid()) return;
      if (!permission.granted) { this.permissionDenied("calendar", permission); return; }
      if (!force && this.deps.now() - this.lastCalendar < TODAY_CALENDAR_INTERVAL) return;
      this.patch({ calendarState: "loading", calendarError: "" });
      const now = this.deps.now();
      const events = await this.deps.readCalendar(now, controller.signal);
      if (!valid()) return;
      // A query crossing midnight must not briefly expose yesterday's list.
      if (day(now) !== day(this.deps.now())) { this.lastCalendar = -Infinity; this.patch({ events: [], calendarState: "idle" }); return; }
      this.lastCalendar = this.deps.now();
      this.patch({ events, calendarState: "ready", calendarError: "" });
    } catch (error) { if (valid()) this.failed("calendar", error); }
    finally { if (this.calendarRequest === controller) this.calendarRequest = null; }
  };
  enableNetworkLocation = async () => {
    if (!this.active || !this.snapshot.locationEnabled) return;
    try { await this.deps.networkLocation(); if (this.active && this.snapshot.locationEnabled) await this.refreshLocation(true); }
    catch { if (this.active && this.snapshot.locationEnabled) this.patch({ locationError: "未启用系统网络辅助定位，仍可尝试 GPS 定位。" }); }
  };
  openEvent = async (event: TodayCalendarEvent) => {
    if (!this.active || !this.snapshot.calendarEnabled || !this.snapshot.events.some((item) => item.id === event.id && item.startDate === event.startDate)) return;
    const permission = await this.deps.calendarPermission(false);
    if (!this.active || !this.snapshot.calendarEnabled) return;
    if (!permission.granted) { this.permissionDenied("calendar", permission); return; }
    try { await this.deps.openEvent(event); }
    catch (error) { if (this.active) this.patch({ calendarError: error instanceof TodayContextError ? error.message : "无法打开系统日历，请稍后重试。" }); }
  };
  dispose() { this.cancelLocation(); this.cancelCalendar(); this.alive = false; this.readVersion++; }
}

const nativeDependencies: Dependencies = {
  getPreferences: () => AsyncStorage.getItem(TODAY_PREFERENCES_KEY), setPreferences: (value) => AsyncStorage.setItem(TODAY_PREFERENCES_KEY, value),
  locationPermission: todayLocationPermission, calendarPermission: todayCalendarPermission,
  readPlace: readTodayPlace, readCalendar: readTodayCalendar, weather: fetchTodayWeather,
  networkLocation: enableTodayNetworkLocation, openEvent: openTodayCalendarEvent, now: Date.now,
};

export function useTodayDeviceContext(active: boolean) {
  const [controller] = useState(() => new TodayDeviceController(nativeDependencies));
  const [snapshot, setSnapshot] = useState(controller.snapshot);
  useEffect(() => {
    const unsubscribe = controller.subscribe(setSnapshot);
    controller.setForeground(AppState.currentState === "active");
    const subscription = AppState.addEventListener("change", (state) => controller.setForeground(state === "active"));
    void controller.initialize();
    let timer: ReturnType<typeof setTimeout>;
    const nextMinute = () => { timer = setTimeout(() => { controller.tick(); nextMinute(); }, 60000 - Date.now() % 60000 + 1); };
    nextMinute();
    return () => { unsubscribe(); subscription.remove(); clearTimeout(timer); controller.dispose(); };
  }, [controller]);
  useEffect(() => { controller.setVisibility(active); return () => controller.setVisibility(false); }, [active, controller]);
  return { snapshot, enableLocation: controller.enableLocation, refreshLocation: () => controller.refreshLocation(true),
    disableLocation: controller.disableLocation, enableCalendar: controller.enableCalendar, refreshCalendar: () => controller.refreshCalendar(true),
    disableCalendar: controller.disableCalendar, openEvent: controller.openEvent, retryPreferences: controller.retryPreferences,
    cancelLocation: controller.cancelLocation, enableNetworkLocation: controller.enableNetworkLocation };
}
