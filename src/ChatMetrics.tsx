import { useEffect, useRef, useState } from "react";
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { useThemedStyles } from "./ThemeProvider";
import { useUi } from "./ui";
import { radius, space, typography, type ThemeColors } from "./theme";
import { cacheHit, compactTokens, contextOccupancy, duration, tokenSpeed, totalTokens, type DshContext, type DshTurnMetrics } from "./dshMetrics";

type Rect = { x: number; y: number; width: number; height: number };
export type MetricPopup = { kind: "context" | "activity" | "usage"; anchor: Rect; metrics?: DshTurnMetrics };
type Open = (popup: MetricPopup) => void;

export function ContextRing({ context, compacting, onOpen }: { context?: DshContext; compacting?: boolean; onOpen: Open }) {
  const { colors } = useUi(), styles = useThemedStyles(createStyles);
  const trigger = useRef<View>(null), occupancy = contextOccupancy(context);
  const percent = occupancy?.percent ?? 0, circumference = 2 * Math.PI * 8;
  return <Pressable ref={trigger} accessibilityRole="button" accessibilityLabel={compacting ? "上下文，正在压缩" : occupancy ? `上下文已用 ${percent}%` : "上下文，暂无用量"}
    onPress={() => trigger.current?.measureInWindow((x, y, width, height) => onOpen({ kind: "context", anchor: { x, y, width, height } }))} style={styles.ringButton}>
    <Svg width={22} height={22} viewBox="0 0 22 22" accessible={false}>
      <Circle cx={11} cy={11} r={8} fill="none" stroke={colors.line} strokeWidth={2.5} />
      <Circle cx={11} cy={11} r={8} fill="none" stroke={compacting ? colors.gold : colors.muted} strokeWidth={2.5}
        strokeDasharray={[circumference * percent / 100, circumference]} rotation={-90} origin="11,11" />
    </Svg>
  </Pressable>;
}

export function TurnMetrics({ value, onOpen }: { value: DshTurnMetrics; onOpen: Open }) {
  const styles = useThemedStyles(createStyles);
  const activity = useRef<View>(null), usage = useRef<View>(null);
  return <View style={styles.pills}>
    <Pressable ref={activity} accessibilityRole="button" accessibilityLabel="查看会话统计"
      onPress={() => activity.current?.measureInWindow((x, y, width, height) => onOpen({ kind: "activity", metrics: value, anchor: { x, y, width, height } }))} style={styles.pill}>
      <Text style={styles.caption}>{value.stats ? `${value.stats.turns} 轮 ${value.stats.steps} 步 · ${tokenSpeed(value.stats)}` : "会话统计 —"}</Text>
    </Pressable>
    <Pressable ref={usage} accessibilityRole="button" accessibilityLabel="查看 Token 用量"
      onPress={() => usage.current?.measureInWindow((x, y, width, height) => onOpen({ kind: "usage", metrics: value, anchor: { x, y, width, height } }))} style={styles.pill}>
      <Text style={styles.caption}>{value.usage ? compactTokens(totalTokens(value.usage)) : "—"} tok · 缓存命中 {cacheHit(value.usage)}</Text>
    </Pressable>
  </View>;
}

/** In-page anchored box: no native Modal, dimming, or bottom drawer. */
export function ChatMetricBox({ popup, context, compacting, canCompact, compactError, onCompact, onClose }: {
  popup: MetricPopup; context?: DshContext; compacting: boolean; canCompact: boolean; compactError: string;
  onCompact: () => void; onClose: () => void;
}) {
  const styles = useThemedStyles(createStyles), { colors } = useUi();
  const overlay = useRef<View>(null);
  const [frame, setFrame] = useState<Rect | null>(null), [boxHeight, setBoxHeight] = useState(280);
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => { onClose(); return true; });
    return () => subscription.remove();
  }, [onClose]);
  const width = Math.min(320, Math.max(0, (frame?.width ?? 344) - 24));
  const anchor = { x: popup.anchor.x - (frame?.x ?? 0), y: popup.anchor.y - (frame?.y ?? 0) };
  const above = anchor.y - boxHeight - 8;
  const top = Math.max(12, Math.min(above >= 12 ? above : anchor.y + popup.anchor.height + 8, (frame?.height ?? 600) - boxHeight - 12));
  const left = Math.max(12, Math.min(anchor.x, (frame?.width ?? 344) - width - 12));
  const stats = popup.metrics?.stats ?? null, usage = popup.metrics?.usage ?? null;
  const occupancy = contextOccupancy(context), breakdown = context?.breakdown;
  const used = context?.pressure?.projectedTokens ?? context?.pressure?.pressureTokens, capacity = context?.pressure?.contextWindow;
  const categories = [
    { label: "系统提示词", count: breakdown?.systemTokens, color: colors.muted },
    { label: "工具定义", count: breakdown?.toolsTokens, color: colors.gold },
    { label: "对话消息", count: breakdown?.messageTokens, color: colors.blue },
  ];
  const composition = categories.reduce((sum, row) => sum + (row.count ?? 0), 0);
  const exact = (value?: number) => value == null ? "—" : `${value.toLocaleString("en-US")} tok`;
  const rows = popup.kind === "activity" ? [
    ["模型用时", duration(stats?.llmMs ?? null)], ["工具调用用时", duration(stats?.toolMs ?? null)],
    ["TTFT", duration(stats && stats.ttftSteps > 0 ? stats.ttftMs / stats.ttftSteps : null)], ["TPS", tokenSpeed(stats)],
  ] : [["缓存命中率", cacheHit(usage)], ["未缓存输入", exact(usage?.uncachedInputTokens)], ["缓存读取", exact(usage?.cacheReadTokens)], ["输出", exact(usage?.outputTokens)]];
  return <View ref={overlay} style={StyleSheet.absoluteFill} pointerEvents="box-none"
    onLayout={() => overlay.current?.measureInWindow((x, y, width, height) => setFrame({ x, y, width, height }))}>
    <Pressable accessibilityRole="button" accessibilityLabel="关闭统计小窗" onPress={onClose} style={StyleSheet.absoluteFill} />
    <View accessibilityViewIsModal style={[styles.box, { left, top, width, maxHeight: Math.max(120, (frame?.height ?? 600) - 24), opacity: frame ? 1 : 0 }]}
      onLayout={event => setBoxHeight(event.nativeEvent.layout.height)}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.boxContent}>
        {popup.kind === "context" ? <>
          <View style={styles.heading}>
            <Text style={styles.caption}>上下文已用 <Text style={styles.value}>{occupancy ? `${occupancy.percent}%` : "—"}</Text></Text>
            <Text style={styles.value}>{`${used == null ? "—" : `~${compactTokens(used)}`} / ${capacity == null ? "—" : compactTokens(capacity)}`}</Text>
          </View>
          <View style={styles.bar} accessible={false}>
            {composition > 0 ? categories.map(row => <View key={row.label} style={{ width: `${(occupancy?.percent ?? 0) * (row.count ?? 0) / composition}%`, backgroundColor: row.color }} />)
              : <View style={{ width: `${occupancy?.percent ?? 0}%`, backgroundColor: colors.muted }} />}
          </View>
          {categories.map(row => <View key={row.label} style={styles.detail}>
            <View style={styles.legend}><View style={[styles.swatch, { backgroundColor: row.color }]} /><Text style={styles.label}>{row.label}</Text></View>
            <Text style={styles.value}>{row.count == null ? "—" : `~${compactTokens(row.count)}`}</Text>
          </View>)}
          {compactError ? <Text accessibilityRole="alert" style={styles.error}>{compactError}</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel={compacting ? "正在压缩上下文" : "压缩上下文"}
            disabled={!canCompact || compacting} accessibilityState={{ disabled: !canCompact || compacting }} onPress={onCompact}
            style={[styles.compress, (!canCompact || compacting) && styles.disabled]}>
            <Ionicons name="contract-outline" size={16} color={colors.ink} /><Text style={styles.value}>{compacting ? "正在压缩…" : "压缩上下文"}</Text>
          </Pressable>
          <Text style={styles.note}>{compacting ? "新消息将由 DSH 接续处理。" : "DSH 估算值；分项与总量的估算口径不同。"}</Text>
        </> : <>
          <Text accessibilityRole="header" style={styles.title}>{popup.kind === "activity" ? "会话统计" : "Token 用量"}</Text>
          {rows.map(([label, value]) => <View key={label} style={styles.detail}><Text style={styles.label}>{label}</Text><Text style={styles.value}>{value}</Text></View>)}
          {popup.kind === "usage" && !!usage?.cacheWriteTokens ? <Text style={styles.note}>总量另含缓存写入 {exact(usage.cacheWriteTokens)}。</Text> : null}
          <Text style={styles.note}>累计至本轮结束</Text>
        </>}
      </ScrollView>
    </View>
  </View>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  ringButton: { width: 40, minHeight: 44, alignItems: "center", justifyContent: "center" },
  pills: { flexDirection: "row", flexWrap: "wrap", columnGap: space.md },
  pill: { minHeight: 44, justifyContent: "center", flexShrink: 1 },
  caption: { ...typography.caption, color: colors.muted },
  box: { position: "absolute", borderRadius: radius.item, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line,
    backgroundColor: colors.surfaceRaised, shadowColor: colors.shadow, shadowOpacity: 0.15, shadowRadius: 16, shadowOffset: { width: 0, height: 4 }, elevation: 8 },
  boxContent: { padding: space.md, gap: space.xs },
  heading: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: space.xs },
  title: { ...typography.item, color: colors.ink, marginBottom: space.xs },
  label: { ...typography.detail, color: colors.muted, flexShrink: 1 },
  value: { ...typography.detail, color: colors.ink, fontVariant: ["tabular-nums"] },
  detail: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md, minHeight: 27 },
  legend: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 },
  swatch: { width: 7, height: 7, borderRadius: 2 },
  bar: { height: 4, backgroundColor: colors.neutral, borderRadius: 2, overflow: "hidden", flexDirection: "row", marginVertical: space.sm },
  compress: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, marginTop: space.sm },
  disabled: { opacity: 0.4 },
  note: { ...typography.caption, color: colors.muted, marginTop: space.xs },
  error: { ...typography.detail, color: colors.red, marginTop: space.sm },
});
