/** DSH owns these records. Keep opaque fields so new tools remain inspectable. */
export type DshEvent = { seq: number; time: number; type: string; data: Record<string, unknown> };
export type DshQuestion = { id: string; question: string; detail?: string; header?: string;
  options?: { label: string; description?: string }[]; multiSelect?: boolean; intent?: { kind: string } };
export type DshPending = { id: string; sessionId: string; kind: "approval" | "question";
  toolName?: string; reason?: string; questions?: DshQuestion[] };
export type DshSnapshot = { events: DshEvent[]; next: number; hasMore: boolean; running: boolean; active: boolean;
  queue: { id: string; content: unknown }[]; pending: DshPending[];
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
