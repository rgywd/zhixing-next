import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

function load(name, mode = "light") {
  const exports = {};
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    "react-native": { Image: "Image", View: "View", Text: "Text", StyleSheet: { create: (styles) => styles } },
    "./theme": { radius: { item: 16 }, typography: { detail: {}, body: {} } },
    "./ThemeProvider": { useThemedStyles: (factory) => factory({}) },
    "./ui": {
      useUi: () => ({ s: {}, mode }),
      ...Object.fromEntries(["ActionRow", "CardHeader", "Empty", "IconBadge", "PageHero", "PageScrollView", "ServiceTile"].map((key) => [key, key])),
    },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${name}.tsx`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports,
    require: (key) => {
      if (key.startsWith("../assets/")) return key;
      assert.ok(key in dependencies, `Unexpected dependency: ${key}`);
      return dependencies[key];
    },
  });
  return exports[name];
}

function nodes(element) {
  if (!element || typeof element !== "object") return [];
  return [element, ...[element.props?.children].flat(Infinity).flatMap(nodes)];
}

const noop = () => {};

test("life keeps finance and health as separate service destinations", () => {
  const visits = [];
  const LifePanel = load("LifePanel");
  const tree = LifePanel({ onFinance: () => visits.push("finance"), onHealth: () => visits.push("health"), onChat: noop });
  assert.equal(tree.type, "PageScrollView");
  assert.equal(tree.props.tabs, true);
  const hero = nodes(tree).find((node) => node.type === "PageHero");
  assert.equal(hero.props.title, "生活");
  assert.match(hero.props.art, /life-header-red\.png$/);
  const services = nodes(tree).filter((node) => node.type === "ServiceTile");
  assert.deepEqual(services.map((node) => node.props.title), ["财务", "健康"]);
  for (const service of services) service.props.onPress();
  assert.deepEqual(visits, ["finance", "health"]);
});

test("life displays the supplied real overview instead of duplicating service cards", () => {
  const LifePanel = load("LifePanel");
  const intro = jsxRuntime.jsx("RealLifeOverview", { value: "server data" });
  const tree = LifePanel({ onFinance: noop, onHealth: noop, onChat: noop, intro });
  assert.ok(nodes(tree).includes(intro));
  assert.equal(nodes(tree).filter((node) => node.type === "ServiceTile").length, 0);
  assert.equal(nodes(tree).filter((node) => node.type === "ActionRow").length, 3);
});

test("other life services prefill ordinary chat without old finance or duplicate health shortcuts", () => {
  const prompts = [];
  const LifePanel = load("LifePanel");
  const tree = LifePanel({ onFinance: noop, onHealth: noop, onChat: (prompt) => prompts.push(prompt) });
  const rows = nodes(tree).filter((node) => node.type === "ActionRow");
  assert.deepEqual(rows.map((node) => node.props.title), ["购物", "出行", "家居"]);
  for (const row of rows) row.props.onPress();
  assert.equal(prompts.length, 3);
  assert.match(prompts[0], /购物/);
  assert.match(prompts[1], /出行/);
  assert.match(prompts[2], /家居/);
  const titles = nodes(tree).map((node) => node.props?.title).filter(Boolean);
  assert.equal(titles.filter((title) => title === "健康").length, 1);
  assert.ok(!titles.includes("税务问题") && !titles.includes("理财建议"));
});

test("life hides its decorative footer illustration in dark mode", () => {
  const render = (mode) => load("LifePanel", mode)({ onFinance: noop, onHealth: noop, onChat: noop });
  assert.equal(nodes(render("light")).filter((node) => node.type === "Image").length, 1);
  assert.equal(nodes(render("dark")).filter((node) => node.type === "Image").length, 0);
});

test("construction is a local placeholder without retired work actions", () => {
  const ConstructionPage = load("ConstructionPage");
  const tree = ConstructionPage();
  assert.equal(tree.type, "PageScrollView");
  assert.equal(tree.props.tabs, true);
  const hero = nodes(tree).find((node) => node.type === "PageHero");
  const empty = nodes(tree).find((node) => node.type === "Empty");
  assert.equal(hero.props.title, "施工中");
  assert.equal(empty.props.title, "功能待定");
  assert.equal(empty.props.icon, "construct-outline");
  assert.ok(nodes(tree).every((node) => !Object.keys(node.props ?? {}).some((key) => /^on[A-Z]/.test(key))));
  assert.ok(!nodes(tree).some((node) => /项目|任务|计划/.test(node.props?.title ?? "")));
});
