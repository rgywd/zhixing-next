import type { DshAttachment, DshChatRow } from "./dshProtocol";

export type ConversationFile = { key: string; file: DshAttachment };

/** One delivered file is identified by its declared path; attachments without one keep their DSH id. */
export function conversationFileKey(file: DshAttachment): string {
  const path = file.sourcePath?.trim();
  return path ? `path:${path}` : `file:${file.id}`;
}

/**
 * Files the assistant delivered in this conversation.
 *
 * The rows come from the active DSH version, so user uploads, images and
 * workspace files that were never delivered stay out. Delivering the same file
 * again replaces its earlier entry, and the newest delivery is listed first.
 * Presentation entries carry the version they belong to; an entry from a version
 * the user switched away from is dropped instead of mixing two replies.
 */
export function conversationFiles(rows: DshChatRow[], activeVersion?: string): ConversationFile[] {
  const byKey = new Map<string, ConversationFile>();
  for (const row of rows) {
    if (row.role !== "assistant") continue;
    for (const file of row.attachments) {
      if (file.type !== "file" || !file.name?.trim()) continue;
      if (activeVersion && file.delivery?.version && file.delivery.version !== activeVersion) continue;
      const key = conversationFileKey(file);
      byKey.delete(key);
      byKey.set(key, { key, file });
    }
  }
  return [...byKey.values()].reverse();
}

/** Filename search: Latin letters ignore case, Chinese names match as typed, blank shows everything. */
export function searchConversationFiles(files: ConversationFile[], query: string): ConversationFile[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return files;
  return files.filter(file => file.file.name.toLowerCase().includes(needle));
}
