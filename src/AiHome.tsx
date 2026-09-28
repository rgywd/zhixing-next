import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { type Connection, type ModelCatalog, type ReasoningEffort } from "./api";
import { ModelPicker, reasoningLabel } from "./ModelPicker";
import { SearchPicker } from "./SearchPicker";
import { Button, colors, s } from "./ui";

type Kind = "chat" | "task";

const suggestions = [
  { title: "聊聊近况", icon: "chatbubble-ellipses-outline", prompt: "我想和你聊聊最近的事：", kind: "chat" },
  { title: "理清思路", icon: "bulb-outline", prompt: "帮我理清这件事的思路：", kind: "chat" },
  { title: "读懂资料", icon: "document-text-outline", prompt: "请帮我读懂这段资料：", kind: "chat" },
  { title: "写个计划", icon: "calendar-outline", prompt: "请帮我做一个计划：", kind: "chat" },
  { title: "解释问题", icon: "help-circle-outline", prompt: "请用简单的话解释：", kind: "chat" },
  { title: "交给我办", icon: "flash-outline", prompt: "请帮我完成这件事：", kind: "task" },
] as const;

export function AiHome({
  name,
  draft,
  kind,
  busy,
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
  const [showModels, setShowModels] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const selectedModelId = modelId ?? catalog?.roles[kind] ?? null;
  const model = catalog?.items.find((item) => item.id === selectedModelId);
  const depth = effort ?? model?.default_reasoning_effort ?? "auto";
  return (
    <View style={s.body}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <View style={styles.orbit}>
            <View style={styles.mark}>
              <Ionicons name="leaf-outline" size={58} color={colors.accent} />
            </View>
            <View style={styles.sparkle}><Ionicons name="sparkles" size={20} color={colors.accent} /></View>
          </View>
          <Text accessibilityRole="header" style={styles.greeting}>Hi，我是{name}</Text>
          <Text style={styles.subtitle}>陪你理清想法，也把事情做成。</Text>
        </View>
        <Text style={styles.question}>想从哪里开始？</Text>
        <View style={styles.grid}>
          {suggestions.map((item) => (
            <Pressable
              key={item.title}
              accessibilityRole="button"
              accessibilityLabel={item.title}
              onPress={() => { onDraft(item.prompt); onKind(item.kind); }}
              style={({ pressed }) => [styles.suggestion, pressed && s.pressed]}
            >
              <Ionicons name={item.icon} size={24} color={colors.accent} />
              <Text style={styles.suggestionText}>{item.title}</Text>
              <Ionicons name="arrow-forward" size={17} color={colors.muted} />
            </Pressable>
          ))}
        </View>
      </ScrollView>
      <View style={styles.composerArea}>
        <View style={styles.modes}>
          {(["chat", "task"] as const).map((value) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: kind === value }}
              onPress={() => onKind(value)}
              style={[styles.mode, kind === value && styles.modeActive]}
            >
              <Ionicons name={value === "chat" ? "chatbubble-outline" : "flash-outline"} size={16} color={kind === value ? colors.accent : colors.muted} />
              <Text style={[styles.modeText, kind === value && styles.modeTextActive]}>{value === "chat" ? "聊天" : "任务"}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.modes}>
          <Pressable accessibilityRole="button" accessibilityLabel={`选择${kind === "task" ? "任务" : "聊天"}模型，当前${model?.name ?? "未配置"}`} disabled={!catalog} onPress={() => setShowModels(true)} style={styles.mode}><Ionicons name="options-outline" size={16} color={colors.accent} /><Text numberOfLines={1} style={[styles.modeText, styles.modelText]}>模型 · {model?.name ?? "未配置"}</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={model?.reasoning_levels.length ? `思考深度，当前${reasoningLabel[depth]}` : "当前模型未配置思考深度"} accessibilityState={{ disabled: !model?.reasoning_levels.length }} disabled={!model?.reasoning_levels.length} onPress={() => setShowReasoning(true)} style={[styles.mode, !model?.reasoning_levels.length && s.disabled]}><Ionicons name="sparkles-outline" size={16} color={colors.accent} /><Text style={styles.modeText}>思考 · {model?.reasoning_levels.length ? reasoningLabel[depth] : "未配置"}</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`联网搜索${searchProviderId ? "已开启" : "已关闭"}`} onPress={() => setShowSearch(true)} style={[styles.mode, searchProviderId && styles.modeActive]}><Ionicons name="globe-outline" size={16} color={colors.accent} /><Text style={styles.modeText}>联网{searchProviderId ? " · 开" : ""}</Text></Pressable>
        </View>
        <View style={styles.composer}>
          <Pressable accessibilityRole="button" accessibilityLabel="添加文件" disabled={busy} onPress={onFiles} style={styles.attach}><Ionicons name="add" size={24} color={colors.accent} /></Pressable>
          <TextInput
            accessibilityLabel="向知行提问或交代任务"
            multiline
            maxLength={20000}
            placeholder={`向${name}提问…`}
            placeholderTextColor={colors.muted}
            value={draft}
            onChangeText={onDraft}
            editable={!busy}
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="发送消息"
            accessibilityState={{ disabled: busy || !draft.trim() }}
            disabled={busy || !draft.trim()}
            onPress={onSend}
            style={[styles.send, (busy || !draft.trim()) && styles.sendDisabled]}
          >
            <Ionicons name="arrow-up" size={23} color={colors.white} />
          </Pressable>
        </View>
        <Text style={styles.disclaimer}>回答由 AI 生成，重要信息请核对来源</Text>
      </View>
      <ModelPicker visible={showModels} title={`选择${kind === "task" ? "任务" : "聊天"}模型`} connectionUrl={connection.url} models={catalog?.items ?? []} selectedId={selectedModelId} onSelect={async (id) => { onModelId(id); onEffort(null); }} onUseDefault={modelId ? async () => { onModelId(null); onEffort(null); } : undefined} defaultLabel={`跟随默认${kind === "task" ? "任务" : "聊天"}模型`} onClose={() => setShowModels(false)} />
      <Modal visible={showReasoning} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowReasoning(false)}><SafeAreaView style={s.root}><View style={s.header}><Text style={[s.heading, s.grow]}>思考深度</Text><Button secondary onPress={() => setShowReasoning(false)}>关闭</Button></View><ScrollView contentContainerStyle={s.content}><Text style={s.muted}>不同模型支持的档位可能不同。</Text><Button secondary onPress={() => { onEffort(null); setShowReasoning(false); }}>模型默认</Button>{model?.reasoning_levels.map((value) => <Button key={value} secondary={depth !== value} onPress={() => { onEffort(value); setShowReasoning(false); }}>{reasoningLabel[value]}</Button>)}</ScrollView></SafeAreaView></Modal>
      <SearchPicker visible={showSearch} connection={connection} selectedId={searchProviderId} onSelect={onSearchProviderId} onClose={() => setShowSearch(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 24, paddingBottom: 28 },
  hero: { alignItems: "flex-start", marginBottom: 32 },
  orbit: { width: 146, height: 146, borderWidth: 2, borderColor: "#F0D4D0", borderRadius: 73, alignItems: "center", justifyContent: "center", marginBottom: 23 },
  mark: { width: 114, height: 114, borderRadius: 36, backgroundColor: colors.white, alignItems: "center", justifyContent: "center", shadowColor: colors.accent, shadowOpacity: 0.08, shadowRadius: 16, elevation: 2 },
  sparkle: { position: "absolute", right: -2, top: 0, width: 38, height: 38, borderRadius: 19, backgroundColor: colors.white, alignItems: "center", justifyContent: "center" },
  greeting: { color: colors.ink, fontSize: 35, fontWeight: "700", lineHeight: 46 },
  subtitle: { color: colors.muted, fontSize: 17, lineHeight: 26, marginTop: 7 },
  question: { color: colors.muted, fontSize: 15, marginBottom: 14 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  suggestion: { width: "48%", flexGrow: 1, minHeight: 74, backgroundColor: colors.white, borderColor: colors.line, borderWidth: 1, borderRadius: 21, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 8 },
  suggestionText: { color: colors.ink, fontSize: 15, fontWeight: "600", flex: 1 },
  composerArea: { paddingHorizontal: 16, paddingBottom: 10, gap: 9 },
  modes: { flexDirection: "row", gap: 9, alignItems: "center" },
  mode: { minHeight: 36, borderRadius: 18, paddingHorizontal: 9, flexDirection: "row", alignItems: "center", gap: 6 },
  modeActive: { backgroundColor: colors.white },
  modeText: { color: colors.muted, fontSize: 13 },
  modelText: { maxWidth: 78 },
  modeTextActive: { color: colors.ink, fontWeight: "600" },
  composer: { minHeight: 64, backgroundColor: colors.white, borderRadius: 32, paddingLeft: 8, paddingRight: 7, borderWidth: 1, borderColor: colors.line, flexDirection: "row", alignItems: "center", gap: 8 },
  attach: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.pale, alignItems: "center", justifyContent: "center" },
  input: { flex: 1, color: colors.ink, fontSize: 16, maxHeight: 108, paddingVertical: 12, textAlignVertical: "center" },
  send: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  sendDisabled: { backgroundColor: "#DAA29F" },
  disclaimer: { textAlign: "center", color: colors.muted, fontSize: 11 },
});
