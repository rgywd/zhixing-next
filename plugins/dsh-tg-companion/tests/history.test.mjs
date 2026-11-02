import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Session } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createCompanion } from '../index.mjs';
import { cleanLegacyMessage, LEGACY_RELAY_PREFIX, migrateLegacyRelay } from '../../dsh-messenger-persona/legacy-relay.mjs';

test('companion recalls original user turns once, without obsolete relay instructions or replacement timestamps', async () => {
  const session = Session.create('msgw-history');
  const source = { kind: 'user', plugin: 'dsh-messenger-gateway', form: 'relay', origin: 'telegram' };
  const first = session.append('user/message', createUserMessage({ source, content: [{ type: 'text', text: LEGACY_RELAY_PREFIX + '\n\n以前的话' }] }), { surfaceOp: 'append' });
  session.append('user/message', createUserMessage({ source: { ...source, kind: 'runtime-context' }, content: [{ type: 'text', text: '内部上下文' }] }), { surfaceOp: 'append' });
  const ctx = { agents: { get: () => undefined }, get: () => ({ cleanLegacyMessage }), sessionPersistence: { open: async () => ({
    read: async (offset, limit) => ({ events: session.snapshotEvents(offset, Math.min(offset + limit, session.seq)) }), close: async () => {},
  }) } };
  const companion = createCompanion(ctx, {}, { get: () => ({ sessionIds: [session.id] }) });
  const expected = [{ role: 'user', text: '以前的话', at: first.time, seq: first.seq }];
  assert.deepEqual(await companion.recent(session.id), expected, 'inactive old sessions are cleaned too');
  migrateLegacyRelay(session);
  assert.deepEqual(await companion.recent(session.id), expected, 'model-only replacement is not a new user turn');
  await assert.rejects(companion.recent('msgw-someone-else'), /does not belong/);
});

test('a large migration tail does not move the active transcript past its last real message', async () => {
  const session = Session.create('msgw-long-history');
  const source = { kind: 'user', plugin: 'dsh-messenger-gateway', form: 'relay', origin: 'telegram' };
  for (let i = 0; i < 600; i++) session.append('user/message', createUserMessage({ source,
    content: [{ type: 'text', text: LEGACY_RELAY_PREFIX + '\n\n消息' + i }] }), { surfaceOp: 'append' });
  migrateLegacyRelay(session);
  const ctx = { agents: { get: () => ({ session }) }, sessions: { flush: async () => {} }, get: () => ({ cleanLegacyMessage }),
    sessionPersistence: { open: async () => ({
      read: async (offset, limit) => ({ events: session.snapshotEvents(offset, Math.min(offset + limit, session.seq)) }), close: async () => {},
    }) } };
  const companion = createCompanion(ctx, {}, { get: () => ({ sessionIds: [session.id] }) });
  const recent = await companion.recent(session.id, 14);
  assert.deepEqual(recent.map(row => row.text), Array.from({ length: 14 }, (_, i) => '消息' + (586 + i)));
});
