import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as vaultTypes from "../src/vaultTypes.ts";
import {
  decodeVaultPayload,
  emptyVaultInput,
  searchVaultEntries,
  validateVaultInput,
} from "../src/vaultTypes.ts";

// Every secret in this file is a deliberately fictional sentinel.
const FAKE_PASSWORD = "  TEST-ONLY-PASSWORD-SENTINEL\t ";
const FAKE_ANSWER = "  TEST-ONLY-ANSWER-SENTINEL\n";
const input = (changes = {}) => ({ ...emptyVaultInput(), site: "https://sentinel.example.invalid", account: "fictional-person", password: FAKE_PASSWORD, ...changes });
const entry = (id = "entry-a", changes = {}) => ({ ...input(), id, createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T01:00:00.000Z", ...changes });
const payload = (changes = {}) => ({ version: 1, entries: [entry()], draft: null, ...changes });
const decode = (value) => decodeVaultPayload(JSON.stringify(value));
function corrupt(value) {
  assert.throws(() => decode(value), (error) => {
    assert.equal(error.message, "密码库内容无法读取，原加密文件已保留。");
    assert.doesNotMatch(error.message, /TEST-ONLY|fictional-person/);
    return true;
  });
}

test("vault requires only site/account/password, accepts password whitespace, and never normalizes secret bytes", () => {
  const fields = { site: "网站", account: "账号", password: "密码" };
  for (const [key, name] of Object.entries(fields)) {
    assert.throws(() => validateVaultInput(input({ [key]: "" })), new RegExp(name));
    if (key !== "password") assert.throws(() => validateVaultInput(input({ [key]: " \t\n" })), new RegExp(name));
  }
  const source = input({ site: "  任意网站  ", account: "  user@example.invalid  ", password: " \t\n", recoveryEmail: "", phone: "", notes: "" });
  const saved = validateVaultInput(source);
  assert.equal(saved.site, "任意网站");
  assert.equal(saved.account, "user@example.invalid");
  assert.equal(saved.password, " \t\n");
  assert.equal(source.site, "  任意网站  ");
  assert.deepEqual(source.questions, []);
  assert.deepEqual(source.fields, []);
});

test("optional recovery contacts, unanswered questions, and custom pairs retain exact values without adding requirements", () => {
  const source = input({ recoveryEmail: "  recovery@example.invalid ", phone: "  +00 123  ", notes: "  本机虚构备注\n",
    questions: [{ id: "q-empty", question: "  ", answer: "" }, { id: "q-one", question: "  虚构问题  ", answer: FAKE_ANSWER }, { id: "q-later", question: "以后补答案", answer: "" }],
    fields: [{ id: "f-empty", label: "  ", value: "", secret: false }, { id: "f-one", label: "  虚构自定义字段  ", value: "  VALUE-SENTINEL\n", secret: true }, { id: "f-later", label: "非敏感说明", value: "", secret: false }] });
  const before = structuredClone(source), saved = validateVaultInput(source);
  assert.equal(saved.password, FAKE_PASSWORD);
  assert.equal(saved.recoveryEmail, "recovery@example.invalid");
  assert.equal(saved.phone, "+00 123");
  assert.equal(saved.notes, "  本机虚构备注\n");
  assert.deepEqual(saved.questions, [{ id: "q-one", question: "虚构问题", answer: FAKE_ANSWER }, { id: "q-later", question: "以后补答案", answer: "" }]);
  assert.deepEqual(saved.fields, [{ id: "f-one", label: "虚构自定义字段", value: "  VALUE-SENTINEL\n", secret: true }, { id: "f-later", label: "非敏感说明", value: "", secret: false }]);
  assert.deepEqual(source, before);
});

test("a retained answer/value requires its own question/label and validation errors never echo secrets", () => {
  for (const changes of [
    { questions: [{ id: "q", question: " \t", answer: FAKE_ANSWER }] },
    { fields: [{ id: "f", label: "  ", value: FAKE_PASSWORD, secret: true }] },
  ]) assert.throws(() => validateVaultInput(input(changes)), (error) => {
    assert.match(error.message, /补充/);
    assert.doesNotMatch(error.message, /TEST-ONLY/);
    return true;
  });
});

test("entry length/count limits accept boundary values and reject excess data with safe errors", () => {
  validateVaultInput(input({ site: "s".repeat(2000), account: "a".repeat(2000), password: "p".repeat(20000), recoveryEmail: "r".repeat(2000), phone: "n".repeat(2000), notes: "z".repeat(20000),
    questions: Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, question: "q".repeat(2000), answer: "a".repeat(20000) })),
    fields: Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, label: "l".repeat(2000), value: "v".repeat(20000), secret: i % 2 === 0 })) }));
  for (const changes of [
    ...["site", "account", "recoveryEmail", "phone"].map((key) => ({ [key]: "x".repeat(2001) })),
    { password: "x".repeat(20001) }, { notes: "x".repeat(20001) },
    { questions: Array.from({ length: 31 }, (_, i) => ({ id: `q${i}`, question: "q", answer: "" })) },
    { fields: Array.from({ length: 31 }, (_, i) => ({ id: `f${i}`, label: "f", value: "", secret: false })) },
    { questions: [{ id: "q", question: "q".repeat(2001), answer: "" }] },
    { questions: [{ id: "q", question: "q", answer: "a".repeat(20001) }] },
    { fields: [{ id: "f", label: "l".repeat(2001), value: "", secret: true }] },
    { fields: [{ id: "f", label: "l", value: "v".repeat(20001), secret: true }] },
  ]) assert.throws(() => validateVaultInput(input(changes)), /过长|最多/);
});

test("same website and account can be retained as distinct entries without deduplication", () => {
  const first = entry("one"), second = entry("two", { password: "DIFFERENT-TEST-ONLY-PASSWORD" });
  const result = decode(payload({ entries: [first, second] }));
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].site, result.entries[1].site);
  assert.equal(result.entries[0].account, result.entries[1].account);
  assert.notEqual(result.entries[0].password, result.entries[1].password);
});

test("valid encrypted payload round-trips all local fields and retains incomplete new/edit drafts", () => {
  const saved = entry("one", { questions: [{ id: "q", question: "虚构问题", answer: FAKE_ANSWER }], fields: [{ id: "f", label: "附加密码", value: FAKE_PASSWORD, secret: true }] });
  for (const draft of [null, { entryId: null, input: emptyVaultInput() }, { entryId: "one", input: { ...emptyVaultInput(), site: "尚未完成" } }]) {
    const source = payload({ entries: [saved], draft });
    assert.deepEqual(decode(source), source);
  }
});

test("corrupt, unknown-version, duplicate-ID or dangling-draft payloads fail closed instead of becoming empty vaults", () => {
  for (const value of [null, [], {}, { version: 2, entries: [], draft: null }, { version: 1, entries: {}, draft: null },
    payload({ entries: [entry("same"), entry("same")] }), payload({ entries: [entry("")] }),
    ...[7, true, {}].map((id) => payload({ entries: [entry(id)] })),
    payload({ draft: { entryId: "missing", input: emptyVaultInput() } }), payload({ draft: { entryId: false, input: emptyVaultInput() } }),
    payload({ draft: {} }), payload({ draft: undefined }), payload({ entries: [entry("one", { password: "" })] }),
    payload({ entries: [entry("one", { site: "   " })] }), payload({ entries: [entry("one", { createdAt: 123 })] }),
    payload({ entries: [entry("one", { fields: [{ id: "f", label: "l", value: "v", secret: "true" }] })] }),
    payload({ entries: [entry("one", { questions: [{ id: 7, question: "q", answer: "a" }] })] }),
    payload({ entries: Array.from({ length: 5001 }, (_, i) => entry(`entry-${i}`)) }),
  ]) corrupt(value);
  for (const value of ["", "not-json", '{"version":1,"entries":[', '"TEST-ONLY-MALFORMED"']) {
    assert.throws(() => decodeVaultPayload(value), /原加密文件已保留/);
  }
});

test("malformed optional strings/arrays and incomplete draft shapes fail closed without exposing values", () => {
  for (const changes of [{ notes: null }, { recoveryEmail: false }, { phone: 123 }, { questions: {} }, { fields: null }, { questions: [null] }, { fields: [null] }]) {
    corrupt(payload({ entries: [entry("one", changes)] }));
    corrupt(payload({ draft: { entryId: null, input: { ...emptyVaultInput(), ...changes } } }));
  }
});

test("oversized incomplete drafts fail closed while genuinely incomplete blank drafts remain usable", () => {
  for (const changes of [{ password: "x".repeat(20001) }, { notes: "x".repeat(20001) }, { account: "x".repeat(2001) },
    { questions: Array.from({ length: 31 }, (_, i) => ({ id: `q${i}`, question: "", answer: "" })) },
    { fields: Array.from({ length: 31 }, (_, i) => ({ id: `f${i}`, label: "", value: "", secret: false })) },
  ]) corrupt(payload({ draft: { entryId: null, input: { ...emptyVaultInput(), ...changes } } }));
  assert.deepEqual(decode(payload({ draft: { entryId: null, input: emptyVaultInput() } })).draft.input, emptyVaultInput());
});

test("metadata search is case-insensitive, requires every term, sorts recent first, and does not mutate entries", () => {
  const entries = [entry("older", { site: "Mailbox.EXAMPLE.invalid", account: "Alice", recoveryEmail: "help@example.invalid", phone: "+00 123", updatedAt: "2026-10-14T00:00:00Z" }),
    entry("newer", { site: "Mailbox.example.invalid", account: "Alice", updatedAt: "2026-10-15T00:00:00Z" }), entry("other", { site: "Other.example.invalid", account: "Bob" })];
  const original = structuredClone(entries);
  assert.deepEqual(searchVaultEntries(entries, "  MAILBOX   alice  ").map((value) => value.id), ["newer", "older"]);
  assert.deepEqual(searchVaultEntries(entries, "mailbox bob"), []);
  assert.deepEqual(searchVaultEntries(entries, "help@example.invalid").map((value) => value.id), ["older"]);
  assert.deepEqual(searchVaultEntries(entries, "+00 123").map((value) => value.id), ["older"]);
  assert.equal(searchVaultEntries(entries, " \t ").length, 3);
  assert.deepEqual(entries, original);
});

test("search never indexes passwords, security questions/answers, notes or custom field values", () => {
  const record = entry("one", { password: "PASSWORD-EXCLUSIVE-SECRET", questions: [{ id: "q", question: "QUESTION-EXCLUSIVE", answer: "ANSWER-EXCLUSIVE-SECRET" }],
    notes: "NOTE-EXCLUSIVE", fields: [{ id: "f", label: "LABEL-EXCLUSIVE", value: "FIELD-EXCLUSIVE-SECRET", secret: true }, { id: "public", label: "PUBLIC-LABEL-EXCLUSIVE", value: "PUBLIC-VALUE-EXCLUSIVE", secret: false }] });
  for (const query of ["PASSWORD-EXCLUSIVE", "ANSWER-EXCLUSIVE", "QUESTION-EXCLUSIVE", "NOTE-EXCLUSIVE", "LABEL-EXCLUSIVE", "FIELD-EXCLUSIVE", "PUBLIC-VALUE-EXCLUSIVE"]) assert.deepEqual(searchVaultEntries([record], query), []);
  assert.equal(searchVaultEntries([record], "sentinel").length, 1);
});


test("question/custom field identity corruption fails closed for saved entries and incomplete drafts", () => {
  const questions = [{ id: "same", question: "虚构一", answer: "" }, { id: "same", question: "虚构二", answer: "" }];
  const fields = [{ id: "same", label: "字段一", value: "", secret: false }, { id: "same", label: "字段二", value: "", secret: true }];
  for (const changes of [{ questions }, { fields }, { questions: [{ id: "", question: "q", answer: "" }] },
    { fields: [{ id: "x".repeat(129), label: "l", value: "", secret: false }] }]) {
    corrupt(payload({ entries: [entry("one", changes)] }));
    corrupt(payload({ draft: { entryId: null, input: { ...emptyVaultInput(), ...changes } } }));
  }
});


function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((yes) => setImmediate(yes)); };
const controllerExports = {};
runInNewContext(ts.transpileModule(readFileSync(new URL("../src/vaultController.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: controllerExports, Date, Error, Promise, Set, Map, JSON,
  require(name) { assert.equal(name, "./vaultTypes"); return vaultTypes; } });
const { VaultController, VAULT_IDLE_MS } = controllerExports;
const FAKE_MASTER = "TEST-ONLY-MASTER-PASSWORD";
const NEXT_FAKE_MASTER = "DIFFERENT-TEST-ONLY-MASTER";

// This fake crypto boundary maps opaque ciphertext tokens to fictional documents.
// It verifies controller data flow/races; it does not claim to test cryptography.
function vault({ existing = true, content = payload(), supported = true } = {}) {
  let now = Date.parse("2026-10-15T02:00:00Z"), nextId = 0, raw = null, nextTimer = 0;
  const timers = new Map(), keys = new Map(), documents = new Map();
  const calls = { read: 0, write: [], seal: [], create: [], copy: [], clear: 0, generate: 0 };
  const faults = { read: false, write: false, lostAck: false, writeAt: 0, beforeSeal: null, beforeWrite: null, beforeKey: null, beforeUnlock: null, beforeCopy: null, beforeGenerate: null };
  const makeKey = (master) => { const key = `opaque-test-key-${++nextId}`; keys.set(key, master); return key; };
  const envelope = (value, key, salt = `test-salt-${nextId}`) => {
    const ciphertext = `opaque-test-cipher-${++nextId}`;
    documents.set(ciphertext, { payload: structuredClone(value), key });
    return { version: 1, salt, nonce: "opaque-test-nonce", ciphertext };
  };
  if (existing) raw = JSON.stringify(envelope(content, makeKey(FAKE_MASTER)));
  const parse = (text) => { const value = JSON.parse(text); if (value.version !== 1 || typeof value.salt !== "string" || typeof value.ciphertext !== "string") throw new Error("invalid-test-envelope"); return value; };
  const unlock = async (env, master) => {
    const document = documents.get(env.ciphertext);
    if (!document || keys.get(document.key) !== master) throw new Error(`bad-password-or-cipher:${master}`);
    return { key: document.key, payload: vaultTypes.decodeVaultPayload(JSON.stringify(document.payload)) };
  };
  const ports = {
    supported: () => supported,
    readRaw: async () => { calls.read++; if (faults.read) throw new Error("TEST-ONLY-IO-ERROR"); return raw; },
    writeRaw: async (next, expected) => {
      calls.write.push({ raw: next, expected });
      if (faults.beforeWrite) await faults.beforeWrite(next);
      if (faults.write || faults.writeAt === calls.write.length || expected !== raw) throw new Error("TEST-ONLY-WRITE-ERROR");
      raw = next;
      if (faults.lostAck) { faults.lostAck = false; throw new Error("TEST-ONLY-LOST-RECEIPT"); }
    },
    parse,
    createKey: async (master) => { calls.create.push(master); if (faults.beforeKey) await faults.beforeKey(); return { key: makeKey(master), salt: `test-salt-${nextId}` }; },
    unlock: async (env, master) => { if (faults.beforeUnlock) await faults.beforeUnlock(); return unlock(env, master); },
    seal: async (value, key, salt) => { calls.seal.push(structuredClone(value)); if (faults.beforeSeal) await faults.beforeSeal(); return envelope(value, key, salt); },
    copy: async (value) => { calls.copy.push(value); if (faults.beforeCopy) await faults.beforeCopy(); },
    clearClipboard: async () => { calls.clear++; },
    generate: async () => { calls.generate++; if (faults.beforeGenerate) await faults.beforeGenerate(); return "GENERATED-TEST-ONLY-SECRET"; },
    id: () => `entry-generated-${++nextId}`, now: () => now,
    later: (action, ms) => { const id = ++nextTimer; timers.set(id, { action, at: now + ms }); return id; },
    cancel: (id) => { timers.delete(id); },
  };
  const controller = new VaultController(ports);
  return { controller, ports, calls, faults, timers, raw: () => raw, setRaw: (value) => { raw = value; },
    externalWrite: (value) => { raw = JSON.stringify(envelope(value, makeKey("EXTERNAL-TEST-ONLY-MASTER"))); },
    document: () => structuredClone(documents.get(parse(raw).ciphertext).payload),
    async open() { await controller.start(); assert.equal(await controller.unlock(FAKE_MASTER), true); },
    async tick(ms) {
      const until = now + ms;
      for (;;) { const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break; timers.delete(next[0]); now = next[1].at; next[1].action(); await settle(); }
      now = until; await settle();
    },
  };
}
function noUnlockedSecrets(state) {
  assert.deepEqual(Array.from(state.entries), []);
  assert.equal(state.draft, null);
  assert.doesNotMatch(JSON.stringify(state), /TEST-ONLY-(?:PASSWORD|ANSWER|MASTER)/);
}

test("unsupported, unreadable and corrupt envelope states never offer a silently empty replacement vault", async () => {
  const unsupported = vault({ supported: false }); await unsupported.controller.start();
  assert.equal(unsupported.controller.getSnapshot().status, "unsupported"); assert.equal(unsupported.calls.read, 0);
  assert.equal(await unsupported.controller.create(FAKE_MASTER), false);
  const app = vault(); const before = app.raw(); app.faults.read = true; await app.controller.start();
  assert.equal(app.controller.getSnapshot().status, "error"); assert.equal(app.raw(), before); assert.equal(app.calls.write.length, 0);
  assert.equal(await app.controller.create(FAKE_MASTER), false);
  app.faults.read = false; app.setRaw('{"version":99,"ciphertext":"TEST-ONLY-CORRUPT"}'); await app.controller.start();
  assert.equal(app.controller.getSnapshot().status, "error"); assert.equal(app.calls.write.length, 0);
  noUnlockedSecrets(app.controller.getSnapshot());
});

test("creation validates master length without trimming, writes only an opaque envelope, and locks empty memory", async () => {
  const app = vault({ existing: false }); await app.controller.start();
  assert.equal(app.controller.getSnapshot().status, "create");
  for (const master of ["", "short", "x".repeat(1025)]) assert.equal(await app.controller.create(master), false);
  assert.equal(app.calls.create.length, 0); assert.equal(app.calls.write.length, 0);
  const master = " ".repeat(12);
  assert.equal(await app.controller.create(master), true); assert.equal(app.calls.create[0], master);
  assert.equal(app.controller.getSnapshot().status, "unlocked"); assert.equal(app.calls.write.length, 1);
  assert.doesNotMatch(app.raw(), /entries|password|notes/);
  app.controller.lock(); assert.equal(app.controller.getSnapshot().status, "locked"); noUnlockedSecrets(app.controller.getSnapshot());
  assert.equal(await app.controller.unlock(master), true);
});

test("wrong master or bad authenticated ciphertext leaves the original file unchanged and hides native error contents", async () => {
  const app = vault(); await app.controller.start(); const original = app.raw();
  assert.equal(await app.controller.unlock("WRONG-TEST-ONLY-MASTER"), false);
  assert.equal(app.raw(), original); assert.equal(app.calls.write.length, 0); assert.equal(app.controller.getSnapshot().status, "locked");
  assert.match(app.controller.getSnapshot().error, /主密码不正确|无法解密/);
  assert.doesNotMatch(app.controller.getSnapshot().error, /WRONG|TEST-ONLY/); noUnlockedSecrets(app.controller.getSnapshot());
  app.setRaw(JSON.stringify({ version: 1, salt: "fake", ciphertext: "unknown-opaque-token" }));
  const corruptRaw = app.raw(); assert.equal(await app.controller.unlock(FAKE_MASTER), false);
  assert.equal(app.raw(), corruptRaw); assert.equal(app.calls.write.length, 0); noUnlockedSecrets(app.controller.getSnapshot());
});

test("save first encrypts a draft then commits the record, permits duplicate accounts, and preserves secret whitespace", async () => {
  const app = vault({ content: payload({ entries: [] }) }); await app.open();
  app.controller.beginEdit(); app.controller.updateDraft(input({ questions: [{ id: "q", question: "虚构问题", answer: FAKE_ANSWER }] }));
  assert.equal(await app.controller.save(), true);
  assert.equal(app.calls.write.length, 2); assert.equal(app.calls.seal[0].draft.input.password, FAKE_PASSWORD);
  assert.equal(app.calls.seal[1].draft, null); assert.equal(app.controller.getSnapshot().entries[0].password, FAKE_PASSWORD);
  app.controller.beginEdit(); app.controller.updateDraft(input()); assert.equal(await app.controller.save(), true);
  const entries = app.controller.getSnapshot().entries;
  assert.equal(entries.length, 2); assert.notEqual(entries[0].id, entries[1].id); assert.equal(entries[0].account, entries[1].account);
  for (const write of app.calls.write) assert.doesNotMatch(write.raw, /TEST-ONLY|fictional-person|entries|password/);
});

test("incomplete draft save does not commit and editing a saved entry never mutates that original before persistence", async () => {
  const app = vault(); await app.open(); app.controller.beginEdit("entry-a");
  const changed = input({ password: "CHANGED-TEST-ONLY-SECRET", notes: "虚构修改" }); app.controller.updateDraft(changed); changed.password = "AFTER-CALL-MUTATION";
  assert.equal(app.controller.getSnapshot().entries[0].password, FAKE_PASSWORD);
  assert.equal(app.controller.getSnapshot().draft.input.password, "CHANGED-TEST-ONLY-SECRET");
  app.controller.updateDraft({ ...changed, site: "", password: FAKE_PASSWORD });
  assert.equal(await app.controller.save(), false); assert.equal(app.calls.write.length, 0);
  assert.equal(app.controller.getSnapshot().draft.input.site, ""); assert.equal(app.controller.getSnapshot().entries[0].password, FAKE_PASSWORD);
});

test("failed draft flush retains the editor and prior record, and a retry completes without duplicating entries", async () => {
  const app = vault(); await app.open(); app.controller.beginEdit("entry-a"); app.controller.updateDraft(input({ password: "CHANGED-TEST-ONLY-SECRET" }));
  const before = app.raw(); app.faults.write = true;
  assert.equal(await app.controller.save(), false); assert.equal(app.raw(), before);
  assert.equal(app.controller.getSnapshot().draft.input.password, "CHANGED-TEST-ONLY-SECRET"); assert.equal(app.controller.getSnapshot().entries[0].password, FAKE_PASSWORD);
  assert.match(app.controller.getSnapshot().storageError, /尚未加密保存/);
  app.faults.write = false; assert.equal(await app.controller.save(), true);
  assert.equal(app.controller.getSnapshot().draft, null); assert.equal(app.controller.getSnapshot().entries.length, 1);
  assert.equal(app.controller.getSnapshot().entries[0].id, "entry-a"); assert.equal(app.controller.getSnapshot().entries[0].password, "CHANGED-TEST-ONLY-SECRET");
});

test("record-commit failure leaves encrypted draft recoverable and does not replace prior saved entries", async () => {
  const app = vault(); await app.open(); app.controller.beginEdit("entry-a"); app.controller.updateDraft(input({ notes: "COMMIT-FAIL-TEST-ONLY" }));
  app.faults.writeAt = 2; assert.equal(await app.controller.save(), false);
  assert.equal(app.document().entries[0].notes, ""); assert.equal(app.document().draft.input.notes, "COMMIT-FAIL-TEST-ONLY");
  assert.equal(app.controller.getSnapshot().draft.input.notes, "COMMIT-FAIL-TEST-ONLY");
  app.faults.writeAt = 0; assert.equal(await app.controller.save(), true);
  assert.equal(app.document().entries.length, 1); assert.equal(app.document().entries[0].notes, "COMMIT-FAIL-TEST-ONLY");
});

test("debounced encrypted draft writes serialize and a late older seal cannot overwrite the newest edit", async () => {
  const app = vault(); await app.open(); app.controller.beginEdit(); app.controller.updateDraft(input({ notes: "FIRST-TEST-ONLY" }));
  const sealing = deferred(); let first = true;
  app.faults.beforeSeal = async () => { if (first) { first = false; await sealing.promise; } };
  await app.tick(250); assert.equal(app.calls.seal.length, 1); assert.equal(app.calls.write.length, 0);
  app.controller.updateDraft(input({ notes: "LATEST-TEST-ONLY" })); await app.tick(250);
  sealing.resolve(); await settle();
  assert.equal(app.calls.write.length, 2); assert.equal(app.document().draft.input.notes, "LATEST-TEST-ONLY");
  assert.equal(app.controller.getSnapshot().draft.input.notes, "LATEST-TEST-ONLY"); assert.equal(app.controller.getSnapshot().draftSaving, false);
});

test("lost atomic-write receipt is reconciled by readback, preserving one create/save result", async () => {
  const app = vault({ existing: false }); await app.controller.start(); app.faults.lostAck = true;
  assert.equal(await app.controller.create(FAKE_MASTER), true); assert.equal(app.calls.write.length, 1);
  app.controller.beginEdit(); app.controller.updateDraft(input()); app.faults.lostAck = true;
  assert.equal(await app.controller.save(), true); assert.equal(app.document().entries.length, 1); assert.equal(app.controller.getSnapshot().entries.length, 1);
});

test("lock during decryption clears UI immediately and rejects a late unlock result without restoring timers", async () => {
  const app = vault(); await app.controller.start(); const decrypting = deferred(); app.faults.beforeUnlock = () => decrypting.promise;
  const task = app.controller.unlock(FAKE_MASTER); app.controller.lock(); noUnlockedSecrets(app.controller.getSnapshot());
  decrypting.resolve(); assert.equal(await task, false); assert.equal(app.controller.getSnapshot().status, "locked");
  noUnlockedSecrets(app.controller.getSnapshot()); assert.equal(app.timers.size, 0); assert.equal(app.calls.write.length, 0);
});

test("background-style lock clears decrypted state before pending encryption finishes and retains only ciphertext on disk", async () => {
  const app = vault(); await app.open(); app.controller.beginEdit(); app.controller.updateDraft(input({ notes: "RECOVER-AFTER-LOCK-TEST-ONLY" }));
  const sealing = deferred(); app.faults.beforeSeal = () => sealing.promise;
  app.controller.lock(); assert.equal(app.controller.getSnapshot().status, "locked"); noUnlockedSecrets(app.controller.getSnapshot());
  assert.equal(app.timers.size, 0); sealing.resolve(); await settle();
  assert.equal(app.controller.getSnapshot().status, "locked"); noUnlockedSecrets(app.controller.getSnapshot());
  assert.doesNotMatch(app.raw(), /TEST-ONLY|entries|password/);
  assert.equal(await app.controller.unlock(FAKE_MASTER), true); assert.equal(app.controller.getSnapshot().draft.input.notes, "RECOVER-AFTER-LOCK-TEST-ONLY");
});

test("idle touch postpones locking and disposal cancels every timer and suppresses later UI notifications", async () => {
  const app = vault(); await app.open(); let notified = 0; app.controller.subscribe(() => notified++);
  await app.tick(VAULT_IDLE_MS - 1); assert.equal(app.controller.getSnapshot().status, "unlocked");
  app.controller.touch(); await app.tick(VAULT_IDLE_MS - 1); assert.equal(app.controller.getSnapshot().status, "unlocked");
  await app.tick(1); assert.equal(app.controller.getSnapshot().status, "locked"); noUnlockedSecrets(app.controller.getSnapshot());
  assert.equal(await app.controller.unlock(FAKE_MASTER), true); app.controller.beginEdit(); app.controller.updateDraft(input());
  app.controller.dispose(); const afterDispose = notified; assert.equal(app.timers.size, 0); await app.tick(VAULT_IDLE_MS * 2);
  assert.equal(notified, afterDispose); assert.equal(app.controller.getSnapshot().status, "locked"); noUnlockedSecrets(app.controller.getSnapshot());
});

test("a late create or decrypt after disposal cannot expose secrets or recreate native-session timers", async () => {
  const app = vault({ existing: false }); await app.controller.start(); const kdf = deferred(); app.faults.beforeKey = () => kdf.promise;
  const task = app.controller.create(FAKE_MASTER); app.controller.dispose(); kdf.resolve(); assert.equal(await task, false);
  assert.equal(app.calls.write.length, 0); noUnlockedSecrets(app.controller.getSnapshot()); assert.equal(app.timers.size, 0);
  const other = vault(); await other.controller.start(); const decrypting = deferred(); other.faults.beforeUnlock = () => decrypting.promise;
  const unlocking = other.controller.unlock(FAKE_MASTER); other.controller.dispose(); decrypting.resolve(); assert.equal(await unlocking, false);
  noUnlockedSecrets(other.controller.getSnapshot()); assert.equal(other.timers.size, 0);
});

test("copy errors expose no copied secret and a copy completing after lock clears its owned clipboard", async () => {
  const app = vault(); await app.open();
  app.faults.beforeCopy = async () => { throw new Error(FAKE_PASSWORD); };
  assert.equal(await app.controller.copy(FAKE_PASSWORD), false); assert.equal(app.controller.getSnapshot().error, "尚未复制，请重试。");
  assert.doesNotMatch(app.controller.getSnapshot().error, /TEST-ONLY/);
  const copying = deferred(); app.faults.beforeCopy = () => copying.promise;
  const task = app.controller.copy(FAKE_PASSWORD); app.controller.lock(); const clearOnLock = app.calls.clear;
  copying.resolve(); assert.equal(await task, false); assert.ok(app.calls.clear > clearOnLock); noUnlockedSecrets(app.controller.getSnapshot());
  assert.equal(await app.controller.copy(FAKE_PASSWORD), false); assert.equal(app.calls.write.length, 0);
});

test("late password generation after lock is discarded and generated secrets are not persisted implicitly", async () => {
  const app = vault(); await app.open(); const generating = deferred(); app.faults.beforeGenerate = () => generating.promise;
  const task = app.controller.generate(); app.controller.lock(); generating.resolve(); assert.equal(await task, null); assert.equal(app.calls.write.length, 0);
  assert.equal(await app.controller.generate(), null);
  assert.equal(await app.controller.unlock(FAKE_MASTER), true); app.faults.beforeGenerate = null;
  assert.equal(await app.controller.generate(), "GENERATED-TEST-ONLY-SECRET"); assert.equal(app.calls.write.length, 0);
});

test("master replacement preserves records and rejects old master only after successful atomic persistence", async () => {
  const app = vault(); await app.open(); const before = structuredClone(app.controller.getSnapshot().entries);
  const original = app.raw(); app.faults.write = true;
  assert.equal(await app.controller.changeMaster(NEXT_FAKE_MASTER), false); assert.equal(app.raw(), original);
  assert.deepEqual(app.controller.getSnapshot().entries, before);
  app.controller.lock(); assert.equal(await app.controller.unlock(FAKE_MASTER), true);
  app.faults.write = false; assert.equal(await app.controller.changeMaster(NEXT_FAKE_MASTER), true);
  assert.deepEqual(app.controller.getSnapshot().entries, before);
  app.controller.lock(); assert.equal(await app.controller.unlock(FAKE_MASTER), false); assert.equal(await app.controller.unlock(NEXT_FAKE_MASTER), true);
  assert.deepEqual(app.controller.getSnapshot().entries, before);
});

test("external ciphertext replacement is never overwritten by a stale save and local editing remains recoverable", async () => {
  const app = vault(); await app.open(); app.controller.beginEdit("entry-a"); app.controller.updateDraft(input({ notes: "LOCAL-EDIT-TEST-ONLY" }));
  app.externalWrite(payload({ entries: [entry("external")] })); const externalRaw = app.raw();
  assert.equal(await app.controller.save(), false); assert.equal(app.raw(), externalRaw);
  assert.equal(app.controller.getSnapshot().draft.input.notes, "LOCAL-EDIT-TEST-ONLY"); assert.equal(app.controller.getSnapshot().entries[0].id, "entry-a");
});

test("concurrent save attempts cannot duplicate one draft into separate entries", async () => {
  const app = vault({ content: payload({ entries: [] }) }); await app.open(); app.controller.beginEdit(); app.controller.updateDraft(input());
  const first = app.controller.save(), second = app.controller.save();
  assert.equal(await second, false); assert.equal(await first, true); assert.equal(app.document().entries.length, 1); assert.equal(app.controller.getSnapshot().entries.length, 1);
});


test("locking during master-change draft flush must not start a new KDF after the session has ended", async () => {
  const app = vault(); await app.open(); app.controller.beginEdit(); app.controller.updateDraft(input());
  const sealing = deferred(); app.faults.beforeSeal = () => sealing.promise;
  const changing = app.controller.changeMaster(NEXT_FAKE_MASTER); await settle();
  app.controller.lock(); sealing.resolve(); assert.equal(await changing, false); await settle();
  assert.equal(app.calls.create.length, 0);
  assert.equal(app.controller.getSnapshot().status, "locked"); noUnlockedSecrets(app.controller.getSnapshot());
});

test("lock while unlock waits for file IO prevents a later native decryption/KDF from starting", async () => {
  const app = vault(); await app.controller.start();
  const reading = deferred(), originalRead = app.ports.readRaw; let decryptCalls = 0;
  app.ports.readRaw = () => reading.promise;
  const originalUnlock = app.ports.unlock; app.ports.unlock = async (...args) => { decryptCalls++; return originalUnlock(...args); };
  const unlocking = app.controller.unlock(FAKE_MASTER); await settle();
  app.controller.lock(); reading.resolve(await originalRead()); assert.equal(await unlocking, false);
  assert.equal(decryptCalls, 0); noUnlockedSecrets(app.controller.getSnapshot());
});

test("discard/delete write failures preserve drafts and records; successful delete clears its associated draft", async () => {
  const app = vault(); await app.open(); app.controller.beginEdit("entry-a"); app.controller.updateDraft(input({ notes: "RETAIN-ON-FAILED-DELETE-TEST-ONLY" }));
  app.faults.write = true;
  assert.equal(await app.controller.discardDraft(), false); assert.equal(app.controller.getSnapshot().draft.input.notes, "RETAIN-ON-FAILED-DELETE-TEST-ONLY");
  assert.equal(await app.controller.removeEntry("entry-a"), false); assert.equal(app.controller.getSnapshot().entries.length, 1);
  app.faults.write = false; assert.equal(await app.controller.removeEntry("entry-a"), true);
  assert.equal(app.controller.getSnapshot().entries.length, 0); assert.equal(app.controller.getSnapshot().draft, null);
  assert.equal(app.document().entries.length, 0); assert.equal(app.document().draft, null);
});

function vaultHook({ acquire, supported = true } = {}) {
  const app = vault({ supported });
  const slots = [], effects = [], lifecycle = new Set(), instances = [], privacy = { acquired: [], released: [] };
  let cursor = 0, nextId = 0;
  const different = (old, deps) => !old || old.length !== deps.length || deps.some((value, i) => value !== old[i]);
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { state: typeof initial === "function" ? initial() : initial }; return [slots[i].state, (value) => { slots[i].state = typeof value === "function" ? value(slots[i].state) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (different(old?.deps, deps)) { slots[i] = { deps, effect }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); } },
    useSyncExternalStore(subscribe, getSnapshot) { react.useEffect(() => subscribe(() => {}), [subscribe]); return getSnapshot(); },
  };
  class ObservedVaultController extends VaultController { constructor(ports) { super(ports); instances.push(this); } }
  const exports = {};
  const dependencies = {
    react,
    "react-native": { AppState: { currentState: "active", addEventListener: (_event, listener) => { lifecycle.add(listener); return { remove: () => lifecycle.delete(listener) }; } } },
    "expo-crypto": { randomUUID: () => `hook-test-${++nextId}` },
    "./vaultController": { VaultController: ObservedVaultController },
    "./vaultCrypto": {
      isVaultSupported: app.ports.supported, readVaultRaw: app.ports.readRaw, writeVaultRaw: app.ports.writeRaw, parseVaultEnvelope: app.ports.parse,
      createVaultKey: app.ports.createKey, unlockVault: app.ports.unlock, sealVault: app.ports.seal, copyVaultValue: app.ports.copy,
      clearVaultClipboard: app.ports.clearClipboard, generateVaultPassword: app.ports.generate,
    },
    "./vaultPrivacy": {
      acquireVaultPrivacy: async (key) => { privacy.acquired.push(key); if (acquire) await acquire(); },
      releaseVaultPrivacy: async (key) => { privacy.released.push(key); },
    },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/usePasswordVault.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, Date: { now: app.ports.now }, setTimeout: app.ports.later, clearTimeout: app.ports.cancel,
    require(name) { assert.ok(name in dependencies, name); return dependencies[name]; } });
  return { app, privacy, instances, lifecycle,
    render() { cursor = 0; effects.length = 0; const result = exports.usePasswordVault(); effects.splice(0).forEach((effect) => effect()); return result; },
    foreground(value) { lifecycle.forEach((listener) => listener(value)); },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
    strictEffectsRemount() { slots.forEach((slot) => { if (slot?.effect) { slot.cleanup?.(); slot.deps = undefined; slot.cleanup = undefined; } }); },
  };
}

test("actual hook background/inactive events lock immediately, foreground never auto-unlocks, and cleanup removes listeners/timers", async () => {
  const hook = vaultHook(); hook.render(); await settle(); let view = hook.render();
  assert.equal(view.status, "locked"); assert.equal(await view.unlock(FAKE_MASTER), true);
  view = hook.render(); view.beginEdit(); view.updateDraft(input({ notes: "HOOK-BACKGROUND-TEST-ONLY" }));
  hook.foreground("inactive"); view = hook.render(); assert.equal(view.status, "locked"); noUnlockedSecrets(view);
  await settle(); const cleared = hook.app.calls.clear; hook.foreground("active"); await settle();
  assert.equal(hook.render().status, "locked"); assert.ok(hook.app.calls.clear > cleared);
  assert.equal(await hook.render().unlock(FAKE_MASTER), true); assert.equal(hook.render().draft.input.notes, "HOOK-BACKGROUND-TEST-ONLY");
  hook.unmount(); assert.equal(hook.lifecycle.size, 0); assert.equal(hook.app.timers.size, 0);
  assert.equal(hook.privacy.released.length, 1); noUnlockedSecrets(hook.instances[0].getSnapshot());
});

test("a completed copy survives background locking for pasting, without extending native expiry or unlocking on return", async () => {
  const hook = vaultHook(); hook.render(); await settle();
  assert.equal(await hook.render().unlock(FAKE_MASTER), true);
  assert.equal(await hook.render().copy(FAKE_PASSWORD), true);
  const clearBefore = hook.app.calls.clear, copiesBefore = hook.app.calls.copy.length;
  hook.foreground("inactive"); hook.foreground("background"); await settle();
  noUnlockedSecrets(hook.render()); assert.equal(hook.render().status, "locked");
  assert.equal(hook.app.calls.clear, clearBefore, "switching apps must not erase the password before it can be pasted");
  assert.equal(hook.app.calls.copy.length, copiesBefore, "backgrounding must not restart the native copy expiry");
  hook.foreground("active"); await settle();
  assert.ok(hook.app.calls.clear > clearBefore); assert.equal(hook.render().status, "locked");
  assert.equal(await hook.render().unlock(FAKE_MASTER), true);
  const late = deferred(); hook.app.faults.beforeCopy = () => late.promise;
  const copying = hook.render().copy(FAKE_PASSWORD); hook.foreground("background");
  const clearWhilePending = hook.app.calls.clear;
  late.resolve(); assert.equal(await copying, false);
  assert.ok(hook.app.calls.clear > clearWhilePending, "a copy that completes only after locking must be discarded");
  noUnlockedSecrets(hook.render());
  hook.unmount();
});

test("hook waits for privacy protection, fails closed on its failure, and late acquisition after unmount cannot read the vault", async () => {
  const gate = deferred(); const hook = vaultHook({ acquire: () => gate.promise });
  hook.render(); assert.equal(hook.app.calls.read, 0); assert.equal(hook.render().status, "loading");
  hook.unmount(); gate.resolve(); await settle();
  assert.equal(hook.app.calls.read, 0); assert.equal(hook.lifecycle.size, 0); assert.equal(hook.privacy.released.length, 1);
  let fail = true; const retry = vaultHook({ acquire: async () => { if (fail) throw new Error("FICTIONAL-PRIVACY-ERROR"); } });
  retry.render(); await settle(); assert.equal(retry.render().status, "error"); assert.equal(retry.app.calls.read, 0);
  assert.doesNotMatch(retry.render().error, /FICTIONAL/); fail = false; retry.render().retry(); await settle();
  assert.equal(retry.render().status, "locked"); retry.unmount();
});

test("Strict Effects setup-cleanup-setup reactivates the same controller without keeping an unlocked prior session", async () => {
  const hook = vaultHook(); hook.render(); await settle(); assert.equal(await hook.render().unlock(FAKE_MASTER), true);
  hook.strictEffectsRemount(); hook.render(); await settle();
  assert.equal(hook.instances.length, 1); assert.equal(hook.render().status, "locked"); noUnlockedSecrets(hook.render());
  assert.equal(hook.lifecycle.size, 1); assert.equal(hook.privacy.acquired.length, 2); assert.equal(hook.privacy.released.length, 1);
  assert.equal(await hook.render().unlock(FAKE_MASTER), true); hook.unmount(); assert.equal(hook.lifecycle.size, 0); assert.equal(hook.app.timers.size, 0);
});

test("a second create after lock waits for the old atomic create and cannot replace it with a different master", async () => {
  const app = vault({ existing: false }); await app.controller.start();
  const sealing = deferred(); let first = true;
  app.faults.beforeSeal = async () => { if (first) { first = false; await sealing.promise; } };
  const oldCreate = app.controller.create(FAKE_MASTER); await settle();
  assert.equal(app.calls.create.length, 1); assert.equal(app.calls.seal.length, 1);
  app.controller.lock(); const newCreate = app.controller.create(NEXT_FAKE_MASTER); await settle();
  assert.equal(app.calls.create.length, 1);
  sealing.resolve(); assert.equal(await oldCreate, false); assert.equal(await newCreate, false);
  assert.equal(app.calls.seal.length, 1); assert.equal(app.controller.getSnapshot().status, "locked");
  assert.equal(await app.controller.unlock(FAKE_MASTER), true);
  app.controller.lock(); assert.equal(await app.controller.unlock(NEXT_FAKE_MASTER), false);
});

test("create refreshes disk before deriving and never treats a newly appeared existing vault as replaceable", async () => {
  const app = vault({ existing: false }); await app.controller.start();
  app.externalWrite(payload({ entries: [entry("external")] })); const externalRaw = app.raw();
  assert.equal(await app.controller.create(FAKE_MASTER), false);
  assert.equal(app.raw(), externalRaw); assert.equal(app.calls.create.length, 0); assert.equal(app.calls.write.length, 0);
  assert.equal(app.controller.getSnapshot().status, "locked");
  assert.equal(await app.controller.unlock("EXTERNAL-TEST-ONLY-MASTER"), true); assert.equal(app.controller.getSnapshot().entries[0].id, "external");
});

test("create uses expected-null atomic semantics when another vault appears during key derivation", async () => {
  const app = vault({ existing: false }); await app.controller.start(); const deriving = deferred(); app.faults.beforeKey = () => deriving.promise;
  const creating = app.controller.create(FAKE_MASTER); await settle();
  app.externalWrite(payload({ entries: [entry("external")] })); const externalRaw = app.raw();
  deriving.resolve(); assert.equal(await creating, false); assert.equal(app.raw(), externalRaw);
  assert.ok(app.calls.write.every((write) => write.expected === null));
});

test("every lock advances the UI lock epoch even in unchanged loading/create/locked states", async () => {
  const loading = vault(); const initialEpoch = loading.controller.getSnapshot().lockEpoch;
  loading.controller.lock(); assert.ok(loading.controller.getSnapshot().lockEpoch > initialEpoch);
  assert.equal(loading.controller.getSnapshot().status, "loading");
  for (const existing of [false, true]) {
    const app = vault({ existing }); await app.controller.start();
    const status = existing ? "locked" : "create", before = app.controller.getSnapshot().lockEpoch;
    app.controller.lock(); const after = app.controller.getSnapshot().lockEpoch;
    assert.equal(app.controller.getSnapshot().status, status); assert.ok(after > before);
    app.controller.lock(); assert.ok(app.controller.getSnapshot().lockEpoch > after); assert.equal(app.controller.getSnapshot().status, status);
  }
});

test("hook exposes a fresh epoch for background lock even before unlock so password inputs can remount", async () => {
  const hook = vaultHook(); hook.render(); await settle();
  const before = hook.render().lockEpoch; assert.equal(hook.render().status, "locked");
  hook.foreground("inactive"); const after = hook.render().lockEpoch;
  assert.ok(after > before); assert.equal(hook.render().status, "locked");
  hook.foreground("active"); assert.equal(hook.render().lockEpoch, after);
  assert.equal(await hook.render().unlock(FAKE_MASTER), true); assert.equal(hook.render().lockEpoch, after);
  hook.foreground("background"); assert.ok(hook.render().lockEpoch > after); noUnlockedSecrets(hook.render()); hook.unmount();
});
