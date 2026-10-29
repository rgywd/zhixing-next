import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRevisions } from '../revisions.mjs';

const user = (seq, text, rpcId) => ({ seq, type: 'user/message', data: { source: { kind: 'user', rpcId }, content: [{ type: 'text', text }] } });
function fixture() {
  const logs = new Map([['root', [{ seq: 0, type: 'session/start', data: {} }, user(1, 'original', 'one'),
    { seq: 2, type: 'assistant/message', data: {} }, user(3, 'later', 'two'), { seq: 4, type: 'assistant/message', data: {} }]]]);
  const agents = new Map([['root', { id: 'root', status: 'idle' }]]), admitted = [];
  const table = () => { const data = new Map(); return { get: id => data.get(id), put: async (id, value) => data.set(id, structuredClone(value)) }; };
  const metadata = { revisions: table(), artifacts: table() };
  const ctx = { agents: { get: id => agents.get(id) }, sessionController: {
    state: async () => ({ queue: [] }),
    prompt: async body => { admitted.push(body); const log = logs.get(body.sessionId); log.push(user(log.length, body.content[0].text, body.requestId)); },
  } };
  const dependencies = { metadata, records: async function* (id) { yield* logs.get(id); }, resolve: async id => agents.get(id),
    flush: async () => {}, register: () => {}, async forkRevision(id, _source, events, cut) {
      if (!agents.has(id)) { logs.set(id, events.slice(0, cut + 1)); agents.set(id, { id, status: 'idle' }); }
      return agents.get(id);
    } };
  return { ctx, metadata, admitted, logs, agents, open: () => createRevisions(ctx, dependencies),
    edit: { id: 'edit-one', kind: 'edit', seq: 1, version: 'root', text: 'edited', attachments: [] } };
}
test('history edits preserve the original log and restore the selected branch after restart', async () => {
  const f = fixture(), revisions = f.open();
  const changed = await revisions.revise('root', f.edit);
  assert.equal(changed.versions.length, 2); assert.equal(f.admitted[0].content[0].text, 'edited');
  assert.equal(f.logs.get(changed.active).length, 2); assert.equal(f.logs.get('root').length, 5);
  const restored = f.open(); assert.equal(await restored.active('root'), changed.active);
  await restored.revise('root', f.edit); assert.equal(f.admitted.length, 1);
  await restored.select('root', { expected: changed.active, version: 'root' });
  assert.equal(await restored.active('root'), 'root');
});
test('durable admission survives a lost activation acknowledgement without another prompt', async () => {
  const f = fixture(), put = f.metadata.revisions.put;
  f.metadata.revisions.put = async (id, value) => { if (value.entries.some(e => e.accepted)) throw new Error('disk failed'); await put(id, value); };
  await assert.rejects(f.open().revise('root', f.edit), /disk failed/);
  assert.equal(f.admitted.length, 1); assert.equal(f.metadata.revisions.get('root').active, 'root');
  f.metadata.revisions.put = put;
  const result = await f.open().revise('root', f.edit);
  assert.equal(result.versions.length, 2); assert.equal(f.admitted.length, 1);
});
test('invalid or stale edits and foreign versions never start native work', async () => {
  const f = fixture(), r = f.open();
  for (const body of [{ ...f.edit, version: 'other' }, { ...f.edit, attachments: ['foreign-file'] },
    { ...f.edit, text: '' }, { ...f.edit, seq: 2 }]) await assert.rejects(r.revise('root', body));
  await assert.rejects(r.select('root', { expected: 'root', version: 'foreign' }));
  f.agents.get('root').status = 'running'; await assert.rejects(r.revise('root', f.edit), /等当前回复/);
  assert.equal(f.admitted.length, 0); assert.equal(f.agents.size, 1);
});
test('prepare failure is retryable and a reused request cannot change its body', async () => {
  const f = fixture(), put = f.metadata.revisions.put, r = f.open();
  f.metadata.revisions.put = async () => { throw new Error('disk failed'); };
  await assert.rejects(r.revise('root', f.edit), /disk failed/); assert.equal(f.agents.size, 1);
  f.metadata.revisions.put = put; await r.revise('root', f.edit);
  await assert.rejects(r.revise('root', { ...f.edit, text: 'different' }), /内容已改变/);
  assert.equal(f.admitted.length, 1);
});
