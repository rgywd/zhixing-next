import type { Message, Run, RunEvent } from "./api";

export type LiveTool = { id: string; name: string; status: "started" | "completed" | "failed" };
type ReplyPartBase = { id: string; seq?: number; stream_id?: string; message_id?: string; truncated?: boolean; attempt_status?: "completed" | "failed" };
export type ReplyPart = ReplyPartBase & ({ type: "text"; text: string } | { type: "reasoning"; text: string }
  | { type: "tool"; name: string; status: LiveTool["status"]; tool_call_id?: string;
      detail?: { input?: unknown; output?: unknown; meta?: unknown; error?: unknown; startedAt?: number; finishedAt?: number } });
type Segment = { id: string; content: string; reasoning: string };
export type LiveRunBuffer = {
  runId: string; cursor: number; streamId: string | null; segments: Segment[];
  tools: LiveTool[]; parts: ReplyPart[]; attempts: Record<string, "completed" | "failed">;
  truncated: boolean; phase: string; connectionIssue: boolean;
};
export type LiveRunState = {
  run: Run; content: string; reasoning: string; tools: LiveTool[];
  parts: ReplyPart[]; finalPartId: string | null; truncated: boolean;
  phase: string; active: boolean; connectionIssue: boolean; answerCommitted: boolean;
};
export const newLiveRun = (runId: string): LiveRunBuffer => ({ runId, cursor: 0, streamId: null,
  segments: [], tools: [], parts: [], attempts: {}, truncated: false, phase: "waiting", connectionIssue: false });
const identifier = (value: unknown) => typeof value === "string" && /^[\w.:-]{1,180}$/.test(value) ? value : null;
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
export const liveRunFinished = (value: LiveRunBuffer) => terminal.has(value.phase);

/** Rehydrate a bounded server projection without storing private event payloads. */
export function hydrateLiveRun(process: { run_id: string; cursor: number; stream_id?: string | null;
  status: string; parts: ReplyPart[]; truncated?: boolean }): LiveRunBuffer {
  const value = newLiveRun(process.run_id);
  value.cursor = process.cursor; value.streamId = process.stream_id ?? null; value.phase = process.status;
  value.truncated = !!process.truncated;
  value.parts = process.parts.map((part) => ({ ...part }));
  for (const part of value.parts) {
    if (part.type === "tool") value.tools.push({ id: part.tool_call_id ?? part.id.replace(/^tool:/, ""), name: part.name, status: part.status });
    else {
      const id = part.message_id ?? part.id;
      let segment = value.segments.find((item) => item.id === id);
      if (!segment) { segment = { id, content: "", reasoning: "" }; value.segments.push(segment); }
      if (part.type === "text") segment.content = part.text; else segment.reasoning = part.text;
      if (part.attempt_status && part.stream_id && part.message_id) value.attempts[`${part.stream_id}:${part.message_id}`] = part.attempt_status;
    }
  }
  return value;
}

/** Keep only public display fields. Never retain raw tool arguments, results or provider metadata. */
export function mergeLiveRunEvents(previous: LiveRunBuffer, events: RunEvent[]): LiveRunBuffer {
  let value = { ...previous, segments: previous.segments.map((item) => ({ ...item })), tools: previous.tools.map((item) => ({ ...item })),
    parts: previous.parts.map((part) => ({ ...part })), attempts: { ...previous.attempts }, connectionIssue: false };
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= value.cursor || (event.run_id && event.run_id !== value.runId)) continue;
    value.cursor = event.seq;
    const data = event.data;
    if (!data || typeof data !== "object") continue;
    if (event.type === "assistant.reset") {
      const stream = identifier(data.stream_id);
      if (stream) value = { ...value, streamId: stream, segments: [], parts: value.parts.filter((part) => part.type === "tool"), attempts: {}, phase: "model" };
    } else if (event.type === "assistant.snapshot" || event.type === "reasoning.snapshot") {
      const stream = identifier(data.stream_id), id = identifier(data.message_id);
      if (!stream || !id || stream !== value.streamId || typeof data.text !== "string" || data.text.length > 65536) continue;
      let segment = value.segments.find((item) => item.id === id);
      if (!segment) { segment = { id, content: "", reasoning: "" }; value.segments.push(segment); }
      if (event.type === "assistant.snapshot") segment.content = data.text;
      else segment.reasoning = data.text;
      const type = event.type === "assistant.snapshot" ? "text" : "reasoning", key = `${stream}:${id}:${type}`;
      const old = value.parts.find((part) => part.id === key);
      const part: ReplyPart = { id: key, type, seq: old?.seq ?? event.seq, stream_id: stream, message_id: id,
        text: data.text, ...(data.truncated || old?.truncated ? { truncated: true } : {}),
        ...(value.attempts[`${stream}:${id}`] ? { attempt_status: value.attempts[`${stream}:${id}`] } : {}) };
      if (old) value.parts[value.parts.indexOf(old)] = part; else value.parts.push(part);
      if (data.truncated) value.truncated = true;
      value.phase = "model";
    } else if (event.type === "assistant.attempt") {
      const stream = identifier(data.stream_id), id = identifier(data.message_id);
      if (!stream || !id || stream !== value.streamId || !["completed", "failed"].includes(String(data.status))) continue;
      const status = data.status as "completed" | "failed";
      value.attempts[`${stream}:${id}`] = status;
      value.parts = value.parts.map((part) => part.stream_id === stream && part.message_id === id ? { ...part, attempt_status: status } : part);
    } else if (event.type === "assistant.truncated") {
      if (identifier(data.stream_id) === value.streamId) value.truncated = true;
    } else if (event.type === "tool") {
      const name = identifier(data.tool ?? data.name);
      if (!name || !["started", "completed", "failed"].includes(String(data.status))) continue;
      const id = identifier(data.tool_call_id) ?? value.tools.findLast((item) => item.name === name && item.status === "started")?.id ?? `tool:${event.seq}`;
      const tool = { id, name, status: data.status as LiveTool["status"] };
      const index = value.tools.findIndex((item) => item.id === id);
      if (index < 0) value.tools.push(tool); else value.tools[index] = tool;
      const key = `tool:${id}`, old = value.parts.find((part) => part.id === key);
      const part: ReplyPart = { id: key, type: "tool", seq: old?.seq ?? event.seq, tool_call_id: id, name, status: tool.status };
      if (old) value.parts[value.parts.indexOf(old)] = part; else value.parts.push(part);
      value.phase = tool.status === "started" ? "tool" : "model";
    } else if (terminal.has(event.type)) value.phase = event.type;
    else if (event.type === "paused") value.phase = data.reason === "input" ? "input" : "approval";
    else if (event.type === "input_required") value.phase = "input";
    else if (event.type === "recovering") value.phase = "recovering";
    else if (event.type === "started" || (event.type === "progress" && data.stage === "model")) value.phase = "model";
  }
  return value;
}

export function liveRunView(run: Run | null, buffer: LiveRunBuffer | null, messages: Message[]): LiveRunState | null {
  if (!run) return null;
  const value = buffer?.runId === run.id ? buffer : newLiveRun(run.id);
  const answerCommitted = messages.some((message) => message.role === "assistant" && message.run_id === run.id);
  const active = run.status === "running" || run.status === "queued";
  const content = answerCommitted ? "" : run.status === "completed" && run.result != null ? run.result
    : [...value.segments].reverse().find((item) => item.content)?.content ?? "";
  const reasoning = value.segments.map((item) => item.reasoning).filter(Boolean).join("\n\n");
  if (!active && !content && !reasoning && !value.tools.length) return null;
  const lastText = value.parts.findLast((part) => part.type === "text" && part.attempt_status !== "failed");
  const finalPartId = lastText?.type === "text" && (run.status !== "completed" || run.result == null || run.result.startsWith(lastText.text)) ? lastText.id : null;
  return { run, content, reasoning, tools: value.tools, parts: value.parts, finalPartId,
    truncated: value.truncated, phase: run.phase && run.phase !== "normal" ? run.phase : value.phase,
    active, connectionIssue: value.connectionIssue, answerCommitted };
}
