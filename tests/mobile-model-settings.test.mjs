import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';

const settle = () => new Promise(r => setImmediate(r));
const walk = n => !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(walk) : [n, ...walk(n.props?.children)];
const first = '["one","first"]', second = '["one","second"]';
const view = id => ({ default: { model_id: first, effective_model_id: first, writable: true, revision: 'host:1' },
  telegram: { model_id: id, effective_model_id: id ?? first, writable: true, revision: 'host:2' } });
function harness(write) {
  const slots = [], calls = [], listeners = new Set(); let cursor = 0, effects = [], changed = 0, settings = view(null);
  let catalog = { items: [{ id: first, name: 'First' }, { id: second, name: 'Second' }] };
  const react = {
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = value; return [slots[i], v => { slots[i] = v; }]; },
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useCallback(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((d, n) => d !== slots[i].deps[n])) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((d, n) => d !== slots[i].deps[n])) {
      const old = slots[i]; slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = fn(); });
    } },
  };
  const dependencies = { react, 'react/jsx-runtime': jsx, 'react-native': { Text: 'Text', AppState: {
    addEventListener(_event, fn) { listeners.add(fn); return { remove: () => listeners.delete(fn) }; },
  } },
    './ui': { ...Object.fromEntries(['ActionLink', 'ActionRow', 'PageHeading', 'PageScrollView', 'SettingsGroup'].map(n => [n, n])), useUi: () => ({ s: {} }), humanError: e => e.message },
    './ModelPicker': { ModelPicker: 'ModelPicker' }, './api': { request: async (connection, path, options) => {
      calls.push({ connection, path, ...options });
      if (options?.method === 'PUT') { settings = await write(options.body); return settings; }
      return path === '/settings/models' ? settings : catalog;
    } } };
  const exports = {}, code = readFileSync(new URL('../src/ModelSettingsPanel.tsx', import.meta.url), 'utf8') + '\nexports.Inner = ConnectedModelSettings;';
  runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, require: name => { assert.ok(name in dependencies, name); return dependencies[name]; } });
  const connection = { url: 'https://model.test', token: 'test-token' };
  const render = () => { cursor = 0; effects = []; const nodes = walk(exports.Inner({ connection, onChanged: () => { changed++; } })); effects.forEach(fn => fn()); return nodes; };
  return { render, calls, changed: () => changed, setCatalog: value => { catalog = value; },
    foreground: () => listeners.forEach(fn => fn('active')),
    find: (type, title) => render().find(n => n.type === type && (!title || n.props.title === title)) };
}

test('model picker waits for the server receipt and can return Telegram to following the default', async () => {
  let finish;
  const app = harness(body => new Promise(resolve => { finish = () => resolve(view(body.model_id)); }));
  app.render(); await settle();
  app.find('ActionRow', '后台模型').props.onPress();
  const write = app.find('ModelPicker').props.onSelect(second);
  assert.match(app.find('ActionRow', '后台模型').props.description, /跟随知行默认/);
  assert.equal(app.changed(), 0);
  assert.equal(app.calls.at(-1).body.revision, 'host:2');
  finish(); await write;
  assert.equal(app.find('ActionRow', '后台模型').props.description, 'Second');
  assert.equal(app.changed(), 1);
  const follow = app.find('ModelPicker').props.onUseDefault(); finish(); await follow;
  assert.equal(app.calls.at(-1).body.model_id, null);
  assert.match(app.find('ActionRow', '后台模型').props.description, /跟随知行默认.*First/);
});

test('a failed model save is surfaced to the picker and rereads the authoritative server state', async () => {
  const app = harness(async () => { throw new Error('云端设置已更新'); });
  app.render(); await settle(); app.find('ActionRow', '默认模型').props.onPress();
  await assert.rejects(app.find('ModelPicker').props.onSelect(second), /云端设置已更新/);
  assert.equal(app.changed(), 0);
  assert.equal(app.find('ActionRow', '默认模型').props.description, 'First');
  assert.equal(app.calls.filter(c => c.path === '/settings/models' && !c.method).length, 2);
  assert.equal(app.find('ActionRow', '默认模型').props.disabled, false);
});

test('new server providers and models reach both selectors on foreground and manual refresh without an app update', async () => {
  const app = harness(async body => view(body.model_id));
  app.render(); await settle();
  const added = { id: '["future-provider","future-model"]', name: 'New server model', ready: true };
  app.setCatalog({ items: [added] });
  app.foreground(); await settle();
  for (const title of ['默认模型', '后台模型']) {
    app.find('ActionRow', title).props.onPress();
    assert.deepEqual(app.find('ModelPicker').props.models, [added]);
  }
  await app.find('ModelPicker').props.onSelect(added.id);
  assert.equal(app.calls.findLast(c => c.method === 'PUT').body.model_id, added.id);
  assert.equal(app.find('ActionRow', '后台模型').props.description, added.name);
  app.setCatalog({ items: [] });
  app.find('ActionLink').props.onPress(); await settle();
  assert.equal(app.find('ModelPicker').props.models.length, 0, 'removed server models leave the picker too');
});
