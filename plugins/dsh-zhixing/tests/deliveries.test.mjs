import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declaredFile, deliveryBytes } from '../deliveries.mjs';

test('only a native declaration in the selected session can resolve a file', async () => {
  const ctx = { sessions: { get: () => ({ header: { cwd: '/work' } }) } };
  async function* records(id) { if (id === 'own') yield { seq: 3, type: 'deliverables/presented', data: { files: [{ path: '/work/报告.md' }] } }; }
  assert.deepEqual(await declaredFile(ctx, records, 'own', 3, 0), { path: '/work/报告.md', name: '报告.md', scope: { sessionId: 'own', workspaceRoot: '/work' } });
  await assert.rejects(declaredFile(ctx, records, 'foreign', 3, 0), { status: 404 });
  await assert.rejects(declaredFile(ctx, records, 'own', 3, 1), { status: 404 });
});
test('native file reads preserve exact bytes, respect host denial and reject a file changing between pages', async () => {
  const target = { scope: { sessionId: 'own', workspaceRoot: '/work' }, path: '/work/file' };
  let version = 'a';
  const ctx = { workspaceFiles: { stat: async () => ({ version }), readBytes: async (_scope, _path, options) => ({ version, data: Uint8Array.of(options.range.offset, 255), eof: options.range.offset === 2 }) } };
  const chunks = []; for await (const chunk of deliveryBytes(ctx, target)) chunks.push(...chunk);
  assert.deepEqual(chunks, [0, 255, 2, 255]);
  const stream = deliveryBytes(ctx, target); await stream.next(); version = 'b';
  await assert.rejects(stream.next(), /文件已更新/);
  ctx.workspaceFiles.stat = async () => { throw new Error('host denied'); };
  await assert.rejects(deliveryBytes(ctx, target).next(), /host denied/);
});
