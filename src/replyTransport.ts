import { fetch } from "expo/fetch";
import type { Connection, RunEvent } from "./api";

export type DisplayFrame = { event: string; id: string; data: string };
/** SSE frames may cross both UTF-8 and network chunk boundaries. */
export function displayFrameParser(accept: (frame: DisplayFrame) => void) {
  let pending = "", event = "message", id = "", data: string[] = [], frameLength = 0;
  return (chunk: string, end = false) => {
    pending += chunk;
    let match: RegExpExecArray | null;
    while ((match = /\r\n|\n|\r(?!$)/.exec(pending))) {
      const line = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length);
      frameLength += line.length;
      if (frameLength > 1_048_576) throw new Error("回复进度过长，请重新连接");
      if (!line) {
        if (data.length) accept({ event, id, data: data.join("\n") });
        event = "message"; id = ""; data = []; frameLength = 0;
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "id") id = value;
        else if (field === "data") data.push(value);
      }
    }
    if (pending.length + frameLength > 1_048_576) throw new Error("回复进度过长，请重新连接");
    if (end) { pending = ""; event = "message"; id = ""; data = []; frameLength = 0; }
  };
}
export class DisplayStreamUnavailable extends Error {}
export async function readDisplayStream(connection: Connection, runId: string, after: number, signal: AbortSignal,
  accept: (value: RunEvent | { cursor: number } | { done: true; status: string; cursor: number }) => void) {
  const controller = new AbortController();
  const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  let timer = setTimeout(abort, 15_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${connection.url.replace(/\/$/, "")}/v1/runs/${encodeURIComponent(runId)}/display-stream?after=${after}`, {
      headers: { Authorization: `Bearer ${connection.token}`, Accept: "text/event-stream" }, signal: controller.signal, redirect: "error",
    });
    if ([404, 405, 501].includes(response.status) || (response.ok && !response.body)) throw new DisplayStreamUnavailable();
    if (!response.ok) throw new Error(`回复进度连接失败（${response.status}）`);
    if (!response.headers.get("content-type")?.includes("text/event-stream")) throw new DisplayStreamUnavailable();
    reader = response.body!.getReader();
    const decoder = new TextDecoder(); let done = false;
    const parse = displayFrameParser((frame) => {
      const value: unknown = JSON.parse(frame.data);
      if (!value || typeof value !== "object") return;
      if (frame.event === "display" && "run_id" in value && value.run_id === runId && "seq" in value && Number.isSafeInteger(value.seq)) accept(value as RunEvent);
      else if (frame.event === "cursor" && "cursor" in value && Number.isSafeInteger(value.cursor)) accept({ cursor: value.cursor as number });
      else if (frame.event === "done" && "run_id" in value && value.run_id === runId && "cursor" in value && Number.isSafeInteger(value.cursor) && "status" in value && typeof value.status === "string" && ["completed", "failed", "cancelled", "interrupted"].includes(value.status)) {
        done = true; accept({ done: true, status: value.status, cursor: value.cursor as number });
      }
    });
    while (!signal.aborted && !done) {
      clearTimeout(timer); timer = setTimeout(abort, 35_000);
      const result = await reader.read();
      if (signal.aborted || controller.signal.aborted) break;
      if (result.done) { parse(decoder.decode(), true); break; }
      parse(decoder.decode(result.value, { stream: true }));
    }
    if (!done && !signal.aborted) throw new Error("回复进度连接中断");
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort();
    try { await reader?.cancel(); } catch { /* Already disconnected. */ }
  }
}
