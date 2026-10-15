import type { Message, Run, RunEvent } from "./api";

export type LiveTool = { id: string; name: string; status: "started" | "completed" | "failed" };
type Segment = { id: string; content: string; reasoning: string };
export type LiveRunBuffer = {
  runId: string; cursor: number; streamId: string | null; segments: Segment[];
  tools: LiveTool[]; phase: string; connectionIssue: boolean;
};
export type LiveRunState = {
  run: Run; content: string; reasoning: string; tools: LiveTool[];
  phase: string; active: boolean; connectionIssue: boolean; answerCommitted: boolean;
};
export const newLiveRun = (runId: string): LiveRunBuffer => ({ runId, cursor: 0, streamId: null,
  segments: [], tools: [], phase: "waiting", connectionIssue: false });
const identifier = (value: unknown) => typeof value === "string" && /^[\w.:-]{1,180}$/.test(value) ? value : null;
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
export const liveRunFinished = (value: LiveRunBuffer) => terminal.has(value.phase);

/** Keep only public display fields. Never retain raw tool arguments, results or provider metadata. */
export function mergeLiveRunEvents(previous: LiveRunBuffer, events: RunEvent[]): LiveRunBuffer {
  let value = { ...previous, segments: previous.segments.map((item) => ({ ...item })), tools: previous.tools.map((item) => ({ ...item })), connectionIssue: false };
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= value.cursor || (event.run_id && event.run_id !== value.runId)) continue;
    value.cursor = event.seq;
    const data = event.data;
    if (!data || typeof data !== "object") continue;
    if (event.type === "assistant.reset") {
      const stream = identifier(data.stream_id);
      if (stream) value = { ...value, streamId: stream, segments: [], phase: "model" };
    } else if (event.type === "assistant.snapshot" || event.type === "reasoning.snapshot") {
      const stream = identifier(data.stream_id), id = identifier(data.message_id);
      if (!stream || !id || stream !== value.streamId || typeof data.text !== "string" || data.text.length > 65536) continue;
      let segment = value.segments.find((item) => item.id === id);
      if (!segment) { segment = { id, content: "", reasoning: "" }; value.segments.push(segment); }
      if (event.type === "assistant.snapshot") segment.content = data.text;
      else segment.reasoning = data.text;
      value.phase = "model";
    } else if (event.type === "tool") {
      const name = identifier(data.tool ?? data.name);
      if (!name || !["started", "completed", "failed"].includes(String(data.status))) continue;
      const id = identifier(data.tool_call_id) ?? value.tools.findLast((item) => item.name === name && item.status === "started")?.id ?? `tool:${event.seq}`;
      const tool = { id, name, status: data.status as LiveTool["status"] };
      const index = value.tools.findIndex((item) => item.id === id);
      if (index < 0) value.tools.push(tool); else value.tools[index] = tool;
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
  return { run, content, reasoning, tools: value.tools, phase: run.phase && run.phase !== "normal" ? run.phase : value.phase,
    active, connectionIssue: value.connectionIssue, answerCommitted };
}
