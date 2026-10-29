import { DraftAttachments } from "./PhotoAttachments";
import type { ThemeColors } from "./theme";
import { useUi, ActionLink } from "./ui";
import { useThemedStyles } from "./ThemeProvider";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ConversationComposer } from "./ConversationComposer";
import { ReasoningPicker } from "./ReasoningPicker";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { type Connection, type DraftPhoto, type ModelCatalog, type ReasoningEffort } from "./api";
import { ModelPicker } from "./ModelPicker";

type Kind = "chat" | "task";

const suggestions = [
  { title: "理清思路", description: "拆解杂乱事项成清单", icon: "bulb-outline", prompt: "帮我理清这件事的思路：" },
  { title: "看看开销", description: "分析本月预算与支出", icon: "wallet-outline", prompt: "帮我看看当前开销和预算，有什么可以调整：" },
  { title: "读懂资料", description: "提炼文章与报告核心", icon: "document-text-outline", prompt: "请帮我读懂这段资料：" },
  { title: "聊聊近况", description: "复盘今天或推敲想法", icon: "chatbubble-outline", prompt: "我想和你聊聊最近的事：" },
] as const;

export function AiHome({
  name,
  draft,
  busy,
  draftReady = true,
  draftError = "",
  onRetryDraft,
  connection,
  catalog,
  modelId,
  effort,
  onDraft,
  onKind,
  onModelId,
  onEffort,
  onFiles,
  onPhotos,
  photos = [],
  onRemovePhoto,
  pickingPhotos = false,
  onSend,
}: {
  name: string;
  draft: string;
  kind: Kind;
  busy: boolean;
  draftReady?: boolean;
  draftError?: string;
  onRetryDraft?: () => void;
  connection: Connection;
  catalog: ModelCatalog | null;
  modelId: string | null;
  effort: ReasoningEffort | null;
  onDraft: (text: string) => void;
  onKind: (kind: Kind) => void;
  onModelId: (id: string | null) => void;
  onEffort: (value: ReasoningEffort | null) => void;
  onFiles: () => void;
  onPhotos?: () => void;
  photos?: DraftPhoto[];
  onRemovePhoto?: (id: string) => void;
  pickingPhotos?: boolean;
  onSend: () => void;
}) {
  const { s, colors } = useUi();
  const styles = useThemedStyles(createStyles);
  const [showModels, setShowModels] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const locked = busy || !draftReady;
  const selectedModelId = modelId ?? catalog?.roles.chat ?? null;
  const model = catalog?.items.find((item) => item.id === selectedModelId);
  const depth = effort ?? model?.default_reasoning_effort ?? "auto";
  function prefill(prompt: string) {
    if (locked) return;
    const previous = draft.trimEnd();
    onDraft(`${previous}${previous.trim() ? "\n\n" : ""}${prompt}`);
    onKind("chat");
  }
  return (
    <View style={s.body}>
      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <View style={styles.mark} accessible={false}><Ionicons name="sparkles" size={27} color={colors.onInk} /></View>
          <Text accessibilityRole="header" style={styles.greeting}>今天想做点什么？</Text>
          <Text style={styles.subtitle}>和{name}聊聊想法，或者把一件事交给我。</Text>
        </View>
        <View style={styles.suggestions}>
          {suggestions.map((item) => <Pressable key={item.title} accessibilityRole="button" accessibilityLabel={item.title} disabled={locked}
            accessibilityState={{ disabled: locked }} onPress={() => prefill(item.prompt)} style={({ pressed }) => [styles.suggestion, locked && styles.disabled, pressed && s.pressed]}>
            <Ionicons name={item.icon} size={18} color={colors.muted} /><Text style={styles.suggestionTitle}>{item.title}</Text>
          </Pressable>)}
        </View>
      </ScrollView>
      <ConversationComposer unlimitedText text={draft} placeholder={`和${name}聊聊，或交代一件事…`} editable={!locked} onText={(text) => { if (!locked) onDraft(text); }} onSend={() => { if (!locked && !pickingPhotos && (draft.trim() || photos.length)) onSend(); }} onFiles={() => { if (!locked) onFiles(); }} onPhotos={onPhotos} attachmentLocked={locked || pickingPhotos} canSend={!locked && !pickingPhotos && !!(draft.trim() || photos.length)} busy={busy} kind="chat" onKind={() => { if (!locked) onKind("chat"); }} kindLocked={locked} connection={connection} model={model} depth={depth} optionsLocked={locked || !catalog} onModel={() => { if (!locked && catalog) setShowModels(true); }} onReasoning={() => { if (!locked && catalog) setShowReasoning(true); }}>
        <DraftAttachments connection={connection} photos={photos} removePhoto={locked ? undefined : onRemovePhoto} />
      </ConversationComposer>
      {draftError ? <View style={styles.draftError}>
        <Text accessibilityRole="alert" style={s.error}>{draftError}</Text>
        {onRetryDraft ? <ActionLink icon="refresh-outline" onPress={onRetryDraft}>{draftReady ? "重试保存草稿" : "重新读取草稿"}</ActionLink> : null}
      </View> : null}
      <ModelPicker visible={showModels} title="选择聊天模型" connectionUrl={connection.url} models={catalog?.items ?? []} selectedId={selectedModelId} onSelect={async (id) => { if (!locked) { onModelId(id); onEffort(null); } }} onUseDefault={modelId ? async () => { if (!locked) { onModelId(null); onEffort(null); } } : undefined} defaultLabel="跟随默认聊天模型" onClose={() => setShowModels(false)} />
      <ReasoningPicker visible={showReasoning} model={model} selected={effort} onSelect={async (value) => { if (!locked) onEffort(value); }} onClose={() => setShowReasoning(false)} />
    </View>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 24, paddingTop: 24, paddingBottom: 64, gap: 30 },
  hero: { alignItems: "center", gap: 14 },
  mark: { width: 56, height: 56, borderRadius: 19, backgroundColor: colors.ink, alignItems: "center", justifyContent: "center", marginBottom: 4 },
  greeting: { color: colors.ink, fontSize: 26, fontWeight: "600", lineHeight: 36, textAlign: "center" },
  subtitle: { color: colors.muted, fontSize: 14, lineHeight: 23, textAlign: "center" },
  suggestions: { flexDirection: "row", flexWrap: "wrap", gap: 10, justifyContent: "center", alignSelf: "center", maxWidth: 360 },
  suggestion: { flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 16, minHeight: 48, borderRadius: 24, borderColor: colors.line, borderWidth: 1 },
  suggestionTitle: { color: colors.ink, fontSize: 13, lineHeight: 21 },
  draftError: { paddingHorizontal: 18, paddingBottom: 8 },
  disabled: { opacity: 0.45 },
});
