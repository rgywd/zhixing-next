import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Session, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session';
import { createUserMessage, createSystemMessage } from '@deepseek-ai/dsh-llm';
import { cleanLegacyMessage, LEGACY_RELAY_PREFIX, migrateLegacyRelay } from '../legacy-relay.mjs';

const source = { kind: 'user', plugin: 'dsh-messenger-gateway', form: 'relay', origin: 'telegram' };
const message = (text, override = {}) => createUserMessage({ source, content: [{ type: 'text', text }], ...override });

test('removes only the exact gateway envelope and preserves the complete payload', () => {
  const tail = '[Replying to message: 之前那句]\n\n  我引用：' + LEGACY_RELAY_PREFIX + '\n末尾  ';
  const original = message('', { content: [{ type: 'text', text: LEGACY_RELAY_PREFIX + '\n\n' + tail },
    { type: 'image', attachment: { id: 'original-attachment' } }] });
  const cleaned = cleanLegacyMessage(original);
  assert.equal(cleaned.id, original.id);
  assert.equal(cleaned.source, original.source);
  assert.equal(cleaned.content[0].text, tail);
  assert.equal(cleaned.content[1], original.content[1]);
  assert.equal(original.content[0].text, LEGACY_RELAY_PREFIX + '\n\n' + tail);
  assert.equal(cleanLegacyMessage(cleaned), cleaned);
});

test('does not strip user quotations, other sources, partial matches or other blocks', () => {
  const text = LEGACY_RELAY_PREFIX + '\n\n在';
  for (const original of [
    message('看这段：\n' + text), message(LEGACY_RELAY_PREFIX + '\n在'), message(LEGACY_RELAY_PREFIX + '\n\n'),
    message(text.replace('三月七', '别的角色')),
    message(text, { source: { ...source, plugin: 'zhixing-app' } }),
    message(text, { source: { ...source, origin: 'discord' } }),
    message(text, { source: { ...source, kind: 'runtime-context' } }),
    message(text, { source: { ...source, form: 'direct' } }),
    message('在', { content: [{ type: 'text', text: '用户原话' }, { type: 'text', text }] }),
  ]) assert.equal(cleanLegacyMessage(original), original);
});

test('native replacements retain raw transcript, attachment and order across restore; reruns are inert', () => {
  const session = Session.create('msgw-legacy-test');
  session.append('system/message', { turn: 0, step: 0, message: createSystemMessage('system') }, { surfaceOp: 'append' });
  const a = session.append('user/message', message(LEGACY_RELAY_PREFIX + '\n\n在'), { surfaceOp: 'append' });
  const b = session.append('user/message', message('Channel: Telegram.\n\n现在的原话'), { surfaceOp: 'append' });
  const original = session.snapshotEvents();
  assert.equal(migrateLegacyRelay(session), 1);
  assert.deepEqual(session.snapshotEvents(0, original.length), original);
  assert.deepEqual(session.deriveMessages().slice(1).map(m => m.content[0].text), ['在', 'Channel: Telegram.\n\n现在的原话']);
  const replacement = session.snapshotEvents().at(-1);
  assert.deepEqual(replacement.sourceEventSeqs, [a.seq]);
  assert.equal(replacement.data.id, a.data.id);
  assert.equal(session.deriveMessages().at(-1).id, b.data.id);
  assert.equal(session.snapshotEvents().filter(e => e.type === 'user/message' && isAppendSurfaceEvent(e)).length, 2);
  const restored = Session.create(session.id, JSON.parse(JSON.stringify(session.snapshotEvents())));
  assert.deepEqual(restored.deriveMessages(), session.deriveMessages());
  const before = restored.seq;
  assert.equal(migrateLegacyRelay(restored), 0);
  assert.equal(restored.seq, before);
});
