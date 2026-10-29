import type { ReplyPart } from "./liveRun";

/** DSH owns these records. Keep opaque fields so new tools remain inspectable. */
export type DshEvent = { seq: number; time: number; type: string; data: Record<string, unknown> };
export type DshQuestion = { id: string; question: string; detail?: string; header?: string;
  options?: { label: string; description?: string }[]; multiSelect?: boolean; intent?: { kind: string } };
export type DshPending = { id: string; sessionId: string; kind: "approval" | "question";
  toolName?: string; reason?: string; questions?: DshQuestion[] };
export type DshSnapshot = { events: DshEvent[]; next: number; hasMore: boolean; running: boolean; active: boolean;
  queue: { id: string; placement?: "queued" | "steering" | "context"; content: unknown }[]; pending: DshPending[];
  live: { attemptId: string; turn: number; step: number; chunks: Record<string, unknown>[] } | null };

export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(value => {
    const part = record(value);
    if (part.type === "text") return String(part.text ?? "");
    if (part.type === "image" || part.type === "file") return `[${part.type === "image" ? "图片" : "文件"}：${part.name ?? record(part.attachment).name ?? "附件"}]`;
    return "";
  }).filter(Boolean).join("\n");
}
export function mergeDshEvents(previous: DshEvent[], incoming: DshEvent[]): DshEvent[] {
  if (!incoming.length) return previous;
  const bySeq = new Map(previous.map(event => [event.seq, event]));
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
export function liveText(snapshot: DshSnapshot | null): string {
  if (!snapshot?.live) return "";
  return snapshot.live.chunks.filter(c => c.type === "text-delta").map(c => String(c.text ?? "")).join("");
}

export type DshAttachment = { id: string; name: string; type: "image" | "file"; bytes: number };
export type DshChatRow = { id: string; role: "user" | "assistant"; parts: ReplyPart[]; attachments: DshAttachment[];
  events: DshEvent[]; active: boolean; status?: "completed" | "cancelled" | "failed" | "interrupted" };
export const rowText = (row: DshChatRow) => row.parts.flatMap(p => p.type === "text" && p.attempt_status !== "failed" ? [p.text] : []).join("\n\n");
export function contentAttachments(content: unknown): DshAttachment[] {
  return (Array.isArray(content) ? content : []).flatMap(value => {
    const block = record(value), attachment = record(block.attachment);
    return (block.type === "image" || block.type === "file") && typeof attachment.attachmentId === "string"
      ? [{ id: attachment.attachmentId, name: String(attachment.name ?? "图片"), type: block.type, bytes: Number(attachment.bytes ?? 0) }] : [];
  });
}

/** Presentation only: the complete native log stays intact for replay and details. */
export function chatRows(events: DshEvent[], snapshot: DshSnapshot | null): DshChatRow[] {
  const rows: DshChatRow[] = [];
  const turns = new Map<number, { events: DshEvent[]; row?: DshChatRow; segment: string; ended: boolean; steps: Set<number> }>();
  let turn = 0;
  const context = (number: number) => {
    let value = turns.get(number);
    if (!value) { value = { events: [], segment: "start", ended: false, steps: new Set() }; turns.set(number, value); }
    return value;
  };
  const assistant = (number: number) => {
    const value = context(number);
    if (!value.row) {
      value.row = { id: `turn:${number}:${value.segment}`, role: "assistant", parts: [], attachments: [], events: value.events, active: false };
      rows.push(value.row);
    }
    return value.row;
  };
  const contentParts = (content: unknown, id: string): ReplyPart[] => (Array.isArray(content) ? content : []).flatMap((value, index) => {
    const block = record(value);
    return block.type === "text" || block.type === "reasoning" ? [{ id: `${id}:${index}`, type: block.type, text: String(block.text ?? "") }] : [];
  });
  for (const event of events) {
    const data = event.data;
    if (typeof data.turn === "number" && (event.type === "turn/start" || turn === 0)) turn = data.turn;
    const eventTurn = typeof data.turn === "number" ? data.turn : turn;
    const current = context(eventTurn);
    current.events.push(event);
    if (event.type === "user/message" && record(data.source).kind === "user") {
      rows.push({ id: `user:${data.id ?? event.seq}`, role: "user", parts: contentParts(data.content, `user:${event.seq}`),
        attachments: contentAttachments(data.content), events: [event], active: false });
      current.row = undefined; current.segment = String(event.seq);
    } else if (event.type === "assistant/message" || event.type === "assistant/attempt") {
      const row = assistant(eventTurn), message = record(data.message);
      row.parts.push(...contentParts(message.content, `message:${event.seq}`).map(part => event.type === "assistant/attempt" ? { ...part, attempt_status: "failed" as const } : part));
      row.attachments.push(...contentAttachments(message.content));
      if (event.type === "assistant/message") current.steps.add(Number(data.step));
      if (data.interrupted) row.status = "interrupted";
    } else if (event.type === "tool/call") {
      assistant(eventTurn).parts.push({ id: `tool:${data.callId}`, type: "tool", name: String(data.name), tool_call_id: String(data.callId), status: "started" });
    } else if (event.type === "tool/result") {
      const message = record(data.message), callId = message.toolCallId ?? record(message.source).callId ?? data.callId;
      const part = rows.flatMap(row => row.parts).find(p => p.type === "tool" && p.tool_call_id === callId);
      if (part?.type === "tool") part.status = message.isError || data.error ? "failed" : "completed";
    } else if (event.type === "turn/end") {
      current.ended = true;
      const reason = record(data.reason).kind;
      assistant(eventTurn).status = reason === "completed" ? "completed" : reason === "aborted" ? "cancelled" : "failed";
    }
  }
  const live = snapshot?.live;
  if (live && !context(live.turn).ended && !context(live.turn).steps.has(live.step)) {
    const row = assistant(live.turn), blocks = new Map<number, { id: string; type: "text" | "reasoning"; text: string }>();
    for (const chunk of live.chunks) {
      if (chunk.type !== "text-delta" && chunk.type !== "reasoning-delta") continue;
      const index = Number(chunk.index ?? 0), type = chunk.type === "text-delta" ? "text" : "reasoning";
      let part = blocks.get(index);
      if (!part) { part = { id: `live:${live.attemptId}:${index}`, type, text: "" }; blocks.set(index, part); row.parts.push(part as ReplyPart); }
      part.text += String(chunk.text ?? "");
    }
  }
  const activeTurn = live?.turn ?? turn;
  if (snapshot?.running && !context(activeTurn).ended) assistant(activeTurn).active = true;
  return rows.filter(row => row.role === "user" || row.parts.length || row.attachments.length || row.status || row.active);
}
export function eventPresentation(event: DshEvent): { title: string; text: string; message?: "user" | "assistant"; quiet?: boolean } {
  const data = event.data;
  const message = record(data.message);
  if (event.type === "user/message") return record(data.source).kind === "user" || record(data.source).kind === "user-question-reply"
    ? { title: "你", text: contentText(data.content), message: "user" }
    : { title: "上下文", text: contentText(data.content), quiet: true };
  if (event.type === "assistant/message") return { title: data.interrupted ? "知行 · 已中断" : "知行", text: contentText(message.content), message: "assistant" };
  if (event.type === "tool/call") return { title: `调用 ${String(data.name)}`, text: String(data.arguments ?? "") };
  if (event.type === "tool/result") return { title: message.isError ? "工具执行失败" : "工具返回", text: contentText(message.content) || String(record(data.error).reason ?? "") };
  if (event.type === "turn/end") return { title: record(data.reason).kind === "completed" ? "本轮完成" : "执行结束", text: JSON.stringify(data.reason) };
  if (event.type === "approval/asked") return { title: "等待授权", text: String(data.reason ?? data.toolName ?? "") };
  if (event.type === "approval/decided") return { title: "授权结果", text: String(data.outcome) };
  // Internal bookkeeping stays available in the full event view. New event kinds
  // are visible by default; the UI never defines a tool capability allowlist.
  const quiet = /^(system\/message|request\/|step\/|turn\/start|agent\/inbox\/|inbox\/|model\/|tools\/|session\/)/.test(event.type);
  return { title: event.type, text: "", quiet };
}
