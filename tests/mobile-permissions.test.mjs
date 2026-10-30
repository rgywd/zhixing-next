import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';
import * as permissions from '../src/dshPermissions.ts';
import * as theme from '../src/theme.ts';

const walk = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
function harness(onSelect) {
  const slots = [], exports = {}; let cursor = 0, closes = 0;
  const dependencies = {
    react: {
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value; }]; },
      useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    },
    'react/jsx-runtime': jsxRuntime,
    'react-native': { ...Object.fromEntries(['Pressable', 'ScrollView', 'Text', 'View'].map(n => [n, n])), StyleSheet: { create: s => s } },
    '@react-native-vector-icons/ionicons': { Ionicons: 'Ionicons' }, './BottomSheet': { BottomSheet: 'BottomSheet' },
    './dshPermissions': permissions, './theme': theme,
    './ThemeProvider': { useThemedStyles: factory => factory(theme.lightColors) },
    './ui': { humanError: e => e.message, useUi: () => ({ s: {}, colors: theme.lightColors }) },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL('../src/PermissionPicker.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => { assert.ok(name in dependencies, name); return dependencies[name]; } });
  const props = { visible: true, permissions: { current: 'read-only', options: permissions.permissionChoices.map(c => c.value) },
    onSelect, onClose: () => { closes++; } };
  return { props, get closes() { return closes; }, render() { cursor = 0; return walk(exports.PermissionPicker(props)); } };
}

test('permission picker waits for saving, prevents double selection and keeps failures visible for retry', async () => {
  let fail, finish, requests = 0;
  const app = harness(() => { requests++; return new Promise((resolve, reject) => { finish = resolve; fail = reject; }); });
  const options = () => app.render().filter(n => n.type === 'Pressable');
  const choose = options()[1]; choose.props.onPress(); choose.props.onPress();
  assert.equal(requests, 1); assert.equal(app.closes, 0);
  assert.ok(options().every(n => n.props.disabled));
  app.render()[0].props.onClose(); assert.equal(app.closes, 0);
  fail(new Error('离线，保存失败')); await settle();
  assert.ok(app.render().some(n => n.props.accessibilityRole === 'alert' && n.props.children === '离线，保存失败'));
  assert.equal(options()[0].props.accessibilityState.checked, true);
  options()[1].props.onPress(); finish(); await settle();
  assert.equal(app.closes, 1); assert.equal(requests, 2);
});

test('permission picker does not invent a current mode or enable unavailable host modes', () => {
  const app = harness(() => assert.fail('unavailable modes cannot be written'));
  app.props.permissions = { current: 'custom', options: ['read-only'] };
  let options = app.render().filter(n => n.type === 'Pressable');
  assert.ok(options.every(n => !n.props.accessibilityState.checked));
  assert.equal(options[0].props.disabled, false); assert.equal(options[1].props.disabled, true);
  options[2].props.onPress(); assert.equal(app.closes, 0);
  app.props.permissions = null;
  options = app.render().filter(n => n.type === 'Pressable');
  assert.ok(options.every(n => n.props.disabled));
  assert.equal(permissions.permissionPresentation().label, '权限未就绪');
});
