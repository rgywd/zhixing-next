export type TodayLoadState = "idle" | "loading" | "ready" | "denied" | "blocked" | "error";
export type TodayPlace = {
  label: string; latitude: number; longitude: number; accuracy: number | null;
  timestamp: number; mocked: boolean; networkAvailable: boolean | null;
};
export type TodayWeather = {
  temperature: number; apparentTemperature: number | null; code: number;
  condition: string; icon: "sunny-outline" | "moon-outline" | "partly-sunny-outline" | "cloudy-outline" | "rainy-outline" | "snow-outline" | "thunderstorm-outline";
  isDay: boolean; observedAt: number; fetchedAt: number;
};
export type TodayCalendarEvent = {
  id: string; title: string; startDate: string; endDate: string; allDay: boolean; location: string;
};
export type TodayDeviceSnapshot = {
  now: number; place: TodayPlace | null; weather: TodayWeather | null; events: TodayCalendarEvent[];
  locationEnabled: boolean; calendarEnabled: boolean; preferencesReady: boolean;
  locationState: TodayLoadState; calendarState: TodayLoadState; weatherState: TodayLoadState;
  locationError: string; calendarError: string; weatherError: string; preferenceError: string;
};
export type TodayHomeModule = {
  value: string; badge: string; tone: "gold" | "green" | "red" | "neutral";
  detail: string; footerLabel: string; footerValue: string; progress: number | null;
};
export type TodayHomeView = {
  dateLabel: string; clockLabel: string; locationLabel: string; weatherLabel: string;
  weatherIcon: TodayWeather["icon"]; contextBusy: boolean; contextHint: string;
  statusLabel: string; statusTone: "green" | "gold" | "neutral";
  briefing: string;
  calendar: { month: string; day: string; title: string; description: string; badge: string; hasEvent: boolean };
  finance: TodayHomeModule; health: TodayHomeModule;
};
