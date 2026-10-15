import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { AppearanceControl } from "./AppearanceControl";
import { useThemedStyles } from "./ThemeProvider";
import { radius, space, typography, type ThemeColors } from "./theme";
import { useUi } from "./ui";

/** All agents share this chrome; identity and navigation remain caller-owned. */
export function AgentChatHeader({ title, subtitle, status, pinned = false, pinReady = true, busy = false, onMenu, onNew, onClose, onPin }: {
  title: string; subtitle: string; status?: string; pinned?: boolean; pinReady?: boolean; busy?: boolean;
  onMenu: () => void; onNew: () => void; onClose: () => void; onPin?: () => void;
}) {
  const { colors } = useUi();
  const styles = useThemedStyles(createStyles);
  return <View style={styles.header}>
    <Pressable accessibilityRole="button" accessibilityLabel="打开对话侧边栏" onPress={onMenu} style={styles.menu}>
      <Ionicons name="menu-outline" size={22} color={colors.ink} />
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel={`${title}，${subtitle}，打开对话侧边栏`} onPress={onMenu} style={styles.copy}>
      <View style={styles.titleRow}>
        <Text accessibilityRole="header" numberOfLines={1} style={styles.name}>{title}</Text>
        {status ? <View style={[styles.status, status !== "待命中" && styles.statusMuted]}><View accessible={false} style={[styles.dot, status !== "待命中" && { backgroundColor: colors.muted }]} /><Text numberOfLines={1} style={[styles.statusText, status !== "待命中" && { color: colors.muted }]}>{status}</Text></View> : null}
      </View>
      <Text numberOfLines={1} style={styles.subtitle}>{subtitle}</Text>
    </Pressable>
    {onPin ? <Pressable accessibilityRole="button" accessibilityLabel="固定或取消固定此对话" accessibilityState={{ selected: pinned, disabled: !pinReady }} disabled={!pinReady} onPress={onPin} style={[styles.action, !pinReady && styles.disabled]}><Ionicons name={pinned ? "bookmark" : "bookmark-outline"} size={21} color={pinned ? colors.gold : colors.muted} /></Pressable> : null}
    <AppearanceControl />
    <Pressable accessibilityRole="button" accessibilityLabel="新建对话" accessibilityState={{ disabled: busy }} disabled={busy} onPress={onNew} style={[styles.action, busy && styles.disabled]}><Ionicons name="create-outline" size={23} color={colors.muted} /></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="返回上一页" onPress={onClose} style={styles.action}><Ionicons name="close" size={22} color={colors.muted} /></Pressable>
  </View>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 10, gap: 4, minHeight: 66, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  menu: { width: 40, minHeight: 44, borderRadius: radius.item, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  copy: { flex: 1, minWidth: 0, gap: 3 },
  titleRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 7, rowGap: 3 },
  name: { ...typography.section, fontSize: 18, lineHeight: 25, color: colors.ink, flexShrink: 1 },
  status: { maxWidth: "100%", borderRadius: radius.pill, backgroundColor: colors.goldSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.strongLine, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: 7, paddingVertical: 1 },
  statusMuted: { backgroundColor: colors.surface, borderColor: colors.line },
  dot: { width: 5, height: 5, borderRadius: radius.pill, backgroundColor: colors.gold, flexShrink: 0 },
  statusText: { ...typography.small, color: colors.gold, flexShrink: 1 },
  subtitle: { ...typography.caption, color: colors.muted },
  action: { width: 40, minHeight: 44, alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.4 },
});
