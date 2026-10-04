import { useEffect, useState } from "react";
import { Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import type { Connection, Conversation, FinanceObservation, FinanceSummary, ModelCatalog } from "./api";
import { ChatPanel } from "./ChatPanel";
import { useUi, IconAction, timeLabel } from "./ui";
import { useThemedStyles } from "./ThemeProvider";
import { type ThemeColors, layout, radius, space, typography } from "./theme";

export function FinancePage({
  connection, conversation, finance, catalog, onBack, onRefresh, onConversationChanged, agentModelId = null,
  backLabel = "生活", focusMessageSeq = null, onFocusHandled,
}: {
  connection: Connection;
  conversation: Conversation;
  finance: FinanceSummary;
  catalog: ModelCatalog | null;
  agentModelId?: string | null;
  backLabel?: string;
  focusMessageSeq?: number | null;
  onFocusHandled?: (seq: number) => void;
  onBack: () => void;
  onRefresh: () => void;
  onConversationChanged: (conversation: Conversation) => void;
}) {
  const { s } = useUi();
  const styles = useThemedStyles(createStyles);
  const [keyboardVisible, setKeyboardVisible] = useState(Keyboard.isVisible());
  const [overviewExpanded, setOverviewExpanded] = useState(false);
  const [composerContext, setComposerContext] = useState<{ conversationId: string; modelId: string | null; kind: "chat" | "task" } | null>(null);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => { setKeyboardVisible(true); setOverviewExpanded(false); });
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const context = composerContext?.conversationId === conversation.id ? composerContext : null;
  const modelId = context ? context.modelId : conversation.model_id ?? agentModelId ?? catalog?.roles.chat;
  const model = catalog?.items.find((item) => item.id === modelId);
  return (
    <View style={s.body}>
      <View style={styles.header}>
        <IconAction icon="arrow-back" label={`返回${backLabel}`} onPress={onBack} />
        <View style={s.headingCopy}>
          <Text accessibilityRole="header" style={styles.title}>财务</Text>
          <Text numberOfLines={1} style={s.muted}>{context?.kind === "task" ? "任务 · " : ""}{model?.name ?? "财务助手"}</Text>
        </View>
      </View>
      <ChatPanel
        connection={connection}
        conversation={conversation}
        assistantName="财务助手"
        catalog={catalog}
        agentModelId={agentModelId}
        focusMessageSeq={focusMessageSeq}
        onFocusHandled={onFocusHandled}
        onConversationChanged={onConversationChanged}
        onComposerContext={setComposerContext}
        onRefresh={onRefresh}
        intro={<FinanceOverview finance={finance} hidden={keyboardVisible} expanded={overviewExpanded} onToggle={() => setOverviewExpanded((value) => !value)} />}
      />
    </View>
  );
}

function FinanceOverview({ finance, hidden, expanded, onToggle }: { finance: FinanceSummary; hidden: boolean; expanded: boolean; onToggle: () => void }) {
  const { s, colors } = useUi();
  const styles = useThemedStyles(createStyles);
  if (hidden) return null;
  if (!finance.balances.length && !finance.recent.length) return <Text style={s.muted}>发截图或说一笔收支，开始整理。</Text>;
  const balances = expanded ? finance.balances : finance.balances.slice(0, 1);
  const recent = expanded ? finance.recent : finance.recent.slice(0, 1);
  return (
    <View style={styles.overview}>
      <Pressable accessibilityRole="button" accessibilityLabel={expanded ? "收起财务速览" : "展开财务速览"}
        accessibilityState={{ expanded }} onPress={onToggle} style={styles.overviewHeading}>
        <Ionicons name="wallet-outline" size={20} color={colors.gold} />
        <View style={s.headingCopy}><Text style={s.itemTitle}>账户与收支</Text><Text style={s.muted}>{finance.balances.length} 个账户 · {finance.recent.length} 笔近期收支</Text></View>
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={18} color={colors.muted} />
      </Pressable>
      {[...balances, ...recent].map((item) => <FinanceRecord key={item.id} item={item} />)}
    </View>
  );
}

function FinanceRecord({ item }: { item: FinanceObservation }) {
  const { s } = useUi();
  const styles = useThemedStyles(createStyles);
  const kind = item.kind === "balance" ? "余额" : item.kind === "income" ? "收入" : "支出";
  return <View style={styles.recordRow}>
    <View style={s.headingCopy}>
      <Text style={styles.recordLabel}>{item.platform} · {kind}</Text>
      {item.note ? <Text numberOfLines={2} style={s.description}>{item.note}</Text> : null}
      <Text style={s.muted}>{timeLabel(item.created_at)}</Text>
    </View>
    <Text style={styles.amount}>{item.kind === "income" ? "+" : item.kind === "expense" ? "−" : ""}¥{item.amount}</Text>
  </View>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  header: { minHeight: 60, paddingHorizontal: space.sm, paddingVertical: space.xs, flexDirection: "row", alignItems: "center", gap: space.sm },
  title: { ...typography.section, color: colors.ink },
  overview: { backgroundColor: colors.surfaceRaised, borderRadius: radius.item, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingHorizontal: space.md },
  overviewHeading: { minHeight: layout.touchTarget, flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.sm },
  recordRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  recordLabel: { ...typography.body, fontWeight: "600", color: colors.ink },
  amount: { ...typography.item, color: colors.ink, flexShrink: 1, maxWidth: "45%" },
});
