import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as vaultTypes from "../src/vaultTypes.ts";

const SALT = "000102030405060708090a0b0c0d0e0f";
const MASTER = "  知行🔐 Master密码  ";
const fixture = () => ({ version: 1, entries: [{ ...vaultTypes.emptyVaultInput(), id: "fixture-entry", site: "fixture.invalid", account: "VAULT_FIXTURE_NOT_REAL", password: "  密码🔐\nwith spaces  ", recoveryEmail: "fixture@example.invalid", phone: "fixture-phone", questions: [{ id: "question", question: "示例问题", answer: "  fixture answer  " }], fields: [{ id: "field", label: "备用代码", value: "  fixture secret  ", secret: true }], notes: "fixture notes", createdAt: "2028-06-02T12:00:00Z", updatedAt: "2028-06-02T12:00:00Z" }], draft: null });

function harness({ available = true, supported = true, encoding = true, random = randomBytes } = {}) {
  const calls = [], writes = []; let stored = null;
  const native = {
    isSupported: () => supported,
    async deriveKey(master, salt) { calls.push({ kind: "derive", master, salt }); return pbkdf2Sync(master, Buffer.from(salt, "hex"), 600000, 32, "sha256").toString("hex"); },
    async copyValue(value) { calls.push({ kind: "copy", value }); },
    async clearClipboard() { calls.push({ kind: "clear" }); },
    async readVaultRaw() { return stored; },
    async writeVaultRaw(raw, expected) { if (stored !== expected) throw Object.assign(new Error("conflict"), { code: "ERR_VAULT_CONFLICT" }); writes.push(raw); stored = raw; },
  };
  const crypto = {
    AESEncryptionKey: { async import(hex, encoding) { assert.equal(encoding, "hex"); return { bytes: Buffer.from(hex, "hex"), size: Buffer.from(hex, "hex").length * 8 }; } },
    AESSealedData: { fromCombined(value, options) { assert.equal(options.ivLength, 12); assert.equal(options.tagLength, 16); return { bytes: Buffer.from(value, "base64") }; } },
    async getRandomBytesAsync(length) { return new Uint8Array(random(length)); },
    async aesEncryptAsync(plaintext, key, options) {
      assert.equal(options.nonce.length, 12); assert.equal(options.tagLength, 16);
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key.bytes, iv);
      cipher.setAAD(options.additionalData);
      const sealed = Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
      return { async combined(format) { assert.equal(format, "base64"); return sealed.toString("base64"); } };
    },
    async aesDecryptAsync(sealed, key, options) {
      const bytes = sealed.bytes, decipher = createDecipheriv("aes-256-gcm", key.bytes, bytes.subarray(0, 12));
      decipher.setAAD(options.additionalData); decipher.setAuthTag(bytes.subarray(-16));
      return new Uint8Array(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]));
    },
  };
  const exports = {}, dependencies = { expo: { requireOptionalNativeModule: () => available ? native : null }, "expo-crypto": crypto, "./vaultTypes": vaultTypes };
  const globals = { exports, Uint8Array, Error, TextEncoder: encoding ? TextEncoder : undefined, TextDecoder: encoding ? TextDecoder : undefined, require(name) { assert.ok(name in dependencies, `unexpected vault dependency ${name}`); return dependencies[name]; } };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/vaultCrypto.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, globals);
  return { ...exports, calls, writes, crypto, native, get stored() { return stored; }, set stored(value) { stored = value; } };
}

test("vault capabilities fail closed without a native module or on an unsupported Android version", async () => {
  for (const options of [{ available: false }, { supported: false }]) {
    const app = harness(options); assert.equal(app.isVaultSupported(), false);
    await assert.rejects(app.createVaultKey(MASTER), /原生 App/);
    await assert.rejects(app.readVaultRaw(), /原生 App/);
    await assert.rejects(app.copyVaultValue("fixture"), /原生 App/);
    await assert.rejects(app.generateVaultPassword(), /原生 App/);
    assert.equal(app.calls.length, 0); assert.equal(app.writes.length, 0);
  }
});

test("the KDF bridge preserves whitespace, Unicode, emoji and embedded NUL with fixed standard vectors", async () => {
  for (const [master, expected] of [[MASTER, "42efc584cbe073cf4121eb247b9db4702b2408f0b86cdcf17742bd9567e2ad47"], ["Master\0秘密🔐Fixture", "96165cf193a2d4abe1653020cbd67d2fef3bf9e7c1e3932d7fe75624c4893169"]]) {
    const app = harness({ random: () => Buffer.from(SALT, "hex") });
    const { key, salt } = await app.createVaultKey(master);
    assert.equal(salt, SALT); assert.equal(key.bytes.toString("hex"), expected);
    assert.equal(app.calls[0].master, master); assert.equal(app.calls[0].salt, SALT);
  }
  const app = harness();
  for (const master of ["short", "x".repeat(1025), "valid prefix\ud800", "valid prefix\udc00", "valid prefix\ud800x"]) await assert.rejects(app.createVaultKey(master), /主密码/);
  assert.equal(app.calls.length, 0);
});

test("authenticated encryption uses a fresh IV and preserves every password and auxiliary field exactly", async () => {
  const app = harness(), { key, salt } = await app.createVaultKey(MASTER), payload = fixture();
  payload.draft = { entryId: "fixture-entry", input: { ...vaultTypes.emptyVaultInput(), password: "未保存 \ud800 fixture", notes: "draft remains encrypted" } };
  const first = await app.sealVault(payload, key, salt), second = await app.sealVault(payload, key, salt);
  assert.notEqual(first.sealed, second.sealed);
  assert.notEqual(Buffer.from(first.sealed, "base64").subarray(0, 12).toString("hex"), Buffer.from(second.sealed, "base64").subarray(0, 12).toString("hex"));
  const raw = JSON.stringify(first);
  for (const sentinel of ["VAULT_FIXTURE_NOT_REAL", "fixture.invalid", "fixture@example.invalid", "fixture answer", "draft remains encrypted", MASTER]) assert.equal(raw.includes(sentinel), false);
  const result = await app.unlockVault(app.parseVaultEnvelope(raw), MASTER);
  assert.deepEqual(result.payload, payload);
});

test("wrong passwords and modifications to IV, ciphertext, tag or authenticated salt cannot return an empty vault", async () => {
  const app = harness(), { key, salt } = await app.createVaultKey(MASTER), envelope = await app.sealVault(fixture(), key, salt), original = JSON.stringify(envelope);
  await assert.rejects(app.unlockVault(envelope, "incorrect fixture master"), /主密码不正确/);
  for (const offset of [0, 12, -1]) {
    const bytes = Buffer.from(envelope.sealed, "base64"), index = offset < 0 ? bytes.length + offset : offset; bytes[index] ^= 1;
    await assert.rejects(app.unlockVault({ ...envelope, sealed: bytes.toString("base64") }, MASTER), /已损坏/);
  }
  app.native.deriveKey = async () => key.bytes.toString("hex");
  await assert.rejects(app.unlockVault({ ...envelope, salt: salt[0] === "0" ? `1${salt.slice(1)}` : `0${salt.slice(1)}` }, MASTER), /已损坏/, "salt is authenticated even when the key is held constant");
  assert.equal(JSON.stringify(envelope), original); assert.equal(app.writes.length, 0);
});

test("unknown formats, plaintext additions, invalid encodings and oversized documents are rejected before native IO", async () => {
  const app = harness(), { key, salt } = await app.createVaultKey(MASTER), envelope = await app.sealVault(fixture(), key, salt);
  await assert.rejects(app.sealVault(fixture(), { bytes: Buffer.alloc(16), size: 128 }, salt), /原加密文件/);
  for (const changed of [null, [], { ...envelope, version: 2 }, { ...envelope, kdf: "sha256" }, { ...envelope, iterations: 1 }, { ...envelope, iterations: "600000" }, { ...envelope, salt: "0".repeat(31) }, { ...envelope, salt: "g".repeat(32) }, { ...envelope, password: "plaintext" }, { ...envelope, sealed: "" }, { ...envelope, sealed: "A".repeat(40) + "?===" }, { ...envelope, sealed: "a".repeat(39) + "=" }]) {
    const raw = JSON.stringify(changed); assert.throws(() => app.parseVaultEnvelope(raw), /原加密文件/); await assert.rejects(app.writeVaultRaw(raw, null), /原加密文件/);
  }
  assert.throws(() => app.parseVaultEnvelope(" ".repeat(8 * 1024 * 1024 + 1)), /原加密文件/);
  assert.equal(app.writes.length, 0);
});

test("authenticated malformed payloads and invalid UTF8 remain errors instead of initializing an empty vault", async () => {
  const app = harness(), { key, salt } = await app.createVaultKey(MASTER), aad = new TextEncoder().encode(JSON.stringify({ version: 1, kdf: "pbkdf2-sha256", iterations: 600000, salt }));
  for (const plaintext of [new Uint8Array([255]), new TextEncoder().encode("{}"), new TextEncoder().encode('{"version":1,"entries":[],"draft":{"entryId":"missing"}}')]) {
    const sealed = await app.crypto.aesEncryptAsync(plaintext, key, { nonce: { length: 12 }, tagLength: 16, additionalData: aad });
    await assert.rejects(app.unlockVault({ version: 1, kdf: "pbkdf2-sha256", iterations: 600000, salt, sealed: await sealed.combined("base64") }, MASTER), /原加密文件/);
  }
  assert.equal(app.writes.length, 0);
});

test("UTF8 fallback works without runtime encoder globals and does not normalize stored Unicode", async () => {
  const app = harness({ encoding: false }), { key, salt } = await app.createVaultKey(MASTER), payload = fixture();
  payload.entries[0].password = "  e\u0301≠é 🔐 \0  ";
  const envelope = await app.sealVault(payload, key, salt);
  assert.deepEqual((await app.unlockVault(envelope, MASTER)).payload, payload);
});

test("encrypted storage distinguishes missing data from corruption and forwards compare-and-swap conflicts", async () => {
  const app = harness(), { key, salt } = await app.createVaultKey(MASTER), first = JSON.stringify(await app.sealVault(fixture(), key, salt));
  assert.equal(await app.readVaultRaw(), null); await app.writeVaultRaw(first, null); assert.equal(await app.readVaultRaw(), first);
  const updated = fixture(); updated.entries[0].notes = "updated fixture";
  const second = JSON.stringify(await app.sealVault(updated, key, salt));
  await assert.rejects(app.writeVaultRaw(second, null), { code: "ERR_VAULT_CONFLICT" }); assert.equal(app.stored, first);
  await app.writeVaultRaw(second, first); assert.equal(app.stored, second);
  app.stored = "corrupt fixture file";
  await assert.rejects(app.readVaultRaw(), /原加密文件/); assert.equal(app.stored, "corrupt fixture file"); assert.equal(app.writes.length, 2);
});

test("password generation uses rejection sampling and clipboard operations never retrieve content to JS", async () => {
  let count = 0;
  const app = harness({ random: (length) => { count++; return Buffer.alloc(length, count === 1 ? 255 : 0); } });
  const generated = await app.generateVaultPassword(); assert.equal(generated.length, 20); assert.equal(count, 2); assert.match(generated, /^[A-Za-z0-9!@#$%^&*()_=+\-]{20}$/);
  const value = "  clipboard fixture 🔐  "; await app.copyVaultValue(value); await app.clearVaultClipboard();
  assert.deepEqual(app.calls, [{ kind: "copy", value }, { kind: "clear" }]); assert.equal(app.writes.length, 0);
});
