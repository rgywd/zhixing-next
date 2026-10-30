import { useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { BottomSheet } from "./BottomSheet";
import { permissionChoices, permissionPresentation, type DshPermission, type DshPermissions } from "./dshPermissions";
import { useThemedStyles } from "./ThemeProvider";
import { radius, space, type ThemeColors } from "./theme";
import { humanError, useUi } from "./ui";

export function PermissionPicker({ visible, permissions, onSelect, onClose }: {
  visible: boolean; permissions?: DshPermissions | null;
  onSelect: (value: DshPermission) => Promise<void>; onClose: () => void;
}) {
  const { s, colors } = useUi();
  const styles = useThemedStyles(createStyles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const working = useRef(false);
  async function choose(value: DshPermission) {
    if (working.current || !permissions?.options.includes(value)) return;
    if (permissions.current === value) { onClose(); return; }
    working.current = true; setBusy(true); setError("");
    try { await onSelect(value); onClose(); }
    catch (e) { setError(humanError(e)); }
    finally { working.current = false; setBusy(false); }
  }
  return <BottomSheet visible={visible} title="权限管理" subtitle={`当前：${permissionPresentation(permissions?.current).label}`}
    onClose={() => { if (!working.current) { setError(""); onClose(); } }}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <View accessibilityRole="radiogroup" style={styles.options}>
        {permissionChoices.map(choice => {
          const selected = permissions?.current === choice.value;
          const available = !!permissions?.options.includes(choice.value);
          const color = choice.value === "danger-full-access" ? colors.red : colors.ink;
          return <Pressable key={choice.value} accessibilityRole="radio" accessibilityLabel={choice.label}
            accessibilityState={{ checked: selected, disabled: busy || !available }} disabled={busy || !available}
            onPress={() => { void choose(choice.value); }} style={[styles.option, selected && styles.selected, !available && styles.disabled]}>
            <Ionicons name={choice.icon} size={23} color={color} />
            <View style={styles.copy}><Text style={s.text}>{choice.label}</Text><Text style={s.description}>{available ? choice.description : "当前服务未提供此模式"}</Text></View>
            {selected ? <Ionicons name="checkmark" size={20} color={colors.gold} /> : null}
          </Pressable>;
        })}
      </View>
      {busy ? <Text style={s.muted}>正在保存权限…</Text> : null}
      {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    </ScrollView>
  </BottomSheet>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.md },
  options: { gap: space.sm },
  option: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, minHeight: 64, borderRadius: radius.item },
  selected: { backgroundColor: colors.neutral },
  copy: { flex: 1, minWidth: 0, gap: space.xs },
  disabled: { opacity: 0.4 },
});
