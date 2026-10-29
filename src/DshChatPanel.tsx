import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, FlatList, Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { Directory, File, Paths } from "expo-file-system";
import { fetch as expoFetch } from "expo/fetch";
import { request, type Connection, type Conversation, type Draft, type ModelCatalog, type ReasoningEffort } from "./api";
import { clearDraft, draftKey, readDraft, saveDraft } from "./storage";
import { readCache, writeCache } from "./localCache";
import { ActionLink, Button, IconAction, humanError, useUi } from "./ui";
import { MessageBody } from "./MessageBody";
import { ConversationComposer } from "./ConversationComposer";
import { BottomSheet } from "./BottomSheet";
import { ModelPicker } from "./ModelPicker";
import { ReasoningPicker } from "./ReasoningPicker";
import { chatRows, contentText, eventPresentation, rowText, mergeDshEvents, type DshChatRow, type DshEvent, type DshPending, type DshSnapshot } from "./dshProtocol";
import { useSyncStatus } from "./ConnectionStatus";
import { DraftAttachments, MessagePhotos } from "./PhotoAttachments";
import { discardDraftPhotos } from "./chatPhotos";
import { ReplyContent } from "./ReplyContent";
import { useNotice } from "./Notice";
import { layout, radius, space } from "./theme";

type LocalFile = { id: string; uri: string; name: string; mediaType?: string };
type DshDraft = Draft & { files?: LocalFile[]; receipts?: Record<string, string> };
const imageType = (uri: string, name: string) => {
  const suffix = (uri.match(/\.([a-z]+)(?:[?#]|$)/i)?.[1] ?? name.split(".").at(-1) ?? "jpeg").toLowerCase();
  return `image/${suffix === "jpg" ? "jpeg" : suffix}`;
};
function discardFile(file: LocalFile) {
  if (!/^[a-f0-9-]+$/.test(file.id)) return;
  const dir = new Directory(Paths.document, "dsh-drafts", file.id);
  if (!file.uri.startsWith(`${dir.uri.replace(/\/$/, "")}/`)) return;
  try { if (dir.exists) dir.delete(); } catch { /* The app can retry cleanup later. */ }
}

function EventRow({ event, name }: { event: DshEvent; name: string }) {
  const { s, colors } = useUi();
  const [expanded, setExpanded] = useState(false);
  const item = eventPresentation(event);
  return <View style={{ paddingVertical: 10, gap: 6, ...(item.message === "user" ? { backgroundColor: colors.surfaceRaised, paddingHorizontal: 12, borderRadius: 16 } : {}) }}>
    <Text style={s.small}>{item.message === "assistant" ? item.title.replace("知行", name) : item.title}</Text>
    {item.text ? item.message ? <MessageBody>{item.text}</MessageBody> : <Text selectable numberOfLines={expanded ? undefined : 4} style={s.text}>{item.text}</Text> : null}
    <ActionLink onPress={() => setExpanded(!expanded)}>{expanded ? "收起详情" : "查看详情"}</ActionLink>
    {expanded ? <Text selectable style={s.small}>{JSON.stringify(event.data, null, 2)}</Text> : null}
  </View>;
}

function MessageRow({ row, name, connection, base, phase, onCopy, onMenu, onRecords }: {
  row: DshChatRow; name: string; connection: Connection; base: string; phase?: string;
  onCopy: () => void; onMenu: () => void; onRecords: () => void;
}) {
  const { s, colors } = useUi();
  const user = row.role === "user";
  const images = row.attachments.filter(a => a.type === "image").map((a, index) => ({ ...a, id: `${a.id}:${index}`, path: `${base}/dsh/images/${encodeURIComponent(a.id)}` }));
  return <View style={{ paddingVertical: space.md, gap: space.xs, alignItems: user ? "flex-end" : "stretch" }}>
    {!user ? <Text style={s.small}>{name}</Text> : null}
    <View style={user ? { maxWidth: "88%", paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.card, backgroundColor: colors.neutral, gap: space.xs } : { gap: space.sm }}>
      {images.length ? <MessagePhotos connection={connection} images={images} /> : null}
      {row.attachments.filter(a => a.type === "file").map((a, index) => <View key={`${a.id}:${index}`} style={{ paddingVertical: space.sm }}><Text selectable style={s.description}>📎 {a.name}</Text></View>)}
      {user ? rowText(row) ? <MessageBody>{rowText(row)}</MessageBody> : null
        : <ReplyContent parts={row.parts} active={row.active} status={row.status} phase={phase} onOpenRun={onRecords} />}
    </View>
    {!row.active ? <View style={s.row}>
      {rowText(row) ? <IconAction icon="copy-outline" label="复制消息" onPress={onCopy} /> : null}
      <IconAction icon="ellipsis-horizontal" label="更多消息操作" onPress={onMenu} />
    </View> : null}
  </View>;
}

function InputCard({ pending, busy, answer }: { pending: DshPending; busy: boolean; answer: (value: unknown) => void }) {
  const { s, colors } = useUi();
  const [values, setValues] = useState<Record<string, { selected: string[]; custom: string }>>({});
  const questions = pending.questions ?? [];
  return <View style={[s.card, { marginVertical: space.md, gap: space.sm }]}>
    {pending.kind === "approval" ? <>
      <Text style={s.label}>{pending.toolName} 请求授权</Text>
      <Text style={s.text}>{pending.reason}</Text>
      <Button disabled={busy} onPress={() => answer({ outcome: "allowed-once" })}>允许这一次</Button>
      <ActionLink disabled={busy} onPress={() => answer({ outcome: "rejected" })}>拒绝</ActionLink>
    </> : <>
      {questions.map(q => <View key={q.id} style={{ gap: 8 }}>
        <Text style={s.label}>{q.question}</Text>
        {q.detail ? <MessageBody>{q.detail}</MessageBody> : null}
        {q.options?.map(option => <Pressable key={option.label} accessibilityRole="button" accessibilityLabel={option.label} accessibilityState={{ selected: values[q.id]?.selected.includes(option.label), disabled: busy }} disabled={busy}
          style={{ minHeight: layout.touchTarget, justifyContent: "center", padding: space.sm, gap: space.xs, borderWidth: 1, borderRadius: radius.small,
            borderColor: values[q.id]?.selected.includes(option.label) ? colors.gold : colors.line,
            backgroundColor: values[q.id]?.selected.includes(option.label) ? colors.goldSoft : colors.surfaceRaised }}
          onPress={() => setValues(old => { const current = old[q.id] ?? { selected: [], custom: "" }; return { ...old, [q.id]: { ...current,
            selected: q.multiSelect ? current.selected.includes(option.label) ? current.selected.filter(v => v !== option.label) : [...current.selected, option.label] : [option.label] } }; })}>
          <Text style={s.text}>{values[q.id]?.selected.includes(option.label) ? "● " : "○ "}{option.label}</Text>
          {option.description ? <Text style={s.small}>{option.description}</Text> : null}
        </Pressable>)}
        {q.intent?.kind !== "approval" ? <TextInput accessibilityLabel={q.question} placeholder="填写回答" style={s.input} multiline editable={!busy}
          value={values[q.id]?.custom ?? ""} onChangeText={custom => setValues(old => ({ ...old, [q.id]: { selected: old[q.id]?.selected ?? [], custom } }))} /> : null}
      </View>)}
      <Button disabled={busy || questions.some(q => !values[q.id]?.selected.length && !values[q.id]?.custom.trim())}
        onPress={() => answer({ answers: questions.map(q => ({ id: q.id, ...values[q.id] })) })}>提交回答</Button>
    </>}
  </View>;
}

export function DshHostSettings({ webUrl }: { webUrl?: string | null }) {
  const { s } = useUi();
  return <View style={[s.card, { margin: 20, gap: 12 }]}>
    <Text style={s.label}>DSH 宿主设置</Text>
    <Text style={s.text}>模型供应商、插件、工作目录与权限沿用 DSH 的设置。在这里发送的消息直接由 DSH 执行。</Text>
    {webUrl && /^https?:\/\//.test(webUrl) ? <ActionLink onPress={() => { void Linking.openURL(webUrl); }}>打开 DSH</ActionLink> : <Text style={s.muted}>在服务器的 DSH 页面管理宿主配置。</Text>}
  </View>;
}

export function DshChatPanel({ connection, conversation, assistantName, catalog, onRefresh, onConversationChanged,
  startWithFiles, onFilesOpened, startWithSend, onSendStarted, settingsOpen, onSettingsClose, webUrl,
}: {
  connection: Connection; conversation: Conversation; assistantName: string; catalog: ModelCatalog | null;
  onRefresh: () => void; onConversationChanged: (conversation: Conversation) => void;
  startWithFiles?: boolean; onFilesOpened?: () => void; startWithSend?: boolean; onSendStarted?: () => void;
  settingsOpen?: boolean; onSettingsClose?: () => void; webUrl?: string | null;
}) {
  const { s, colors } = useUi();
  const notice = useNotice();
  const key = draftKey(connection.url, conversation.id);
  const base = `/conversations/${encodeURIComponent(conversation.id)}`;
  const [draft, setDraft] = useState<DshDraft>({ text: "", pending: null });
  const draftRef = useRef(draft);
  const [ready, setReady] = useState(false);
  const [draftAttempt, setDraftAttempt] = useState(0);
  const [events, setEvents] = useState<DshEvent[]>([]);
  const [snapshot, setSnapshot] = useState<DshSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [records, setRecords] = useState<DshChatRow | "all" | null>(null);
  const [messageMenu, setMessageMenu] = useState<DshChatRow | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [models, setModels] = useState(false);
  const [reasoning, setReasoning] = useState(false);
  const [intent, setIntent] = useState<"queue" | "steer">("queue");
  const list = useRef<FlatList<DshChatRow>>(null);
  const contentHeight = useRef(0);
  const nearBottom = useRef(true);
  const dragging = useRef(false);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const alive = useRef(true);
  const working = useRef(false);
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  const report = useSyncStatus(refresh);
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => { onRefreshRef.current = onRefresh; }, [onRefresh]);
  const currentModel = catalog?.items.find(m => m.id === (conversation.model_id ?? catalog.roles.chat));
  const update = async (value: DshDraft) => {
    draftRef.current = value; if (alive.current) setDraft(value); await saveDraft(key, value);
  };
  useEffect(() => {
    alive.current = true;
    void readDraft(key).then(value => { if (alive.current) { draftRef.current = value; setDraft(value); setReady(true); setError(""); } }).catch(e => { if (alive.current) setError(humanError(e)); });
    return () => { alive.current = false; };
  }, [key, draftAttempt]);
  useEffect(() => {
    let active = true, polling = false, cursor = 0, wasRunning = false;
    let accumulated: DshEvent[] = [];
    const controller = new AbortController();
    const cacheKey = `dsh:${conversation.id}`;
    async function poll() {
      if (!active || polling || AppState.currentState === "background") return;
      polling = true;
      try {
        let changed = false;
        let next: DshSnapshot;
        do {
          next = await request<DshSnapshot>(connection, `${base}/dsh?offset=${cursor}`, { signal: controller.signal });
          if (!active) return;
          changed ||= next.events.length > 0;
          accumulated = mergeDshEvents(accumulated, next.events); cursor = next.next;
        } while (next.hasMore);
        if (changed) setEvents(accumulated);
        setSnapshot(next); report();
        if (wasRunning && !next.running) onRefreshRef.current();
        wasRunning = next.running;
        if (changed) void writeCache(connection, cacheKey, accumulated).catch(() => {});
      } catch (e) { if (active) report(e); }
      finally { polling = false; }
    }
    refreshRef.current = () => { void poll(); };
    void readCache<DshEvent[]>(connection, cacheKey).then(cached => {
      if (!active) return;
      if (Array.isArray(cached)) { accumulated = cached; cursor = cached.length ? cached[cached.length - 1].seq + 1 : 0; setEvents(cached); }
      void poll();
    });
    const timer = setInterval(() => { void poll(); }, 750);
    const listener = AppState.addEventListener("change", state => { if (state === "active") void poll(); });
    return () => { active = false; clearInterval(timer); controller.abort(); listener.remove(); };
  }, [connection, conversation.id, base, report]);

  async function files() {
    if (working.current || !ready || draftRef.current.pending) return;
    working.current = true; setBusy(true);
    try {
      const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true });
      if (picked.canceled || !alive.current) return;
      const added: LocalFile[] = [];
      for (const asset of picked.assets) {
        const id = Crypto.randomUUID();
        const dir = new Directory(Paths.document, "dsh-drafts", id); dir.create({ intermediates: true, idempotent: true });
        const local = new File(dir, "attachment"); await new File(asset.uri).copy(local);
        added.push({ id, uri: local.uri, name: asset.name, mediaType: asset.mimeType });
      }
      await update({ ...draftRef.current, files: [...(draftRef.current.files ?? []), ...added] });
    } catch (e) { if (alive.current) setError(humanError(e)); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  }
  async function photos() {
    if (working.current || !ready || draftRef.current.pending) return;
    working.current = true; setBusy(true);
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true,
        orderedSelection: true, allowsEditing: false, quality: 1,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible });
      if (picked.canceled || !alive.current) return;
      const added: LocalFile[] = [];
      for (const asset of picked.assets) {
        const id = Crypto.randomUUID();
        const dir = new Directory(Paths.document, "dsh-drafts", id); dir.create({ intermediates: true, idempotent: true });
        const local = new File(dir, "attachment"); await new File(asset.uri).copy(local);
        added.push({ id, uri: local.uri, name: asset.fileName ?? "photo.jpg", mediaType: asset.mimeType ?? "image/jpeg" });
      }
      await update({ ...draftRef.current, files: [...(draftRef.current.files ?? []), ...added] });
    } catch (e) { if (alive.current) setError(humanError(e)); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  }
  async function send() {
    if (working.current || !ready) return;
    working.current = true; setBusy(true); setError("");
    try {
      const current = draftRef.current;
      const pending = current.pending ?? { id: Crypto.randomUUID(), content: current.text, kind: "chat" as const, intent: snapshot?.running ? intent : "queue" };
      await update({ ...current, pending });
      const parts: ({ type: "text"; text: string } | { type: "file"; receiptId: string })[] = pending.content.trim() ? [{ type: "text", text: pending.content }] : [];
      const attachments = [...(current.files ?? []), ...(current.photos ?? []).map(p => ({ id: p.id, uri: p.prepared?.uri ?? p.uri, name: p.prepared?.name ?? p.name,
        mediaType: imageType(p.prepared?.uri ?? p.uri, p.prepared?.name ?? p.name) }))];
      for (const file of attachments) {
        const saved = draftRef.current.receipts?.[file.id];
        if (saved) { parts.push({ type: "file", receiptId: saved }); continue; }
        const response = await expoFetch(`${connection.url}/v1${base}/dsh/files?name=${encodeURIComponent(file.name)}${file.mediaType ? `&mediaType=${encodeURIComponent(file.mediaType)}` : ""}`, {
          method: "PUT", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/octet-stream" },
          body: await new File(file.uri).bytes(), redirect: "error",
        });
        const receipt = await response.json();
        if (!response.ok) throw new Error(receipt.error?.message ?? "文件发送失败。");
        await update({ ...draftRef.current, receipts: { ...draftRef.current.receipts, [file.id]: receipt.receiptId } });
        parts.push({ type: "file", receiptId: receipt.receiptId });
      }
      await request(connection, `${base}/messages`, { method: "POST", body: { ...pending, parts } });
      // Keep the request ID until clearing is durable, including after a lost ACK.
      await clearDraft(key, pending.id);
      if (draftRef.current.pending?.id === pending.id) {
        draftRef.current = { text: "", pending: null };
        if (alive.current) setDraft(draftRef.current);
      }
      for (const file of current.files ?? []) discardFile(file);
      discardDraftPhotos(current.photos ?? []);
      nearBottom.current = true; setAwayFromLatest(false); refresh(); onRefreshRef.current();
    } catch (e) { if (alive.current) setError(humanError(e)); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  }
  async function action(path: string, body?: unknown) {
    if (working.current) return;
    working.current = true; setBusy(true); setError("");
    try { await request(connection, `${base}${path}`, { method: "POST", body, timeoutMs: 60000 }); refresh(); }
    catch (e) { if (alive.current) setError(humanError(e)); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  }
  async function selectModel(modelId: string | null, effort: ReasoningEffort | null) {
    const updated = await request<Conversation>(connection, `${base}/model`, { method: "PUT", body: { model_id: modelId, reasoning_effort: effort } });
    onConversationChanged(updated); refresh();
  }
  async function copyMessage(row: DshChatRow) {
    try { await Clipboard.setStringAsync(rowText(row)); notice.show({ message: "已复制消息", tone: "success" }); }
    catch (e) { setError(humanError(e)); }
  }
  async function quoteMessage(row: DshChatRow) {
    if (!ready || busy || draftRef.current.pending) return;
    try {
      const addition = row.role === "user" ? rowText(row) : `关于这条回复：\n${rowText(row)}\n\n`;
      await update({ ...draftRef.current, text: [draftRef.current.text, addition].filter(Boolean).join("\n\n") });
      setMessageMenu(null); notice.show({ message: "已放入草稿，可修改后发送" });
    } catch (e) { setError(humanError(e)); }
  }
  const started = useRef(false);
  useEffect(() => {
    if (!ready || started.current) return;
    if (startWithFiles) { started.current = true; onFilesOpened?.(); void files(); }
    else if (startWithSend) { started.current = true; onSendStarted?.(); void send(); }
  });
  const rows = useMemo(() => chatRows(events, snapshot), [events, snapshot]);
  const queue = snapshot?.queue ?? [];
  const canSend = ready && !busy && !!(draft.text.trim() || draft.files?.length || draft.photos?.length || draft.pending);
  const scrollToLatest = (animated: boolean) => list.current?.scrollToOffset({ offset: contentHeight.current, animated });
  const followLatest = () => { if (nearBottom.current) scrollToLatest(false); };
  return <View style={{ flex: 1 }}>
    <View style={{ flex: 1 }}>
    <FlatList ref={list} data={rows} keyExtractor={row => row.id} keyboardShouldPersistTaps="handled" removeClippedSubviews={false}
      contentContainerStyle={{ paddingHorizontal: layout.gutter, paddingBottom: queue.length ? 64 : space.md }}
      onScroll={e => {
        const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
        // Content growth and keyboard layout also emit scroll events. Only a
        // user drag should turn following off, as in the existing ChatPanel.
        if (dragging.current) setAwayFromLatest(contentSize.height - contentOffset.y - layoutMeasurement.height >= 8);
      }}
      onScrollBeginDrag={() => { dragging.current = true; nearBottom.current = false; setAwayFromLatest(true); }}
      onScrollEndDrag={e => {
        dragging.current = false;
        const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
        nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 8;
        setAwayFromLatest(!nearBottom.current);
      }}
      onMomentumScrollEnd={e => {
        const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
        nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 8;
        setAwayFromLatest(!nearBottom.current);
      }} scrollEventThrottle={80}
      onContentSizeChange={(_width, height) => { contentHeight.current = height; followLatest(); }} onLayout={followLatest}
      renderItem={({ item }) => <MessageRow row={item} name={assistantName} connection={connection} base={base}
        phase={item.active && snapshot?.pending.length ? snapshot.pending[0].kind === "approval" ? "approval" : "input" : undefined}
        onCopy={() => { void copyMessage(item); }} onMenu={() => setMessageMenu(item)} onRecords={() => setRecords(item)} />}
      ListFooterComponent={<>
        {snapshot?.pending.map(p => <InputCard key={p.id} pending={p} busy={busy} answer={value => { void action(`/dsh/answers/${p.id}`, value); }} />)}
      </>} />
    {awayFromLatest ? <Pressable accessibilityRole="button" accessibilityLabel="回到最新消息"
      onPress={() => { nearBottom.current = true; setAwayFromLatest(false); scrollToLatest(true); }}
      style={{ position: "absolute", bottom: 12, alignSelf: "center", minHeight: 44, paddingHorizontal: 16,
        justifyContent: "center", borderRadius: 22, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.line }}>
      <Text style={s.description}>回到最新</Text>
    </Pressable> : null}
    </View>
    {error ? <Text accessibilityRole="alert" style={[s.error, { marginHorizontal: 20 }]}>{error}</Text> : null}
    {!ready && error ? <Button secondary onPress={() => setDraftAttempt(value => value + 1)}>重新读取草稿</Button> : null}
    <ConversationComposer unlimitedText text={draft.text} onText={text => { void update({ ...draftRef.current, text }).catch(e => setError(humanError(e))); }}
      editable={ready && !busy && !draft.pending} onSend={() => { void send(); }} onFiles={() => { void files(); }} onPhotos={() => { void photos(); }}
      attachmentLocked={!ready || busy || !!draft.pending} busy={busy} canSend={canSend} pending={!!draft.pending}
      kind="chat" onKind={() => {}} model={currentModel} depth={conversation.reasoning_effort ?? "auto"}
      onModel={() => setModels(true)} onReasoning={() => setReasoning(true)} optionsLocked={busy || !catalog}
      stopping={snapshot?.running && !canSend} onStop={() => { void action("/dsh/cancel"); }}
      floating={queue.length ? <Pressable accessibilityRole="button" accessibilityLabel={`查看待发送消息，共 ${queue.length} 条`} onPress={() => setQueueOpen(true)}
        style={{ minHeight: layout.touchTarget, borderRadius: radius.item, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surfaceRaised, paddingHorizontal: space.md, justifyContent: "center" }}>
        <Text numberOfLines={1} style={s.description}>等待发送 · {queue.length} 条　{contentText(queue[0].content)}</Text>
      </Pressable> : undefined}
      hint={draft.pending && error ? <Text style={s.muted}>发送尚未确认，内容已保留，可重试。</Text> : undefined}>
      <DraftAttachments connection={connection} photos={[...(draft.photos ?? []), ...(draft.files ?? []).filter(f => f.mediaType?.startsWith("image/")).map(f => ({ ...f, width: 0, height: 0 }))]}
        removePhoto={busy || draft.pending ? undefined : id => { const value = draftRef.current;
          void update({ ...value, photos: value.photos?.filter(p => p.id !== id), files: value.files?.filter(f => f.id !== id) })
            .then(() => { discardDraftPhotos(value.photos?.filter(p => p.id === id) ?? []); value.files?.filter(f => f.id === id).forEach(discardFile); })
            .catch(e => setError(humanError(e))); }} />
      {(draft.files ?? []).filter(f => !f.mediaType?.startsWith("image/")).map(file => <ActionLink key={file.id} disabled={busy || !!draft.pending} onPress={() => { void update({ ...draftRef.current, files: draftRef.current.files?.filter(f => f.id !== file.id) }).then(() => discardFile(file)).catch(e => setError(humanError(e))); }}>{`移除 · ${file.name}`}</ActionLink>)}
    </ConversationComposer>
    <ModelPicker visible={models} title="选择模型" connectionUrl={connection.url} models={catalog?.items ?? []} selectedId={currentModel?.id ?? null}
      onSelect={id => selectModel(id, null)} onClose={() => setModels(false)} />
    <ReasoningPicker visible={reasoning} model={currentModel} selected={conversation.reasoning_effort}
      onSelect={value => selectModel(conversation.model_id, value)} onClose={() => setReasoning(false)} />
    <BottomSheet visible={!!settingsOpen} title="对话设置" onClose={() => onSettingsClose?.()}>
      <ScrollView contentContainerStyle={s.content}>
        <Text style={s.label}>这条消息的发送方式</Text>
        <ActionLink disabled={busy || !!draft.pending} onPress={() => setIntent(intent === "queue" ? "steer" : "queue")}>{intent === "queue" ? "接着处理" : "补充当前回复"}</ActionLink>
        <Text style={s.description}>{intent === "queue" ? "当前回复完成后，按顺序处理新消息。" : "执行过程中加入新要求；空闲时直接开始回复。"}</Text>
        {snapshot?.running ? <ActionLink disabled={busy} onPress={() => { void action("/dsh/cancel"); }}>停止回复</ActionLink> : null}
        <ActionLink icon="receipt-outline" onPress={() => { onSettingsClose?.(); setRecords("all"); }}>查看完整处理记录</ActionLink>
        <DshHostSettings webUrl={webUrl} />
      </ScrollView>
    </BottomSheet>
    <BottomSheet visible={!!messageMenu} title="消息操作" onClose={() => setMessageMenu(null)}>
      <View style={s.content}>
        {messageMenu && rowText(messageMenu) ? <>
          <ActionLink icon="copy-outline" onPress={() => { void copyMessage(messageMenu); setMessageMenu(null); }}>复制消息</ActionLink>
          <ActionLink icon="create-outline" disabled={!ready || busy || !!draft.pending} onPress={() => { void quoteMessage(messageMenu); }}>{messageMenu.role === "user" ? "修改后重新发送" : "引用到草稿"}</ActionLink>
        </> : null}
        <ActionLink icon="receipt-outline" onPress={() => { setRecords(messageMenu); setMessageMenu(null); }}>查看处理记录</ActionLink>
      </View>
    </BottomSheet>
    <BottomSheet visible={!!records} title="处理记录" subtitle="原始事件与工具回执" tall onClose={() => setRecords(null)}>
      <FlatList data={records === "all" ? events : records?.events ?? []} keyExtractor={event => String(event.seq)}
        contentContainerStyle={{ paddingHorizontal: layout.gutter, paddingBottom: space.lg }} renderItem={({ item }) => <EventRow event={item} name={assistantName} />} />
    </BottomSheet>
    <BottomSheet visible={queueOpen} title={`等待发送 · ${queue.length} 条`} onClose={() => setQueueOpen(false)}>
      <ScrollView contentContainerStyle={s.content}>
        {queue.length ? queue.map(item => <View key={item.id} style={{ gap: space.sm, borderBottomWidth: 1, borderBottomColor: colors.line, paddingBottom: space.sm }}>
          <Text selectable style={s.text}>{contentText(item.content)}</Text>
          <Text style={s.muted}>{item.placement === "steering" ? "将在下一步补充当前回复" : "当前回复完成后接着处理"}</Text>
          <View style={s.row}>
            <ActionLink disabled={busy || !snapshot?.running || item.placement === "steering"} onPress={() => { void action(`/dsh/queue/${encodeURIComponent(item.id)}`, { kind: "steer" }); }}>补充当前回复</ActionLink>
            <ActionLink disabled={busy} onPress={() => { void action(`/dsh/queue/${encodeURIComponent(item.id)}`, { kind: "remove" }); }}>撤回消息</ActionLink>
          </View>
        </View>) : <Text style={s.muted}>没有等待发送的消息</Text>}
      </ScrollView>
    </BottomSheet>
  </View>;
}
