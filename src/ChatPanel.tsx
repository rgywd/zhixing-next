import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  request,
  type Connection,
  type Conversation,
  type Page,
  type Run,
  type RunEvent,
} from "./api";
import { useChat } from "./useChat";
import { FilesPanel } from "./FilesPanel";
import {
  Button,
  colors,
  Empty,
  humanError,
  runLabels,
  s,
  timeLabel,
} from "./ui";

export function ChatPanel({
  connection,
  conversation,
  assistantName,
  onRefresh,
}: {
  connection: Connection;
  conversation: Conversation;
  assistantName: string;
  onRefresh: () => void;
}) {
  const {
    messages,
    runs,
    running,
    previous,
    draft,
    draftReady,
    intent,
    setIntent,
    kind,
    setKind,
    target,
    setTarget,
    busy,
    error,
    setError,
    syncError,
    loading,
    detail,
    setDetail,
    showFiles,
    setShowFiles,
    speaking,
    list,
    nearBottomRef,
    refresh,
    loadOlder,
    send,
    cancel,
    resume,
    abandonPending,
    attach,
    speak,
    pendingRuns,
    updateDraft,
  } = useChat({ connection, conversation, onRefresh });

  return (
    <View style={s.body}>
      {syncError ? (
        <Pressable
          onPress={() => refresh.current()}
          style={[s.notice, { marginHorizontal: 18, marginBottom: 8 }]}
          accessibilityRole="button"
        >
          <Text style={s.noticeText}>{syncError} 点击重新连接；草稿保留。</Text>
        </Pressable>
      ) : null}
      {loading ? (
        <ActivityIndicator color={colors.green} style={{ padding: 16 }} />
      ) : null}
      <FlatList
        ref={list}
        data={messages}
        keyExtractor={(message) => message.id}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingVertical: 12,
          gap: 18,
          flexGrow: 1,
        }}
        keyboardShouldPersistTaps="handled"
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } =
            event.nativeEvent;
          nearBottomRef.current =
            contentSize.height - contentOffset.y - layoutMeasurement.height <
            140;
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (nearBottomRef.current)
            list.current?.scrollToEnd({ animated: false });
        }}
        ListHeaderComponent={
          previous ? (
            <Button
              secondary
              disabled={busy}
              onPress={() => {
                void loadOlder();
              }}
            >
              查看更早的消息
            </Button>
          ) : null
        }
        ListEmptyComponent={
          !loading ? (
            <Empty title="从这一刻开始">
              随便聊聊，或交给我一件事。{"\n"}这段对话会一直留在这里。
            </Empty>
          ) : null
        }
        renderItem={({ item }) => (
          <View
            style={{
              alignSelf: item.role === "user" ? "flex-end" : "stretch",
              maxWidth: item.role === "user" ? "91%" : "100%",
              gap: 7,
            }}
          >
            <Text style={s.muted}>
              {item.role === "assistant" ? assistantName : "你"} ·{" "}
              {timeLabel(item.created_at)}
              {item.intent === "steer"
                ? ` · 引导${item.status === "applied" ? "已应用" : item.status === "rejected" ? "未应用" : "待应用"}`
                : ""}
            </Text>
            <View
              style={{
                padding: 15,
                borderRadius: 17,
                borderTopRightRadius: item.role === "user" ? 4 : 17,
                borderTopLeftRadius: item.role === "assistant" ? 4 : 17,
                backgroundColor:
                  item.role === "user" ? colors.pale : colors.white,
              }}
            >
              <Text selectable style={s.text}>
                {item.content}
              </Text>
            </View>
            {item.role === "assistant" || item.run_id ? (
              <View style={s.row}>
                {item.role === "assistant" ? (
                  <Button
                    secondary
                    small
                    onPress={() => {
                      void speak(item).catch((e) => setError(humanError(e)));
                    }}
                  >
                    {speaking === item.id ? "停止朗读" : "朗读"}
                  </Button>
                ) : null}
                {item.run_id ? (
                  <Button
                    secondary
                    small
                    onPress={() => setDetail(item.run_id)}
                  >
                    任务记录
                  </Button>
                ) : null}
              </View>
            ) : null}
          </View>
        )}
      />
      {runs.length ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: colors.line,
            paddingHorizontal: 18,
            paddingVertical: 9,
            gap: 7,
          }}
        >
          <View style={s.spread}>
            <Text style={s.muted}>
              {running
                ? `正在${running.kind === "task" ? "处理委托" : "回复"} · ${pendingRuns.filter((run) => run.status === "queued").length} 条等待`
                : "运行记录"}
            </Text>
            <Button
              secondary
              small
              onPress={() => setDetail(running?.id ?? runs[runs.length - 1].id)}
            >
              查看进度
            </Button>
          </View>
          {running ? (
            <View style={s.spread}>
              <Text numberOfLines={1} style={[s.text, s.grow]}>
                {running.prompt}
              </Text>
              <Button
                secondary
                danger
                small
                disabled={running.cancel_requested}
                onPress={() => {
                  void cancel(running).catch(() => undefined);
                }}
              >
                {running.cancel_requested ? "正在取消" : "取消"}
              </Button>
            </View>
          ) : null}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 7 }}
          >
            {[...runs]
              .reverse()
              .slice(0, 8)
              .map((run) => (
                <Button
                  key={run.id}
                  secondary
                  small
                  onPress={() => setDetail(run.id)}
                >
                  {runLabels[run.status]} · {run.prompt.slice(0, 12)}
                </Button>
              ))}
          </ScrollView>
        </View>
      ) : null}
      {conversation.blocked ? (
        <View style={[s.notice, { marginHorizontal: 18, marginBottom: 8 }]}>
          <Text style={s.noticeText}>
            当前会话已停止自动处理。后续排队消息仍保留。
          </Text>
          <Button
            secondary
            small
            onPress={() => {
              void resume();
            }}
          >
            继续处理队列
          </Button>
        </View>
      ) : null}
      <View
        style={{
          paddingHorizontal: 18,
          paddingTop: 10,
          paddingBottom: 12,
          gap: 9,
          borderTopWidth: 1,
          borderTopColor: colors.line,
          backgroundColor: colors.white,
        }}
      >
        <View style={s.spread}>
          <View style={s.row}>
            {(["chat", "task"] as const).map((value) => (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityState={{
                  selected: kind === value,
                  disabled: !!draft.pending,
                }}
                disabled={!!draft.pending}
                onPress={() => setKind(value)}
                style={[s.chip, kind === value && s.chipActive]}
              >
                <Text style={[s.chipText, kind === value && s.chipActiveText]}>
                  {value === "chat" ? "聊一聊" : "交给你做"}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={s.row}>
            {(["queue", "steer"] as const).map((value) => (
              <Pressable
                key={value}
                accessibilityRole="button"
                disabled={!!draft.pending || (value === "steer" && !running)}
                accessibilityState={{
                  selected: intent === value,
                  disabled: !!draft.pending || (value === "steer" && !running),
                }}
                onPress={() => {
                  setIntent(value);
                  if (value === "steer" && running) setKind(running.kind);
                  setTarget(value === "steer" ? (running?.id ?? null) : null);
                }}
                style={[
                  s.chip,
                  intent === value && s.chipActive,
                  value === "steer" && !running && s.disabled,
                ]}
              >
                <Text
                  style={[s.chipText, intent === value && s.chipActiveText]}
                >
                  {value === "queue" ? "排队" : "引导"}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
        <View style={s.spread}>
          <Text style={[s.muted, s.grow]}>
            {draft.pending
              ? `待确认请求 · ${draft.pending.intent === "steer" ? `引导 ${draft.pending.target_run_id?.slice(0, 8)}` : "排队"} · 重试沿用原请求`
              : intent === "steer"
                ? `引导目标 ${target?.slice(0, 8)} · ${running?.id === target ? "在下一可调整步骤生效" : "目标已结束，请重新选择"}`
                : "发给当前会话 · 按顺序处理"}
          </Text>
          <Button secondary small onPress={() => setShowFiles(true)}>
            资料
          </Button>
        </View>
        {error ? (
          <Text accessibilityRole="alert" style={s.error}>
            {error}
          </Text>
        ) : null}
        <View style={[s.row, { alignItems: "flex-end" }]}>
          <TextInput
            accessibilityLabel="消息或任务要求"
            multiline
            placeholder="说说你的想法…"
            placeholderTextColor={colors.muted}
            value={draft.text}
            maxLength={20000}
            editable={draftReady && !draft.pending && !busy}
            onChangeText={(text) => {
              void updateDraft({ text, pending: null }).catch((e) =>
                setError(humanError(e)),
              );
            }}
            style={[
              s.input,
              s.grow,
              { maxHeight: 140, minHeight: 50, lineHeight: 23 },
            ]}
          />
          <Button
            disabled={!draftReady || busy || !draft.text.trim()}
            onPress={() => {
              void send();
            }}
          >
            {busy ? "发送中" : draft.pending ? "重试" : "发送"}
          </Button>
        </View>
        {draft.pending && !busy ? (
          <Button secondary small onPress={abandonPending}>
            返回编辑草稿
          </Button>
        ) : null}
      </View>
      <Modal
        visible={!!detail}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setDetail(null)}
      >
        {detail ? (
          <RunDetail
            connection={connection}
            id={detail}
            close={() => setDetail(null)}
            onCancel={cancel}
          />
        ) : null}
      </Modal>
      <Modal
        visible={showFiles}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowFiles(false)}
      >
        {showFiles ? (
          <FilesPanel
            connection={connection}
            conversationId={conversation.id}
            attach={attach}
            canAttach={draftReady && !draft.pending && !busy}
            close={() => setShowFiles(false)}
          />
        ) : null}
      </Modal>
    </View>
  );
}

function RunDetail({
  connection,
  id,
  close,
  onCancel,
}: {
  connection: Connection;
  id: string;
  close: () => void;
  onCancel: (run: Run) => Promise<void>;
}) {
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let polling = false;
    let cursor = 0;
    const controller = new AbortController();
    async function poll() {
      if (polling || !active) return;
      polling = true;
      try {
        const [task, page] = await Promise.all([
          request<Run>(connection, `/runs/${id}`, {
            signal: controller.signal,
          }),
          request<Page<RunEvent>>(
            connection,
            `/runs/${id}/events?after=${cursor}&limit=100`,
            { signal: controller.signal },
          ),
        ]);
        if (!active) return;
        setRun(task);
        setEvents((old) => [...old, ...page.items]);
        if (page.items.length) cursor = page.items[page.items.length - 1].seq;
        setError("");
      } catch (e) {
        if (active) setError(humanError(e));
      } finally {
        polling = false;
      }
    }
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 2000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [connection, id]);
  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={[s.heading, s.grow]}>任务记录</Text>
        <Button secondary onPress={close}>
          关闭
        </Button>
      </View>
      <ScrollView contentContainerStyle={s.content}>
        {error ? <Text style={s.error}>{error}</Text> : null}
        {run ? (
          <>
            <Text style={s.title}>{run.prompt}</Text>
            <Text style={s.muted}>
              {runLabels[run.status]} · {run.id.slice(0, 8)}
            </Text>
            {run.error ? (
              <View style={s.notice}>
                <Text selectable style={s.error}>
                  {run.error}
                </Text>
              </View>
            ) : null}
            {run.result ? (
              <View style={s.card}>
                <Text style={s.label}>结果</Text>
                <Text selectable style={s.text}>
                  {run.result}
                </Text>
              </View>
            ) : null}
            {run.status === "queued" || run.status === "running" ? (
              <Button
                secondary
                danger
                disabled={run.cancel_requested}
                onPress={() => {
                  void onCancel(run).catch((e) => setError(humanError(e)));
                }}
              >
                {run.cancel_requested ? "已请求取消" : "取消这次运行"}
              </Button>
            ) : null}
          </>
        ) : (
          <ActivityIndicator color={colors.green} />
        )}
        <Text style={s.label}>执行轨迹</Text>
        {events.length ? (
          events.map((event) => (
            <View
              key={event.seq}
              style={{
                borderLeftWidth: 2,
                borderLeftColor: colors.line,
                paddingLeft: 14,
                gap: 4,
              }}
            >
              <Text style={s.muted}>
                {timeLabel(event.created_at)} · {event.type}
              </Text>
              <Text selectable style={s.text}>
                {eventSummary(event)}
              </Text>
            </View>
          ))
        ) : (
          <Text style={s.muted}>尚无执行事件。</Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
function eventSummary(event: RunEvent) {
  const content =
    event.data.message ??
    event.data.content ??
    event.data.name ??
    event.data.error;
  return typeof content === "string"
    ? content
    : JSON.stringify(event.data, null, 2);
}
