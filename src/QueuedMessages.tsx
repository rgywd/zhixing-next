import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import type { Connection, Run } from "./api";
import type { QueuedMessageItem } from "./useQueuedMessages";
import { Attachments } from "./Attachments";
import { BottomSheet } from "./BottomSheet";
import { ResourceImage } from "./ResourcePreview";
import { useThemedStyles } from "./ThemeProvider";
import { layout, radius, space, typography, type ThemeColors } from "./theme";
import { ActionLink, Button, timeLabel, useUi } from "./ui";

type Props = {
  connection: Connection;
  items: QueuedMessageItem[];
  running?: Run | null;
  busyId: string | null;
  error: string;
  onWithdraw: (item: QueuedMessageItem) => Promise<void>;
  onSteer: (item: QueuedMessageItem) => Promise<void>;
  onOpenRun: (id: string) => void;
};

const preview = (item: QueuedMessageItem) => item.text.trim().replace(/\s+/g, " ")
  || (item.attachments.length ? `${item.attachments.length} 个附件` : "待发送消息");

/** One compact queue above the model row; full contents and recovery stay in its sheet. */
export function QueuedMessages({ connection, items, running, busyId, error, onWithdraw, onSteer, onOpenRun }: Props) {
  const { s, colors } = useUi();
  const styles = useThemedStyles(createStyles);
  const [view, setView] = useState<string | null>(null);
  const selected = items.find((item) => item.run.id === view);
  if (view && (!items.length || (view !== "list" && !selected))) setView(items.length ? "list" : null);
  if (!items.length) return null;
  const first = items[0];
  const thumbnail = first.attachments.find((item) => item.mime_type.startsWith("image/"));
  const canSteer = running?.status === "running" && !running.cancel_requested && !busyId;
  const act = (action: Props["onWithdraw"], item: QueuedMessageItem) => { void action(item).catch(() => undefined); };
  const openRun = (id: string) => { setView(null); onOpenRun(id); };
  return <>
    <View style={styles.bar} testID="queued-message-strip">
      <Pressable accessibilityRole="button" accessibilityLabel={`查看待发送消息：${preview(first)}${error ? "，操作未完成，可打开重试" : ""}`}
        onPress={() => setView(first.run.id)} style={styles.summary}>
        <Ionicons name={error ? "alert-circle-outline" : "list-outline"} size={16} color={error ? colors.red : colors.muted} />
        {thumbnail ? <View pointerEvents="none"><ResourceImage connection={connection} resource={thumbnail} style={styles.thumbnail} /></View> : null}
        <Text numberOfLines={1} ellipsizeMode="tail" style={styles.preview}>{preview(first)}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="将待发送消息引导到当前回复"
        accessibilityState={{ disabled: !canSteer, busy: busyId === first.run.id }} disabled={!canSteer}
        onPress={() => act(onSteer, first)} style={[styles.guide, !canSteer && styles.disabled]}>
        {busyId === first.run.id ? <ActivityIndicator size="small" color={colors.muted} /> : <Ionicons name="return-down-forward-outline" size={15} color={colors.muted} />}
        <Text numberOfLines={1} style={styles.actionText}>引导</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="撤回这条待发送消息" accessibilityState={{ disabled: !!busyId }}
        disabled={!!busyId} onPress={() => act(onWithdraw, first)} style={[styles.iconAction, !!busyId && styles.disabled]}>
        <Ionicons name="trash-outline" size={17} color={colors.muted} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`更多待发送消息，共 ${items.length} 条`} onPress={() => setView("list")} style={styles.iconAction}>
        {items.length > 1 ? <Text numberOfLines={1} style={styles.actionText}>+{items.length - 1}</Text> : <Ionicons name="ellipsis-horizontal" size={18} color={colors.muted} />}
      </Pressable>
    </View>
    <BottomSheet visible={!!view} title={selected ? "待发送消息" : `等待发送 · ${items.length} 条`} onClose={() => setView(null)}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
        {error ? <Text accessibilityRole="alert" style={s.error}>{error}。操作未确认，请查看最新队列后重试。</Text> : null}
        {selected ? <>
          {items.length > 1 ? <ActionLink icon="chevron-back" tone="neutral" onPress={() => setView("list")}>查看全部待发送消息</ActionLink> : null}
          <Text style={s.muted}>尚未开始 · {timeLabel(selected.run.created_at)}</Text>
          {selected.text ? <Text selectable style={s.text}>{selected.text}</Text> : null}
          <Attachments connection={connection} items={selected.attachments} />
          <ActionLink icon="receipt-outline" tone="neutral" onPress={() => openRun(selected.run.id)}>查看处理记录</ActionLink>
          <Button secondary disabled={!canSteer} icon="return-down-forward-outline" onPress={() => act(onSteer, selected)}>引导到当前回复</Button>
          {!running || running.cancel_requested ? <Text style={s.muted}>当前没有可补充的回复，会按顺序接着处理。</Text> : null}
          <Button secondary disabled={!!busyId} icon="trash-outline" onPress={() => act(onWithdraw, selected)}>撤回这条消息</Button>
        </> : items.map((item) => <View key={item.run.id} style={styles.listItem}>
          <Pressable accessibilityRole="button" accessibilityLabel={`查看待发送消息：${preview(item)}`} onPress={() => setView(item.run.id)} style={styles.listSummary}>
            <View style={s.grow}><Text numberOfLines={2} style={s.text}>{preview(item)}</Text><Text style={s.muted}>尚未开始 · {timeLabel(item.run.created_at)}{item.attachments.length ? ` · ${item.attachments.length} 个附件` : ""}</Text></View>
            <Ionicons name="chevron-forward" size={17} color={colors.muted} />
          </Pressable>
          <View style={styles.listActions}>
            <ActionLink icon="return-down-forward-outline" tone="neutral" disabled={!canSteer} onPress={() => act(onSteer, item)}>引导</ActionLink>
            <ActionLink icon="trash-outline" tone="neutral" disabled={!!busyId} onPress={() => act(onWithdraw, item)}>撤回</ActionLink>
          </View>
        </View>)}
      </ScrollView>
    </BottomSheet>
  </>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  bar: { flexDirection: "row", flexWrap: "nowrap", alignItems: "center", minHeight: layout.touchTarget, paddingHorizontal: 5, borderRadius: radius.item, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.neutral, shadowColor: colors.shadow, shadowOpacity: 0.14, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 5 },
  summary: { flex: 1, minWidth: 0, minHeight: layout.touchTarget, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 3 },
  thumbnail: { width: 26, height: 26, borderRadius: 4 },
  preview: { ...typography.detail, color: colors.ink, flex: 1, minWidth: 0 },
  iconAction: { minWidth: 40, minHeight: layout.touchTarget, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  guide: { minWidth: 48, minHeight: layout.touchTarget, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 3, paddingHorizontal: 3, flexShrink: 0 },
  actionText: { ...typography.caption, color: colors.muted, flexShrink: 0 },
  disabled: { opacity: 0.4 },
  listItem: { paddingBottom: space.sm, borderBottomWidth: 1, borderBottomColor: colors.line, gap: space.xs },
  listSummary: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: layout.touchTarget },
  listActions: { flexDirection: "row", gap: space.lg },
});
