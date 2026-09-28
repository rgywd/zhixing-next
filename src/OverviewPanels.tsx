import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Conversation, FinanceSummary, Project, Schedule } from "./api";
import { Button, colors, s, timeLabel } from "./ui";

const styles = StyleSheet.create({
  page: { paddingBottom: 32 },
  intro: { gap: 7 },
  kicker: { color: colors.green, fontSize: 12, fontWeight: "700" },
  pageTitle: { color: colors.ink, fontSize: 29, fontWeight: "700" },
  description: { color: colors.muted, fontSize: 14, lineHeight: 22 },
  hero: {
    backgroundColor: colors.pale,
    borderRadius: 24,
    padding: 23,
    gap: 15,
  },
  heroTitle: { color: colors.ink, fontSize: 27, lineHeight: 37, fontWeight: "700" },
  section: { color: colors.ink, fontSize: 17, fontWeight: "700" },
  link: { color: colors.green, fontSize: 14, fontWeight: "600" },
  cardTitle: { color: colors.ink, fontSize: 19, fontWeight: "700" },
  split: { flexDirection: "row", gap: 10 },
  half: { flex: 1, minHeight: 116, justifyContent: "space-between" },
  placeholder: {
    flex: 1,
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.line,
    minHeight: 92,
    padding: 14,
    justifyContent: "space-between",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
  },
  list: { gap: 10 },
  listItem: {
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingBottom: 10,
    gap: 4,
  },
  lastItem: { borderBottomWidth: 0, paddingBottom: 0 },
  tag: {
    color: colors.green,
    backgroundColor: colors.pale,
    overflow: "hidden",
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 5,
    fontSize: 11,
    fontWeight: "600",
  },
});

export function HomePanel({
  conversations,
  onChat,
  onOpenConversation,
  onLife,
  onWork,
}: {
  conversations: Conversation[];
  onChat: () => void;
  onOpenConversation: (id: string) => void;
  onLife: () => void;
  onWork: () => void;
}) {
  const recent = [...conversations].sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at),
  )[0];
  return (
    <ScrollView contentContainerStyle={[s.content, styles.page]}>
      <View style={styles.hero}>
        <Text style={styles.kicker}>你的个人助手</Text>
        <Text style={styles.heroTitle}>想聊聊，还是开始一件事？</Text>
        <Text style={styles.description}>
          从一句话开始。需要研究、处理文件或继续上次的话题，都可以交给知行。
        </Text>
        <Button onPress={onChat}>打开 AI 对话</Button>
      </View>
      <Text style={styles.section}>接着上次</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => (recent ? onOpenConversation(recent.id) : onChat())}
        style={s.card}
      >
        <Text style={styles.cardTitle}>{recent?.title ?? "还没有对话"}</Text>
        <Text style={styles.description}>
          {recent
            ? `${timeLabel(recent.updated_at)} · 继续这段对话`
            : "在 AI 页开始第一段对话，以后可以从这里接着聊。"}
        </Text>
        <Text style={styles.link}>前往对话 ›</Text>
      </Pressable>
      <View style={styles.split}>
        <Pressable accessibilityRole="button" onPress={onLife} style={[s.card, styles.half]}>
          <Text style={styles.cardTitle}>生活</Text>
          <Text style={styles.description}>先从财务服务开始</Text>
          <Text style={styles.link}>看看轮廓 ›</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onWork} style={[s.card, styles.half]}>
          <Text style={styles.cardTitle}>工作</Text>
          <Text style={styles.description}>对话、项目与计划</Text>
          <Text style={styles.link}>进入工作 ›</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

export function LifePanel({ onFinance, finance = { balances: [], recent: [] } }: { onFinance: () => void; finance?: FinanceSummary }) {
  return (
    <ScrollView contentContainerStyle={[s.content, styles.page]}>
      <View style={styles.intro}>
        <Text style={styles.kicker}>LIFE</Text>
        <Text style={styles.pageTitle}>生活</Text>
        <Text style={styles.description}>生活里的服务，从真正用得上的一项开始。</Text>
      </View>
      <View style={s.card}>
        <View style={styles.row}>
          <Text style={styles.cardTitle}>财务</Text>
          <Text style={styles.tag}>财务助手</Text>
        </View>
        <Text style={styles.description}>
          和财务助手聊账户、收支与扣费问题。明确告诉它金额后，记录会出现在这里。
        </Text>
        <View style={styles.split}>
          <View style={styles.placeholder}>
            <Text style={s.label}>账户一览</Text>
            {finance.balances.length ? finance.balances.slice(0, 4).map((item) => (
              <Text key={item.id} style={s.text}>{item.platform} · ¥{item.amount}</Text>
            )) : <Text style={s.muted}>等待真实记录</Text>}
          </View>
          <View style={styles.placeholder}>
            <Text style={s.label}>收支变化</Text>
            {finance.recent.length ? finance.recent.slice(0, 4).map((item) => (
              <Text key={item.id} style={s.text}>{item.kind === "income" ? "收入" : "支出"} · {item.platform} ¥{item.amount}</Text>
            )) : <Text style={s.muted}>等待真实记录</Text>}
          </View>
        </View>
        <Text style={s.muted}>仅显示你提供的观察值，不自动读取账户、对账或推算总资产；截图理解尚未接入。</Text>
        <Button secondary onPress={onFinance}>和财务助手聊</Button>
      </View>
    </ScrollView>
  );
}

export function WorkPanel({
  conversations,
  projects,
  schedules,
  onOpenConversation,
  onChooseConversation,
  onSchedules,
}: {
  conversations: Conversation[];
  projects: Project[];
  schedules: Schedule[];
  onOpenConversation: (id: string) => void;
  onChooseConversation: () => void;
  onSchedules: () => void;
}) {
  const recent = [...conversations]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 3);
  return (
    <ScrollView contentContainerStyle={[s.content, styles.page]}>
      <View style={styles.intro}>
        <Text style={styles.kicker}>WORK</Text>
        <Text style={styles.pageTitle}>工作</Text>
        <Text style={styles.description}>对话、项目和任务会在这里逐步连起来。</Text>
      </View>
      <View style={s.card}>
        <View style={styles.row}>
          <Text style={styles.section}>最近对话</Text>
          <Pressable accessibilityRole="button" onPress={onChooseConversation}>
            <Text style={styles.link}>全部 ›</Text>
          </Pressable>
        </View>
        {recent.length ? (
          <View style={styles.list}>
            {recent.map((conversation, index) => (
              <Pressable
                key={conversation.id}
                accessibilityRole="button"
                onPress={() => onOpenConversation(conversation.id)}
                style={[styles.listItem, index === recent.length - 1 && styles.lastItem]}
              >
                <Text numberOfLines={1} style={s.label}>{conversation.title}</Text>
                <Text style={s.muted}>{timeLabel(conversation.updated_at)}</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <Text style={styles.description}>还没有对话。普通聊天也可以从 AI 页开始。</Text>
        )}
        <Text style={s.muted}>置顶对话会在这里加入，当前先显示最近对话。</Text>
      </View>
      <View style={s.card}>
        <Text style={styles.section}>项目</Text>
        {projects.length ? (
          projects.slice(0, 4).map((project) => (
            <Text key={project.id} style={s.text}>· {project.name}</Text>
          ))
        ) : (
          <Text style={styles.description}>还没有项目。需要持久工作目录时，再从对话里创建。</Text>
        )}
        {projects.length > 4 ? <Text style={s.muted}>还有 {projects.length - 4} 个项目</Text> : null}
      </View>
      <Pressable accessibilityRole="button" onPress={onSchedules} style={s.card}>
        <View style={styles.row}>
          <Text style={styles.section}>定时计划</Text>
          <Text style={styles.link}>管理 ›</Text>
        </View>
        <Text style={styles.description}>
          {schedules.length ? `已有 ${schedules.length} 项计划` : "还没有计划，可以从这里安排一件事。"}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

export function ToolboxPanel({ onSettings, onAgents, onModels }: { onSettings: () => void; onAgents: () => void; onModels: () => void }) {
  return (
    <ScrollView contentContainerStyle={[s.content, styles.page]}>
      <View style={styles.intro}>
        <Text style={styles.kicker}>TOOLBOX</Text>
        <Text style={styles.pageTitle}>工具箱</Text>
        <Text style={styles.description}>资源、服务与助手设置，按需要放进来。</Text>
      </View>
      <View style={s.card}>
        <View style={styles.row}>
          <Text style={styles.cardTitle}>资源库</Text>
          <Text style={styles.tag}>正在搭建</Text>
        </View>
        <Text style={styles.description}>
          以后上传和生成的图片、文件产物会统一放在这里。当前会话的文件仍可在 AI 对话中查看。
        </Text>
        <View style={styles.split}>
          <View style={styles.placeholder}><Text style={s.label}>图片</Text></View>
          <View style={styles.placeholder}><Text style={s.label}>文件</Text></View>
        </View>
      </View>
      <View style={s.card}>
        <Text style={styles.cardTitle}>助手与服务</Text>
        <Text style={styles.description}>
          管理固定的服务助手和你创建的助手；每个助手只使用已绑定的工具。
        </Text>
        <Button secondary onPress={onAgents}>管理子智能体</Button>
        <Button secondary onPress={onModels}>供应商与模型</Button>
        <Button secondary onPress={onSettings}>人格与连接设置</Button>
      </View>
    </ScrollView>
  );
}
