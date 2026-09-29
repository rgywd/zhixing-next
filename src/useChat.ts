import { useEffect, useRef, useState } from "react";
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
} from "./api";
import {
  clearDraft,
  draftKey,
  readDraft,
  saveDraft,
  type Draft,
} from "./storage";
import { humanError } from "./ui";

export function useChat({
  connection,
  conversation,
  onRefresh,
  initialKind = "chat",
  startWithFiles = false,
}: {
  connection: Connection;
  conversation: Conversation;
  onRefresh: () => void;
  initialKind?: "chat" | "task";
  startWithFiles?: boolean;
}) {
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
  const [intent, setIntent] = useState<"queue" | "steer">("queue");
  const [kind, setKind] = useState<"chat" | "task">(initialKind);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(startWithFiles);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const alive = useRef(true);
  const list = useRef<FlatList<Message>>(null);
  const nearBottomRef = useRef(true);
  const key = draftKey(connection.url, conversation.id);
  const refresh = useRef<() => void>(() => undefined);

  useEffect(() => {
    alive.current = true;
    readDraft(key)
      .then((value) => {
        if (alive.current) {
          setDraft(value);
          draftRef.current = value;
          setDraftReady(true);
          if (value.pending) {
            setKind(value.pending.kind);
            setIntent(value.pending.intent);
            setTarget(value.pending.target_run_id ?? null);
          }
        }
      })
      .catch((e) => {
        if (alive.current) setError(humanError(e));
      });
    return () => {
      alive.current = false;
      void Speech.stop();
    };
  }, [key]);

  function updateDraft(value: Draft) {
    draftRef.current = value;
    setDraft(value);
    return saveDraft(key, value);
  }

  useEffect(() => {
    let active = true;
    let polling = false;
    let initial = true;
    let lastSeq = 0;
    let catchUpTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function poll() {
      if (!active || polling || AppState.currentState === "background") return;
      polling = true;
      let hasMore = false;
      try {
        const [history, tasks, activeRuns, receipts] = await Promise.all([
          request<Page<Message>>(
            connection,
            `/conversations/${conversation.id}/messages?${initial ? "latest=true" : `cursor=${lastSeq}`}&limit=100`,
            { signal: controller.signal },
          ),
          request<Page<Run>>(
            connection,
            `/runs?conversation_id=${conversation.id}&latest=true&limit=100`,
            { signal: controller.signal },
          ),
          request<Page<Run>>(
            connection,
            `/runs?conversation_id=${conversation.id}&status=running&limit=1`,
            { signal: controller.signal },
          ),
          pendingStatusRef.current === null
            ? Promise.resolve(null)
            : request<Page<Message>>(
                connection,
                `/conversations/${conversation.id}/messages?cursor=${pendingStatusRef.current - 1}&limit=100`,
                { signal: controller.signal },
              ),
        ]);
        if (!active) return;
        setMessages((old) => {
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
        setRunning(
          activeRuns.items.find((run) => run.status === "running") ?? null,
        );
        if (initial) {
          setPrevious(history.previous_cursor ?? null);
          initial = false;
        }
        setSyncError("");
      } catch (e) {
        if (active) setSyncError(humanError(e));
      } finally {
        polling = false;
        if (active) setLoading(false);
        if (active && hasMore)
          catchUpTimer = setTimeout(() => {
            void poll();
          }, 100);
      }
    }
    refresh.current = () => {
      void poll();
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 2500);
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void poll();
    });
    return () => {
      active = false;
      clearInterval(timer);
      clearTimeout(catchUpTimer);
      controller.abort();
      listener.remove();
    };
  }, [connection, conversation.id]);

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
    if (busy || !draftReady || (!draft.text.trim() && !draft.attachments?.length)) return;
    let payload: MessageInput;
    try {
      payload = prepareMessage(
        draft,
        intent,
        kind,
        target,
        running?.id ?? null,
        Crypto.randomUUID,
      );
      if (!draft.pending && intent === "queue") payload = { ...payload, ...options };
    } catch (e) {
      setError(humanError(e));
      return;
    }
    setBusy(true);
    setError("");
    try {
      // Persist the immutable request before any network I/O; retries after app restart reuse it.
      await updateDraft({ ...draft, pending: payload });
      const receipt = await request<{ message: Message; run: Run }>(
        connection,
        `/conversations/${conversation.id}/messages`,
        { method: "POST", body: payload },
      );
      await clearDraft(key, payload.id);
      if (!alive.current) return;
      draftRef.current = { text: "", pending: null };
      setDraft(draftRef.current);
      setMessages((old) =>
        mergeById(old, [receipt.message]).sort((a, b) => a.seq - b.seq),
      );
      setRuns((old) => mergeById(old, [receipt.run]));
      setIntent("queue");
      setTarget(null);
      nearBottomRef.current = true;
      refresh.current();
      onRefresh();
    } catch (e) {
      if (alive.current) setError(humanError(e));
    } finally {
      if (alive.current) setBusy(false);
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
    if (attachments.length > 8) throw new Error("每条消息最多 8 份资料。");
    await updateDraft({ ...draftRef.current, attachments, pending: null });
  }
  async function removeAttachment(id: string) {
    if (draftRef.current.pending) return;
    await updateDraft({ ...draftRef.current, attachments: draftRef.current.attachments?.filter((item) => item.id !== id) });
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
  const pendingRuns = runs.filter(
    (run) => run.status === "queued" || run.status === "running",
  );

  return {
    messages,
    runs,
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
  };
}
