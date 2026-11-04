import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openState, eligible, HOUR } from '../state.mjs';
import { changePreferences, preferences } from '../preferences.mjs';
import { createCompanion } from '../index.mjs';
import { createProactive } from '../proactive.mjs';

const noon = Date.parse('2026-11-05T04:00:00Z');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'contact-settings-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'contact.json'), store = openState(path, 123, { now: noon - 3 * HOUR, seedSessionId: 'msgw-owner' });
  const tools = new Map();
  const companion = createCompanion({ tools: { register: t => tools.set(t.name, t) } }, {}, store);
  companion.mountControls();
  const invoke = (id, args, header = {}) => tools.get('companion_contact').execute(args, { agent: { id, session: { header } } }).then(JSON.parse);
  return { path, store, invoke, tools };
}
test('App, owner TG and native DSH share durable preferences; group/child access fails', async t => {
  const { path, store, invoke } = fixture(t);
  const before = store.get();
  const old = await invoke('zhixing-main-app', { action: 'status' });
  const saved = await invoke('zhixing-main-app', { action: 'configure', settings: {
    feeds: old.feeds.filter(f => f.publisher !== 'NASA'), excludedTopics: ['NASA'], interests: 'AI 和游戏', activeHours: { start: 12, end: 20 },
  } });
  assert.deepEqual(await invoke('msgw-owner', { action: 'status' }), saved);
  assert.deepEqual(preferences(openState(path, 123).get()), saved);
  assert.equal(saved.revision, 1);
  assert.equal(saved.feeds.length, 1);
  assert.deepEqual(store.get().sessionIds, before.sessionIds);
  assert.equal(store.get().memoryId, before.memoryId);
  assert.deepEqual(store.get().deliveries, before.deliveries);
  assert.equal((await invoke('native-web', { action: 'pause' })).enabled, false);
  await assert.rejects(invoke('msgw-group', { action: 'resume' }), /Owner/);
  await assert.rejects(invoke('native-child', { action: 'resume' }, { origin: 'subagent' }), /Owner/);
  assert.equal(store.get().enabled, false);
});
test('invalid configuration never persists and configured hours reach the actual eligibility check', async t => {
  const { store, invoke } = fixture(t);
  const before = store.get();
  for (const settings of [{ maxPerDay: 0 }, { feeds: [{ publisher: 'x', url: 'file:///etc/passwd', domains: ['x.example'] }] }, { activeHours: { start: 22, end: 22 } }, { unknown: true }]) {
    await assert.rejects(invoke('native-web', { action: 'configure', settings }));
    assert.deepEqual(store.get(), before);
  }
  await invoke('native-web', { action: 'configure', settings: { activeHours: { start: 14, end: 22 } } });
  assert.equal(eligible(store.get(), noon), 'quiet-hours');
  assert.equal(eligible(store.get(), noon + 2 * HOUR), null);
});
test('excluded topics never reach drafting, and a concurrent preference edit cancels the old draft', async t => {
  const { store } = fixture(t); let sent = 0;
  changePreferences(store, { action: 'configure', settings: { excludedTopics: ['NASA'] } });
  const check = createProactive({ store, clock: () => noon, isBusy: () => false,
    collect: async () => [{ id: 'space', publisher: 'NASA' }, { id: 'code', title: 'GitHub' }],
    generate: async candidates => {
      assert.deepEqual(candidates.map(c => c.id), ['code']);
      changePreferences(store, { action: 'configure', settings: { feeds: [] } });
      return JSON.stringify({ send: true, topicId: 'code', text: 'A draft' });
    }, send: async () => { sent++; return { message_id: 1 }; } });
  assert.equal((await check()).skipped, 'conversation-changed');
  assert.equal(sent, 0);
});
test('the news fetch consumer receives saved sources and filters excluded topics', async t => {
  const { store } = fixture(t), tools = new Map();
  changePreferences(store, { action: 'configure', settings: { feeds: [], excludedTopics: ['NASA'] } });
  const controller = createCompanion({ tools: { register: t => tools.set(t.name, t) } }, {}, store, {
    news: async options => {
      assert.deepEqual(options.feeds, []);
      return [{ title: 'NASA item', summary: '' }, { title: 'Unrelated topic', summary: '' }];
    },
  });
  controller.mountControls();
  const result = JSON.parse(await tools.get('companion_news').execute({}, { agent: { id: 'native-web', session: { header: {} } } }));
  assert.deepEqual(result.map(n => n.title), ['Unrelated topic']);
});
