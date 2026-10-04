import { useUi, ActionLink, ActionRow, CardHeader, IconAction, Field, PageHero, PageScrollView, ServiceTile, timeLabel } from "./ui";
import { Pressable, StyleSheet, Text, View, ScrollView } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import type { Conversation, Project, Schedule, Resource } from "./api";

import { useState } from "react";
import { BottomSheet } from "./BottomSheet";
import { emptyHomePreferences, homeEntries, targetKey, type HomePreferences, type HomeTarget } from "./homeEntries";

export function HomePanel({ conversations, projects = [], resources = [], preferences = emptyHomePreferences, preferencesReady = false, preferenceError, onPreferenceRetry, onTogglePin, onChat, onOpenConversation, onOpenProject, onOpenResource, onResources, onLife, onWork }: {
  conversations: Conversation[];
  projects?: Project[];
  resources?: Resource[];
  preferences?: HomePreferences;
  preferencesReady?: boolean;
  preferenceError?: string;
  onPreferenceRetry?: () => void;
  onTogglePin?: (target: HomeTarget) => void;
  onChat: () => void;
  onOpenConversation: (id: string) => void;
  onOpenProject?: (id: string) => void;
  onOpenResource?: (id: string) => void;
  onResources?: () => void;
  onLife: () => void;
  onWork: () => void;
}) {
  const { s } = useUi();
  const [managing, setManaging] = useState(false);
  const [query, setQuery] = useState("");
  const { pins, recent } = homeEntries(conversations, projects, resources, preferences);
  const candidates: HomeTarget[] = [...pins, ...projects.map((item) => ({ kind: "project" as const, id: item.id, title: item.name })), ...[...conversations].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((item) => ({ kind: "conversation" as const, id: item.id, title: item.title }))];
  const choices = [...new Map(candidates.map((item) => [targetKey(item), item])).values()].filter((item) => item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  function open(item: HomeTarget) {
    if (item.kind === "conversation") onOpenConversation(item.id);
    else if (item.kind === "project") onOpenProject?.(item.id);
    else onOpenResource?.(item.id);
  }
  const icon = (item: HomeTarget) => item.kind === "project" ? "folder-outline" : item.kind === "resource" ? "document-outline" : "chatbubble-outline";
  const kindLabel = (item: HomeTarget) => item.kind === "project" ? "项目" : item.kind === "resource" ? "文件" : "对话";
  return (
    <PageScrollView tabs>
      <PageHero eyebrow="HOME" title="首页" description="常用的留在手边，最近的接着看。" />
      <View style={s.sectionHeading}>
        <Text accessibilityRole="header" style={s.title}>常用</Text>
        {onTogglePin ? <ActionLink icon="options-outline" disabled={!preferencesReady} onPress={() => setManaging(true)}>整理</ActionLink> : null}
      </View>
      <View style={s.card}>
        <ActionRow icon="chatbubble-ellipses-outline" title="开始对话" description="说一句话，把事情交给知行" onPress={onChat} compact last={!pins.length} />
        {pins.map((item, index) => <ActionRow key={targetKey(item)} icon={icon(item)} title={item.title} description={kindLabel(item)} compact last={index === pins.length - 1} onPress={() => open(item)} tone={item.kind === "project" ? "blue" : "red"} />)}
      </View>
      <View style={s.serviceGrid}>
        <ServiceTile icon="leaf-outline" title="生活" description="财务与日常" onPress={onLife} tone="gold" />
        <ServiceTile icon="briefcase-outline" title="工作" description="项目与计划" onPress={onWork} tone="blue" />
      </View>
      {preferenceError ? <View><Text accessibilityRole="alert" style={s.error}>{preferenceError}</Text>{!preferencesReady && onPreferenceRetry ? <ActionLink icon="refresh-outline" onPress={onPreferenceRetry}>重试读取常用</ActionLink> : null}</View> : null}
      <View style={s.sectionHeading}>
        <Text accessibilityRole="header" style={s.title}>最近</Text>
        {onResources ? <ActionLink icon="folder-open-outline" tone="blue" onPress={onResources}>资源库</ActionLink> : null}
      </View>
      {recent.length ? <View style={s.card}>{recent.map((item, index) => <ActionRow key={targetKey(item)} icon={icon(item)} title={item.title} description={`${kindLabel(item)} · ${timeLabel(item.time)}`} compact last={index === recent.length - 1} onPress={() => open(item)} tone={item.kind === "conversation" ? "red" : "blue"} />)}</View> : <Text style={s.description}>聊过的话题和最近的文件会出现在这里。</Text>}
      <BottomSheet visible={managing} title="整理常用" subtitle="固定在首页，按加入顺序排列；偏好保存在这台设备。" onClose={() => setManaging(false)}>
        <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
          <Field label="查找对话或项目" value={query} onChangeText={setQuery} placeholder="输入名称" />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}>
          {choices.map((item) => {
            const pinned = pins.some((pin) => targetKey(pin) === targetKey(item));
            return <View key={targetKey(item)} style={s.row}>
              <View style={s.grow}><Text numberOfLines={1} style={s.itemTitle}>{item.title}</Text><Text style={s.muted}>{kindLabel(item)}</Text></View>
              <IconAction icon={pinned ? "bookmark" : "bookmark-outline"} label={`${pinned ? "取消固定" : "固定"}：${item.title}`} onPress={() => onTogglePin?.(item)} />
            </View>;
          })}
          {!choices.length ? <Text style={s.muted}>没有匹配的内容，也可以在对话或项目页直接固定。</Text> : null}
        </ScrollView>
      </BottomSheet>
    </PageScrollView>
  );
}

export function WorkPanel({ conversations, projects, schedules, onOpenConversation, onChooseConversation, onCreateProject, onOpenProject, onProjects, onSchedules }: {
  conversations: Conversation[];
  projects: Project[];
  schedules: Schedule[];
  onOpenConversation: (id: string) => void;
  onChooseConversation: () => void;
  onCreateProject: () => void;
  onOpenProject?: (id: string) => void;
  onProjects?: () => void;
  onSchedules: () => void;
}) {
  const { s, colors } = useUi();
  const recent = [...conversations].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 3);
  return (
    <PageScrollView tabs>
      <PageHero eyebrow="WORK" title="工作" description="按项目继续对话，把要做的事安排好。"
        art={require("../assets/work-header-red.png")} artStyle={styles.workArtwork} />
      <View style={s.card}>
        <CardHeader icon="chatbubbles-outline" title="最近对话" tone="red" action={
          <Pressable accessibilityRole="button" accessibilityLabel="全部对话" onPress={onChooseConversation} style={({ pressed }) => [s.linkButton, pressed && s.pressed]}>
            <Text style={s.link}>全部</Text><Ionicons name="chevron-forward" size={15} color={colors.accent} />
          </Pressable>
        } />
        {recent.length ? <View>{recent.map((conversation, index) => (
          <ActionRow key={conversation.id} icon={conversation.agent_id === "finance" ? "stats-chart-outline" : "chatbubble-outline"} tone={conversation.agent_id === "finance" ? "gold" : "red"}
            title={conversation.title} description={timeLabel(conversation.updated_at)} compact last={index === recent.length - 1}
            onPress={() => onOpenConversation(conversation.id)} />
        ))}</View> : <Text style={s.description}>还没有对话。普通聊天也可以从 AI 页开始。</Text>}
      </View>
      <View style={s.card}>
        <CardHeader icon="folder-outline" title="项目" description={projects.length ? `${projects.length} 个项目` : "把相关对话和资料放在一起"} tone="blue" action={<IconAction icon="add" label="创建项目" onPress={onCreateProject} tone="blue" />} />
        {projects.slice(0, 4).map((project, index, all) => <ActionRow key={project.id} icon="folder-open-outline" title={project.name} compact last={index === all.length - 1} tone="blue" onPress={() => onOpenProject?.(project.id)} />)}
        {onProjects ? <ActionLink icon="list-outline" tone="blue" onPress={onProjects}>全部项目</ActionLink> : null}
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
});
