import type { ReplyPart } from "./liveRun";

/** DSH owns these records. Keep opaque fields so new tools remain inspectable. */
export type DshEvent = { seq: number; time: number; type: string; data: Record<string, unknown> };
export type DshQuestion = { id: string; question: string; detail?: string; header?: string;
  options?: { label: string; description?: string }[]; multiSelect?: boolean; intent?: { kind: string } };
export type DshPending = { id: string; sessionId: string; kind: "approval" | "question";
  toolName?: string; reason?: string; questions?: DshQuestion[] };
export type DshSnapshot = { events: DshEvent[]; next: number; hasMore: boolean; running: boolean; active: boolean;
  history?: { active: string; versions: { id: string; label: string; source?: string; seq?: number; userIndex?: number; group?: string; kind?: string }[] };
  artifacts?: { id: string; toolSeq: number; content: unknown }[];
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

export type DshAttachment = { id: string; name: string; type: "image" | "file"; bytes: number; description?: string; sourcePath?: string; delivery?: { seq: number; index: number; version?: string } };
export type DshChatRow = { id: string; role: "user" | "assistant"; parts: ReplyPart[]; attachments: DshAttachment[];
  events: DshEvent[]; active: boolean; status?: "completed" | "cancelled" | "failed" | "interrupted" };
export const rowText = (row: DshChatRow) => row.parts.flatMap(p => p.type === "text" && p.attempt_status !== "failed" ? [p.text] : []).join("\n\n");
export const rowHasMessage = (row: DshChatRow, seq: number) => row.role === "user" ? row.events[0]?.seq === seq : row.parts.some(p => p.type !== "tool" && p.seq === seq);
export const revisionSeq = (row: DshChatRow) => row.role === "user" ? row.events[0]?.seq
  : row.parts.find(p => p.seq !== undefined)?.seq ?? row.events.findLast(e => e.type === "turn/end")?.seq;
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
  const calls = new Map<string, ReplyPart & { type: "tool" }>();
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
    return (block.type === "text" || block.type === "reasoning") && String(block.text ?? "").trim()
      ? [{ id: `${id}:${index}`, type: block.type, text: String(block.text) }] : [];
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
      row.parts.push(...contentParts(message.content, `message:${event.seq}`).map(part => ({ ...part, seq: event.seq,
        ...(event.type === "assistant/attempt" ? { attempt_status: "failed" as const } : {}) })));
      row.attachments.push(...contentAttachments(message.content));
      if (event.type === "assistant/message") current.steps.add(Number(data.step));
      if (data.interrupted) row.status = "interrupted";
    } else if (event.type === "tool/call") {
      const part: ReplyPart & { type: "tool" } = { id: `tool:${eventTurn}:${data.callId}:${event.seq}`, seq: event.seq, type: "tool", name: String(data.name), tool_call_id: String(data.callId), status: "started",
        detail: { input: data.arguments, startedAt: event.time } };
      assistant(eventTurn).parts.push(part); calls.set(`${eventTurn}:${data.callId}`, part);
    } else if (event.type === "tool/result") {
      const message = record(data.message), callId = message.toolCallId ?? record(message.source).callId ?? data.callId;
      const part = calls.get(`${eventTurn}:${callId}`);
      if (part) {
        part.status = message.isError || data.error ? "failed" : "completed";
        part.detail = { ...part.detail, output: message.content, meta: data.meta, error: data.error, finishedAt: event.time };
      }
      assistant(eventTurn).attachments.push(...contentAttachments(message.content));
    } else if (event.type === "deliverables/presented" && Array.isArray(data.files)) {
      const row = assistant(eventTurn);
      data.files.forEach((value, index) => {
        const file = record(value);
        if (typeof file.path !== "string" || !file.path.trim()) return;
        const id = `presented:${event.seq}:${index}`;
        row.attachments = row.attachments.filter(attachment => attachment.sourcePath !== file.path);
        row.attachments.push({ id, name: file.path.split(/[\\/]/).at(-1) || "文件", type: "file", bytes: 0,
          description: typeof file.description === "string" ? file.description : undefined, sourcePath: file.path,
          delivery: { seq: event.seq, index, version: snapshot?.history?.active } });
      });
    } else if (event.type === "turn/end") {
      current.ended = true;
      const reason = record(data.reason).kind;
      if (reason === "forked") { if (current.row) current.row.status = "interrupted"; continue; }
      assistant(eventTurn).status = reason === "completed" ? "completed" : reason === "aborted" ? "cancelled" : "failed";
    }
  }
  for (const artifact of snapshot?.artifacts ?? []) {
    const owner = rows.find(row => row.parts.some(p => p.type === "tool" && p.seq === artifact.toolSeq));
    if (owner) for (const attachment of contentAttachments(artifact.content)) {
      if (!owner.attachments.some(a => a.id === attachment.id)) owner.attachments.push(attachment);
    }
  }
  const live = snapshot?.live;
  if (live && !context(live.turn).ended && !context(live.turn).steps.has(live.step)) {
    const row = assistant(live.turn), blocks = new Map<number, { id: string; type: "text" | "reasoning"; text: string }>();
    for (const chunk of live.chunks) {
      if (chunk.type !== "text-delta" && chunk.type !== "reasoning-delta") continue;
      const index = Number(chunk.index ?? 0), type = chunk.type === "text-delta" ? "text" : "reasoning";
      let part = blocks.get(index);
      if (!part) { part = { id: `live:${live.attemptId}:${index}`, type, text: "" }; blocks.set(index, part); }
      part.text += String(chunk.text ?? "");
    }
    row.parts.push(...[...blocks.values()].filter(part => part.text.trim()));
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
  const quiet = /^(system\/message|request\/|step\/|turn\/start|agent\/inbox\/|inbox\/|model\/|tools\/|session\/|plugin:zhixing\/)/.test(event.type);
  return { title: event.type, text: "", quiet };
}

/** Show real branch choices at the message where they diverge, never fabricated page numbers. */
export function messageVersions(history: DshSnapshot["history"], userIndex: number) {
  if (!history) return null;
  const ancestors: string[] = [];
  let id: string | undefined = history.active;
  while (id && !ancestors.includes(id)) { ancestors.push(id); id = history.versions.find(v => v.id === id)?.source; }
  const edge = ancestors.map(a => history.versions.find(v => v.id === a && v.userIndex === userIndex && v.group)).find(Boolean)
    ?? history.versions.findLast(v => v.userIndex === userIndex && v.group && v.source && ancestors.includes(v.source));
  if (!edge?.group) return null;
  const siblings = history.versions.filter(v => v.group === edge.group);
  const origin = siblings[0]?.source;
  if (!origin) return null;
  const ids = [origin, ...siblings.map(v => v.id)];
  const selected = ancestors.find(a => ids.includes(a));
  if (!selected) return null;
  return { ids, index: ids.indexOf(selected), kind: edge.kind };
}

export function dshFilePath(base: string, file: DshAttachment, text = false) {
  if (file.delivery) return `${base}/dsh/deliveries/${file.delivery.seq}/${file.delivery.index}${text ? "/text" : ""}${file.delivery.version ? `?version=${encodeURIComponent(file.delivery.version)}` : ""}`;
  return `${base}/dsh/files/${encodeURIComponent(file.id)}${text ? "/text" : ""}`;
}

/** Resolve only files actually delivered in this reply; a model URL never grants filesystem access. */
export function deliveredFileForLink(files: DshAttachment[], url: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return undefined;
  let path: string;
  try { path = decodeURIComponent(url.split("#")[0]).replace(/^\.\//, ""); } catch { return undefined; }
  if (!path || path.split("/").includes("..")) return undefined;
  const matches = files.filter(file => file.type === "file" && (file.sourcePath === path || (!path.startsWith("/") &&
    (file.sourcePath?.endsWith(`/${path}`) || (!file.sourcePath && file.name === path)))));
  return matches.length === 1 ? matches[0] : undefined;
}
