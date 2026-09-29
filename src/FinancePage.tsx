import { ActivityIndicator, FlatList, Modal, Pressable, Text, View } from "react-native";
import { MessageBody } from "./MessageBody";
import { ConversationComposer } from "./ConversationComposer";
import type { Connection, Conversation, FinanceSummary, Message } from "./api";
import { Attachments } from "./Attachments";
import { ApprovalCards } from "./ApprovalCards";
import { FilesPanel } from "./FilesPanel";
import { useChat } from "./useChat";
import { ActionLink, BackLink, CardHeader, colors, humanError, s, timeLabel } from "./ui";

export function FinancePage({
  connection, conversation, finance, onBack, onRefresh,
}: {
  connection: Connection;
  conversation: Conversation;
  finance: FinanceSummary;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const {
    messages, running, pendingRuns, refresh, loading, list, nearBottomRef,
    previous, busy, loadOlder, intent, setIntent, setTarget, kind, setKind, error, setError,
    draft, draftReady, updateDraft, send, cancel, resume, abandonPending,
    showFiles, setShowFiles, attach, removeAttachment,
  } = useChat({ connection, conversation, onRefresh });
  const queued = pendingRuns.filter((run) => run.status === "queued").length;
  return (
    <View style={s.body}>
      <View style={[s.row, { paddingRight: 16, paddingBottom: 4 }]}>
        <BackLink label="生活" onPress={onBack} />
        <Text style={[s.heading, s.grow]}>财务</Text>
      </View>
      <Text style={[s.muted, { marginHorizontal: 22, marginBottom: 8 }]}>账户、收支和扣费问题，直接和财务助手聊。</Text>
      {loading ? <ActivityIndicator color={colors.accent} /> : null}
      <FlatList
        ListFooterComponent={<ApprovalCards connection={connection} conversationId={conversation.id} onChanged={() => refresh.current()} />}
        ref={list}
        data={messages}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 14, gap: 12, flexGrow: 1 }}
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          nearBottomRef.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 140;
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (nearBottomRef.current) list.current?.scrollToEnd({ animated: false });
        }}
        ListHeaderComponent={
          <View style={{ gap: 10, paddingTop: 6, paddingBottom: 8 }}>
            <View style={s.card}>
              <CardHeader icon="wallet-outline" title="账户一览" tone="green" />
              {finance.balances.length ? finance.balances.map((item) => (
                <View key={item.id} style={s.spread}>
                  <Text style={s.text}>{item.platform}</Text>
                  <Text style={s.text}>¥{item.amount}</Text>
                </View>
              )) : <Text style={s.muted}>还没有你提供的余额。</Text>}
            </View>
            <View style={s.card}>
              <CardHeader icon="bar-chart-outline" title="最近收支" tone="green" />
              {finance.recent.length ? finance.recent.slice(0, 5).map((item) => (
                <Text key={item.id} style={s.text}>
                  {item.kind === "income" ? "收入" : "支出"} · {item.platform} · ¥{item.amount}
                </Text>
              )) : <Text style={s.muted}>还没有你提供的收支。</Text>}
            </View>
            {previous ? (
              <ActionLink icon="chevron-up" tone="green" disabled={busy} onPress={() => { void loadOlder(); }}>查看更早的消息</ActionLink>
            ) : null}
            {!messages.length && !loading ? (
              <Text style={s.muted}>可以直接说一个账户余额、消费，或问一笔扣费是怎么发生的。</Text>
            ) : null}
          </View>
        }
        renderItem={({ item }: { item: Message }) => (
          <View style={{ alignSelf: item.role === "user" ? "flex-end" : "stretch", maxWidth: item.role === "user" ? "88%" : "100%", gap: 5 }}>
            <Text style={s.muted}>
              {item.role === "user" ? "你" : "财务助手"} · {timeLabel(item.created_at)}
              {item.intent === "steer" ? ` · 引导${item.status === "applied" ? "已应用" : item.status === "rejected" ? "未应用" : "待应用"}` : ""}
            </Text>
            <View style={{ backgroundColor: item.role === "user" ? colors.neutral : "transparent", padding: item.role === "user" ? 13 : 0, borderRadius: 15 }}>
              <MessageBody>{item.content}</MessageBody>
              <Attachments connection={connection} items={item.attachments} />
            </View>
          </View>
        )}
      />
      <View style={{ backgroundColor: colors.paper, paddingTop: 6, gap: 4 }}>
        {running || queued ? (
          <View style={s.spread}>
            <Text style={s.muted}>{running ? `正在回复 · ${queued} 条等待` : `${queued} 条等待`}</Text>
            {running ? <ActionLink disabled={running.cancel_requested} onPress={() => { void cancel(running).catch(() => undefined); }}>取消</ActionLink> : null}
          </View>
        ) : null}
        {conversation.blocked ? <ActionLink icon="play-outline" tone="green" onPress={() => { void resume(); }}>继续处理队列</ActionLink> : null}
        {running || intent === "steer" ? (
          <View style={s.row}>
            {(["queue", "steer"] as const).map((value) => (
              <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: intent === value, disabled: !!draft.pending || (value === "steer" && !running) }} disabled={!!draft.pending || (value === "steer" && !running)} onPress={() => { setIntent(value); setTarget(value === "steer" ? running?.id ?? null : null); if (value === "steer" && running) setKind(running.kind); }} style={[s.chip, intent === value && s.chipActive]}>
                <Text style={[s.chipText, intent === value && s.chipActiveText]}>{value === "queue" ? "排队" : "引导当前回复"}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
        <ConversationComposer text={draft.text} placeholder="说说这笔钱，或发张截图…" editable={draftReady && !draft.pending && !busy} onText={(text) => { void updateDraft({ ...draft, text, pending: null }).catch((e) => setError(humanError(e))); }} onSend={() => { void send(); }} onFiles={() => setShowFiles(true)} attachmentLocked={!draftReady || !!draft.pending || busy} canSend={draftReady && !busy && !!(draft.text.trim() || draft.attachments?.length)} busy={busy} pending={!!draft.pending} kind={kind} onKind={setKind} kindLocked={intent === "steer"}>
          <Attachments connection={connection} items={draft.attachments} remove={draft.pending ? undefined : (id) => { void removeAttachment(id).catch((e) => setError(humanError(e))); }} />
        </ConversationComposer>
        {draft.pending && !busy ? (
          <ActionLink icon="create-outline" tone="green" onPress={abandonPending}>返回编辑草稿</ActionLink>
        ) : null}
      </View>
      <Modal visible={showFiles} onRequestClose={() => setShowFiles(false)}>
        {showFiles ? <FilesPanel connection={connection} conversationId={conversation.id} attach={attach} close={() => setShowFiles(false)} canAttach={draftReady && !draft.pending && !busy} /> : null}
      </Modal>
    </View>
  );
}
