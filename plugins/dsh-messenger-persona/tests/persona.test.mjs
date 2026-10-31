import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPersonaFile, isMessengerAgent } from '../persona-file.mjs';
import { apply } from '../index.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'persona-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'persona.md');
  writeFileSync(file, '三月七：自然聊天。');
  return file;
}

test('atomic replacement changes the next assembly without restarting', t => {
  const file = fixture(t), card = openPersonaFile(file);
  assert.equal(card.read(), '三月七：自然聊天。');
  writeFileSync(file + '.next', '三月七：认真接住新话题。{{literal}}');
  renameSync(file + '.next', file);
  assert.equal(card.read(), '三月七：认真接住新话题。{{literal}}');
});

test('broken edits keep the last good card, log once and recover', t => {
  const file = fixture(t), warnings = [], card = openPersonaFile(file, message => warnings.push(message));
  writeFileSync(file, '');
  assert.equal(card.read(), '三月七：自然聊天。');
  assert.equal(card.read(), '三月七：自然聊天。');
  assert.equal(warnings.length, 1);
  writeFileSync(file, '新内容');
  assert.equal(card.read(), '新内容');
  rmSync(file);
  assert.equal(card.read(), '新内容');
  assert.equal(warnings.length, 2);
});

test('invalid initial cards fail visibly', t => {
  const file = fixture(t);
  for (const text of ['', '\0', '\uFFFD', '字'.repeat(9000)]) {
    writeFileSync(file, text);
    assert.throws(() => openPersonaFile(file));
  }
  rmSync(file);
  assert.throws(() => openPersonaFile(file));
});

test('only native messenger sessions qualify; child and App agents do not', () => {
  const agent = (id, header = {}) => ({ session: { id, header } });
  assert.equal(isMessengerAgent(agent('msgw-123')), true);
  for (const value of [undefined, {}, agent('zhixing-main-123'), agent('web-123'),
    agent('msgw-child', { origin: 'subagent' }), agent('msgw-child', { delegationDepth: 1 })]) {
    assert.equal(isMessengerAgent(value), false);
  }
});

test('existing, new and restored sessions mount once and dispose cleanly', t => {
  const file = fixture(t), sections = [], cleanups = [], handlers = {};
  function agent(id) {
    const lifecycle = {};
    return { session: { id, header: {} }, lifecycle, ctx: {
      on: (event, fn) => { lifecycle[event] = fn; },
      systemPrompt: {
        getSectionOrder: () => 0,
        section: value => {
          const entry = { ...value, active: true }; sections.push(entry);
          return () => { entry.active = false; };
        },
      },
    } };
  }
  const existing = agent('msgw-existing');
  apply({ agents: { list: () => [existing, agent('zhixing-main-test')] },
    on: (event, fn) => { handlers[event] = fn; }, effect: fn => cleanups.push(fn()) }, { personaFile: file });
  handlers['agent/created']({ agent: existing });
  assert.equal(sections.length, 2);
  assert.equal(sections[0].name, 'deployment:persona-prefix');
  assert.equal(sections[0].interpolate, false);
  writeFileSync(file, '同一会话已经更新');
  assert.equal(sections[0].text(), '同一会话已经更新');
  existing.lifecycle.dispose();
  assert.equal(sections[0].active, false);
  handlers['agent/created']({ agent: agent('msgw-existing') });
  assert.equal(sections.length, 4);
  cleanups.forEach(fn => fn());
  assert.ok(sections.every(section => !section.active));
});
