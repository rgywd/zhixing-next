import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModelSettings, resolveSelection, modelProtocols } from '../models.mjs';

function fixture() {
  const descriptors = [
    { ns: 'agent-default-model', revision: 1, value: { provider: 'one', model: 'first', reasoningEffort: 'high' } },
    { ns: 'dsh-messenger-gateway', revision: 2, value: { agent: { provider: '', model: '', instructionPrefix: 'keep' }, telegram: { botToken: 'private', allowedUserIds: [123] } } },
    { ns: 'llm-pi-ai', value: { providers: { one: { api: 'openai-responses' } } } },
  ];
  let busy = false;
  const settings = { writable: true, describe: options => { assert.equal(options.redactSecrets, true); return descriptors; },
    async mutate(ns, ops, revision) {
      const view = descriptors.find(v => v.ns === ns);
      if (view.revision !== revision) throw Object.assign(new Error(), { code: 'SETTINGS_CONFLICT' });
      for (const op of ops) {
        let obj = view.value;
        for (const key of op.path.slice(0, -1)) obj = obj[key] ??= {};
        if (op.op === 'unset') delete obj[op.path.at(-1)]; else obj[op.path.at(-1)] = op.value;
      }
      view.revision++;
    } };
  const ctx = { get: name => ({ settings, agentDefaultModel: { currentSelection: () => descriptors[0].value },
    zhixingCompanion: { isBusy: () => busy } })[name],
    sessionController: { modelCatalog: async () => ({ default: descriptors[0].value, routableProviders: ['one'],
      groups: [{ id: 'one', models: [{ id: 'first' }, { id: 'second' }] }, { id: 'missing-key', models: [{ id: 'no' }] }] }) },
    llm: { resolveCallConfig: async selection => { if (selection.reasoningEffort === 'invalid') throw new Error(); } } };
  const service = createModelSettings(ctx);
  const write = (key, model_id) => service.write({ key, model_id, revision: service.read()[key].revision });
  return { ctx, settings, descriptors, service, write, busy: value => { busy = value; } };
}
const first = JSON.stringify(['one', 'first']), second = JSON.stringify(['one', 'second']);

test('default and Telegram choices persist independently; unrelated config and secrets stay untouched', async () => {
  const f = fixture();
  assert.equal(JSON.stringify(f.service.read()).includes('private'), false);
  assert.equal(f.service.read().telegram.model_id, null);
  await f.write('telegram', first);
  await f.write('default', second);
  assert.equal(f.service.read().telegram.effective_model_id, first);
  assert.equal(f.service.read().default.model_id, second);
  assert.equal(f.descriptors[0].value.reasoningEffort, undefined);
  assert.deepEqual(f.descriptors[1].value.telegram, { botToken: 'private', allowedUserIds: [123] });
  assert.equal(f.descriptors[1].value.agent.instructionPrefix, 'keep');
  await f.write('telegram', null);
  assert.equal(f.service.read().telegram.effective_model_id, second);
  assert.equal(modelProtocols(f.ctx).get('one'), 'responses');
});

test('stale pages, unavailable models, busy Telegram and failed writes never report success', async () => {
  const f = fixture(), revision = f.service.read().default.revision;
  await f.write('default', second);
  await assert.rejects(f.service.write({ key: 'default', model_id: first, revision }), { status: 409 });
  await assert.rejects(f.write('default', JSON.stringify(['missing-key', 'no'])), { status: 409 });
  await assert.rejects(f.write('default', JSON.stringify(['one', 'invented'])), { status: 409 });
  await assert.rejects(resolveSelection(f.ctx, first, 'invalid'), { status: 409 });
  f.busy(true); await assert.rejects(f.write('telegram', first), { status: 409 }); f.busy(false);
  f.settings.mutate = async () => { throw new Error('disk full'); };
  await assert.rejects(f.write('default', first), { status: 503 });
  assert.equal(f.service.read().default.model_id, second);
  f.settings.mutate = async () => {};
  await assert.rejects(f.write('default', first), { status: 409 });
  f.settings.writable = false;
  await assert.rejects(f.write('default', first), { status: 503 });
  assert.notEqual(createModelSettings(f.ctx).read().default.revision, f.service.read().default.revision);
});
