import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';
import { cacheHarness } from './helpers/local-cache.mjs';
import * as permissions from '../src/dshPermissions.ts';
import * as theme from '../src/theme.ts';

const plain = value => JSON.parse(JSON.stringify(value));
const connection = { url: 'https://settings.test', token: 'test-only-token' };
const settings = (mode = 'queue', revision = 'host:0') => ({ writable: true,
  permission: { value: 'read-only', options: ['read-only', 'workspace-write', 'danger-full-access'], revision },
  busy: { value: mode, options: ['queue', 'steer'], revision } });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
function load(file, dependencies) {
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, Date, Error, require: name => { assert.ok(name in dependencies, name); return dependencies[name]; } });
  return exports;
}
function harness({ cache = cacheHarness(), read = async () => settings(), write = async () => settings('steer', 'host:1') } = {}) {
  const calls = [];
  const api = { request: async (target, path, options) => {
    calls.push({ target, path, ...options });
    return options?.method === 'PUT' ? write(options.body) : read();
  } };
  const exported = load('dshSettings.ts', { './api': api, './localCache': cache });
  const create = (target = connection) => exported.createDshSettingsStore(target);
  return { ...exported, cache, calls, create, store: create() };
}

test('fresh persistent settings restore after process restart without fetching, then expire and revalidate', async t => {
  const root = mkdtempSync(join(tmpdir(), 'settings-cache-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const filename = join(root, 'cache.db'), first = harness({ cache: cacheHarness(filename) });
  await first.store.refresh(); first.cache.close();
  const second = harness({ cache: cacheHarness(filename) }); t.after(() => second.cache.close());
  await second.store.refresh(); await second.store.refresh();
  assert.equal(second.calls.length, 0); assert.equal(second.store.getSnapshot().snapshot.settings.busy.value, 'queue');
  await second.cache.writeCache(connection, second.settingsCacheKey, { settings: settings(), checkedAt: Date.now() - second.settingsMaxAge - 1 });
  const expired = second.create(); await expired.refresh();
  assert.equal(second.calls.length, 1); assert.ok(expired.getSnapshot().snapshot.checkedAt > Date.now() - 1000);
});

test('overlapping reads share a request and offline failure retains cached values without queuing writes', async t => {
  const read = deferred(), app = harness({ read: () => read.promise }); t.after(() => app.cache.close());
  await app.cache.writeCache(connection, app.settingsCacheKey, { settings: settings('steer'), checkedAt: 1 });
  const first = app.store.refresh(); await settle(); const second = app.store.refresh();
  assert.equal(app.calls.length, 1); assert.equal(app.store.getSnapshot().snapshot.settings.busy.value, 'steer');
  read.reject(new Error('offline')); await Promise.all([first, second]);
  assert.equal(app.store.getSnapshot().snapshot.settings.busy.value, 'steer'); assert.match(app.store.getSnapshot().error, /offline/);
  assert.equal(app.calls.some(call => call.method === 'PUT'), false);
});

test('save waits for cloud acknowledgement, prevents double taps, caches the accepted response and defeats stale reads', async t => {
  const read = deferred(), write = deferred(); let slow = false;
  const app = harness({ read: () => slow ? read.promise : settings(), write: () => write.promise }); t.after(() => app.cache.close());
  await app.store.refresh(); slow = true;
  const oldRead = app.store.refresh(true); await settle();
  const saving = app.store.select('busy', 'steer'); await app.store.select('permission', 'workspace-write');
  assert.equal(app.store.getSnapshot().snapshot.settings.busy.value, 'queue');
  assert.equal(app.calls.filter(call => call.method === 'PUT').length, 1);
  assert.deepEqual(plain(app.calls.at(-1).body), { key: 'busy', value: 'steer', revision: 'host:0' });
  write.resolve(settings('steer', 'host:1')); await saving;
  read.resolve(settings()); await oldRead;
  assert.equal(app.store.getSnapshot().snapshot.settings.busy.value, 'steer');
  assert.equal((await app.cache.readCache(connection, app.settingsCacheKey)).settings.busy.value, 'steer');
});

test('a failed or conflicting save preserves confirmed data and retry reads the other device without resending', async t => {
  let cloud = settings();
  const app = harness({ read: () => cloud, write: () => { throw new Error('云端设置已更新，请刷新后再选择。'); } }); t.after(() => app.cache.close());
  await app.store.refresh(); await app.store.select('busy', 'steer');
  assert.equal(app.store.getSnapshot().snapshot.settings.busy.value, 'queue'); assert.match(app.store.getSnapshot().error, /云端设置已更新/);
  cloud = settings('steer', 'host:4'); await app.store.refresh(true);
  assert.equal(app.store.getSnapshot().snapshot.settings.busy.value, 'steer'); assert.equal(app.store.getSnapshot().error, '');
  assert.equal(app.calls.filter(call => call.method === 'PUT').length, 1);
});

test('an old connection lifetime cannot replace a newer cache response after reconnecting to the same account', async t => {
  const old = deferred(); let slow = false;
  const app = harness({ read: () => slow ? old.promise : settings() }); t.after(() => app.cache.close());
  await app.store.refresh(); slow = true;
  const older = app.store.refresh(true); await settle();
  const reconnected = app.create(); await reconnected.refresh(); await reconnected.select('busy', 'steer');
  old.resolve(settings()); await older;
  assert.equal((await app.cache.readCache(connection, app.settingsCacheKey)).settings.busy.value, 'steer');
});

test('cache identities include URL and token and never contain the plaintext token', async t => {
  const app = harness(); t.after(() => app.cache.close()); await app.store.refresh();
  for (const target of [{ ...connection, token: 'another-account' }, { ...connection, url: 'https://another.test' }]) {
    const fresh = app.create(target); assert.equal(fresh.getSnapshot().snapshot, null); await fresh.refresh();
  }
  assert.equal(app.calls.length, 3);
  const rows = app.cache.db.prepare('SELECT * FROM snapshots').all();
  assert.equal(rows.length, 3); assert.ok(!JSON.stringify(rows).includes(connection.token));
});

test('failed disk cache writes do not turn a confirmed cloud save into a failed setting', async t => {
  const cache = cacheHarness(); t.after(() => cache.close());
  const app = harness({ cache: { ...cache, writeCache: async () => { throw new Error('disk full'); } } });
  await app.store.refresh(); await app.store.select('busy', 'steer');
  assert.equal(app.store.getSnapshot().snapshot.settings.busy.value, 'steer');
  assert.equal(app.store.getSnapshot().error, ''); assert.match(app.store.getSnapshot().cacheWarning, /缓存未保存/);
});

test('corrupt cache, clock reversal and unsupported service never fabricate a selection', async t => {
  const app = harness({ read: () => ({ error: 'old service' }) }); t.after(() => app.cache.close());
  await app.cache.writeCache(connection, app.settingsCacheKey, { settings: { writable: true }, checkedAt: Date.now() });
  await app.store.refresh(); assert.equal(app.store.getSnapshot().snapshot, null); assert.match(app.store.getSnapshot().error, /配置无效/);
  await app.cache.writeCache(connection, app.settingsCacheKey, { settings: settings(), checkedAt: Date.now() + 100000 });
  const next = app.create(); await next.refresh(); assert.equal(app.calls.length, 2);
});

test('read-only and unavailable settings cannot be submitted', async t => {
  const app = harness({ read: () => ({ writable: false, permission: null, busy: null }) }); t.after(() => app.cache.close());
  await app.store.refresh(); await app.store.select('permission', 'danger-full-access');
  assert.equal(app.calls.length, 1);
});

const walk = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
test('settings panel shows cloud options, inline errors, unavailable and disconnected states with no local fallback', () => {
  const { ChatSettingsPanel } = load('ChatSettingsPanel.tsx', {
    'react/jsx-runtime': jsxRuntime, 'react-native': { Pressable: 'Pressable', Text: 'Text', View: 'View' },
    '@react-native-vector-icons/ionicons': { Ionicons: 'Ionicons' }, './dshPermissions': permissions, './theme': theme,
    './ui': { useUi: () => ({ s: {}, colors: theme.lightColors }), ActionLink: 'ActionLink', PageHeading: 'PageHeading', PageScrollView: 'PageScrollView', SettingsGroup: 'SettingsGroup' },
  });
  const writes = [], refreshes = [];
  const controller = { snapshot: { settings: settings(), checkedAt: 1 }, error: 'save failed', select: (...args) => writes.push(args), refresh: (...args) => refreshes.push(args) };
  let nodes = walk(ChatSettingsPanel({ controller }));
  assert.equal(nodes.filter(n => n.props.accessibilityRole === 'radio').length, 5);
  assert.equal(nodes.filter(n => n.props.accessibilityState?.checked).length, 2);
  nodes.find(n => n.props.accessibilityLabel?.startsWith('插话发送')).props.onPress(); assert.deepEqual(writes, [['busy', 'steer']]);
  nodes.find(n => n.type === 'ActionLink').props.onPress(); assert.deepEqual(refreshes, [[true]]);
  assert.equal(nodes.find(n => n.props.accessibilityRole === 'alert').props.children, 'save failed');
  controller.saving = 'busy'; nodes = walk(ChatSettingsPanel({ controller }));
  assert.ok(nodes.filter(n => n.props.accessibilityRole === 'radio').every(n => n.props.disabled));
  assert.equal(walk(ChatSettingsPanel({})).filter(n => n.props.accessibilityRole === 'radio').length, 0);
});
