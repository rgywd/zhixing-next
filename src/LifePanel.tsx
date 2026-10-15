import type { ReactNode } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import type { ThemeColors } from "./theme";
import { radius, typography } from "./theme";
import { useThemedStyles } from "./ThemeProvider";
import { ActionRow, CardHeader, IconBadge, PageHero, PageScrollView, ServiceTile, useUi } from "./ui";

const services = [
  { title: "购物", subtitle: "购物清单，挑选思路", icon: "cart-outline", prompt: "帮我整理购物需求和挑选思路：" },
  { title: "出行", subtitle: "行程想法，出发准备", icon: "airplane-outline", prompt: "和我一起规划这次出行：" },
  { title: "家居", subtitle: "家居灵感，生活技巧", icon: "home-outline", prompt: "帮我想想家居和日常生活的改善办法：" },
] as const;

export function LifePanel({ onFinance, onHealth, onChat, intro }: {
  onFinance: () => void;
  onHealth: () => void;
  onChat: (prompt: string) => void;
  intro?: ReactNode;
}) {
  const { s, mode } = useUi();
  const styles = useThemedStyles(createStyles);
  return (
    <PageScrollView tabs>
      <PageHero eyebrow="LIFE" title="生活" description="打理收支、饮食和体重，也聊聊日常生活。" art={require("../assets/life-header-red.png")} />

      {intro ?? <View style={s.serviceGrid}>
        <ServiceTile title="财务" description="收支记录、预算与结余目标" icon="wallet-outline" accessibilityLabel="打开财务" onPress={onFinance} tone="gold" />
        <ServiceTile title="健康" description="饮食建议、体重与日常记录" icon="restaurant-outline" accessibilityLabel="打开健康" onPress={onHealth} tone="blue" />
      </View>}

      <View style={s.card}>
        <CardHeader icon="chatbubbles-outline" title="其他生活服务" description="和知行聊聊你的想法" />
        {services.map((item, index) => (
          <ActionRow key={item.title} title={item.title} description={item.subtitle} icon={item.icon} onPress={() => onChat(item.prompt)} compact last={index === services.length - 1} tone="gold" />
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
  footer: { minHeight: 86, flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.surfaceRaised, borderRadius: radius.item, padding: 14, overflow: "hidden", marginTop: 3 },
  footerArt: { position: "absolute", right: -2, bottom: -4, width: 282, height: 94 },
  footerCopy: { gap: 3, maxWidth: "72%" },
  footerText: { ...typography.detail, color: colors.ink },
  footerDash: { ...typography.body, color: colors.khaki },
});
