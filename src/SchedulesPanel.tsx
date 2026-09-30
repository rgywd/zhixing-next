import { useUi, ActionLink, Button, Empty, Field, IconAction, PageHeading, PageScrollView, StatusPill, humanError, timeLabel } from "./ui";
import { useEffect, useRef, useState } from "react";
import { Alert, Platform, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import {
  prepareSchedule,
  request,
  type Connection,
  type Conversation,
  type Schedule,
  type PlanDraft,
} from "./api";
import { clearPlanDraft, readPlanDraft, savePlanDraft } from "./storage";
import { openSystemCalendar } from "./deviceCapabilities";
import { scheduleCalendarEvent } from "./deviceCapabilityLogic";
import { useNotice } from "./Notice";

function nextHour() {
  const date = new Date(Date.now() + 3600000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
export function SchedulesPanel({
  connection,
  schedules,
  conversation,
  conversationName,
  onRefresh,
  onChanged,
  hasMore,
  loadMore,
}: {
  connection: Connection;
  schedules: Schedule[];
  conversation: Conversation | null;
  conversationName: (id: string) => string;
  onRefresh: () => void;
  onChanged: (schedule: Schedule) => void;
  hasMore: boolean;
  loadMore: () => void;
}) {
  const { s } = useUi();
  const notice = useNotice();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<PlanDraft>({
    prompt: "",
    time: nextHour(),
    interval: "",
    pending: null,
  });
  const { prompt, time, interval, pending } = draft;
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const calendarBusy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    readPlanDraft(connection.url)
      .then((saved) => {
        if (!alive.current) return;
        if (saved) {
          setDraft(saved);
          setCreating(!!saved.pending || !!saved.prompt);
        }
        setReady(true);
      })
      .catch((e) => {
        if (alive.current) setError(humanError(e));
      });
    return () => {
      alive.current = false;
    };
  }, [connection.url]);
  function change(value: Partial<PlanDraft>) {
    const updated = { ...draft, ...value };
    setDraft(updated);
    void savePlanDraft(connection.url, updated).catch((e) =>
      setError(humanError(e)),
    );
  }
  const setPrompt = (prompt: string) => change({ prompt });
  const setTime = (time: string) => change({ time });
  const setInterval = (interval: string) => change({ interval });
  function editPending() {
    Alert.alert(
      "重新编辑计划？",
      "上一次请求可能已创建计划。请先检查计划列表；重新编辑后再次创建会使用新的请求。",
      [
        { text: "保留重试", style: "cancel" },
        { text: "确认并编辑", onPress: () => change({ pending: null }) },
      ],
    );
  }
  async function create() {
    if (!ready || busy) return;
    if (!conversation && !pending) {
      setError("先在对话页选择或创建一个会话，作为结果归属。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload = prepareSchedule(
        draft,
        conversation?.id ?? null,
        Crypto.randomUUID,
      );
      const durable = { ...draft, pending: payload };
      setDraft(durable);
      await savePlanDraft(connection.url, durable);
      const created = await request<Schedule>(connection, "/schedules", {
        method: "POST",
        body: payload,
      });
      const empty = {
        prompt: "",
        time: nextHour(),
        interval: "",
        pending: null,
      };
      await clearPlanDraft(connection.url, payload.id, empty);
      onChanged(created);
      onRefresh();
      if (alive.current) {
        setDraft(empty);
        setCreating(false);
      }
    } catch (e) {
      if (alive.current) setError(humanError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function toggle(schedule: Schedule) {
    setError("");
    setBusy(true);
    try {
      const updated = await request<Schedule>(
        connection,
        `/schedules/${schedule.id}`,
        {
          method: "PATCH",
          body: { enabled: !schedule.enabled },
        },
      );
      onChanged(updated);
      onRefresh();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <PageScrollView>
      <PageHeading title="定时计划" description="把需要惦记的事，交给知行。" action={
        <IconAction icon={creating ? "close" : "add"} label={creating ? "收起新计划" : "新计划"} onPress={() => setCreating(!creating)} tone="gold" />
      } />
      {error ? (
        <Text accessibilityRole="alert" style={s.error}>
          {error}
        </Text>
      ) : null}
      {creating ? (
        <View style={s.card}>
          <Text style={s.label}>
            结果归属 ·{" "}
            {pending
              ? conversationName(pending.conversation_id)
              : (conversation?.title ?? "请先选择一个对话")}
          </Text>
          <Field
            label="到时要做什么"
            multiline
            placeholder="明确要研究或处理的事情，以及期望的结果…"
            value={prompt}
            onChangeText={setPrompt}
            maxLength={20000}
            editable={ready && !busy && !pending}
          />
          <Field
            label="首次执行时间 · 手机当地时间"
            placeholder="2026-10-01 09:00"
            value={time}
            onChangeText={setTime}
            editable={ready && !busy && !pending}
          />
          <Field
            label="重复间隔（分钟，留空表示仅一次）"
            keyboardType="numeric"
            placeholder="例如 1440，每 24 小时"
            value={interval}
            onChangeText={setInterval}
            editable={ready && !busy && !pending}
          />
          <Text style={s.muted}>
            重复任务不重叠运行。服务离线错过多次时，恢复后合并执行一次。
          </Text>
          <Button
            disabled={
              !ready || busy || !prompt.trim() || (!conversation && !pending)
            }
            style={{ alignSelf: "flex-start" }}
            onPress={() => {
              void create();
            }}
          >
            {busy ? "保存中…" : pending ? "重试原计划" : "创建计划"}
          </Button>
          {pending && !busy ? (
            <>
              <Text style={s.muted}>
                等待确认 · 重试会沿用原时间、原会话与同一请求 ID。
              </Text>
              <ActionLink icon="create-outline" tone="gold" onPress={editPending}>重新编辑计划</ActionLink>
            </>
          ) : null}
        </View>
      ) : null}
      {!schedules.length && !creating ? (
        <View style={s.card}>
          <Empty compact icon="calendar-outline" title="还没有安排">
            先从一件小事开始：定时整理资料，或者继续一项研究。
          </Empty>
        </View>
      ) : schedules.length ? (
        [...schedules].reverse().map((schedule) => (
          <View key={schedule.id} style={s.card}>
            <View style={s.spread}>
              <StatusPill tone={schedule.enabled ? "green" : "neutral"}>{schedule.enabled ? "计划中" : "已暂停 / 已触发"}</StatusPill>
              <ActionLink
                icon={schedule.enabled ? "pause-outline" : "play-outline"}
                tone="gold"
                disabled={busy}
                onPress={() => {
                  void toggle(schedule);
                }}
              >
                {schedule.enabled ? "暂停" : "启用"}
              </ActionLink>
            </View>
            <Text style={s.text}>{schedule.prompt}</Text>
            <Text style={s.muted}>
              {conversationName(schedule.conversation_id)}
              {"\n"}
              {timeLabel(schedule.next_run_at)} ·{" "}
              {schedule.interval_seconds
                ? `每 ${schedule.interval_seconds / 60} 分钟`
                : "仅一次"}
              {schedule.last_run_id
                ? `\n最近运行 ${schedule.last_run_id.slice(0, 8)} · 在归属对话查看结果`
                : ""}
            </Text>
            {Platform.OS === "android" ? <ActionLink icon="calendar-outline" tone="blue" disabled={busy} onPress={() => {
              if (calendarBusy.current) return;
              calendarBusy.current = true; setBusy(true); setError("");
              void Promise.resolve().then(() => openSystemCalendar(scheduleCalendarEvent(schedule)))
                .then((message) => { if (alive.current) notice.show({ message }); })
                .catch((e) => { if (alive.current) notice.show({ message: humanError(e), tone: "warning", duration: 8000 }); })
                .finally(() => { calendarBusy.current = false; if (alive.current) setBusy(false); });
            }}>将本次时间带入日历</ActionLink> : null}
          </View>
        ))
      ) : null}
      {hasMore ? (
        <ActionLink icon="chevron-down" onPress={loadMore}>加载更多计划</ActionLink>
      ) : null}
    </PageScrollView>
  );
}
