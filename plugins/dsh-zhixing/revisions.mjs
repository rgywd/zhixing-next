import { createHash } from 'node:crypto';

const failure = (message, status = 409) => Object.assign(new Error(message), { status });
const isUser = e => e.type === 'user/message' && e.data.source?.kind === 'user';

/** A logical App conversation owns immutable native branches; the source log is never rewritten. */
export function createRevisions(ctx, { records, resolve, flush, metadata, forkRevision, register }) {
  const ledgers = new Map();
  const load = async root => {
    if (!ledgers.has(root)) ledgers.set(root, (async () => {
      const state = metadata.revisions.get(root) ?? { active: root, entries: [] };
      for (const entry of state.entries) register(entry.child);
      return state;
    })().catch(e => { ledgers.delete(root); throw e; }));
    return ledgers.get(root);
  };
  const save = async (root, state) => {
    await metadata.revisions.put(root, state);
    ledgers.set(root, Promise.resolve(state));
  };
  const summary = async root => {
    const state = await load(root);
    return { active: state.active, versions: [{ id: root, label: '原始版本' }, ...state.entries.filter(v => v.accepted).map((v, i) => ({
      id: v.child, label: `${v.kind === 'edit' ? '编辑' : '重答'}版本 ${i + 1}`, source: v.source, seq: v.seq, userIndex: v.userIndex, group: v.group, kind: v.kind,
    }))] };
  };
  const idle = async id => {
    const state = await ctx.sessionController.state({ sessionId: id }, new AbortController().signal);
    if (ctx.agents.get(id)?.status === 'running' || state.queue?.some(item => item.placement !== 'context')) throw failure('请先等当前回复和等待消息处理完，再操作历史版本。');
  };
  const activate = async (root, child) => {
    const state = await load(root);
    await save(root, { active: child, entries: state.entries.map(v => v.child === child ? { ...v, accepted: true } : v) });
  };
  return {
    load, summary, active: async root => (await load(root)).active,
    async select(root, body) {
      const state = await load(root);
      if (body.expected !== state.active) throw failure('对话版本已改变，请刷新后重试。');
      if (body.version !== root && !state.entries.some(v => v.accepted && v.child === body.version)) throw failure('这个版本不属于当前对话。', 404);
      await idle(state.active); await idle(body.version);
      await activate(root, body.version); return summary(root);
    },
    async revise(root, body) {
      if (typeof body.id !== 'string' || !body.id || !['edit', 'retry'].includes(body.kind) || !Number.isSafeInteger(body.seq)) throw failure('无效的消息操作。', 400);
      const state = await load(root);
      const signature = JSON.stringify({ kind: body.kind, seq: body.seq, version: body.version, text: body.text, attachments: body.attachments });
      let entry = state.entries.find(v => v.request === body.id);
      if (entry && entry.signature !== signature) throw failure('这次提交的内容已改变，请重新打开编辑。');
      if (entry?.accepted) return summary(root); // Lost ACK never creates another branch or executes twice.
      if (body.version !== state.active) throw failure('对话版本已改变，请刷新后重新编辑。');
      await idle(state.active);
      const events = []; for await (const event of records(state.active)) events.push(event);
      const target = events.find(e => e.seq === body.seq);
      if (!target || (body.kind === 'edit' ? !isUser(target) : !['assistant/message', 'assistant/attempt', 'tool/call', 'tool/result', 'turn/end'].includes(target.type))) throw failure('这条消息不能执行此操作。', 400);
      const user = body.kind === 'edit' ? target : events.findLast(e => e.seq < target.seq && isUser(e));
      if (!user || user.seq < 1) throw failure('找不到这条回复对应的用户消息。', 400);
      const original = user.data.content;
      const attachments = original.filter(b => b.type === 'file' || b.type === 'image');
      if (body.kind === 'edit' && (typeof body.text !== 'string' || !Array.isArray(body.attachments) || body.attachments.some(id => !attachments.some(b => b.attachment.attachmentId === id)))) throw failure('编辑内容或附件无效。', 400);
      const content = body.kind === 'retry' ? original : [ ...(body.text.trim() ? [{ type: 'text', text: body.text }] : []),
        ...attachments.filter(b => body.attachments.includes(b.attachment.attachmentId)) ];
      if (!content.length) throw failure('消息至少需要文字或一个附件。', 400);
      if (!entry) {
        const userIndex = events.filter(e => isUser(e) && e.seq < user.seq).length;
        let ancestor = state.entries.find(v => v.child === state.active);
        while (ancestor && ancestor.userIndex > userIndex) ancestor = state.entries.find(v => v.child === ancestor.source);
        const group = ancestor?.userIndex === userIndex ? ancestor.group : `${state.active}:${user.data.id ?? user.seq}`;
        entry = { request: body.id, signature, source: state.active, seq: body.seq, kind: body.kind, userIndex, group,
          child: `zhixing-revision-${createHash('sha256').update(`${root}:${body.id}`).digest('hex')}`, cut: user.seq - 1, content };
        await save(root, { ...state, entries: [...state.entries, entry] }); register(entry.child);
      }
      // The stable child identity is committed before creation, so restart can resume any stage.
      const source = await resolve(entry.source);
      const child = await forkRevision(entry.child, source, events, entry.cut);
      await flush(child.id);
      if (!metadata.artifacts.get(child.id)) {
        await metadata.artifacts.put(child.id, (metadata.artifacts.get(entry.source) ?? []).filter(a => a.toolSeq <= entry.cut));
      }
      const childEvents = []; for await (const event of records(child.id)) childEvents.push(event);
      const accepted = childEvents.some(e => isUser(e) && e.data.source.rpcId === body.id) ||
        (await ctx.sessionController.state({ sessionId: child.id }, new AbortController().signal)).queue?.some(q => q.rpcId === body.id);
      if (!accepted) {
        const parts = [];
        for (const block of entry.content) {
          if (block.type === 'text') { parts.push(block); continue; }
          const ref = block.attachment;
          const request = { sessionId: child.id, name: ref.name };
          const receipt = block.type === 'file'
            ? await ctx.fileUploads.uploadStream({ ...request, data: ctx.attachments.readFileStream(ref) })
            : await ctx.fileUploads.uploadImageStream({ ...request, mediaType: ref.mediaType,
              data: (async function* () { yield (await ctx.attachments.readImage(ref)).data; })() });
          parts.push({ type: 'file', receiptId: receipt.receiptId });
        }
        await ctx.sessionController.prompt({ sessionId: child.id, requestId: body.id, mode: 'queue', content: parts }, new AbortController().signal);
        await flush(child.id);
      }
      await activate(root, child.id); return summary(root);
    },
  };
}
