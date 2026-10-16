import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { ApiError, request, type Connection, type Page, type Run, type RunEvent } from "./api";
import { hydrateLiveRun, mergeLiveRunEvents, newLiveRun, liveRunFinished } from "./liveRun";
import { DisplayStreamUnavailable, readDisplayStream } from "./replyTransport";
import type { ReplyProcess, ReplyRecord } from "./replyProcess";

export function useReplyProcesses(connection: Connection, conversationId: string, runIds: string[], runs: Run[], onDone: () => void) {
  const scope = `${connection.url}\n${connection.token}\n${conversationId}`;
  const cache = useRef<{ scope: string; records: Record<string, ReplyRecord> }>({ scope, records: {} });
  const [state, setState] = useState<{ scope: string; records: Record<string, ReplyRecord> }>({ scope, records: {} });
  const doneRef = useRef(onDone); useEffect(() => { doneRef.current = onDone; }, [onDone]);
  const idsKey = [...new Set(runIds)].sort().join(",");
  const activeKey = runs.filter((run) => run.status === "running" || run.status === "queued").map((run) => `${run.id}:${run.status}:${run.phase}`).sort().join(",");
  const runsRef = useRef(runs); useEffect(() => { runsRef.current = runs; }, [runs]);
  useEffect(() => {
    if (cache.current.scope !== scope) cache.current = { scope, records: {} };
    let active = true, generation = 0;
    let controllers: AbortController[] = [], publishTimer: ReturnType<typeof setTimeout> | undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const valid = (epoch: number) => active && generation === epoch && AppState.currentState === "active";
    const publish = () => { if (publishTimer || !active) return; publishTimer = setTimeout(() => {
      publishTimer = undefined; if (active) setState({ scope, records: { ...cache.current.records } });
    }, 48); };
    const schedule = (fn: () => void, delay: number) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, delay); timers.add(timer); };
    async function hydrate(ids: string[], controller: AbortController, epoch: number) {
      for (let offset = 0; offset < ids.length; offset += 50) {
        const query = ids.slice(offset, offset + 50).map((id) => `run_ids=${encodeURIComponent(id)}`).join("&");
        const result = await request<{ items: ReplyProcess[] }>(connection, `/conversations/${conversationId}/reply-processes?${query}`, { signal: controller.signal });
        if (!valid(epoch) || controller.signal.aborted) return;
        for (const process of result.items) {
          const old = cache.current.records[process.run_id];
          if (!old || old.buffer.cursor <= process.cursor) cache.current.records[process.run_id] = {
            buffer: { ...hydrateLiveRun(process), phase: process.phase !== "normal" ? process.phase : process.status },
            status: process.status, finalPartId: process.final_part_id, finalProjection: !["running", "queued"].includes(process.status),
          };
        }
        publish();
      }
    }
    async function track(id: string, epoch: number, legacy = false) {
      if (!valid(epoch)) return;
      const controller = new AbortController(); controllers.push(controller);
      let sseUnavailable = legacy;
      const read = () => cache.current.records[id] ?? { buffer: newLiveRun(id), status: "running" as const, finalPartId: null };
      const write = (record: ReplyRecord) => { if (valid(epoch) && !controller.signal.aborted) { cache.current.records[id] = record; publish(); } };
      try {
        if (!legacy) {
          await readDisplayStream(connection, id, read().buffer.cursor, controller.signal, (event) => {
            if (!valid(epoch)) return;
            const old = read();
            if ("done" in event) {
              write({ ...old, status: event.status as Run["status"], buffer: { ...old.buffer, cursor: Math.max(old.buffer.cursor, event.cursor), phase: event.status, connectionIssue: false } });
              doneRef.current();
            } else if ("cursor" in event) write({ ...old, buffer: { ...old.buffer, cursor: Math.max(old.buffer.cursor, event.cursor), connectionIssue: false } });
            else {
              const buffer = mergeLiveRunEvents(old.buffer, [event]);
              write({ ...old, buffer, ...(liveRunFinished(buffer) ? { status: buffer.phase as Run["status"] } : {}) });
            }
          });
          if (valid(epoch)) await hydrate([id], controller, epoch);
          return;
        }
      } catch (error) {
        if (!valid(epoch) || controller.signal.aborted) return;
        sseUnavailable = error instanceof DisplayStreamUnavailable;
        write({ ...read(), buffer: { ...read().buffer, connectionIssue: !sseUnavailable } });
      } finally { controllers = controllers.filter((item) => item !== controller); }
      if (!valid(epoch)) return;
      const pollController = new AbortController(); controllers.push(pollController);
      try {
        let more = true;
        while (more && valid(epoch)) {
          const page = await request<Page<RunEvent>>(connection, `/runs/${id}/events?after=${read().buffer.cursor}&limit=100`, { signal: pollController.signal });
          if (!valid(epoch) || pollController.signal.aborted) return;
          const old = read(), buffer = mergeLiveRunEvents(old.buffer, page.items);
          cache.current.records[id] = { ...old, buffer, ...(liveRunFinished(buffer) ? { status: buffer.phase as Run["status"] } : {}) }; publish();
          more = !!page.next_cursor && buffer.cursor > old.buffer.cursor;
        }
        if (liveRunFinished(read().buffer)) {
          if (!sseUnavailable) await hydrate([id], pollController, epoch);
          doneRef.current(); return;
        }
      } catch { if (valid(epoch)) { cache.current.records[id] = { ...read(), buffer: { ...read().buffer, connectionIssue: true } }; publish(); } }
      finally { controllers = controllers.filter((item) => item !== pollController); }
      if (valid(epoch)) schedule(() => { void track(id, epoch, sseUnavailable); }, sseUnavailable ? 400 : 1800);
    }
    async function start() {
      if (AppState.currentState !== "active") return;
      const epoch = ++generation;
      const ids = idsKey ? idsKey.split(",") : [];
      const retained = new Set(ids);
      for (const id of Object.keys(cache.current.records)) if (!retained.has(id)) delete cache.current.records[id];
      publish();
      const needed = ids.filter((id) => !cache.current.records[id]?.finalProjection || runsRef.current.some((run) => run.id === id && (run.status === "running" || run.status === "queued")));
      let legacy = false;
      const controller = new AbortController(); controllers.push(controller);
      try {
        await hydrate(needed, controller, epoch);
      } catch (error) {
        if (!valid(epoch) || controller.signal.aborted) return;
        legacy = error instanceof ApiError && [404, 405, 501].includes(error.status);
        if (!legacy) {
          for (const id of needed) {
            const old = cache.current.records[id];
            cache.current.records[id] = { ...(old ?? { buffer: newLiveRun(id), status: runsRef.current.find((run) => run.id === id)?.status ?? "running", finalPartId: null }),
              buffer: { ...(old?.buffer ?? newLiveRun(id)), connectionIssue: true } };
          }
          publish(); schedule(() => { void start(); }, 5000); return;
        }
      }
      finally { controllers = controllers.filter((item) => item !== controller); }
      if (!valid(epoch)) return;
      for (const id of ids) {
        const run = runsRef.current.find((item) => item.id === id);
        const unstartedQueue = run?.status === "queued" && !run.started_at && (!run.phase || run.phase === "normal");
        if (!unstartedQueue && (legacy || !cache.current.records[id]?.finalProjection || run?.status === "running" || run?.status === "queued")) void track(id, epoch, legacy);
      }
    }
    const stop = () => { generation++; controllers.forEach((item) => item.abort()); controllers = []; timers.forEach(clearTimeout); timers.clear(); };
    void start();
    const listener = AppState.addEventListener("change", (value) => { stop(); if (value === "active") void start(); });
    return () => { active = false; stop(); clearTimeout(publishTimer); listener.remove(); };
  }, [connection, conversationId, scope, idsKey, activeKey]);
  return state.scope === scope ? state.records : {};
}
