import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createInteractions, businessRequest } from '../server.mjs';

function fixture() {
  const listeners = new Map(), rows = [], records = new Map(), agents = new Map();
  const ctx = {
    on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name); },
    agents: { get: id => agents.get(id) },
    sessions: { get: id => agents.get(id)?.session, flush: async () => {} },
    sessionPersistence: { open: async id => ({ read: async offset => ({ events: records.get(id).slice(offset) }), close: async () => {} }) },
    sessionController: {
      async modelCatalog() { return { default: { provider: 'fixture', model: 'fixture' }, routableProviders: ['fixture'], groups: [{ id: 'fixture', name: 'fixture', models: [{ id: 'fixture', name: 'fixture' }] }] }; },
      async list() { return { items: rows }; },
      async create({ sessionId }) {
        rows.push({ sessionId, updatedAt: Date.now(), projections: { values: { title: 'new' } } }); records.set(sessionId, []);
        agents.set(sessionId, { session: {}, inbox: { nextStep: [], nextTurn: [] }, status: 'idle', whenIdle: async () => {} });
        return { sessionId };
      },
      async rename({ sessionId, title }) { rows.find(r => r.sessionId === sessionId).projections.values.title = title; },
      async prompt(input) {
        const events = records.get(input.sessionId);
        if (!events.some(e => e.data.id === input.requestId)) {
          await new Promise(resolve => setTimeout(resolve, 5));
          events.push({ seq: events.length, time: Date.now(), type: 'user/message', data: { id: input.requestId, content: input.content } });
        }
        return { accepted: true };
      },
      cancel() {},
    },
  };
  return { ctx, listeners, agents };
}

test('outlet authentication, full prompt admission, duplicate retry and durable event replay', async t => {
  const f = fixture();
  const server = await startServer(f.ctx, { token: 'test-token', port: 0 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address.port}/v1`;
  const request = async (path, body) => {
    const response = await fetch(base + path, { headers: { Authorization: 'Bearer test-token' }, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status < 300, true, await response.clone().text()); return response.json();
  };
  assert.equal((await fetch(base + '/status')).status, 401);
  assert.equal((await request('/status')).runtime, 'dsh');
  const chat = await request('/conversations', { title: 'Code work' });
  const message = { id: 'same-request', content: 'x'.repeat(25000) };
  await Promise.all([request(`/conversations/${chat.id}/messages`, message), request(`/conversations/${chat.id}/messages`, message)]);
  const snapshot = await request(`/conversations/${chat.id}/dsh?offset=0`);
  assert.equal(snapshot.events.length, 1); assert.equal(snapshot.events[0].data.content[0].text.length, 25000);
  assert.equal((await request(`/conversations/${chat.id}/dsh?offset=1`)).events.length, 0);
  const agent = f.agents.get(chat.id); let settled = false;
  agent.whenIdle = async () => { await new Promise(resolve => setTimeout(resolve, 20)); settled = true; };
  await request(`/conversations/${chat.id}/dsh/cancel`, {}); assert.equal(settled, true);
});

test('human decisions are session bound, validated, and invalidated by DSH cancellation', async () => {
  const f = fixture(), input = createInteractions(f.ctx);
  const id = 'zhixing-main-aaaa';
  const controller = new AbortController();
  const approval = f.listeners.get('approval/request')({ agent: { id }, toolName: 'bash', signal: controller.signal }, () => assert.fail());
  const [pending] = input.list(id);
  assert.throws(() => input.answer('another-session', pending.id, { outcome: 'allowed-once' }), /结束/);
  assert.throws(() => input.answer(id, pending.id, { outcome: 'always' }), /无效/);
  controller.abort(); assert.equal(await approval, 'cancelled');
  assert.throws(() => input.answer(id, pending.id, { outcome: 'allowed-once' }), /结束/);
  const question = f.listeners.get('user-questions/request')({ agent: { id }, questions: [{ id: 'a', question: 'Q', options: [{ label: 'Yes' }] }] }, () => assert.fail());
  const [q] = input.list(id);
  assert.throws(() => input.answer(id, q.id, { answers: [{ id: 'a', selected: ['Unlisted'] }] }), /不符合/);
  input.answer(id, q.id, { answers: [{ id: 'a', selected: ['Yes'] }] });
  assert.deepEqual(await question, { answers: [{ id: 'a', selected: ['Yes'] }] });
  assert.equal(await f.listeners.get('approval/request')({ agent: { id: 'telegram-session' } }, async () => 'other-channel'), 'other-channel');
  input.close();
});

test('business bridge rejects arbitrary targets without forwarding credentials', async () => {
  await assert.rejects(businessRequest({ businessUrl: 'http://127.0.0.1:1' }, '//external.example/path'), /不是/);
  await assert.rejects(businessRequest({ businessUrl: 'http://127.0.0.1:1' }, '/v1/finance/../../admin'), /无效/);
  await assert.rejects(businessRequest({}, '/v1/finance'), /尚未连接/);
});
