import { useRef, useState } from "react";
import { BottomSheet } from "./BottomSheet";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { AppearanceControl } from "./AppearanceControl";
import { useThemedStyles } from "./ThemeProvider";
import { radius, space, typography, type ThemeColors } from "./theme";
import { ActionLink, useUi } from "./ui";

/** All agents share this chrome; identity and navigation remain caller-owned. */
export function AgentChatHeader({ title, subtitle, status, pinned = false, pinReady = true, busy = false, onMenu, onNew, onClose, onPin, onSettings }: {
  title: string; subtitle: string; status?: string; pinned?: boolean; pinReady?: boolean; busy?: boolean;
  onMenu: () => void; onNew: () => void; onClose: () => void; onPin?: () => void; onSettings?: () => void;
}) {
  const { s, colors } = useUi();
  const [menu, setMenu] = useState(false);
  const afterMenu = useRef<(() => void) | null>(null);
  const styles = useThemedStyles(createStyles);
  return <View style={styles.header}>
    <Pressable accessibilityRole="button" accessibilityLabel="打开对话侧边栏" onPress={onMenu} style={styles.menu}>
      <Ionicons name="menu-outline" size={22} color={colors.ink} />
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel={`${title}，${subtitle}，打开对话侧边栏`} onPress={onMenu} style={styles.copy}>
      <View style={styles.titleRow}>
        <Text accessibilityRole="header" numberOfLines={1} style={styles.name}>{status ? title : subtitle || title}</Text>
        {status ? <View style={[styles.status, status !== "待命中" && styles.statusMuted]}><View accessible={false} style={[styles.dot, status !== "待命中" && { backgroundColor: colors.muted }]} /><Text numberOfLines={1} style={[styles.statusText, status !== "待命中" && { color: colors.muted }]}>{status}</Text></View> : null}
      </View>
      <Text numberOfLines={1} style={styles.subtitle}>{status ? subtitle : title}</Text>
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="新建对话" accessibilityState={{ disabled: busy }} disabled={busy} onPress={onNew} style={[styles.action, busy && styles.disabled]}><Ionicons name="create-outline" size={23} color={colors.ink} /></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="对话菜单" onPress={() => setMenu(true)} style={styles.action}><Ionicons name="ellipsis-horizontal" size={22} color={colors.ink} /></Pressable>
    <BottomSheet visible={menu} title="对话" onClose={() => setMenu(false)} onDismiss={() => { const next = afterMenu.current; afterMenu.current = null; next?.(); }}>
      <View style={s.content}>
        {onSettings ? <ActionLink icon="options-outline" onPress={() => { afterMenu.current = onSettings; setMenu(false); }}>对话设置</ActionLink> : null}
        {onPin ? <ActionLink icon="bookmark-outline" disabled={!pinReady} onPress={() => { onPin(); setMenu(false); }}>{pinned ? "取消固定" : "固定对话"}</ActionLink> : null}
        <View style={s.row}><AppearanceControl /><Text style={s.description}>外观</Text></View>
        <ActionLink icon="arrow-back-outline" onPress={() => { afterMenu.current = onClose; setMenu(false); }}>返回上一页</ActionLink>
      </View>
    </BottomSheet>
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
