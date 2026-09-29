import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { type Connection, type ModelCatalog, type ReasoningEffort } from "./api";
import { ChatComposer } from "./ChatComposer";
import { colors, s } from "./ui";

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
      <ChatComposer
        name={name} draft={draft} kind={kind} busy={busy} connection={connection} catalog={catalog}
        modelId={modelId} effort={effort} searchProviderId={searchProviderId}
        onDraft={onDraft} onKind={onKind} onModel={async (id, value) => { onModelId(id); onEffort(value); }}
        onSearchProviderId={onSearchProviderId} onFiles={onFiles} onSend={onSend}
      />
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
});
