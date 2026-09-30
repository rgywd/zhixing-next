import { AppearanceControl } from "./AppearanceControl";
import type { ThemeColors } from "./theme";
import { useTheme, useThemedStyles } from "./ThemeProvider";
import type { ComponentProps, ReactNode } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type ImageSourcePropType,
  type ImageStyle,
  type ScrollViewProps,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { layout, radius, space, typography } from "./theme";

type IconName = ComponentProps<typeof Ionicons>["name"];
export type UiTone = "red" | "blue" | "gold" | "green" | "neutral";
const getToneColors = (colors: ThemeColors) => ({
  red: [colors.accent, colors.pale],
  blue: [colors.blue, colors.blueSoft], gold: [colors.gold, colors.goldSoft],
  green: [colors.green, colors.greenSoft], neutral: [colors.ink, colors.neutral],
} as const);

export function PageScrollView({ tabs = false, contentContainerStyle, ...props }: ScrollViewProps & { tabs?: boolean }) {
  const { s } = useUi();
  return <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" {...props} contentContainerStyle={[s.content, tabs && s.mainPage, tabs && s.tabContent, contentContainerStyle]} />;
}

export function PageHero({ eyebrow, title, description, art, artStyle }: {
  eyebrow: string; title: string; description: string; art?: ImageSourcePropType; artStyle?: StyleProp<ImageStyle>;
}) {
  const { s, mode } = useUi();
  const narrow = useWindowDimensions().width < layout.compactWidth;
  return (
    <View style={s.hero}>
      {art && !narrow && mode === "light" ? <Image source={art} resizeMode="contain" style={[s.heroArt, artStyle]} accessible={false} /> : null}
      <View style={s.heroAppearance}><AppearanceControl /></View>
      <Text style={s.kicker}>{eyebrow}</Text>
      <Text accessibilityRole="header" style={s.heroTitle}>{title}</Text>
      <Text style={[s.description, art && !narrow && mode === "light" ? s.heroDescription : null]}>{description}</Text>
    </View>
  );
}

export function PageHeading({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  const { s } = useUi();
  return (
    <View style={s.row}>
      <View style={s.headingCopy}>
        <Text accessibilityRole="header" style={s.heading}>{title}</Text>
        {description ? <Text style={s.description}>{description}</Text> : null}
      </View>
      {action}
    </View>
  );
}

export function SheetHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const { s } = useUi();
  return <View style={s.header}><Text accessibilityRole="header" style={[s.heading, s.grow]}>{title}</Text><IconAction icon="close" label="关闭" onPress={onClose} /></View>;
}

export function BackLink({ label, onPress }: { label: string; onPress: () => void }) {
  const { s, colors } = useUi();
  return <Pressable accessibilityRole="button" accessibilityLabel={`返回${label}`} onPress={onPress} style={({ pressed }) => [s.backLink, pressed && s.pressed]}><Ionicons name="chevron-back" size={20} color={colors.accent} /><Text style={s.backLinkText}>{label}</Text></Pressable>;
}

export function IconBadge({ name, small = false, tone = "red" }: { name: IconName; small?: boolean; tone?: UiTone }) {
  const { s, toneColors } = useUi();
  return <View accessible={false} style={[s.iconBadge, small && s.iconBadgeSmall, { backgroundColor: toneColors[tone][1] }]}><Ionicons name={name} size={small ? 19 : 23} color={toneColors[tone][0]} /></View>;
}

export function CardHeader({ icon, title, description, action, tone = "red" }: { icon: IconName; title: string; description?: string; action?: ReactNode; tone?: UiTone }) {
  const { s } = useUi();
  return <View style={s.row}><IconBadge name={icon} tone={tone} /><View style={s.headingCopy}><Text accessibilityRole="header" style={s.title}>{title}</Text>{description ? <Text style={s.muted}>{description}</Text> : null}</View>{action}</View>;
}

export function ServiceTile({ icon, title, description, onPress, accessibilityLabel = title, tone = "red" }: {
  icon: IconName; title: string; description: string; onPress: () => void; accessibilityLabel?: string; tone?: UiTone;
}) {
  const { s, colors } = useUi();
  const narrow = useWindowDimensions().width < layout.compactWidth;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} style={({ pressed }) => [s.serviceTile, narrow && s.serviceTileNarrow, pressed && s.pressed]}><IconBadge name={icon} small tone={tone} /><View style={s.headingCopy}><Text style={s.itemTitle}>{title}</Text><Text numberOfLines={1} style={s.small}>{description}</Text></View><Ionicons name="chevron-forward" size={16} color={colors.muted} /></Pressable>;
}

export function ActionRow({ icon, title, description, onPress, last = false, compact = false, tone = "red" }: {
  icon: IconName; title: string; description?: string; onPress: () => void; last?: boolean; compact?: boolean; tone?: UiTone;
}) {
  const { s, colors } = useUi();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress} style={({ pressed }) => [s.actionRow, !last && s.rowDivider, pressed && s.pressed]}>
      <IconBadge name={icon} small={compact} tone={tone} />
      <View style={s.headingCopy}><Text numberOfLines={1} style={compact ? s.listTitle : s.itemTitle}>{title}</Text>{description ? <Text style={s.muted}>{description}</Text> : null}</View>
      <Ionicons name="chevron-forward" size={18} color={colors.muted} />
    </Pressable>
  );
}
export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  const { s } = useUi();
  return <View style={s.settingsSection}>
    <Text accessibilityRole="header" style={s.settingsLabel}>{title}</Text>
    <View style={s.settingsGroup}>{children}</View>
  </View>;
}
export function SwitchRow({ label, description, value, disabled, onValueChange }: {
  label: string; description?: string; value: boolean; disabled?: boolean; onValueChange: (value: boolean) => void;
}) {
  const { s, colors } = useUi();
  return <View style={[s.row, { minHeight: 48 }]}>
    <View style={s.headingCopy}><Text style={s.text}>{label}</Text>{description ? <Text style={s.muted}>{description}</Text> : null}</View>
    <Switch accessibilityLabel={label} value={value} disabled={disabled} onValueChange={onValueChange} trackColor={{ false: colors.strongLine, true: colors.gold }} thumbColor={colors.switchThumb} />
  </View>;
}
export function IconAction({ icon, label, onPress, tone = "neutral", disabled = false }: { icon: IconName; label: string; onPress: () => void; tone?: UiTone; disabled?: boolean }) {
  const { s, toneColors } = useUi();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [s.iconAction, disabled && s.disabled, pressed && s.pressed]}><Ionicons name={icon} size={20} color={toneColors[tone][0]} /></Pressable>;
}
export function ActionLink({ icon, children, onPress, tone = "red", disabled = false }: { icon?: IconName; children: string; onPress: () => void; tone?: UiTone; disabled?: boolean }) {
  const { s, toneColors } = useUi();
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [s.actionLink, disabled && s.disabled, pressed && s.pressed]}>{icon ? <Ionicons name={icon} size={17} color={toneColors[tone][0]} /> : null}<Text style={[s.actionLinkText, { color: toneColors[tone][0] }]}>{children}</Text></Pressable>;
}
export function StatusPill({ children, tone = "neutral" }: { children: string; tone?: UiTone }) {
  const { s, toneColors } = useUi();
  return <View style={[s.statusPill, { backgroundColor: toneColors[tone][1] }]}><Text style={[s.statusPillText, { color: toneColors[tone][0] }]}>{children}</Text></View>;
}
export function Button({
  children,
  onPress,
  disabled = false,
  secondary = false,
  danger = false,
  small = false,
  icon,
  style,
}: {
  children: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  danger?: boolean;
  small?: boolean;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const { s, colors } = useUi();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        secondary && s.secondary,
        small && s.smallButton,
        disabled && s.disabled,
        pressed && s.pressed,
        style,
      ]}
    >
      {icon ? <Ionicons name={icon} size={20} color={danger ? colors.red : secondary ? colors.ink : colors.onPrimary} /> : null}
      <Text
        style={[s.buttonText, secondary && s.secondaryText, danger && s.danger]}
      >
        {children}
      </Text>
    </Pressable>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const { s, colors } = useUi();
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        selectionColor={colors.accent}
        {...props}
        style={[s.input, props.multiline && s.multiline, props.style]}
      />
    </View>
  );
}
export function Empty({
  title,
  children,
  icon = "leaf-outline",
  compact = false,
}: {
  title: string;
  children?: ReactNode;
  icon?: IconName;
  compact?: boolean;
}) {
  const { s } = useUi();
  return (
    <View style={[s.empty, compact && s.compactEmpty]}>
      <IconBadge name={icon} />
      <Text accessibilityRole="header" style={s.emptyTitle}>
        {title}
      </Text>
      {children ? <Text style={s.emptyBody}>{children}</Text> : null}
    </View>
  );
}
export const humanError = (error: unknown) =>
  error instanceof Error ? error.message : "操作未完成，请重试。";
export const timeLabel = (date: string) =>
  new Date(date).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
export const runLabels = {
  queued: "等待执行",
  running: "正在执行",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
  interrupted: "执行中断",
};
export const createSharedStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  body: { flex: 1 },
  content: { padding: layout.gutter, gap: layout.pageGap, paddingBottom: 36 },
  mainPage: { paddingTop: 0 },
  tabContent: { paddingBottom: layout.tabClearance },
  row: { flexDirection: "row", alignItems: "center", gap: space.md },
  stack: { gap: space.sm },
  form: { gap: layout.pageGap },
  headingCopy: { flex: 1, minWidth: 0, gap: space.xs },
  hero: { minHeight: layout.heroHeight, justifyContent: "center", gap: 6, paddingHorizontal: 6, paddingTop: 9 },
  heroAppearance: { position: "absolute", top: 4, right: 0, zIndex: 1, backgroundColor: colors.paper, borderRadius: radius.pill },
  heroArt: { position: "absolute", width: 226, height: 130, right: -26, top: -4 },
  kicker: { ...typography.kicker, color: colors.accent },
  heroTitle: { ...typography.hero, color: colors.ink, paddingRight: 44 },
  heroDescription: { maxWidth: "76%" },
  description: { ...typography.body, color: colors.muted },
  itemTitle: { ...typography.item, color: colors.ink },
  listTitle: { ...typography.body, color: colors.ink, fontWeight: "500" },
  iconBadge: { width: 42, height: 42, borderRadius: 14, backgroundColor: colors.pale, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  iconBadgeSmall: { width: 34, height: 34, borderRadius: 11 },
  actionRow: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 56, paddingVertical: space.sm },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.line },
  settingsSection: { gap: space.sm },
  settingsLabel: { ...typography.caption, fontWeight: "600", color: colors.muted, paddingHorizontal: space.md },
  settingsGroup: { backgroundColor: colors.surfaceRaised, borderRadius: radius.item, paddingHorizontal: space.md, paddingVertical: space.xs },
  serviceGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  serviceTile: { width: "47%", flexGrow: 1, flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 66, paddingHorizontal: space.sm, paddingVertical: space.sm, borderRadius: radius.item, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.line },
  serviceTileNarrow: { width: "100%" },
  caption: { ...typography.caption, color: colors.muted },
  small: { ...typography.small, color: colors.muted },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, paddingHorizontal: 3, marginTop: space.xs, marginBottom: -7 },
  link: { ...typography.body, color: colors.accent, fontWeight: "600" },
  linkButton: { minHeight: layout.touchTarget, paddingHorizontal: space.sm, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: space.xs },
  badge: { ...typography.caption, color: colors.accent, backgroundColor: colors.pale, overflow: "hidden", borderRadius: radius.small, paddingHorizontal: space.sm, paddingVertical: space.xs, fontWeight: "600" },
  centeredAction: { minWidth: 176, maxWidth: "100%", alignSelf: "center", borderRadius: radius.pill },
  cardRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  iconButton: { minWidth: layout.touchTarget, minHeight: layout.touchTarget, alignItems: "center", justifyContent: "center" },
  iconAction: { width: layout.touchTarget, height: layout.touchTarget, borderRadius: radius.control, alignItems: "center", justifyContent: "center" },
  actionLink: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, minHeight: layout.touchTarget, paddingHorizontal: 4 },
  actionLinkText: { ...typography.button },
  statusPill: { alignSelf: "flex-start", borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 4 },
  statusPillText: { ...typography.caption, fontWeight: "700" },
  accentText: { color: colors.accent },
  spread: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  grow: { flex: 1 },
  header: {
    paddingHorizontal: layout.gutter,
    paddingTop: space.md,
    paddingBottom: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  brand: { width: 48, height: 48, borderRadius: 17, backgroundColor: colors.pale, alignItems: "center", justifyContent: "center" },
  eyebrow: {
    fontSize: 10,
    letterSpacing: 2.5,
    color: colors.muted,
    marginBottom: 3,
  },
  heading: { ...typography.title, color: colors.ink },
  title: { ...typography.section, color: colors.ink },
  text: { ...typography.reading, color: colors.ink },
  muted: { ...typography.caption, color: colors.muted },
  label: { ...typography.body, fontWeight: "600", color: colors.ink },
  field: { gap: space.sm },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.control,
    paddingHorizontal: layout.cardPadding,
    paddingVertical: space.md,
    ...typography.reading,
    color: colors.ink,
    minHeight: 48,
  },
  multiline: { minHeight: 120, textAlignVertical: "top", lineHeight: 23 },
  button: {
    minHeight: 46,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.control,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: space.sm,
  },
  smallButton: { paddingHorizontal: space.md, paddingVertical: space.sm, minHeight: layout.touchTarget },
  buttonText: { ...typography.button, color: colors.onPrimary, flexShrink: 1, textAlign: "center" },
  secondary: { backgroundColor: colors.neutral },
  secondaryText: { color: colors.ink },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.72 },
  danger: { color: colors.red },
  error: { color: colors.red, ...typography.body },
  notice: { padding: space.md, borderRadius: radius.small, backgroundColor: colors.pale, gap: 6 },
  noticeText: { color: colors.amber, ...typography.detail },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.card,
    padding: layout.cardPadding,
    gap: 9,
    shadowColor: colors.shadow,
    shadowOpacity: 0.025,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 12,
    elevation: 0,
  },
  divider: { height: 1, backgroundColor: colors.line },
  floatingTabs: {
    position: "absolute",
    bottom: 10,
    width: "92%",
    maxWidth: 560,
    height: 94,
    alignSelf: "center",
    zIndex: 10,
  },
  tabs: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.surfaceRaised,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.14,
    shadowRadius: 16,
    elevation: 8,
  },
  tabItems: {
    flex: 1,
    zIndex: 1,
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 8,
    paddingBottom: 6,
    gap: 2,
  },
  tabNotch: {
    position: "absolute",
    top: 0,
    alignSelf: "center",
    width: 144,
    height: 64,
    tintColor: colors.paper,
  },
  tab: {
    flex: 1,
    height: 60,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    borderRadius: 24,
  },
  aiTab: {
    flex: 0,
    width: 76,
    height: 76,
    marginTop: 6,
    alignSelf: "flex-start",
    borderRadius: 32,
    backgroundColor: colors.paper,
  },
  aiButton: {
    width: 66,
    height: 66,
    borderRadius: 26,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: colors.surfaceRaised,
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.18,
    shadowRadius: 7,
    elevation: 3,
  },
  aiButtonIcon: { width: 40, height: 40, tintColor: colors.onPrimary },
  activeTab: { backgroundColor: colors.pale },
  tabText: { color: colors.muted, fontSize: 11, fontWeight: "600" },
  activeTabText: { color: colors.accent, fontWeight: "700" },
  backLink: { minHeight: layout.touchTarget, paddingHorizontal: layout.gutter, flexDirection: "row", alignItems: "center", gap: space.xs },
  backLinkText: { ...typography.button, color: colors.accent },
  empty: {
    flex: 1,
    padding: space.xl,
    gap: space.md,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 180,
  },
  emptyTitle: {
    ...typography.section,
    color: colors.ink,
    textAlign: "center",
  },
  emptyBody: {
    color: colors.muted,
    ...typography.body,
    textAlign: "center",
  },
  compactEmpty: { flex: 0, minHeight: 0, paddingVertical: space.sm, gap: space.sm },
  chip: {
    paddingVertical: 9,
    paddingHorizontal: 13,
    borderRadius: radius.small,
    backgroundColor: colors.pale,
    minHeight: layout.touchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  chipActive: { backgroundColor: colors.primary },
  chipText: { color: colors.muted, ...typography.detail },
  chipActiveText: { color: colors.onPrimary },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});

export function useUi() {
  const theme = useTheme();
  const s = useThemedStyles(createSharedStyles);
  return { ...theme, s, toneColors: getToneColors(theme.colors) };
}
