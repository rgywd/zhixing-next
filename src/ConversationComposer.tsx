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
import { ChatTextEditor, type TextSelection } from "./ChatTextEditor";

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
  editing?: { id: string; label: string; onCancel: () => void; locked?: boolean };
};

export function ConversationComposer(props: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [showAttachments, setShowAttachments] = useState(false);
  const [expanded, setExpanded] = useState<TextSelection | null>(null);
  const input = useRef<TextInput>(null);
  const selection = useRef<TextSelection>({ start: props.text.length, end: props.text.length });
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
  useEffect(() => {
    if (props.editing?.id) { const timer = setTimeout(() => input.current?.focus(), 120); return () => clearTimeout(timer); }
  }, [props.editing?.id]);
  return <View style={[styles.area, !!props.floating && styles.areaFloating]}>
    {props.floating ? <View style={styles.floating}>{props.floating}</View> : null}
    <View style={styles.composer}>
      {props.editing ? <View style={styles.editBanner}>
        <Ionicons name="create-outline" size={17} color={colors.ink} />
        <Text style={[styles.chipText, { flex: 1 }]}>{props.editing.label}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="取消编辑" disabled={busy} onPress={props.editing.onCancel} style={styles.smallAction}>
          <Ionicons name="close" size={20} color={colors.muted} />
        </Pressable>
      </View> : null}
      {children ? <View style={styles.attachments}>{children}</View> : null}
      <TextInput ref={input} accessibilityLabel={props.editing ? "编辑原消息" : "消息"} multiline maxLength={props.unlimitedText ? undefined : 20000}
        placeholder={placeholder ?? "和知行聊聊…"} placeholderTextColor={colors.muted} value={text} editable={editable && !expanded}
        onChangeText={onText} onSelectionChange={e => { selection.current = e.nativeEvent.selection; }} style={styles.input} />
      <View style={styles.toolbar}>
        <Pressable accessibilityRole="button" accessibilityLabel="添加资料" accessibilityState={{ disabled: props.attachmentLocked }} disabled={props.attachmentLocked}
          onPress={() => { if (props.onPhotos) setShowAttachments(true); else onFiles(); }} style={[styles.smallAction, props.attachmentLocked && styles.disabled]}>
          <Ionicons name="add" size={25} color={colors.ink} />
        </Pressable>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={styles.optionsViewport} contentContainerStyle={styles.options}>
          {onModel ? <Pressable accessibilityRole="button" accessibilityLabel={`选择${kind === "task" ? "任务" : "聊天"}模型，当前${model?.name ?? "未配置"}`}
            disabled={optionsLocked} onPress={onModel} style={[styles.chip, optionsLocked && styles.disabled]}>
            <BrandIcon name={model ? `${model.model} ${model.provider}` : ""} size={17} />
            <Text numberOfLines={1} style={[styles.chipText, { maxWidth: 120 }]}>{model?.name ?? "选择模型"}</Text>
            <Ionicons name="chevron-down" size={12} color={colors.muted} />
          </Pressable> : null}
          {onReasoning && canReason ? <Pressable accessibilityRole="button" accessibilityLabel={`思考深度，当前${reasoningText}`} disabled={optionsLocked}
            onPress={onReasoning} style={[styles.smallAction, optionsLocked && styles.disabled]}>
            <Ionicons name="bulb-outline" size={20} color={depth === "none" ? colors.muted : colors.gold} />
          </Pressable> : null}
          {onSearch ? <Pressable accessibilityRole="button" accessibilityLabel={`联网搜索${searchId ? `已开启${provider ? `，${provider.name}` : ""}` : "已关闭"}`}
            accessibilityState={{ selected: !!searchId }} disabled={optionsLocked} onPress={onSearch} style={styles.smallAction}>
            <Ionicons name="globe-outline" size={20} color={searchId ? colors.blue : colors.muted} />
          </Pressable> : null}
        </ScrollView>
        {text.length > 80 || text.includes("\n") ? <Pressable accessibilityRole="button" accessibilityLabel="展开编辑消息" disabled={!editable}
          onPress={() => setExpanded({ start: Math.min(selection.current.start, text.length), end: Math.min(selection.current.end, text.length) })} style={styles.smallAction}>
          <Ionicons name="expand-outline" size={18} color={colors.muted} />
        </Pressable> : null}
        <Pressable accessibilityRole="button" accessibilityLabel={props.stopping ? props.stopDisabled ? "正在停止回复" : "停止回复" : pending ? "重试发送" : props.editing ? "发送修改并重新回答" : "发送消息"}
          accessibilityState={{ disabled: props.stopping ? props.stopDisabled || busy : !canSend }} disabled={props.stopping ? props.stopDisabled || busy : !canSend}
          onPress={props.stopping ? props.onStop : onSend} style={[styles.send, (props.stopping ? props.stopDisabled : !canSend) && styles.sendDisabled]}>
          {busy ? <ActivityIndicator size="small" color={colors.onInk} /> : <Ionicons name={props.stopping ? "stop" : pending ? "refresh" : "arrow-up"} size={23} color={colors.onInk} />}
        </Pressable>
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
    {expanded ? <ChatTextEditor text={text} onText={onText} editable={editable} maxLength={props.unlimitedText ? undefined : 20000}
      initialSelection={expanded}
      onSelection={value => { selection.current = value; }} onClose={() => {
        setExpanded(null);
        setTimeout(() => { input.current?.focus(); input.current?.setNativeProps({ selection: selection.current }); }, 100);
      }} /> : null}
  </View>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  area: { paddingHorizontal: space.md, paddingBottom: space.sm, paddingTop: space.sm, backgroundColor: colors.paper },
  areaFloating: { paddingTop: 0 },
  floating: { paddingBottom: space.sm },
  optionsViewport: { flex: 1, minWidth: 0 },
  options: { flexDirection: "row", alignItems: "center", gap: 2 },
  chip: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 5 },
  chipText: { ...typography.detail, fontWeight: "500", color: colors.ink },
  composer: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 26, padding: 6,
    shadowColor: colors.shadow, shadowOpacity: 0.05, shadowRadius: 12, shadowOffset: { width: 0, height: 3 } },
  editBanner: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  input: { ...typography.reading, fontSize: 16, lineHeight: 25, color: colors.ink, minHeight: 60, maxHeight: 160, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10, textAlignVertical: "top" },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 2 },
  smallAction: { width: 40, minHeight: 44, alignItems: "center", justifyContent: "center" },
  send: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22, backgroundColor: colors.ink },
  sendDisabled: { opacity: 0.25 },
  attachments: { paddingHorizontal: space.sm, paddingTop: space.sm },
  hint: { paddingHorizontal: space.md, paddingBottom: space.sm },
  disabled: { opacity: 0.4 },
  addOptions: { flexDirection: "row", gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.lg },
  addOption: { flex: 1, minHeight: 88, borderRadius: radius.item, backgroundColor: colors.neutral, alignItems: "center", justifyContent: "center", gap: space.sm },
  addLabel: { ...typography.body, color: colors.ink },
});
