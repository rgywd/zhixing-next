import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishFile } from '../artifacts.mjs';

function fixture(bytes = new Uint8Array(150003).map((_, i) => i % 256)) {
  const reads = [], saved = []; let version = 'one';
  const ctx = { attachments: { async saveFileStream({ data, name }) {
    const chunks = []; for await (const chunk of data) chunks.push(...chunk);
    saved.push(new Uint8Array(chunks)); return { attachmentId: 'sha256:fixture', name, bytes: chunks.length };
  } } };
  const agent = { session: { header: { cwd: '/workspace' } }, ctx: { fs: {
    async resolve(path, options) { assert.equal(options.cwd, '/workspace'); return { displayPath: `/workspace/${path}` }; },
    async stat() { return { type: 'file', version }; },
    async readByteRange(_target, range) { reads.push(range); return bytes.slice(range.offset, range.offset + range.length); },
  } } };
  ctx.fs = agent.ctx.fs;
  ctx.workingDirectory = { ensure: async () => '/workspace' };
  return { ctx, agent, bytes, reads, saved, change: () => { version = 'two'; } };
}

test('publication preserves exact binary bytes in bounded filesystem reads', async () => {
  const f = fixture(), result = await publishFile(f.ctx, f.agent, 'result.bin');
  assert.deepEqual(f.saved[0], f.bytes); assert.equal(result.attachment.bytes, 150003);
  assert.equal(result.attachment.name, 'result.bin'); assert.equal(result.path, '/workspace/result.bin');
  assert.ok(f.reads.every(r => r.length === 64 * 1024)); assert.equal(f.reads.length, 4);
});
test('a changing file or filesystem denial never produces a published receipt', async () => {
  const f = fixture(), read = f.agent.ctx.fs.readByteRange;
  f.agent.ctx.fs.readByteRange = async (...args) => { const data = await read(...args); f.change(); return data; };
  await assert.rejects(publishFile(f.ctx, f.agent, 'result.bin'), /发布时发生变化/); assert.equal(f.saved.length, 0);
  f.agent.ctx.fs.resolve = async () => { throw new Error('host denied'); };
  await assert.rejects(publishFile(f.ctx, f.agent, 'result.bin'), /host denied/);
});
test('publication rejects directories and honors cancellation', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(publishFile(f.ctx, f.agent, 'result.bin', undefined, controller.signal), { name: 'AbortError' });
  f.agent.ctx.fs.stat = async () => ({ type: 'directory' });
  await assert.rejects(publishFile(f.ctx, f.agent, '.'), /不是普通文件/); assert.equal(f.saved.length, 0);
});
