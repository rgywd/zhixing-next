import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const HOUR = 3_600_000;
export function localDay(now) { return new Date(now + 8 * HOUR).toISOString().slice(0, 10); }
export function localHour(now) { return new Date(now + 8 * HOUR).getUTCHours(); }
export const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 24);

export function durableWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(data, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export function openState(path, targetId, { seedSessionId, now = Date.now(), write = durableWrite } = {}) {
  if (!Number.isSafeInteger(targetId) || targetId <= 0) throw new Error('A private Telegram target is required');
  const validSession = id => typeof id === 'string' && /^msgw-[a-zA-Z0-9_-]+$/.test(id);
  if (seedSessionId && !validSession(seedSessionId)) throw new Error('Invalid seed session');
  let state;
  try { state = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e; // A damaged ledger must never reset message limits.
    state = { version: 1, targetId, sessionId: seedSessionId || null, sessionIds: seedSessionId ? [seedSessionId] : [],
      memoryId: seedSessionId || `msgw-memory-${digest('telegram:' + targetId)}`,
      enabled: true, maxPerDay: 2, lastInboundAt: now, inboundVersion: 0, lastCheckAt: 0, deliveries: [] };
    write(path, state);
  }
  if (state.version !== 1 || state.targetId !== targetId || !Array.isArray(state.deliveries) || !Array.isArray(state.sessionIds) ||
      typeof state.enabled !== 'boolean' || ![1, 2].includes(state.maxPerDay) || !Number.isFinite(state.lastInboundAt) ||
      !Number.isSafeInteger(state.inboundVersion) || state.inboundVersion < 0 || !Number.isFinite(state.lastCheckAt) || !validSession(state.memoryId) ||
      state.sessionIds.some(id => !validSession(id)) || new Set(state.sessionIds).size !== state.sessionIds.length ||
      (state.sessionId !== null && !state.sessionIds.includes(state.sessionId)) ||
      state.deliveries.some(d => !d || !Number.isFinite(d.at) || !['sending', 'sent', 'unknown'].includes(d.status))) {
    throw new Error('Companion state identity/schema mismatch');
  }
  return {
    get: () => structuredClone(state),
    change(fn) {
      const next = structuredClone(state); fn(next); write(path, next); state = next;
      return structuredClone(state);
    },
  };
}

export function eligible(s, now) {
  if (!s.enabled) return 'paused';
  if (localHour(now) < 10 || localHour(now) >= 22) return 'quiet-hours';
  if (now - s.lastInboundAt < 90 * 60_000) return 'recent-conversation';
  if (now - s.lastCheckAt < 2 * HOUR) return 'check-cooldown';
  const attempts = s.deliveries.filter(d => ['sending', 'sent', 'unknown'].includes(d.status));
  if (attempts.filter(d => localDay(d.at) === localDay(now)).length >= s.maxPerDay) return 'daily-limit';
  const last = attempts.at(-1);
  if (last && (Number.isFinite(last.inboundVersion) ? s.inboundVersion <= last.inboundVersion : s.lastInboundAt <= last.at)) return 'awaiting-reply';
  if (last && now - last.at < 4 * HOUR) return 'send-cooldown';
  return null;
}

export function immediatePreference(text) {
  const clean = String(text).trim().replace(/[，。！!、\s]/g, '');
  if (/^(?:以后|暂时|先|这段时间)?(?:别|不要|不用|停止|暂停)(?:再)?(?:主动)?(?:找我|给我发消息|联系我|打扰我|发新闻|主动聊天)(?:了|吧)?$/.test(clean)) return 'pause';
  if (/^(?:以后|可以|继续|恢复|重新)(?:继续|恢复)?(?:主动找我|主动聊天|给我发消息)(?:了|吧)?$/.test(clean)) return 'resume';
  return null;
}

export function validateDraft(raw, candidates) {
  const value = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  if (value.send === false) return null;
  const candidate = candidates.find(c => c.id === value.topicId);
  if (value.send !== true || !candidate || typeof value.text !== 'string') throw new Error('Invalid proactive draft');
  const text = value.text.trim();
  if (!text || text.length > 400 || /https?:\/\/|<\/?[a-z]|\[.*\]\(/i.test(text)) throw new Error('Unexpected link/markup/length in draft');
  return { topicId: candidate.id, text: candidate.url ? `${text}\n\n${candidate.publisher} · ${candidate.publishedAt.slice(0, 10)}\n${candidate.url}` : text };
}
