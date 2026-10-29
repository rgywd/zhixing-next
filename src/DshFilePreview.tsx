import type { Connection } from "./api";
import { dshFilePath, type DshAttachment } from "./dshProtocol";
import { ResourcePreview } from "./ResourcePreview";
import { shareNativeDownload } from "./resources";

const textFiles = /\.(txt|md|markdown|csv|json|jsonl|log|js|jsx|ts|tsx|py|sh|yaml|yml|toml|xml|html|css|sql|diff|patch|svg)$/i;

/** Null keeps the native modal mounted so its dismissal can be observed before the next layer opens. */
export function DshFilePreview({ connection, base, file, onClose, onDismiss }: {
  connection: Connection; base: string; file: DshAttachment | null; onClose: () => void; onDismiss?: () => void;
}) {
  const contentPath = file ? dshFilePath(base, file) : "";
  return <ResourcePreview connection={connection} resource={file ? { id: file.id, name: file.name, size: file.bytes,
    mime_type: textFiles.test(file.name) ? "text/plain" : "application/octet-stream" } : null}
    textPath={file ? dshFilePath(base, file, true) : undefined}
    onDownload={file ? () => shareNativeDownload(connection, file.name, contentPath) : undefined}
    onClose={onClose} onDismiss={onDismiss} />;
}
