import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import type { Conversation, Project, Schedule } from "./api";
import { ActionRow, Button, CardHeader, PageHero, PageScrollView, ServiceTile, colors, s, timeLabel } from "./ui";

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
        <CardHeader icon="chatbubbles-outline" title="想聊聊，还是开始一件事？" />
        <Text style={s.description}>需要研究、处理文件或继续上次的话题，都可以交给知行。</Text>
        <Button icon="chatbubble-ellipses-outline" onPress={onChat}>打开 AI 对话</Button>
      </View>
      <View style={s.card}>
        <CardHeader icon="time-outline" title="接着上次" />
        <ActionRow icon="chatbubble-outline" title={recent?.title ?? "还没有对话"}
          description={recent ? `${timeLabel(recent.updated_at)} · 继续这段对话` : "在 AI 页开始第一段对话，以后可以从这里接着聊。"}
          onPress={() => recent ? onOpenConversation(recent.id) : onChat()} last />
      </View>
      <View style={s.sectionHeading}><Text accessibilityRole="header" style={s.title}>生活与工作</Text></View>
      <View style={s.serviceGrid}>
        <ServiceTile icon="leaf-outline" title="生活" description="先从财务服务开始" onPress={onLife} />
        <ServiceTile icon="briefcase-outline" title="工作" description="对话、项目与计划" onPress={onWork} />
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
        <CardHeader icon="chatbubbles-outline" title="最近对话" description="接着上次的话题继续。" action={
          <Pressable accessibilityRole="button" accessibilityLabel="全部对话" onPress={onChooseConversation} style={({ pressed }) => [s.linkButton, pressed && s.pressed]}>
            <Text style={s.link}>全部</Text><Ionicons name="chevron-forward" size={15} color={colors.accent} />
          </Pressable>
        } />
        {recent.length ? <View>{recent.map((conversation, index) => (
          <ActionRow key={conversation.id} icon={conversation.agent_id === "finance" ? "stats-chart-outline" : "chatbubble-outline"}
            title={conversation.title} description={timeLabel(conversation.updated_at)} compact last={index === recent.length - 1}
            onPress={() => onOpenConversation(conversation.id)} />
        ))}</View> : <Text style={s.description}>还没有对话。普通聊天也可以从 AI 页开始。</Text>}
      </View>
      <View style={s.card}>
        <CardHeader icon="folder-outline" title="项目" description={projects.length ? `${projects.length} 个项目` : "把相关对话和资料放在一起。"} action={<Pressable accessibilityRole="button" accessibilityLabel="创建项目" onPress={onCreateProject} style={s.iconButton}><Ionicons name="add" size={24} color={colors.ink} /></Pressable>} />
        {projects.slice(0, 4).map((project) => <Text key={project.id} style={s.text}>· {project.name}</Text>)}
        {projects.length > 4 ? <Text style={s.muted}>还有 {projects.length - 4} 个项目</Text> : null}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="定时计划" onPress={onSchedules} style={({ pressed }) => [s.card, pressed && s.pressed]}>
        <CardHeader icon="time-outline" title="定时计划" description={schedules.length ? `已有 ${schedules.length} 项计划` : "还没有计划"}
          action={<View style={s.row}><Text style={s.link}>管理</Text><Ionicons name="chevron-forward" size={18} color={colors.accent} /></View>} />
      </Pressable>
    </PageScrollView>
  );
}

export function ToolboxPanel({ onSettings, onAgents, onModels, onResources }: { onSettings: () => void; onAgents: () => void; onModels: () => void; onResources: () => void }) {
  return (
    <PageScrollView tabs>
      <PageHero eyebrow="TOOLBOX" title="工具箱" description="资源、服务与助手设置，按需要放进来。" />
      <View style={s.card}>
        <ActionRow icon="albums-outline" title="资源库" description="图片、资料和知行交付的文件" onPress={onResources} last compact />
      </View>
      <View style={s.card}>
        <CardHeader icon="apps-outline" title="助手与服务" description="管理服务助手、模型和你的个人设置。" />
        <View>
          <ActionRow icon="people-outline" title="管理子智能体" description="固定助手与自定义助手" onPress={onAgents} />
          <ActionRow icon="options-outline" title="供应商与模型" description="聊天、执行和记忆整理" onPress={onModels} />
          <ActionRow icon="settings-outline" title="人格与连接设置" description="称呼、表达方式与服务连接" onPress={onSettings} last />
        </View>
      </View>
    </PageScrollView>
  );
}

const styles = StyleSheet.create({
  workArtwork: { left: -16, right: undefined, top: -4, width: "110%", height: 130, opacity: 0.88 },
});
