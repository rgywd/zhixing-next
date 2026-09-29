import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { BottomSheet } from "./BottomSheet";
import { useTheme, useThemedStyles } from "./ThemeProvider";
import { darkColors, lightColors, radius, space, typography, type ThemeColors, type ThemePreference } from "./theme";

const options = [
  { value: "system", label: "跟随系统", icon: "phone-portrait-outline" },
  { value: "light", label: "白天", icon: "sunny-outline" },
  { value: "dark", label: "夜间", icon: "moon-outline" },
] as const;

export function AppearanceControl({ row = false }: { row?: boolean }) {
  const { colors, mode, preference, setPreference, error } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [visible, setVisible] = useState(false);
  const label = options.find((item) => item.value === preference)!.label;
  function choose(value: ThemePreference) { setPreference(value); }
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={`外观，当前${label}`} onPress={() => setVisible(true)} style={({ pressed }) => [row ? styles.row : styles.trigger, pressed && styles.pressed]}>
      <Ionicons name={mode === "dark" ? "moon-outline" : "sunny-outline"} size={21} color={colors.khaki} />
      {row ? <><Text style={styles.rowTitle}>外观</Text><Text style={styles.caption}>{label}</Text><Ionicons name="chevron-forward" size={17} color={colors.muted} /></> : null}
    </Pressable>
    <BottomSheet visible={visible} title="外观" subtitle="为白天与夜晚，换一种舒服的颜色" onClose={() => setVisible(false)}>
      <ScrollView contentContainerStyle={styles.content}>
        <View accessibilityRole="radiogroup" style={styles.choices}>
          {options.map((item) => {
            const selected = preference === item.value;
            const preview = item.value === "dark" ? darkColors : lightColors;
            return <Pressable key={item.value} accessibilityRole="radio" accessibilityLabel={item.label} accessibilityState={{ checked: selected }} onPress={() => choose(item.value)} style={({ pressed }) => [styles.choice, selected && styles.selected, pressed && styles.pressed]}>
              <View style={[styles.preview, { backgroundColor: item.value === "system" ? colors.neutral : preview.paper, borderColor: item.value === "system" ? colors.line : preview.line }]}>
                <Ionicons name={item.icon} size={22} color={item.value === "system" ? colors.ink : preview.ink} />
                <View style={styles.swatches}>{(item.value === "system" ? [lightColors.primary, darkColors.gold, colors.blue] : [preview.accent, preview.gold, preview.blue]).map((color, index) => <View key={index} style={[styles.swatch, { backgroundColor: color }]} />)}</View>
              </View>
              <Text style={[styles.label, selected && { color: colors.accent }]}>{item.label}</Text>
              <Ionicons name={selected ? "checkmark-circle" : "ellipse-outline"} size={19} color={selected ? colors.accent : colors.strongLine} />
            </Pressable>;
          })}
        </View>
        <Text style={styles.caption}>{preference === "system" ? "随设备外观自动切换。" : mode === "dark" ? "近黑与炭灰，点缀暗金和卡其。" : "白色与朱红，金色点缀，冷蓝辅助。"}</Text>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      </ScrollView>
    </BottomSheet>
  </>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  trigger: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.pill },
  row: { flexDirection: "row", gap: space.md, alignItems: "center", minHeight: 54, paddingHorizontal: 3 },
  rowTitle: { flex: 1, ...typography.item, color: colors.ink },
  content: { paddingHorizontal: 20, paddingBottom: 16, gap: 16 },
  choices: { flexDirection: "row", gap: 10 },
  choice: { flex: 1, minWidth: 0, padding: 8, paddingBottom: 12, gap: 10, alignItems: "center", borderRadius: radius.item, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  selected: { borderColor: colors.accent, backgroundColor: colors.pale },
  preview: { height: 72, width: "100%", borderRadius: radius.small, borderWidth: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  swatches: { flexDirection: "row", gap: 5 },
  swatch: { width: 8, height: 8, borderRadius: 4 },
  label: { ...typography.detail, fontWeight: "600", color: colors.ink, textAlign: "center" },
  caption: { ...typography.caption, color: colors.muted },
  error: { ...typography.detail, color: colors.red },
  pressed: { opacity: 0.7 },
});
