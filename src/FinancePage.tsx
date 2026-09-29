import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from "react-native";
import type { Connection, Conversation, FinanceSummary, Message } from "./api";
import { useChat } from "./useChat";
import { Button, colors, humanError, s, timeLabel } from "./ui";

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
    messages, running, pendingRuns, syncError, refresh, loading, list, nearBottomRef,
    previous, busy, loadOlder, intent, setIntent, setTarget, setKind, error, setError,
    draft, draftReady, updateDraft, send, cancel, resume, abandonPending,
  } = useChat({ connection, conversation, onRefresh });
  const queued = pendingRuns.filter((run) => run.status === "queued").length;
  return (
    <View style={s.body}>
      <View style={[s.header, { paddingBottom: 6 }]}>
        <Button secondary small onPress={onBack}>‹ 生活</Button>
        <Text style={[s.heading, s.grow]}>财务</Text>
      </View>
      <Text style={[s.muted, { marginHorizontal: 22, marginBottom: 8 }]}>账户、收支和扣费问题，直接和财务助手聊。</Text>
      {syncError ? (
        <Pressable accessibilityRole="button" onPress={() => refresh.current()} style={[s.notice, { marginHorizontal: 18 }]}>
          <Text style={s.noticeText}>{syncError} · 点击重试，草稿仍在。</Text>
        </Pressable>
      ) : null}
      {loading ? <ActivityIndicator color={colors.accent} /> : null}
      <FlatList
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
              <Text style={s.title}>账户一览</Text>
              {finance.balances.length ? finance.balances.map((item) => (
                <View key={item.id} style={s.spread}>
                  <Text style={s.text}>{item.platform}</Text>
                  <Text style={s.text}>¥{item.amount}</Text>
                </View>
              )) : <Text style={s.muted}>还没有你提供的余额。</Text>}
            </View>
            <View style={s.card}>
              <Text style={s.title}>最近收支</Text>
              {finance.recent.length ? finance.recent.slice(0, 5).map((item) => (
                <Text key={item.id} style={s.text}>
                  {item.kind === "income" ? "收入" : "支出"} · {item.platform} · ¥{item.amount}
                </Text>
              )) : <Text style={s.muted}>还没有你提供的收支。</Text>}
            </View>
            {previous ? (
              <Button secondary small disabled={busy} onPress={() => { void loadOlder(); }}>
                查看更早的消息
              </Button>
            ) : null}
            {!messages.length && !loading ? (
              <Text style={s.muted}>可以直接说一个账户余额、消费，或问一笔扣费是怎么发生的。</Text>
            ) : null}
          </View>
        }
        renderItem={({ item }: { item: Message }) => (
          <View style={{ alignSelf: item.role === "user" ? "flex-end" : "stretch", maxWidth: "92%", gap: 5 }}>
            <Text style={s.muted}>
              {item.role === "user" ? "你" : "财务助手"} · {timeLabel(item.created_at)}
              {item.intent === "steer" ? ` · 引导${item.status === "applied" ? "已应用" : item.status === "rejected" ? "未应用" : "待应用"}` : ""}
            </Text>
            <View style={{ backgroundColor: item.role === "user" ? colors.pale : colors.white, padding: 13, borderRadius: 15 }}>
              <Text selectable style={s.text}>{item.content}</Text>
            </View>
          </View>
        )}
      />
      <View style={{ backgroundColor: colors.white, borderTopColor: colors.line, borderTopWidth: 1, padding: 12, gap: 8 }}>
        {running || queued ? (
          <View style={s.spread}>
            <Text style={s.muted}>{running ? `正在回复 · ${queued} 条等待` : `${queued} 条等待`}</Text>
            {running ? <Button secondary danger small disabled={running.cancel_requested} onPress={() => { void cancel(running).catch(() => undefined); }}>取消</Button> : null}
          </View>
        ) : null}
        {conversation.blocked ? <Button secondary small onPress={() => { void resume(); }}>继续处理队列</Button> : null}
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
        <View style={[s.row, { alignItems: "flex-end" }]}>
          <TextInput
            accessibilityLabel="给财务助手发消息"
            multiline
            placeholder="直接说说你的财务问题…"
            placeholderTextColor={colors.muted}
            value={draft.text}
            maxLength={20000}
            editable={draftReady && !draft.pending && !busy}
            onChangeText={(text) => { void updateDraft({ text, pending: null }).catch((e) => setError(humanError(e))); }}
            style={[s.input, s.grow, { minHeight: 46, maxHeight: 105 }]}
          />
          <Button disabled={!draftReady || busy || !draft.text.trim()} onPress={() => { void send(); }}>
            {draft.pending ? "重试" : "发送"}
          </Button>
        </View>
        {draft.pending && !busy ? (
          <Button secondary small onPress={abandonPending}>返回编辑草稿</Button>
        ) : null}
      </View>
    </View>
  );
}
