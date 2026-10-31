import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatSettings } from '../settings.mjs';

function fixture() {
  const descriptors = [{ ns: 'permission', value: { defaultPreset: 'read-only', unrelated: 'keep' }, revision: 0 },
    { ns: 'ui-conversation', value: { busyEnter: 'queue', extra: true }, revision: 0 },
    { ns: 'provider', value: { apiKey: 'never-return-this' }, revision: 0 }];
  const calls = [];
  const settings = { writable: true, describe(options) { assert.equal(options.redactSecrets, true); return descriptors; },
    async mutate(ns, ops, revision) {
      calls.push({ ns, ops, revision }); const view = descriptors.find(d => d.ns === ns);
      assert.equal(revision, view.revision); view.value[ops[0].path[0]] = ops[0].value; view.revision++;
    } };
  const ctx = { get: name => name === 'settings' ? settings : name === 'permissionPresets' ? {
    catalog: () => ({ defaultPreset: 'read-only', defaultOptions: ['read-only', 'workspace-write', 'danger-full-access', 'custom'].map(value => ({ value })) }),
  } : undefined };
  return { descriptors, calls, settings, ctx, service: createChatSettings(ctx) };
}

test('exposes only requested scalar settings, native options and opaque revisions', () => {
  const f = fixture(), view = f.service.read();
  assert.ok(!JSON.stringify(view).includes('never-return-this')); assert.ok(!JSON.stringify(view).includes('unrelated'));
  assert.deepEqual(view.permission.options, ['read-only', 'workspace-write', 'danger-full-access', 'custom']);
  assert.equal(view.busy.value, 'queue');
});

test('writes one native path with revision protection and keeps unrelated configuration', async () => {
  const f = fixture(), view = f.service.read();
  const updated = await f.service.write({ key: 'permission', value: 'workspace-write', revision: view.permission.revision });
  assert.equal(updated.permission.value, 'workspace-write');
  assert.deepEqual(f.calls, [{ ns: 'permission', ops: [{ op: 'set', path: ['defaultPreset'], value: 'workspace-write' }], revision: 0 }]);
  assert.equal(f.descriptors[0].value.unrelated, 'keep');
  await assert.rejects(f.service.write({ key: 'permission', value: 'danger-full-access', revision: view.permission.revision }), e => e.status === 409);
  await assert.rejects(createChatSettings(f.ctx).write({ key: 'busy', value: 'steer', revision: view.busy.revision }), e => e.status === 409);
});

test('invalid, read-only and unavailable settings do not write; native conflict/failure never returns a success receipt', async () => {
  const f = fixture();
  for (const body of [null, { key: 'provider' }, { key: 'busy', value: 'steer' },
    { key: 'busy', value: 'invented', revision: f.service.read().busy.revision },
    { key: 'busy', value: 'steer', revision: f.service.read().busy.revision, apiKey: 'injected' }]) await assert.rejects(f.service.write(body));
  assert.equal(f.calls.length, 0);
  f.settings.writable = false;
  await assert.rejects(f.service.write({ key: 'busy', value: 'steer', revision: f.service.read().busy.revision }), e => e.status === 503);
  f.settings.writable = true;
  for (const error of [new Error('disk failed'), Object.assign(new Error('stale'), { code: 'SETTINGS_CONFLICT' })]) {
    f.settings.mutate = async () => { throw error; };
    await assert.rejects(f.service.write({ key: 'busy', value: 'steer', revision: f.service.read().busy.revision }), e => e.status === (error.code ? 409 : 400));
  }
  const absent = createChatSettings({ get: () => undefined });
  assert.throws(absent.read, e => e.status === 503); assert.equal(absent.busyBehavior(), 'queue');
});
