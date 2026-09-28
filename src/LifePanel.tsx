import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import type { FinanceSummary } from "./api";
import { colors, s } from "./ui";

const financeShortcuts = [
  { title: "账户一览", subtitle: "余额速览", icon: "business-outline" },
  { title: "收支变化", subtitle: "最近记录", icon: "bar-chart-outline" },
  { title: "税务问题", subtitle: "聊聊疑问", icon: "document-text-outline" },
  { title: "理财建议", subtitle: "理清目标", icon: "calculator-outline" },
] as const;

const services = [
  { title: "购物", subtitle: "购物清单，挑选思路", icon: "cart-outline", prompt: "帮我整理购物需求和挑选思路：" },
  { title: "出行", subtitle: "行程想法，出发准备", icon: "airplane-outline", prompt: "和我一起规划这次出行：" },
  { title: "健康", subtitle: "运动饮食，生活习惯", icon: "heart-outline", prompt: "我想聊聊运动、饮食和生活习惯：" },
  { title: "家居", subtitle: "家居灵感，生活技巧", icon: "home-outline", prompt: "帮我想想家居和日常生活的改善办法：" },
] as const;

export function LifePanel({ onFinance, onChat, finance = { balances: [], recent: [] } }: {
  onFinance: () => void;
  onChat: (prompt: string) => void;
  finance?: FinanceSummary;
}) {
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.page}>
      <View style={styles.hero}>
        <Image source={require("../assets/life-header-red.png")} resizeMode="contain" style={styles.heroArt} accessible={false} />
        <Text style={styles.kicker}>LIFE</Text>
        <Text accessibilityRole="header" style={styles.title}>生活</Text>
        <Text style={styles.intro}>生活里的琐碎，从真正用得上的一项开始。</Text>
      </View>

      <View style={styles.financeCard}>
        <View style={styles.financeHeading}>
          <View style={styles.wallet}><Ionicons name="wallet-outline" size={28} color={colors.accent} /></View>
          <Pressable accessibilityRole="button" accessibilityLabel="打开财务" onPress={onFinance} style={styles.financeTitleLink}>
            <Text style={styles.financeTitle}>财务</Text>
            <Ionicons name="chevron-forward" size={21} color={colors.ink} />
          </Pressable>
          <View style={styles.assistantBadge}>
            <Ionicons name="sparkles" size={13} color={colors.accent} />
            <Text style={styles.assistantBadgeText}>财务助手</Text>
          </View>
        </View>
        <Text style={styles.description}>和财务助手聊账户、收支与财务问题。</Text>
        <View style={styles.shortcuts}>
          {financeShortcuts.map((item) => (
            <Pressable key={item.title} accessibilityRole="button" accessibilityLabel={`打开财务助手，${item.title}`} onPress={onFinance} style={({ pressed }) => [styles.shortcut, pressed && s.pressed]}>
              <View style={styles.shortcutIcon}><Ionicons name={item.icon} size={24} color={colors.accent} /></View>
              <Text style={styles.shortcutTitle}>{item.title}</Text>
              <Text style={styles.shortcutSubtitle}>{item.subtitle}</Text>
            </Pressable>
          ))}
        </View>
        {finance.balances.length || finance.recent.length ? (
          <View style={styles.records}>
            {finance.balances.length ? <View style={styles.recordColumn}>
              <Text style={styles.recordLabel}>账户余额</Text>
              {finance.balances.slice(0, 2).map((item) => <Text key={item.id} style={styles.record}>{item.platform} · ¥{item.amount}</Text>)}
            </View> : null}
            {finance.recent.length ? <View style={styles.recordColumn}>
              <Text style={styles.recordLabel}>最近收支</Text>
              {finance.recent.slice(0, 2).map((item) => <Text key={item.id} style={styles.record}>{item.kind === "income" ? "收入" : "支出"} · {item.platform} ¥{item.amount}</Text>)}
            </View> : null}
          </View>
        ) : null}
        <Pressable accessibilityRole="button" onPress={onFinance} style={({ pressed }) => [styles.financeButton, pressed && s.pressed]}>
          <Ionicons name="chatbubble-ellipses-outline" size={21} color={colors.accent} />
          <Text style={styles.financeButtonText}>和财务助手聊一聊</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.accent} />
        </Pressable>
        <View style={styles.privacy}>
          <Ionicons name="shield-checkmark-outline" size={17} color={colors.muted} />
          <Text style={styles.privacyText}>只显示你提供的财务信息，不会自动读取账户。</Text>
        </View>
      </View>

      <View style={styles.sectionHeading}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>其他生活服务</Text>
        <Pressable accessibilityRole="button" onPress={() => onChat("想和你聊聊我的日常生活：")} style={styles.more}>
          <Text style={styles.moreText}>问问知行</Text>
          <Ionicons name="chevron-forward" size={15} color={colors.muted} />
        </Pressable>
      </View>
      <View style={styles.serviceGrid}>
        {services.map((item) => (
          <Pressable key={item.title} accessibilityRole="button" accessibilityLabel={`和知行聊${item.title}`} onPress={() => onChat(item.prompt)} style={({ pressed }) => [styles.service, pressed && s.pressed]}>
            <View style={styles.serviceIcon}><Ionicons name={item.icon} size={24} color={colors.accent} /></View>
            <View style={styles.serviceCopy}>
              <Text style={styles.serviceTitle}>{item.title}</Text>
              <Text style={styles.serviceSubtitle}>{item.subtitle}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.muted} />
          </Pressable>
        ))}
      </View>

      <View style={styles.footer}>
        <Image source={require("../assets/life-footer-red.png")} resizeMode="contain" style={styles.footerArt} accessible={false} />
        <View style={styles.footerIcon}><Ionicons name="leaf-outline" size={24} color={colors.accent} /></View>
        <View style={styles.footerCopy}>
          <Text style={styles.footerText}>把生活的琐碎，{"\n"}变成值得期待的日常。</Text>
          <Text style={styles.footerDash}>—</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 16, paddingBottom: 20, gap: 14 },
  hero: { minHeight: 116, justifyContent: "center", gap: 6, paddingHorizontal: 6, paddingTop: 9 },
  heroArt: { position: "absolute", width: 226, height: 130, right: -26, top: -4 },
  kicker: { color: colors.accent, fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },
  title: { color: colors.ink, fontSize: 31, lineHeight: 42, fontWeight: "700" },
  intro: { color: colors.muted, fontSize: 13, lineHeight: 21, maxWidth: "76%" },
  financeCard: { backgroundColor: "#FFFCFA", borderColor: colors.white, borderWidth: 1, borderRadius: 25, padding: 14, gap: 10, shadowColor: colors.ink, shadowOpacity: 0.05, shadowOffset: { width: 0, height: 4 }, shadowRadius: 12, elevation: 2 },
  financeHeading: { flexDirection: "row", alignItems: "center", gap: 12 },
  wallet: { width: 46, height: 46, borderRadius: 17, backgroundColor: colors.pale, alignItems: "center", justifyContent: "center" },
  financeTitleLink: { flex: 1, flexDirection: "row", alignItems: "center", gap: 3, minHeight: 44 },
  financeTitle: { color: colors.ink, fontSize: 23, fontWeight: "700" },
  assistantBadge: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.pale, borderRadius: 15, paddingHorizontal: 9, paddingVertical: 7 },
  assistantBadgeText: { color: colors.accent, fontSize: 11, fontWeight: "600" },
  description: { color: colors.muted, fontSize: 13, lineHeight: 21, marginTop: -5 },
  shortcuts: { flexDirection: "row", gap: 8 },
  shortcut: { flex: 1, alignItems: "center", backgroundColor: colors.white, borderRadius: 17, paddingVertical: 10, gap: 4 },
  shortcutIcon: { width: 32, height: 32, borderRadius: 12, backgroundColor: colors.pale, alignItems: "center", justifyContent: "center", marginBottom: 2 },
  shortcutTitle: { color: colors.ink, fontSize: 12, fontWeight: "600", textAlign: "center" },
  shortcutSubtitle: { color: colors.muted, fontSize: 10, textAlign: "center" },
  records: { flexDirection: "row", gap: 12, paddingHorizontal: 2 },
  recordColumn: { flex: 1, gap: 4 },
  recordLabel: { color: colors.accent, fontSize: 11, fontWeight: "600" },
  record: { color: colors.ink, fontSize: 12, lineHeight: 18 },
  financeButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 46, backgroundColor: colors.pale, borderRadius: 16 },
  financeButtonText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  privacy: { flexDirection: "row", alignItems: "flex-start", gap: 7, paddingHorizontal: 3 },
  privacyText: { flex: 1, color: colors.muted, fontSize: 11, lineHeight: 18 },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 3, marginBottom: -7, marginTop: 4 },
  sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: "700" },
  more: { flexDirection: "row", alignItems: "center", gap: 1, minHeight: 40 },
  moreText: { color: colors.muted, fontSize: 11 },
  serviceGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  service: { width: "47%", flexGrow: 1, flexDirection: "row", alignItems: "center", gap: 8, minHeight: 72, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 20, backgroundColor: colors.white },
  serviceIcon: { width: 35, height: 39, borderRadius: 13, backgroundColor: colors.pale, alignItems: "center", justifyContent: "center" },
  serviceCopy: { flex: 1, gap: 4 },
  serviceTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  serviceSubtitle: { color: colors.muted, fontSize: 10, lineHeight: 15 },
  footer: { minHeight: 86, flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.white, borderRadius: 22, padding: 14, overflow: "hidden", marginTop: 3 },
  footerArt: { position: "absolute", right: -2, bottom: -4, width: 282, height: 94 },
  footerIcon: { width: 38, height: 38, borderRadius: 15, backgroundColor: colors.pale, alignItems: "center", justifyContent: "center" },
  footerCopy: { gap: 3, maxWidth: "72%" },
  footerText: { color: colors.ink, fontSize: 12, lineHeight: 19 },
  footerDash: { color: colors.muted, fontSize: 13 },
});
