import { ReplyContent } from "./ReplyContent";
import type { LiveRunState } from "./liveRun";

/** Compatibility entry point; all assistants and durable replies use ReplyContent. */
export function LiveRunView({ value }: { value: LiveRunState | null }) {
  if (!value) return null;
  return <ReplyContent key={value.run.id} parts={value.answerCommitted ? value.parts.filter((part) => part.type !== "text") : value.parts}
    finalText={!value.answerCommitted && value.content ? value.content : undefined} finalPartId={value.finalPartId}
    active={value.active} status={value.run.status} phase={value.phase} cancelRequested={value.run.cancel_requested}
    connectionIssue={value.connectionIssue} truncated={value.truncated} />;
}
