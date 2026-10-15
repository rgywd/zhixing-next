import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import * as theme from "../src/theme.ts";
import * as types from "../src/vaultTypes.ts";

const clone = (value) => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let index = 0; index < 3; index++) await new Promise((resolve) => setImmediate(resolve)); };
const entry = (id, extra = {}) => ({ ...types.emptyVaultInput(), id, site: `${id}.example`, account: `${id}@example.test`, password: `fictional-password-${id}`, questions: [{ id: `question-${id}`, question: "虚构的问题", answer: `fictional-answer-${id}` }], fields: [{ id: `field-${id}`, label: "恢复代码", value: `fictional-recovery-${id}`, secret: true }], createdAt: "2031-01-02T10:00:00Z", updatedAt: "2031-01-02T10:00:00Z", ...extra });
function lifecycle() {
  const slots = []; let cursor = 0, effects = [];
  const changed = (old, next) => !old || next.length !== old.length || next.some((item, index) => item !== old[index]);
  return { react: {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial; return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useCallback(callback, dependencies) { const index = cursor++; if (changed(slots[index]?.dependencies, dependencies)) slots[index] = { dependencies, callback }; return slots[index].callback; },
    useEffect(callback, dependencies) { const index = cursor++, previous = slots[index]; if (changed(previous?.dependencies, dependencies)) { slots[index] = { dependencies }; effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = callback(); }); } },
  }, render(fn) { cursor = 0; effects = []; const tree = fn(); effects.forEach((effect) => effect()); return tree; }, unmount() { slots.forEach((slot) => slot?.cleanup?.()); } };
}
function harness(initial = {}) {
  const state = { status: "unlocked", lockEpoch: 0, entries: [entry("first"), entry("second")], draft: null, busy: false, draftSaving: false, error: "", storageError: "", ...initial };
  const results = { save: true, create: true, unlock: true, remove: true, master: true, copy: true, ...initial.results };
  const calls = [], notices = [], alerts = [], backs = new Set(), instances = new Map(); let active, uuid = 0, keyboard = false, dismisses = 0;
  const touch = () => calls.push(["touch"]);
  const methods = {
    touch,
    create: async (password) => { calls.push(["create", password]); if (results.create) state.status = "unlocked"; return results.create; },
    unlock: async (password) => { calls.push(["unlock", password]); if (results.unlock) state.status = "unlocked"; else state.error = "未能解锁，原文件保留。"; return results.unlock; },
    beginEdit(id) { calls.push(["edit", id]); if (!state.draft) { const found = state.entries.find((item) => item.id === id); const input = found ? Object.fromEntries(Object.keys(types.emptyVaultInput()).map((key) => [key, clone(found[key])])) : types.emptyVaultInput(); state.draft = { entryId: id ?? null, input }; } },
    updateDraft(input) { calls.push(["update"]); state.draft.input = clone(input); },
    save: async () => {
      calls.push(["save"]);
      try { types.validateVaultInput(state.draft.input); } catch (error) { state.error = error.message; return false; }
      if (!results.save) { state.error = "尚未保存，编辑已保留。"; return false; }
      const next = { ...state.draft.input, id: state.draft.entryId ?? "new-entry", createdAt: "2031-01-02T10:00:00Z", updatedAt: "2031-01-02T10:01:00Z" };
      state.entries = [...state.entries.filter((item) => item.id !== next.id), next]; state.draft = null; return true;
    },
    discardDraft: async () => { calls.push(["discard"]); state.draft = null; return true; },
    removeEntry: async (id) => { calls.push(["remove", id]); if (results.remove) state.entries = state.entries.filter((item) => item.id !== id); return results.remove; },
    changeMaster: async (password) => { calls.push(["master", password]); return results.master; },
    copy: async (value) => { calls.push(["copy", value]); return results.copy; },
    generate: async () => { calls.push(["generate"]); return "A1!b2@C3#d4$E5%f6^G7"; },
    lock() { calls.push(["lock"]); state.status = "locked"; }, retry() { calls.push(["retry"]); },
  };
  const react = Object.fromEntries(["useState", "useRef", "useEffect", "useCallback"].map((name) => [name, (...args) => active.react[name](...args)]));
  const noticeApi = { show: (notice) => { notices.push(notice); return notice.id; }, dismiss: (id) => calls.push(["dismiss", id]) };
  const native = { ...Object.fromEntries(["ActivityIndicator", "FlatList", "Pressable", "Text", "View"].map((name) => [name, name])), StyleSheet: { hairlineWidth: 0.5, create: (value) => value }, Keyboard: { isVisible: () => keyboard, dismiss: () => { keyboard = false; dismisses++; } }, BackHandler: { addEventListener(_event, handler) { backs.add(handler); return { remove() { backs.delete(handler); } }; } }, Alert: { alert(...args) { alerts.push(args); } } };
  const dependencies = { "react/jsx-runtime": jsxRuntime, react, "react-native": native, "expo-crypto": { randomUUID: () => `field-${++uuid}` }, "./Notice": { useNotice: () => noticeApi }, "./ThemeProvider": { useThemedStyles: (factory) => factory(initial.colors ?? theme.darkColors) }, "./theme": theme, "./vaultTypes": types, "./usePasswordVault": { usePasswordVault: () => ({ ...state, ...methods }) }, "./ui": { useUi: () => ({ s: {} }), ...Object.fromEntries(["ActionLink", "BackLink", "Button", "Empty", "Field", "IconAction", "PageHeading", "PageScrollView", "SwitchRow"].map((name) => [name, name])) } };
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/PasswordVaultPanel.tsx", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, Date, Set, Promise, require(name) { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name]; } });
  function render() {
    const visited = new Set(), nodes = [];
    function visit(node, path) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach((item, index) => visit(item, `${path}/${index}`)); return; }
      nodes.push(node);
      if (typeof node.type === "function") {
        const key = `${path}:${node.type.name}:${node.key ?? ""}`; visited.add(key);
        if (!instances.has(key)) instances.set(key, lifecycle());
        active = instances.get(key); const tree = active.render(() => node.type(node.props)); visit(tree, `${path}/body`);
      } else if (node.type === "FlatList") {
        visit(node.props.ListHeaderComponent, `${path}/header`);
        if (node.props.data.length) node.props.data.forEach((item) => visit(node.props.renderItem({ item }), `${path}/item:${item.id}`));
        else visit(node.props.ListEmptyComponent, `${path}/empty`);
        visit(node.props.ListFooterComponent, `${path}/footer`);
      } else { visit(node.props?.action, `${path}/action`); visit(node.props?.children, `${path}/children`); }
    }
    visit(jsxRuntime.jsx(exports.PasswordVaultPanel, { onBack: () => calls.push(["back"]) }), "root");
    for (const [key, instance] of instances) if (!visited.has(key)) { instance.unmount(); instances.delete(key); }
    return nodes;
  }
  const get = (label) => { const node = render().find((item) => item.props?.label === label || item.props?.accessibilityLabel === label || (typeof item.props?.children === "string" && item.props.children === label)); assert.ok(node, `control ${label}`); return node; };
  return { state, results, calls, notices, alerts, render, get, fill(label, value) { get(label).props.onChangeText(value); render(); }, press(label) { get(label).props.onPress(); render(); }, async settle() { await settle(); return render(); }, back() { const result = [...backs].at(-1)?.(); render(); return result; }, keyboard(value) { keyboard = value; }, get keyboardDismisses() { return dismisses; } };
}
const allText = (nodes) => nodes.filter((node) => node.type === "Text").flatMap((node) => [node.props.children].flat(Infinity)).filter((value) => typeof value === "string").join(" ");
const isShown = (app, value) => allText(app.render()).includes(value);
const editNew = (app) => app.press("添加密码记录");

test("locked, loading, unreadable and unsupported views never render decrypted lists or prior values", () => {
  for (const status of ["locked", "create", "loading", "error", "unsupported"]) {
    const app = harness({ status }); const nodes = app.render();
    assert.equal(nodes.some((node) => node.type === "FlatList"), false);
    assert.equal(allText(nodes).includes("first.example"), false);
    assert.equal(allText(nodes).includes("fictional-password"), false);
    assert.equal(nodes.some((node) => node.type === "Field" && node.props.label === "搜索密码记录"), false);
  }
});

test("master creation validates confirmation and preserves exact password characters", async () => {
  const app = harness({ status: "create" }); app.render();
  assert.match(allText(app.render()), /主密码无法找回；卸载会丢失本机密码库/);
  app.fill("主密码", "short"); app.fill("再次输入主密码", "short"); app.press("创建密码库"); await app.settle();
  assert.equal(app.calls.some(([kind]) => kind === "create"), false);
  const password = "  fictional master password  "; app.fill("主密码", password); app.fill("再次输入主密码", "different enough"); app.press("创建密码库"); await app.settle();
  assert.equal(app.calls.some(([kind]) => kind === "create"), false);
  app.fill("再次输入主密码", password); app.press("创建密码库"); await app.settle();
  assert.deepEqual(app.calls.find(([kind]) => kind === "create"), ["create", password]);
  assert.equal(app.state.status, "unlocked");
  app.state.status = "locked"; app.render(); assert.equal(app.get("输入主密码").props.value, "");
});

test("failed unlock keeps its input masked and uses a local error without exposing records", async () => {
  const app = harness({ status: "locked", results: { unlock: false } }); app.fill("输入主密码", "fictional wrong master"); app.press("解锁"); await app.settle();
  const field = app.get("输入主密码"); assert.equal(field.props.secureTextEntry, true); assert.equal(field.props.value, "fictional wrong master");
  assert.equal(field.props.autoComplete, "off"); assert.equal(field.props.importantForAutofill, "no");
  assert.equal(app.render().some((node) => node.type === "FlatList"), false);
  assert.match(allText(app.render()), /未能解锁/);
});

test("background locking clears master inputs even when create or locked status stays unchanged", () => {
  for (const status of ["create", "locked"]) {
    const app = harness({ status });
    const label = status === "create" ? "主密码" : "输入主密码";
    app.fill(label, "fictional master before background");
    if (status === "create") app.fill("再次输入主密码", "fictional master before background");
    assert.equal(app.get(label).props.value, "fictional master before background");
    app.state.lockEpoch++;
    app.render();
    assert.equal(app.state.status, status);
    assert.equal(app.get(label).props.value, "");
    if (status === "create") assert.equal(app.get("再次输入主密码").props.value, "");
    assert.equal(app.calls.some(([kind]) => kind === "create" || kind === "unlock"), false);
  }
});

test("explicit locking stays available during saving or password generation and hides secrets immediately", async () => {
  for (const operation of ["saving", "generating"]) {
    const app = harness({ busy: operation === "saving" });
    if (operation === "generating") {
      editNew(app); app.press("生成20位密码");
      assert.equal(app.get("正在生成…").props.disabled, true);
    }
    assert.equal(Boolean(app.get("锁定密码库").props.disabled), false);
    app.press("锁定密码库");
    assert.equal(app.state.status, "locked"); assert.equal(app.render().some((node) => node.type === "FlatList"), false);
    await app.settle();
    assert.equal(app.state.status, "locked"); assert.equal(app.get("输入主密码").props.value, "");
    assert.equal(isShown(app, "A1!b2@C3#d4$E5%f6^G7"), false);
  }
});

test("list and search expose only metadata and opening a detail defaults all secret values to hidden", () => {
  const app = harness(); app.render();
  assert.equal(isShown(app, "fictional-password-first"), false);
  app.fill("搜索密码记录", "second@");
  assert.equal(app.render().find((node) => node.type === "FlatList").props.data.length, 1);
  app.press("打开密码记录：second.example");
  for (const value of ["fictional-password-second", "fictional-answer-second", "fictional-recovery-second"]) assert.equal(isShown(app, value), false);
  app.press("显示密码"); assert.equal(isShown(app, "fictional-password-second"), true);
  assert.equal(isShown(app, "fictional-answer-second"), false);
  app.press("密码管理"); app.fill("搜索密码记录", "first@"); app.press("打开密码记录：first.example");
  assert.equal(isShown(app, "fictional-password-first"), false);
});

test("field copy is explicit, targets only the chosen value and never echoes it in a notice", async () => {
  const app = harness(); app.press("打开密码记录：first.example"); app.press("复制密码"); await app.settle();
  assert.deepEqual(app.calls.find(([kind]) => kind === "copy"), ["copy", "fictional-password-first"]);
  assert.equal(isShown(app, "fictional-password-first"), false);
  assert.match(app.notices.at(-1).message, /将尝试在30秒后清除/);
  assert.ok(app.notices.every((notice) => !JSON.stringify(notice).includes("fictional-password")));
});

test("new entries start with three required fields and generated passwords remain hidden", async () => {
  for (const colors of [theme.lightColors, theme.darkColors]) {
    const app = harness({ entries: [], colors }); editNew(app);
    assert.deepEqual(app.render().filter((node) => node.type === "Field").map((node) => node.props.label), ["网站/网址", "账号", "密码"]);
    app.fill("网站/网址", "虚构网站名称"); app.fill("账号", "fictional-user"); app.press("生成20位密码"); await app.settle();
    assert.equal(app.get("密码").props.value.length, 20); assert.equal(app.get("密码").props.secureTextEntry, true);
    app.press("保存"); await app.settle(); assert.equal(app.state.entries.length, 1); assert.equal(app.state.draft, null);
  }
});

test("optional repeated questions and custom fields retain stable identities and default to secret", () => {
  const app = harness({ entries: [] }); editNew(app); app.press("更多信息（选填）");
  app.press("添加密保问题"); app.fill("密保问题 1", "虚构问题一"); app.fill("密保答案 1", "fictional first answer");
  app.press("添加密保问题"); app.fill("密保问题 2", "虚构问题二"); app.fill("密保答案 2", "fictional second answer");
  const retained = app.state.draft.input.questions[1].id;
  app.press("移除密保问题 1"); assert.equal(app.state.draft.input.questions[0].id, retained); assert.equal(app.get("密保答案 1").props.value, "fictional second answer");
  app.press("添加自定义字段"); assert.equal(app.state.draft.input.fields[0].secret, true);
  app.fill("字段名称 1", "虚构恢复项"); app.fill("字段内容 1", "fictional custom secret"); assert.equal(app.get("字段内容 1").props.secureTextEntry, true);
  app.press("更多信息（选填）"); assert.equal(app.render().some((node) => node.type === "Field" && node.props.label === "辅助邮箱"), false);
  app.press("更多信息（选填）"); assert.equal(app.get("字段内容 1").props.value, "fictional custom secret");
});

test("existing encrypted drafts resume instead of being replaced and failed save remains in place", async () => {
  const input = { ...types.emptyVaultInput(), site: "保留的虚构站点", account: "old draft user", password: "fictional saved draft" };
  const app = harness({ draft: { entryId: null, input: clone(input) }, results: { save: false } });
  editNew(app); assert.equal(app.get("网站/网址").props.value, input.site);
  app.press("保存"); await app.settle(); assert.equal(app.get("密码").props.value, input.password);
  app.press("密码管理"); assert.ok(app.state.draft); app.press("继续未完成编辑"); assert.equal(app.get("账号").props.value, input.account);
  app.press("放弃这次编辑"); await app.settle(); assert.equal(app.state.draft, null);
});

test("delete requires a confirmation without password content and removes only the selected record", async () => {
  const app = harness(); app.press("打开密码记录：second.example"); app.press("删除这条记录");
  assert.equal(app.calls.some(([kind]) => kind === "remove"), false);
  assert.ok(!JSON.stringify(app.alerts).includes("fictional-password"));
  const confirm = app.alerts[0][2].find((button) => button.text === "删除"); confirm.onPress(); await app.settle();
  assert.deepEqual(app.calls.find(([kind]) => kind === "remove"), ["remove", "second"]); assert.deepEqual(app.state.entries.map((item) => item.id), ["first"]);
});

test("changing the master password uses confirmation and leaves entry values intact", async () => {
  const app = harness(); app.press("修改主密码"); const original = clone(app.state.entries);
  app.fill("新主密码", "fictional replacement master"); app.fill("再次输入新主密码", "another replacement master"); app.press("更新主密码"); await app.settle();
  assert.equal(app.calls.some(([kind]) => kind === "master"), false);
  app.fill("再次输入新主密码", "fictional replacement master"); app.press("更新主密码"); await app.settle();
  assert.deepEqual(app.calls.find(([kind]) => kind === "master"), ["master", "fictional replacement master"]); assert.deepEqual(app.state.entries, original);
});

test("Android back dismisses the keyboard, returns within the vault, then locks before leaving settings", () => {
  const app = harness({ entries: [] }); editNew(app); app.fill("网站/网址", "保留草稿"); app.keyboard(true);
  assert.equal(app.back(), true); assert.equal(app.keyboardDismisses, 1); assert.equal(app.get("网站/网址").props.value, "保留草稿");
  assert.equal(app.back(), true); assert.ok(app.render().some((node) => node.type === "FlatList")); assert.ok(app.state.draft);
  assert.equal(app.back(), true); const actions = app.calls.map(([kind]) => kind); assert.ok(actions.lastIndexOf("lock") < actions.lastIndexOf("back"));
});

test("locking drops the unlocked subtree, query, reveal state and master inputs before a new session", () => {
  const app = harness(); app.press("打开密码记录：first.example"); app.press("显示密码");
  app.state.status = "locked"; app.render(); assert.equal(isShown(app, "fictional-password-first"), false);
  app.state.status = "unlocked"; app.render(); assert.equal(app.get("搜索密码记录").props.value, "");
  app.press("打开密码记录：first.example"); assert.equal(isShown(app, "fictional-password-first"), false);
  app.press("密码管理"); app.press("修改主密码"); app.fill("新主密码", "fictional master before lock");
  app.state.status = "locked"; app.render(); assert.equal(app.get("输入主密码").props.value, "");
  app.state.status = "unlocked"; app.render(); app.press("修改主密码"); assert.equal(app.get("新主密码").props.value, "");
});
