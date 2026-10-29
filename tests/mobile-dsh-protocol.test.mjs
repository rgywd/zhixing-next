import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentText, eventPresentation, liveText, mergeDshEvents } from '../src/dshProtocol.ts';

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
