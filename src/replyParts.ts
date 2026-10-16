import type { ReplyPart } from "./liveRun";

/** A durable final answer replaces its matching stream block, never appends twice. */
export function replyParts(parts: ReplyPart[], finalText?: string | null, finalPartId?: string | null): ReplyPart[] {
  if (finalText == null) return parts;
  const last = parts.findLast((part) => part.type === "text" && part.attempt_status !== "failed");
  const target = finalPartId === null ? null : finalPartId !== undefined ? parts.find((part) => part.id === finalPartId && part.type === "text")
    : last?.type === "text" && finalText.startsWith(last.text) ? last : null;
  return target ? parts.map((part) => part === target ? { ...target, text: finalText, truncated: false, attempt_status: "completed" } : part)
    : [...parts, { id: "answer:final", type: "text", text: finalText }];
}

export type ReplySection = { id: string; type: "text"; part: ReplyPart & { type: "text" } }
  | { id: string; type: "process"; parts: ReplyPart[] };
export function replySections(parts: ReplyPart[]): ReplySection[] {
  const sections: ReplySection[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.attempt_status !== "failed") sections.push({ id: part.id, type: "text", part });
    else {
      const last = sections.at(-1);
      if (last?.type === "process") last.parts.push(part);
      else sections.push({ id: `process:${part.id}`, type: "process", parts: [part] });
    }
  }
  return sections;
}
