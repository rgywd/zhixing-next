import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyState, createBusinessService } from '../business/service.mjs';
import { hash } from '../business/common.mjs';
import { importBusiness } from '../business/import.mjs';

test('migration verifies snapshots, refuses conflicting data and never restores over later native changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhixing-import-'));
  try {
    let state = emptyState();
    const global = { get: () => state, set: async value => { state = structuredClone(value); } };
    const tables = structuredClone(state.tables);
    const source = { format: 'zhixing-business-export-v1', tables, source_schema: 16,
      sha256: hash(tables), counts: Object.fromEntries(Object.entries(tables).map(([k,v]) => [k,v.length])) };
    const file = join(root, 'export.json');
    const save = value => writeFile(file, JSON.stringify(value));
    await save({ ...source, sha256: 'tampered' });
    await assert.rejects(importBusiness(global, file), /fingerprint/);
    await save({ ...source, counts: { ...source.counts, health_state: 2 } });
    await assert.rejects(importBusiness(global, file), /count/);
    await save(source);
    const receipt = await importBusiness(global, file);
    assert.equal(hash(state.tables), source.sha256);
    await createBusinessService(global).request('/v1/health/profile', 'PATCH', { height_cm: 170 });
    const changed = structuredClone(state);
    assert.deepEqual(await importBusiness(global, file), receipt);
    assert.deepEqual(state, changed, 'repeated startup imports must preserve changes made in DSH');
    const next = structuredClone(source); next.tables.health_state[0].revision = 1; next.sha256 = hash(next.tables);
    await save(next);
    await assert.rejects(importBusiness(global, file), /overwrite/);
    state = emptyState();
    await createBusinessService(global).request('/v1/health/profile', 'PATCH', { height_cm: 160 });
    await save(source);
    await assert.rejects(importBusiness(global, file), /overwrite/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
