import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { request, type Connection } from "./api";
import type { FinanceDashboardSummary, HealthSummary } from "./serviceApi";
import type { TodayServices } from "./todayHomeLogic";

const empty = (loading: boolean): TodayServices => ({ finance: { data: null, loading, error: "" }, health: { data: null, loading, error: "" } });

/** The phone's local date owns Home's 'today'; never reuse another day's health totals. */
export function useTodayServices(connection: Connection | undefined, date: string, refreshKey = 0): TodayServices {
  const scope = connection ? `${connection.url}\n${connection.token}\n${date}` : "disconnected";
  const [state, setState] = useState<{ scope: string; value: TodayServices }>(() => ({ scope, value: empty(!!connection) }));
  useEffect(() => {
    if (!connection) return;
    let active = true, inFlight = false, lastStarted = -Infinity;
    const controller = new AbortController();
    async function load() {
      if (!active || inFlight || AppState.currentState !== "active" || Date.now() - lastStarted < 60000) return;
      inFlight = true;
      lastStarted = Date.now();
      try {
        const results = await Promise.allSettled([
          request<FinanceDashboardSummary>(connection!, `/finance/summary?month=${date.slice(0, 7)}`, { signal: controller.signal }),
          request<HealthSummary>(connection!, `/health/summary?date=${date}`, { signal: controller.signal }),
        ]);
        if (!active) return;
        setState((old) => {
          const previous = old.scope === scope ? old.value : empty(true);
          return { scope, value: {
            finance: results[0].status === "fulfilled" ? { data: results[0].value, loading: false, error: "" } : { ...previous.finance, loading: false, error: "本月财务暂未更新" },
            health: results[1].status === "fulfilled" ? { data: results[1].value, loading: false, error: "" } : { ...previous.health, loading: false, error: "今日健康暂未更新" },
          } };
        });
      } finally { inFlight = false; }
    }
    void load();
    const timer = setInterval(() => { void load(); }, 60000);
    const listener = AppState.addEventListener("change", (next) => { if (next === "active") void load(); });
    return () => { active = false; controller.abort(); clearInterval(timer); listener.remove(); };
  }, [connection, scope, date, refreshKey]);
  return state.scope === scope ? state.value : empty(!!connection);
}
