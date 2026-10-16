import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import * as live from "../src/liveRun.ts";
import { replyParts, replySections } from "../src/replyParts.ts";
import { markdownBlockSignature } from "../src/messageMarkdown.ts";
const require = createRequire(import.meta.url);
const parser = require("@ronradtke/react-native-markdown-display/dist/lib/view/parser.js").default;
const { createMarkdownIt } = require("@ronradtke/react-native-markdown-display/dist/lib/view/createMarkdownIt.js");
const { sealIncompleteMarkdown } = require("@ronradtke/react-native-markdown-display/dist/lib/view/util/sealIncompleteMarkdown.js");
const event = (seq, type, data = {}) => ({ seq, type, data, run_id: "r1" });
const snapshot = (seq, message_id, text, type = "assistant.snapshot") => event(seq, type, { stream_id: "s1", message_id, text });
function load(name, dependencies) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  runInNewContext(code, { exports, require(id) { assert.ok(id in dependencies, id); return dependencies[id]; } });
  return exports;
}
const thought = (id, text) => ({ id, type: "reasoning", text });
const text = (id, value) => ({ id, type: "text", text: value });
const tool = (id, name = "web_search", status = "completed") => ({ id, type: "tool", name, status });

test("ordered reply blocks retain the explanation before and after tools; final answer replaces once", () => {
  const buffer = live.mergeLiveRunEvents(live.newLiveRun("r1"), [event(1, "assistant.reset", { stream_id: "s1" }),
    snapshot(2, "m1", "First thought", "reasoning.snapshot"), snapshot(3, "m1", "I will look it up"),
    event(4, "tool", { tool_call_id: "call", tool: "web_search", status: "started" }),
    event(5, "tool", { tool_call_id: "call", tool: "web_search", status: "completed" }),
    snapshot(6, "m2", "Second thought", "reasoning.snapshot"), snapshot(7, "m2", "Partial"), snapshot(8, "m2", "Partial final")]);
  assert.deepEqual(buffer.parts.map((p) => p.type), ["reasoning", "text", "tool", "reasoning", "text"]);
  assert.equal(buffer.parts[2].seq, 4);
  const final = replyParts(buffer.parts, "Durable final", "s1:m2:text");
  assert.equal(final.length, 5); assert.equal(final[1].text, "I will look it up"); assert.equal(final[4].text, "Durable final");
  assert.equal(buffer.parts[4].text, "Partial final", "projection does not mutate the received buffer");
  assert.deepEqual(replySections(final).map((p) => p.type), ["process", "text", "process", "text"]);
  assert.equal(replyParts([], "Legacy final").filter((p) => p.type === "text").length, 1);
  assert.equal(replyParts([tool("call")], "Clipped final", "missing").at(-1).text, "Clipped final");
  const clipped = [text("preface", "Let me check your records"), tool("receipt")];
  assert.deepEqual(replyParts(clipped, "The final answer", null).map((p) => p.type), ["text", "tool", "text"]);
  assert.equal(replyParts(clipped, "The final answer", null)[0].text, "Let me check your records");
  assert.equal(replyParts([text("p", "Prefix")], "Prefix extended", null).length, 2, "explicit null never infers a replacement");
  assert.equal(replyParts([text("p", "Prefix")], "Prefix extended", undefined).length, 1, "unknown legacy receipt may use a matching prefix");
});

test("reset preserves actual tool receipts and failed attempt text is folded into its own process", () => {
  const buffer = live.mergeLiveRunEvents(live.newLiveRun("r1"), [event(1, "assistant.reset", { stream_id: "s1" }),
    snapshot(2, "old", "A failed draft"), event(3, "assistant.attempt", { stream_id: "s1", message_id: "old", status: "failed" }),
    event(4, "tool", { tool_call_id: "call", tool: "record_meal", status: "completed" }), snapshot(5, "new", "Recovered reply")]);
  assert.equal(replySections(buffer.parts)[0].type, "process");
  assert.equal(buffer.parts[0].attempt_status, "failed");
  assert.equal(replyParts(buffer.parts, "Recovered reply final").find((p) => p.id === "s1:new:text").text, "Recovered reply final");
  const reset = live.mergeLiveRunEvents(buffer, [event(6, "assistant.reset", { stream_id: "s2" }), snapshot(7, "old", "Late old stream")]);
  assert.deepEqual(reset.parts.map((p) => p.type), ["tool"]); assert.equal(reset.parts[0].status, "completed");
});

test("compact history hydration and subsequent SSE snapshots have matching stable part identities", () => {
  const initial = [{ id: "s1:m1:text", type: "text", stream_id: "s1", message_id: "m1", seq: 2, text: "Before" },
    { id: "tool:call", type: "tool", seq: 3, tool_call_id: "call", name: "web_search", status: "started" }];
  const hydrated = live.hydrateLiveRun({ run_id: "r1", cursor: 3, stream_id: "s1", status: "running", parts: initial });
  const next = live.mergeLiveRunEvents(hydrated, [snapshot(2, "m1", "Stale"), snapshot(4, "m1", "Before more"),
    event(5, "tool", { tool: "web_search", tool_call_id: "call", status: "completed", output: "private-value" }),
    event(6, "assistant.truncated", { stream_id: "s1", reason: "display_limit" })]);
  assert.equal(next.parts.length, 2); assert.equal(next.parts[0].text, "Before more"); assert.equal(next.parts[0].seq, 2);
  assert.equal(next.parts[1].status, "completed"); assert.equal(next.truncated, true); assert.equal(next.cursor, 6);
  assert.equal(hydrated.parts[0].text, "Before"); assert.ok(!JSON.stringify(next).includes("private-value"));
});

function uiHarness(initial) {
  const states = new Map(); let context; let props = initial;
  const react = { useState(value) { const index = context.index++; if (!(index in context.slots)) context.slots[index] = value;
    const slots = context.slots; return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; } };
  const { ReplyContent } = load("ReplyContent.tsx", { react, "react/jsx-runtime": jsx,
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", ActivityIndicator: "Spinner", ScrollView: "ScrollView" },
    "@react-native-vector-icons/ionicons": { Ionicons: "Icon" }, "./MessageBody": { MessageBody: "Markdown" },
    "./BottomSheet": { BottomSheet: "BottomSheet" }, "./replyParts": { replyParts, replySections },
    "./theme": { layout: { touchTarget: 44 } }, "./ui": { useUi: () => ({ s: { row: {}, muted: {}, description: {}, text: {} }, colors: { line: "#333", muted: "#aaa", gold: "#ca8", red: "#f88" } }) } });
  function visit(node, path = "root") {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((item, index) => visit(item, `${path}/${item?.key ?? index}`));
    if (typeof node.type === "function") {
      const key = `${path}:${node.type.name}`; const prior = context; context = { slots: states.get(key) ?? [], index: 0 }; states.set(key, context.slots);
      const output = node.type(node.props); context = prior; return visit(output, key);
    }
    return { ...node, props: { ...node.props, children: visit(node.props?.children, `${path}/children`) } };
  }
  const walk = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
  return { render(next = props) { props = next; return walk(visit(jsx.jsx(ReplyContent, props))); } };
}
const byLabel = (nodes, label) => nodes.find((n) => n.props?.accessibilityLabel === label);
const bodyTexts = (nodes) => nodes.filter((n) => n.type === "Markdown").map((n) => n.props.children);

test("real reasoning has a bounded preview, full expansion survives completion, untouched process folds", () => {
  const parts = [thought("r", "Actual provider thought\n".repeat(12)), tool("t")];
  const untouched = uiHarness({ parts, active: true });
  let nodes = untouched.render();
  assert.ok(nodes.some((n) => n.type === "Text" && n.props.numberOfLines === 4 && n.props.selectable === false));
  nodes = untouched.render({ parts, active: false, status: "completed" });
  assert.ok(byLabel(nodes, "展开思考与工具过程")); assert.ok(!nodes.some((n) => n.props?.numberOfLines === 4));
  const manual = uiHarness({ parts, active: true }); nodes = manual.render();
  byLabel(nodes, "展开完整思考").props.onPress(); nodes = manual.render({ parts, active: false, status: "completed" });
  assert.ok(byLabel(nodes, "收起思考与工具过程"));
  assert.ok(nodes.some((n) => n.type === "Text" && n.props.children === parts[0].text && n.props.selectable && n.props.numberOfLines === undefined));
  byLabel(nodes, "收起思考").props.onPress(); nodes = manual.render(); assert.ok(byLabel(nodes, "预览思考"));
});

test("process preview shows two latest steps and tool detail follows the real completion receipt", () => {
  let parts = [thought("a", "Early thought"), tool("b", "read_document"), tool("c", "web_search", "started")];
  const ui = uiHarness({ parts, active: true }); let nodes = ui.render();
  assert.ok(!nodes.some((n) => n.props?.children === "Early thought")); assert.ok(byLabel(nodes, "查看全部 3 步"));
  byLabel(nodes, "查看全部 3 步").props.onPress(); nodes = ui.render(); assert.ok(nodes.some((n) => n.props?.children === "Early thought"));
  byLabel(nodes, "搜索网页 · 进行中，查看工具详情").props.onPress(); nodes = ui.render(); assert.ok(nodes.some((n) => n.type === "BottomSheet"));
  parts = [...parts.slice(0, 2), { ...parts[2], status: "completed", args: "fictional-private", output: "fictional-private" }];
  nodes = ui.render({ parts, active: true }); assert.ok(nodes.some((n) => n.type === "Text" && n.props.children === "已完成"));
  assert.ok(!JSON.stringify(nodes).includes("fictional-private"));
});

test("ordered Markdown stays the subject and terminal partial replies keep the correct status", () => {
  const parts = [text("a", "Before tool"), thought("b", "Provider thought"), tool("c"), text("d", "Partial final")];
  const ui = uiHarness({ parts, active: false, status: "failed", cancelRequested: true, connectionIssue: true, finalText: "Durable final", finalPartId: "d" });
  const nodes = ui.render(); assert.deepEqual(bodyTexts(nodes), ["Before tool", "Durable final"]);
  assert.ok(nodes.some((n) => n.props?.children === "回复未完成")); assert.ok(!nodes.some((n) => n.type === "Spinner"));
  assert.ok(!nodes.some((n) => n.props?.children === "正在停止"));
  assert.ok(!byLabel(uiHarness({ parts: [text("x", "Answer")], status: "completed" }).render(), "展开思考与工具过程"));
});

function parse(source) { let result; parser(source, (nodes) => { result = nodes; return null; }, createMarkdownIt()); return result; }
test("Markdown signatures reuse semantic blocks despite random parser keys and notice real link changes", () => {
  const first = parse("Stable paragraph\n\nNext"), second = parse("Stable paragraph\n\nNext growing");
  assert.notEqual(first[0].key, second[0].key); assert.equal(markdownBlockSignature(first[0]), markdownBlockSignature(second[0]));
  assert.notEqual(markdownBlockSignature(first[1]), markdownBlockSignature(second[1]));
  assert.notEqual(markdownBlockSignature(parse("[go][x]\n\n[x]: https://one.test")[0]), markdownBlockSignature(parse("[go][x]\n\n[x]: https://two.test")[0]));
});
test("incomplete code and table snapshots retain all source text through completion", () => {
  const code = "Intro\n\n```js\nconst amount = 18;\nconst next =";
  const projected = sealIncompleteMarkdown(code); assert.ok(projected.startsWith(code)); assert.equal(code.endsWith("```"), false);
  assert.ok(parse(projected).find((node) => node.type === "fence").content.includes("const next ="));
  const table = "| Item | Amount |\n| --- | --- |\n| Lunch | 18 |\n| Dinner |";
  const ast = parse(table); assert.equal(ast[0].type, "table"); assert.ok(JSON.stringify(ast).includes("Lunch")); assert.ok(JSON.stringify(ast).includes("Dinner"));
  const finished = parse(`${table} 20 |\n\nDone`); assert.ok(JSON.stringify(finished).includes('"content":"20"')); assert.equal(finished.at(-1).type, "paragraph");
});

test("MessageBody renders the complete final source immediately and disables selection while streaming", () => {
  const blockComparisons = []; let deferred = "Previous";
  const { MessageBody } = load("MessageBody.tsx", { react: { memo(fn, compare) { fn.compare = compare; blockComparisons.push(compare); return fn; }, useDeferredValue: () => deferred, useMemo: (fn) => fn() },
    "react/jsx-runtime": jsx, "react-native": { Text: "Text", View: "View" },
    "@ronradtke/react-native-markdown-display": { __esModule: true, default: "Markdown", createMarkdownIt, parser, sealIncompleteMarkdown },
    "./ThemeProvider": { useTheme: () => ({ mode: "dark" }), useThemedStyles: (factory) => factory({ ink: "#fff", muted: "#aaa", line: "#333" }) },
    "./messageMarkdown": { markdownBlockSignature } });
  const current = MessageBody({ children: "Current complete", streaming: true }).props.children[0];
  let rendered = current.type(current.props); assert.equal(rendered.props.children[0].children[0].children[0].content, "Previous");
  assert.equal(rendered.props.textcomponent({}).props.selectable, false);
  deferred = "Previous";
  const final = MessageBody({ children: "Current complete", streaming: false }).props.children[0]; rendered = final.type(final.props);
  assert.ok(JSON.stringify(rendered.props.children).includes("Current complete")); assert.equal(rendered.props.textcomponent({}).props.selectable, true);
  const same = { ...final.props, node: { ...final.props.node, key: "new-random-key" } };
  assert.equal(blockComparisons[0](final.props, same), true);
});

test("Markdown tables share fixed column boundaries across unequal headers, rows and incomplete cells", () => {
  const { MessageBody } = load("MessageBody.tsx", { react: { memo: (fn) => fn, useDeferredValue: (value) => value, useMemo: (fn) => fn() },
    "react/jsx-runtime": jsx, "react-native": { Text: "Text", View: "View", ScrollView: "ScrollView" },
    "@ronradtke/react-native-markdown-display": { __esModule: true, default: "Markdown", createMarkdownIt, parser, sealIncompleteMarkdown },
    "./ThemeProvider": { useTheme: () => ({ mode: "dark" }), useThemedStyles: (factory) => factory({ ink: "#fff", muted: "#aaa", line: "#333" }) },
    "./messageMarkdown": { markdownBlockSignature } });
  const sources = [
    "| 事项 | 现在可以做 |\n| --- | --- |\n| 开销 | 记下一笔，看看本月余量 |\n| 饮食 | 记录这一餐，给下一餐留余地 |",
    "| A | Much longer heading | Third |\n| --- | --- | --- |\n| A very long first cell | 1 | [Link](https://fixture.test) |\n| B | Incomplete |",
  ];
  const flatten = (style) => Object.assign({}, ...style.filter(Boolean));
  for (const source of sources) {
    const block = MessageBody({ children: source, streaming: true }).props.children[0];
    const markdown = block.type(block.props), rules = markdown.props.rules, table = markdown.props.children[0];
    const rows = table.children.flatMap((section) => section.children).filter((node) => node.type === "tr");
    const renderedTable = rules.table(table, ["semantic table children"], [], {});
    assert.equal(renderedTable.type, "ScrollView"); assert.equal(renderedTable.props.horizontal, true);
    assert.equal(renderedTable.props.children.props.children[0], "semantic table children");
    const gridWidth = flatten(renderedTable.props.children.props.style).width - 2;
    const columnCount = rows[0].children.length;
    assert.equal(gridWidth, columnCount * 160);
    const boundaries = rows.map((row) => {
      const renderedRow = rules.tr(row, [], [table], {});
      assert.equal(flatten(renderedRow.props.style).width, gridWidth);
      let offset = 0;
      return row.children.map((cell) => {
        const renderedCell = rules[cell.type](cell, [cell.children], [row, table], {}), style = flatten(renderedCell.props.style);
        assert.equal(style.flexGrow, 0); assert.equal(style.flexShrink, 0); assert.equal(style.width, 160);
        assert.equal(style.minWidth, style.maxWidth); assert.equal(renderedCell.props.children[0], cell.children);
        const boundary = offset; offset += style.width; return boundary;
      });
    });
    for (const row of boundaries) assert.deepEqual(row, boundaries[0], "every row uses exactly the header's column positions");
    assert.ok(gridWidth > 284, "a 320dp screen scrolls the grid locally instead of shrinking cells per row");
    assert.ok(JSON.stringify(table).includes(source.includes("事项") ? "给下一餐留余地" : "https://fixture.test"), "complete semantic content survives the layout rule");
  }
});
