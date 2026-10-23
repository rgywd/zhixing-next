import type { Message, Run } from "./api";
import type { LiveRunBuffer, ReplyPart } from "./liveRun";
export type ReplyProcess = { run_id: string; status: Run["status"]; cursor: number; stream_id: string | null;
  phase: string; parts: ReplyPart[]; final_message_id: string | null; final_part_id: string | null; truncated: boolean };
export type ReplyRecord = { buffer: LiveRunBuffer; status: Run["status"]; finalPartId: string | null; finalProjection?: boolean };
export const replyRowKey = (message: Message) => message.role === "assistant" && !message.origin && message.run_id ? `reply:${message.run_id}` : message.id;
export const isPendingReply = (message: Message) => message.id === `reply:${message.run_id}`;
/** A streaming row keeps its identity when the persisted final answer arrives. */
export function conversationReplyRows(messages: Message[], runs: Run[], records: Record<string, ReplyRecord>): Message[] {
  const answers = new Map<string, Message[]>(), lastInputs = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant" && !message.origin && message.run_id) {
      const group = answers.get(message.run_id) ?? []; group.push(message); answers.set(message.run_id, group);
    } else if (message.role === "user" && message.run_id) lastInputs.set(message.run_id, message.id);
  }
  const rows: Message[] = [];
  // Keep a completed answer beside its own input, where its streaming row was.
  // A queued follow-up can be persisted before that answer finishes.
  for (const message of messages) {
    const group = message.run_id ? answers.get(message.run_id) : undefined;
    if (message.role === "assistant" && !message.origin && group?.length === 1 && message.run_id && lastInputs.has(message.run_id)) continue;
    rows.push(message);
    if (message.role === "user" && message.run_id && lastInputs.get(message.run_id) === message.id && group?.length === 1) rows.push(group[0]);
  }
  for (const run of runs) {
    if (answers.has(run.id)) continue;
    const record = records[run.id];
    const unstarted = !run.started_at && (!run.phase || run.phase === "normal");
    if (unstarted && ["queued", "cancelled"].includes(run.status)) continue;
    if (!["running", "queued"].includes(run.status) && !record?.buffer.parts.length && !run.result) continue;
    const userIndex = rows.findLastIndex((message) => message.role === "user" && message.run_id === run.id);
    if (userIndex < 0) continue;
    rows.splice(userIndex + 1, 0, { id: `reply:${run.id}`, role: "assistant", run_id: run.id, conversation_id: run.conversation_id,
      content: record?.status === "completed" ? run.result ?? "" : "", intent: "queue", status: "applied", created_at: run.created_at, seq: -Math.abs(rows[userIndex].seq) });
  }
  return rows;
}
