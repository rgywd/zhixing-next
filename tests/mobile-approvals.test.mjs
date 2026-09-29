import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

// Exercise the actual approval controls with native primitives replaced by inert elements.
function screen(item, decisionError = false) {
  const state = [];
  let cursor = 0;
  let mounted = false;
  const calls = [];
  let refreshed = 0;
  const exports = {};
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    react: {
      useState(initial) {
        const slot = cursor++;
        if (!(slot in state)) state[slot] = initial;
        return [state[slot], (next) => { state[slot] = typeof next === "function" ? next(state[slot]) : next; }];
      },
      useEffect(effect) { if (!mounted) { mounted = true; effect(); } },
    },
    "react-native": { View: "View", Text: "Text" },
    "./ui": { Button: "Button", s: {}, humanError: (error) => error.message },
    "./resources": { shareDownload: async (...args) => { calls.push(args); } },
    "./api": {
      request: async (_connection, path, options) => {
        calls.push({ path, options });
        if (options?.method === "POST") {
          if (decisionError) throw new Error("服务暂不可用");
          return { ...item, state: options.body.decision };
        }
        return { items: [item] };
      },
    },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/ApprovalCards.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: (name) => dependencies[name], AbortController, setInterval: () => 1, clearInterval: () => {} });
  function render() {
    cursor = 0;
    const nodes = [];
    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      nodes.push(node);
      walk(node.props?.children);
    }
    walk(exports.ApprovalCards({
      connection: { url: "https://example.com", token: "local-test" },
      runId: "run-1", onChanged: () => { refreshed += 1; },
    }));
    return nodes;
  }
  render();
  return { render, calls, refreshed: () => refreshed };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("uncertain operation preserves the choice to inspect without authorizing a retry", async () => {
  const page = screen({ id: "approval-1", kind: "uncertain", details: { title: "结果不明", tool: "execute", arguments: { command: "append" } } });
  await settle();
  const button = page.render().find((node) => node.props.children === "保留现状，继续核对");
  button.props.onPress();
  assert.ok(page.render().filter((node) => node.type === "Button").every((node) => node.props.disabled));
  await settle();
  const call = page.calls.find((entry) => entry.options?.method === "POST");
  assert.equal(call.path, "/approvals/approval-1/decision");
  assert.equal(call.options.body.decision, "skip");
  assert.equal(page.refreshed(), 1);
  assert.equal(page.render().filter((node) => node.type === "Button").length, 0);
});

test("failed approval submission retains the review and never reports a successful decision", async () => {
  const page = screen({ id: "approval-2", kind: "overwrite", details: { title: "替换", path: "/docs/a.txt", preview: "-old\\n+new", bytes: 3 } }, true);
  await settle();
  const button = page.render().find((node) => node.props.children === "允许这次操作");
  button.props.onPress();
  await settle();
  assert.equal(page.refreshed(), 0);
  assert.ok(page.render().some((node) => node.props.children === "服务暂不可用"));
  assert.ok(page.render().some((node) => node.props.children === "查看完整新文件"));
  assert.ok(page.render().filter((node) => node.type === "Button").every((node) => !node.props.disabled));
});

