/** Mobile transport for native present declarations. The client never supplies a filesystem path. */
export async function declaredFile(ctx, records, sessionId, seq, index) {
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(index) || seq < 0 || index < 0) throw Object.assign(new Error('无效的文件引用。'), { status: 400 });
  let declaration;
  for await (const event of records(sessionId)) {
    if (event.seq === seq && event.type === 'deliverables/presented') { declaration = event.data.files?.[index]; break; }
  }
  if (!declaration || typeof declaration.path !== 'string' || !declaration.path.trim()) throw Object.assign(new Error('这段对话中没有这个文件。'), { status: 404 });
  const header = ctx.sessions.get(sessionId)?.header ?? (await ctx.sessionPersistence.stat(sessionId))?.header;
  if (!header) throw Object.assign(new Error('对话不存在。'), { status: 404 });
  return { path: declaration.path, name: declaration.path.split(/[\\/]/).at(-1),
    scope: { sessionId, workspaceRoot: header.cwd ?? ctx.sandboxPolicy.workspaceRoot } };
}

/** Page through the native read service and reject files changing while being downloaded. */
export async function* deliveryBytes(ctx, target, signal) {
  const before = await ctx.workspaceFiles.stat(target.scope, target.path, signal);
  for (let offset = 0;;) {
    const page = await ctx.workspaceFiles.readBytes(target.scope, target.path, { range: { offset } }, signal);
    if (page.version !== before.version) throw new Error('文件已更新，请重新打开。');
    yield page.data;
    if (page.eof) break;
    if (!page.data.length) throw new Error('文件读取中断，请重试。');
    offset += page.data.length;
  }
  if ((await ctx.workspaceFiles.stat(target.scope, target.path, signal)).version !== before.version) throw new Error('文件已更新，请重新打开。');
}
