import type { TodayPlace, TodayWeather } from "./todayTypes";

export const TODAY_WEATHER_CREDIT = "天气数据：Open-Meteo";
export const TODAY_WEATHER_URL = "https://open-meteo.com/";

export function weatherDescription(code: number, isDay: boolean): Pick<TodayWeather, "condition" | "icon"> {
  if (code === 0) return { condition: "晴", icon: isDay ? "sunny-outline" : "moon-outline" };
  if (code === 1 || code === 2) return { condition: "多云", icon: "partly-sunny-outline" };
  if (code === 3) return { condition: "阴", icon: "cloudy-outline" };
  if (code === 45 || code === 48) return { condition: "雾", icon: "cloudy-outline" };
  if ([51, 53, 55, 56, 57].includes(code)) return { condition: "毛毛雨", icon: "rainy-outline" };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { condition: "有雨", icon: "rainy-outline" };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { condition: "有雪", icon: "snow-outline" };
  if ([95, 96, 99].includes(code)) return { condition: "雷雨", icon: "thunderstorm-outline" };
  return { condition: "天气暂无描述", icon: "cloudy-outline" };
}

/** Weather grids do not need a precise phone fix. Never include connection tokens. */
export function todayWeatherRequest(place: Pick<TodayPlace, "latitude" | "longitude">) {
  if (!Number.isFinite(place.latitude) || Math.abs(place.latitude) > 90 || !Number.isFinite(place.longitude) || Math.abs(place.longitude) > 180) {
    throw new Error("当前位置无效，请重新定位。");
  }
  const latitude = place.latitude.toFixed(2), longitude = place.longitude.toFixed(2);
  return `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,weather_code,is_day&timezone=auto&timeformat=unixtime&forecast_days=1`;
}

export function parseTodayWeather(payload: unknown, now = Date.now()): TodayWeather {
  const current = (payload as { current?: Record<string, unknown> } | null)?.current;
  const temperature = current?.temperature_2m, code = current?.weather_code, time = current?.time, isDay = current?.is_day;
  if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < -100 || temperature > 70 ||
      typeof code !== "number" || !Number.isInteger(code) || code < 0 || code > 99 ||
      typeof time !== "number" || !Number.isFinite(time) || time * 1000 < now - 2 * 60 * 60 * 1000 || time * 1000 > now + 10 * 60 * 1000 ||
      (isDay !== 0 && isDay !== 1)) throw new Error("天气数据暂不可用，请稍后刷新。");
  const apparent = current?.apparent_temperature;
  return { temperature, apparentTemperature: typeof apparent === "number" && Number.isFinite(apparent) ? apparent : null,
    code, isDay: isDay === 1, observedAt: time * 1000, fetchedAt: now, ...weatherDescription(code, isDay === 1) };
}

export async function fetchTodayWeather(place: TodayPlace, signal: AbortSignal): Promise<TodayWeather> {
  if (signal.aborted) throw new Error("天气更新已取消。");
  const url = todayWeatherRequest(place);
  const controller = new AbortController();
  let timedOut = false;
  let interrupt: (reason: Error) => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject; });
  const abort = () => { controller.abort(); interrupt(new Error("天气更新已取消。")); };
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); interrupt(new Error("天气更新超时，请稍后刷新。")); }, 10000);
  try {
    const response = await Promise.race([fetch(url, { signal: controller.signal }), interrupted]);
    if (!response.ok) throw new Error("天气服务暂不可用，请稍后刷新。");
    const payload: unknown = await Promise.race([response.json(), interrupted]);
    if (controller.signal.aborted) throw new Error("天气更新已取消。");
    return parseTodayWeather(payload);
  } catch (error) {
    if (signal.aborted) throw new Error("天气更新已取消。");
    if (timedOut) throw new Error("天气更新超时，请稍后刷新。");
    if (error instanceof Error && /^天气/.test(error.message)) throw error;
    throw new Error("天气更新失败，请检查网络后重试。");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
