import type { ComponentProps, ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { AppearanceControl } from "./AppearanceControl";
import { useThemedStyles } from "./ThemeProvider";
import { layout, radius, serviceLayout, space, typography, type ThemeColors } from "./theme";
import { useUi } from "./ui";

type IconName = ComponentProps<typeof Ionicons>["name"];
export const useServiceStyles = () => useThemedStyles(createServiceStyles);

export function ServiceToolbar({ period, onPrevious, onNext, onBack, onCurrent, previousLabel = "上个月", nextLabel = "下个月", currentLabel }: {
  period: string; onPrevious: () => void; onNext: () => void; onBack?: () => void; onCurrent?: () => void;
  previousLabel?: string; nextLabel?: string; currentLabel?: string;
}) {
  const styles = useServiceStyles();
  const { colors } = useUi();
  return <View style={styles.toolbar}>
    <View style={styles.toolbarSide}>
      {onBack ? <Pressable accessibilityRole="button" accessibilityLabel="返回生活" onPress={onBack} style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
        <Ionicons name="chevron-back" size={18} color={colors.gold} /><Text style={styles.backText}>生活</Text>
      </Pressable> : null}
    </View>
    <View style={styles.period}>
      <View pointerEvents="none" style={styles.periodSurface} />
      <Pressable accessibilityRole="button" accessibilityLabel={previousLabel} onPress={onPrevious} style={({ pressed }) => [styles.periodArrow, pressed && styles.pressed]}><Ionicons name="chevron-back" size={14} color={colors.muted} /></Pressable>
      {onCurrent ? <Pressable accessibilityRole="button" accessibilityLabel={currentLabel ?? period} onPress={onCurrent} style={({ pressed }) => [styles.periodCurrent, pressed && styles.pressed]}><Text style={styles.periodText}>{period}</Text></Pressable>
        : <Text style={styles.periodText}>{period}</Text>}
      <Pressable accessibilityRole="button" accessibilityLabel={nextLabel} onPress={onNext} style={({ pressed }) => [styles.periodArrow, pressed && styles.pressed]}><Ionicons name="chevron-forward" size={14} color={colors.muted} /></Pressable>
    </View>
    <View style={[styles.toolbarSide, styles.toolbarEnd]}><AppearanceControl /></View>
  </View>;
}

export function ServiceHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  const styles = useServiceStyles();
  return <View style={styles.heading}><Text style={styles.eyebrow}>{eyebrow}</Text><Text accessibilityRole="header" style={styles.headingTitle}>{title}</Text><Text style={styles.muted}>{description}</Text></View>;
}

export function ServiceCard({ children }: { children: ReactNode }) {
  const styles = useServiceStyles();
  return <View style={styles.card}>{children}</View>;
}

export function ServiceSectionHeader({ icon, title, subtitle, action }: { icon: IconName; title: string; subtitle?: string; action?: ReactNode }) {
  const styles = useServiceStyles();
  const { colors } = useUi();
  return <View style={styles.row}>
    <View style={styles.sectionIcon}><Ionicons name={icon} size={21} color={colors.gold} /></View>
    <View style={styles.recordMain}><Text accessibilityRole="header" style={styles.title}>{title}</Text>{subtitle ? <Text style={styles.muted}>{subtitle}</Text> : null}</View>
    {action}
  </View>;
}

export function ServiceMetric({ label, value, detail, tone = "neutral", actionLabel, onPress, disabled = false }: {
  label: string; value: string; detail?: string; tone?: "gold" | "neutral" | "warning";
  actionLabel?: string; onPress?: () => void; disabled?: boolean;
}) {
  const styles = useServiceStyles();
  const content = <><Text style={styles.metricLabel}>{label}</Text><Text style={[styles.metricValue, tone !== "neutral" && styles.gold]}>{value}</Text>{detail ? <Text style={[styles.metricDetail, tone === "gold" && styles.gold]}>{detail}</Text> : null}</>;
  return onPress ? <Pressable accessibilityRole="button" accessibilityLabel={actionLabel ?? label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.metric, disabled && styles.disabled, pressed && styles.pressed]}>{content}</Pressable>
    : <View style={styles.metric}>{content}</View>;
}

export function ServiceChatRow({ title, description, onPress }: { title: string; description?: string; onPress: () => void }) {
  const styles = useServiceStyles();
  const { colors } = useUi();
  return <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress} style={({ pressed }) => [styles.chatRow, pressed && styles.pressed]}>
    <View style={styles.chatIcon}><Ionicons name="chatbubble-ellipses-outline" size={14} color={colors.gold} /></View>
    <Text style={styles.chatTitle}>{title}</Text>
    {description ? <Text style={styles.chatDescription}>{description}</Text> : null}
    <Ionicons name="chevron-forward" size={14} color={colors.muted} />
  </Pressable>;
}

export function ServiceEmpty({ icon, title, description, children }: { icon: IconName; title: string; description: string; children?: ReactNode }) {
  const styles = useServiceStyles();
  const { colors } = useUi();
  return <View style={styles.empty}>
    <View style={styles.emptyIcon}><Ionicons name={icon} size={26} color={colors.gold} /></View>
    <Text accessibilityRole="header" style={styles.emptyTitle}>{title}</Text><Text style={styles.emptyDescription}>{description}</Text>
    {children ? <View style={styles.emptyActions}>{children}</View> : null}
  </View>;
}

export const createServiceStyles = (colors: ThemeColors) => StyleSheet.create({
  toolbar: { minHeight: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: layout.gutter - space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  toolbarSide: { flex: 1, minWidth: 48 },
  toolbarEnd: { alignItems: "flex-end" },
  back: { flexDirection: "row", alignItems: "center", minHeight: layout.touchTarget, alignSelf: "flex-start", paddingRight: 4, gap: 1 },
  backText: { ...typography.item, color: colors.gold },
  period: { flexDirection: "row", alignItems: "center", minHeight: layout.touchTarget },
  periodSurface: { position: "absolute", top: 7, bottom: 7, left: 0, right: 0, backgroundColor: colors.surface, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  periodArrow: { minWidth: 40, minHeight: layout.touchTarget, alignItems: "center", justifyContent: "center" },
  periodCurrent: { minHeight: layout.touchTarget, justifyContent: "center" },
  periodText: { ...typography.detail, color: colors.ink, textAlign: "center", paddingHorizontal: 3 },
  heading: { gap: 3, paddingHorizontal: 4, paddingTop: 0, paddingBottom: space.xs },
  eyebrow: { ...typography.small, fontWeight: "700", letterSpacing: 2.3, color: colors.gold },
  headingTitle: { ...typography.hero, fontSize: serviceLayout.headingSize, lineHeight: 35, color: colors.ink },
  card: { backgroundColor: colors.surface, borderRadius: serviceLayout.cardRadius, padding: serviceLayout.cardPadding, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, gap: 14 },
  row: { flexDirection: "row", alignItems: "center", gap: space.md },
  spread: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, flexWrap: "wrap" },
  stack: { gap: space.sm },
  title: { ...typography.section, fontSize: 16, lineHeight: 23, color: colors.ink },
  body: { ...typography.detail, color: colors.ink },
  muted: { ...typography.caption, color: colors.muted },
  tiny: { ...typography.small, color: colors.muted },
  gold: { color: colors.gold },
  sectionIcon: { width: 40, height: 40, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.strongLine, backgroundColor: colors.surfaceRaised, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.md },
  metric: { width: "46%", flexGrow: 1, minWidth: 0, borderRadius: serviceLayout.tileRadius, padding: space.md, backgroundColor: colors.surfaceRaised, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, gap: 3, minHeight: 80 },
  metricLabel: { ...typography.caption, color: colors.muted },
  metricValue: { ...typography.item, fontSize: 15, color: colors.ink, fontVariant: ["tabular-nums"] },
  metricDetail: { ...typography.small, color: colors.muted },
  amount: { fontSize: serviceLayout.amountSize, lineHeight: 42, fontWeight: "700", letterSpacing: -1, color: colors.ink, fontVariant: ["tabular-nums"] },
  amountSmall: { ...typography.title, fontSize: 24, lineHeight: 32, color: colors.ink, fontVariant: ["tabular-nums"] },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  inset: { backgroundColor: colors.surfaceRaised, borderRadius: serviceLayout.tileRadius, padding: space.md, gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  threeColumns: { flexDirection: "row", gap: space.sm },
  column: { flex: 1, minWidth: 0, alignItems: "center", backgroundColor: colors.surfaceRaised, borderRadius: radius.control, paddingHorizontal: space.xs, paddingVertical: space.sm, gap: space.xs, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  progressTrack: { height: 6, borderRadius: radius.pill, overflow: "hidden", backgroundColor: colors.neutral, flexDirection: "row" },
  progressFill: { backgroundColor: colors.accent, height: "100%", borderRadius: radius.pill },
  progressReserved: { backgroundColor: colors.strongLine, height: "100%" },
  chatRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, minHeight: layout.touchTarget, paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: colors.surfaceRaised, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: serviceLayout.tileRadius },
  chatIcon: { width: 25, height: 25, borderRadius: 9, backgroundColor: colors.goldSoft, alignItems: "center", justifyContent: "center" },
  chatTitle: { ...typography.caption, fontWeight: "600", color: colors.ink },
  chatDescription: { ...typography.small, color: colors.muted, flex: 1, textAlign: "right", minWidth: 56 },
  primaryButton: { minHeight: 52, borderRadius: serviceLayout.tileRadius },
  empty: { alignItems: "center", paddingVertical: space.xl, paddingHorizontal: space.sm, gap: space.md },
  emptyIcon: { width: 56, height: 56, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.strongLine, backgroundColor: colors.surfaceRaised, marginBottom: space.xs },
  emptyTitle: { ...typography.section, fontSize: 16, color: colors.ink, textAlign: "center" },
  emptyDescription: { ...typography.detail, color: colors.muted, textAlign: "center", maxWidth: 270 },
  emptyActions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.md },
  footerAction: { alignSelf: "flex-end" },
  recordRow: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  recordMain: { flex: 1, minWidth: 0, gap: 2 },
  recordAmount: { ...typography.item, color: colors.ink, fontVariant: ["tabular-nums"] },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.45 },
});
