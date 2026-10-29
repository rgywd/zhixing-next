import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessService, emptyState } from '../business/service.mjs';
import { toolBody } from '../business/tool-context.mjs';

function fixture() {
  let state = emptyState(), failure;
  const global = { get: () => state, set: async next => { if (failure) throw failure; state = structuredClone(next); } };
  const service = createBusinessService(global);
  return { ...service, state: () => structuredClone(state), fail: error => { failure = error; } };
}
const meal = { source_id: 'user-1', entry_key: 'lunch', conversation_id: 'native-thread', meal: { occurred_at: '2026-10-29T12:30:00+08:00', description: '鸡肉饭' }, amount: '28', occurred_on: '2026-10-29' };
test('one meal and its payment commit together; replay, correction and failed changes preserve both records', async () => {
  const f = fixture(), saved = await f.request('/v1/life/meals', 'POST', meal);
  assert.equal(saved.atomic, true); assert.equal(saved.finance.amount, '28.00');
  assert.deepEqual(await f.request('/v1/life/meals', 'POST', meal), saved);
  assert.equal(f.state().tables.finance_transactions.length, 1);
  const before = f.state();
  await assert.rejects(f.request('/v1/life/meals', 'POST', { ...meal, entry_key: 'bad-meal', meal: { ...meal.meal, description: '' } }));
  assert.deepEqual(f.state(), before, 'the tentative payment and receipts must roll back when meal validation fails');
  const corrected = await f.request(`/v1/life/meals/${saved.event_id}`, 'PATCH', { source_id: 'correction', entry_key: 'lunch', meal_changes: { description: '鸡肉饭和青菜' }, finance_changes: { amount: '32' } });
  assert.equal(corrected.finance.amount, '32.00'); assert.equal(corrected.meal.description, '鸡肉饭和青菜');
  assert.equal(corrected.finance.id, saved.finance.id); assert.equal(corrected.meal.id, saved.meal.id);
});

test('durability failure never reports a saved record or publishes a partial in-memory state', async () => {
  const f = fixture(), before = f.state();
  f.fail(new Error('disk full'));
  await assert.rejects(f.request('/v1/life/meals', 'POST', meal), /disk full/);
  assert.deepEqual(f.state(), before);
  f.fail(null);
  await f.request('/v1/life/meals', 'POST', meal);
  assert.equal(f.state().tables.finance_transactions.length, 1);
  const reopened = createBusinessService({ get: () => f.state(), set: async () => assert.fail('read only') });
  assert.equal((await reopened.request('/v1/health/summary?date=2026-10-29')).meals[0].description, '鸡肉饭');
});

test('concurrent changes compare the committed revision and do not lose a restriction', async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    f.request('/v1/health/profile', 'PUT', { revision: 0, food_allergies: ['花生'] }),
    f.request('/v1/health/profile', 'PUT', { revision: 0, height_cm: 170 }),
  ]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'revision_conflict');
  await f.request('/v1/health/profile', 'PATCH', { height_cm: 170 });
  assert.deepEqual((await f.request('/v1/health/profile')).food_allergies, ['花生']);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.request('/v1/life/meals', 'POST', meal, controller.signal), { name: 'AbortError' });
  assert.equal(f.state().tables.life_events.length, 0);
});

test('business API cannot forward requests, manage files, search providers or manufacture memory', async () => {
  const f = fixture();
  for (const path of ['//external.example/v1/finance/summary', '/v1/finance/../../admin', '/v1/resources', '/v1/memories', '/v1/search/providers']) {
    await assert.rejects(f.request(path), { status: 404 });
  }
  const schema = await f.request('/v1/business/schema?domain=finance');
  assert.ok(schema.routes.every(r => r.path.startsWith('/v1/finance/')));
  assert.ok(schema.schemas.TransactionInput);
});

test('source message replay must not double-book a payment after a lost acknowledgement', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 8 }, () => f.request('/v1/life/meals', 'POST', meal)));
  assert.equal(f.state().tables.life_events.length, 1);
  assert.equal(f.state().tables.finance_transactions.length, 1);
  assert.equal(f.state().tables.health_meals.length, 1);
  await assert.rejects(f.request('/v1/life/meals', 'POST', { ...meal, amount: '99' }), { code: 'idempotency_conflict' });
});

test('business tools bind real consumed input and session without asking the model for internal IDs', async () => {
  const f = fixture();
  const exec = { rootCallId: 'native-call', agent: { id: 'native-session', session: { deriveMessages: () => [
    { role: 'user', id: 'consumed-user', source: { kind: 'user' } },
    { role: 'user', id: 'clock-context', source: { kind: 'time-context' } },
  ] } } };
  const body = toolBody({ path: '/v1/life/meals', method: 'POST', body: { ...meal, conversation_id: undefined, source_id: 'invented' } }, exec);
  assert.equal(body.conversation_id, 'native-session'); assert.equal(body.source_id, 'native-session:consumed-user');
  const saved = await f.request('/v1/life/meals', 'POST', body);
  assert.equal(saved.meal.conversation_id, 'native-session');
  assert.equal(saved.meal.source_id, body.source_id);
  assert.deepEqual(await f.request('/v1/life/meals', 'POST', body), saved);
  assert.deepEqual(toolBody({ path: '/v1/health/profile', method: 'PATCH', body: { food_allergies: ['花生'] } }, exec), { food_allergies: ['花生'] });
  assert.equal(toolBody({ path: '/v1/health/recommendations/plan/feedback?idempotency_key=replay', method: 'POST', body: {} }, exec).source_id, body.source_id);
});
