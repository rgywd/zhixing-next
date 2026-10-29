import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatRows, contentText, eventPresentation, liveText, mergeDshEvents, rowText, rowHasMessage } from '../src/dshProtocol.ts';
import { toolDetails } from '../src/toolPresentation.ts';

const event = (seq, type, data) => ({ seq, type, data });
const user = (seq, text) => event(seq, 'user/message', { id: `user-${seq}`, source: { kind: 'user' }, content: [{ type: 'text', text }] });
const answer = (seq, turn, step, content) => event(seq, 'assistant/message', { turn, step, message: { content } });

test('DSH replay deduplicates sequence numbers without dropping unknown tools or fields', () => {
  const first = { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'change code' }] } };
  const unknown = { seq: 1, type: 'future-plugin/output', data: { nested: { diff: '+42' } } };
  assert.deepEqual(mergeDshEvents([first, unknown], [unknown]), [first, unknown]);
  assert.equal(eventPresentation(unknown).quiet, false);
  assert.equal(eventPresentation(first).text, 'change code');
});

test('DSH tool failures and cancelled partial replies do not render as success', () => {
  const failed = { type: 'tool/result', data: { message: { isError: true, content: [{ type: 'text', text: 'exit 1' }] } } };
  assert.equal(eventPresentation(failed).title, '工具执行失败');
  assert.equal(eventPresentation(failed).text, 'exit 1');
  assert.equal(eventPresentation({ type: 'assistant/message', data: { interrupted: true, message: { content: [{ type: 'text', text: 'partial' }] } } }).title, '知行 · 已中断');
});

test('DSH live text consumes only public text deltas and disappears on settlement', () => {
  assert.equal(liveText({ live: { chunks: [{ type: 'text-delta', text: 'hello' }, { type: 'tool-call-delta', argumentsDelta: '{}' }, { type: 'text-delta', text: ' world' }] } }), 'hello world');
  assert.equal(liveText({ live: null }), '');
  assert.match(contentText([{ type: 'file', attachment: { name: 'sample.js' } }]), /sample.js/);
});

test('conversation projection groups real tool receipts and reasoning with the assistant answer', () => {
  const events = [event(0, 'turn/start', { turn: 1 }), user(1, '修复代码'),
    event(2, 'user/message', { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'internal' }] }),
    answer(3, 1, 1, [{ type: 'reasoning', text: '检查文件' }, { type: 'tool-call', id: 'a', name: 'read' }]),
    event(4, 'tool/call', { turn: 1, callId: 'a', name: 'read' }),
    event(5, 'future-plugin/output', { result: 42 }),
    event(6, 'tool/result', { turn: 1, message: { toolCallId: 'a', isError: true } }),
    answer(7, 1, 2, [{ type: 'text', text: '读取失败，请检查路径。' }]), event(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } })];
  const before = JSON.stringify(events), rows = chatRows(events, null);
  assert.deepEqual(rows.map(r => r.role), ['user', 'assistant']);
  assert.equal(rowText(rows[1]), '读取失败，请检查路径。');
  assert.deepEqual(rows[1].parts.map(p => p.type), ['reasoning', 'tool', 'text']);
  assert.equal(rows[1].parts[1].status, 'failed');
  assert.equal(rows[1].events.find(e => e.type === 'future-plugin/output').data.result, 42);
  assert.equal(JSON.stringify(events), before, 'rendering must not mutate native records');
});

test('streaming and durable answers use one conversation row without repeating settled text', () => {
  const events = [event(0, 'turn/start', { turn: 1 }), user(1, 'hello')];
  const live = { turn: 1, step: 1, attemptId: 'a', chunks: [{ type: 'reasoning-delta', index: 0, text: 'thinking' }, { type: 'text-delta', index: 1, text: 'hello' }] };
  const streaming = chatRows(events, { running: true, live });
  assert.equal(streaming[1].active, true); assert.equal(rowText(streaming[1]), 'hello');
  events.push(answer(2, 1, 1, [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'hello world' }]));
  const settled = chatRows(events, { running: true, live });
  assert.equal(settled[1].id, streaming[1].id); assert.equal(rowText(settled[1]), 'hello world');
  events.push(event(3, 'turn/end', { turn: 1, reason: { kind: 'aborted' } }));
  const cancelled = chatRows(events, { running: false, live: null });
  assert.equal(cancelled[1].status, 'cancelled'); assert.equal(cancelled[1].active, false);
});

test('images remain structured, queued prompts stay ordered, and steering starts a new assistant segment', () => {
  const events = [event(0, 'turn/start', { turn: 1 }), user(1, 'first'), answer(2, 1, 1, [{ type: 'text', text: 'before steering' }]),
    user(3, 'steer'), answer(4, 1, 2, [{ type: 'text', text: 'after steering' }]), event(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event(6, 'turn/start', { turn: 2 }), event(7, 'user/message', { source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'photo', name: 'one.png', bytes: 42 } }] }),
    answer(8, 2, 1, [{ type: 'text', text: 'image reply' }])];
  const rows = chatRows(events, { running: true, live: null });
  assert.deepEqual(rows.map(rowText), ['first', 'before steering', 'steer', 'after steering', '', 'image reply']);
  assert.equal(rows[4].attachments[0].id, 'photo');
  assert.equal(rows.at(-1).active, true); assert.equal(rows[3].active, false);
});

test('late background events do not move the active turn back into an older reply', () => {
  const events = [event(0, 'turn/start', { turn: 1 }), user(1, 'first'), answer(2, 1, 1, [{ type: 'text', text: 'done' }]),
    event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), event(4, 'turn/start', { turn: 2 }), user(5, 'next'),
    event(6, 'job/completed', { turn: 1, result: 'old background job' })];
  const rows = chatRows(events, { running: true, live: null });
  assert.equal(rows.at(-1).active, true); assert.match(rows.at(-1).id, /^turn:2:/);
  assert.equal(rows[1].active, false); assert.equal(rows[1].events.at(-1).type, 'job/completed');
});

test('tool details retain native arguments, failed outputs and metadata across replay without call-ID collisions', () => {
  const events = [event(0, 'turn/start', { turn: 1 }), user(1, 'inspect'),
    { ...event(2, 'tool/call', { turn: 1, callId: 'same', name: 'custom_plugin', arguments: '{"q":"中文"}' }), time: 100 },
    { ...event(3, 'tool/result', { turn: 1, message: { toolCallId: 'same', isError: true, content: [{ type: 'text', text: 'Permission denied' }, { type: 'custom', value: 42 }] }, error: { reason: 'denied' }, meta: { retryable: true } }), time: 123 },
    event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), event(5, 'turn/start', { turn: 2 }), user(6, 'retry'),
    event(7, 'tool/call', { turn: 2, callId: 'same', name: 'bash', arguments: '{"command":"false"}' }),
    event(8, 'tool/result', { turn: 2, message: { toolCallId: 'same', content: [{ type: 'text', text: 'shell output' }] }, meta: { exitCode: 1 } })];
  const before = JSON.stringify(events), rows = chatRows(events, null);
  const first = rows[1].parts[0], second = rows[3].parts[0];
  assert.equal(first.status, 'failed'); assert.equal(second.status, 'completed');
  const detail = toolDetails(first);
  assert.match(detail.input, /中文/); assert.match(detail.output, /Permission denied/); assert.match(detail.output, /42/);
  assert.match(detail.error, /denied/); assert.equal(detail.duration, 23);
  assert.equal(toolDetails(second).exitCode, 1);
  assert.equal(toolDetails({ ...second, detail: {} }).exitCode, null, 'no invented shell exit status');
  assert.equal(JSON.stringify(events), before);
});

test('native edit metadata shows actual before and after, and plain plugin arguments survive', () => {
  const detail = toolDetails({ type: 'tool', name: 'edit', detail: { input: '{incomplete', meta: { path: 'a.ts', diffs: [{ oldText: 'a = 0', newText: 'a = 42' }] } } });
  assert.equal(detail.input, '{incomplete'); assert.deepEqual(detail.diffs, [{ path: 'a.ts', before: 'a = 0', after: 'a = 42' }]);
});

test('message focus distinguishes steering segments sharing the same turn log, including sequence zero', () => {
  const events = [user(0, 'first'), event(1, 'turn/start', { turn: 1 }), answer(2, 1, 1, [{ type: 'text', text: 'before' }]),
    user(3, 'steer'), answer(4, 1, 2, [{ type: 'text', text: 'after' }])];
  const rows = chatRows(events, null);
  assert.equal(rows.findIndex(row => rowHasMessage(row, 0)), 0);
  assert.equal(rows.findIndex(row => rowHasMessage(row, 4)), 3);
  assert.equal(rows.findIndex(row => rowHasMessage(row, 2)), 1);
});

test('published workspace files attach to the matching tool reply without changing native event sequences', () => {
  const events = [event(0, 'turn/start', { turn: 1 }), user(1, 'create file'),
    event(2, 'tool/call', { turn: 1, callId: 'write', name: 'write', arguments: '{}' }),
    event(3, 'tool/result', { turn: 1, message: { toolCallId: 'write', content: [] } }),
    event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } })];
  const ref = { type: 'file', attachment: { attachmentId: 'file-a', name: 'result.bin', bytes: 7 } };
  const rows = chatRows(events, { artifacts: [{ id: 'p1', toolSeq: 2, content: [ref] }, { id: 'p2', toolSeq: 2, content: [ref] },
    { id: 'foreign', toolSeq: 999, content: [{ ...ref, attachment: { ...ref.attachment, attachmentId: 'foreign' } }] }] });
  assert.equal(rows[1].attachments.length, 1); assert.equal(rows[1].attachments[0].id, 'file-a');
  assert.deepEqual(rows[1].events.map(e => e.seq), [0, 1, 2, 3, 4]); assert.equal(events.length, 5);
});
test('native fork closers do not create phantom failed replies before the edited user message', () => {
  const rows = chatRows([event(0, 'turn/start', { turn: 1 }), event(1, 'turn/end', { turn: 1, reason: { kind: 'forked' } }), user(2, 'edited')], null);
  assert.equal(rows.length, 1); assert.equal(rows[0].role, 'user');
});
