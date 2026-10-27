import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, type FlatList } from "react-native";
import * as Crypto from "expo-crypto";
import * as Speech from "expo-speech";
import {
  mergeById,
  prepareMessage,
  request,
  type Connection,
  type Conversation,
  type Message,
  type MessageInput,
  type Page,
  type Run,
  type Resource,
  type DraftPhoto,
  type RunEvent,
} from "./api";
import { liveRunFinished, liveRunView, mergeLiveRunEvents, newLiveRun, type LiveRunBuffer } from "./liveRun";
import {
  clearDraft,
  draftKey,
  readDraft,
  saveDraft,
  type Draft,
} from "./storage";
import { useSyncStatus } from "./ConnectionStatus";
import { humanError } from "./ui";
import { isSteerableUserRun } from "./steerableRun";
import { discardDraftPhotos, sendDraftPhoto } from "./chatPhotos";

export function useChat({
  connection,
  conversation,
  onRefresh,
  initialKind = "chat",
  startWithFiles = false,
  focusMessageSeq = null,
  defaultIntent = "queue",
  defaultIntentReady = true,
  streamEvents = true,
}: {
  connection: Connection;
  conversation: Conversation;
  onRefresh: () => void;
  initialKind?: "chat" | "task";
  startWithFiles?: boolean;
  focusMessageSeq?: number | null;
  defaultIntent?: "queue" | "steer";
  defaultIntentReady?: boolean;
  streamEvents?: boolean;
}) {
  const streamScope = `${connection.url}\n${connection.token}\n${conversation.id}`;
  const currentScope = useRef(streamScope);
  const sendController = useRef<AbortController | null>(null);
  const [sendingPhoto, setSendingPhoto] = useState<{ id: string; index: number; total: number } | null>(null);
  const [runScope, setRunScope] = useState(streamScope);
  const loadedScope = useRef(streamScope);
  const [messages, setMessages] = useState<Message[]>([]);
  const pendingStatusRef = useRef<number | null>(null);
  useEffect(() => {
    pendingStatusRef.current =
      messages.find(
        (message) =>
          message.role === "user" &&
          message.status === "accepted" &&
          message.intent === "steer",
      )?.seq ??
      messages.find(
        (message) => message.role === "user" && message.status === "accepted",
      )?.seq ??
      null;
  }, [messages]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [running, setRunning] = useState<Run | null>(null);
  const [previous, setPrevious] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ text: "", pending: null });
  const draftRef = useRef(draft);
  const [draftReady, setDraftReady] = useState(false);
  const [draftLoadError, setDraftLoadError] = useState("");
  const [draftRevision, setDraftRevision] = useState(0);
  const sending = useRef(false);
  const acknowledged = useRef(new Set<string>());
  const clearing = useRef(new Map<string, Promise<void>>());
  const [intent, setIntentValue] = useState<"queue" | "steer">("queue");
  const [kind, setKind] = useState<"chat" | "task">(initialKind);
  const [target, setTargetValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(startWithFiles);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const alive = useRef(true);
  const list = useRef<FlatList<Message>>(null);
  const nearBottomRef = useRef(focusMessageSeq === null);
  const key = draftKey(connection.url, conversation.id);
  const [draftScope, setDraftScope] = useState(streamScope);
  if (draftScope !== streamScope) {
    setDraftScope(streamScope); setDraftReady(false); setDraftLoadError("");
    setDraft({ text: "", pending: null }); setBusy(false); setSendingPhoto(null);
  }
  const refresh = useRef<() => void>(() => undefined);
  const refreshLive = useRef<() => void>(() => undefined);
  const reportSync = useSyncStatus(() => refresh.current());
  const reportLiveSync = useSyncStatus(() => refreshLive.current());
  const [liveEvents, setLiveEvents] = useState<{ scope: string; buffer: LiveRunBuffer } | null>(null);
  const retainedLive = useRef<{ scope: string; buffer: LiveRunBuffer } | null>(null);
  const scopedRuns = runScope === streamScope ? runs.filter((run) => run.conversation_id === conversation.id) : [];
  const currentRunning = runScope === streamScope && running?.conversation_id === conversation.id && isSteerableUserRun(running) ? running : null;
  const trackedRun = currentRunning
    ?? scopedRuns.find((run) => run.status === "queued") ?? scopedRuns.at(-1) ?? null;
  const trackedRunId = trackedRun?.id ?? null;
  const trackedRunStatus = trackedRun?.status ?? null;

  useEffect(() => {
    alive.current = true;
    let active = true;
    readDraft(key)
      .then((value) => {
        if (active) {
          if (!value.pending) {
            // Legacy drafts have no trustworthy original running target. Keep them queued.
            value = { ...value, delivery: value.text.trim() || value.attachments?.length || value.photos?.length ? value.delivery?.intent === "steer"
              ? { intent: "steer", ...(typeof value.delivery.target_run_id === "string" ? { target_run_id: value.delivery.target_run_id } : {}) }
              : { intent: "queue" } : undefined };
          }
          setDraft(value);
          draftRef.current = value;
          setDraftReady(true);
          if (value.pending) {
            setKind(value.pending.kind);
            setIntentValue(value.pending.intent);
            setTargetValue(value.pending.target_run_id ?? null);
          } else {
            setIntentValue(value.delivery?.intent ?? "queue");
            setTargetValue(value.delivery?.target_run_id ?? null);
          }
        }
      })
      .catch((e) => {
        if (active) setDraftLoadError(humanError(e));
      });
    return () => {
      active = false;
      alive.current = false;
      void Speech.stop();
    };
  }, [key, streamScope, draftRevision]);

  useEffect(() => {
    currentScope.current = streamScope;
    sending.current = false;
    return () => { sendController.current?.abort(); sendController.current = null; };
  }, [streamScope]);

  function updateDraft(change: Draft | ((old: Draft) => Draft)) {
    let value = typeof change === "function" ? change(draftRef.current) : change;
    if (!value.pending) {
      const hasContent = !!value.text.trim() || !!value.attachments?.length || !!value.photos?.length;
      const bound = value.delivery ?? draftRef.current.delivery;
      const delivery = hasContent ? bound ?? { intent: currentRunning && defaultIntentReady ? defaultIntent : "queue",
        ...(currentRunning && defaultIntentReady && defaultIntent === "steer" ? { target_run_id: currentRunning.id } : {}) } : undefined;
      value = { ...value, delivery };
      setIntentValue(delivery?.intent ?? "queue"); setTargetValue(delivery?.target_run_id ?? null);
    }
    draftRef.current = value;
    setDraft(value);
    return saveDraft(key, value);
  }
  function setIntent(value: "queue" | "steer") {
    if (draftRef.current.pending) return;
    const delivery = { intent: value, ...(value === "steer" && target ? { target_run_id: target } : {}) };
    void updateDraft({ ...draftRef.current, delivery }).catch((e) => setError(humanError(e)));
  }
  function setTarget(value: string | null) {
    if (draftRef.current.pending) return;
    const delivery = { intent: draftRef.current.delivery?.intent ?? intent, ...(value ? { target_run_id: value } : {}) };
    void updateDraft({ ...draftRef.current, delivery }).catch((e) => setError(humanError(e)));
  }

  const settleDraft = useCallback((id: string) => {
    const existing = clearing.current.get(id);
    if (existing) return existing;
    const photos = draftRef.current.pending?.id === id ? draftRef.current.photos ?? [] : [];
    const pending = clearDraft(key, id).then(() => {
      discardDraftPhotos(photos);
      // A late receipt must never erase text edited after abandoning that request.
      if (!alive.current || draftRef.current.pending?.id !== id) return;
      draftRef.current = { text: "", pending: null };
      setDraft(draftRef.current); setIntentValue("queue"); setTargetValue(null); setError("");
    }).finally(() => { clearing.current.delete(id); });
    clearing.current.set(id, pending);
    return pending;
  }, [key]);
  useEffect(() => {
    const pending = draft.pending;
    if (!draftReady || !pending || runScope !== streamScope) return;
    const receipt = messages.find((message) => message.id === pending.id && message.role === "user"
      && message.conversation_id === conversation.id && message.content === pending.content && (message.submitted_intent ?? message.intent) === pending.intent
      && (message.attachments ?? []).map((item) => item.id).sort().join(",") === [...(pending.attachments ?? [])].sort().join(","));
    if (!receipt) return;
    acknowledged.current.add(pending.id);
    void settleDraft(pending.id).catch((e) => { if (alive.current) setError(humanError(e)); });
  }, [conversation.id, draft.pending, draftReady, messages, runScope, streamScope, settleDraft]);

  useEffect(() => {
    let active = true;
    let initial = true;
    let lastSeq = 0;
    let catchUpTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    async function poll() {
      if (!active || controller || AppState.currentState !== "active") return;
      const batch = new AbortController(); controller = batch;
      const valid = () => active && !batch.signal.aborted && controller === batch && AppState.currentState === "active";
      let hasMore = false;
      try {
        const [history, tasks, activeRuns, receipts] = await Promise.all([
          request<Page<Message>>(
            connection,
            `/conversations/${conversation.id}/messages?${initial ? (focusMessageSeq === null ? "latest=true" : `before=${focusMessageSeq + 1}`) : `cursor=${lastSeq}`}&limit=100`,
            { signal: batch.signal },
          ),
          request<Page<Run>>(
            connection,
            `/runs?conversation_id=${conversation.id}&latest=true&limit=100`,
            { signal: batch.signal },
          ),
          request<Page<Run>>(
            connection,
            `/runs?conversation_id=${conversation.id}&status=running&limit=1`,
            { signal: batch.signal },
          ),
          pendingStatusRef.current === null
            ? Promise.resolve(null)
            : request<Page<Message>>(
                connection,
                `/conversations/${conversation.id}/messages?cursor=${pendingStatusRef.current - 1}&limit=100`,
                { signal: batch.signal },
              ),
        ]);
        if (!valid()) return;
        const sameScope = loadedScope.current === streamScope;
        setMessages((previous) => {
          const old = sameScope ? previous : [];
          const known = new Set(old.map((message) => message.id));
          const updated =
            receipts?.items.filter((message) => known.has(message.id)) ?? [];
          return mergeById(mergeById(old, updated), history.items).sort(
            (a, b) => a.seq - b.seq,
          );
        });
        if (history.items.length)
          lastSeq = history.items[history.items.length - 1].seq;
        hasMore = !!history.next_cursor;
        setRuns(tasks.items);
        loadedScope.current = streamScope; setRunScope(streamScope);
        setRunning(
          [...activeRuns.items, ...tasks.items].find((run) => run.conversation_id === conversation.id && isSteerableUserRun(run)) ?? null,
        );
        if (initial) {
          setPrevious(history.previous_cursor ?? null);
          initial = false;
        }
        reportSync();
      } catch (e) {
        if (valid()) reportSync(e);
      } finally {
        const accepted = valid();
        if (controller === batch) controller = null;
        if (accepted) setLoading(false);
        if (accepted && hasMore)
          catchUpTimer = setTimeout(() => {
            void poll();
          }, 100);
      }
    }
    refresh.current = () => {
      void poll();
      refreshLive.current();
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 2500);
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void poll();
      else { controller?.abort(); controller = null; clearTimeout(catchUpTimer); }
    });
    return () => {
      active = false;
      clearInterval(timer);
      clearTimeout(catchUpTimer);
      controller?.abort();
      listener.remove();
    };
  }, [connection, conversation.id, focusMessageSeq, streamScope, reportSync]);

  useEffect(() => {
    if (!streamEvents || !trackedRunId) return;
    let active = true;
    let buffer = retainedLive.current?.scope === streamScope && retainedLive.current.buffer.runId === trackedRunId
      ? retainedLive.current.buffer : newLiveRun(trackedRunId);
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => { retainedLive.current = { scope: streamScope, buffer }; setLiveEvents({ scope: streamScope, buffer }); };
    async function poll() {
      if (!active || controller || AppState.currentState !== "active") return;
      clearTimeout(timer);
      const batch = new AbortController(); controller = batch;
      const valid = () => active && !batch.signal.aborted && controller === batch && AppState.currentState === "active";
      let more = false;
      try {
        const page = await request<Page<RunEvent>>(connection, `/runs/${trackedRunId}/events?after=${buffer.cursor}&limit=100`, { signal: batch.signal });
        if (!valid()) return;
        const before = buffer.cursor;
        buffer = mergeLiveRunEvents(buffer, page.items);
        more = !!page.next_cursor && buffer.cursor > before;
        publish(); reportLiveSync();
      } catch (e) {
        if (valid()) { buffer = { ...buffer, connectionIssue: true }; publish(); reportLiveSync(e); }
      } finally {
        const accepted = valid();
        if (controller === batch) controller = null;
        // A resumed run keeps its ID/cursor. Empty pages can precede the new
        // runtime's reset, so an old terminal event must not stop its new poll.
        if (accepted && (more || trackedRunStatus === "running" || trackedRunStatus === "queued" || !liveRunFinished(buffer)))
          timer = setTimeout(() => { void poll(); }, more ? 100 : 800);
      }
    }
    refreshLive.current = () => { void poll(); };
    void poll();
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void poll();
      else { controller?.abort(); controller = null; clearTimeout(timer); }
    });
    return () => { active = false; controller?.abort(); clearTimeout(timer); listener.remove(); refreshLive.current = () => undefined; };
  }, [connection, streamScope, trackedRunId, trackedRunStatus, reportLiveSync, streamEvents]);

  async function loadOlder() {
    if (!previous || busy) return;
    setBusy(true);
    try {
      const page = await request<Page<Message>>(
        connection,
        `/conversations/${conversation.id}/messages?before=${encodeURIComponent(previous)}&limit=100`,
      );
      if (!alive.current) return;
      nearBottomRef.current = false;
      setMessages((old) =>
        mergeById(page.items, old).sort((a, b) => a.seq - b.seq),
      );
      setPrevious(page.previous_cursor ?? null);
    } catch (e) {
      if (alive.current) setError(humanError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function send(options: Pick<MessageInput, "model_id" | "reasoning_effort" | "search_provider_id"> = {}) {
    let source = draftRef.current;
    if (sending.current || busy || !draftReady || runScope !== streamScope || (!source.text.trim() && !source.attachments?.length && !source.photos?.length)) return;
    if (!source.pending && !defaultIntentReady) return;
    sending.current = true;
    const controller = new AbortController(); sendController.current = controller;
    const active = () => alive.current && currentScope.current === streamScope && sendController.current === controller;
    const savePhoto = async (photo: DraftPhoto) => {
      if (!active() || controller.signal.aborted) throw new Error("照片发送已中断，草稿已保留。");
      await updateDraft((current) => ({ ...current, photos: current.photos?.map((item) => item.id === photo.id ? photo : item) }));
    };
    let received = false;
    let payload: MessageInput | undefined;
    setBusy(true); setError("");
    try {
      if (!source.pending && source.photos?.length) {
        await updateDraft(source);
        for (const [index, selected] of source.photos.entries()) {
          if (!active()) return;
          const photo = draftRef.current.photos?.find((item) => item.id === selected.id);
          if (!photo || photo.resource) continue;
          setSendingPhoto({ id: photo.id, index: index + 1, total: source.photos.length });
          let timedOut = false;
          const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 120000);
          try { await sendDraftPhoto(connection, conversation.id, photo, savePhoto, controller.signal); }
          catch (e) {
            if (!active()) return;
            const message = timedOut ? "照片发送超时，请重试发送。" : humanError(e);
            await updateDraft((current) => ({ ...current, photos: current.photos?.map((item) => item.id === photo.id ? { ...item, error: message } : item) }));
            throw new Error(message);
          } finally { clearTimeout(timeout); }
        }
        if (!active()) return;
        source = draftRef.current;
      }
      payload = prepareMessage(source, source.delivery?.intent ?? (currentRunning ? defaultIntent : "queue"),
        kind, source.delivery?.target_run_id ?? target, currentRunning?.id ?? null, Crypto.randomUUID);
      if (!source.pending && payload.intent === "queue") payload = { ...payload, ...options };
      // The sole Send action transfers photos, then persists one immutable message.
      await updateDraft({ ...source, pending: payload });
      if (!active()) return;
      const receipt = await request<{ message: Message; run: Run }>(connection,
        `/conversations/${conversation.id}/messages`, { method: "POST", body: payload, signal: controller.signal });
      received = true;
      acknowledged.current.add(payload.id);
      await settleDraft(payload.id);
      if (!active()) return;
      setMessages((old) => mergeById(old, [receipt.message]).sort((a, b) => a.seq - b.seq));
      setRuns((old) => mergeById(old, [receipt.run]));
      nearBottomRef.current = true;
      refresh.current(); onRefresh();
    } catch (e) {
      if (active() && (received || !payload || !acknowledged.current.has(payload.id))) setError(humanError(e));
    } finally {
      if (sendController.current === controller) {
        sending.current = false; sendController.current = null;
        if (alive.current && currentScope.current === streamScope) { setBusy(false); setSendingPhoto(null); }
      }
    }
  }

  async function cancel(run: Run) {
    try {
      await request(connection, `/runs/${run.id}/cancel`, { method: "POST" });
      if (alive.current) {
        refresh.current();
        onRefresh();
      }
    } catch (e) {
      if (alive.current) setError(humanError(e));
      throw e;
    }
  }
  async function resume() {
    try {
      await request(connection, `/conversations/${conversation.id}/resume`, {
        method: "POST",
      });
      if (alive.current) {
        refresh.current();
        onRefresh();
      }
    } catch (e) {
      if (alive.current) setError(humanError(e));
    }
  }
  function abandonPending() {
    Alert.alert(
      "编辑这条草稿？",
      "如果上次提交已被服务器接收，它仍可能执行。请先检查消息与任务记录；编辑后再次发送会创建新请求。",
      [
        { text: "保留重试", style: "cancel" },
        {
          text: "确认并编辑",
          onPress: () => {
            void updateDraft({ ...draft, pending: null }).catch((e) =>
              setError(humanError(e)),
            );
            setIntent("queue");
            setTarget(null);
          },
        },
      ],
    );
  }
  async function attach(resource: Resource) {
    if (draftRef.current.pending)
      throw new Error("先处理待确认消息，再添加文件。");
    const attachments = mergeById(draftRef.current.attachments ?? [], [resource]);
    if (new Set([...attachments.map((item) => item.id), ...(draftRef.current.photos ?? []).map((item) => item.id)]).size > 8) throw new Error("每条消息最多 8 份附件。");
    await updateDraft({ ...draftRef.current, attachments, pending: null });
  }
  async function removeAttachment(id: string) {
    if (draftRef.current.pending) return;
    await updateDraft({ ...draftRef.current, attachments: draftRef.current.attachments?.filter((item) => item.id !== id) });
  }
  async function addPhotos(photos: DraftPhoto[]) {
    if (draftRef.current.pending || sending.current || !draftReady) throw new Error("请先等待当前消息发送完成。");
    const next = mergeById(draftRef.current.photos ?? [], photos);
    if (new Set([...(draftRef.current.attachments ?? []).map((item) => item.id), ...next.map((item) => item.id)]).size > 8)
      throw new Error("每条消息最多 8 份附件。");
    await updateDraft((current) => ({ ...current, photos: next }));
  }
  async function removePhoto(id: string) {
    if (draftRef.current.pending || sending.current) return;
    const removed = draftRef.current.photos?.filter((photo) => photo.id === id) ?? [];
    await updateDraft((current) => ({ ...current, photos: current.photos?.filter((photo) => photo.id !== id) }));
    discardDraftPhotos(removed);
  }
  async function speak(message: Message) {
    await Speech.stop();
    if (speaking === message.id) {
      setSpeaking(null);
      return;
    }
    setSpeaking(message.id);
    const chunks =
      message.content.match(
        new RegExp(
          `[\\s\\S]{1,${Math.min(Speech.maxSpeechInputLength, 3500)}}`,
          "g",
        ),
      ) ?? [];
    chunks.forEach((chunk, index) =>
      Speech.speak(chunk, {
        language: "zh-CN",
        onDone:
          index === chunks.length - 1 ? () => setSpeaking(null) : undefined,
        onError: () => {
          setSpeaking(null);
          setError("朗读失败，请检查系统是否安装中文语音。");
        },
      }),
    );
  }
  const pendingRuns = scopedRuns.filter(
    (run) => run.status === "queued" || run.status === "running",
  );

  return {
    messages: runScope === streamScope ? messages : [],
    runs: runScope === streamScope ? runs : [],
    running: currentRunning,
    liveRun: liveRunView(trackedRun, liveEvents?.scope === streamScope ? liveEvents.buffer : null, messages),
    previous,
    draft,
    draftReady,
    draftLoadError,
    retryDraft: () => { setDraftReady(false); setDraftLoadError(""); setDraftRevision((old) => old + 1); },
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
    addPhotos,
    removePhoto,
    sendingPhoto,
    speak,
    pendingRuns,
    updateDraft,
  };
}
