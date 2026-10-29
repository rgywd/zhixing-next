import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';

function load(file, deps) {
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, AbortController, setTimeout, clearTimeout, require: id => { assert.ok(id in deps, id); return deps[id]; } });
  return exports;
}
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

test('copy reports success only after writing exact code and permits retry after clipboard failure', async () => {
  let cursor = 0, finish; const states = [], writes = [];
  const { CopyAction } = load('CopyAction.tsx', {
    react: { useState(value) { const i = cursor++; if (!(i in states)) states[i] = value; return [states[i], value => { states[i] = value; }]; } },
    'react/jsx-runtime': jsx, 'react-native': { Text: 'Text', View: 'View' },
    'expo-clipboard': { setStringAsync: async text => { writes.push(text); return new Promise(resolve => { finish = resolve; }); } },
    './ui': { useUi: () => ({ s: {} }), humanError: e => e.message, ActionLink: 'ActionLink' },
  });
  const source = 'const 文 = "exact";\n';
  const render = () => { cursor = 0; return CopyAction({ text: source, label: '复制代码' }); };
  render().props.children[0].props.onPress();
  assert.equal(render().props.children[0].props.children, '复制代码'); assert.equal(render().props.children[0].props.disabled, true);
  finish(false); await settle();
  assert.match(render().props.children[1].props.children, /失败/);
  render().props.children[0].props.onPress(); finish(true); await settle();
  assert.deepEqual(writes, [source, source]); assert.equal(render().props.children[0].props.children, '已复制');
});

test('DSH download streams exact chunks before sharing and removes partial files on failure', async () => {
  for (const fail of [false, true]) {
    const chunks = [], shared = []; let closed = false, removed = false, index = 0;
    const { shareNativeDownload } = load('resources.ts', {
      'expo-crypto': { randomUUID: () => 'download' }, 'expo-sharing': { isAvailableAsync: async () => true, shareAsync: async uri => { assert.equal(closed, true); shared.push(uri); } },
      'expo-file-system': { Paths: { cache: 'cache' }, FileMode: { WriteOnly: 'w' },
        Directory: class { exists = true; create() {} delete() { removed = true; } },
        File: class { uri = 'file:///cache/received.txt'; create() {} open() { return { writeBytes: bytes => chunks.push(...bytes), close: () => { closed = true; } }; } } },
      'expo/fetch': { fetch: async (_url, options) => {
        assert.equal(options.headers.Authorization, 'Bearer private'); assert.equal(options.redirect, 'error');
        return { ok: true, body: { getReader: () => ({ cancel: async () => {}, read: async () => {
          if (index++ === 0) return { value: new Uint8Array([1, 2]), done: false };
          if (fail) throw new Error('connection lost');
          return index === 2 ? { value: new Uint8Array([3, 4]), done: false } : { done: true };
        } }) } };
      } }, './api': { safeDownloadName: name => name },
    });
    const promise = shareNativeDownload({ url: 'https://host', token: 'private' }, 'received.txt', '/conversations/own/dsh/files/immutable');
    if (fail) { await assert.rejects(promise, /connection lost/); assert.equal(removed, true); assert.equal(shared.length, 0); }
    else { await promise; assert.deepEqual(chunks, [1, 2, 3, 4]); assert.equal(shared.length, 1); }
    assert.equal(closed, true);
  }
});
