import type { Connection } from "./api";
import { dshFilePath, type DshAttachment } from "./dshProtocol";
import { ResourcePreview } from "./ResourcePreview";
import { shareNativeDownload } from "./resources";

export function DshFilePreview({ connection, base, file, onClose }: { connection: Connection; base: string; file: DshAttachment; onClose: () => void }) {
  const contentPath = dshFilePath(base, file);
  const text = /\.(txt|md|markdown|csv|json|jsonl|log|js|jsx|ts|tsx|py|sh|yaml|yml|toml|xml|html|css|sql|diff|patch|svg)$/i.test(file.name);
  return <ResourcePreview connection={connection} resource={{ id: file.id, name: file.name, size: file.bytes, mime_type: text ? "text/plain" : "application/octet-stream" }}
    textPath={dshFilePath(base, file, true)} onDownload={() => shareNativeDownload(connection, file.name, contentPath)} onClose={onClose} />;
}
