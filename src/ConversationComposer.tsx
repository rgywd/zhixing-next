import type { ThemeColors } from "./theme";
import { useTheme, useThemedStyles } from "./ThemeProvider";
import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { request, type Connection, type ModelInfo, type ReasoningEffort, type SearchProvider } from "./api";
import { BrandIcon } from "./BrandIcon";
import { reasoningLabel } from "./ModelPicker";
import { radius, space, typography } from "./theme";

type Props = {
  text: string; placeholder?: string; onText: (text: string) => void; onSend: () => void; onFiles: () => void;
  editable: boolean; canSend: boolean; busy: boolean; pending?: boolean; attachmentLocked?: boolean;
  kind: "chat" | "task"; kindLocked?: boolean; onKind: (kind: "chat" | "task") => void;
  connection?: Connection; model?: ModelInfo; depth?: ReasoningEffort; searchId?: string | null;
  optionsLocked?: boolean; onModel?: () => void; onReasoning?: () => void; onSearch?: () => void;
  children?: ReactNode; hint?: ReactNode;
};

export function ConversationComposer(props: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { text, placeholder, onText, onSend, onFiles, editable, canSend, busy, pending, kind, onKind,
    model, depth = "auto", searchId, onModel, onReasoning, onSearch, optionsLocked, children, hint } = props;
  const [provider, setProvider] = useState<SearchProvider | null>(null);
  useEffect(() => {
    if (!props.connection || !searchId) return;
    const controller = new AbortController();
    void request<{ items: SearchProvider[] }>(props.connection, "/search/providers", { signal: controller.signal })
      .then((page) => { if (!controller.signal.aborted) setProvider(page.items.find((item) => item.id === searchId) ?? null); }).catch(() => undefined);
    return () => controller.abort();
  }, [props.connection, searchId]);
  return <View style={styles.area}>
    <View style={styles.composer}>
      {children}
      <TextInput accessibilityLabel="消息或任务要求" multiline maxLength={20000} placeholder={placeholder ?? (kind === "task" ? "交给知行完成…" : "说说你的想法…")} placeholderTextColor={colors.muted} value={text} editable={editable} onChangeText={onText} style={styles.input} />
      {hint}
      <View style={styles.toolbar}>
        <View style={styles.choices}>
          {onModel ? <Pressable accessibilityRole="button" accessibilityLabel={`选择${kind === "task" ? "任务" : "聊天"}模型，当前${model?.name ?? "未配置"}`} disabled={optionsLocked} accessibilityState={{ disabled: optionsLocked }} onPress={onModel} style={[styles.tool, optionsLocked && styles.disabled]}><BrandIcon name={model ? `${model.model} ${model.provider}` : ""} /><Ionicons name="chevron-down" size={10} color={colors.muted} /></Pressable> : null}
          {onSearch ? <Pressable accessibilityRole="button" accessibilityLabel={`联网搜索${searchId ? `已开启${provider?.id === searchId ? `，${provider.name}` : ""}` : "已关闭"}`} accessibilityState={{ selected: !!searchId, disabled: optionsLocked }} disabled={optionsLocked} onPress={onSearch} style={[styles.tool, !!searchId && styles.searchOn, optionsLocked && styles.disabled]}>
            {searchId ? <BrandIcon name={provider?.id === searchId ? provider.kind : ""} search size={22} /> : <Ionicons name="globe-outline" size={22} color={colors.muted} />}
            {searchId ? <View style={styles.statusDot} /> : null}
          </Pressable> : null}
          {onReasoning ? <Pressable accessibilityRole="button" accessibilityLabel={`思考深度，当前${model?.reasoning_levels.length ? reasoningLabel[depth] : "不可调整"}`} accessibilityState={{ disabled: optionsLocked || !model?.reasoning_levels.length }} disabled={optionsLocked || !model?.reasoning_levels.length} onPress={onReasoning} style={[styles.tool, styles.depth, depth !== "none" && styles.reasoningOn, (optionsLocked || !model?.reasoning_levels.length) && styles.disabled]}>
            <Ionicons name={depth === "none" ? "bulb-outline" : "bulb"} size={21} color={depth === "none" ? colors.muted : colors.gold} /><Text style={[styles.depthLabel, depth !== "none" && { color: colors.gold }]}>{model?.reasoning_levels.length ? reasoningLabel[depth] : "—"}</Text>
          </Pressable> : null}
          <Pressable accessibilityRole="button" accessibilityLabel={kind === "chat" ? "当前聊天，切换为任务" : "当前任务，切换为聊天"} accessibilityState={{ selected: kind === "task", disabled: !!pending || busy || props.kindLocked }} disabled={!!pending || busy || props.kindLocked} onPress={() => onKind(kind === "chat" ? "task" : "chat")} style={[styles.tool, kind === "task" && styles.taskOn, (pending || busy || props.kindLocked) && styles.disabled]}><Ionicons name={kind === "task" ? "flash" : "chatbubble-outline"} size={21} color={kind === "task" ? colors.blue : colors.muted} /></Pressable>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="添加资料" accessibilityState={{ disabled: props.attachmentLocked }} disabled={props.attachmentLocked} onPress={onFiles} style={[styles.tool, props.attachmentLocked && styles.disabled]}><Ionicons name="add" size={25} color={colors.ink} /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={pending ? "重试发送" : "发送消息"} accessibilityState={{ disabled: !canSend }} disabled={!canSend} onPress={onSend} style={[styles.send, !canSend && styles.sendDisabled]}>{busy ? <ActivityIndicator size="small" color={colors.onInk} /> : <Ionicons name={pending ? "refresh" : "arrow-up"} size={23} color={canSend ? colors.onInk : colors.muted} />}</Pressable>
      </View>
    </View>
  </View>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  area: { paddingHorizontal: 12, paddingBottom: 8, paddingTop: 6 },
  composer: { backgroundColor: colors.surface, borderRadius: 22, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 8, paddingBottom: 6, shadowColor: colors.shadow, shadowOpacity: 0.035, shadowRadius: 12, shadowOffset: { width: 0, height: 3 } },
  input: { ...typography.reading, fontSize: 16, color: colors.ink, minHeight: 54, maxHeight: 140, paddingHorizontal: 7, paddingTop: 13, paddingBottom: 8, textAlignVertical: "top" },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 2 },
  choices: { flex: 1, flexDirection: "row", alignItems: "center", gap: 2 },
  tool: { minWidth: 40, minHeight: 44, flexDirection: "row", gap: 2, alignItems: "center", justifyContent: "center", borderRadius: radius.small },
  depth: { paddingHorizontal: 5, gap: 3 },
  depthLabel: { ...typography.small, color: colors.muted },
  searchOn: { backgroundColor: colors.blueSoft },
  reasoningOn: { backgroundColor: colors.goldSoft },
  taskOn: { backgroundColor: colors.blueSoft },
  statusDot: { position: "absolute", width: 4, height: 4, borderRadius: 2, right: 5, top: 7, backgroundColor: colors.blue },
  send: { width: 40, height: 40, marginLeft: space.xs, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: colors.ink },
  sendDisabled: { backgroundColor: colors.neutral },
  disabled: { opacity: 0.4 },
});
