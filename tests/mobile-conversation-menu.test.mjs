import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';
import * as theme from '../src/theme.ts';

const walk = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(walk) : typeof node.type === 'function' ? walk(node.type(node.props)) : [node, ...walk(node.props?.children)];
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
function harness() {
  const slots = [], exports = {}, backs = new Set(); let cursor = 0, closes = 0;
  const appearance = { colors: theme.lightColors, mode: 'light', preference: 'system', error: '', setPreference(value) { this.preference = value; this.mode = value === 'dark' ? 'dark' : 'light'; this.colors = this.mode === 'dark' ? theme.darkColors : theme.lightColors; } };
  appearance.setPreference = appearance.setPreference.bind(appearance);
  const dependencies = {
    react: {
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
      useRef(initial) { return slots[cursor++] ??= { current: initial }; },
      useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((d, j) => d !== old.deps[j])) { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; } },
    },
    'react/jsx-runtime': jsxRuntime,
    'react-native': { ...Object.fromEntries(['Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map(n => [n, n])),
      StyleSheet: { create: s => s, absoluteFill: { position: 'absolute' }, hairlineWidth: 1 }, useWindowDimensions: () => ({ width: 320 }),
      BackHandler: { addEventListener: (_name, fn) => { backs.add(fn); return { remove: () => backs.delete(fn) }; } } },
    '@react-native-vector-icons/ionicons': { Ionicons: 'Ionicons' }, './theme': theme,
    './ThemeProvider': { useTheme: () => appearance, useThemedStyles: factory => factory(appearance.colors) }, './ui': { humanError: e => e.message },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL('../src/ConversationMenu.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => { assert.ok(name in dependencies, name); return dependencies[name]; } });
  const props = { title: '研究插件并整理接入方案', top: 62, existing: true, onClose: () => { closes++; }, onRename: async () => {}, onShare() {}, onSearch() {}, onDelete: async () => {} };
  const render = () => { cursor = 0; return walk(exports.ConversationMenu(props)); };
  return { props, appearance, render, get closes() { return closes; }, button: label => render().find(n => n.props.accessibilityLabel === label), back: () => [...backs].at(-1)() };
}

test('the inline box has five ordered actions, no native modal, and a theme submenu with the actual current appearance', () => {
  const app = harness();
  assert.deepEqual(app.render().filter(n => n.type === 'Pressable').map(n => n.props.accessibilityLabel), ['关闭对话菜单', '修改对话名称', '分享', '在聊天中查找', '主题：白天', '删除']);
  assert.equal(app.render().some(n => ['Modal', 'BottomSheet'].includes(n.type)), false);
  app.button('主题：白天').props.onPress(); app.button('夜间').props.onPress();
  assert.equal(app.appearance.preference, 'dark'); assert.equal(app.closes, 0);
  assert.equal(app.back(), true); assert.ok(app.button('主题：夜间'));
  app.back(); assert.equal(app.closes, 1);
});

test('rename retains the entered name on failure and waits for acknowledgement, without double submission', async () => {
  const app = harness(); let resolve, reject, calls = 0;
  app.props.onRename = title => { assert.equal(title, '新的名称'); calls++; return new Promise((done, fail) => { resolve = done; reject = fail; }); };
  app.button('修改对话名称').props.onPress();
  app.render().find(n => n.type === 'TextInput').props.onChangeText('新的名称');
  const save = app.button('保存名称'); save.props.onPress(); save.props.onPress();
  assert.equal(calls, 1); app.button('关闭对话菜单').props.onPress(); app.back(); assert.equal(app.closes, 0);
  reject(new Error('保存失败')); await settle();
  assert.equal(app.render().find(n => n.type === 'TextInput').props.value, '新的名称');
  assert.ok(app.render().some(n => n.props.accessibilityRole === 'alert' && n.props.children === '保存失败'));
  app.button('保存名称').props.onPress(); resolve(); await settle(); assert.equal(app.closes, 1);
});

test('deleting requires its confirmation and a successful server result; welcome actions stay disabled', async () => {
  const app = harness(); let deleted = 0;
  app.props.onDelete = async () => { deleted++; throw new Error('服务离线'); };
  app.button('删除').props.onPress(); assert.equal(deleted, 0);
  app.button('确认删除').props.onPress(); await settle(); assert.equal(deleted, 1); assert.equal(app.closes, 0);
  assert.ok(app.render().some(n => n.props.children === '服务离线'));
  app.back(); app.props.existing = false;
  for (const label of ['修改对话名称', '分享', '在聊天中查找', '删除']) assert.equal(app.button(label).props.disabled, true);
  assert.equal(app.button('主题：白天').props.disabled, false);
});
