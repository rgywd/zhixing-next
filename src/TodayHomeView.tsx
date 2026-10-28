import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { AppearanceControl } from "./AppearanceControl";
import { useThemedStyles } from "./ThemeProvider";
import { radius, space, typography, type ThemeColors } from "./theme";
import type { TodayHomeModule, TodayHomeView as TodayView } from "./todayTypes";
import { useUi } from "./ui";

export function emptyTodayView(now = new Date()): TodayView {
  const module = { value: "待连接", badge: "暂无数据", tone: "neutral" as const, detail: "连接服务后查看真实记录。", footerLabel: "当前记录", footerValue: "未知", progress: null };
  return {
    dateLabel: new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(now),
    clockLabel: new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(now),
    locationLabel: "位置未连接", weatherLabel: "天气未连接", weatherIcon: "partly-sunny-outline", contextBusy: false, contextHint: "可以按需连接位置天气和系统日历。",
    statusLabel: "知行待连接", statusTone: "neutral", briefing: "还未连接今日信息。可以先说说今天想处理的事，再一起安排节奏。",
    calendar: { month: `${now.getMonth() + 1}月`, day: String(now.getDate()), title: "还未连接日历", description: "连接系统日历，查看下一项安排。", badge: "按需连接", hasEvent: false },
    finance: { ...module, footerLabel: "本月收支" }, health: { ...module, footerLabel: "饮食与体重" },
  };
}

export function TodayHomeView({ today: supplied, onSettings, onCalendar, onPrompt, onFinance, onHealth, onManage, manageReady, promptReady = true }: {
  today?: TodayView; onSettings?: () => void; onCalendar?: () => void; onPrompt?: (text: string) => void;
  onFinance: () => void; onHealth: () => void;
  onManage?: () => void; manageReady: boolean; promptReady?: boolean;
}) {
  const { colors, s } = useUi();
  const v = useThemedStyles(createStyles);
  const [input, setInput] = useState("");
  const today = supplied ?? emptyTodayView();
  const promptLocked = !promptReady || !onPrompt;
  const statusColor = today.statusTone === "green" ? colors.green : today.statusTone === "gold" ? colors.gold : colors.muted;
  function start() {
    if (promptLocked) return;
    const text = input.trim() || `请结合今天（${today.dateLabel} ${today.clockLabel}）的信息帮我梳理日常节奏：${today.briefing} ${today.calendar.hasEvent ? `下一项日程：${today.calendar.title}，${today.calendar.description}。` : "目前没有已确认的下一项日程信息。"}先一起明确接下来可以做的一件事。`;
    onPrompt?.(text);
    setInput("");
  }
  const module = (title: string, icon: "wallet-outline" | "heart-outline", value: TodayHomeModule, onPress: () => void) => {
    const tone = value.tone === "green" ? colors.green : value.tone === "red" ? colors.red : value.tone === "gold" ? colors.gold : colors.muted;
    const toneBackground = value.tone === "green" ? colors.greenSoft : value.tone === "red" ? colors.pale : value.tone === "gold" ? colors.goldSoft : colors.neutral;
    const progress = value.progress != null && Number.isFinite(value.progress) ? Math.max(0, Math.min(1, value.progress)) : null;
    return <Pressable accessibilityRole="button" accessibilityLabel={`打开${title}`} onPress={onPress} style={({ pressed }) => [v.module, pressed && s.pressed]}>
      <View style={v.moduleTop}><View style={[v.moduleIcon, { borderColor: tone, backgroundColor: toneBackground }]}><Ionicons name={icon} size={22} color={tone} /></View><View style={[v.moduleBadge, { backgroundColor: toneBackground }]}><Text style={[v.moduleBadgeText, { color: tone }]}>{value.badge}</Text></View></View>
      <Text style={v.moduleLabel}>{title === "财务" ? "财务 · 额度结余" : "健康 · 饮食节律"}</Text>
      <Text style={v.moduleValue}>{value.value}</Text>
      <Text style={v.moduleDetail}>{value.detail}</Text>
      <View style={v.moduleFooter}>
        {progress != null ? <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }} style={v.progressTrack}><View style={[v.progressFill, { width: `${progress * 100}%`, backgroundColor: tone }]} /></View> : null}
        <View style={v.footerLabels}><Text style={v.moduleDetail}>{value.footerLabel}</Text><Text style={v.footerValue}>{value.footerValue}</Text></View>
      </View>
    </Pressable>;
  };
  return <>
    <View style={v.contextBar}>
      <Pressable accessibilityRole="button" accessibilityLabel="今日位置、天气与日历设置" disabled={!onSettings} onPress={onSettings} style={({ pressed }) => [v.contextContent, pressed && s.pressed]}>
        <View style={v.contextRow}><Ionicons name="location-outline" size={15} color={colors.gold} /><Text style={v.place}>{today.locationLabel}</Text><Text style={v.contextSeparator}>|</Text><Ionicons name={today.weatherIcon} size={15} color={colors.gold} /><Text style={v.weather}>{today.weatherLabel}</Text></View>
        <Text style={v.dateLabel}>{today.dateLabel}</Text>
      </Pressable>
      <AppearanceControl />
    </View>
    {today.contextBusy || today.contextHint ? <Text accessibilityLiveRegion="polite" style={v.contextHint}>{today.contextBusy ? "正在更新今日信息…" : today.contextHint}</Text> : null}
    <View style={v.headingRow}>
      <View style={v.headingCopy}><Text style={v.eyebrow}>TODAY</Text><Text accessibilityRole="header" style={v.heading}>今天</Text><Text style={v.subtitle}>照顾好开销，也照顾好自己。</Text></View>
      <View style={v.status}><View style={[v.statusDot, { backgroundColor: statusColor }]} /><Text style={[v.statusText, { color: statusColor }]}>{today.statusLabel}</Text></View>
    </View>

    <View style={v.briefingCard}>
      <View style={v.briefingRow}>
        <View style={v.briefingIcon}><Ionicons name={today.weatherIcon === "rainy-outline" || today.weatherIcon === "thunderstorm-outline" ? "umbrella-outline" : "leaf-outline"} size={26} color={colors.gold} /></View>
        <View style={v.briefingCopy}><View style={v.briefingTitleRow}><Text accessibilityRole="header" style={v.cardTitle}>今日节律建议</Text><View style={v.companion}><Text style={v.companionText}>思考伙伴</Text></View></View><Text style={v.briefingText}>{today.briefing}</Text></View>
      </View>
      <View style={v.divider} />
      <View style={v.inputRow}>
        <View style={v.inputShell}><Ionicons name="create-outline" size={18} color={colors.gold} /><TextInput accessibilityLabel="交给知行的想法" editable={!promptLocked} value={input} onChangeText={(text) => { if (!promptLocked) setInput(text); }} placeholder="交代知行，或随手记下想法…" placeholderTextColor={colors.muted} maxLength={2000} multiline textAlignVertical="center" style={v.input} /></View>
        <Pressable accessibilityRole="button" accessibilityLabel="开始梳理今日安排" accessibilityState={{ disabled: promptLocked }} disabled={promptLocked} onPress={() => start()} style={({ pressed }) => [v.startButton, promptLocked && v.disabled, pressed && s.pressed]}><Text style={v.startText}>开始</Text><Ionicons name="chevron-forward" size={17} color={colors.onInk} /></Pressable>
      </View>
    </View>

    <Pressable accessibilityRole="button" accessibilityLabel={today.calendar.hasEvent ? "查看下一项日程" : "连接或查看系统日历"} disabled={!onCalendar} onPress={onCalendar} style={({ pressed }) => [v.calendar, pressed && s.pressed]}>
      <View style={v.calendarDate}><Text style={v.calendarMonth}>{today.calendar.month}</Text><Text style={v.calendarDay}>{today.calendar.day}</Text></View>
      <View style={v.calendarCopy}><View style={v.calendarTitleRow}><Text style={v.calendarTitle}>{today.calendar.title}</Text>{today.calendar.badge ? <Text style={v.calendarBadge}>{today.calendar.badge}</Text> : null}</View><Text style={v.calendarDescription}>{today.calendar.description}</Text></View>
      <Ionicons name="chevron-forward" size={18} color={colors.muted} />
    </Pressable>

    <View style={v.sectionRow}><Text accessibilityRole="header" style={v.sectionTitle}>常用模块</Text>{onManage ? <Pressable accessibilityRole="button" accessibilityLabel="整理常用" disabled={!manageReady} onPress={onManage} style={({ pressed }) => [v.manageButton, !manageReady && v.disabled, pressed && s.pressed]}><Ionicons name="options-outline" size={17} color={colors.gold} /><Text style={v.moduleDetail}>整理</Text></Pressable> : null}</View>
    <View style={v.moduleGrid}>{module("财务", "wallet-outline", today.finance, onFinance)}{module("健康", "heart-outline", today.health, onHealth)}</View>
  </>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  contextBar: { flexDirection: "row", alignItems: "center", marginTop: space.md, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingLeft: space.md, paddingRight: space.xs, minHeight: 44, gap: space.xs },
  contextContent: { flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "center", alignContent: "center", columnGap: space.md, rowGap: 2, minHeight: 44, paddingVertical: space.xs },
  contextRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.xs, maxWidth: "100%", flexShrink: 1 },
  place: { ...typography.detail, color: colors.ink, flexShrink: 1 }, weather: { ...typography.detail, color: colors.muted, flexShrink: 1 }, contextSeparator: { ...typography.small, color: colors.muted, marginHorizontal: 2 },
  dateLabel: { ...typography.caption, color: colors.muted }, contextHint: { ...typography.small, color: colors.muted, marginTop: -space.sm, paddingHorizontal: space.sm },
  headingRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: space.md, paddingHorizontal: space.xs, paddingTop: space.sm }, headingCopy: { flex: 1, minWidth: 0, gap: 2 },
  eyebrow: { ...typography.kicker, color: colors.khaki, letterSpacing: 1.8 }, heading: { ...typography.hero, fontSize: 34, lineHeight: 43, color: colors.ink }, subtitle: { ...typography.body, color: colors.muted },
  status: { flexDirection: "row", flexWrap: "nowrap", alignItems: "center", justifyContent: "center", gap: 5, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.strongLine, backgroundColor: colors.surface, paddingHorizontal: 10, paddingVertical: 7, maxWidth: "48%", marginTop: 8 }, statusDot: { width: 6, height: 6, borderRadius: 3, flexShrink: 0 }, statusText: { ...typography.caption, flexShrink: 1 },
  briefingCard: { backgroundColor: colors.surface, borderRadius: radius.card + 4, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.strongLine, padding: space.lg, gap: space.lg },
  briefingRow: { flexDirection: "row", alignItems: "center", gap: space.md }, briefingIcon: { width: 40, height: 44, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.strongLine, backgroundColor: colors.goldSoft, alignItems: "center", justifyContent: "center", flexShrink: 0 }, briefingCopy: { flex: 1, minWidth: 0, gap: space.xs },
  briefingTitleRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }, cardTitle: { ...typography.section, fontSize: 16, color: colors.ink }, companion: { backgroundColor: colors.goldSoft, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 }, companionText: { ...typography.small, color: colors.gold }, briefingText: { ...typography.body, color: colors.muted },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line }, inputRow: { flexDirection: "row", alignItems: "center", gap: space.sm }, inputShell: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44, borderRadius: radius.control, backgroundColor: colors.paper, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingHorizontal: space.md }, input: { flex: 1, minWidth: 0, ...typography.body, color: colors.ink, minHeight: 44, maxHeight: 100, paddingVertical: space.sm },
  startButton: { flexDirection: "row", gap: space.xs, minHeight: 44, paddingHorizontal: space.md, borderRadius: radius.control, alignItems: "center", justifyContent: "center", backgroundColor: colors.gold }, startText: { ...typography.button, color: colors.onInk },
  calendar: { flexDirection: "row", alignItems: "center", gap: space.md, backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, padding: space.md, minHeight: 76 }, calendarDate: { minWidth: 42, borderRadius: radius.control, paddingHorizontal: space.sm, paddingVertical: 5, alignItems: "center", backgroundColor: colors.surfaceRaised, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }, calendarMonth: { ...typography.small, fontWeight: "700", color: colors.gold }, calendarDay: { ...typography.item, fontSize: 19, lineHeight: 25, color: colors.ink }, calendarCopy: { flex: 1, minWidth: 0, gap: space.xs }, calendarTitleRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }, calendarTitle: { ...typography.item, color: colors.ink, flexShrink: 1 }, calendarBadge: { ...typography.small, color: colors.gold, backgroundColor: colors.goldSoft, borderRadius: radius.small, paddingHorizontal: 6, paddingVertical: 2 }, calendarDescription: { ...typography.caption, color: colors.muted },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, minHeight: 34 }, sectionTitle: { ...typography.section, color: colors.ink }, manageButton: { flexDirection: "row", gap: space.xs, minHeight: 44, alignItems: "center", paddingHorizontal: space.xs },
  moduleGrid: { flexDirection: "row", flexWrap: "wrap", gap: space.md }, module: { width: "45%", flexGrow: 1, minWidth: 0, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: radius.card, padding: space.md, gap: space.sm }, moduleTop: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: space.sm }, moduleIcon: { width: 34, height: 34, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" }, moduleBadge: { borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2 }, moduleBadgeText: { ...typography.small }, moduleLabel: { ...typography.caption, color: colors.muted }, moduleValue: { ...typography.title, fontSize: 21, lineHeight: 29, color: colors.ink, fontVariant: ["tabular-nums"] }, moduleDetail: { ...typography.small, color: colors.muted }, moduleFooter: { marginTop: "auto", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingTop: space.sm, gap: space.xs }, progressTrack: { height: 6, borderRadius: radius.pill, overflow: "hidden", backgroundColor: colors.neutral }, progressFill: { height: "100%", borderRadius: radius.pill }, footerLabels: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: space.xs, rowGap: 2 }, footerValue: { ...typography.caption, color: colors.ink, fontWeight: "600", flexShrink: 1 },
  disabled: { opacity: 0.45 },
});
