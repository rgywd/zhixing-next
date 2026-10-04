import { useUi, ActionLink, Button, Empty, Field, IconAction, PageHeading, PageScrollView, StatusPill, humanError, timeLabel } from "./ui";
import { useEffect, useRef, useState } from "react";
import { Alert, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import * as Crypto from "expo-crypto";
import { prepareSchedule, request, type Connection, type Conversation, type Schedule, type PlanDraft } from "./api";
import { clearPlanDraft, readPlanDraft, savePlanDraft } from "./storage";
import { openSystemCalendar } from "./deviceCapabilities";
import { scheduleCalendarEvent } from "./deviceCapabilityLogic";
import { useNotice } from "./Notice";
import { ScheduleConversationPicker, ScheduleDatePicker } from "./SchedulePickers";
import { dateOffset, localDateTime, scheduleDateLabel, scheduleDestination, scheduleIntervalLabel, scheduleRepeat, scheduleTriggered, type ScheduleRepeat } from "./scheduleForm";
import { space } from "./theme";

const nextHour = () => localDateTime(new Date(Date.now() + 3600000));
const repeatOptions: { id: ScheduleRepeat; label: string; interval: string }[] = [
  { id: "once", label: "一次", interval: "" },
  { id: "daily", label: "每天", interval: "1440" },
  { id: "weekly", label: "每周", interval: "10080" },
  { id: "custom", label: "自定", interval: "60" },
];

export function SchedulesPanel({ connection, schedules, conversation, conversations = [], conversationName,
  onRefresh, onChanged, hasMore, loadMore, hasMoreConversations, onLoadMoreConversations, onOpenConversation,
  conversationLoading, conversationError,
}: {
  connection: Connection;
  schedules: Schedule[];
  conversation: Conversation | null;
  conversations?: Conversation[];
  conversationName: (id: string) => string;
  onRefresh: () => void;
  onChanged: (schedule: Schedule) => void;
  hasMore: boolean;
  loadMore: () => void;
  hasMoreConversations?: boolean;
  onLoadMoreConversations?: () => void;
  conversationLoading?: boolean;
  conversationError?: string;
  onOpenConversation?: (id: string) => void;
}) {
  const { s, colors } = useUi();
  const notice = useNotice();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<PlanDraft>({ prompt: "", time: nextHour(), interval: "", pending: null });
  const draftRef = useRef(draft);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [picker, setPicker] = useState<"date" | "conversation" | null>(null);
  const operationBusy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    readPlanDraft(connection.url).then((saved) => {
      if (!alive.current) return;
      if (saved) {
        draftRef.current = saved;
        setDraft(saved);
        setCreating(!!saved.pending || !!saved.prompt);
      }
      setReady(true);
    }).catch((e) => { if (alive.current) setError(humanError(e)); });
    return () => { alive.current = false; };
  }, [connection.url]);

  const pending = draft.pending;
  const destination = scheduleDestination(draft, conversation?.id ?? null);
  const availableConversations = conversation && !conversations.some((item) => item.id === conversation.id)
    ? [conversation, ...conversations] : conversations;
  const destinationName = (id: string) => availableConversations.find((item) => item.id === id)?.title ?? conversationName(id);
  const prompt = pending?.prompt ?? draft.prompt;
  const time = pending ? localDateTime(new Date(pending.next_run_at)) : draft.time;
  const interval = pending ? (pending.interval_seconds === null ? "" : String(pending.interval_seconds / 60)) : draft.interval;
  const [date, clock = ""] = time.split(" ");
  const repeat = pending ? scheduleRepeat(interval) : (draft.repeat_mode ?? scheduleRepeat(interval));
  const editable = ready && !busy && !pending;

  function change(value: Partial<PlanDraft>) {
    if (operationBusy.current || (draftRef.current.pending && value.pending !== null)) return;
    const updated = { ...draftRef.current, conversation_id: scheduleDestination(draftRef.current, conversation?.id ?? null), ...value };
    draftRef.current = updated;
    setDraft(updated);
    void savePlanDraft(connection.url, updated).catch((e) => { if (alive.current) setError(humanError(e)); });
  }
  function editPending() {
    Alert.alert("重新编辑计划？", "上一次请求可能已创建计划。请先检查计划列表；重新编辑后再次创建会使用新的请求。", [
      { text: "保留重试", style: "cancel" },
      { text: "确认并编辑", onPress: () => {
        const original = draftRef.current.pending;
        if (!original) return;
        const interval = original.interval_seconds === null ? "" : String(original.interval_seconds / 60);
        change({ pending: null, conversation_id: original.conversation_id, prompt: original.prompt,
          time: localDateTime(new Date(original.next_run_at)), interval, repeat_mode: scheduleRepeat(interval) });
      } },
    ]);
  }
  async function create() {
    if (!ready || operationBusy.current) return;
    operationBusy.current = true;
    setBusy(true);
    setError("");
    try {
      const current = draftRef.current;
      if (!current.pending && current.repeat_mode === "custom" && !current.interval.trim()) throw new Error("请填写重复间隔，至少 1 分钟。");
      if (!current.pending && !/^([01]\d|2[0-3]):[0-5]\d$/.test(current.time.split(" ")[1] ?? "")) throw new Error("时间请用 HH:mm，例如 09:00。");
      const payload = prepareSchedule(current, scheduleDestination(current, conversation?.id ?? null), Crypto.randomUUID);
      const durable = { ...current, conversation_id: payload.conversation_id, pending: payload };
      draftRef.current = durable;
      setDraft(durable);
      setPicker(null);
      await savePlanDraft(connection.url, durable);
      const created = await request<Schedule>(connection, "/schedules", { method: "POST", body: payload });
      const empty: PlanDraft = { prompt: "", time: nextHour(), interval: "", conversation_id: payload.conversation_id, pending: null };
      await clearPlanDraft(connection.url, payload.id, empty);
      onChanged(created);
      onRefresh();
      if (alive.current) {
        draftRef.current = empty;
        setDraft(empty);
        setCreating(false);
        notice.show({ message: `计划已创建，结果会发到「${destinationName(created.conversation_id)}」`, tone: "success", duration: 6000,
          ...(onOpenConversation ? { action: { label: "查看对话", onPress: () => onOpenConversation(created.conversation_id) } } : {}) });
      }
    } catch (e) { if (alive.current) setError(humanError(e)); }
    finally { operationBusy.current = false; if (alive.current) setBusy(false); }
  }
  async function toggle(schedule: Schedule) {
    if (operationBusy.current || scheduleTriggered(schedule)) return;
    operationBusy.current = true;
    setError(""); setBusy(true);
    try {
      const updated = await request<Schedule>(connection, `/schedules/${schedule.id}`, { method: "PATCH", body: { enabled: !schedule.enabled } });
      onChanged(updated); onRefresh();
    } catch (e) { if (alive.current) setError(humanError(e)); }
    finally { operationBusy.current = false; if (alive.current) setBusy(false); }
  }
  async function calendar(schedule: Schedule) {
    if (operationBusy.current) return;
    operationBusy.current = true;
    setBusy(true); setError("");
    try {
      const message = await openSystemCalendar(scheduleCalendarEvent(schedule));
      if (alive.current) notice.show({ message });
    } catch (e) { if (alive.current) notice.show({ message: humanError(e), tone: "warning", duration: 8000 }); }
    finally { operationBusy.current = false; if (alive.current) setBusy(false); }
  }

  return <>
    <PageScrollView>
      <PageHeading title="定时计划" description="把需要惦记的事，交给知行。" action={
        <IconAction icon={creating ? "close" : "add"} label={creating ? "收起新计划" : "新计划"} disabled={!ready || busy} onPress={() => setCreating(!creating)} tone="gold" />
      } />
      {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      {creating ? <View style={s.card}>
        <Field label="到时要做什么" multiline placeholder="例如：整理这周的资料，给我一份简报" value={prompt} onChangeText={(prompt) => change({ prompt })} maxLength={20000} editable={editable} />
        <View>
          <Text style={s.label}>结果发到</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="选择结果对话" accessibilityState={{ disabled: !editable }} disabled={!editable} onPress={() => setPicker("conversation")} style={({ pressed }) => [s.actionRow, pressed && s.pressed, !editable && s.disabled]}>
            <Ionicons name="chatbubble-outline" size={20} color={colors.blue} />
            <Text style={[s.text, styles.destination]}>{destination ? destinationName(destination) : "选择一个对话"}</Text>
            <Ionicons name="chevron-down" size={17} color={colors.muted} />
          </Pressable>
        </View>
        <View style={styles.dateSection}>
          <Text style={s.label}>首次执行 · 手机当地时间</Text>
          <View style={styles.options}>
            {[{ label: "今天", value: dateOffset(0) }, { label: "明天", value: dateOffset(1) }].map((option) => <Pressable key={option.label} accessibilityRole="button" accessibilityLabel={`执行日期${option.label}`} accessibilityState={{ selected: date === option.value, disabled: !editable }} disabled={!editable} onPress={() => change({ time: `${option.value} ${clock}` })} style={[s.chip, date === option.value && s.chipActive, !editable && s.disabled]}><Text style={[s.chipText, date === option.value && s.chipActiveText]}>{option.label}</Text></Pressable>)}
            <ActionLink icon="calendar-outline" tone="blue" disabled={!editable} onPress={() => setPicker("date")}>{date !== dateOffset(0) && date !== dateOffset(1) ? scheduleDateLabel(date) : "选择日期"}</ActionLink>
          </View>
          <Field label="时间" accessibilityLabel="执行时间" placeholder="09:00" maxLength={5} autoCapitalize="none" autoCorrect={false} value={clock} onChangeText={(clock) => change({ time: `${date} ${clock}` })} editable={editable} />
          <Text style={s.muted}>{scheduleDateLabel(date)}{clock ? ` ${clock}` : ""} 首次执行</Text>
        </View>
        <View style={styles.dateSection}>
          <Text style={s.label}>重复</Text>
          <View style={styles.options}>{repeatOptions.map((option) => <Pressable key={option.id} accessibilityRole="button" accessibilityLabel={`重复${option.label}`} accessibilityState={{ selected: repeat === option.id, disabled: !editable }} disabled={!editable} onPress={() => change({ repeat_mode: option.id, interval: option.id === "custom" && repeat === "custom" ? interval : option.interval })} style={[s.chip, repeat === option.id && s.chipActive, !editable && s.disabled]}><Text style={[s.chipText, repeat === option.id && s.chipActiveText]}>{option.label}</Text></Pressable>)}</View>
          {repeat === "custom" ? <Field label="间隔分钟" keyboardType="numeric" placeholder="至少 1 分钟" value={interval} onChangeText={(interval) => change({ interval })} editable={editable} /> : null}
          {repeat !== "once" ? <Text style={s.muted}>从首次时间起{repeat === "daily" ? "每 24 小时" : repeat === "weekly" ? "每 7 天" : "按固定间隔"}重复，不随时区或夏令时调整。运行不重叠，离线错过多次会合并执行一次。</Text> : null}
        </View>
        <Button disabled={!ready || busy || !prompt.trim() || !destination} style={styles.submit} onPress={() => { void create(); }}>{busy ? "保存中…" : pending ? "重试原计划" : "创建计划"}</Button>
        {pending && !busy ? <>
          <Text style={s.muted}>等待确认 · 重试会沿用原时间和原对话，不重复创建。</Text>
          <ActionLink icon="create-outline" tone="gold" onPress={editPending}>重新编辑计划</ActionLink>
        </> : null}
      </View> : null}
      {!schedules.length && !creating ? <View style={s.card}><Empty compact icon="calendar-outline" title="还没有安排">定时整理资料，或者继续一项研究。</Empty><ActionLink icon="add" tone="gold" disabled={!ready} onPress={() => setCreating(true)}>安排第一件事</ActionLink></View> : null}
      {[...schedules].reverse().map((schedule) => {
        const triggered = scheduleTriggered(schedule);
        return <View key={schedule.id} style={s.card}>
          <View style={s.spread}>
            <StatusPill tone={schedule.enabled ? "green" : "neutral"}>{schedule.enabled ? "计划中" : triggered ? "一次已触发" : "已暂停"}</StatusPill>
            {!triggered ? <ActionLink icon={schedule.enabled ? "pause-outline" : "play-outline"} tone="gold" disabled={busy} onPress={() => { void toggle(schedule); }}>{schedule.enabled ? "暂停" : "启用"}</ActionLink> : null}
          </View>
          <Text style={s.text}>{schedule.prompt}</Text>
          <Text style={s.description}>{schedule.enabled ? "下次执行" : "原定时间"} · {timeLabel(schedule.next_run_at)}{"\n"}{scheduleIntervalLabel(schedule.interval_seconds)}</Text>
          <View style={styles.resultRow}><Ionicons name="chatbubble-outline" size={16} color={colors.blue} /><Text style={[s.muted, styles.destination]}>结果发到 · {destinationName(schedule.conversation_id)}</Text></View>
          {schedule.last_run_id && onOpenConversation ? <ActionLink icon="arrow-forward-outline" tone="blue" onPress={() => onOpenConversation(schedule.conversation_id)}>查看结果</ActionLink> : null}
          {Platform.OS === "android" ? <ActionLink icon="calendar-outline" tone="blue" disabled={busy} onPress={() => { void calendar(schedule); }}>将本次时间带入日历</ActionLink> : null}
        </View>;
      })}
      {hasMore ? <ActionLink icon="chevron-down" onPress={loadMore}>加载更多计划</ActionLink> : null}
    </PageScrollView>
    <ScheduleDatePicker visible={picker === "date" && editable} value={date} onClose={() => setPicker(null)} onSelect={(date) => { change({ time: `${date} ${clock}` }); setPicker(null); }} />
    <ScheduleConversationPicker visible={picker === "conversation" && editable} conversations={availableConversations} selectedId={destination} hasMore={hasMoreConversations} loading={conversationLoading} error={conversationError} onLoadMore={onLoadMoreConversations} onClose={() => setPicker(null)} onSelect={(conversation_id) => { change({ conversation_id }); setPicker(null); }} />
  </>;
}

const styles = StyleSheet.create({
  destination: { flex: 1 },
  dateSection: { gap: space.sm },
  options: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
  submit: { alignSelf: "flex-start" },
  resultRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
});
