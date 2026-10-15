import type { ThemeColors } from "./theme";
import { useUi, ActionLink } from "./ui";
import { useThemedStyles } from "./ThemeProvider";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ConversationComposer } from "./ConversationComposer";
import { ReasoningPicker } from "./ReasoningPicker";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { type Connection, type ModelCatalog, type ReasoningEffort } from "./api";
import { ModelPicker } from "./ModelPicker";
import { SearchPicker } from "./SearchPicker";

type Kind = "chat" | "task";

const shortcuts = [
  { title: "☕ 规划今日节奏", prompt: "帮我结合今天的安排，规划一个做得到的日常节奏：" },
  { title: "🎯 明确执行要点", prompt: "帮我明确这件事的目标、限制和接下来可以做的一步：" },
] as const;
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
  searchProviderId,
  onDraft,
  onKind,
  onModelId,
  onEffort,
  onSearchProviderId,
  onFiles,
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
  searchProviderId: string | null;
  onDraft: (text: string) => void;
  onKind: (kind: Kind) => void;
  onModelId: (id: string | null) => void;
  onEffort: (value: ReasoningEffort | null) => void;
  onSearchProviderId: (id: string | null) => void;
  onFiles: () => void;
  onSend: () => void;
}) {
  const { s, colors } = useUi();
  const styles = useThemedStyles(createStyles);
  const [showModels, setShowModels] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
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
          <View style={styles.identity} accessible={false}>
            <View style={styles.glowOuter} /><View style={styles.glowInner} />
            <View style={styles.mark}>
              <Ionicons name="leaf-outline" size={32} color={colors.gold} />
              <View style={styles.sparkle}><Ionicons name="sparkles" size={18} color={colors.gold} /></View>
            </View>
          </View>
          <View style={styles.greetingRow}>
            <Text accessibilityRole="header" style={styles.greeting}>Hi，我是{name}</Text>
            <View style={styles.companion}><Text style={styles.companionText}>思考伙伴</Text></View>
          </View>
          <Text style={styles.subtitle}>陪你理清想法，也把事情做成。今天打算聚焦在哪件事上？</Text>
        </View>
        <View style={styles.shortcuts}>
          <Text style={styles.shortcutLabel}>快捷状态：</Text>
          {shortcuts.map((item) => <Pressable key={item.title} accessibilityRole="button" accessibilityLabel={item.title} disabled={locked} accessibilityState={{ disabled: locked }} onPress={() => prefill(item.prompt)} style={({ pressed }) => [styles.shortcut, locked && styles.disabled, pressed && s.pressed]}><View style={styles.shortcutPill}><Text style={styles.shortcutText}>{item.title}</Text></View></Pressable>)}
        </View>
        <View style={styles.sectionHeading}><Text style={styles.question}>想从哪里开始？</Text><Text style={styles.sectionHint}>点击直接载入对话</Text></View>
        <View style={styles.grid}>
          {suggestions.map((item) => <Pressable key={item.title} accessibilityRole="button" accessibilityLabel={item.title} disabled={locked} accessibilityState={{ disabled: locked }} onPress={() => prefill(item.prompt)} style={({ pressed }) => [styles.suggestion, locked && styles.disabled, pressed && s.pressed]}>
            <View style={styles.suggestionTop}><View style={styles.iconPlate}><Ionicons name={item.icon} size={23} color={colors.gold} /></View><Ionicons name="arrow-forward" size={17} color={colors.muted} /></View>
            <Text style={styles.suggestionTitle}>{item.title}</Text><Text style={styles.suggestionDescription}>{item.description}</Text>
          </Pressable>)}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="饮食与生活建议" disabled={locked} accessibilityState={{ disabled: locked }} onPress={() => prefill("根据我的饮食约定、身体限制和最近记录，聊聊适合我的饮食与日常生活安排：")} style={({ pressed }) => [styles.lifeRow, locked && styles.disabled, pressed && s.pressed]}>
          <View style={styles.lifeIcon}><Ionicons name="restaurant-outline" size={22} color={colors.gold} /></View>
          <View style={styles.lifeCopy}><Text style={styles.lifeTitle}>饮食与生活建议</Text><Text style={styles.lifeDescription}>根据每日节奏，调整健康小目标</Text></View>
          <Ionicons name="chevron-forward" size={17} color={colors.muted} />
        </Pressable>
      </ScrollView>
      <ConversationComposer appearance="welcome" text={draft} placeholder={`和${name}聊聊，或交代一件事…`} editable={!locked} onText={(text) => { if (!locked) onDraft(text); }} onSend={() => { if (!locked && draft.trim()) onSend(); }} onFiles={() => { if (!locked) onFiles(); }} attachmentLocked={locked} canSend={!locked && !!draft.trim()} busy={busy} kind="chat" onKind={() => { if (!locked) onKind("chat"); }} kindLocked={locked} connection={connection} model={model} depth={depth} searchId={searchProviderId} optionsLocked={locked || !catalog} onModel={() => { if (!locked && catalog) setShowModels(true); }} onReasoning={() => { if (!locked && catalog) setShowReasoning(true); }} onSearch={() => { if (!locked && catalog) setShowSearch(true); }} />
      {draftError ? <View style={styles.draftError}>
        <Text accessibilityRole="alert" style={s.error}>{draftError}</Text>
        {onRetryDraft ? <ActionLink icon="refresh-outline" onPress={onRetryDraft}>{draftReady ? "重试保存草稿" : "重新读取草稿"}</ActionLink> : null}
      </View> : null}
      <ModelPicker visible={showModels} title="选择聊天模型" connectionUrl={connection.url} models={catalog?.items ?? []} selectedId={selectedModelId} onSelect={async (id) => { if (!locked) { onModelId(id); onEffort(null); } }} onUseDefault={modelId ? async () => { if (!locked) { onModelId(null); onEffort(null); } } : undefined} defaultLabel="跟随默认聊天模型" onClose={() => setShowModels(false)} />
      <ReasoningPicker visible={showReasoning} model={model} selected={effort} onSelect={async (value) => { if (!locked) onEffort(value); }} onClose={() => setShowReasoning(false)} />
      <SearchPicker visible={showSearch} connection={connection} selectedId={searchProviderId} onSelect={(id) => { if (!locked) onSearchProviderId(id); }} onClose={() => setShowSearch(false)} />
    </View>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 16 },
  hero: { alignItems: "flex-start" },
  identity: { width: 56, height: 56, alignItems: "center", justifyContent: "center", marginBottom: 14 },
  glowOuter: { position: "absolute", width: 104, height: 104, borderRadius: 52, backgroundColor: colors.gold, opacity: 0.035 },
  glowInner: { position: "absolute", width: 80, height: 80, borderRadius: 40, backgroundColor: colors.gold, opacity: 0.055 },
  mark: { width: 54, height: 54, borderRadius: 16, borderWidth: 1, borderColor: colors.strongLine, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center", shadowColor: colors.gold, shadowOpacity: 0.26, shadowRadius: 18, shadowOffset: { width: 0, height: 0 }, elevation: 6 },
  sparkle: { position: "absolute", right: 4, top: 5 },
  greetingRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  greeting: { color: colors.ink, fontSize: 26, fontWeight: "700", lineHeight: 34, flexShrink: 1 },
  companion: { backgroundColor: colors.goldSoft, borderColor: colors.strongLine, borderWidth: StyleSheet.hairlineWidth, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 3 },
  companionText: { color: colors.gold, fontSize: 12, lineHeight: 18 },
  subtitle: { color: colors.muted, fontSize: 13, lineHeight: 21, marginTop: 7 },
  shortcuts: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 12 },
  shortcutLabel: { color: colors.muted, fontSize: 11, lineHeight: 18 },
  shortcut: { minWidth: 40, minHeight: 44, alignItems: "center", justifyContent: "center" },
  shortcutPill: { borderColor: colors.line, borderWidth: 1, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5, minHeight: 30, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  shortcutText: { color: colors.ink, fontSize: 12, lineHeight: 18 },
  sectionHeading: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 6, marginTop: 18, marginBottom: 10 },
  question: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  sectionHint: { color: colors.muted, fontSize: 11, lineHeight: 18 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  suggestion: { width: "46%", flexGrow: 1, minWidth: 0, minHeight: 110, backgroundColor: colors.surface, borderColor: colors.strongLine, borderWidth: StyleSheet.hairlineWidth, borderRadius: 20, padding: 12 },
  suggestionTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  iconPlate: { width: 34, height: 34, borderRadius: 12, backgroundColor: colors.goldSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.strongLine, alignItems: "center", justifyContent: "center" },
  suggestionTitle: { color: colors.ink, fontSize: 14, fontWeight: "600", lineHeight: 21, marginTop: 10 },
  suggestionDescription: { color: colors.muted, fontSize: 11, lineHeight: 18, marginTop: 2 },
  lifeRow: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.surface, borderColor: colors.line, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 10, marginTop: 10, minHeight: 50 },
  lifeIcon: { width: 30, height: 30, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceRaised },
  lifeCopy: { flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 10, rowGap: 2 },
  lifeTitle: { color: colors.ink, fontSize: 12, lineHeight: 19 },
  lifeDescription: { color: colors.muted, fontSize: 11, lineHeight: 18, flexShrink: 1 },
  draftError: { paddingHorizontal: 18, paddingBottom: 8 },
  disabled: { opacity: 0.45 },
});
