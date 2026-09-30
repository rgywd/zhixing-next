import type { ThemeColors } from "./theme";
import { useUi, ActionLink, IconBadge, PageHero, PageScrollView, ServiceTile } from "./ui";
import { useThemedStyles } from "./ThemeProvider";
import { Image, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import type { FinanceSummary } from "./api";

import { layout, radius, space, typography } from "./theme";

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
  const { s, colors, mode } = useUi();
  const styles = useThemedStyles(createStyles);
  const narrow = useWindowDimensions().width < layout.compactWidth;
  return (
    <PageScrollView tabs>
      <PageHero eyebrow="LIFE" title="生活" description="生活里的琐碎，从真正用得上的一项开始。" art={require("../assets/life-header-red.png")} />

      <View style={s.card}>
        <View style={s.row}>
          <IconBadge name="wallet-outline" tone="gold" />
          <Pressable accessibilityRole="button" accessibilityLabel="打开财务" onPress={onFinance} style={styles.financeTitleLink}>
            <Text style={s.heading}>财务</Text>
            <Ionicons name="chevron-forward" size={21} color={colors.ink} />
          </Pressable>
          {!narrow ? <View style={styles.assistantBadge}><Ionicons name="sparkles" size={13} color={colors.gold} /><Text style={styles.assistantBadgeText}>财务助手</Text></View> : null}
        </View>
        <Text style={s.description}>和财务助手聊账户、收支与财务问题。</Text>
        <View style={styles.shortcuts}>
          {financeShortcuts.map((item) => (
            <Pressable key={item.title} accessibilityRole="button" accessibilityLabel={`打开财务助手，${item.title}`} onPress={onFinance} style={({ pressed }) => [styles.shortcut, narrow && styles.shortcutNarrow, pressed && s.pressed]}>
              <View style={styles.shortcutIcon}><Ionicons name={item.icon} size={20} color={colors.gold} /></View>
              <Text style={styles.shortcutTitle}>{item.title}</Text>
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
        <ActionLink icon="chatbubble-ellipses-outline" tone="gold" onPress={onFinance}>和财务助手聊聊</ActionLink>
        <View style={styles.privacy}>
          <Ionicons name="shield-checkmark-outline" size={17} color={colors.muted} />
          <Text style={styles.privacyText}>只显示你提供的财务信息，不会自动读取账户。</Text>
        </View>
      </View>

      <View style={s.sectionHeading}>
        <Text accessibilityRole="header" style={s.title}>其他生活服务</Text>
        <Pressable accessibilityRole="button" onPress={() => onChat("想和你聊聊我的日常生活：")} style={s.linkButton}>
          <Text style={s.muted}>问问知行</Text>
          <Ionicons name="chevron-forward" size={15} color={colors.muted} />
        </Pressable>
      </View>
      <View style={s.serviceGrid}>
        {services.map((item) => (
          <ServiceTile key={item.title} accessibilityLabel={`和知行聊${item.title}`} title={item.title} description={item.subtitle} icon={item.icon} onPress={() => onChat(item.prompt)} tone="gold" />
        ))}
      </View>

      <View style={styles.footer}>
        {mode === "light" ? <Image source={require("../assets/life-footer-red.png")} resizeMode="contain" style={styles.footerArt} accessible={false} /> : null}
        <IconBadge name="leaf-outline" small />
        <View style={styles.footerCopy}>
          <Text style={styles.footerText}>把生活的琐碎，{"\n"}变成值得期待的日常。</Text>
          <Text style={styles.footerDash}>—</Text>
        </View>
      </View>
    </PageScrollView>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  financeTitleLink: { flex: 1, flexDirection: "row", alignItems: "center", gap: 3, minHeight: 44 },
  assistantBadge: { flexDirection: "row", alignItems: "center", gap: space.xs, backgroundColor: colors.goldSoft, borderRadius: 15, paddingHorizontal: 9, paddingVertical: 7 },
  assistantBadgeText: { ...typography.caption, color: colors.gold, fontWeight: "600" },
  shortcuts: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  shortcut: { flexGrow: 1, flexBasis: "21%", alignItems: "center", backgroundColor: colors.surfaceRaised, borderRadius: radius.control, paddingVertical: 8, gap: space.xs, borderWidth: 1, borderColor: colors.line },
  shortcutNarrow: { flexBasis: "43%" },
  shortcutIcon: { width: 30, height: 30, borderRadius: radius.small, backgroundColor: colors.goldSoft, alignItems: "center", justifyContent: "center" },
  shortcutTitle: { ...typography.detail, color: colors.ink, fontWeight: "600", textAlign: "center" },
  records: { flexDirection: "row", gap: space.md, paddingHorizontal: 2 },
  recordColumn: { flex: 1, gap: space.xs },
  recordLabel: { ...typography.caption, color: colors.accent, fontWeight: "600" },
  record: { ...typography.detail, color: colors.ink },
  privacy: { flexDirection: "row", alignItems: "flex-start", gap: 7, paddingHorizontal: 3 },
  privacyText: { flex: 1, ...typography.caption, color: colors.muted },
  footer: { minHeight: 86, flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.surfaceRaised, borderRadius: radius.item, padding: 14, overflow: "hidden", marginTop: 3 },
  footerArt: { position: "absolute", right: -2, bottom: -4, width: 282, height: 94 },
  footerCopy: { gap: 3, maxWidth: "72%" },
  footerText: { ...typography.detail, color: colors.ink },
  footerDash: { ...typography.body, color: colors.khaki },
});
