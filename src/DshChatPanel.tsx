import { PermissionPicker } from "./PermissionPicker";
import type { DshPermission, DshPermissions } from "./dshPermissions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, BackHandler, FlatList, Keyboard, Linking, Pressable, ScrollView, Share, Text, TextInput, View, type ViewToken } from "react-native";
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
import { chatRows, contentText, eventPresentation, rowText, rowHasMessage, revisionSeq, deliveredFileForLink, messageVersions, dshFilePath, mergeDshEvents, type DshAttachment, type DshChatRow, type DshEvent, type DshPending, type DshSnapshot } from "./dshProtocol";
import { useSyncStatus } from "./ConnectionStatus";
import { DraftAttachments, MessagePhotos } from "./PhotoAttachments";
import { discardDraftPhotos } from "./chatPhotos";
import { ReplyContent } from "./ReplyContent";
import { useNotice } from "./Notice";
import { layout, radius, space } from "./theme";
import { ChatTextEditor } from "./ChatTextEditor";
import { DshFilePreview } from "./DshFilePreview";
import type { MessageRevision } from "./messageRevision";
import { ChatFileCard } from "./ChatFileCard";
import { conversationFiles } from "./conversationFiles";
import { ConversationFilesSheet } from "./ConversationFilesSheet";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { shareNativeDownload } from "./resources";

type LocalFile = { id: string; uri: string; name: string; mediaType?: string };
type DshDraft = Draft & { revision?: MessageRevision; sendVersion?: string; files?: LocalFile[]; receipts?: Record<string, string> };
type DshCache = { historyId: string; events: DshEvent[] } & Pick<DshSnapshot, "history">;
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

function MessageRow({ row, name, connection, base, phase, onCopy, onMenu, onRecords, onFile, highlighted, onRevise, revisionDisabled, versions, onVersion, onShare, onReadProcess }: {
  row: DshChatRow; name: string; connection: Connection; base: string; phase?: string;
  onCopy: () => void; onReadProcess: () => void; onMenu: () => void; onRecords: () => void;
  onFile: (file: DshAttachment) => void; highlighted?: boolean; onShare: (file: DshAttachment) => void;
  onRevise: () => void; revisionDisabled: boolean; versions: ReturnType<typeof messageVersions>; onVersion: (id: string) => void;
}) {
  const { s, colors } = useUi();
  const user = row.role === "user";
  const linkFiles = useRef(row.attachments);
  useEffect(() => { linkFiles.current = row.attachments; }, [row.attachments]);
  const openLink = useCallback((url: string) => {
    const file = deliveredFileForLink(linkFiles.current, url);
    if (!file) return false;
    onFile(file); return true;
  }, [onFile]);
  const images = row.attachments.filter(a => a.type === "image").map((a, index) => ({ ...a, id: `${a.id}:${index}`, path: `${base}/dsh/images/${encodeURIComponent(a.id)}` }));
  return <View style={{ paddingTop: space.lg, paddingBottom: space.sm, gap: 6, alignItems: user ? "flex-end" : "stretch" }}>
    {highlighted ? <Text accessibilityRole="header" style={[s.small, { color: colors.gold }]}>搜索定位到这里</Text> : null}
    {!user ? <View style={[s.row, { gap: 8, marginBottom: 4 }]}>
      <View style={{ width: 26, height: 26, borderRadius: 9, backgroundColor: colors.ink, alignItems: "center", justifyContent: "center" }}><Ionicons name="sparkles" size={14} color={colors.onInk} /></View>
      <Text style={[s.label, { fontSize: 13 }]}>{name}</Text>
    </View> : null}
    {/* Horizontal Markdown scrollers need a definite width inside a shrinking user bubble on Android. */}
    <View style={user ? { maxWidth: "88%", width: /```|~~~|\||(^|\n)( {4}|\t)/.test(rowText(row)) ? "88%" : undefined,
      paddingHorizontal: space.md, paddingVertical: space.md, borderRadius: radius.card, backgroundColor: colors.neutral, gap: space.xs } : { gap: space.sm }}>
      {images.length ? <MessagePhotos connection={connection} images={images} /> : null}
      {user ? rowText(row) ? <MessageBody>{rowText(row)}</MessageBody> : null
        : <ReplyContent parts={row.parts} active={row.active} status={row.status} phase={phase} onOpenRun={onRecords} onReadProcess={onReadProcess} onOpenLink={openLink} />}
      {row.attachments.filter(a => a.type === "file").map((a, index) => <ChatFileCard key={`${a.id}:${index}`} file={a} onOpen={() => onFile(a)} onShare={() => onShare(a)} />)}
    </View>
    {!row.active ? <View style={[s.row, { gap: 0, flexWrap: "wrap" }]}>
      {rowText(row) ? <IconAction icon="copy-outline" label="复制消息" onPress={onCopy} /> : null}
      <IconAction icon={user ? "create-outline" : "refresh-outline"} label={user ? "编辑消息" : "重新回答"} disabled={revisionDisabled} onPress={onRevise} />
      <IconAction icon="ellipsis-horizontal" label="更多消息操作" onPress={onMenu} />
      {versions && !user ? <View style={[s.row, { gap: 0 }]}>
        <IconAction icon="chevron-back" label="上一个消息版本" disabled={revisionDisabled || versions.index === 0} onPress={() => onVersion(versions.ids[versions.index - 1])} />
        <Text accessibilityLabel={`消息版本 ${versions.index + 1}，共 ${versions.ids.length} 个`} style={s.muted}>{versions.index + 1} / {versions.ids.length}</Text>
        <IconAction icon="chevron-forward" label="下一个消息版本" disabled={revisionDisabled || versions.index === versions.ids.length - 1} onPress={() => onVersion(versions.ids[versions.index + 1])} />
      </View> : null}
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
    <Text style={s.label}>模型与插件</Text>
    <Text style={s.text}>模型、搜索、记忆和其他扩展由 DSH 提供。可以在对话里让知行检查并配置所需的插件。</Text>
    <Text style={s.muted}>聊天与文件由 DSH 管理，知行负责发送、展示、预览和分享。</Text>
    {webUrl && /^https?:\/\//.test(webUrl) ? <ActionLink onPress={() => { void Linking.openURL(webUrl); }}>打开 DSH 设置</ActionLink> : null}
  </View>;
}

export function DshChatPanel({ connection, conversation, assistantName, catalog, onRefresh, onConversationChanged,
  startWithFiles, onFilesOpened, startWithSend, onSendStarted, settingsOpen, onSettingsClose, filesOpen, onFilesClose, onFilesOpen,
  focusMessageSeq, focusMessageVersion, onFocusHandled,
  menuAction, onMessageOptions,
}: {
  connection: Connection; conversation: Conversation; assistantName: string; catalog: ModelCatalog | null;
  onRefresh: () => void; onConversationChanged: (conversation: Conversation) => void;
  startWithFiles?: boolean; onFilesOpened?: () => void; startWithSend?: boolean; onSendStarted?: () => void;
  settingsOpen?: boolean; onSettingsClose?: () => void; filesOpen?: boolean; onFilesClose?: () => void; onFilesOpen?: () => void; webUrl?: string | null;
  focusMessageSeq?: number | null; onFocusHandled?: (seq: number) => void;
  focusMessageVersion?: string;
  menuAction?: { id: number; type: "share" | "search" }; onMessageOptions?: () => void;
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
  const rows = useMemo(() => chatRows(events, snapshot), [events, snapshot]);
  // The rows already belong to the active version; the extra guard drops a
  // presentation stamped for a version the user switched away from.
  const deliveredFiles = useMemo(() => conversationFiles(rows, snapshot?.history?.active), [rows, snapshot?.history?.active]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [records, setRecords] = useState<DshChatRow | "all" | null>(null);
  const [messageMenu, setMessageMenu] = useState<DshChatRow | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const afterMenu = useRef<(() => void) | null>(null);
  const [previewFile, setPreviewFile] = useState<DshAttachment | null>(null);
  const [previewFromFiles, setPreviewFromFiles] = useState(false);
  const [pendingPreview, setPendingPreview] = useState<DshAttachment | null>(null);
  const [closedSearchId, setClosedSearchId] = useState<number | null>(null);
  const searchOpen = menuAction?.type === "search" && menuAction.id !== closedSearchId;
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCursor, setSearchCursor] = useState(0);
  const lastMenuAction = useRef<number | null>(null);
  const sharing = useRef(false);
  const searchMatches = useMemo(() => searchQuery.trim() ? rows.filter(row => rowText(row).toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase())) : [], [rows, searchQuery]);
  const searchIndex = searchCursor % Math.max(searchMatches.length, 1);
  const [revisionError, setRevisionError] = useState("");
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [models, setModels] = useState(false);
  const [reasoning, setReasoning] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const permissionRevision = useRef(0);
  const [intent, setIntent] = useState<"queue" | "steer">("queue");
  const list = useRef<FlatList<DshChatRow>>(null);
  const contentHeight = useRef(0);
  const nearBottom = useRef(focusMessageSeq == null);
  const dragging = useRef(false);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const focusTarget = useRef<{ index: number; seq: number; attempts: number; editing: boolean } | null>(null);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handled = useRef(onFocusHandled);
  useEffect(() => { handled.current = onFocusHandled; }, [onFocusHandled]);
  const viewable = useCallback(({ viewableItems }: { viewableItems: ViewToken<DshChatRow>[] }) => {
    const target = focusTarget.current;
    if (!target || !viewableItems.some(item => item.index === target.index && item.isViewable)) return;
    focusTarget.current = null;
    if (focusTimer.current) clearTimeout(focusTimer.current);
    list.current?.scrollToIndex({ index: target.index, animated: false, viewPosition: 0.1 });
    if (!target.editing) handled.current?.(target.seq);
  }, []);
  const alive = useRef(true);
  const working = useRef(false);
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  const report = useSyncStatus(refresh);
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => { onRefreshRef.current = onRefresh; }, [onRefresh]);
  const currentModel = catalog?.items.find(m => m.id === (conversation.model_id ?? catalog.roles.chat));
  useEffect(() => {
    if (!menuAction || lastMenuAction.current === menuAction.id) return;
    lastMenuAction.current = menuAction.id;
    if (menuAction.type === "search") return;
    if (sharing.current) return;
    if (!snapshot || snapshot.hasMore) { notice.show({ message: "对话还在读取，请稍后分享。" }); return; }
    const messages = rows.map(row => {
      const text = [rowText(row), ...row.attachments.map(file => `[${file.type === "image" ? "图片" : "文件"}：${file.name}]`)].filter(Boolean).join("\n");
      return text ? `${row.role === "user" ? "我" : assistantName}\n${text}` : "";
    }).filter(Boolean);
    if (!messages.length) { notice.show({ message: "这段对话还没有可分享的消息。" }); return; }
    sharing.current = true;
    void Share.share({ title: conversation.title, message: `${conversation.title}\n\n${messages.join("\n\n")}` })
      .catch(e => { if (alive.current) notice.show({ message: humanError(e), tone: "error" }); })
      .finally(() => { sharing.current = false; });
  }, [menuAction, snapshot, rows, assistantName, conversation.title, notice]);
  useEffect(() => {
    if (!searchOpen) return;
    const handler = BackHandler.addEventListener("hardwareBackPress", () => { Keyboard.dismiss(); setClosedSearchId(menuAction?.id ?? null); setHighlighted(null); return true; });
    return () => handler.remove();
  }, [searchOpen, menuAction?.id]);
  const update = async (value: DshDraft) => {
    draftRef.current = value; if (alive.current) setDraft(value); await saveDraft(key, value);
  };
  useEffect(() => {
    alive.current = true;
    void readDraft(key).then(value => { if (alive.current) {
      const saved = value as DshDraft;
      if (saved.revision?.kind === "edit") nearBottom.current = false;
      draftRef.current = saved; setDraft(saved); setReady(true); setError("");
    } }).catch(e => { if (alive.current) setError(humanError(e)); });
    return () => { alive.current = false; };
  }, [key, draftAttempt]);
  useEffect(() => {
    let active = true, polling = false, cursor = 0, wasRunning = false;
    let accumulated: DshEvent[] = [];
    let historyId = conversation.id;
    let metadata = "";
    const controller = new AbortController();
    const cacheKey = `dsh:${conversation.id}`;
    async function poll() {
      if (!active || polling || AppState.currentState === "background") return;
      polling = true;
      const permissionsAtStart = permissionRevision.current;
      try {
        let changed = false;
        let next: DshSnapshot;
        do {
          next = await request<DshSnapshot>(connection, `${base}/dsh?offset=${cursor}&version=${encodeURIComponent(historyId)}`, { signal: controller.signal });
          if (!active) return;
          if (next.history && next.history.active !== historyId) {
            accumulated = []; historyId = next.history.active; changed = true;
            setHighlighted(null); setPreviewFile(null); setRecords(null); nearBottom.current = !draftRef.current.revision; setAwayFromLatest(false);
          }
          changed ||= next.events.length > 0;
          accumulated = mergeDshEvents(accumulated, next.events); cursor = next.next;
        } while (next.hasMore);
        if (changed) setEvents(accumulated);
        setSnapshot(previous => permissionsAtStart === permissionRevision.current || previous?.history?.active !== next.history?.active
          ? next : { ...next, permissions: previous?.permissions }); report();
        if (wasRunning && !next.running) onRefreshRef.current();
        wasRunning = next.running;
        const nextMetadata = JSON.stringify(next.history);
        if (changed || metadata !== nextMetadata) {
          metadata = nextMetadata;
          void writeCache(connection, cacheKey, { historyId, events: accumulated, history: next.history }).catch(() => {});
        }
      } catch (e) { if (active) report(e); }
      finally { polling = false; }
    }
    refreshRef.current = () => { void poll(); };
    void readCache<DshEvent[] | DshCache>(connection, cacheKey).then(cached => {
      if (!active) return;
      if (cached) {
        accumulated = Array.isArray(cached) ? cached : cached.events;
        historyId = Array.isArray(cached) ? conversation.id : cached.historyId;
        if (!Array.isArray(cached)) {
          metadata = JSON.stringify(cached.history);
          setSnapshot({ history: cached.history, events: [], next: 0, hasMore: false,
            running: false, active: false, queue: [], pending: [], live: null });
        }
        cursor = accumulated.length ? accumulated[accumulated.length - 1].seq + 1 : 0; setEvents(accumulated);
      }
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
    if (working.current || !ready || draftRef.current.revision) return;
    working.current = true; setBusy(true); setError("");
    try {
      const current = draftRef.current;
      const pending = current.pending ?? { id: Crypto.randomUUID(), content: current.text, kind: "chat" as const, intent: snapshot?.running ? intent : "queue" };
      const sendVersion = current.sendVersion ?? snapshot?.history?.active ?? conversation.id;
      await update({ ...current, pending, sendVersion });
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
      await request(connection, `${base}/messages`, { method: "POST", body: { ...pending, parts, version: sendVersion } });
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
  async function selectPermission(permission: DshPermission) {
    if (working.current) throw new Error("请等当前操作完成后再修改权限。");
    working.current = true; setBusy(true); permissionRevision.current++;
    const version = snapshot?.history?.active ?? conversation.id;
    try {
      const updated = await request<DshPermissions>(connection, `${base}/dsh/permissions`, {
        method: "PUT", body: { permission, version },
      });
      if (alive.current) setSnapshot(previous => previous && (previous.history?.active ?? conversation.id) === version
        ? { ...previous, permissions: updated } : previous);
    } finally {
      permissionRevision.current++; working.current = false;
      if (alive.current) { setBusy(false); refresh(); }
    }
  }
  async function copyMessage(row: DshChatRow) {
    try { await Clipboard.setStringAsync(rowText(row)); notice.show({ message: "已复制消息", tone: "success" }); }
    catch (e) { setError(humanError(e)); }
  }
  const prepareShare = useCallback((file: DshAttachment) => shareNativeDownload(connection, file.name, dshFilePath(base, file)), [connection, base]);
  const shareFromMessage = useCallback((file: DshAttachment) => {
    void prepareShare(file).catch(e => setError(humanError(e)));
  }, [prepareShare]);
  function openFromFiles(file: DshAttachment) {
    // Close the list first; its dismissal hands off to the single native preview modal.
    setPendingPreview(file); onFilesClose?.();
  }
  function previewClosed() {
    if (!previewFromFiles) return;
    setPreviewFromFiles(false); onFilesOpen?.();
  }
  async function quoteMessage(row: DshChatRow) {
    if (!ready || busy || draftRef.current.pending) return;
    try {
      const addition = row.role === "user" ? rowText(row) : `关于这条回复：\n${rowText(row)}\n\n`;
      await update({ ...draftRef.current, text: [draftRef.current.text, addition].filter(Boolean).join("\n\n") });
      setMessageMenu(null); notice.show({ message: "已放入草稿，可修改后发送" });
    } catch (e) { setError(humanError(e)); }
  }
  const historyId = snapshot?.history?.active ?? conversation.id;
  const historyLocked = !snapshot || snapshot.running || !!snapshot.queue.length || busy || !!draft.pending || !ready;
  async function beginRevision(row: DshChatRow) {
    const seq = revisionSeq(row); if (seq === undefined || historyLocked || draftRef.current.revision) return;
    try {
      await update({ ...draftRef.current, revision: { id: Crypto.randomUUID(), kind: row.role === "user" ? "edit" : "retry",
        seq, version: historyId, text: rowText(row), attachments: row.attachments } });
      setRevisionError("");
      if (row.role === "assistant") await submitRevision();
    } catch (e) { setError(humanError(e)); }
  }
  async function submitRevision() {
    const value = draftRef.current.revision;
    if (!value || working.current) return;
    working.current = true; setBusy(true); setRevisionError("");
    try {
      await update({ ...draftRef.current, revision: { ...value, submitted: true } });
      await request(connection, `${base}/dsh/revisions`, { method: "POST", timeoutMs: 60000,
        body: { id: value.id, kind: value.kind, seq: value.seq, version: value.version,
          ...(value.kind === "edit" ? { text: value.text, attachments: value.attachments.map(a => a.id) } : {}) } });
      await update({ ...draftRef.current, revision: undefined, receipts: undefined, sendVersion: undefined });
      if (alive.current) { nearBottom.current = true; setAwayFromLatest(false); refresh(); onRefreshRef.current(); }
    } catch (e) { if (alive.current) setRevisionError(humanError(e)); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  }
  async function switchVersion(version: string) {
    if (working.current || historyLocked || draftRef.current.revision) return;
    working.current = true; setBusy(true); setRevisionError("");
    try {
      await request(connection, `${base}/dsh/version`, { method: "PUT", body: { expected: historyId, version } });
      await update({ ...draftRef.current, receipts: undefined, sendVersion: undefined });
      setVersionsOpen(false); refresh(); onRefreshRef.current();
    } catch (e) { setRevisionError(humanError(e)); }
    finally { working.current = false; setBusy(false); }
  }
  const started = useRef(false);
  useEffect(() => {
    if (!ready || started.current) return;
    if (startWithFiles) { started.current = true; onFilesOpened?.(); void files(); }
    else if (startWithSend) { started.current = true; onSendStarted?.(); void send(); }
  });
  useEffect(() => {
    // Wait for native cells to mount when restoring history; later streaming
    // growth still follows onContentSizeChange. A drag or search cancels following.
    const timer = setTimeout(() => { if (nearBottom.current) list.current?.scrollToOffset({ offset: contentHeight.current, animated: false }); }, 50);
    return () => clearTimeout(timer);
  }, [rows.length]);
  const focusVersionMatches = !focusMessageVersion || snapshot?.history?.active === focusMessageVersion;
  useEffect(() => {
    if (focusMessageSeq != null && snapshot?.history?.active && !focusVersionMatches) {
      handled.current?.(focusMessageSeq);
      notice.show({ message: "对话版本已改变，请重新搜索后定位。", tone: "warning" });
    }
  }, [focusMessageSeq, focusVersionMatches, snapshot?.history?.active, notice]);
  const editingTarget = draft.revision?.kind === "edit" && draft.revision.version === historyId ? draft.revision : undefined;
  const editingId = searchOpen ? undefined : editingTarget?.id;
  const targetSeq = searchOpen ? searchMatches[searchIndex] ? revisionSeq(searchMatches[searchIndex]) : null
    : editingTarget?.seq ?? (focusVersionMatches ? focusMessageSeq : null);
  const focusIndex = targetSeq == null ? -1 : rows.findIndex(row => rowHasMessage(row, targetSeq));
  const focusRowId = rows[focusIndex]?.id;
  useEffect(() => {
    if (targetSeq == null || focusIndex < 0) return;
    nearBottom.current = false;
    focusTarget.current = { seq: targetSeq, index: focusIndex, attempts: 0, editing: !!editingId };
    focusTimer.current = setTimeout(() => {
      setAwayFromLatest(true); setHighlighted(editingId ? null : focusRowId ?? null);
      list.current?.scrollToIndex({ index: focusIndex, animated: false, viewPosition: 0.1 });
    }, 100);
    return () => { focusTarget.current = null; if (focusTimer.current) clearTimeout(focusTimer.current); };
  }, [targetSeq, focusIndex, focusRowId, editingId]);
  const queue = snapshot?.queue ?? [];
  const canSend = ready && !busy && !draft.revision && !!(draft.text.trim() || draft.files?.length || draft.photos?.length || draft.pending);
  const scrollToLatest = (animated: boolean) => list.current?.scrollToOffset({ offset: contentHeight.current, animated });
  const followLatest = () => { if (nearBottom.current) scrollToLatest(false); };
  return <View style={{ flex: 1 }}>
    {searchOpen ? <View style={[s.row, { paddingHorizontal: space.md, borderBottomWidth: 1, borderBottomColor: colors.line, gap: space.xs }]}>
      <TextInput accessibilityLabel="在聊天中查找" placeholder="在聊天中查找" placeholderTextColor={colors.muted} autoFocus
        value={searchQuery} onChangeText={value => { setSearchQuery(value); setSearchCursor(0); setHighlighted(null); }}
        style={{ flex: 1, minWidth: 0, minHeight: layout.touchTarget, color: colors.ink }} returnKeyType="search" />
      <Text accessibilityLiveRegion="polite" style={s.small}>{searchQuery.trim() ? searchMatches.length ? `${searchIndex + 1}/${searchMatches.length} 条` : "无匹配" : ""}</Text>
      <IconAction icon="chevron-up" label="上一个匹配" disabled={!searchMatches.length} onPress={() => setSearchCursor((searchIndex + searchMatches.length - 1) % searchMatches.length)} />
      <IconAction icon="chevron-down" label="下一个匹配" disabled={!searchMatches.length} onPress={() => setSearchCursor(searchIndex + 1)} />
      <IconAction icon="close" label="关闭聊天查找" onPress={() => { Keyboard.dismiss(); setClosedSearchId(menuAction?.id ?? null); setHighlighted(null); }} />
    </View> : null}
    <View style={{ flex: 1 }}>
    <FlatList key={historyId} ref={list} data={rows} keyExtractor={row => row.id} keyboardShouldPersistTaps="handled" removeClippedSubviews={false}
      onViewableItemsChanged={viewable}
      onScrollToIndexFailed={({ index, averageItemLength }) => {
        const target = focusTarget.current;
        if (!target || target.index !== index) return;
        if (++target.attempts > 8) {
          focusTarget.current = null; notice.show({ message: "未能定位到这条消息，可滚动查看原文。", tone: "warning" }); return;
        }
        list.current?.scrollToOffset({ offset: averageItemLength * index, animated: false });
        if (focusTimer.current) clearTimeout(focusTimer.current);
        focusTimer.current = setTimeout(() => { if (focusTarget.current) list.current?.scrollToIndex({ index, animated: false, viewPosition: 0.1 }); }, 200);
      }}
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
      renderItem={({ item, index }) => <MessageRow row={item} name={assistantName} connection={connection} base={base}
        phase={item.active && snapshot?.pending.length ? snapshot.pending[0].kind === "approval" ? "approval" : "input" : undefined}
        highlighted={item.id === highlighted} onFile={setPreviewFile} onReadProcess={() => { nearBottom.current = false; setAwayFromLatest(true); }}
        onShare={shareFromMessage}
        onRevise={() => { void beginRevision(item); }} revisionDisabled={historyLocked || !!draft.revision}
        versions={messageVersions(snapshot?.history, rows.slice(0, index + 1).filter(row => row.role === "user").length - 1)} onVersion={id => { void switchVersion(id); }}
        onCopy={() => { void copyMessage(item); }} onMenu={() => setMessageMenu(item)} onRecords={() => setRecords(item)} />}
      ListFooterComponent={<>
        {snapshot?.pending.map(p => <InputCard key={p.id} pending={p} busy={busy} answer={value => { void action(`/dsh/answers/${p.id}`, value); }} />)}
      </>} />
    {awayFromLatest && !draft.revision && !searchOpen ? <Pressable accessibilityRole="button" accessibilityLabel="回到最新消息"
      onPress={() => { nearBottom.current = true; setAwayFromLatest(false); scrollToLatest(true); }}
      style={{ position: "absolute", bottom: 12, alignSelf: "center", minHeight: 44, paddingHorizontal: 16,
        justifyContent: "center", borderRadius: 22, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.line }}>
      <Text style={s.description}>回到最新</Text>
    </Pressable> : null}
    </View>
    {error ? <Text accessibilityRole="alert" style={[s.error, { marginHorizontal: 20 }]}>{error}</Text> : null}
    {!ready && error ? <Button secondary onPress={() => setDraftAttempt(value => value + 1)}>重新读取草稿</Button> : null}
    {revisionError ? <Text accessibilityRole="alert" style={[s.error, { marginHorizontal: 20 }]}>{revisionError}</Text> : null}
    {!searchOpen ? <ConversationComposer unlimitedText text={draft.revision?.kind === "edit" ? draft.revision.text : draft.text}
      onText={text => { const value = draftRef.current; void update(value.revision?.kind === "edit" ? { ...value, revision: { ...value.revision, text } } : { ...value, text }).catch(e => setError(humanError(e))); }}
      editing={draft.revision ? { id: draft.revision.id, label: draft.revision.kind === "retry" ? "重新回答" : "编辑消息", onCancel: () => {
        void update({ ...draftRef.current, revision: undefined }).then(() => { setRevisionError(""); refresh(); }).catch(e => setError(humanError(e)));
      } } : undefined}
      editable={ready && !busy && !draft.pending && !draft.revision?.submitted} onSend={() => { void (draft.revision ? submitRevision() : send()); }} onFiles={() => { void files(); }} onPhotos={() => { void photos(); }}
      onConversationFiles={onFilesOpen} onMessageOptions={onMessageOptions}
      attachmentLocked={!ready || busy || !!draft.pending || !!draft.revision} busy={busy}
      canSend={draft.revision ? !busy && !!(draft.revision.kind === "retry" || draft.revision.text.trim() || draft.revision.attachments.length) : canSend}
      pending={!!draft.pending || !!draft.revision?.submitted}
      kind="chat" onKind={() => {}} model={currentModel} depth={conversation.reasoning_effort ?? "auto"}
      onModel={() => setModels(true)} onReasoning={() => setReasoning(true)} optionsLocked={busy || !catalog || !!draft.revision}
      permission={snapshot?.permissions?.current} onPermission={() => setPermissionOpen(true)} permissionLocked={busy || !snapshot?.permissions || !!draft.revision}
      stopping={!draft.revision && snapshot?.running && !canSend} onStop={() => { void action("/dsh/cancel"); }}
      floating={queue.length ? <Pressable accessibilityRole="button" accessibilityLabel={`查看待发送消息，共 ${queue.length} 条`} onPress={() => setQueueOpen(true)}
        style={{ minHeight: layout.touchTarget, borderRadius: radius.item, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surfaceRaised, paddingHorizontal: space.md, justifyContent: "center" }}>
        <Text numberOfLines={1} style={s.description}>等待发送 · {queue.length} 条　{contentText(queue[0].content)}</Text>
      </Pressable> : undefined}
      hint={draft.revision?.submitted ? <Text style={s.muted}>提交结果待确认，重试会核对同一次操作。</Text> : draft.pending && error ? <Text style={s.muted}>发送尚未确认，内容已保留，可重试。</Text> : undefined}>
      {draft.revision?.kind === "edit" && draft.revision.attachments.some(a => a.type === "image") ? <MessagePhotos connection={connection}
        images={draft.revision.attachments.filter(a => a.type === "image").map(a => ({ ...a, path: `${base}/dsh/images/${encodeURIComponent(a.id)}` }))} /> : null}
      {draft.revision?.kind === "edit" ? draft.revision.attachments.map(a => <View key={a.id} style={[s.row, { gap: 4 }]}>
        <Ionicons name={a.type === "image" ? "image-outline" : "document-outline"} size={18} color={colors.muted} />
        <Text numberOfLines={1} style={[s.description, { flex: 1 }]}>{a.name}</Text>
        <IconAction icon="close" label={`移除附件 ${a.name}`} disabled={busy || !!draft.revision?.submitted} onPress={() => {
          const value = draftRef.current; if (value.revision) void update({ ...value, revision: { ...value.revision, attachments: value.revision.attachments.filter(f => f.id !== a.id) } }).catch(e => setError(humanError(e)));
        }} />
      </View>) : null}
      {!draft.revision ? <>
      <DraftAttachments connection={connection} photos={[...(draft.photos ?? []), ...(draft.files ?? []).filter(f => f.mediaType?.startsWith("image/")).map(f => ({ ...f, width: 0, height: 0 }))]}
        removePhoto={busy || draft.pending ? undefined : id => { const value = draftRef.current;
          void update({ ...value, photos: value.photos?.filter(p => p.id !== id), files: value.files?.filter(f => f.id !== id) })
            .then(() => { discardDraftPhotos(value.photos?.filter(p => p.id === id) ?? []); value.files?.filter(f => f.id === id).forEach(discardFile); })
            .catch(e => setError(humanError(e))); }} />
      {(draft.files ?? []).filter(f => !f.mediaType?.startsWith("image/")).map(file => <ActionLink key={file.id} disabled={busy || !!draft.pending} onPress={() => { void update({ ...draftRef.current, files: draftRef.current.files?.filter(f => f.id !== file.id) }).then(() => discardFile(file)).catch(e => setError(humanError(e))); }}>{`移除 · ${file.name}`}</ActionLink>)}
      </> : null}
    </ConversationComposer> : null}
    <ModelPicker visible={models} title="选择模型" connectionUrl={connection.url} models={catalog?.items ?? []} selectedId={currentModel?.id ?? null}
      onSelect={id => selectModel(id, null)} onClose={() => setModels(false)} />
    <ReasoningPicker visible={reasoning} model={currentModel} selected={conversation.reasoning_effort}
      onSelect={value => selectModel(conversation.model_id, value)} onClose={() => setReasoning(false)} />
    <PermissionPicker visible={permissionOpen} permissions={snapshot?.permissions} onSelect={selectPermission} onClose={() => setPermissionOpen(false)} />
    <BottomSheet visible={!!settingsOpen} title="发送方式" onClose={() => onSettingsClose?.()}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
        <Text style={s.label}>这条消息的发送方式</Text>
        <ActionLink disabled={busy || !!draft.pending} onPress={() => setIntent(intent === "queue" ? "steer" : "queue")}>{intent === "queue" ? "接着处理" : "补充当前回复"}</ActionLink>
        <Text style={s.description}>{intent === "queue" ? "当前回复完成后，按顺序处理新消息。" : "执行过程中加入新要求；空闲时直接开始回复。"}</Text>
        {snapshot?.running ? <ActionLink disabled={busy} onPress={() => { void action("/dsh/cancel"); }}>停止回复</ActionLink> : null}
        <ActionLink icon="git-branch-outline" onPress={() => { onSettingsClose?.(); setRevisionError(""); setVersionsOpen(true); }}>查看对话版本</ActionLink>
        <ActionLink icon="receipt-outline" onPress={() => { onSettingsClose?.(); setRecords("all"); }}>查看完整处理记录</ActionLink>
      </ScrollView>
    </BottomSheet>
    <BottomSheet visible={!!messageMenu} title="消息操作" onClose={() => setMessageMenu(null)} onDismiss={() => { const next = afterMenu.current; afterMenu.current = null; next?.(); }}>
      <View style={s.content}>
        {messageMenu && rowText(messageMenu) ? <>
          <ActionLink icon="copy-outline" onPress={() => { void copyMessage(messageMenu); setMessageMenu(null); }}>复制消息</ActionLink>
          <ActionLink icon="text-outline" onPress={() => { const text = rowText(messageMenu); afterMenu.current = () => setSelectedText(text); setMessageMenu(null); }}>选取文字</ActionLink>
          <ActionLink icon="create-outline" disabled={!ready || busy || !!draft.pending} onPress={() => { void quoteMessage(messageMenu); }}>{messageMenu.role === "user" ? "复制到草稿修改" : "引用到草稿"}</ActionLink>
        </> : null}
        {messageMenu && revisionSeq(messageMenu) !== undefined ? <ActionLink icon="refresh-outline" disabled={historyLocked || !!draft.revision}
          onPress={() => { const row = messageMenu; afterMenu.current = () => { void beginRevision(row); }; setMessageMenu(null); }}>
          {messageMenu.role === "user" ? "编辑消息" : "重新回答"}
        </ActionLink> : null}
        <ActionLink icon="receipt-outline" onPress={() => { setRecords(messageMenu); setMessageMenu(null); }}>查看处理记录</ActionLink>
      </View>
    </BottomSheet>
    <BottomSheet visible={versionsOpen} title="对话版本" onClose={() => { if (!busy) setVersionsOpen(false); }}>
      <ScrollView contentContainerStyle={s.content}>
        <Text style={s.description}>切换要查看和继续的版本。旧回复保留；工作区文件和已执行操作不会回滚。</Text>
        {(snapshot?.history?.versions ?? [{ id: conversation.id, label: "原始版本" }]).map(v => <ActionLink key={v.id}
          disabled={historyLocked || !!draft.revision || v.id === historyId} onPress={() => { void switchVersion(v.id); }}>
          {`${v.label}${v.id === historyId ? " · 当前" : ""}`}
        </ActionLink>)}
        {revisionError ? <Text accessibilityRole="alert" style={s.error}>{revisionError}</Text> : null}
        {historyLocked ? <Text style={s.muted}>回复和等待消息处理完后可切换。</Text> : null}
      </ScrollView>
    </BottomSheet>
    {selectedText !== null ? <ChatTextEditor text={selectedText} onClose={() => setSelectedText(null)} /> : null}
    <ConversationFilesSheet visible={!!filesOpen} ready={!!snapshot} files={deliveredFiles}
      onOpen={openFromFiles} onShare={prepareShare} onClose={() => { setPendingPreview(null); onFilesClose?.(); }}
      onDismiss={() => { const file = pendingPreview; if (!file) return; setPendingPreview(null); setPreviewFromFiles(true); setPreviewFile(file); }} />
    <DshFilePreview connection={connection} base={base} file={previewFile} onClose={() => setPreviewFile(null)} onDismiss={previewClosed} />
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
