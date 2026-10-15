import { useEffect, useState } from "react";
import { AppState, Text, View } from "react-native";
import { request, type Connection } from "./api";
import type { FinanceDashboardSummary, HealthSummary } from "./serviceApi";
import { ActionLink, CardHeader, useUi } from "./ui";

export function LifeSummary({ connection, refreshKey, onFinance, onHealth }: {
  connection: Connection; refreshKey: number; onFinance: () => void; onHealth: () => void;
}) {
  const { s } = useUi();
  const [finance, setFinance] = useState<FinanceDashboardSummary | null>(null);
  const [health, setHealth] = useState<HealthSummary | null>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function load() {
      if (AppState.currentState !== "active") return;
      const results = await Promise.allSettled([
        request<FinanceDashboardSummary>(connection, "/finance/summary", { signal: controller.signal }),
        request<HealthSummary>(connection, "/health/summary", { signal: controller.signal }),
      ]);
      if (!active) return;
      if (results[0].status === "fulfilled") setFinance(results[0].value);
      if (results[1].status === "fulfilled") setHealth(results[1].value);
    }
    void load();
    const listener = AppState.addEventListener("change", (state) => { if (state === "active") void load(); });
    return () => { active = false; controller.abort(); listener.remove(); };
  }, [connection, refreshKey]);
  const latest = health?.review.weight_trend.latest_kg;
  return <View style={s.stack}>
    <View style={s.card}>
      <CardHeader icon="wallet-outline" title="财务 · 本月开销" tone="gold" />
      <Text style={s.text}>{finance ? `已记 ¥${finance.totals.expense}` : "从一笔消费或本月预算开始。"}</Text>
      <Text style={s.muted}>{finance?.remaining.daily_budget != null ? `剩余日常额度 ¥${finance.remaining.daily_budget}` : "预算可以随时聊着调整。"}</Text>
      {finance?.projection.savings != null ? <Text style={s.description}>预计结余 ¥{finance.projection.savings} · 按当前已知收支</Text> : null}
      <ActionLink icon="arrow-forward" onPress={onFinance}>看看预算与记录</ActionLink>
    </View>
    <View style={s.card}>
      <CardHeader icon="restaurant-outline" title="健康 · 饮食与体重" tone="blue" />
      <Text style={s.text}>{health ? `${health.rules.length} 条当前饮食约定 · 最近已记 ${health.review.recorded_meals} 餐` : "聊聊饮食习惯，让建议适合自己的生活。"}</Text>
      {latest != null ? <Text style={s.description}>最近体重 {latest} kg</Text> : null}
      <Text style={s.muted}>按当前约定推荐，记录后再一起调整。</Text>
      <ActionLink icon="arrow-forward" onPress={onHealth}>饮食建议与记录</ActionLink>
    </View>
  </View>;
}
