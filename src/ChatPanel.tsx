import { availablePreference } from "./providerEditing";
import type { ThemeColors } from "./theme";
import { useUi, Button, Empty, humanError, runLabels, SheetHeader, timeLabel } from "./ui";
import { useThemedStyles } from "./ThemeProvider";
import { useEffect, useRef, useState } from "react";
import { MessageBody } from "./MessageBody";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { useSyncStatus } from "./ConnectionStatus";
import { ConversationComposer } from "./ConversationComposer";
import { ReasoningPicker } from "./ReasoningPicker";
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
import { ModelPicker, reasoningLabel } from "./ModelPicker";
import { Attachments } from "./Attachments";
import { ApprovalCards } from "./ApprovalCards";
import { FilesPanel } from "./FilesPanel";
import { SearchPicker } from "./SearchPicker";

export function ChatPanel({
  connection,
  conversation,
  assistantName,
  catalog,
  initialKind = "chat",
  initialTaskModelId = null,
  initialTaskEffort = null,
  initialSearchId = null,
  focusMessageSeq = null,
  startWithFiles = false,
  onFilesOpened,
  onConversationChanged,
  onComposerContext,
  onRefresh,
}: {
  connection: Connection;
  conversation: Conversation;
  assistantName: string;
  catalog: ModelCatalog | null;
  initialKind?: "chat" | "task";
  initialTaskModelId?: string | null;
  initialTaskEffort?: ReasoningEffort | null;
  initialSearchId?: string | null;
  focusMessageSeq?: number | null;
  startWithFiles?: boolean;
  onFilesOpened?: () => void;
  onConversationChanged: (conversation: Conversation) => void;
  onComposerContext: (value: { conversationId: string; modelId: string | null; kind: "chat" | "task" }) => void;
  onRefresh: () => void;
}) {
  const { s, colors } = useUi();
  const chatStyles = useThemedStyles(createChatStyles);
  const [showModels, setShowModels] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [taskModelId, setTaskModelId] = useState(initialTaskModelId);
  const [taskEffort, setTaskEffort] = useState(initialTaskEffort);
  const [searchProviderId, setSearchProviderId] = useState(initialSearchId);
  const [showSearch, setShowSearch] = useState(false);
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
    removeAttachment,
    speak,
    pendingRuns,
    updateDraft,
  } = useChat({ connection, conversation, onRefresh, initialKind, startWithFiles, focusMessageSeq });
  const focused = useRef(false);
  const focusAttempts = useRef(0);
  useEffect(() => {
    if (focused.current || loading || focusMessageSeq === null) return;
    const index = messages.findIndex((message) => message.seq === focusMessageSeq);
    if (index < 0) return;
    const timer = setTimeout(() => {
      list.current?.scrollToIndex({ index, animated: true, viewPosition: 0.3 });
      focused.current = true;
    }, 180);
    return () => clearTimeout(timer);
  }, [focusMessageSeq, list, loading, messages]);
  useEffect(() => { if (startWithFiles) onFilesOpened?.(); }, [startWithFiles, onFilesOpened]);
  const taskPreference = availablePreference(catalog, "task", taskModelId, taskEffort);
  const chatPreference = availablePreference(catalog, "chat", conversation.model_id, conversation.reasoning_effort);
  const chatModelId = chatPreference.modelId ?? catalog?.roles.chat ?? null;
  const modelId = kind === "task" ? taskPreference.modelId ?? catalog?.roles.task ?? null : chatModelId;
  const model = catalog?.items.find((item) => item.id === modelId);
  useEffect(() => { onComposerContext({ conversationId: conversation.id, modelId, kind }); }, [conversation.id, modelId, kind, onComposerContext]);
  const depth = (kind === "task" ? taskPreference.effort : chatPreference.effort) ?? model?.default_reasoning_effort ?? "auto";
  async function updateModel(model_id: string | null, reasoning_effort: ReasoningEffort | null) {
    if (kind === "task") {
      setTaskModelId(model_id);
      setTaskEffort(reasoning_effort);
      return;
    }
    setModelBusy(true);
    try {
      const updated = await request<Conversation>(connection, `/conversations/${conversation.id}/model`, {
        method: "PUT", body: { model_id, reasoning_effort },
      });
      onConversationChanged(updated);
    } finally {
      setModelBusy(false);
    }
  }

  return (
    <View style={s.body}>
      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ padding: 16 }} />
      ) : null}
      <FlatList
        ListFooterComponent={<ApprovalCards connection={connection} conversationId={conversation.id} onChanged={() => refresh.current()} />}
        ref={list}
        data={messages}
        keyExtractor={(message) => message.id}
        onScrollToIndexFailed={({ index, averageItemLength }) => {
          if (focusAttempts.current++ > 3) return;
          list.current?.scrollToOffset({ offset: averageItemLength * Math.max(0, index - 1), animated: false });
          setTimeout(() => list.current?.scrollToIndex({ index, animated: true, viewPosition: 0.3 }), 250);
        }}
        contentContainerStyle={{
          paddingHorizontal: 18,
          paddingVertical: 16,
          gap: 20,
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
              alignSelf: item.role === "user" && !item.origin ? "flex-end" : "stretch",
              maxWidth: item.role === "user" && !item.origin ? "88%" : "100%",
              gap: 5,
              backgroundColor: item.seq === focusMessageSeq ? colors.pale : "transparent",
              borderRadius: 14,
            }}
          >
            <View style={[chatStyles.messageIdentity, item.role === "user" && !item.origin && { justifyContent: "flex-end" }]}>
            {item.role === "assistant" ? <View style={chatStyles.assistantMark}><Ionicons name="sparkles" size={13} color={colors.accent} /></View> : null}
            <Text style={[s.muted, item.role === "assistant" && { color: colors.ink, fontWeight: "600" }]}>
              {item.origin === "assistant_task" ? "后台任务" : item.role === "assistant" ? assistantName : "你"}
              {item.intent === "steer"
                ? ` · 引导${item.status === "applied" ? "已应用" : item.status === "rejected" ? "未应用" : "待应用"}`
                : ""}
            </Text>
            </View>
            <View style={item.role === "user" && !item.origin ? chatStyles.userBubble : chatStyles.assistantContent}>
              <MessageBody>{item.content}</MessageBody>
              <Attachments connection={connection} items={item.attachments} />
            </View>
            {item.role === "assistant" || item.run_id ? (
              <View style={[chatStyles.messageActions, item.role === "user" && !item.origin && { justifyContent: "flex-end" }]}>
                {item.role === "assistant" ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={speaking === item.id ? "停止朗读" : "朗读消息"}
                    style={chatStyles.messageAction}
                    onPress={() => {
                      void speak(item).catch((e) => setError(humanError(e)));
                    }}
                  >
                    <Ionicons name={speaking === item.id ? "stop-circle-outline" : "volume-medium-outline"} size={18} color={colors.muted} />
                  </Pressable>
                ) : null}
                {item.run_id ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="查看任务记录"
                    style={chatStyles.messageAction}
                    onPress={() => setDetail(item.run_id)}
                  >
                    <Ionicons name="receipt-outline" size={18} color={colors.muted} />
                  </Pressable>
                ) : null}
                <Text style={s.small}>{timeLabel(item.created_at)}</Text>
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
              : pendingRuns.some((run) => run.phase === "approval") ? "有操作需要你的决定" : `${pendingRuns.length} 条等待执行`}
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
      <ConversationComposer
        text={draft.text} editable={draftReady && !draft.pending && !busy}
        onText={(text) => { void updateDraft({ ...draft, text, pending: null }).catch((e) => setError(humanError(e))); }}
        canSend={draftReady && !busy && !modelBusy && !!(draft.text.trim() || draft.attachments?.length)} busy={busy} pending={!!draft.pending}
        attachmentLocked={!draftReady || !!draft.pending || busy} onFiles={() => setShowFiles(true)}
        kind={kind} onKind={setKind} kindLocked={intent === "steer"}
        connection={connection} model={model} depth={depth} searchId={searchProviderId}
        optionsLocked={!catalog || modelBusy || busy || !!draft.pending || intent === "steer"}
        onModel={conversation.agent_id ? undefined : () => setShowModels(true)}
        onReasoning={conversation.agent_id ? undefined : () => setShowReasoning(true)}
        onSearch={conversation.agent_id ? undefined : () => setShowSearch(true)}
        onSend={() => { void send({ ...(kind === "task" && taskPreference.modelId ? { model_id: taskPreference.modelId } : {}), ...(kind === "task" && taskPreference.effort ? { reasoning_effort: taskPreference.effort } : {}), ...(searchProviderId ? { search_provider_id: searchProviderId } : {}) }); }}
        hint={(running || intent === "steer") ? <View style={chatStyles.delivery}>
          {(["queue", "steer"] as const).map((value) => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={value === "queue" ? "排队：当前运行结束后处理" : "引导：发送给当前运行"} accessibilityState={{ checked: intent === value, disabled: !!draft.pending || (value === "steer" && !running) }} disabled={!!draft.pending || (value === "steer" && !running)} onPress={() => { setIntent(value); if (value === "steer" && running) setKind(running.kind); setTarget(value === "steer" ? running?.id ?? null : null); }} style={[chatStyles.deliveryChoice, intent === value && { backgroundColor: colors.neutral }]}><Ionicons name={value === "queue" ? "layers-outline" : "git-branch-outline"} size={13} color={colors.muted} /><Text style={s.caption}>{value === "queue" ? "接着处理" : "调整当前任务"}</Text></Pressable>)}
          {intent === "steer" && running?.id !== target ? <Text style={s.error}>目标已结束，请切回接着处理</Text> : null}
        </View> : null}
      >
        <Attachments connection={connection} items={draft.attachments} remove={draft.pending ? undefined : (id) => { void removeAttachment(id).catch((e) => setError(humanError(e))); }} />
      </ConversationComposer>
      {draft.pending ? <View style={chatStyles.pending}><Text style={[s.muted, s.grow]}>提交尚未确认 · 可重试，内容仍保留</Text>{!busy ? <Pressable accessibilityRole="button" onPress={abandonPending} style={s.linkButton}><Text style={s.link}>编辑草稿</Text></Pressable> : null}</View> : null}
      {error ? <Text accessibilityRole="alert" style={[s.error, { marginHorizontal: 18, marginBottom: 6 }]}>{error}</Text> : null}
      <ModelPicker
        visible={showModels}
        title={`选择${kind === "task" ? "任务" : "聊天"}模型`}
        connectionUrl={connection.url}
        models={catalog?.items ?? []}
        selectedId={modelId}
        onSelect={(id) => updateModel(id, null)}
        onUseDefault={(kind === "task" ? taskModelId : conversation.model_id) ? () => updateModel(null, null) : undefined}
        defaultLabel={kind === "task" ? "跟随默认任务模型" : "跟随默认聊天模型"}
        onClose={() => setShowModels(false)}
      />
      <ReasoningPicker visible={showReasoning} model={model} selected={kind === "task" ? taskPreference.effort : chatPreference.effort} onSelect={(value) => updateModel(kind === "task" ? taskPreference.modelId : chatPreference.modelId, value)} onClose={() => setShowReasoning(false)} />
      <SearchPicker visible={showSearch} connection={connection} selectedId={searchProviderId} onSelect={setSearchProviderId} onClose={() => setShowSearch(false)} />
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
  const { s, colors } = useUi();
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const retry = useRef<() => void>(() => undefined);
  const reportSync = useSyncStatus(() => retry.current());
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
        reportSync();
      } catch (e) {
        if (active) reportSync(e);
      } finally {
        polling = false;
      }
    }
    retry.current = () => { void poll(); };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 2000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [connection, id, reportSync]);
  return (
    <SafeAreaView style={s.root}>
      <SheetHeader title="任务记录" onClose={close} />
      <ScrollView contentContainerStyle={s.content}>
        {error ? <Text style={s.error}>{error}</Text> : null}
        {run ? (
          <>
            <Text style={s.title}>{run.prompt}</Text>
            <Text style={s.muted}>
              {run.status === "queued" && run.phase === "approval" ? "等待批准" : run.status === "queued" && run.phase === "recovering" ? "正在恢复任务" : runLabels[run.status]} · {run.id.slice(0, 8)}
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
            {run.status === "interrupted" && run.recovery_enabled ? <Button onPress={() => {
              void request<Run>(connection, `/runs/${run.id}/resume`, { method: "POST" }).then(setRun).catch((e) => setError(humanError(e)));
            }}>核对已有步骤并继续原任务</Button> : null}
            <ApprovalCards connection={connection} runId={run.id} />
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
  if (event.type === "recovering") return "已保留进度，正在核对并继续原任务。";
  if (event.type === "paused") return event.data.reason === "resume" ? "决定已保存，准备继续任务。" : "任务进度已保存，等待操作决定。";
  if (event.type === "operation") {
    const labels: Record<string, string> = { prepared: "准备就绪", started: "已开始", succeeded: "已核对完成", failed: "未完成", denied: "未获批准", unconfirmed: "结果待核对" };
    return `${String(event.data.tool ?? "操作")} · ${labels[String(event.data.state)] ?? "状态已更新"}`;
  }
  if (event.type === "approval") {
    const labels: Record<string, string> = { pending: "等待决定", approve: "已允许", deny: "已拒绝", retry: "允许重试", skip: "保留现状并核对", cancelled: "已撤销" };
    return `操作授权 · ${labels[String(event.data.status)] ?? "状态已更新"}`;
  }
  if (event.type === "execution") {
    const labels: Record<string, string> = { started: "开始执行", running: "执行中", completed: "执行完成", failed: "执行失败", cancelled: "已停止执行", timed_out: "执行超时，已停止", interrupted: "服务重启，已停止旧进程" };
    return `${labels[String(event.data.status)] ?? "执行进度"}${typeof event.data.exit_code === "number" ? ` · 退出码 ${event.data.exit_code}` : ""}${typeof event.data.output === "string" && event.data.output ? `\n${event.data.output}` : ""}`;
  }
  if (event.type === "artifact") {
    const resource = event.data.resource as { name?: string } | undefined;
    return `已交付：${resource?.name ?? "文件"}`;
  }
  const content =
    event.data.message ??
    event.data.content ??
    event.data.name ??
    event.data.error;
  return typeof content === "string"
    ? content
    : JSON.stringify(event.data, null, 2);
}

const createChatStyles = (colors: ThemeColors) => StyleSheet.create({
  delivery: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4, paddingBottom: 5 },
  deliveryChoice: { minHeight: 36, paddingHorizontal: 9, borderRadius: 8, flexDirection: "row", alignItems: "center", gap: 5 },
  pending: { flexDirection: "row", alignItems: "center", marginHorizontal: 18 },
  messageIdentity: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 24 },
  assistantMark: { width: 24, height: 24, borderRadius: 8, backgroundColor: colors.pale, alignItems: "center", justifyContent: "center" },
  userBubble: { backgroundColor: colors.neutral, borderRadius: 17, borderTopRightRadius: 5, paddingHorizontal: 13, paddingVertical: 10 },
  assistantContent: { paddingHorizontal: 2 },
  messageActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  messageAction: { minHeight: 44, minWidth: 36, alignItems: "center", justifyContent: "center" },
  actionText: { color: colors.accent, fontSize: 12, fontWeight: "500" },
  runBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: colors.neutral,
  },
  link: { color: colors.accent, fontSize: 12, fontWeight: "600" },
});
