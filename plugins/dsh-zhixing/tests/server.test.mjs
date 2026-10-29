import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { startServer, createInteractions, businessRequest } from '../server.mjs';

function fixture() {
  const listeners = new Map(), rows = [], records = new Map(), agents = new Map();
  const ctx = {
    on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name); },
    agents: { get: id => agents.get(id) },
    sessions: { get: id => agents.get(id)?.session, flush: async () => {} },
    sessionPersistence: { open: async id => ({ read: async (offset, limit) => ({ events: records.get(id).slice(offset, offset + limit) }), close: async () => {} }) },
    sessionController: {
      async modelCatalog() { return { default: { provider: 'fixture', model: 'fixture' }, routableProviders: ['fixture'], groups: [{ id: 'fixture', name: 'fixture', models: [{ id: 'fixture', name: 'fixture' }] }] }; },
      async list() { return { items: rows }; },
      async state({ sessionId }) { return { queue: agents.get(sessionId)?.queue ?? [] }; },
      async updateQueue({ sessionId, itemId, action }) {
        const agent = agents.get(sessionId), item = agent.queue.find(q => q.id === itemId);
        if (!item) throw new Error('no queued item');
        if (action.kind === 'remove') agent.queue = agent.queue.filter(q => q.id !== itemId);
        if (action.kind === 'steer') item.placement = 'steering';
        return { accepted: true };
      },
      async attachment({ attachment }) { return { attachment, data: Buffer.from('image bytes').toString('base64') }; },
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
  return { ctx, listeners, agents, records };
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
  agent.queue = [{ id: 'queued', placement: 'queued', content: [{ type: 'text', text: 'next' }] }, { id: 'system', placement: 'context', content: [] }];
  assert.equal((await request(`/conversations/${chat.id}/dsh`)).queue.length, 1);
  await request(`/conversations/${chat.id}/dsh/queue/queued`, { kind: 'steer' });
  assert.equal((await request(`/conversations/${chat.id}/dsh`)).queue[0].placement, 'steering');
  await request(`/conversations/${chat.id}/dsh/queue/queued`, { kind: 'remove' });
  assert.equal((await request(`/conversations/${chat.id}/dsh`)).queue.length, 0);
});

test('file retrieval uses only session-owned immutable references, streams bytes and provides bounded text previews', async t => {
  const f = fixture(), bytes = Buffer.from('中文文件\n' + 'x'.repeat(300000));
  f.ctx.attachments = { async *readFileStream(ref) { assert.equal(ref.attachmentId, 'file-1'); yield bytes.subarray(0, 1000); yield bytes.subarray(1000); } };
  const server = await startServer(f.ctx, { token: 'files', port: 0 }); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address.port}/v1/conversations`, headers = { Authorization: 'Bearer files' };
  for (const sessionId of ['zhixing-main-aaaa', 'zhixing-main-bbbb']) await f.ctx.sessionController.create({ sessionId });
  f.records.get('zhixing-main-aaaa').push(...Array.from({ length: 260 }, (_, seq) => ({ seq, type: 'system/message', data: {} })),
    { seq: 260, type: 'tool/result', data: { message: { content: [{ type: 'file', attachment: { attachmentId: 'file-1', name: '报告.txt', bytes: bytes.length } }] } } });
  const path = `${base}/zhixing-main-aaaa/dsh/files/file-1`;
  assert.equal((await fetch(path)).status, 401);
  assert.equal((await fetch(`${base}/zhixing-main-bbbb/dsh/files/file-1`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/zhixing-main-aaaa/dsh/files/%2Fetc%2Fpasswd`, { headers })).status, 404);
  const downloaded = await fetch(path, { headers });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  const preview = await (await fetch(`${path}/text`, { headers })).json();
  assert.equal(preview.truncated, true); assert.equal(preview.content, bytes.subarray(0, 256 * 1024).toString('utf8'));
  f.ctx.attachments.readFileStream = async function* () { yield bytes; await new Promise(resolve => setTimeout(resolve, 20)); throw new Error('integrity mismatch'); };
  await assert.rejects(async () => { const corrupt = await fetch(path, { headers }); await corrupt.arrayBuffer(); }, /terminated|fetch failed/);
});

test('rename returns the accepted native title and search anchors only visible message content', async t => {
  const f = fixture(), server = await startServer(f.ctx, { token: 'search', port: 0 }); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address.port}/v1`, headers = { Authorization: 'Bearer search' }, id = 'zhixing-main-aaaa';
  await f.ctx.sessionController.create({ sessionId: id });
  const rename = title => fetch(`${base}/conversations/${id}/title`, { method: 'PUT', headers, body: JSON.stringify({ title }) });
  assert.equal((await rename('  ')).status, 400);
  assert.equal((await (await rename('  本周代码改进  ')).json()).title, '本周代码改进');
  f.ctx.sessionController.search = async () => ({ items: [{ sessionId: id, snippet: 'host summary' }, { sessionId: 'telegram-private', snippet: 'not this outlet' }] });
  f.records.get(id).push({ seq: 0, type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '需要调整模型' }] } },
    { seq: 1, type: 'assistant/message', data: { message: { id: 'm1', content: [{ type: 'reasoning', text: '需要调整模型' }, { type: 'text', text: '后面再说' }] } } },
    { seq: 2, type: 'user/message', data: { id: 'm2', source: { kind: 'user' }, content: [{ type: 'text', text: '需要调整模型' }] } });
  const result = await (await fetch(`${base}/conversations/search?q=${encodeURIComponent('调整模型')}`, { headers })).json();
  assert.equal(result.items.length, 1); assert.equal(result.items[0].message_seq, 2); assert.equal(result.items[0].message_id, 'm2');
  assert.equal(result.items[0].title, '本周代码改进'); assert.equal(result.items[0].snippet, '需要调整模型');
});

test('native image bytes require authorization and a durable reference in the requested session', async t => {
  const f = fixture(), server = await startServer(f.ctx, { token: 'image-token', port: 0 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address.port}/v1`;
  const id = 'zhixing-main-aaaa', other = 'zhixing-main-bbbb';
  await f.ctx.sessionController.create({ sessionId: id }); await f.ctx.sessionController.create({ sessionId: other });
  const attachment = { attachmentId: 'immutable-image', mediaType: 'image/png', bytes: 11, width: 1, height: 1 };
  f.records.get(id).push({ type: 'user/message', data: { content: [{ type: 'image', attachment }] } });
  const path = session => `${base}/conversations/${session}/dsh/images/immutable-image`;
  assert.equal((await fetch(path(id))).status, 401);
  const headers = { Authorization: 'Bearer image-token' };
  assert.equal((await fetch(path(other), { headers })).status, 404);
  const response = await fetch(path(id), { headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(await response.text(), 'image bytes');
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
