import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openState, eligible, HOUR, immediatePreference } from '../state.mjs';
import { createProactive } from '../proactive.mjs';
import { parseFeed, fetchNews, FEEDS } from '../news.mjs';

const noon = Date.parse('2026-10-30T04:00:00Z');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zhixing-companion-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'contact.json'); const store = openState(path, 12345, { now: noon - 3 * HOUR });
  return { path, store };
}
function runner(store, overrides = {}) {
  let sent = 0;
  const check = createProactive({ store, clock: () => noon, isBusy: () => false,
    collect: async () => [{ id: 'topic', title: 'A real topic' }],
    generate: async () => JSON.stringify({ send: true, topicId: 'topic', text: '之前聊的那个点，我想到一个小变化。' }),
    send: async () => { sent++; return { message_id: 8 }; }, ...overrides });
  return { check, sent: () => sent };
}

test('restart restores one contact and never resets the sent/unanswered ledger', async t => {
  const { path, store } = fixture(t); const run = runner(store);
  assert.equal((await run.check()).status, 'sent'); assert.equal(run.sent(), 1);
  const restored = openState(path, 12345);
  assert.equal(eligible(restored.get(), noon + 24 * HOUR), 'awaiting-reply');
  assert.throws(() => openState(path, 99999), /identity/);
  writeFileSync(path, '{'); assert.throws(() => openState(path, 12345));
});
test('window, daily ceiling and spacing survive a day boundary', t => {
  const { store } = fixture(t); const s = store.get();
  assert.equal(eligible(s, Date.parse('2026-10-30T01:59:00Z')), 'quiet-hours');
  assert.equal(eligible(s, Date.parse('2026-10-30T14:00:00Z')), 'quiet-hours');
  s.deliveries = [{ at: noon - 5 * HOUR, status: 'sent' }, { at: noon - 4 * HOUR, status: 'sent' }];
  assert.equal(eligible(s, noon), 'daily-limit');
  s.lastInboundAt = noon + 22 * HOUR;
  assert.equal(eligible(s, noon + 24 * HOUR), null);
});
test('no interesting candidate stays silent and throttles model calls', async t => {
  const { store } = fixture(t); const run = runner(store, { generate: async () => '{"send":false}' });
  assert.equal((await run.check()).skipped, 'nothing-worth-sending');
  assert.equal((await run.check()).skipped, 'check-cooldown'); assert.equal(run.sent(), 0);
});
test('an inbound reply or pause while drafting prevents stale delivery', async t => {
  const { store } = fixture(t);
  const run = runner(store, { generate: async () => {
    store.change(s => { s.inboundVersion++; s.lastInboundAt = noon; s.enabled = false; });
    return '{"send":true,"topicId":"topic","text":"A draft"}';
  } });
  assert.equal((await run.check()).skipped, 'paused'); assert.equal(run.sent(), 0);
});
test('network ambiguity is durable and never retried, including after restart', async t => {
  const { path, store } = fixture(t);
  const run = runner(store, { send: async () => { throw new Error('timeout after submission'); } });
  assert.equal((await run.check()).status, 'unknown');
  assert.equal(eligible(openState(path, 12345).get(), noon + 24 * HOUR), 'awaiting-reply');
});
test('a process crash with a sending claim also blocks a resend', t => {
  const { path, store } = fixture(t);
  store.change(s => { s.deliveries.push({ at: noon, status: 'sending' }); });
  assert.equal(eligible(openState(path, 12345).get(), noon + 24 * HOUR), 'awaiting-reply');
});
test('one check at a time and a late quiet-hours boundary prevent extra delivery', async t => {
  const { store } = fixture(t); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const run = runner(store, { generate: async () => { await gate; return '{"send":true,"topicId":"topic","text":"A draft"}'; } });
  const first = run.check();
  assert.equal((await run.check()).skipped, 'check-running');
  release(); await first; assert.equal(run.sent(), 1);
  store.change(s => { s.deliveries = []; s.lastCheckAt = 0; });
  let now = noon;
  const late = runner(store, { clock: () => now, generate: async () => {
    now = Date.parse('2026-10-30T14:00:00Z'); return '{"send":true,"topicId":"topic","text":"A draft"}';
  } });
  assert.equal((await late.check()).skipped, 'quiet-hours'); assert.equal(late.sent(), 0);
});
test('reply sequence acknowledges even identical timestamps; two genuine replies never bypass the daily cap', async t => {
  const { path, store } = fixture(t); let now = noon, topic = 1;
  const run = runner(store, { clock: () => now, collect: async () => [{ id: 'topic-' + topic }],
    generate: async () => JSON.stringify({ send: true, topicId: 'topic-' + topic, text: 'A new topic' }) });
  await run.check();
  store.change(s => { s.lastInboundAt = noon; s.inboundVersion++; });
  now += 4 * HOUR; topic++;
  assert.equal(eligible(openState(path, 12345).get(), now), null);
  assert.equal((await run.check()).status, 'sent');
  store.change(s => { s.lastInboundAt = now; s.inboundVersion++; });
  now += 4 * HOUR; topic++;
  assert.equal((await run.check()).skipped, 'daily-limit'); assert.equal(run.sent(), 2);
});
test('receipt write failure preserves the pre-send claim across restart', async t => {
  const { path } = fixture(t); let writes = 0;
  const { durableWrite } = await import('../state.mjs');
  const faulty = openState(path, 12345, { write: (p, data) => {
    if (++writes === 3) throw new Error('disk full after receipt'); durableWrite(p, data);
  } });
  const run = runner(faulty); await assert.rejects(run.check(), /disk full/);
  assert.equal(run.sent(), 1);
  assert.equal(openState(path, 12345).get().deliveries[0].status, 'sending');
  assert.equal(eligible(openState(path, 12345).get(), noon + 24 * HOUR), 'awaiting-reply');
});
test('write failure before delivery never sends or mutates in-memory state', async t => {
  const { path, store } = fixture(t);
  let writes = 0;
  const faulty = openState(path, 12345, { write: () => { if (++writes === 2) throw new Error('disk full'); } });
  const run = runner(faulty); await assert.rejects(run.check(), /disk full/);
  assert.equal(run.sent(), 0); assert.deepEqual(store.get().deliveries, []);
});
test('an invented topic/link is rejected and completed topics are not sent again', async t => {
  const { store } = fixture(t);
  const run = runner(store, { generate: async () => '{"send":true,"topicId":"invented","text":"https://bad.example"}' });
  await assert.rejects(run.check(), /Invalid/); assert.equal(run.sent(), 0);
  store.change(s => { s.lastCheckAt = 0; s.lastInboundAt = noon - 2 * HOUR; s.deliveries.push({ at: noon - 26 * HOUR, topicId: 'topic', status: 'sent' }); });
  assert.equal((await runner(store).check()).skipped, 'no-new-topic');
});
test('direct opt-out is immediate; quoted or reported text is not a control command', () => {
  assert.equal(immediatePreference('先别主动找我了。'), 'pause');
  assert.equal(immediatePreference('恢复主动聊天吧'), 'resume');
  assert.equal(immediatePreference('新闻里说“不要主动找我”是什么意思？'), null);
});
test('feed parsing requires recent dated items and publisher links; partial failure preserves good sources', async () => {
  const xml = '<rss><item><title><![CDATA[A &amp; B]]></title><link>https://www.nasa.gov/story</link><pubDate>Fri, 30 Oct 2026 03:00:00 GMT</pubDate><description><![CDATA[<p>Observed result.</p>]]></description></item>' +
    '<item><title>Old</title><link>https://www.nasa.gov/old</link><pubDate>1 Jan 2020 00:00:00 GMT</pubDate></item>' +
    '<item><title>Bad</title><link>http://127.0.0.1/secret</link><pubDate>Fri, 30 Oct 2026 03:00:00 GMT</pubDate></item></rss>';
  const news = parseFeed(xml, FEEDS[0], noon);
  assert.equal(news.length, 1); assert.equal(news[0].title, 'A & B');
  const result = await fetchNews({ now: noon, fetchImpl: async url => {
    if (url.includes('github')) throw new Error('offline'); return new Response(xml);
  } });
  assert.equal(result.length, 1);
});
