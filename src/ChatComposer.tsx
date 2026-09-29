import { useState, type ReactNode } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import type { Connection, ModelCatalog, ReasoningEffort, Resource } from "./api";
import { Attachments } from "./Attachments";
import { ModelPicker, reasoningLabel } from "./ModelPicker";
import { SearchPicker } from "./SearchPicker";
import { Button, colors, humanError, s } from "./ui";

export type ChatComposerProps = {
  name: string;
  draft: string;
  attachments?: Resource[];
  onRemoveAttachment?: (id: string) => void;
  kind: "chat" | "task";
  busy: boolean;
  ready?: boolean;
  pending?: boolean;
  optionsLocked?: boolean;
  connection: Connection;
  catalog: ModelCatalog | null;
  modelId: string | null;
  effort: ReasoningEffort | null;
  searchProviderId: string | null;
  onDraft: (text: string) => void;
  onKind: (kind: "chat" | "task") => void;
  onModel: (id: string | null, effort: ReasoningEffort | null) => Promise<void>;
  onSearchProviderId: (id: string | null) => void;
  onFiles: () => void;
  onSend: () => void;
  onEditPending?: () => void;
  error?: string;
  children?: ReactNode;
};

export function ChatComposer({
  name, draft, attachments, onRemoveAttachment, kind, busy, ready = true, pending = false, optionsLocked = false,
  connection, catalog, modelId, effort, searchProviderId, onDraft, onKind, onModel,
  onSearchProviderId, onFiles, onSend, onEditPending, error, children,
}: ChatComposerProps) {
  const [showModels, setShowModels] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState("");
  const selectedModelId = modelId ?? catalog?.roles[kind] ?? null;
  const model = catalog?.items.find((item) => item.id === selectedModelId);
  const depth = effort ?? model?.default_reasoning_effort ?? "auto";
  const locked = !ready || pending || busy || modelBusy || optionsLocked;
  const sendDisabled = !ready || busy || modelBusy || (!draft.trim() && !attachments?.length);
  async function updateModel(id: string | null, value: ReasoningEffort | null) {
    setModelBusy(true);
    try { await onModel(id, value); }
    finally { setModelBusy(false); }
  }
  async function chooseEffort(value: ReasoningEffort | null) {
    setModelError("");
    try {
      await updateModel(modelId, value);
      setShowReasoning(false);
    } catch (e) { setModelError(humanError(e)); }
  }
  return (
    <View style={styles.area}>
      <View style={styles.modes}>
        {(["chat", "task"] as const).map((value) => (
          <Pressable key={value} accessibilityRole="button" accessibilityLabel={value === "chat" ? "聊天模式" : "任务模式"} accessibilityState={{ selected: kind === value, disabled: locked }} disabled={locked} onPress={() => onKind(value)} style={[styles.mode, kind === value && styles.modeActive, locked && s.disabled]}>
            <Ionicons name={value === "chat" ? "chatbubble-outline" : "flash-outline"} size={16} color={kind === value ? colors.accent : colors.muted} />
            <Text style={[styles.modeText, kind === value && styles.modeTextActive]}>{value === "chat" ? "聊天" : "任务"}</Text>
          </Pressable>
        ))}
        {children}
      </View>
      <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} style={styles.options} contentContainerStyle={styles.modes}>
        <Pressable accessibilityRole="button" accessibilityLabel={`选择${kind === "task" ? "任务" : "聊天"}模型，当前${model?.name ?? "未配置"}`} accessibilityState={{ disabled: locked || !catalog }} disabled={locked || !catalog} onPress={() => setShowModels(true)} style={[styles.mode, (locked || !catalog) && s.disabled]}>
          <Ionicons name="options-outline" size={16} color={colors.accent} /><Text numberOfLines={1} style={[styles.modeText, styles.modelText]}>模型 · {model?.name ?? "未配置"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={model?.reasoning_levels.length ? `思考深度，当前${reasoningLabel[depth]}` : "当前模型未配置思考深度"} accessibilityState={{ disabled: locked || !model?.reasoning_levels.length }} disabled={locked || !model?.reasoning_levels.length} onPress={() => { setModelError(""); setShowReasoning(true); }} style={[styles.mode, (locked || !model?.reasoning_levels.length) && s.disabled]}>
          <Ionicons name="sparkles-outline" size={16} color={colors.accent} /><Text style={styles.modeText}>思考 · {model?.reasoning_levels.length ? reasoningLabel[depth] : "未配置"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`联网搜索${searchProviderId ? "已开启" : "已关闭"}`} accessibilityState={{ disabled: locked }} disabled={locked} onPress={() => setShowSearch(true)} style={[styles.mode, !!searchProviderId && styles.modeActive, locked && s.disabled]}>
          <Ionicons name="globe-outline" size={16} color={colors.accent} /><Text style={styles.modeText}>联网{searchProviderId ? " · 开" : ""}</Text>
        </Pressable>
      </ScrollView>
      {optionsLocked ? <Text style={styles.hint}>引导模式 · 沿用目标运行的模型与联网设置</Text> : null}
      <Attachments connection={connection} items={attachments} remove={ready && !pending && !busy ? onRemoveAttachment : undefined} />
      <View style={styles.composer}>
        <Pressable accessibilityRole="button" accessibilityLabel="添加文件" accessibilityState={{ disabled: !ready || busy }} disabled={!ready || busy} onPress={onFiles} style={styles.attach}><Ionicons name="add" size={24} color={colors.accent} /></Pressable>
        <TextInput accessibilityLabel={`向${name}提问或交代任务`} multiline maxLength={20000} scrollEnabled placeholder={`向${name}提问…`} placeholderTextColor={colors.muted} value={draft} onChangeText={onDraft} editable={ready && !pending && !busy} style={styles.input} />
        <Pressable accessibilityRole="button" accessibilityLabel={pending ? "重试发送" : "发送消息"} accessibilityState={{ disabled: sendDisabled }} disabled={sendDisabled} onPress={onSend} style={[styles.send, sendDisabled && styles.sendDisabled]}>
          {busy ? <ActivityIndicator color={colors.white} /> : <Ionicons name={pending ? "refresh" : "arrow-up"} size={23} color={colors.white} />}
        </Pressable>
      </View>
      {pending ? <Text style={s.muted}>提交尚未确认 · 重试沿用原请求</Text> : null}
      {pending && !busy && onEditPending ? <Button secondary small onPress={onEditPending}>返回编辑草稿</Button> : null}
      {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      <Text style={styles.disclaimer}>回答由 AI 生成，重要信息请核对来源</Text>
      <ModelPicker visible={showModels} title={`选择${kind === "task" ? "任务" : "聊天"}模型`} connectionUrl={connection.url} models={catalog?.items ?? []} selectedId={selectedModelId} onSelect={(id) => updateModel(id, null)} onUseDefault={modelId ? () => updateModel(null, null) : undefined} defaultLabel={`跟随默认${kind === "task" ? "任务" : "聊天"}模型`} onClose={() => setShowModels(false)} />
      <Modal visible={showReasoning} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowReasoning(false)}>
        <SafeAreaView style={s.root}>
          <View style={s.header}><Text style={[s.heading, s.grow]}>思考深度</Text><Button secondary onPress={() => setShowReasoning(false)}>关闭</Button></View>
          <ScrollView contentContainerStyle={s.content}>
            <Text style={s.muted}>只影响之后提交的{kind === "task" ? "任务" : "聊天"}。不同模型支持的档位可能不同。</Text>
            {modelError ? <Text accessibilityRole="alert" style={s.error}>{modelError}</Text> : null}
            <Button secondary disabled={modelBusy} onPress={() => { void chooseEffort(null); }}>模型默认{model?.default_reasoning_effort ? ` · ${reasoningLabel[model.default_reasoning_effort]}` : " · 自动"}</Button>
            {model?.reasoning_levels.map((value) => <Button key={value} secondary={depth !== value} disabled={modelBusy} onPress={() => { void chooseEffort(value); }}>{reasoningLabel[value]}</Button>)}
          </ScrollView>
        </SafeAreaView>
      </Modal>
      <SearchPicker visible={showSearch} connection={connection} selectedId={searchProviderId} onSelect={onSearchProviderId} onClose={() => setShowSearch(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  area: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 10, gap: 7 },
  modes: { flexDirection: "row", gap: 5, alignItems: "center" },
  options: { flexGrow: 0 },
  mode: { minHeight: 36, borderRadius: 18, paddingHorizontal: 9, flexDirection: "row", alignItems: "center", gap: 6 },
  modeActive: { backgroundColor: colors.white },
  modeText: { color: colors.muted, fontSize: 13 },
  modelText: { maxWidth: 90 },
  modeTextActive: { color: colors.ink, fontWeight: "600" },
  hint: { color: colors.amber, fontSize: 12 },
  composer: { minHeight: 64, backgroundColor: colors.white, borderRadius: 32, paddingLeft: 8, paddingRight: 7, borderWidth: 1, borderColor: colors.line, flexDirection: "row", alignItems: "center", gap: 8 },
  attach: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.pale, alignItems: "center", justifyContent: "center" },
  input: { flex: 1, color: colors.ink, fontSize: 16, maxHeight: 108, paddingVertical: 12, textAlignVertical: "center" },
  send: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  sendDisabled: { backgroundColor: "#DAA29F" },
  disclaimer: { textAlign: "center", color: colors.muted, fontSize: 11 },
});
