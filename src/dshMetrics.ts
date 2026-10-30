export type DshSessionStats = { turns: number; steps: number; llmMs: number; toolMs: number;
  ttftMs: number; ttftSteps: number; decodeMs: number; decodeTokens: number };
export type DshTokenUsage = { uncachedInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number };
export type DshTurnMetrics = { seq: number; turn: number; stats: DshSessionStats | null; usage: DshTokenUsage | null };
export type DshContext = { pressure: { pressureTokens?: number; projectedTokens?: number; contextWindow?: number } | null;
  breakdown: { systemTokens: number; toolsTokens: number; messageTokens: number } | null };

export function mergeTurnMetrics(previous: DshTurnMetrics[], incoming: DshTurnMetrics[] = []) {
  const bySeq = new Map(previous.map(value => [value.seq, value]));
  for (const value of incoming) bySeq.set(value.seq, value);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
export function compactTokens(value: number) {
  const scaled = (count: number) => String(count >= 100 ? Math.round(count) : Math.round(count * 10) / 10);
  return value < 1000 ? String(Math.round(value)) : value < 1e6 ? `${scaled(value / 1000)}K` : `${scaled(value / 1e6)}M`;
}
export function contextOccupancy(context?: DshContext | null) {
  const used = context?.pressure?.projectedTokens ?? context?.pressure?.pressureTokens, capacity = context?.pressure?.contextWindow;
  return used == null || capacity == null || !Number.isFinite(used) || !Number.isFinite(capacity) || capacity <= 0 ? null
    : { used, capacity, percent: Math.max(0, Math.min(100, Math.round(100 * used / capacity))) };
}
export const totalTokens = (usage: DshTokenUsage) => usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
export function cacheHit(usage: DshTokenUsage | null) {
  if (!usage) return "—";
  const input = totalTokens(usage) - usage.outputTokens;
  if (input <= 0) return "—";
  if (usage.cacheReadTokens === input) return "100%";
  const percent = 100 * usage.cacheReadTokens / input;
  // Match DSH: never round a partial hit up to a full cache hit.
  for (let decimals = 0; decimals <= 6; decimals++) {
    const text = percent.toFixed(decimals);
    if (Number(text) < 100) return `${text}%`;
  }
  return "<100%";
}
export const tokenSpeed = (stats: DshSessionStats | null) => stats && stats.decodeMs > 0 ? `${(stats.decodeTokens * 1000 / stats.decodeMs).toFixed(1)} tok/s` : "— tok/s";
export const duration = (ms: number | null) => ms == null ? "—" : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${Math.round(ms / 100) / 10} s` : `${Math.floor(Math.round(ms / 1000) / 60)} m ${Math.round(ms / 1000) % 60} s`;
