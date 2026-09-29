import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import type { ModelInfo, ReasoningEffort } from "./api";
import { BottomSheet } from "./BottomSheet";
import { reasoningLabel } from "./ModelPicker";
import { humanError, s } from "./ui";
import { colors, radius, space, typography } from "./theme";

const descriptions: Record<ReasoningEffort, string> = {
  auto: "交给模型决定思考深度", none: "关闭额外思考", low: "轻量思考，快速回应", medium: "兼顾速度与推敲", high: "为复杂问题多想一步", xhigh: "使用当前模型最高思考档位",
};
export function ReasoningPicker({ visible, model, selected, onSelect, onClose }: {
  visible: boolean; model?: ModelInfo; selected: ReasoningEffort | null;
  onSelect: (value: ReasoningEffort | null) => Promise<void>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const depth = selected ?? model?.default_reasoning_effort ?? "auto";
  const levels = model?.reasoning_levels.filter((level) => level !== "auto") ?? [];
  async function choose(value: ReasoningEffort | null) {
    if (busy) return;
    setBusy(true); setError("");
    try { await onSelect(value); onClose(); } catch (e) { setError(humanError(e)); } finally { setBusy(false); }
  }
  return <BottomSheet visible={visible} title="思考深度" subtitle={model?.name} onClose={() => { setError(""); onClose(); }}>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.preview}>
        <View style={styles.bulb}><Ionicons name={depth === "none" ? "bulb-outline" : "bulb"} size={29} color={depth === "none" ? colors.muted : colors.gold} /></View>
        <Text style={s.title}>{reasoningLabel[depth]}</Text><Text style={s.muted}>{descriptions[depth]}</Text>
      </View>
      <View accessibilityRole="radiogroup" style={styles.steps}>
        <View style={styles.track} />
        {levels.map((level) => <Pressable key={level} accessibilityRole="radio" accessibilityLabel={`思考深度${reasoningLabel[level]}`} accessibilityState={{ checked: depth === level, disabled: busy }} disabled={busy} onPress={() => { void choose(level); }} style={styles.step}>
          <View style={[styles.dot, depth === level && styles.selectedDot]}>{depth === level ? <View style={styles.dotCenter} /> : null}</View>
          <Text style={[styles.stepText, depth === level && { color: colors.gold, fontWeight: "700" }]}>{reasoningLabel[level]}</Text>
        </Pressable>)}
      </View>
      <View style={styles.options}>
        <Pressable accessibilityRole="radio" accessibilityState={{ checked: selected === null, disabled: busy }} disabled={busy} onPress={() => { void choose(null); }} style={[styles.option, selected === null && styles.activeOption]}><Ionicons name="return-down-back-outline" size={17} color={colors.muted} /><Text style={s.description}>跟随模型默认</Text>{selected === null ? <Ionicons name="checkmark" size={16} color={colors.gold} /> : null}</Pressable>
        {model?.reasoning_levels.includes("auto") ? <Pressable accessibilityRole="radio" accessibilityState={{ checked: selected === "auto", disabled: busy }} disabled={busy} onPress={() => { void choose("auto"); }} style={[styles.option, selected === "auto" && styles.activeOption]}><Ionicons name="sparkles-outline" size={17} color={colors.gold} /><Text style={s.description}>自动</Text></Pressable> : null}
      </View>
      {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    </ScrollView>
  </BottomSheet>;
}
const styles = StyleSheet.create({
  content: { paddingHorizontal: 22, paddingBottom: 20, gap: space.lg },
  preview: { alignItems: "center", gap: 6, paddingVertical: 8 },
  bulb: { width: 56, height: 56, borderRadius: 20, backgroundColor: colors.goldSoft, alignItems: "center", justifyContent: "center", marginBottom: 2 },
  steps: { flexDirection: "row", paddingTop: 6 },
  track: { position: "absolute", top: 19, left: "10%", right: "10%", height: 3, backgroundColor: "#E2D6BE", borderRadius: 2 },
  step: { flex: 1, alignItems: "center", minHeight: 65, gap: 9 },
  dot: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.paper, borderWidth: 2, borderColor: "#DFD5C4", alignItems: "center", justifyContent: "center" },
  selectedDot: { borderColor: colors.gold, backgroundColor: colors.goldSoft },
  dotCenter: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.gold },
  stepText: { ...typography.caption, color: colors.muted },
  options: { flexDirection: "row", justifyContent: "center", gap: space.sm },
  option: { minHeight: 44, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 6, borderRadius: radius.small },
  activeOption: { backgroundColor: colors.neutral },
});
