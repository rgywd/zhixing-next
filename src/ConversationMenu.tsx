import { useEffect, useRef, useState } from "react";
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { useTheme, useThemedStyles } from "./ThemeProvider";
import { humanError } from "./ui";
import { layout, radius, space, typography, type ThemeColors } from "./theme";

/** Inline menu, mounted at the chat root so its touch area is not clipped by the header. */
export function ConversationMenu({ title, top, existing, onClose, onRename, onShare, onSearch, onDelete }: {
  title: string; top: number; existing: boolean; onClose: () => void;
  onRename: (title: string) => Promise<void>; onShare: () => void; onSearch: () => void; onDelete: () => Promise<void>;
}) {
  const { colors, mode, preference, setPreference, error: themeError } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { width } = useWindowDimensions();
  const [view, setView] = useState<"menu" | "theme" | "rename" | "delete">("menu");
  const [name, setName] = useState(title);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  useEffect(() => {
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!working.current) { if (view === "menu") onClose(); else { setView("menu"); setError(""); } }
      return true;
    });
    return () => listener.remove();
  }, [onClose, view]);
  async function save(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError("");
    try { await action(); onClose(); }
    catch (e) { setError(humanError(e)); }
    finally { working.current = false; setBusy(false); }
  }
  return <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
    <Pressable accessibilityRole="button" accessibilityLabel="关闭对话菜单" style={StyleSheet.absoluteFill} onPress={() => { if (!working.current) onClose(); }} />
    <View accessibilityViewIsModal style={[styles.box, { top, width: Math.min(240, width - space.xl) }]}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        {view === "menu" ? <>
          <Pressable accessibilityRole="button" accessibilityLabel="修改对话名称" disabled={!existing} accessibilityState={{ disabled: !existing }}
            onPress={() => { setName(title); setView("rename"); }} style={({ pressed }) => [styles.nameRow, pressed && styles.pressed]}>
            <Text numberOfLines={2} style={styles.name}>{title}</Text><Ionicons name="create-outline" size={16} color={colors.muted} />
          </Pressable>
          <MenuRow label="分享" icon="share-social-outline" onPress={() => { onClose(); onShare(); }} disabled={!existing} />
          <MenuRow label="在聊天中查找" icon="search-outline" onPress={() => { onClose(); onSearch(); }} disabled={!existing} />
          <MenuRow label={`主题：${mode === "dark" ? "夜间" : "白天"}`} icon={mode === "dark" ? "moon-outline" : "sunny-outline"} onPress={() => setView("theme")} />
          <View style={styles.line} />
          <MenuRow label="删除" icon="trash-outline" onPress={() => setView("delete")} disabled={!existing} danger />
        </> : view === "theme" ? <>
          <MenuRow label="主题" icon="chevron-back" onPress={() => setView("menu")} />
          {([{ value: "system", label: "跟随系统" }, { value: "light", label: "白天" }, { value: "dark", label: "夜间" }] as const).map(item =>
            <Pressable key={item.value} accessibilityRole="radio" accessibilityLabel={item.label} accessibilityState={{ checked: preference === item.value }}
              onPress={() => setPreference(item.value)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
              <Ionicons name={preference === item.value ? "checkmark" : "ellipse-outline"} size={18} color={preference === item.value ? colors.gold : colors.muted} /><Text style={styles.label}>{item.label}</Text>
            </Pressable>)}
          {themeError ? <Text accessibilityRole="alert" style={styles.error}>{themeError}</Text> : null}
        </> : <>
          <MenuRow label={view === "rename" ? "对话名称" : "删除对话"} icon="chevron-back" disabled={busy} onPress={() => { setView("menu"); setError(""); }} />
          {view === "rename" ? <TextInput accessibilityLabel="对话名称" value={name} onChangeText={setName} autoFocus editable={!busy}
            style={styles.input} placeholder="填写对话名称" placeholderTextColor={colors.muted} returnKeyType="done" onSubmitEditing={() => { if (name.trim()) void save(() => onRename(name.trim())); }} />
            : <Text style={styles.description}>删除后将从知行中移除这段对话，已生成的工作区文件会保留。</Text>}
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <MenuRow label={busy ? view === "delete" ? "正在删除…" : "正在保存…" : view === "rename" ? "保存名称" : "确认删除"} icon={view === "rename" ? "checkmark" : "trash-outline"}
            onPress={() => { void save(view === "rename" ? () => onRename(name.trim()) : onDelete); }} disabled={busy || (view === "rename" && !name.trim())} danger={view === "delete"} />
        </>}
      </ScrollView>
    </View>
  </View>;
}

function MenuRow({ label, icon, onPress, disabled = false, danger = false }: {
  label: string; icon: React.ComponentProps<typeof Ionicons>["name"]; onPress: () => void; disabled?: boolean; danger?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} accessibilityState={{ disabled }} onPress={onPress}
    style={({ pressed }) => [styles.row, pressed && styles.pressed, disabled && styles.disabled]}>
    <Ionicons name={icon} size={18} color={danger ? colors.red : colors.ink} /><Text style={[styles.label, danger && { color: colors.red }]}>{label}</Text>
  </Pressable>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  box: { position: "absolute", right: space.md, maxHeight: "85%", borderRadius: radius.control, backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, shadowColor: colors.shadow, shadowOpacity: 0.14, shadowRadius: 16, shadowOffset: { width: 0, height: 4 }, elevation: 9 },
  content: { padding: space.xs },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: layout.touchTarget, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.small },
  label: { ...typography.body, fontSize: 14, color: colors.ink, flex: 1 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: layout.touchTarget, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.small },
  name: { ...typography.caption, fontSize: 12, color: colors.muted, flex: 1 },
  line: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginHorizontal: space.sm, marginVertical: space.xs },
  input: { ...typography.body, color: colors.ink, minHeight: layout.touchTarget, borderWidth: 1, borderColor: colors.line, borderRadius: radius.small, paddingHorizontal: space.sm, marginHorizontal: space.sm },
  description: { ...typography.body, color: colors.muted, padding: space.md },
  error: { ...typography.detail, color: colors.red, paddingHorizontal: space.md, paddingVertical: space.sm },
  pressed: { backgroundColor: colors.neutral }, disabled: { opacity: 0.4 },
});
