import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { useTheme, useThemedStyles } from "./ThemeProvider";
import { layout, radius, space, typography, type ThemeColors } from "./theme";

type IconName = ComponentProps<typeof Ionicons>["name"];
export type Notice = {
  id?: string;
  message: string;
  tone?: "info" | "success" | "warning" | "error";
  icon?: IconName;
  /** null keeps a status visible until its owner dismisses it. Defaults to 4 seconds. */
  duration?: number | null;
  dismissible?: boolean;
  action?: { label: string; icon?: IconName; onPress: () => void };
};
type Notices = { show: (notice: Notice) => string; dismiss: (id: string) => void };
const Context = createContext<Notices | null>(null);

/** Mount once inside the safe area. Notices never change the page's layout. */
export function NoticeProvider({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  const [items, setItems] = useState<(Notice & { id: string })[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const sequence = useRef(0);
  const dismiss = useCallback((id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((old) => old.filter((item) => item.id !== id));
  }, []);
  const show = useCallback((notice: Notice) => {
    const id = notice.id ?? `notice-${++sequence.current}`;
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((old) => [...old.filter((item) => item.id !== id), { ...notice, id }]);
    const duration = notice.duration === undefined ? 4000 : notice.duration;
    if (duration !== null) timers.current.set(id, setTimeout(() => dismiss(id), Math.max(0, duration)));
    return id;
  }, [dismiss]);
  useEffect(() => {
    const activeTimers = timers.current;
    return () => { activeTimers.forEach(clearTimeout); activeTimers.clear(); };
  }, []);
  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  const visible = items.at(-1);
  return <Context.Provider value={value}>
    <View style={styles.root}>
      {children}
      {visible ? <View pointerEvents="box-none" style={styles.overlay}>
        <FloatingNotice {...visible} onClose={visible.dismissible === false ? undefined : () => dismiss(visible.id)} />
      </View> : null}
    </View>
  </Context.Provider>;
}

export function useNotice() {
  const notices = useContext(Context);
  if (!notices) throw new Error("useNotice must be used inside NoticeProvider");
  return notices;
}

export function FloatingNotice({ message, tone = "info", icon, action, onClose }: Notice & { onClose?: () => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const foreground = { info: colors.ink, success: colors.green, warning: colors.amber, error: colors.red }[tone];
  const symbol = icon ?? { info: "information-circle-outline", success: "checkmark-circle-outline", warning: "alert-circle-outline", error: "alert-circle-outline" }[tone] as IconName;
  return <View style={styles.notice} accessibilityLiveRegion="polite">
    <Ionicons name={symbol} size={18} color={foreground} accessible={false} />
    <Text style={[styles.message, { color: foreground }]}>{message}</Text>
    {action ? <Pressable accessibilityRole="button" accessibilityLabel={action.label} onPress={action.onPress}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
      {action.icon ? <Ionicons name={action.icon} size={18} color={colors.ink} /> : <Text style={styles.actionText}>{action.label}</Text>}
    </Pressable> : null}
    {onClose ? <Pressable accessibilityRole="button" accessibilityLabel="关闭提示" onPress={onClose}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
      <Ionicons name="close" size={18} color={colors.muted} />
    </Pressable> : null}
  </View>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1 },
  overlay: { position: "absolute", top: space.sm, left: layout.gutter, right: layout.gutter, zIndex: 20 },
  notice: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.md, paddingRight: space.xs, paddingVertical: space.xs,
    minHeight: layout.touchTarget, borderRadius: radius.item, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line,
    backgroundColor: colors.surfaceRaised, shadowColor: colors.shadow, shadowOpacity: 0.12, shadowOffset: { width: 0, height: 3 }, shadowRadius: 8, elevation: 6 },
  message: { flex: 1, minWidth: 0, ...typography.detail },
  action: { minWidth: layout.touchTarget, minHeight: layout.touchTarget, paddingHorizontal: space.sm, alignItems: "center", justifyContent: "center" },
  actionText: { ...typography.button, color: colors.ink, flexShrink: 1 },
  pressed: { opacity: 0.72 },
});
