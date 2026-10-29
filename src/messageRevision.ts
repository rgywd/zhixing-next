import type { DshAttachment } from "./dshProtocol";

export type MessageRevision = { id: string; kind: "edit" | "retry"; seq: number; version: string; text: string;
  attachments: DshAttachment[]; submitted?: boolean };
