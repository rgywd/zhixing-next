/** Freeze a file through the Agent's actual filesystem, then publish a native attachment. */
export async function publishFile(ctx, agent, path, name, signal) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('请指定要发布的文件。');
  const fs = ctx.fs;
  const cwd = await ctx.workingDirectory.ensure(agent, signal);
  const target = await fs.resolve(path, { cwd, signal });
  const before = await fs.stat(target, signal);
  if (before?.type !== 'file') throw new Error('文件不存在或不是普通文件。');
  async function* chunks() {
    for (let offset = 0;;) {
      signal?.throwIfAborted();
      const chunk = await fs.readByteRange(target, { offset, length: 64 * 1024 }, signal);
      if (!chunk.length) break;
      offset += chunk.length; yield chunk;
    }
    const after = await fs.stat(target, signal);
    if (after?.version !== before.version) throw new Error('文件在发布时发生变化，请重试。');
  }
  const attachment = await ctx.attachments.saveFileStream({ data: chunks(), signal,
    name: name || target.displayPath.split(/[\\/]/).at(-1) });
  return { attachment, path: target.displayPath };
}
