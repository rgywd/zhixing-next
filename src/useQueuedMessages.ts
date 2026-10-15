import { useEffect, useRef, useState } from "react";
import { ApiError, request, type Connection, type Resource, type Run } from "./api";
import { humanError } from "./ui";

export type QueuedMessageItem = { run: Run; text: string; attachments: Resource[] };
export function getQueuedMessages(runs: Run[], conversationId: string): QueuedMessageItem[] {
  return runs.filter((run) => run.conversation_id === conversationId && run.kind === "chat"
    && run.status === "queued" && (run.phase ?? "normal") === "normal" && run.started_at === null
    && !run.cancel_requested && typeof run.message_id === "string")
    .sort((a, b) => (a.seq != null && b.seq != null ? a.seq - b.seq : a.created_at.localeCompare(b.created_at)))
    .map((run) => ({ run, text: run.prompt, attachments: run.attachments ?? [] }));
}

type Attempt = { sourceId: string; action: "withdraw" | "steer"; targetId: string | null };
type Session = { scope: string; active: boolean; controller: AbortController | null; attempts: Map<string, Attempt> };
type State = { scope: string; busyId: string | null; error: string; confirmed: string[] };
const emptyState = (scope: string): State => ({ scope, busyId: null, error: "", confirmed: [] });

export function useQueuedMessages({ connection, conversationId, runs, running, onChanged, onError }: {
  connection: Connection; conversationId: string; runs: Run[]; running?: Run | null;
  onChanged: () => void; onError?: (message: string) => void;
}) {
  const scope = JSON.stringify([connection.url, connection.token, conversationId]);
  const session = useRef<Session | null>(null);
  const [state, setState] = useState<State>(() => emptyState(scope));
  const current = state.scope === scope ? state : emptyState(scope);
  useEffect(() => {
    const value: Session = { scope, active: true, controller: null, attempts: new Map() };
    session.current = value;
    return () => { value.active = false; value.controller?.abort(); };
  }, [scope]);

  async function perform(item: QueuedMessageItem, action: Attempt["action"]) {
    const value = session.current;
    if (!value?.active || value.scope !== scope || value.controller) return;
    if (item.run.conversation_id !== conversationId) return;
    const prior = value.attempts.get(item.run.id);
    // A transport failure may have committed. Retry the identical target, never
    // silently promote the same queued message into a later reply.
    const attempt = prior?.action === action ? prior : { sourceId: item.run.id, action,
      targetId: action === "steer" && running?.status === "running" && running.conversation_id === conversationId && !running.cancel_requested ? running.id : null };
    if (action === "steer" && !attempt.targetId) return;
    value.attempts.set(item.run.id, attempt);
    const controller = new AbortController(); value.controller = controller;
    const valid = () => value.active && session.current === value && !controller.signal.aborted;
    setState((old) => ({ ...(old.scope === scope ? old : emptyState(scope)), busyId: item.run.id, error: "" }));
    try {
      await request(connection, `/runs/${encodeURIComponent(attempt.sourceId)}/queued/${attempt.action}`, {
        method: "POST", ...(action === "steer" ? { body: { target_run_id: attempt.targetId } } : {}), signal: controller.signal,
      });
      if (!valid()) return;
      value.attempts.delete(item.run.id);
      setState((old) => ({ ...(old.scope === scope ? old : emptyState(scope)), busyId: null, error: "",
        confirmed: [...new Set([...(old.scope === scope ? old.confirmed : []), item.run.id])] }));
      onChanged();
    } catch (cause) {
      if (!valid()) return;
      if (cause instanceof ApiError) value.attempts.delete(item.run.id);
      const error = cause instanceof ApiError && cause.code === "stale_queue"
        ? "这条消息已开始处理或已移出队列，操作未执行，请查看最新状态。"
        : cause instanceof ApiError && cause.code === "stale_steer" ? "刚才的回复已结束或正在停止，这条消息仍按队列处理。"
        : cause instanceof ApiError && cause.status === 404 ? "当前服务尚不支持队列操作，请更新服务后重试。" : humanError(cause);
      setState((old) => ({ ...(old.scope === scope ? old : emptyState(scope)), busyId: null, error }));
      onError?.(error);
      onChanged();
      throw cause;
    } finally {
      if (value.controller === controller) value.controller = null;
    }
  }

  return {
    items: getQueuedMessages(runs, conversationId).filter((item) => !current.confirmed.includes(item.run.id)),
    busyId: current.busyId, error: current.error,
    withdraw: (item: QueuedMessageItem) => perform(item, "withdraw"),
    steer: (item: QueuedMessageItem) => perform(item, "steer"),
  };
}
