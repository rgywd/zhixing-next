import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, FlatList, Linking, Pressable, Text, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { Directory, File, Paths } from "expo-file-system";
import { fetch as expoFetch } from "expo/fetch";
import { request, type Connection, type Conversation, type Draft, type ModelCatalog, type ReasoningEffort } from "./api";
import { clearDraft, draftKey, readDraft, saveDraft } from "./storage";
import { readCache, writeCache } from "./localCache";
import { ActionLink, Button, humanError, useUi } from "./ui";
import { MessageBody } from "./MessageBody";
import { ConversationComposer } from "./ConversationComposer";
import { BottomSheet } from "./BottomSheet";
import { ModelPicker } from "./ModelPicker";
import { ReasoningPicker } from "./ReasoningPicker";
import { contentText, eventPresentation, liveText, mergeDshEvents, type DshEvent, type DshPending, type DshSnapshot } from "./dshProtocol";
import { useSyncStatus } from "./ConnectionStatus";
import { DraftAttachments } from "./PhotoAttachments";
import { discardDraftPhotos } from "./chatPhotos";

type LocalFile = { id: string; uri: string; name: string; mediaType?: string };
type DshDraft = Draft & { files?: LocalFile[] };
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

function InputCard({ pending, busy, answer }: { pending: DshPending; busy: boolean; answer: (value: unknown) => void }) {
  const { s } = useUi();
  const [values, setValues] = useState<Record<string, { selected: string[]; custom: string }>>({});
  const questions = pending.questions ?? [];
  return <View style={[s.card, { margin: 16, gap: 8 }]}>
    {pending.kind === "approval" ? <>
      <Text style={s.label}>{pending.toolName} 请求授权</Text>
      <Text style={s.text}>{pending.reason}</Text>
      <Button disabled={busy} onPress={() => answer({ outcome: "allowed-once" })}>允许这一次</Button>
      <ActionLink disabled={busy} onPress={() => answer({ outcome: "rejected" })}>拒绝</ActionLink>
    </> : <>
      {questions.map(q => <View key={q.id} style={{ gap: 8 }}>
        <Text style={s.label}>{q.question}</Text>
        {q.detail ? <MessageBody>{q.detail}</MessageBody> : null}
        {q.options?.map(option => <Pressable key={option.label} accessibilityRole="button" accessibilityState={{ selected: values[q.id]?.selected.includes(option.label), disabled: busy }} disabled={busy}
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
  const { s } = useUi();
  const key = draftKey(connection.url, conversation.id);
  const base = `/conversations/${encodeURIComponent(conversation.id)}`;
  const [draft, setDraft] = useState<DshDraft>({ text: "", pending: null });
  const draftRef = useRef(draft);
  const [ready, setReady] = useState(false);
  const [events, setEvents] = useState<DshEvent[]>([]);
  const [snapshot, setSnapshot] = useState<DshSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [allEvents, setAllEvents] = useState(false);
  const [models, setModels] = useState(false);
  const [reasoning, setReasoning] = useState(false);
  const [intent, setIntent] = useState<"queue" | "steer">("queue");
  const list = useRef<FlatList<DshEvent>>(null);
  const nearBottom = useRef(true);
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
    void readDraft(key).then(value => { if (alive.current) { draftRef.current = value; setDraft(value); setReady(true); } }).catch(e => { if (alive.current) setError(humanError(e)); });
    return () => { alive.current = false; };
  }, [key]);
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
      const pending = current.pending ?? { id: Crypto.randomUUID(), content: current.text, kind: "chat" as const, intent };
      await update({ ...current, pending });
      const parts: ({ type: "text"; text: string } | { type: "file"; receiptId: string })[] = pending.content.trim() ? [{ type: "text", text: pending.content }] : [];
      const attachments = [...(current.files ?? []), ...(current.photos ?? []).map(p => ({ id: p.id, uri: p.prepared?.uri ?? p.uri, name: p.prepared?.name ?? p.name,
        mediaType: imageType(p.prepared?.uri ?? p.uri, p.prepared?.name ?? p.name) }))];
      for (const file of attachments) {
        const response = await expoFetch(`${connection.url}/v1${base}/dsh/files?name=${encodeURIComponent(file.name)}${file.mediaType ? `&mediaType=${encodeURIComponent(file.mediaType)}` : ""}`, {
          method: "PUT", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/octet-stream" },
          body: await new File(file.uri).bytes(), redirect: "error",
        });
        const receipt = await response.json();
        if (!response.ok) throw new Error(receipt.error?.message ?? "文件发送失败。");
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
      nearBottom.current = true; refresh(); onRefreshRef.current();
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
  const started = useRef(false);
  useEffect(() => {
    if (!ready || started.current) return;
    if (startWithFiles) { started.current = true; onFilesOpened?.(); void files(); }
    else if (startWithSend) { started.current = true; onSendStarted?.(); void send(); }
  });
  const rows = allEvents ? events : events.filter(e => !eventPresentation(e).quiet);
  const canSend = ready && !busy && !!(draft.text.trim() || draft.files?.length || draft.photos?.length || draft.pending);
  return <View style={{ flex: 1 }}>
    <FlatList ref={list} data={rows} keyExtractor={event => String(event.seq)} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 12 }}
      onScroll={e => { const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent; nearBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 100; }} scrollEventThrottle={100}
      onContentSizeChange={() => { if (nearBottom.current) list.current?.scrollToEnd({ animated: false }); }}
      renderItem={({ item }) => <EventRow event={item} name={assistantName} />}
      ListHeaderComponent={<ActionLink onPress={() => setAllEvents(!allEvents)}>{allEvents ? "收起内部事件" : "查看全部 DSH 事件"}</ActionLink>}
      ListFooterComponent={<>
        {liveText(snapshot) ? <MessageBody streaming>{liveText(snapshot)}</MessageBody> : null}
        {snapshot?.running ? <Text style={s.muted}>{snapshot.pending.length ? "等待你的回答" : "正在执行…"}</Text> : null}
        {snapshot?.queue.map(q => <Text key={q.id} style={s.small}>待处理：{contentText(q.content)}</Text>)}
        {snapshot?.pending.map(p => <InputCard key={p.id} pending={p} busy={busy} answer={value => { void action(`/dsh/answers/${p.id}`, value); }} />)}
      </>} />
    {error ? <Text accessibilityRole="alert" style={[s.error, { marginHorizontal: 20 }]}>{error}</Text> : null}
    <ConversationComposer unlimitedText text={draft.text} onText={text => { void update({ ...draftRef.current, text }).catch(e => setError(humanError(e))); }}
      editable={ready && !busy && !draft.pending} onSend={() => { void send(); }} onFiles={() => { void files(); }} onPhotos={() => { void photos(); }}
      attachmentLocked={!ready || busy || !!draft.pending} busy={busy} canSend={canSend} pending={!!draft.pending}
      kind="chat" onKind={() => {}} model={currentModel} depth={conversation.reasoning_effort ?? "auto"}
      onModel={() => setModels(true)} onReasoning={() => setReasoning(true)} optionsLocked={busy || !catalog}
      stopping={snapshot?.running && !canSend} onStop={() => { void action("/dsh/cancel"); }}
      hint={snapshot?.running ? <View style={s.row}>
        <ActionLink disabled={busy || !!draft.pending} onPress={() => setIntent(intent === "queue" ? "steer" : "queue")}>{intent === "queue" ? "排队发送" : "调整当前执行"}</ActionLink>
        <ActionLink disabled={busy} onPress={() => { void action("/dsh/cancel"); }}>停止执行</ActionLink>
      </View> : undefined}>
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
    <BottomSheet visible={!!settingsOpen} title="对话设置" onClose={() => onSettingsClose?.()}><DshHostSettings webUrl={webUrl} /></BottomSheet>
  </View>;
}
