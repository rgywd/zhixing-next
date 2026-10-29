import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { mergeById, request, type Agent, type Assistant, type Connection, type Conversation, type ModelCatalog, type Page, type ServiceStatus } from "./api";
import { useSyncStatus } from "./ConnectionStatus";
import { readCache, writeCache } from "./localCache";

/** Restore the app's reading surface before synchronizing each server section independently. */
export function useSessionData(connection: Connection) {
  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [runtime, setRuntime] = useState<ServiceStatus["runtime"]>();
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [lastSyncFailed, setLastSyncFailed] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [cacheReady, setCacheReady] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef(selectedId);
  const [conversationCursor, setConversationCursor] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const refreshRef = useRef<() => void>(() => undefined);
  const alive = useRef(true);
  const refresh = useCallback(() => refreshRef.current(), []);
  const reportSync = useSyncStatus(refresh);
  const snapshot = JSON.stringify({ runtime, assistant, conversations, agents, catalog, conversationCursor });
  useEffect(() => {
    if (!cacheReady) return;
    void writeCache(connection, "app", JSON.parse(snapshot)).catch(() => undefined);
  }, [connection, cacheReady, snapshot]);
  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    let polling = false;
    let initial = true;
    let hydrated = false;
    alive.current = true;
    const controller = new AbortController();
    async function poll() {
      if (!active || !hydrated || polling || AppState.currentState === "background") return;
      polling = true;
      try {
        const results = await Promise.allSettled([
          request<ServiceStatus>(connection, "/status", { signal: controller.signal }),
          request<Assistant>(connection, "/assistant", { signal: controller.signal }),
          request<Page<Conversation>>(connection, "/conversations?latest=true&limit=100", { signal: controller.signal }),
          request<Page<Agent>>(connection, "/agents", { signal: controller.signal }),
          request<ModelCatalog>(connection, "/models", { signal: controller.signal }),
          selectedRef.current ? request<Conversation>(connection, `/conversations/${selectedRef.current}`, { signal: controller.signal }) : Promise.resolve(null),
          request<Page<Conversation>>(connection, "/conversations/recent?limit=10", { signal: controller.signal }),
        ]);
        if (!active) return;
        const [health, person, chats, agentPage, modelPage, current, recentChats] = results;
        if (health.status === "fulfilled" && health.value.runtime !== "dsh") throw new Error("当前连接尚未切换到 DSH，请检查服务连接。");
        const failure = results.find((result) => result.status === "rejected");
        if (health.status === "fulfilled") { setStatus(health.value); setRuntime(health.value.runtime); }
        setLastSyncFailed(!!failure);
        if (person.status === "fulfilled") setAssistant(person.value);
        setConversations((old) =>
          mergeById(old, [
            ...(chats.status === "fulfilled" ? chats.value.items : []),
            ...(recentChats.status === "fulfilled" ? recentChats.value.items : []),
            ...(current.status === "fulfilled" && current.value ? [current.value] : []),
          ]),
        );
        if (agentPage.status === "fulfilled") setAgents(agentPage.value.items);
        if (modelPage.status === "fulfilled") setCatalog(modelPage.value);
        if (initial && chats.status === "fulfilled") {
          setConversationCursor(chats.value.previous_cursor ?? null);
          initial = false;
        }
        if (chats.status === "fulfilled") setSelectedId(
          (old) => old ?? [...chats.value.items].reverse().find((item) => !item.agent_id)?.id ?? null,
        );
        reportSync(failure?.status === "rejected" ? failure.reason : undefined);
      } catch (e) {
        if (active) {
          setLastSyncFailed(true);
          reportSync(e);
        }
      } finally {
        polling = false;
        if (active) setLoading(false);
      }
    }
    refreshRef.current = () => {
      void poll();
    };
    void readCache<{ runtime?: ServiceStatus["runtime"]; assistant: Assistant | null; conversations: Conversation[]; agents: Agent[]; catalog: ModelCatalog | null;
      conversationCursor: string | null }>(connection, "app").then((cached) => {
      if (!active) return;
      if (cached && Array.isArray(cached.conversations) && Array.isArray(cached.agents) && cached.runtime === "dsh") {
        setRuntime(cached.runtime);
        setAssistant(cached.assistant); setConversations(cached.conversations); setAgents(cached.agents);
        setCatalog(cached.catalog); setConversationCursor(cached.conversationCursor);
        setSelectedId((old) => old ?? [...cached.conversations].reverse().find((item) => !item.agent_id)?.id ?? null);
        setLoading(false);
      }
      hydrated = true; setCacheReady(true);
      void poll();
    });
    const timer = setInterval(() => {
      void poll();
    }, 5000);
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void poll();
    });
    return () => {
      active = false;
      alive.current = false;
      clearInterval(timer);
      controller.abort();
      listener.remove();
    };
  }, [connection, reportSync]);

  return { assistant, setAssistant, status, runtime, lastSyncFailed, conversations, setConversations, agents, catalog, setCatalog,
    selectedId, setSelectedId, selectedRef, conversationCursor, setConversationCursor, loading, refresh, alive };
}
