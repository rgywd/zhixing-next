import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';
import * as protocol from '../src/dshProtocol.ts';

const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
const walk = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
function hooks() {
  const slots = []; let cursor = 0, effects = [];
  const changed = (a, b) => !a || !b || a.length !== b.length || b.some((item, i) => item !== a[i]);
  return { react: {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (changed(old?.deps, deps)) { slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); } },
    useCallback(fn, deps) { const i = cursor++; if (changed(slots[i]?.deps, deps)) slots[i] = { deps, fn }; return slots[i].fn; },
  }, render(fn) { cursor = 0; effects = []; const result = fn(); effects.forEach(effect => effect()); return result; }, unmount() { slots.forEach(slot => slot?.cleanup?.()); } };
}
function harness({ store = { draft: { text: 'fix this', pending: null } }, post = async () => {}, clear = async () => {} } = {}) {
  const lifecycle = hooks(), calls = [], uploads = [], removed = [], cache = [], exports = {};
  let uuid = 0, tick;
  const snapshot = { events: [], next: 0, hasMore: false, running: false, active: true, queue: [], pending: [], live: null };
  const report = () => {};
  const dependencies = {
    react: lifecycle.react, 'react/jsx-runtime': jsxRuntime,
    'react-native': { ...Object.fromEntries(['FlatList', 'Pressable', 'Text', 'TextInput', 'View'].map(n => [n, n])), Linking: {}, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } },
    'expo-crypto': { randomUUID: () => `request-${++uuid}` }, 'expo-document-picker': {}, 'expo-image-picker': {},
    'expo-file-system': { Paths: { document: 'file:///private/' }, Directory: class { constructor(...parts) { this.uri = parts.map(p => p.replace(/\/$/, '')).join('/'); this.exists = true; } delete() { removed.push(this.uri); } }, File: class { async bytes() { return new Uint8Array([1, 2]); } } },
    'expo/fetch': { fetch: async (url, options) => { uploads.push({ url, options }); return { ok: true, json: async () => ({ receiptId: `upload-${uploads.length}` }) }; } },
    './api': { request: async (_connection, path, options) => {
      calls.push({ path, ...options });
      if (path.includes('/dsh?')) return plain(snapshot);
      await post(path, options); return {};
    } },
    './storage': { draftKey: () => 'draft', readDraft: async () => plain(store.draft), saveDraft: async (_key, value) => { store.draft = plain(value); },
      clearDraft: async (_key, id) => { await clear(id); if (store.draft.pending?.id === id) store.draft = { text: '', pending: null }; } },
    './localCache': { readCache: async () => null, writeCache: async (_connection, _key, value) => cache.push(plain(value)) },
    './ConnectionStatus': { useSyncStatus: () => report }, './dshProtocol': protocol, './chatPhotos': { discardDraftPhotos() {} },
    './ui': { useUi: () => ({ s: {}, colors: {} }), humanError: e => e.message, ActionLink: 'ActionLink', Button: 'Button' },
  };
  for (const component of ['MessageBody', 'ConversationComposer', 'BottomSheet', 'ModelPicker', 'ReasoningPicker']) dependencies[`./${component}`] = { [component]: component };
  dependencies['./PhotoAttachments'] = { DraftAttachments: 'DraftAttachments' };
  runInNewContext(ts.transpileModule(readFileSync(new URL('../src/DshChatPanel.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, AbortController, Uint8Array, encodeURIComponent, setInterval: fn => { tick = fn; return 1; }, clearInterval() {}, require: name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name];
  } });
  const props = { connection: { url: 'https://example.test', token: 'test' }, conversation: { id: 'zhixing-main-aaaa', model_id: null }, assistantName: '知行', catalog: null, onRefresh() {}, onConversationChanged() {} };
  const render = () => walk(lifecycle.render(() => exports.DshChatPanel(props)));
  return { render, store, calls, uploads, removed, cache, snapshot, tick: () => tick(), composer: () => render().find(n => n.type === 'ConversationComposer').props, unmount: lifecycle.unmount };
}

test('DSH send retains the accepted request ID until draft clearing is durable', async () => {
  let attempts = 0;
  const app = harness({ clear: async () => { if (++attempts === 1) throw new Error('disk busy'); } });
  app.render(); await settle();
  app.composer().onSend(); await settle();
  const pending = plain(app.store.draft.pending);
  assert.ok(pending.id); assert.equal(app.composer().pending, true); assert.equal(app.composer().text, 'fix this');
  app.composer().onSend(); await settle();
  const posts = app.calls.filter(c => c.path.endsWith('/messages'));
  assert.equal(posts.length, 2); assert.equal(posts[0].body.id, posts[1].body.id);
  assert.equal(app.store.draft.pending, null); assert.equal(app.composer().text, '');
  app.unmount();
});

test('DSH attachment retries survive remount and send native receipts with the same request ID', async () => {
  const store = { draft: { text: 'photo', pending: null, files: [{ id: 'aaaa', name: 'photo.png', uri: 'file:///private/dsh-drafts/aaaa/attachment', mediaType: 'image/png' }] } };
  const first = harness({ store, post: async () => { throw new Error('lost reply'); } });
  first.render(); await settle(); first.composer().onSend(); await settle();
  const id = store.draft.pending.id; assert.equal(first.removed.length, 0); first.unmount();
  const restored = harness({ store }); restored.render(); await settle(); restored.composer().onSend(); await settle();
  const post = restored.calls.find(c => c.path.endsWith('/messages'));
  assert.equal(post.body.id, id); assert.deepEqual(plain(post.body.parts), [{ type: 'text', text: 'photo' }, { type: 'file', receiptId: 'upload-1' }]);
  assert.match(restored.uploads[0].url, /mediaType=image%2Fpng/); assert.equal(store.draft.pending, null);
  assert.equal(restored.removed.length, 1); restored.unmount();
});

test('DSH rendering preserves opaque events, persists only new data, and waits for cancel acknowledgement', async () => {
  let finish;
  const app = harness({ post: async path => { if (path.endsWith('/cancel')) await new Promise(resolve => { finish = resolve; }); } });
  app.snapshot.running = true;
  app.snapshot.events = [{ seq: 0, type: 'plugin/custom', data: { result: 42 } }]; app.snapshot.next = 1;
  app.render(); await settle();
  const list = app.render().find(n => n.type === 'FlatList'); assert.equal(list.props.data[0].data.result, 42); assert.equal(app.cache.length, 1);
  app.snapshot.events = []; app.tick(); await settle(); assert.equal(app.cache.length, 1);
  app.composer().onStop(); await settle(); assert.equal(app.composer().busy, true);
  finish(); await settle(); assert.equal(app.composer().busy, false);
  assert.equal(app.calls.filter(c => c.path.endsWith('/cancel')).length, 1); app.unmount();
});
