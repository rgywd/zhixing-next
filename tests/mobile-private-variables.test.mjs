import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';
import * as theme from '../src/theme.ts';

const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const walk = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
function harness({ save = async () => {}, protect = async () => {} } = {}) {
  const slots = [], calls = [], privacy = [], exports = {}; let cursor = 0, effects = [], appState, serial = 0;
  const dependencies = {
    react: {
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
        return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
      useRef(initial) { return slots[cursor++] ??= { current: initial }; },
      useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((x, index) => x !== old.deps[index])) {
        slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); });
      } },
    },
    'react/jsx-runtime': jsxRuntime,
    'react-native': { Text: 'Text', TextInput: 'TextInput', View: 'View', AppState: { addEventListener: (_name, callback) => { appState = callback; return { remove() { appState = undefined; } }; } } },
    'expo-crypto': { randomUUID: () => `00000000-0000-0000-0000-${String(++serial).padStart(12, '0')}` },
    './ui': { useUi: () => ({ s: {}, colors: theme.lightColors }), Button: 'Button', ActionLink: 'ActionLink' }, './theme': theme,
    './vaultPrivacy': { acquireVaultPrivacy: async key => { privacy.push(['acquire', key]); await protect(); },
      releaseVaultPrivacy: async key => { privacy.push(['release', key]); } },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL('../src/PrivateVariablesCard.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => { assert.ok(name in dependencies, `Unexpected private input dependency: ${name}`); return dependencies[name]; } });
  const props = { pending: { id: 'request', sessionId: 'session', kind: 'environment', title: '填写连接密钥',
    fields: [{ id: '0', name: 'DSH_SECRET_TOKEN', label: 'Token' }, { id: '1', name: 'DSH_SECRET_KEY', label: 'Key' }], configuredNames: [] },
    disabled: false, submit: async body => { calls.push(plain(body)); await save(body); } };
  function render() { cursor = 0; effects = []; const result = walk(exports.PrivateVariablesCard(props)); effects.forEach(effect => effect()); return result; }
  const input = label => render().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === label);
  return { render, props, calls, privacy, input, background: () => appState('background'),
    button: () => render().find(node => node.type === 'Button'), unmount: () => slots.forEach(slot => slot?.cleanup?.()) };
}

test('private card requires privacy, masks values, edits names and submits all fields without a chat or persistent draft', async () => {
  const app = harness();
  assert.equal(app.render().some(node => node.type === 'TextInput'), false);
  await settle();
  app.input('变量名 0').props.onChangeText('DSH_SECRET_TELEGRAM_TOKEN');
  app.input('私密值 0').props.onChangeText('TEST_ONLY_SECRET_ONE');
  app.input('私密值 1').props.onChangeText('TEST_ONLY_SECRET_TWO');
  for (const id of ['0', '1']) {
    const field = app.input(`私密值 ${id}`);
    assert.equal(field.props.secureTextEntry, true); assert.equal(field.props.autoComplete, 'off');
    assert.equal(field.props.importantForAutofill, 'no');
  }
  assert.equal(app.button().props.disabled, false); app.button().props.onPress(); await settle();
  assert.equal(app.calls.length, 1); assert.equal(app.calls[0].fields[0].name, 'DSH_SECRET_TELEGRAM_TOKEN');
  assert.deepEqual(app.calls[0].fields.map(field => field.value), ['TEST_ONLY_SECRET_ONE', 'TEST_ONLY_SECRET_TWO']);
  assert.equal(app.render().some(node => node.type === 'TextInput'), false, 'values disappear after real receipt');
  assert.ok(!JSON.stringify(app.render()).includes('TEST_ONLY_SECRET'));
  app.unmount(); await settle(); assert.equal(app.privacy.at(-1)[0], 'release');
});

test('private card keeps an unacknowledged submission retryable, hides remote errors and clears values on background', async () => {
  let fail = true;
  const app = harness({ save: async () => { if (fail) throw new Error('SERVER_MUST_NOT_DISPLAY_VALUE'); } });
  app.render(); await settle();
  app.input('私密值 0').props.onChangeText('TEST_ONLY_SECRET_ONE'); app.input('私密值 1').props.onChangeText('TEST_ONLY_SECRET_TWO');
  app.button().props.onPress(); await settle();
  assert.ok(!JSON.stringify(app.render()).includes('SERVER_MUST_NOT_DISPLAY_VALUE'));
  assert.equal(app.input('私密值 0').props.value, 'TEST_ONLY_SECRET_ONE');
  app.button().props.onPress(); await settle(); assert.equal(app.calls[0].submissionId, app.calls[1].submissionId);
  app.background(); assert.equal(app.input('私密值 0').props.value, ''); assert.equal(app.input('私密值 1').props.value, '');
  fail = false; app.render().find(node => node.type === 'ActionLink' && node.props.children === '取消填写').props.onPress(); await settle();
  assert.deepEqual(app.calls.at(-1), { cancelled: true }); app.unmount();
});

test('private card requires explicit replacement and stays closed if native privacy cannot be enabled', async () => {
  const blocked = harness({ protect: async () => { throw new Error('unavailable'); } });
  blocked.render(); await settle(); assert.equal(blocked.button().props.disabled, true);
  assert.equal(blocked.render().some(node => node.type === 'TextInput'), false); blocked.unmount();
  const app = harness(); app.props.pending.configuredNames = ['DSH_SECRET_TOKEN']; app.render(); await settle();
  app.input('私密值 0').props.onChangeText('TEST_ONLY_SECRET_ONE'); app.input('私密值 1').props.onChangeText('TEST_ONLY_SECRET_TWO');
  assert.equal(app.button().props.disabled, true);
  app.render().find(node => node.type === 'ActionLink' && String(node.props.children).startsWith('☐')).props.onPress();
  assert.equal(app.button().props.disabled, false); app.button().props.onPress(); await settle();
  assert.equal(app.calls[0].fields[0].replace, true); app.unmount();
});
