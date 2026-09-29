import { useEffect, useState, type ReactNode } from "react";
import Markdown, { type ASTNode, type MarkdownStyleMap } from "@ronradtke/react-native-markdown-display";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type TextProps,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  request,
  type Connection,
  type Conversation,
  type ModelCatalog,
  type ReasoningEffort,
  type Page,
  type Run,
  type RunEvent,
} from "./api";
import { useChat } from "./useChat";
import { reasoningLabel } from "./ModelPicker";
import { ChatComposer } from "./ChatComposer";
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

function SelectableText(props: TextProps) {
  return <Text selectable {...props} />;
}

const markdownRules = {
  image: (node: ASTNode) => (
    <Text key={node.key} style={{ color: colors.muted }}>
      {node.attributes.alt || "[图片]"}
    </Text>
  ),
};

const openWebLink = (url: string) => /^https?:\/\//i.test(url);

const markdownStyles = {
  body: { color: colors.ink, fontSize: 15, lineHeight: 24 },
  text: { color: colors.ink, fontSize: 15, lineHeight: 24 },
  paragraph: { marginTop: 0, marginBottom: 8 },
  heading1: { color: colors.ink, fontSize: 20, fontWeight: "600", marginBottom: 8 },
  heading2: { color: colors.ink, fontSize: 18, fontWeight: "600", marginBottom: 7 },
  heading3: { color: colors.ink, fontSize: 16, fontWeight: "600", marginBottom: 6 },
  bullet_list: { marginVertical: 5 },
  ordered_list: { marginVertical: 5 },
  code_inline: { backgroundColor: colors.pale, color: colors.ink, fontSize: 13, padding: 0, paddingHorizontal: 4, borderWidth: 0, borderRadius: 4 },
  code_block: { backgroundColor: colors.pale, color: colors.ink, fontSize: 13, padding: 10, borderRadius: 10 },
  fence: { borderColor: colors.line, borderWidth: 1, borderRadius: 10, overflow: "hidden", marginVertical: 6 },
  fence_header: { backgroundColor: colors.pale, borderBottomColor: colors.line },
  fence_code: { backgroundColor: colors.white },
  blockquote: { backgroundColor: colors.pale, borderLeftColor: colors.accent, borderLeftWidth: 3, paddingHorizontal: 10 },
  link: { color: colors.accent, textDecorationLine: "underline" },
} satisfies MarkdownStyleMap;

export function ChatPanel({
  connection,
  conversation,
  assistantName,
  catalog,
  initialKind = "chat",
  initialTaskModelId = null,
  initialTaskEffort = null,
  initialSearchId = null,
  startWithFiles = false,
  onFilesOpened,
  onConversationChanged,
  onRefresh,
  intro,
  stretchIntro = false,
}: {
  connection: Connection;
  conversation: Conversation;
  assistantName: string;
  catalog: ModelCatalog | null;
  initialKind?: "chat" | "task";
  initialTaskModelId?: string | null;
  initialTaskEffort?: ReasoningEffort | null;
  initialSearchId?: string | null;
  startWithFiles?: boolean;
  onFilesOpened?: () => void;
  onConversationChanged: (conversation: Conversation) => void;
  onRefresh: () => void;
  intro?: ReactNode;
  stretchIntro?: boolean;
}) {
  const [taskModelId, setTaskModelId] = useState(initialTaskModelId);
  const [taskEffort, setTaskEffort] = useState(initialTaskEffort);
  const [searchProviderId, setSearchProviderId] = useState(initialSearchId);
  const {
    messages,
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
  } = useChat({ connection, conversation, onRefresh, initialKind, startWithFiles });
  useEffect(() => { if (startWithFiles) onFilesOpened?.(); }, [startWithFiles, onFilesOpened]);
  async function updateModel(model_id: string | null, reasoning_effort: ReasoningEffort | null) {
    if (kind === "task") {
      setTaskModelId(model_id);
      setTaskEffort(reasoning_effort);
      return;
    }
    const updated = await request<Conversation>(connection, `/conversations/${conversation.id}/model`, {
      method: "PUT", body: { model_id, reasoning_effort },
    });
    onConversationChanged(updated);
  }

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
        <ActivityIndicator color={colors.accent} style={{ padding: 16 }} />
      ) : null}
      <FlatList
        ref={list}
        style={s.body}
        ListHeaderComponentStyle={stretchIntro && !messages.length ? { flexGrow: 1 } : undefined}
        data={messages}
        keyExtractor={(message) => message.id}
        contentContainerStyle={{
          paddingHorizontal: 18,
          paddingVertical: 16,
          gap: 24,
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
          if (messages.length && nearBottomRef.current)
            list.current?.scrollToEnd({ animated: false });
        }}
        ListHeaderComponent={
          <View style={{ gap: 16, flexGrow: stretchIntro && !messages.length ? 1 : 0 }}>
            {intro}
            {previous ? (
              <Button
                secondary
                disabled={busy}
                onPress={() => {
                  void loadOlder();
                }}
              >
                查看更早的消息
              </Button>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !loading && !intro ? (
            <Empty title="从这一刻开始">
              随便聊聊，或交给我一件事。{"\n"}这段对话会一直留在这里。
            </Empty>
          ) : null
        }
        renderItem={({ item }) => (
          <View
            style={{
              alignSelf: item.role === "user" ? "flex-end" : "stretch",
              maxWidth: item.role === "user" ? "88%" : "100%",
              gap: 5,
            }}
          >
            <Text style={[s.muted, item.role === "user" && chatStyles.userMeta]}>
              {item.role === "assistant" ? assistantName : "你"} ·{" "}
              {timeLabel(item.created_at)}
              {item.intent === "steer"
                ? ` · 引导${item.status === "applied" ? "已应用" : item.status === "rejected" ? "未应用" : "待应用"}`
                : ""}
            </Text>
            <View style={item.role === "user" ? chatStyles.userBubble : chatStyles.assistantContent}>
              <Markdown
                style={markdownStyles}
                textcomponent={SelectableText}
                rules={markdownRules}
                onLinkPress={openWebLink}
              >
                {item.content}
              </Markdown>
            </View>
            {item.role === "assistant" || item.run_id ? (
              <View style={chatStyles.messageActions}>
                {item.role === "assistant" ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={speaking === item.id ? "停止朗读" : "朗读消息"}
                    style={chatStyles.messageAction}
                    onPress={() => {
                      void speak(item).catch((e) => setError(humanError(e)));
                    }}
                  >
                    <Text style={chatStyles.actionText}>{speaking === item.id ? "停止朗读" : "朗读"}</Text>
                  </Pressable>
                ) : null}
                {item.run_id ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="查看任务记录"
                    style={chatStyles.messageAction}
                    onPress={() => setDetail(item.run_id)}
                  >
                    <Text style={chatStyles.actionText}>任务记录</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        )}
      />
      {pendingRuns.length ? (
        <View style={chatStyles.runBar}>
          <Text numberOfLines={1} style={[s.muted, s.grow]}>
            {running
              ? `正在${running.kind === "task" ? "处理委托" : "回复"} · ${pendingRuns.filter((run) => run.status === "queued").length} 条等待`
              : `${pendingRuns.length} 条等待执行`}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="查看运行进度" onPress={() => setDetail(running?.id ?? pendingRuns[0].id)}>
            <Text style={chatStyles.link}>进度</Text>
          </Pressable>
          {running ? (
            <Pressable accessibilityRole="button" accessibilityLabel="取消当前运行" accessibilityState={{ disabled: running.cancel_requested }} disabled={running.cancel_requested} onPress={() => { void cancel(running).catch(() => undefined); }}>
              <Text style={[chatStyles.link, { color: colors.red }]}>{running.cancel_requested ? "取消中" : "取消"}</Text>
            </Pressable>
          ) : null}
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
      <ChatComposer
        name={assistantName}
        draft={draft.text}
        kind={kind}
        busy={busy}
        ready={draftReady}
        pending={!!draft.pending}
        optionsLocked={intent === "steer"}
        connection={connection}
        catalog={catalog}
        modelId={kind === "task" ? taskModelId : conversation.model_id}
        effort={kind === "task" ? taskEffort : conversation.reasoning_effort}
        searchProviderId={searchProviderId}
        onDraft={(text) => { void updateDraft({ text, pending: null }).catch((e) => setError(humanError(e))); }}
        onKind={setKind}
        onModel={updateModel}
        onSearchProviderId={setSearchProviderId}
        onFiles={() => setShowFiles(true)}
        onSend={() => { void send({ ...(kind === "task" && taskModelId ? { model_id: taskModelId } : {}), ...(kind === "task" && taskEffort ? { reasoning_effort: taskEffort } : {}), ...(searchProviderId ? { search_provider_id: searchProviderId } : {}) }); }}
        onEditPending={abandonPending}
        error={error || (intent === "steer" && running?.id !== target ? "目标已结束，请切回排队发送" : "")}
      >
        {(running || intent === "steer") && (["queue", "steer"] as const).map((value) => (
          <Pressable key={value} accessibilityRole="button" accessibilityLabel={value === "queue" ? "排队：当前运行结束后处理" : "引导：发送给当前运行"} accessibilityState={{ selected: intent === value, disabled: !!draft.pending || (value === "steer" && !running) }} disabled={!!draft.pending || (value === "steer" && !running)} onPress={() => {
            setIntent(value);
            if (value === "steer" && running) setKind(running.kind);
            setTarget(value === "steer" ? (running?.id ?? null) : null);
          }} style={[s.chip, intent === value && s.chipActive, value === "steer" && !running && s.disabled]}>
            <Text style={[s.chipText, intent === value && s.chipActiveText]}>{value === "queue" ? "排队" : "引导"}</Text>
          </Pressable>
        ))}
      </ChatComposer>
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
            {run.model_id ? (
              <Text style={s.muted}>
                模型 {run.model_id}{run.reasoning_effort ? ` · 思考 ${reasoningLabel[run.reasoning_effort]}` : ""}
              </Text>
            ) : null}
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
          <ActivityIndicator color={colors.accent} />
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

const chatStyles = StyleSheet.create({
  userMeta: { textAlign: "right" },
  userBubble: { backgroundColor: colors.pale, borderRadius: 17, borderTopRightRadius: 5, paddingHorizontal: 13, paddingVertical: 10 },
  assistantContent: { paddingHorizontal: 2 },
  messageActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  messageAction: { minHeight: 36, justifyContent: "center", paddingHorizontal: 4 },
  actionText: { color: colors.accent, fontSize: 12, fontWeight: "500" },
  runBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: colors.pale,
  },
  link: { color: colors.accent, fontSize: 12, fontWeight: "600" },
});
