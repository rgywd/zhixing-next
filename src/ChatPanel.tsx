import { useEffect, useState } from "react";
import Markdown, { type ASTNode, type MarkdownStyleMap } from "@ronradtke/react-native-markdown-display";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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
import { ModelPicker, reasoningLabel } from "./ModelPicker";
import { Attachments } from "./Attachments";
import { FilesPanel } from "./FilesPanel";
import { SearchPicker } from "./SearchPicker";
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
}) {
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
    removeAttachment,
    speak,
    pendingRuns,
    updateDraft,
  } = useChat({ connection, conversation, onRefresh, initialKind, startWithFiles });
  useEffect(() => { if (startWithFiles) onFilesOpened?.(); }, [startWithFiles, onFilesOpened]);
  const chatModelId = conversation.model_id ?? catalog?.roles.chat ?? null;
  const modelId = kind === "task" ? taskModelId ?? catalog?.roles.task ?? null : chatModelId;
  const model = catalog?.items.find((item) => item.id === modelId);
  const depth = (kind === "task" ? taskEffort : conversation.reasoning_effort) ?? model?.default_reasoning_effort ?? "auto";
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
            }}
          >
            <Text style={[s.muted, item.role === "user" && !item.origin && chatStyles.userMeta]}>
              {item.origin === "assistant_task" ? "后台任务" : item.role === "assistant" ? assistantName : "你"} ·{" "}
              {timeLabel(item.created_at)}
              {item.intent === "steer"
                ? ` · 引导${item.status === "applied" ? "已应用" : item.status === "rejected" ? "未应用" : "待应用"}`
                : ""}
            </Text>
            <View style={item.role === "user" && !item.origin ? chatStyles.userBubble : chatStyles.assistantContent}>
              <Markdown
                style={markdownStyles}
                textcomponent={SelectableText}
                rules={markdownRules}
                onLinkPress={openWebLink}
              >
                {item.content}
              </Markdown>
              <Attachments connection={connection} items={item.attachments} />
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
      <View style={chatStyles.composerArea}>
        <View style={chatStyles.composer}>
          <Attachments connection={connection} items={draft.attachments} remove={draft.pending ? undefined : (id) => { void removeAttachment(id).catch((e) => setError(humanError(e))); }} />
          <TextInput
            accessibilityLabel="消息或任务要求"
            multiline
            placeholder={kind === "task" ? "交给知行完成…" : "输入消息与知行聊天…"}
            placeholderTextColor={colors.muted}
            value={draft.text}
            maxLength={20000}
            scrollEnabled
            editable={draftReady && !draft.pending && !busy}
            onChangeText={(text) => {
              void updateDraft({ ...draft, text, pending: null }).catch((e) => setError(humanError(e)));
            }}
            style={chatStyles.composerInput}
          />
          {intent === "steer" ? (
            <Text style={chatStyles.composerHint}>
              {running?.id === target ? "引导当前运行 · 在下一可调整步骤生效" : "目标已结束，请切回排队发送"}
            </Text>
          ) : null}
          <View style={chatStyles.toolbar}>
            <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} style={chatStyles.toolbarChoices} contentContainerStyle={chatStyles.toolbarChoicesContent}>
              {!conversation.agent_id ? (
              <Pressable accessibilityRole="button" accessibilityLabel={`选择${kind === "task" ? "任务" : "聊天"}模型，当前${model?.name ?? "未配置"}`} accessibilityState={{ disabled: !catalog || modelBusy || !!draft.pending || intent === "steer" }} disabled={!catalog || modelBusy || !!draft.pending || intent === "steer"} onPress={() => setShowModels(true)} style={[chatStyles.tool, intent === "steer" && s.disabled]}>
                <Text style={chatStyles.toolText}>模型 · {model?.name ?? "未配置"}</Text>
              </Pressable>
            ) : null}
            <Pressable accessibilityRole="button" accessibilityLabel={kind === "chat" ? "当前聊天，切换为任务" : "当前任务，切换为聊天"} accessibilityState={{ disabled: !!draft.pending }} disabled={!!draft.pending} onPress={() => setKind(kind === "chat" ? "task" : "chat")} style={[chatStyles.tool, kind === "task" && chatStyles.toolActive]}>
              <Text style={[chatStyles.toolText, kind === "task" && chatStyles.toolActiveText]}>{kind === "chat" ? "聊天" : "任务"}</Text>
            </Pressable>
            {!conversation.agent_id ? (
              <Pressable accessibilityRole="button" accessibilityLabel={model?.reasoning_levels.length ? `思考深度，当前${reasoningLabel[depth]}` : "当前模型未配置思考深度"} accessibilityState={{ disabled: modelBusy || !!draft.pending || intent === "steer" || !model?.reasoning_levels.length }} disabled={modelBusy || !!draft.pending || intent === "steer" || !model?.reasoning_levels.length} onPress={() => setShowReasoning(true)} style={[chatStyles.tool, (!model?.reasoning_levels.length || intent === "steer") && s.disabled]}>
                <Text style={chatStyles.toolText}>思考 · {model?.reasoning_levels.length ? reasoningLabel[depth] : "未配置"}</Text>
              </Pressable>
            ) : null}
            {!conversation.agent_id ? <Pressable accessibilityRole="button" accessibilityLabel={`联网搜索${searchProviderId ? "已开启" : "已关闭"}`} accessibilityState={{ disabled: !!draft.pending || intent === "steer" }} disabled={!!draft.pending || intent === "steer"} onPress={() => setShowSearch(true)} style={[chatStyles.tool, !!searchProviderId && chatStyles.toolActive, intent === "steer" && s.disabled]}><Text style={[chatStyles.toolText, !!searchProviderId && chatStyles.toolActiveText]}>联网{searchProviderId ? " · 开" : ""}</Text></Pressable> : null}
            {(running || intent === "steer") && (["queue", "steer"] as const).map((value) => (
              <Pressable key={value} accessibilityRole="button" accessibilityLabel={value === "queue" ? "排队：当前运行结束后处理" : "引导：发送给当前运行"} accessibilityState={{ selected: intent === value, disabled: !!draft.pending || (value === "steer" && !running) }} disabled={!!draft.pending || (value === "steer" && !running)} onPress={() => {
                setIntent(value);
                if (value === "steer" && running) setKind(running.kind);
                setTarget(value === "steer" ? (running?.id ?? null) : null);
              }} style={[chatStyles.tool, intent === value && chatStyles.toolActive, value === "steer" && !running && s.disabled]}>
                <Text style={[chatStyles.toolText, intent === value && chatStyles.toolActiveText]}>{value === "queue" ? "排队" : "引导"}</Text>
              </Pressable>
            ))}
            </ScrollView>
            <Pressable accessibilityRole="button" accessibilityLabel="添加资料" onPress={() => setShowFiles(true)} style={chatStyles.tool}>
              <Text style={[chatStyles.toolText, { fontSize: 24, lineHeight: 25 }]}>＋</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={draft.pending ? "重试发送" : "发送消息"} accessibilityState={{ disabled: !draftReady || busy || modelBusy || (!draft.text.trim() && !draft.attachments?.length) }} disabled={!draftReady || busy || modelBusy || (!draft.text.trim() && !draft.attachments?.length)} onPress={() => { void send({ ...(kind === "task" && taskModelId ? { model_id: taskModelId } : {}), ...(kind === "task" && taskEffort ? { reasoning_effort: taskEffort } : {}), ...(searchProviderId ? { search_provider_id: searchProviderId } : {}) }); }} style={[chatStyles.send, (!draftReady || busy || modelBusy || (!draft.text.trim() && !draft.attachments?.length)) && s.disabled]}>
              <Text style={chatStyles.sendText}>{busy ? "…" : draft.pending ? "重试" : "↑"}</Text>
            </Pressable>
          </View>
        </View>
        {draft.pending ? <Text style={s.muted}>提交尚未确认 · 重试沿用原请求{!busy ? " · 可返回编辑" : ""}</Text> : null}
        {draft.pending && !busy ? <Button secondary small onPress={abandonPending}>返回编辑草稿</Button> : null}
        {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      </View>
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
      <Modal visible={showReasoning} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowReasoning(false)}>
        <SafeAreaView style={s.root}>
          <View style={s.header}>
            <Text style={[s.heading, s.grow]}>思考深度</Text>
            <Button secondary onPress={() => setShowReasoning(false)}>关闭</Button>
          </View>
          <ScrollView contentContainerStyle={s.content}>
            <Text style={s.muted}>只影响之后提交的{kind === "task" ? "任务" : "聊天"}。不同模型支持的档位可能不同。</Text>
            {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
            <Button secondary disabled={modelBusy} onPress={() => {
              void updateModel(kind === "task" ? taskModelId : conversation.model_id, null).then(() => setShowReasoning(false)).catch((e) => setError(humanError(e)));
            }}>
              模型默认{model?.default_reasoning_effort ? ` · ${reasoningLabel[model.default_reasoning_effort]}` : " · 自动"}
            </Button>
            {model?.reasoning_levels.map((value) => (
              <Button key={value} secondary={depth !== value} disabled={modelBusy} onPress={() => {
                void updateModel(kind === "task" ? taskModelId : conversation.model_id, value).then(() => setShowReasoning(false)).catch((e) => setError(humanError(e)));
              }}>{reasoningLabel[value]}</Button>
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>
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
  composerArea: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 8, gap: 6 },
  composer: {
    backgroundColor: colors.white,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 21,
    paddingHorizontal: 10,
    paddingBottom: 6,
  },
  composerInput: {
    color: colors.ink,
    fontSize: 16,
    lineHeight: 24,
    minHeight: 48,
    maxHeight: 128,
    paddingTop: 11,
    paddingBottom: 5,
    textAlignVertical: "top",
  },
  composerHint: { color: colors.amber, fontSize: 12, paddingBottom: 6 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 4 },
  toolbarChoices: { flex: 1 },
  toolbarChoicesContent: { alignItems: "center", gap: 3 },
  tool: {
    minHeight: 40,
    minWidth: 40,
    paddingHorizontal: 8,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.pale,
  },
  toolText: { color: colors.accent, fontSize: 12, fontWeight: "600" },
  toolActive: { backgroundColor: colors.accent },
  toolActiveText: { color: colors.white },
  send: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  sendText: { color: colors.white, fontSize: 21, fontWeight: "600" },
});
