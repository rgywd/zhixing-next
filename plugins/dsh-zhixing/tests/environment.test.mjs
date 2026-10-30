import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createEnvironment } from '../environment.mjs';

const SECRET = 'TEST_ONLY_TOKEN_-a6fd2b594d1942';
const fields = [{ name: 'DSH_SECRET_BOT_TOKEN', label: 'Bot Token' }, { name: 'DSH_SECRET_API_KEY', label: 'API Key' }];
function context() {
  const events = new Map(), registrations = new Map();
  let record, writes = 0, failure, gate;
  return { events, registrations, get record() { return record; }, get writes() { return writes; },
    set failure(value) { failure = value; }, set gate(value) { gate = value; },
    on: (name, handler) => { events.set(name, handler); return () => events.delete(name); },
    credentials: { readRecord: async () => record, modifyRecord: async (_key, mutate) => {
      await gate; if (failure) throw failure;
      const next = await mutate(record); if (next) { record = structuredClone(next); writes++; } return record;
    } },
    shellEnv: { list: () => [...registrations.values()].flatMap(item => Object.keys(item.variables).map(key => ({ key }))),
      register: item => { assert.ok(!registrations.has(item.name)); registrations.set(item.name, item); return () => registrations.delete(item.name); } },
  };
}
async function fixture(ctx = context()) {
  const store = await createEnvironment(ctx, id => id === 'session-one', '/workspace');
  const signal = new AbortController();
  const execution = { agent: { id: 'session-one', session: { header: { cwd: '/workspace' } } }, signal: signal.signal };
  const result = store.request({ title: '连接服务', fields }, execution);
  const request = store.list('session-one')[0];
  const body = { submissionId: randomUUID(), fields: request.fields.map((field, i) => ({ id: field.id,
    name: i ? field.name : 'DSH_SECRET_RENAMED_TOKEN', value: i ? SECRET + '-second' : SECRET })) };
  return { ctx, store, signal, execution, result, request, body };
}

test('private multi-value submission is atomic, name-editable, session bound and idempotent; native injection is scoped', async () => {
  const f = await fixture();
  await assert.rejects(f.store.answer('other', f.request.id, f.body), e => e.status === 409);
  assert.equal(f.ctx.writes, 0);
  const receipt = await f.store.answer('session-one', f.request.id, f.body);
  assert.deepEqual(receipt.names, ['DSH_SECRET_RENAMED_TOKEN', 'DSH_SECRET_API_KEY']);
  assert.equal(f.ctx.writes, 1);
  assert.deepEqual(await f.store.answer('session-one', f.request.id, f.body), receipt);
  assert.equal(f.ctx.writes, 1);
  assert.ok(!JSON.stringify([f.request, receipt, await f.result]).includes(SECRET));
  const injected = Object.assign({}, ...[...f.ctx.registrations.values()].map(item => item.resolve(f.execution)));
  assert.equal(injected.DSH_SECRET_RENAMED_TOKEN, SECRET);
  const other = { agent: { session: { header: { cwd: '/another-workspace' } } } };
  for (const registration of f.ctx.registrations.values()) assert.deepEqual(registration.resolve(other), {});
  assert.equal(process.env.DSH_SECRET_RENAMED_TOKEN, undefined);
  await f.store.close();
  const reopened = await createEnvironment(f.ctx, () => true, '/workspace');
  assert.equal(Object.assign({}, ...[...f.ctx.registrations.values()].map(item => item.resolve(f.execution))).DSH_SECRET_RENAMED_TOKEN, SECRET);
  await reopened.close();
});

test('duplicate/reserved variable names, overwrite and provider failures never publish partial credentials or raw errors', async () => {
  const f = await fixture();
  for (const name of ['PATH', 'DSH_HOME', 'DSH_SECRET_', 'DSH_SECRET_BAD-NAME']) {
    await assert.rejects(f.store.answer('session-one', f.request.id, { ...f.body, fields: f.body.fields.map((item, index) => index ? item : { ...item, name }) }));
  }
  await assert.rejects(f.store.answer('session-one', f.request.id, { ...f.body, fields: f.body.fields.map(item => ({ ...item, name: 'DSH_SECRET_SAME' })) }));
  assert.equal(f.ctx.writes, 0);
  f.ctx.failure = Object.assign(new Error(SECRET), { status: 400 });
  await assert.rejects(f.store.answer('session-one', f.request.id, f.body), e => e.status === 503 && !e.message.includes(SECRET));
  assert.equal(f.store.list('session-one').length, 1);
  f.ctx.failure = undefined;
  await f.store.answer('session-one', f.request.id, f.body); await f.result;
  const next = f.store.request({ title: '更新变量', fields }, f.execution);
  const request = f.store.list('session-one')[0];
  const body = { ...f.body, submissionId: randomUUID() };
  await assert.rejects(f.store.answer('session-one', request.id, body), e => e.status === 409);
  assert.equal(f.ctx.writes, 1);
  await f.store.answer('session-one', request.id, { ...body, fields: body.fields.map(item => ({ ...item, replace: true })) });
  await next; assert.equal(f.ctx.writes, 2); await f.store.close();
});

test('cancellation, stale requests and cancellation during a queued durable write cannot store values', async () => {
  const f = await fixture();
  f.signal.abort(); assert.equal((await f.result).status, 'cancelled');
  await assert.rejects(f.store.answer('session-one', f.request.id, f.body), e => e.status === 409);
  assert.equal(f.ctx.writes, 0); await f.store.close();
  const g = await fixture(); let release;
  g.ctx.gate = new Promise(resolve => { release = resolve; });
  const saving = g.store.answer('session-one', g.request.id, g.body);
  await new Promise(resolve => setImmediate(resolve)); g.signal.abort(); release();
  await assert.rejects(saving, e => e.status === 409);
  assert.equal((await g.result).status, 'cancelled'); assert.equal(g.ctx.writes, 0); await g.store.close();
});

test('native post-tool policy hides private values in content, structured data, encoded output and failed-tool metadata', async () => {
  const f = await fixture(); await f.store.answer('session-one', f.request.id, f.body); await f.result;
  const filter = f.ctx.events.get('tools/post-execute');
  for (const value of [SECRET, encodeURIComponent(SECRET), Buffer.from(SECRET).toString('base64')]) {
    const result = await filter(f.execution, { content: [], error: { message: value }, value: { stdout: value } }, async () => ({ kind: 'accept' }));
    assert.equal(result.kind, 'block'); assert.ok(!JSON.stringify(result).includes(value));
  }
  assert.deepEqual(await filter(f.execution, { content: [{ type: 'text', text: 'OK' }] }, async () => ({ kind: 'accept' })), { kind: 'accept' });
  const rejected = await filter(f.execution, {}, async () => ({ kind: 'block', feedback: [{ type: 'text', text: SECRET }] }));
  assert.ok(!JSON.stringify(rejected).includes(SECRET)); await f.store.close();
});
