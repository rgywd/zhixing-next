import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as store from "../../src/cacheStore.ts";

// Run the production SQL and cache API with SQLite; only the Expo driver boundary is replaced.
export function cacheHarness(filename = ":memory:") {
  const db = new DatabaseSync(filename);
  const driver = {
    execAsync: async (sql) => { db.exec(sql); },
    runAsync: async (sql, ...args) => db.prepare(sql).run(...args),
    getFirstAsync: async (sql, ...args) => db.prepare(sql).get(...args) ?? null,
  };
  const exports = {};
  const dependencies = {
    "./cacheStore": store,
    "expo-crypto": { randomUUID, CryptoDigestAlgorithm: { SHA256: "sha256" }, digestStringAsync: async (algorithm, value) => createHash(algorithm).update(value).digest("hex") },
    "expo-sqlite": { openDatabaseAsync: async () => driver },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../../src/localCache.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Date, require: (id) => { if (!(id in dependencies)) throw new Error(id); return dependencies[id]; } });
  return { ...exports, db, close: () => db.close() };
}
