import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetrics, contextSnapshot } from '../metrics.mjs';

test('native replay cuts advance in bounded pages, freeze each terminal snapshot, and remain version scoped', async () => {
  const reads = [], restores = [];
  const events = Array.from({ length: 701 }, (_, seq) => ({ seq, type: [260, 600, 700].includes(seq) ? 'turn/end' : 'step/start', data: { turn: seq, reason: { kind: 'completed' } } }));
  const reader = { header: { id: 'native-one' }, inheritedEventCount: 0, async read(offset, limit) {
    assert.ok(limit <= 256); reads.push([offset, limit]); return { events: events.slice(offset, offset + limit) };
  } };
  const registry = { restore(checkpoint, slice, base, header, inherited) {
    assert.equal(inherited, 0); assert.equal(slice[0].seq, base);
    assert.equal(base, Math.max(0, (checkpoint.next ?? 1) - 1));
    const seq = slice.at(-1).seq;
    restores.push([base, seq]);
    return { checkpoint: { next: seq + 1 }, snapshot: { values: {
      sessionStats: { steps: 9000 + seq, turns: 77 }, tokenUsage: { outputTokens: seq, source: header.id },
    } } };
  } };
  const metrics = createMetrics({ get: name => name === 'sessionProjections' ? registry : undefined });
  const result = await metrics.turns('one', reader, events.slice(580, 650));
  assert.deepEqual(result, [{ seq: 600, turn: 600, stats: { steps: 9600, turns: 77 }, usage: { outputTokens: 600, source: 'native-one' } }]);
  const readCount = reads.length;
  assert.deepEqual(await metrics.turns('one', reader, events.slice(601, 650)), []);
  assert.equal(reads.length, readCount, 'active steps do not fetch or recompute statistics');
  const earlier = await metrics.turns('one', reader, events.slice(250, 270));
  assert.equal(earlier[0].stats.steps, 9260); assert.equal(reads.length, readCount);
  await metrics.turns('one', reader, events.slice(650));
  assert.deepEqual((await metrics.turns('one', reader, events.slice(580, 650)))[0], result[0]);
  const second = await metrics.turns('two', { ...reader, header: { id: 'native-two' } }, events.slice(580, 650));
  assert.equal(second[0].usage.source, 'native-two');
  assert.ok(restores.some(([start, end]) => start > 0 && end === 600));
});

test('missing native projections and unknown context stay absent rather than fabricated', async () => {
  const metrics = createMetrics({});
  assert.deepEqual(await metrics.turns('one', null, [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }]), []);
  assert.deepEqual(contextSnapshot(null), { pressure: null, breakdown: null });
});
