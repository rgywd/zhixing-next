import type { ReplyPart } from "./liveRun";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function displayValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
export function toolDetails(part: ReplyPart & { type: "tool" }) {
  const detail = part.detail;
  let input = detail?.input;
  if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* Preserve incomplete or non-JSON plugin arguments. */ } }
  const args = object(input), meta = object(detail?.meta);
  const path = typeof meta.path === "string" ? meta.path : typeof args.file_path === "string" ? args.file_path : "";
  const command = part.name === "bash" && typeof args.command === "string" ? args.command : "";
  const diffs = (part.name === "write" || part.name === "edit") && Array.isArray(meta.diffs) ? meta.diffs.flatMap(value => {
    const diff = object(value);
    return typeof diff.oldText === "string" && typeof diff.newText === "string"
      ? [{ path: typeof diff.path === "string" ? diff.path : path, before: diff.oldText, after: diff.newText }] : [];
  }) : [];
  const output = Array.isArray(detail?.output) ? detail.output.map(value => {
    const block = object(value);
    return block.type === "text" && typeof block.text === "string" ? block.text : displayValue(value);
  }).join("\n\n") : displayValue(detail?.output);
  const duration = typeof detail?.startedAt === "number" && typeof detail.finishedAt === "number" && detail.finishedAt >= detail.startedAt
    ? detail.finishedAt - detail.startedAt : null;
  // Missing exit metadata is deliberately not inferred from a successful tool receipt.
  const exitCode = part.name === "bash" && typeof meta.exitCode === "number" ? meta.exitCode : null;
  const embeddedContent = output.match(/<content>\n?([\s\S]*?)\n?<\/content>/)?.[1];
  const preview = part.name === "write" && typeof args.content === "string" ? args.content
    : part.name === "read" ? embeddedContent ?? output
    : part.name === "bash" ? output
    : !/^(\s*[\[{]|\s*<)/.test(output) && part.name !== "present" ? output : "";
  return { preview, input: displayValue(input), output, meta: displayValue(detail?.meta), error: displayValue(detail?.error),
    path, command, diffs, duration, exitCode };
}

export function toolSummary(part: ReplyPart & { type: "tool" }, label: string) {
  const detail = toolDetails(part);
  const file = detail.path.split(/[\\/]/).at(-1);
  return file ? `${label} · ${file}` : label;
}
