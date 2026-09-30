import { Image, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import type { Connection, Conversation, FinanceSummary, ModelCatalog } from "./api";
import { ChatPanel } from "./ChatPanel";
import { useUi, BackLink, CardHeader } from "./ui";
import { useTheme, useThemedStyles } from "./ThemeProvider";
import { type ThemeColors, typography } from "./theme";

export function FinancePage({
  connection, conversation, finance, catalog, onBack, onRefresh, onConversationChanged, agentModelId = null,
}: {
  connection: Connection;
  conversation: Conversation;
  finance: FinanceSummary;
  catalog: ModelCatalog | null;
  agentModelId?: string | null;
  onBack: () => void;
  onRefresh: () => void;
  onConversationChanged: (conversation: Conversation) => void;
}) {
  const { s } = useUi();
  const { mode } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { width } = useWindowDimensions();
  return (
    <View style={s.body}>
      <View style={styles.hero}>
        {mode === "light" && width >= 380 ? <Image source={require("../assets/life-header-red.png")} resizeMode="contain" style={styles.heroArt} accessible={false} /> : null}
        <BackLink label="生活" onPress={onBack} />
        <Text accessibilityRole="header" style={styles.title}>财务</Text>
        <Text style={styles.intro}>账户、收支和扣费问题，直接和财务助手聊。</Text>
      </View>
      <ChatPanel
        connection={connection}
        conversation={conversation}
        assistantName="财务助手"
        catalog={catalog}
        agentModelId={agentModelId}
        onConversationChanged={onConversationChanged}
        onRefresh={onRefresh}
        intro={<FinanceOverview finance={finance} />}
        stretchIntro={!finance.balances.length && !finance.recent.length}
      />
    </View>
  );
}

function FinanceOverview({ finance }: { finance: FinanceSummary }) {
  const { s } = useUi();
  const styles = useThemedStyles(createStyles);
  const emptyOverview = !finance.balances.length && !finance.recent.length;
  return (
    <View style={[styles.overview, emptyOverview && styles.fill]}>
      <View style={[s.card, emptyOverview && styles.fill]}>
        <CardHeader icon="wallet-outline" title="账户一览" tone="gold" />
        {finance.balances.length ? (
          <View style={styles.records}>
            {finance.balances.map((item) => (
              <View key={item.id} style={styles.recordRow}>
                <Text style={[styles.recordLabel, s.grow]}>{item.platform}</Text>
                <Text style={styles.amount}>¥{item.amount}</Text>
              </View>
            ))}
          </View>
        ) : <FinanceEmpty icon="wallet-outline">{"告诉我账户名称和余额，\n我来帮你整理。"}</FinanceEmpty>}
      </View>
      <View style={[s.card, emptyOverview && styles.fill]}>
        <CardHeader icon="bar-chart-outline" title="最近收支" tone="gold" />
        {finance.recent.length ? (
          <View style={styles.records}>
            {finance.recent.slice(0, 5).map((item) => (
              <View key={item.id} style={styles.recordRow}>
                <View style={s.grow}>
                  <Text style={styles.recordLabel}>{item.platform}</Text>
                  <Text style={s.muted}>{item.kind === "income" ? "收入" : "支出"}</Text>
                </View>
                <Text style={styles.amount}>¥{item.amount}</Text>
              </View>
            ))}
          </View>
        ) : <FinanceEmpty icon="receipt-outline">{"可以直接说一笔收入或消费，\n也可以聊聊扣费问题。"}</FinanceEmpty>}
      </View>
    </View>
  );
}

function FinanceEmpty({ icon, children }: { icon: "wallet-outline" | "receipt-outline"; children: string }) {
  const { colors } = useUi();
  const { mode } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyArtwork} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {mode === "light" ? <Image source={require("../assets/life-footer-red.png")} resizeMode="contain" style={styles.hills} /> : null}
        <Ionicons name="leaf-outline" size={27} color={colors.accent} style={styles.sprout} />
        <View style={styles.emptyObject}><Ionicons name={icon} size={40} color={colors.accent} /></View>
      </View>
      <Text style={styles.emptyText}>{children}</Text>
    </View>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  hero: { paddingHorizontal: 22, paddingTop: 6, paddingBottom: 14, gap: 8, minHeight: 166 },
  heroArt: { position: "absolute", width: 286, height: 190, right: -30, top: -9 },
  title: { ...typography.hero, color: colors.ink },
  intro: { color: colors.muted, fontSize: 13, lineHeight: 21, maxWidth: "76%" },
  overview: { gap: 14 },
  fill: { flexGrow: 1 },
  emptyState: { flexGrow: 1, alignItems: "center", justifyContent: "center", gap: 9, paddingBottom: 5 },
  emptyArtwork: { width: "100%", maxWidth: 280, height: 96, alignItems: "center", justifyContent: "center" },
  hills: { position: "absolute", width: "100%", height: 90, bottom: -3, opacity: 0.5 },
  sprout: { position: "absolute", left: "24%", bottom: 13, opacity: 0.24, transform: [{ rotate: "-25deg" }] },
  emptyObject: { width: 64, height: 66, borderRadius: 19, backgroundColor: colors.pale, alignItems: "center", justifyContent: "center", opacity: 0.8, transform: [{ rotate: "-5deg" }] },
  emptyText: { color: colors.muted, fontSize: 13, lineHeight: 21, textAlign: "center" },
  records: { gap: 8 },
  recordRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.line },
  recordLabel: { color: colors.ink, fontSize: 15, lineHeight: 23 },
  amount: { color: colors.ink, fontSize: 16, lineHeight: 24, fontWeight: "600", flexShrink: 1 },
});
