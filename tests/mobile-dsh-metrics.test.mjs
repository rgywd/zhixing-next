import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheHit, compactTokens, contextOccupancy, duration, tokenSpeed, totalTokens, mergeTurnMetrics } from '../src/dshMetrics.ts';
import { chatRows } from '../src/dshProtocol.ts';

test('native context pressure prefers the post-compaction estimate and never invents missing capacity', () => {
  assert.deepEqual(contextOccupancy({ pressure: { projectedTokens: 92400, pressureTokens: 200000, contextWindow: 1000000 } }), { used: 92400, capacity: 1000000, percent: 9 });
  assert.equal(contextOccupancy({ pressure: { pressureTokens: 10 } }), null);
  assert.equal(contextOccupancy({ pressure: { contextWindow: 10000 } }), null);
  assert.equal(contextOccupancy({ pressure: { pressureTokens: 100, contextWindow: 0 } }), null);
  assert.equal(contextOccupancy({ pressure: { pressureTokens: 110, contextWindow: 100 } }).percent, 100);
  assert.equal(contextOccupancy({ pressure: { projectedTokens: 0, pressureTokens: 100, contextWindow: 100 } }).percent, 0);
});

test('DSH billing buckets stay disjoint and speed uses decode time; absent timing and partial hits stay honest', () => {
  const usage = { uncachedInputTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 20, outputTokens: 40 };
  assert.equal(totalTokens(usage), 1060); assert.equal(cacheHit(usage), '20%');
  assert.equal(cacheHit({ ...usage, uncachedInputTokens: 0, cacheWriteTokens: 0 }), '100%');
  assert.equal(cacheHit({ ...usage, uncachedInputTokens: 1, cacheReadTokens: 9999, cacheWriteTokens: 0 }), '99.99%');
  assert.equal(cacheHit({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }), '—');
  assert.equal(tokenSpeed({ decodeTokens: 120, decodeMs: 3000, llmMs: 10000 }), '40.0 tok/s');
  assert.equal(tokenSpeed({ decodeTokens: 0, decodeMs: 0 }), '— tok/s');
  assert.equal(duration(25), '25 ms'); assert.equal(duration(null), '—');
  assert.deepEqual([compactTokens(92400), compactTokens(1000000), compactTokens(1400)], ['92.4K', '1M', '1.4K']);
});

test('only the last assistant segment of an ended native turn gets its immutable snapshot', () => {
  const e = (seq, type, data) => ({ seq, type, data, time: seq * 100 });
  const metrics = { seq: 5, turn: 1, stats: { turns: 1, steps: 2 }, usage: null };
  const events = [e(0, 'turn/start', { turn: 1 }), e(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'original' }] }),
    e(2, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'progress' }] } }),
    e(3, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'steer' }] }),
    e(4, 'assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'done' }] } }),
    e(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } })];
  const rows = chatRows(events, { statistics: [metrics] });
  assert.equal(rows.filter(row => row.metrics).length, 1); assert.equal(rows.at(-1).metrics, metrics);
  assert.equal(chatRows(events.slice(0, -1), { statistics: [metrics], running: true }).some(row => row.metrics), false);
  const next = { seq: 10, turn: 2, stats: { turns: 2, steps: 3 }, usage: null };
  assert.deepEqual(mergeTurnMetrics([metrics], [next, next]), [metrics, next]);
  assert.equal(chatRows(events, { statistics: [metrics, next] }).at(-1).metrics.stats.turns, 1);
  assert.equal(chatRows(events, { statistics: [] }).some(row => row.metrics), false);
});
