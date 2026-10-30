import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { useThemedStyles } from "./ThemeProvider";
import { radius, space, typography, type ThemeColors } from "./theme";
import { useUi } from "./ui";

/** All agents share this chrome; identity and navigation remain caller-owned. */
export function AgentChatHeader({ title, subtitle, modelName, status, busy = false, onMenu, onNew, onOptions, menuOpen, onLayout }: {
  modelName?: string;
  title: string; subtitle: string; status?: string; busy?: boolean;
  onMenu: () => void; onNew: () => void;
  onOptions: () => void; menuOpen?: boolean; onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const { colors } = useUi();
  const styles = useThemedStyles(createStyles);
  return <View style={styles.header} onLayout={onLayout}>
    <Pressable accessibilityRole="button" accessibilityLabel="打开对话侧边栏" onPress={onMenu} style={styles.menu}>
      <Ionicons name="menu-outline" size={22} color={colors.ink} />
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel={`${modelName ? `当前模型${modelName}，` : ""}${title}，${subtitle}，打开对话侧边栏`} onPress={onMenu} style={styles.copy}>
      <View style={styles.titleRow}>
        <Text accessibilityRole="header" numberOfLines={1} style={styles.name}>{status ? title : subtitle || title}</Text>
        {status ? <View style={[styles.status, status !== "待命中" && styles.statusMuted]}><View accessible={false} style={[styles.dot, status !== "待命中" && { backgroundColor: colors.muted }]} /><Text numberOfLines={1} style={[styles.statusText, status !== "待命中" && { color: colors.muted }]}>{status}</Text></View> : null}
      </View>
      <Text numberOfLines={1} style={styles.subtitle}>{modelName ? `${title}：${modelName}` : status ? subtitle : title}</Text>
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="新建对话" accessibilityState={{ disabled: busy }} disabled={busy} onPress={onNew} style={[styles.action, busy && styles.disabled]}><Ionicons name="create-outline" size={23} color={colors.ink} /></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="对话菜单" accessibilityState={{ expanded: !!menuOpen }} onPress={onOptions} style={styles.action}><Ionicons name="ellipsis-horizontal" size={22} color={colors.ink} /></Pressable>
  </View>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, gap: 8, minHeight: 64, backgroundColor: colors.paper },
  menu: { width: 40, minHeight: 44, borderRadius: radius.item, alignItems: "center", justifyContent: "center" },
  copy: { flex: 1, minWidth: 0, gap: 3 },
  titleRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 7, rowGap: 3 },
  name: { ...typography.section, fontSize: 17, lineHeight: 23, color: colors.ink, flexShrink: 1 },
  status: { maxWidth: "100%", borderRadius: radius.pill, backgroundColor: colors.goldSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.strongLine, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: 7, paddingVertical: 1 },
  statusMuted: { backgroundColor: colors.surface, borderColor: colors.line },
  dot: { width: 5, height: 5, borderRadius: radius.pill, backgroundColor: colors.gold, flexShrink: 0 },
  statusText: { ...typography.small, color: colors.gold, flexShrink: 1 },
  subtitle: { ...typography.caption, color: colors.muted },
  action: { width: 40, minHeight: 44, alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.4 },
});
