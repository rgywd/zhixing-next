import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';
import * as protocol from '../src/dshProtocol.ts';
import * as conversationFiles from '../src/conversationFiles.ts';
import * as theme from '../src/theme.ts';

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
    useMemo(fn, deps) { const i = cursor++; if (changed(slots[i]?.deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
  }, render(fn) { cursor = 0; effects = []; const result = fn(); effects.forEach(effect => effect()); return result; }, unmount() { slots.forEach(slot => slot?.cleanup?.()); } };
}
function harness({ store = { draft: { text: 'fix this', pending: null } }, post = async () => {}, clear = async () => {} } = {}) {
  const lifecycle = hooks(), calls = [], uploads = [], removed = [], cache = [], exports = {};
  let uuid = 0, tick;
  const snapshot = { events: [], next: 0, hasMore: false, running: false, active: true, queue: [], pending: [], live: null };
  const report = () => {};
  const dependencies = {
    '@react-native-vector-icons/ionicons': { Ionicons: 'Ionicons' }, './resources': { shareNativeDownload: async () => {} },
    react: lifecycle.react, 'react/jsx-runtime': jsxRuntime,
    'react-native': { ...Object.fromEntries(['FlatList', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map(n => [n, n])), Linking: {}, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } },
    'expo-clipboard': { setStringAsync: async () => {} }, './Notice': { useNotice: () => ({ show() {} }) }, './theme': theme,
    'expo-crypto': { randomUUID: () => `request-${++uuid}` }, 'expo-document-picker': {}, 'expo-image-picker': {},
    'expo-file-system': { Paths: { document: 'file:///private/' }, Directory: class { constructor(...parts) { this.uri = parts.map(p => p.replace(/\/$/, '')).join('/'); this.exists = true; } delete() { removed.push(this.uri); } }, File: class { async bytes() { return new Uint8Array([1, 2]); } } },
    'expo/fetch': { fetch: async (url, options) => { uploads.push({ url, options }); return { ok: true, json: async () => ({ receiptId: `upload-${uploads.length}` }) }; } },
    './api': { request: async (_connection, path, options) => {
      calls.push({ path, ...options });
      if (path.includes('/dsh?')) return plain(snapshot);
      return await post(path, options) ?? {};
    } },
    './storage': { draftKey: () => 'draft', readDraft: async () => plain(store.draft), saveDraft: async (_key, value) => { store.draft = plain(value); },
      clearDraft: async (_key, id) => { await clear(id); if (store.draft.pending?.id === id) store.draft = { text: '', pending: null }; } },
    './localCache': { readCache: async () => null, writeCache: async (_connection, _key, value) => cache.push(plain(value)) },
    './ConnectionStatus': { useSyncStatus: () => report }, './dshProtocol': protocol, './chatPhotos': { discardDraftPhotos() {} },
    './conversationFiles': conversationFiles,
    './ui': { useUi: () => ({ s: {}, colors: {} }), humanError: e => e.message, ActionLink: 'ActionLink', Button: 'Button', IconAction: 'IconAction' },
  };
  for (const component of ['MessageBody', 'ConversationComposer', 'BottomSheet', 'ModelPicker', 'ReasoningPicker', 'ReplyContent', 'ChatTextEditor', 'DshFilePreview', 'ChatFileCard', 'ConversationFilesSheet', 'PermissionPicker']) dependencies[`./${component}`] = { [component]: component };
  dependencies['./PhotoAttachments'] = { DraftAttachments: 'DraftAttachments', MessagePhotos: 'MessagePhotos' };
  runInNewContext(ts.transpileModule(readFileSync(new URL('../src/DshChatPanel.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, AbortController, Uint8Array, setTimeout, clearTimeout, encodeURIComponent, setInterval: fn => { tick = fn; return 1; }, clearInterval() {}, require: name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name];
  } });
  const props = { connection: { url: 'https://example.test', token: 'test' }, conversation: { id: 'zhixing-main-aaaa', model_id: null }, assistantName: '知行', catalog: null, onRefresh() {}, onConversationChanged() {} };
  const render = () => walk(lifecycle.render(() => exports.DshChatPanel(props)));
  return { render, props, store, calls, uploads, removed, cache, snapshot, tick: () => tick(), composer: () => render().find(n => n.type === 'ConversationComposer').props, unmount: lifecycle.unmount };
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

test('permissions change only after native acknowledgement, survive refresh, and leave a failed change retryable', async () => {
  let accept, fail = false;
  const app = harness({ post: async path => {
    if (path.endsWith('/permissions')) {
      if (fail) throw new Error('permission refused');
      return await new Promise(resolve => { accept = resolve; });
    }
  } });
  const permissions = { current: 'read-only', options: ['read-only', 'workspace-write', 'danger-full-access'] };
  app.snapshot.permissions = permissions;
  app.snapshot.history = { active: 'current-version', versions: [] };
  app.render(); await settle();
  assert.equal(app.composer().permission, 'read-only');
  app.composer().onPermission();
  const picker = () => app.render().find(n => n.type === 'PermissionPicker');
  assert.equal(picker().props.visible, true);
  const changing = picker().props.onSelect('workspace-write'); await settle();
  assert.equal(app.composer().permission, 'read-only');
  assert.equal(app.composer().permissionLocked, true);
  const call = app.calls.find(c => c.path.endsWith('/permissions'));
  assert.equal(call.method, 'PUT'); assert.deepEqual(plain(call.body), { permission: 'workspace-write', version: 'current-version' });
  app.snapshot.permissions = { ...permissions, current: 'workspace-write' };
  accept(plain(app.snapshot.permissions)); await changing; await settle();
  assert.equal(app.composer().permission, 'workspace-write');
  fail = true;
  await assert.rejects(picker().props.onSelect('danger-full-access'), /permission refused/);
  await settle(); assert.equal(app.composer().permission, 'workspace-write');
  assert.equal(picker().props.visible, true); assert.equal(app.composer().permissionLocked, false);
  assert.equal(app.composer().text, 'fix this');
  app.snapshot.permissions = null; app.tick(); await settle();
  assert.equal(app.composer().permission, undefined); assert.equal(app.composer().permissionLocked, true);
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
  assert.equal(restored.uploads.length, 0, 'persisted upload receipts must be reused after a lost reply');
  assert.match(first.uploads[0].url, /mediaType=image%2Fpng/); assert.equal(store.draft.pending, null);
  assert.equal(restored.removed.length, 1); restored.unmount();
});

test('DSH rendering preserves opaque events, persists only new data, and waits for cancel acknowledgement', async () => {
  let finish;
  const app = harness({ post: async path => { if (path.endsWith('/cancel')) await new Promise(resolve => { finish = resolve; }); } });
  app.snapshot.running = true;
  app.snapshot.events = [{ seq: 0, type: 'plugin/custom', data: { result: 42 } }]; app.snapshot.next = 1;
  app.render(); await settle();
  const list = app.render().find(n => n.type === 'FlatList');
  assert.equal(list.props.data.some(row => row.data?.result === 42), false, 'raw plugin data belongs in details');
  assert.equal(app.cache[0].events[0].data.result, 42); assert.equal(app.cache.length, 1);
  app.snapshot.events = []; app.tick(); await settle(); assert.equal(app.cache.length, 1);
  app.composer().onStop(); await settle(); assert.equal(app.composer().busy, true);
  finish(); await settle(); assert.equal(app.composer().busy, false);
  assert.equal(app.calls.filter(c => c.path.endsWith('/cancel')).length, 1); app.unmount();
});

test('DSH follows streamed growth and keyboard resizing while preserving manual history reading', async () => {
  const app = harness(), scrolls = [];
  app.render(); await settle();
  let list = app.render().find(n => n.type === 'FlatList');
  list.props.ref.current = { scrollToOffset: options => scrolls.push(options) };
  const event = distance => ({ nativeEvent: { contentOffset: { y: 500 - distance }, contentSize: { height: 1000 }, layoutMeasurement: { height: 500 } } });
  list.props.onScroll(event(250)); list.props.onContentSizeChange(400, 1400); list.props.onLayout();
  assert.equal(scrolls.length, 2, 'native layout and growing replies must not disable following');
  assert.equal(scrolls.at(-1).offset, 1400, 'use the measured content including the streaming footer');
  list.props.onScrollBeginDrag(); list.props.onScroll(event(4)); list.props.onContentSizeChange(400, 1500);
  list.props.onScrollEndDrag(event(150)); list.props.onLayout();
  assert.equal(scrolls.length, 2, 'new chunks must not pull the user away from history');
  list.props.onScroll(event(0)); list.props.onContentSizeChange(400, 1600);
  assert.equal(scrolls.length, 2, 'a virtualized layout event must not silently resume following');
  app.render().find(n => n.props.accessibilityLabel === '回到最新消息').props.onPress();
  assert.equal(scrolls.at(-1).animated, true);
  list = app.render().find(n => n.type === 'FlatList');
  list.props.onScroll(event(300)); list.props.onContentSizeChange(400, 1700);
  assert.equal(scrolls.at(-1).animated, false); assert.equal(scrolls.length, 4);
  list.props.renderItem({ item: { id: 'reply', role: 'assistant' }, index: 0 }).props.onReadProcess();
  list.props.onContentSizeChange(400, 1900);
  assert.equal(scrolls.length, 4, 'opening a process must keep its position instead of chasing the new bottom');
  app.unmount();
});

test('search focus waits for the exact visible row and disables automatic following during positioning', async () => {
  const app = harness(), positions = [], handled = [];
  app.props.focusMessageSeq = 0; app.props.onFocusHandled = seq => handled.push(seq);
  app.snapshot.events = [{ seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'target' }] } }];
  app.render(); await settle();
  const list = app.render().find(n => n.type === 'FlatList');
  list.props.ref.current = { scrollToIndex: value => positions.push(value), scrollToOffset: () => assert.fail('must not follow latest before focus') };
  list.props.onContentSizeChange(300, 2000);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(positions[0].index, 0); assert.equal(handled.length, 0);
  list.props.onViewableItemsChanged({ viewableItems: [{ index: 1, isViewable: true }] }); assert.equal(handled.length, 0);
  list.props.onViewableItemsChanged({ viewableItems: [{ index: 0, isViewable: true }] }); assert.deepEqual(handled, [0]);
  app.unmount();
});

async function openRevision(app, role = 'user') {
  const list = app.render().find(n => n.type === 'FlatList');
  list.props.renderItem({ item: list.props.data.find(r => r.role === role), index: role === 'user' ? 0 : 1 }).props.onMenu();
  const label = role === 'user' ? '编辑消息' : '重新回答';
  app.render().find(n => n.type === 'ActionLink' && n.props.children === label).props.onPress();
  app.render().find(n => n.type === 'BottomSheet' && n.props.title === '消息操作').props.onDismiss();
  await settle();
}
const revisionEvents = [
  { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'old demand' }, { type: 'file', attachment: { attachmentId: 'file-one', name: 'note.txt', bytes: 8 } }] } },
  { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'old answer' }] } } },
  { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
];
test('restoring an unfinished edit returns to its original message without losing the ordinary draft', async () => {
  const store = { draft: { text: 'ordinary draft', pending: null, revision: {
    id: 'edit-in-progress', kind: 'edit', seq: 1, version: 'edited-version', text: 'unfinished change', attachments: [],
  } } };
  const app = harness({ store }), positions = [];
  app.props.onFocusHandled = () => assert.fail('editing is not a search result');
  app.snapshot.events = revisionEvents; app.snapshot.history = { active: 'edited-version', versions: [] };
  app.render(); await settle();
  const list = app.render().find(n => n.type === 'FlatList');
  list.props.ref.current = { scrollToIndex: value => positions.push(value), scrollToOffset: () => assert.fail('must stay at the original message while editing') };
  list.props.onContentSizeChange(320, 4000); list.props.onLayout();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(positions[0].index, 0);
  list.props.onViewableItemsChanged({ viewableItems: [{ index: 0, isViewable: true }] });
  assert.equal(app.composer().text, 'unfinished change');
  app.composer().editing.onCancel(); await settle();
  assert.equal(app.composer().text, 'ordinary draft');
  assert.equal(app.calls.some(c => c.method === 'POST'), false); app.unmount();
});
test('true message editing preserves the normal draft and retries an identical durable operation after remount', async () => {
  const store = { draft: { text: 'unsent normal draft', pending: null } };
  const first = harness({ store, post: async () => { throw new Error('lost acknowledgement'); } });
  first.snapshot.events = revisionEvents; first.snapshot.next = 4;
  first.render(); await settle(); await openRevision(first);
  assert.equal(first.composer().text, 'old demand');
  first.composer().onText('new demand'); await settle();
  first.render().find(n => n.type === 'IconAction' && n.props.label === '移除附件 note.txt').props.onPress(); await settle();
  first.composer().onSend(); await settle();
  const sent = first.calls.find(c => c.path.endsWith('/revisions'));
  assert.equal(sent.body.seq, 1); assert.equal(sent.body.text, 'new demand'); assert.deepEqual(plain(sent.body.attachments), []);
  assert.equal(store.draft.text, 'unsent normal draft'); assert.equal(store.draft.revision.submitted, true);
  assert.equal(first.composer().canSend, true); assert.equal(first.composer().editable, false); assert.ok(first.render().some(n => n.props?.children === 'lost acknowledgement')); first.unmount();
  const restored = harness({ store }); restored.render(); await settle();
  restored.composer().onSend(); await settle();
  const retry = restored.calls.find(c => c.path.endsWith('/revisions'));
  assert.deepEqual(plain(retry.body), plain(sent.body)); assert.equal(store.draft.revision, undefined);
  assert.equal(restored.composer().text, 'unsent normal draft'); restored.unmount();
});
test('regenerate acts directly on the assistant reply; cancelling inline edit restores ordinary draft without sending', async () => {
  const app = harness(); app.snapshot.events = revisionEvents; app.render(); await settle();
  await openRevision(app); assert.equal(app.composer().text, 'old demand');
  app.composer().onText('unfinished change'); await settle();
  app.composer().editing.onCancel(); await settle();
  assert.equal(app.store.draft.revision, undefined); assert.equal(app.calls.some(c => c.method === 'POST'), false);
  assert.equal(app.composer().text, 'fix this');
  await openRevision(app, 'assistant');
  const sent = app.calls.find(c => c.path.endsWith('/revisions'));
  assert.equal(sent.body.seq, 2); assert.equal(sent.body.kind, 'retry');
  assert.equal(app.store.draft.revision, undefined); assert.equal(app.composer().text, 'fix this'); app.unmount();
});
test('version changes replace reused native sequence numbers and cache native history without an artifact store', async () => {
  const app = harness(); app.snapshot.events = revisionEvents; app.snapshot.next = 4;
  app.snapshot.history = { active: app.props.conversation.id, versions: [{ id: app.props.conversation.id, label: '原始版本' }] };
  app.render(); await settle();
  app.snapshot.history = { active: 'child', versions: [...app.snapshot.history.versions, { id: 'child', label: '编辑版本 1' }] };
  app.snapshot.events = [{ seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'replacement' }] } }]; app.snapshot.next = 2;
  app.tick(); await settle();
  const rows = app.render().find(n => n.type === 'FlatList').props.data;
  assert.equal(rows.length, 1); assert.equal(protocol.rowText(rows[0]), 'replacement');
  app.snapshot.events = [];
  app.tick(); await settle();
  assert.equal(app.cache.at(-1).historyId, 'child'); assert.equal(app.cache.at(-1).events.length, 1);
  assert.equal(Object.hasOwn(app.cache.at(-1), 'artifacts'), false); app.unmount();
});

test('stale search results cannot highlight a different message with a reused sequence number', async () => {
  const app = harness(), handled = [];
  app.props.focusMessageSeq = 1; app.props.focusMessageVersion = 'old-version'; app.props.onFocusHandled = seq => handled.push(seq);
  app.snapshot.history = { active: 'new-version', versions: [] }; app.snapshot.events = revisionEvents;
  app.render(); await settle(); app.render(); await settle();
  assert.deepEqual(handled, [1]);
  const list = app.render().find(n => n.type === 'FlatList');
  assert.equal(list.props.renderItem({ item: list.props.data[0] }).props.highlighted, false);
  app.unmount();
});

test('the conversation file sheet hands the preview between native layers instead of stacking them', async () => {
  const app = harness();
  app.snapshot.history = { active: 'version-b', versions: [{ id: 'version-b', label: '原始版本' }] };
  app.snapshot.events = [
    { seq: 1, type: 'user/message', data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: '整理清单' }, { type: 'file', attachment: { attachmentId: 'upload', name: '我的上传.pdf', bytes: 9 } }] } },
    { seq: 2, type: 'deliverables/presented', data: { turn: 1, files: [{ path: '采购清单.md', description: '六人份' }, { path: '旧版方案.md' }] } },
    { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  // Mirror the App: the sheet is driven by filesOpen, so closing and reopening
  // it is observable instead of an assumed prop value.
  app.props.filesOpen = true;
  app.props.onFilesClose = () => { app.props.filesOpen = false; };
  app.props.onFilesOpen = () => { app.props.filesOpen = true; };
  app.render(); await settle();
  const sheet = () => app.render().find(n => n.type === 'ConversationFilesSheet');
  const preview = () => app.render().find(n => n.type === 'DshFilePreview');
  const stacked = () => sheet().props.visible && !!preview().props.file;
  assert.equal(sheet().props.visible, true);
  assert.deepEqual(sheet().props.files.map(item => item.file.name), ['旧版方案.md', '采购清单.md']);
  assert.equal(sheet().props.files.some(item => item.file.name === '我的上传.pdf'), false);
  assert.equal(preview().props.file, null);
  assert.equal(stacked(), false);

  app.composer().onText('还没发出的草稿'); await settle();
  assert.equal(app.store.draft.text, '还没发出的草稿');

  sheet().props.onOpen(sheet().props.files[0].file);
  assert.equal(sheet().props.visible, false, 'opening a file closes the list first');
  assert.equal(preview().props.file, null, 'the preview waits for the list to finish dismissing');
  assert.ok(sheet(), 'the list component stays mounted so its query and share state survive');
  assert.equal(stacked(), false);

  sheet().props.onDismiss();
  assert.equal(preview().props.file.name, '旧版方案.md');
  assert.equal(sheet().props.visible, false, 'the list is hidden while the preview is open');
  assert.equal(stacked(), false);

  preview().props.onClose(); await settle();
  assert.equal(preview().props.file, null);
  assert.equal(sheet().props.visible, false, 'the list waits for the preview dismissal');
  assert.equal(stacked(), false);

  preview().props.onDismiss();
  assert.equal(sheet().props.visible, true, 'the list reopens only after the preview is gone');
  assert.equal(stacked(), false);
  assert.equal(app.composer().text, '还没发出的草稿', 'the draft survives the whole round trip');
  assert.equal(app.calls.some(call => call.path.endsWith('/messages')), false, 'listing files sends nothing');

  sheet().props.onClose();
  assert.equal(sheet().props.visible, false);
  app.unmount();
});
