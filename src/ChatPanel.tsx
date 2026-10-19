import { availablePreference } from "./providerEditing";
import { layout, type ThemeColors } from "./theme";
import { useUi, ActionLink, Button, Empty, humanError, runLabels, SheetHeader, timeLabel } from "./ui";
import { useThemedStyles } from "./ThemeProvider";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
  type ViewToken,
} from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { useSyncStatus } from "./ConnectionStatus";
import { ConversationComposer } from "./ConversationComposer";
import { BottomSheet } from "./BottomSheet";
import { useChatPreferences } from "./chatPreferences";
import { ReplyContent } from "./ReplyContent";
import { useReplyProcesses } from "./useReplyProcesses";
import { conversationReplyRows, isPendingReply, replyRowKey } from "./replyProcess";
import * as Clipboard from "expo-clipboard";
import { useNotice } from "./Notice";
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
  type Message,
  type Resource,
} from "./api";
import { useChat } from "./useChat";
import { ModelPicker, reasoningLabel } from "./ModelPicker";
import { Attachments } from "./Attachments";
import { ApprovalCards } from "./ApprovalCards";
import { RunReport } from "./RunReport";
import { FilesPanel } from "./FilesPanel";
import { SearchPicker } from "./SearchPicker";
import { QueuedMessages } from "./QueuedMessages";
import { useQueuedMessages } from "./useQueuedMessages";

const searchViewabilityConfig = { itemVisiblePercentThreshold: 1 };
const historyAnchor = { minIndexForVisible: 0 };

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
  onFocusHandled,
  startWithFiles = false,
  onFilesOpened,
  onConversationChanged,
  onComposerContext,
  onRefresh,
  onRunsChanged,
  intro,
  stretchIntro = false,
  agentModelId = null,
  settingsOpen = false,
  onSettingsClose,
  onOpenChatSettings,
  onPin,
  pinned = false,
  pinReady = true,
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
  onFocusHandled?: (seq: number) => void;
  startWithFiles?: boolean;
  onFilesOpened?: () => void;
  onConversationChanged: (conversation: Conversation) => void;
  onComposerContext?: (value: { conversationId: string; modelId: string | null; kind: "chat" | "task" }) => void;
  onRefresh: () => void;
  onRunsChanged?: (runs: Run[]) => void;
  intro?: ReactNode;
  stretchIntro?: boolean;
  agentModelId?: string | null;
  settingsOpen?: boolean;
  onSettingsClose?: () => void;
  onOpenChatSettings?: () => void;
  onPin?: () => void;
  pinned?: boolean;
  pinReady?: boolean;
}) {
  const { s, colors } = useUi();
  const chatStyles = useThemedStyles(createChatStyles);
  const chatPreferences = useChatPreferences();
  const notice = useNotice();
  const [messageMenu, setMessageMenu] = useState<Message | null>(null);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [visibleRuns, setVisibleRuns] = useState<string[]>([]);
  const draggingMessages = useRef(false);
  const [showModels, setShowModels] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [taskModelId, setTaskModelId] = useState(initialTaskModelId);
  const [taskEffort, setTaskEffort] = useState(initialTaskEffort);
  const [searchProviderId, setSearchProviderId] = useState(initialSearchId);
  const [showSearch, setShowSearch] = useState(false);
  // Keep the loaded history window when navigation consumes the search target.
  const [focusRequest, setFocusRequest] = useState({ input: focusMessageSeq, seq: focusMessageSeq, id: 0 });
  if (focusMessageSeq !== focusRequest.input) setFocusRequest({
    input: focusMessageSeq, seq: focusMessageSeq ?? focusRequest.seq,
    id: focusMessageSeq === null ? focusRequest.id : focusRequest.id + 1,
  });
  const focusAnchor = focusRequest.seq;
  const {
    messages,
    runs = [],
    running,
    previous,
    draft,
    draftReady,
    draftLoadError,
    retryDraft,
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
  } = useChat({ connection, conversation, onRefresh, initialKind, startWithFiles, focusMessageSeq: focusAnchor,
    defaultIntent: chatPreferences.defaultIntent, defaultIntentReady: chatPreferences.ready, streamEvents: false });
  const refreshQueuedMessages = useCallback(() => refresh.current(), [refresh]);
  const replyIds = [...messages.filter((item) => item.role === "assistant" && !item.origin).slice(-20).map((item) => item.run_id),
    ...visibleRuns.filter((id) => messages.some((item) => item.run_id === id)), ...runs.filter((item) => item.started_at || item.status === "running" || item.phase && item.phase !== "normal").slice(-20).map((item) => item.id)];
  const replyRecords = useReplyProcesses(connection, conversation.id, replyIds, runs, refreshQueuedMessages);
  const rows = conversationReplyRows(messages, runs, replyRecords);
  const goToLatest = () => { nearBottomRef.current = true; setAwayFromLatest(false); list.current?.scrollToEnd({ animated: true }); };
  const replyStatus = (id: string) => {
    const run = runs.find((value) => value.id === id);
    return run && !["running", "queued"].includes(run.status) ? run.status : replyRecords[id]?.status ?? run?.status;
  };
  const actionMessage = (message: Message): Message => message.content || !isPendingReply(message) ? message : { ...message,
    content: (replyRecords[message.run_id]?.buffer.parts ?? []).filter((part) => part.type === "text" && part.attempt_status !== "failed").map((part) => part.type === "text" ? part.text : "").join("\n\n") };
  async function copyMessage(message: Message) {
    if (!message.content) { notice.show({ message: "这条回复尚无可复制正文" }); return; }
    try { await Clipboard.setStringAsync(message.content); notice.show({ message: "已复制消息", tone: "success" }); }
    catch (e) { setError(humanError(e)); }
  }
  async function messageToDraft(message: Message) {
    if (!draftReady || draft.pending || busy) return;
    const addition = message.role === "user" ? message.content : `关于这条回复：\n${message.content}\n\n`;
    try {
      const text = [draft.text, addition].filter(Boolean).join("\n\n");
      if (text.length > 20000) { notice.show({ message: "内容超过草稿长度，可先复制并选取需要的部分", tone: "warning" }); return; }
      await updateDraft({ ...draft, text, pending: null });
      setMessageMenu(null); notice.show({ message: "已放入草稿，可修改后发送" });
    } catch (e) { setError(humanError(e)); }
  }
  const queuedMessages = useQueuedMessages({ connection, conversationId: conversation.id, runs, running,
    onChanged: refreshQueuedMessages, onError: setError });
  const runStates = useRef<{ conversationId: string; statuses: Map<string, Run["status"]> }>({ conversationId: conversation.id, statuses: new Map() });
  useEffect(() => {
    if (!onRunsChanged) return;
    if (runStates.current.conversationId !== conversation.id) runStates.current = { conversationId: conversation.id, statuses: new Map() };
    const changed = runs.filter((run) => run.conversation_id === conversation.id && runStates.current.statuses.get(run.id) !== run.status);
    if (!changed.length) return;
    changed.forEach((run) => runStates.current.statuses.set(run.id, run.status));
    onRunsChanged(changed);
  }, [conversation.id, onRunsChanged, runs]);
  const focusState = useRef({ seq: focusAnchor, requested: false, handled: false, attempts: 0 });
  useEffect(() => {
    focusState.current = { seq: focusAnchor, requested: false, handled: false, attempts: 0 };
    if (focusAnchor !== null) nearBottomRef.current = false;
  }, [focusAnchor, focusRequest.id, nearBottomRef]);
  const focusHandled = useRef(onFocusHandled);
  useEffect(() => { focusHandled.current = onFocusHandled; }, [onFocusHandled]);
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken<Message>[] }) => {
    const ids = [...new Set(viewableItems.filter((item) => item.isViewable && item.item.role === "assistant").map((item) => item.item.run_id))].sort();
    setVisibleRuns((old) => old.join(",") === ids.join(",") ? old : ids);
    const target = focusState.current;
    if (target.seq === null || target.handled) return;
    if (viewableItems.some((item) => item.isViewable && item.item.seq === target.seq)) {
      target.handled = true;
      focusHandled.current?.(target.seq);
    }
  }, []);
  const focusRowIndex = rows.findIndex((message) => message.seq === focusAnchor);
  useEffect(() => {
    if (focusAnchor === null || focusState.current.requested || focusState.current.handled) return;
    nearBottomRef.current = false;
    if (loading) return;
    const index = focusRowIndex;
    if (index < 0) return;
    const timer = setTimeout(() => {
      focusState.current.requested = true;
      list.current?.scrollToIndex({ index, animated: true, viewPosition: 0.3 });
    }, 180);
    return () => clearTimeout(timer);
  }, [focusAnchor, focusRequest.id, list, loading, focusRowIndex, nearBottomRef]);
  useEffect(() => { if (startWithFiles) onFilesOpened?.(); }, [startWithFiles, onFilesOpened]);
  const effectiveCatalog = catalog && agentModelId && catalog.items.some((item) => item.id === agentModelId)
    ? { ...catalog, roles: { ...catalog.roles, chat: agentModelId, task: agentModelId } } : catalog;
  const taskPreference = availablePreference(effectiveCatalog, "task", taskModelId, taskEffort);
  const chatPreference = availablePreference(effectiveCatalog, "chat", conversation.model_id, conversation.reasoning_effort);
  const chatModelId = chatPreference.modelId ?? effectiveCatalog?.roles.chat ?? null;
  const modelId = kind === "task" ? taskPreference.modelId ?? effectiveCatalog?.roles.task ?? null : chatModelId;
  const model = catalog?.items.find((item) => item.id === modelId);
  useEffect(() => { onComposerContext?.({ conversationId: conversation.id, modelId, kind }); }, [conversation.id, modelId, kind, onComposerContext]);
  const depth = (kind === "task" ? taskPreference.effort : chatPreference.effort) ?? model?.default_reasoning_effort ?? "auto";
  const currentRun = running ?? pendingRuns[0];
  const staleTarget = intent === "steer" && running?.id !== target;
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
      <View style={{ flex: 1, minHeight: 0 }}>
      <FlatList
        ListFooterComponent={<View style={s.stack}>
          <ApprovalCards connection={connection} conversationId={conversation.id} onChanged={() => refresh.current()} />
        </View>}
        ref={list}
        data={rows}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={searchViewabilityConfig}
        maintainVisibleContentPosition={historyAnchor}
        keyExtractor={replyRowKey}
        onScrollToIndexFailed={({ index, averageItemLength }) => {
          if (focusState.current.attempts++ > 3) return;
          list.current?.scrollToOffset({ offset: averageItemLength * Math.max(0, index - 1), animated: false });
          const target = focusState.current.seq;
          setTimeout(() => { if (focusState.current.seq === target) list.current?.scrollToIndex({ index, animated: true, viewPosition: 0.3 }); }, 250);
        }}
        contentContainerStyle={{
          paddingHorizontal: 18,
          paddingVertical: 16,
          paddingBottom: queuedMessages.items.length ? 76 : 16,
          gap: 20,
          flexGrow: 1,
        }}
        keyboardShouldPersistTaps="handled"
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } =
            event.nativeEvent;
          const close = contentSize.height - contentOffset.y - layoutMeasurement.height < 8;
          if (!draggingMessages.current && close) nearBottomRef.current = true;
          setAwayFromLatest(!nearBottomRef.current);
        }}
        onScrollBeginDrag={() => { draggingMessages.current = true; nearBottomRef.current = false; }}
        onScrollEndDrag={(event) => {
          draggingMessages.current = false;
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          const atBottom = contentSize.height - contentOffset.y - layoutMeasurement.height < 8;
          nearBottomRef.current = atBottom; setAwayFromLatest(!atBottom);
        }}
        scrollEventThrottle={80}
        onContentSizeChange={() => {
          if (nearBottomRef.current)
            list.current?.scrollToEnd({ animated: false });
        }}
        ListHeaderComponent={
          <View style={{ gap: 12, ...(stretchIntro && !messages.length ? { flexGrow: 1 } : {}) }}>
            {intro}
            {previous ? <Button secondary disabled={busy} onPress={() => { void loadOlder(); }}>查看更早的消息</Button> : null}
          </View>
        }
        ListHeaderComponentStyle={stretchIntro && !messages.length ? { flexGrow: 1 } : undefined}
        ListEmptyComponent={
          !loading && !intro ? <Empty title="从这一刻开始">
            随便聊聊，或交给我一件事。{"\n"}这段对话会一直留在这里。
          </Empty> : null
        }
        renderItem={({ item }) => (
          <View
            style={{
              alignSelf: item.role === "user" && !item.origin ? "flex-end" : "stretch",
              maxWidth: item.role === "user" && !item.origin ? "88%" : "100%",
              gap: 5,
              backgroundColor: item.seq === focusAnchor ? colors.pale : "transparent",
              borderRadius: 14,
            }}
          >
            <View style={[chatStyles.messageIdentity, item.role === "user" && !item.origin && { justifyContent: "flex-end" }]}>
            {item.role === "assistant" ? <View style={chatStyles.assistantMark}><Ionicons name="sparkles" size={13} color={colors.accent} /></View> : null}
            <Text style={[s.muted, item.role === "assistant" && { color: colors.ink, fontWeight: "600" }]}>
              {item.origin === "agent_message" ? "其他对话的助手 · 只读咨询" : item.origin === "assistant_task" ? "后台任务" : item.role === "assistant" ? assistantName : "你"}
              {item.role === "user" && !item.origin && item.intent === "queue" && item.status === "rejected"
                && runs.some((run) => run.id === item.run_id && run.status === "cancelled" && run.started_at === null)
                ? " · 已撤回" : ""}
              {item.intent === "steer"
                ? ` · 引导${item.status === "applied" ? "已应用" : item.status === "rejected" ? "未应用" : "待应用"}`
                : ""}
            </Text>
            </View>
            <View onTouchStart={item.role === "assistant" ? () => { nearBottomRef.current = false; setAwayFromLatest(true); } : undefined}
              style={item.role === "user" && !item.origin ? chatStyles.userBubble : chatStyles.assistantContent}>
              {item.role === "assistant" && !item.origin ? (() => {
                const record = replyRecords[item.run_id], run = runs.find((value) => value.id === item.run_id);
                const status = replyStatus(item.run_id);
                return <ReplyContent parts={record?.buffer.parts ?? []} active={status === "running" || status === "queued"}
                  finalText={!isPendingReply(item) || item.content ? item.content : undefined} finalPartId={record?.finalProjection ? record.finalPartId : undefined}
                  status={status} phase={record?.buffer.phase ?? run?.phase} cancelRequested={run?.cancel_requested}
                  connectionIssue={record?.buffer.connectionIssue} truncated={record?.buffer.truncated}
                  onOpenRun={() => setDetail(item.run_id)} />;
              })() : <MessageBody>{item.content}</MessageBody>}
              <Attachments connection={connection} items={item.attachments} />
            </View>
            {!isPendingReply(item) || ["completed", "failed", "cancelled", "interrupted"].includes(replyStatus(item.run_id) ?? "") ? <View style={[chatStyles.messageActions, item.role === "user" && !item.origin && { justifyContent: "flex-end" }]}>
              <Pressable accessibilityRole="button" accessibilityLabel="复制消息" style={chatStyles.messageAction} onPress={() => { void copyMessage(actionMessage(item)); }}>
                <Ionicons name="copy-outline" size={17} color={colors.muted} />
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="更多消息操作" style={chatStyles.messageAction} onPress={() => setMessageMenu(actionMessage(item))}>
                <Ionicons name="ellipsis-horizontal" size={19} color={colors.muted} />
              </Pressable>
              <Text style={s.small}>{timeLabel(item.created_at)}</Text>
            </View> : null}
          </View>
        )}
      />
      {awayFromLatest ? <Pressable accessibilityRole="button" accessibilityLabel="回到最新消息" onPress={goToLatest}
        style={{ position: "absolute", bottom: queuedMessages.items.length ? 62 : 12, alignSelf: "center", minHeight: 44,
          paddingHorizontal: 16, gap: 7, flexDirection: "row", alignItems: "center", borderRadius: 22, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.line }}>
        <Ionicons name="arrow-down" size={17} color={colors.gold} /><Text style={s.description}>回到最新</Text>
      </Pressable> : null}
      </View>
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
        floating={queuedMessages.items.length ? <QueuedMessages key={conversation.id} connection={connection} items={queuedMessages.items} running={running}
          busyId={queuedMessages.busyId} error={queuedMessages.error} onWithdraw={queuedMessages.withdraw}
          onSteer={queuedMessages.steer} onOpenRun={setDetail} /> : undefined}
        placeholder={`和${assistantName}聊聊，或交代一件事…`}
        text={draft.text} editable={draftReady && !draft.pending && !busy}
        onText={(text) => { void updateDraft({ ...draft, text, pending: null }).catch((e) => setError(humanError(e))); }}
        stopping={!!running && !draft.text.trim() && !draft.attachments?.length && !draft.pending}
        stopDisabled={!!running?.cancel_requested}
        onStop={() => { if (running) void cancel(running).catch(() => undefined); }}
        canSend={draftReady && (chatPreferences.ready || !!draft.pending) && !busy && !modelBusy && !!(draft.text.trim() || draft.attachments?.length)} busy={busy} pending={!!draft.pending}
        attachmentLocked={!draftReady || !!draft.pending || busy} onFiles={() => setShowFiles(true)}
        kind={kind} onKind={setKind} kindLocked={intent === "steer"}
        connection={connection} model={model} depth={depth} searchId={searchProviderId}
        optionsLocked={!catalog || modelBusy || busy || !!draft.pending || intent === "steer"}
        onModel={() => setShowModels(true)}
        onReasoning={() => setShowReasoning(true)}
        onSearch={() => setShowSearch(true)}
        onSend={() => { void send({ ...(kind === "task" && taskPreference.modelId ? { model_id: taskPreference.modelId } : {}), ...(kind === "task" && taskPreference.effort ? { reasoning_effort: taskPreference.effort } : {}), ...(searchProviderId ? { search_provider_id: searchProviderId } : {}) }); }}
      >
        <Attachments connection={connection} items={draft.attachments} remove={!draftReady || draft.pending || busy ? undefined : (id) => { void removeAttachment(id).catch((e) => setError(humanError(e))); }} />
      </ConversationComposer>
      {draftLoadError ? <View style={{ marginHorizontal: 18, marginBottom: 6 }}>
        <Text accessibilityRole="alert" style={s.error}>草稿暂时无法读取：{draftLoadError}</Text>
        <Button secondary small onPress={retryDraft}>重新读取草稿</Button>
      </View> : null}
      {draft.pending ? <View style={chatStyles.pending}><Text style={[s.muted, s.grow]}>提交尚未确认 · 可重试，内容仍保留</Text>{!busy ? <Pressable accessibilityRole="button" onPress={abandonPending} style={s.linkButton}><Text style={s.link}>编辑草稿</Text></Pressable> : null}</View> : null}
      {error ? <Text accessibilityRole="alert" style={[s.error, { marginHorizontal: 18, marginBottom: 6 }]}>{error}</Text> : null}
      <BottomSheet visible={settingsOpen} title="当前对话" onClose={() => onSettingsClose?.()}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
          <Text style={s.text}>{running
            ? `正在${running.kind === "task" ? "处理委托" : "回复"} · ${pendingRuns.filter((run) => run.status === "queued").length} 条等待`
            : pendingRuns.some((run) => run.phase === "input") ? "有问题需要你补充" : pendingRuns.some((run) => run.phase === "approval") ? "有操作需要你的决定" : pendingRuns.some((run) => run.phase === "agent_wait") ? "等待其他对话回复" : pendingRuns.length ? `${pendingRuns.length} 条等待执行` : "当前没有正在处理的回复"}</Text>
          {currentRun ? <ActionLink icon="receipt-outline" onPress={() => setDetail(currentRun.id)}>查看运行进度</ActionLink> : null}
          {running ? <Button secondary danger disabled={running.cancel_requested} onPress={() => { void cancel(running).catch(() => undefined); }}>{running.cancel_requested ? "已请求取消" : "取消当前运行"}</Button> : null}
          <Text style={s.muted}>本条发送方式：{intent === "steer" ? "补充当前回复" : "接着处理"}</Text>
          {running && !!(draft.text.trim() || draft.attachments?.length) ? <View style={s.stack}>
            {(["queue", "steer"] as const).map((value) => <Pressable key={value} accessibilityRole="radio"
              accessibilityLabel={value === "queue" ? "本条接着处理" : "本条补充当前回复"}
              accessibilityState={{ checked: intent === value && (value === "queue" || target === running.id), disabled: !!draft.pending || busy }}
              disabled={!!draft.pending || busy}
              onPress={() => { void updateDraft({ ...draft, delivery: { intent: value, ...(value === "steer" ? { target_run_id: running.id } : {}) } }).catch((e) => setError(humanError(e))); }}
              style={[s.row, { minHeight: layout.touchTarget, gap: 10 }]}>
              <Ionicons name={intent === value && (value === "queue" || target === running.id) ? "radio-button-on" : "radio-button-off"} size={21} color={colors.gold} />
              <Text style={s.text}>{value === "queue" ? "接着处理" : "补充当前回复"}</Text>
            </Pressable>)}
          </View> : null}
          {staleTarget ? <View style={s.stack}>
            <Text accessibilityRole="alert" style={s.error}>补充目标已结束，请改为接着处理。</Text>
            <Button secondary disabled={!!draft.pending || busy} onPress={() => { setIntent("queue"); setTarget(null); }}>改为接着处理</Button>
          </View> : null}
          {!chatPreferences.ready ? <Text style={s.muted}>{chatPreferences.error ? "发送设置尚未读取，新消息暂不能发送。" : "正在读取发送设置…"}</Text> : null}
          {chatPreferences.error ? <View style={s.stack}>
            <Text accessibilityRole="alert" style={s.error}>{chatPreferences.error}</Text>
            <ActionLink icon="refresh-outline" onPress={chatPreferences.retry}>重新读取发送设置</ActionLink>
          </View> : null}
          {onOpenChatSettings ? <ActionLink icon="options-outline" onPress={onOpenChatSettings}>默认发送方式</ActionLink> : null}
          {onPin ? <ActionLink icon={pinned ? "bookmark" : "bookmark-outline"} disabled={!pinReady} onPress={onPin}>{pinned ? "取消固定此对话" : "固定此对话"}</ActionLink> : null}
          {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
        </ScrollView>
      </BottomSheet>
      <BottomSheet visible={!!messageMenu} title="消息操作" onClose={() => setMessageMenu(null)}>
        {messageMenu ? <View style={s.content}>
          <ActionLink icon="copy-outline" onPress={() => { void copyMessage(messageMenu); setMessageMenu(null); }}>复制消息</ActionLink>
          <ActionLink icon="create-outline" disabled={!draftReady || !!draft.pending || busy} onPress={() => { void messageToDraft(messageMenu); }}>{messageMenu.role === "user" ? "修改后重新发送" : "引用到草稿"}</ActionLink>
          {messageMenu.role === "assistant" ? <ActionLink icon="volume-medium-outline" onPress={() => { void speak(messageMenu).catch((e) => setError(humanError(e))); setMessageMenu(null); }}>{speaking === messageMenu.id ? "停止朗读" : "朗读消息"}</ActionLink> : null}
          {messageMenu.run_id ? <ActionLink icon="receipt-outline" onPress={() => { setDetail(messageMenu.run_id); setMessageMenu(null); }}>查看处理记录</ActionLink> : null}
        </View> : null}
      </BottomSheet>
      <ModelPicker
        visible={showModels}
        title={`选择${kind === "task" ? "任务" : "聊天"}模型`}
        connectionUrl={connection.url}
        models={catalog?.items ?? []}
        selectedId={modelId}
        onSelect={(id) => updateModel(id, null)}
        onUseDefault={(kind === "task" ? taskModelId : conversation.model_id) ? () => updateModel(null, null) : undefined}
        defaultLabel={agentModelId ? "跟随助手默认模型" : kind === "task" ? "跟随默认任务模型" : "跟随默认聊天模型"}
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
            key={detail}
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
  const [showEvents, setShowEvents] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const retry = useRef<() => void>(() => undefined);
  const reportSync = useSyncStatus(() => retry.current());
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [eventsError, setEventsError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    let polling = false;
    let cursor = 0;
    let catchUpTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function poll() {
      if (polling || !active) return;
      polling = true;
      setLoading(true);
      let hasMore = false;
      try {
        const results = await Promise.allSettled([
          request<Run>(connection, `/runs/${id}`, {
            signal: controller.signal,
          }).then((task) => {
            if (!active) return;
            setRun(task);
            setLoadError("");
          }).catch((e) => {
            if (active) setLoadError(humanError(e));
            throw e;
          }),
          request<Page<RunEvent>>(
            connection,
            `/runs/${id}/events?after=${cursor}&limit=100`,
            { signal: controller.signal },
          ).then((page) => {
            if (!active) return;
            setEvents((old) => [...old, ...page.items]);
            if (page.items.length) cursor = page.items[page.items.length - 1].seq;
            hasMore = !!page.next_cursor;
            setEventsError("");
          }).catch((e) => {
            if (active) setEventsError(humanError(e));
            throw e;
          }),
        ]);
        if (!active) return;
        const failure = results.find((result) => result.status === "rejected");
        reportSync(failure?.reason);
      } finally {
        polling = false;
        if (active) setLoading(false);
        if (active && hasMore) catchUpTimer = setTimeout(() => { void poll(); }, 100);
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
      clearTimeout(catchUpTimer);
    };
  }, [connection, id, reportSync]);
  const artifacts = [...new Map(events.flatMap((event) => {
    const item = event.data.resource;
    if (event.type !== "artifact" || !item || typeof item !== "object") return [];
    const resource = item as Partial<Resource>;
    return typeof resource.id === "string" && typeof resource.name === "string" && typeof resource.path === "string"
      && typeof resource.mime_type === "string" && typeof resource.size === "number" && typeof resource.conversation_id === "string"
      ? [[resource.id, resource as Resource] as const] : [];
  })).values()];
  async function control(action: () => Promise<void>) {
    if (controlBusy) return;
    setControlBusy(true); setError("");
    try { await action(); retry.current(); } catch (e) { setError(humanError(e)); }
    finally { setControlBusy(false); }
  }
  return (
    <SafeAreaView style={s.root}>
      <SheetHeader title="处理记录" onClose={close} />
      <ScrollView contentContainerStyle={s.content}>
        {error ? <Text style={s.error}>{error}</Text> : null}
        {loadError ? <View style={s.notice}>
          <Text accessibilityRole="alert" style={s.error}>{run ? "任务状态暂未更新" : "任务暂时无法读取"}：{loadError}</Text>
          <Button secondary disabled={loading} onPress={() => retry.current()}>重试读取任务</Button>
        </View> : null}
        {run ? (
          <>
            <Text style={s.title}>{run.prompt}</Text>
            <Text style={s.muted}>
              {run.status === "queued" && run.phase === "input" ? "等待回答" : run.status === "queued" && run.phase === "approval" ? "等待批准" : run.status === "queued" && run.phase === "agent_wait" ? "等待其他对话回复" : run.status === "queued" && run.phase === "recovering" ? "正在恢复任务" : runLabels[run.status]} · {run.id.slice(0, 8)}
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
            {(run.status === "interrupted" || run.status === "failed") && run.recovery_enabled && !run.cancel_requested ? <Button disabled={controlBusy} onPress={() => {
              void control(async () => { setRun(await request<Run>(connection, `/runs/${run.id}/resume`, { method: "POST" })); });
            }}>{run.status === "failed" ? "重试这次回复" : "继续这次回复"}</Button> : null}
            <ApprovalCards connection={connection} runId={run.id} />
            {run.result ? (
              <View style={s.card}>
                <Text style={s.label}>结果</Text>
                <MessageBody>{run.result}</MessageBody>
              </View>
            ) : null}
            {artifacts.length ? <View style={s.card}>
              <Text style={s.label}>交付文件</Text>
              <Attachments connection={connection} items={artifacts} />
            </View> : null}
            <RunReport connection={connection} runId={run.id} />
            {run.status === "queued" || run.status === "running" ? (
              <Button
                secondary
                danger
                disabled={run.cancel_requested || controlBusy}
                onPress={() => {
                  void control(() => onCancel(run));
                }}
              >
                {run.cancel_requested ? "已请求取消" : "取消这次运行"}
              </Button>
            ) : null}
          </>
        ) : !loadError ? (
          <ActivityIndicator color={colors.accent} />
        ) : null}
        {eventsError ? <View style={s.notice}>
          <Text accessibilityRole="alert" style={s.error}>步骤与交付文件暂未更新：{eventsError}</Text>
          <Button secondary disabled={loading} onPress={() => retry.current()}>重试读取步骤</Button>
        </View> : null}
        <Pressable accessibilityRole="button" accessibilityLabel={showEvents ? "收起执行轨迹" : "展开执行轨迹"}
          accessibilityState={{ expanded: showEvents }} onPress={() => setShowEvents((value) => !value)}
          style={[s.row, { minHeight: layout.touchTarget }]}>
          <View style={s.headingCopy}><Text style={s.label}>执行轨迹</Text><Text style={s.muted}>{events.length} 条记录 · 按需查看详细步骤</Text></View>
          <Ionicons name={showEvents ? "chevron-up" : "chevron-down"} size={18} color={colors.muted} />
        </Pressable>
        {showEvents ? events.length ? (
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
        ) : !eventsError ? (
          <Text style={s.muted}>{loading ? "正在读取执行轨迹…" : "尚无执行事件。"}</Text>
        ) : null : null}
      </ScrollView>
    </SafeAreaView>
  );
}
function eventSummary(event: RunEvent) {
  if (event.type === "retry") return `连接短暂波动，正在重试（第 ${String(event.data.attempt)} 次）。`;
  if (event.type === "model_error") return `模型请求未成功 · ${String(event.data.kind ?? "未知原因")}`;
  if (event.type === "usage") return `已报告用量：输入 ${String(event.data.input_tokens ?? 0)} / 输出 ${String(event.data.output_tokens ?? 0)} token · 调用 ${String(event.data.model_attempts ?? 0)} 次${event.data.unknown_usage ? " · 部分调用未返回用量" : ""}`;
  if (event.type === "input_required") return String(event.data.question ?? "等待补充信息");
  if (event.type === "input_answered") return "回答已保存，将继续原任务。";
  if (event.type === "task_plan") return "任务完成条件已记录。";
  if (event.type === "task_check") return `验证 ${String(event.data.step_id)} · ${event.data.status === "passed" ? "已取得证据" : "存在阻碍"}`;
  if (event.type === "recovering") return "已保留进度，正在核对并继续原任务。";
  if (event.type === "paused") return event.data.reason === "input" ? "任务进度已保存，等待补充信息。" : event.data.reason === "resume" ? "决定已保存，准备继续任务。" : "任务进度已保存，等待操作决定。";
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
  pending: { flexDirection: "row", alignItems: "center", marginHorizontal: 18 },
  messageIdentity: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 24 },
  assistantMark: { width: 24, height: 24, borderRadius: 8, backgroundColor: colors.pale, alignItems: "center", justifyContent: "center" },
  userBubble: { backgroundColor: colors.neutral, borderRadius: 17, borderTopRightRadius: 5, paddingHorizontal: 13, paddingVertical: 10 },
  assistantContent: { paddingHorizontal: 2 },
  messageActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  messageAction: { minHeight: layout.touchTarget, minWidth: layout.touchTarget, alignItems: "center", justifyContent: "center" },
  actionText: { color: colors.accent, fontSize: 12, fontWeight: "500" },
});
