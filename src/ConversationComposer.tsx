import type { ThemeColors } from "./theme";
import { useTheme, useThemedStyles } from "./ThemeProvider";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { request, type Connection, type ModelInfo, type ReasoningEffort, type SearchProvider } from "./api";
import { BrandIcon } from "./BrandIcon";
import { thinkingLabel } from "./reasoning";
import { radius, space, typography } from "./theme";
import { BottomSheet } from "./BottomSheet";

type Props = {
  unlimitedText?: boolean;
  text: string; placeholder?: string; onText: (text: string) => void; onSend: () => void; onFiles: () => void;
  onPhotos?: () => void;
  editable: boolean; canSend: boolean; busy: boolean; pending?: boolean; attachmentLocked?: boolean;
  kind: "chat" | "task"; kindLocked?: boolean; onKind: (kind: "chat" | "task") => void;
  connection?: Connection; model?: ModelInfo; depth?: ReasoningEffort; searchId?: string | null;
  optionsLocked?: boolean; onModel?: () => void; onReasoning?: () => void; onSearch?: () => void;
  stopping?: boolean; stopDisabled?: boolean; onStop?: () => void;
  children?: ReactNode; hint?: ReactNode; floating?: ReactNode;
};

export function ConversationComposer(props: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [showAttachments, setShowAttachments] = useState(false);
  const nextAttachment = useRef<(() => void) | null>(null);
  const { text, placeholder, onText, onSend, onFiles, editable, canSend, busy, pending, kind,
    model, depth = "auto", searchId, onModel, onReasoning, onSearch, optionsLocked, children, hint } = props;
  const [providerState, setProvider] = useState<{ connection: Connection; id: string; item: SearchProvider | null } | null>(null);
  const provider = providerState && providerState.connection === props.connection && providerState.id === searchId ? providerState.item : null;
  useEffect(() => {
    if (!props.connection || !searchId) return;
    const controller = new AbortController();
    void request<{ items: SearchProvider[] }>(props.connection, "/search/providers", { signal: controller.signal })
      .then((page) => { if (!controller.signal.aborted) setProvider({ connection: props.connection!, id: searchId, item: page.items.find((item) => item.id === searchId) ?? null }); }).catch(() => undefined);
    return () => controller.abort();
  }, [props.connection, searchId]);
  const canReason = !!model?.reasoning_levels.length;
  const reasoningText = canReason ? thinkingLabel(model, depth) : "不可调整";
  const reasoningColor = !canReason || depth === "none" ? colors.strongLine : depth === "auto" ? colors.gold : colors.green;
  const searchText = searchId ? `搜索 · ${provider?.name ?? "已开启"}` : "联网搜索";
  return <View style={[styles.area, !!props.floating && styles.areaFloating]}>
    <View style={[styles.optionsAnchor, !!props.floating && styles.optionsFloating]}>
    {props.floating ? <View pointerEvents="box-none" style={styles.floating}>{props.floating}</View> : null}
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={styles.optionsViewport} contentContainerStyle={styles.options}>
      {onModel ? <Pressable accessibilityRole="button" accessibilityLabel={`选择${kind === "task" ? "任务" : "聊天"}模型，当前${model?.name ?? "未配置"}`} accessibilityState={{ disabled: optionsLocked }} disabled={optionsLocked} onPress={onModel} style={[styles.chip, optionsLocked && styles.disabled]}><View style={[styles.chipSurface, styles.modelChip]}>
        <BrandIcon name={model ? `${model.model} ${model.provider}` : ""} size={17} /><Text numberOfLines={1} style={styles.chipText}>{model?.name ?? "选择模型"}</Text><Ionicons name="chevron-down" size={12} color={colors.muted} />
      </View></Pressable> : null}
      {onReasoning ? <Pressable accessibilityRole="button" accessibilityLabel={`思考深度，当前${reasoningText}`} accessibilityState={{ disabled: optionsLocked || !canReason }} disabled={optionsLocked || !canReason} onPress={onReasoning} style={[styles.chip, (optionsLocked || !canReason) && styles.disabled]}><View style={styles.chipSurface}>
        <Ionicons name="bulb-outline" size={17} color={canReason && depth !== "none" ? colors.gold : colors.muted} /><Text numberOfLines={1} style={styles.chipText}>思考 · {reasoningText}</Text><View accessible={false} style={[styles.statusDot, { backgroundColor: reasoningColor }]} />
      </View></Pressable> : null}
      {onSearch ? <Pressable accessibilityRole="button" accessibilityLabel={`联网搜索${searchId ? `已开启${provider ? `，${provider.name}` : ""}` : "已关闭"}`} accessibilityState={{ selected: !!searchId, disabled: optionsLocked }} disabled={optionsLocked} onPress={onSearch} style={[styles.chip, optionsLocked && styles.disabled]}><View style={[styles.chipSurface, searchId && styles.searchOn]}>
        {searchId ? <BrandIcon name={provider?.kind ?? ""} search size={17} /> : <Ionicons name="globe-outline" size={17} color={colors.muted} />}
        <Text numberOfLines={1} style={[styles.chipText, searchId && { color: colors.blue }]}>{searchText}</Text>
      </View></Pressable> : null}
    </ScrollView>
    </View>
    <View style={styles.composer}>
      {children ? <View style={styles.attachments}>{children}</View> : null}
      <View style={styles.inputRow}>
        <Pressable accessibilityRole="button" accessibilityLabel="添加资料" accessibilityState={{ disabled: props.attachmentLocked }} disabled={props.attachmentLocked} onPress={() => { if (props.onPhotos) setShowAttachments(true); else onFiles(); }} style={[styles.files, props.attachmentLocked && styles.disabled]}><Ionicons name="add" size={26} color={colors.ink} /></Pressable>
        <TextInput accessibilityLabel="消息" multiline maxLength={props.unlimitedText ? undefined : 20000} placeholder={placeholder ?? "说说你的想法…"} placeholderTextColor={colors.muted} value={text} editable={editable} onChangeText={onText} style={styles.input} />
        <Pressable accessibilityRole="button" accessibilityLabel={props.stopping ? props.stopDisabled ? "正在停止回复" : "停止回复" : pending ? "重试发送" : "发送消息"} accessibilityState={{ disabled: props.stopping ? props.stopDisabled || busy : !canSend }} disabled={props.stopping ? props.stopDisabled || busy : !canSend} onPress={props.stopping ? props.onStop : onSend} style={[styles.send, (props.stopping ? props.stopDisabled : !canSend) && styles.sendDisabled]}>{busy ? <ActivityIndicator size="small" color={colors.onInk} /> : <Ionicons name={props.stopping ? "stop" : pending ? "refresh" : "arrow-up"} size={25} color={colors.onInk} />}</Pressable>
      </View>
      {hint ? <View style={styles.hint}>{hint}</View> : null}
    </View>
    <BottomSheet visible={showAttachments} title="添加到消息" onClose={() => setShowAttachments(false)} onDismiss={() => {
      const next = nextAttachment.current; nextAttachment.current = null; next?.();
    }}>
      <View style={styles.addOptions}>
        {props.onPhotos ? <Pressable accessibilityRole="button" accessibilityLabel="选择照片" style={styles.addOption} onPress={() => { nextAttachment.current = props.onPhotos!; setShowAttachments(false); }}>
          <Ionicons name="images-outline" size={28} color={colors.ink} /><Text style={styles.addLabel}>照片</Text>
        </Pressable> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="选择文件" style={styles.addOption} onPress={() => { nextAttachment.current = onFiles; setShowAttachments(false); }}>
          <Ionicons name="document-attach-outline" size={28} color={colors.ink} /><Text style={styles.addLabel}>文件</Text>
        </Pressable>
      </View>
    </BottomSheet>
  </View>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  area: { paddingHorizontal: space.lg, paddingBottom: space.sm, paddingTop: space.sm, gap: space.sm },
  // Keep every native parent's touch bounds around the floating strip. The negative
  // margin offsets its padding, so the model row and input keep their usual position.
  areaFloating: { marginTop: -50 },
  optionsAnchor: { position: "relative", zIndex: 1 },
  optionsFloating: { paddingTop: 50 },
  floating: { position: "absolute", left: 0, right: 0, top: 0, paddingBottom: 6, zIndex: 2 },
  optionsViewport: { flexGrow: 0, flexShrink: 0 },
  options: { flexDirection: "row", flexWrap: "nowrap", alignItems: "center", gap: space.sm },
  chip: { minHeight: 44, minWidth: 40, flexShrink: 0, justifyContent: "center" },
  chipSurface: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 30, minWidth: 0, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, paddingHorizontal: 8, paddingVertical: 5 },
  modelChip: { backgroundColor: colors.goldSoft, borderColor: colors.strongLine },
  chipText: { ...typography.caption, color: colors.ink, flexShrink: 0 },
  statusDot: { width: 6, height: 6, borderRadius: 3, flexShrink: 0 },
  searchOn: { backgroundColor: colors.blueSoft, borderColor: colors.blueLine },
  composer: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.gold, borderRadius: 24, padding: 6, shadowColor: colors.gold, shadowOpacity: 0.09, shadowRadius: 12, shadowOffset: { width: 0, height: 2 } },
  inputRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  input: { ...typography.reading, fontSize: 16, color: colors.ink, minHeight: 54, maxHeight: 140, paddingHorizontal: 5, paddingTop: 13, paddingBottom: 8, textAlignVertical: "top", flex: 1, minWidth: 0 },
  files: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.item, backgroundColor: colors.surfaceRaised },
  send: { width: 46, height: 46, alignItems: "center", justifyContent: "center", borderRadius: radius.item, backgroundColor: colors.gold },
  sendDisabled: { opacity: 0.42 },
  attachments: { paddingHorizontal: space.xs, paddingTop: space.xs },
  hint: { paddingHorizontal: space.sm, paddingBottom: space.xs },
  disabled: { opacity: 0.4 },
  addOptions: { flexDirection: "row", gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.lg },
  addOption: { flex: 1, minHeight: 88, borderRadius: radius.item, backgroundColor: colors.surfaceRaised, alignItems: "center", justifyContent: "center", gap: space.sm },
  addLabel: { ...typography.body, color: colors.ink },
});
