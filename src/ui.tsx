import type { ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";

export const colors = {
  paper: "#FBF7F1",
  white: "#FFFFFF",
  ink: "#25252D",
  accent: "#A6322C",
  muted: "#77777F",
  line: "#EBE6E2",
  pale: "#F8E9E6",
  red: "#B3261E",
  amber: "#8A5A28",
};
export function Button({
  children,
  onPress,
  disabled = false,
  secondary = false,
  danger = false,
  small = false,
}: {
  children: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  danger?: boolean;
  small?: boolean;
}) {
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
      ]}
    >
      <Text
        style={[s.buttonText, secondary && s.secondaryText, danger && s.danger]}
      >
        {children}
      </Text>
    </Pressable>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        {...props}
        style={[s.input, props.multiline && s.multiline, props.style]}
      />
    </View>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <View style={s.empty}>
      <View style={s.brand}><Ionicons name="leaf-outline" size={24} color={colors.accent} /></View>
      <Text accessibilityRole="header" style={s.emptyTitle}>
        {title}
      </Text>
      <Text style={s.emptyBody}>{children}</Text>
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
export const tabBarClearance = 112;
export const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  body: { flex: 1 },
  content: { padding: 22, gap: 18, paddingBottom: 36 },
  tabContent: { paddingBottom: tabBarClearance + 20 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  spread: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  grow: { flex: 1 },
  header: {
    paddingHorizontal: 22,
    paddingTop: 16,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  brand: { width: 48, height: 48, borderRadius: 17, backgroundColor: colors.pale, alignItems: "center", justifyContent: "center" },
  eyebrow: {
    fontSize: 10,
    letterSpacing: 2.5,
    color: colors.muted,
    marginBottom: 3,
  },
  heading: { fontSize: 25, fontWeight: "600", color: colors.ink },
  title: { fontSize: 18, lineHeight: 27, fontWeight: "600", color: colors.ink },
  text: { fontSize: 15, lineHeight: 24, color: colors.ink },
  muted: { fontSize: 12, lineHeight: 19, color: colors.muted },
  label: { fontSize: 13, fontWeight: "500", color: colors.ink },
  field: { gap: 8 },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.white,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.ink,
    minHeight: 48,
  },
  multiline: { minHeight: 120, textAlignVertical: "top", lineHeight: 23 },
  button: {
    minHeight: 46,
    paddingHorizontal: 17,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  smallButton: { paddingHorizontal: 12, paddingVertical: 8, minHeight: 40 },
  buttonText: { color: colors.white, fontWeight: "600", fontSize: 14 },
  secondary: { backgroundColor: colors.pale },
  secondaryText: { color: colors.accent },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.72 },
  danger: { color: colors.red },
  error: { color: colors.red, fontSize: 13, lineHeight: 20 },
  notice: { padding: 13, borderRadius: 12, backgroundColor: colors.pale, gap: 6 },
  noticeText: { color: colors.amber, fontSize: 12, lineHeight: 19 },
  card: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 18,
    padding: 17,
    gap: 12,
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
    borderWidth: 1,
    borderColor: colors.white,
    backgroundColor: colors.white,
    shadowColor: "#5F2B25",
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
    alignSelf: "flex-start",
    borderRadius: 32,
    backgroundColor: colors.paper,
  },
  aiButton: {
    width: 66,
    height: 66,
    borderRadius: 26,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
    borderWidth: 3,
    borderColor: colors.white,
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.18,
    shadowRadius: 7,
    elevation: 3,
  },
  aiButtonText: { color: colors.white, fontSize: 10, fontWeight: "700", letterSpacing: 1 },
  activeTab: { backgroundColor: colors.pale },
  tabText: { color: colors.muted, fontSize: 11, fontWeight: "600" },
  activeTabText: { color: colors.accent, fontWeight: "700" },
  backLink: { minHeight: 44, paddingHorizontal: 22, justifyContent: "center" },
  backLinkText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  empty: {
    flex: 1,
    padding: 32,
    gap: 18,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 280,
  },
  emptyTitle: {
    fontSize: 23,
    color: colors.ink,
    fontWeight: "500",
    textAlign: "center",
  },
  emptyBody: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 24,
    textAlign: "center",
  },
  chip: {
    paddingVertical: 9,
    paddingHorizontal: 13,
    borderRadius: 12,
    backgroundColor: colors.pale,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  chipActive: { backgroundColor: colors.accent },
  chipText: { color: colors.muted, fontSize: 12 },
  chipActiveText: { color: colors.white },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
