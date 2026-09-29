import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import type { Conversation, Project, Schedule } from "./api";
import { ActionLink, ActionRow, CardHeader, IconAction, PageHero, PageScrollView, ServiceTile, colors, s, timeLabel } from "./ui";

export function HomePanel({ conversations, onChat, onOpenConversation, onLife, onWork }: {
  conversations: Conversation[];
  onChat: () => void;
  onOpenConversation: (id: string) => void;
  onLife: () => void;
  onWork: () => void;
}) {
  const recent = [...conversations].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  return (
    <PageScrollView tabs>
      <PageHero eyebrow="HOME" title="首页" description="你的个人助手，从一句话开始。" />
      <View style={s.card}>
        <CardHeader icon="sparkles-outline" title="交给知行" description="聊天、研究、处理文件，从一句话开始。" tone="purple" />
        <ActionLink icon="chatbubble-ellipses-outline" onPress={onChat} tone="purple">开始对话</ActionLink>
      </View>
      <View style={s.card}>
        <Text accessibilityRole="header" style={s.label}>接着上次</Text>
        <ActionRow icon="chatbubble-outline" title={recent?.title ?? "还没有对话"}
          description={recent ? timeLabel(recent.updated_at) : "从一段新对话开始"}
          onPress={() => recent ? onOpenConversation(recent.id) : onChat()} last />
      </View>
      <View style={s.sectionHeading}><Text accessibilityRole="header" style={s.title}>生活与工作</Text></View>
      <View style={s.serviceGrid}>
        <ServiceTile icon="leaf-outline" title="生活" description="财务与日常" onPress={onLife} tone="green" />
        <ServiceTile icon="briefcase-outline" title="工作" description="对话与计划" onPress={onWork} tone="blue" />
      </View>
    </PageScrollView>
  );
}

export function WorkPanel({ conversations, projects, schedules, onOpenConversation, onChooseConversation, onCreateProject, onSchedules }: {
  conversations: Conversation[];
  projects: Project[];
  schedules: Schedule[];
  onOpenConversation: (id: string) => void;
  onChooseConversation: () => void;
  onCreateProject: () => void;
  onSchedules: () => void;
}) {
  const recent = [...conversations].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 3);
  return (
    <PageScrollView tabs>
      <PageHero eyebrow="WORK" title="工作" description="对话、项目和任务会在这里逐步连起来。"
        art={require("../assets/work-header-red.png")} artStyle={styles.workArtwork} />
      <View style={s.card}>
        <CardHeader icon="chatbubbles-outline" title="最近对话" tone="purple" action={
          <Pressable accessibilityRole="button" accessibilityLabel="全部对话" onPress={onChooseConversation} style={({ pressed }) => [s.linkButton, pressed && s.pressed]}>
            <Text style={s.link}>全部</Text><Ionicons name="chevron-forward" size={15} color={colors.accent} />
          </Pressable>
        } />
        {recent.length ? <View>{recent.map((conversation, index) => (
          <ActionRow key={conversation.id} icon={conversation.agent_id === "finance" ? "stats-chart-outline" : "chatbubble-outline"} tone={conversation.agent_id === "finance" ? "green" : "purple"}
            title={conversation.title} description={timeLabel(conversation.updated_at)} compact last={index === recent.length - 1}
            onPress={() => onOpenConversation(conversation.id)} />
        ))}</View> : <Text style={s.description}>还没有对话。普通聊天也可以从 AI 页开始。</Text>}
      </View>
      <View style={s.card}>
        <CardHeader icon="folder-outline" title="项目" description={projects.length ? `${projects.length} 个项目` : "把相关对话和资料放在一起"} tone="blue" action={<IconAction icon="add" label="创建项目" onPress={onCreateProject} tone="blue" />} />
        {projects.slice(0, 4).map((project) => <View key={project.id} style={styles.projectRow}><Ionicons name="folder-open-outline" size={17} color={colors.blue} /><Text numberOfLines={1} style={s.itemTitle}>{project.name}</Text></View>)}
        {projects.length > 4 ? <Text style={s.muted}>还有 {projects.length - 4} 个项目</Text> : null}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="定时计划" onPress={onSchedules} style={({ pressed }) => [s.card, pressed && s.pressed]}>
        <CardHeader icon="time-outline" title="定时计划" tone="gold" description={schedules.length ? `已有 ${schedules.length} 项计划` : "把要惦记的事交给知行"}
          action={<View style={s.row}><Text style={s.link}>管理</Text><Ionicons name="chevron-forward" size={18} color={colors.accent} /></View>} />
      </Pressable>
    </PageScrollView>
  );
}

const styles = StyleSheet.create({
  workArtwork: { left: -16, right: undefined, top: -4, width: "110%", height: 130, opacity: 0.88 },
  projectRow: { flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 5 },
});
