import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createRevisions } from './revisions.mjs';
import { declaredFile, deliveryBytes } from './deliveries.mjs';
import { businessPath } from './business/service.mjs';

const page = items => ({ items, next_cursor: null, previous_cursor: null });
const own = id => /^zhixing-(main|finance|health)-[a-f0-9-]+$/.test(id);
const routeId = selection => JSON.stringify([selection.provider, selection.model]);
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const textFile = name => /\.(txt|md|markdown|csv|json|jsonl|log|js|jsx|ts|tsx|py|sh|yaml|yml|toml|xml|html|css|sql|diff|patch|svg)$/i.test(name);
const messageText = event => {
  if (event.type !== 'assistant/message' && !(event.type === 'user/message' && event.data.source?.kind === 'user')) return '';
  const content = event.data.message?.content ?? event.data.content;
  return Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
};

async function json(req, limit = 16 * 1024 * 1024) {
  let source = '';
  // This is a control-message transport bound; file bodies stream to DSH separately.
  for await (const chunk of req) {
    source += chunk;
    if (Buffer.byteLength(source) > limit) throw failure('请求过大，请使用文件上传。', 413);
  }
  try { return source ? JSON.parse(source) : {}; } catch { throw failure('无效的 JSON。'); }
}

export function conversation(row) {
  const values = row.projections?.values ?? {};
  const selection = values.modelSelection?.next ?? values.modelSelection?.lastUsed;
  return { id: row.sessionId, title: values.title || '新的对话', project_id: null,
    agent_id: row.sessionId.startsWith('zhixing-finance-') ? 'finance' : row.sessionId.startsWith('zhixing-health-') ? 'health' : null,
    model_id: selection ? routeId(selection) : null, reasoning_effort: selection?.reasoningEffort ?? null,
    blocked: false, updated_at: new Date(row.updatedAt).toISOString() };
}

export function modelCatalog(catalog, images = new Map()) {
  return { items: catalog.groups.flatMap(group => group.models.map(model => ({
    id: routeId({ provider: group.id, model: model.id }), name: model.name, model: model.id, provider: group.id,
    protocol: 'chat_completions', ready: catalog.routableProviders.includes(group.id), image_input: images.get(routeId({ provider: group.id, model: model.id })) ?? false,
    reasoning_levels: model.reasoning?.efforts.map(e => e.id) ?? [],
    reasoning_labels: Object.fromEntries(model.reasoning?.efforts.map(e => [e.id, e.name]) ?? []),
    default_reasoning_effort: model.reasoning?.defaultEffort ?? null,
  }))), roles: { chat: routeId(catalog.default), task: routeId(catalog.default) } };
}

/** Answer only requests for this outlet. Other channel answerers keep their scope. */
export function createInteractions(ctx, owns = own) {
  const pending = new Map();
  const wait = (kind, req) => new Promise((resolve, reject) => {
    const id = randomUUID();
    const finish = (value, error) => {
      pending.delete(id); req.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(kind === 'approval' ? 'cancelled' : undefined,
      kind === 'question' ? new Error('Question cancelled by DSH') : undefined);
    pending.set(id, { id, sessionId: req.agent.id, kind,
      ...(kind === 'approval' ? { toolName: req.toolName, reason: req.displayReason?.zh ?? req.reason, callId: req.callId }
        : { questions: req.questions, callId: req.wait?.callId }), finish });
    req.signal?.addEventListener('abort', abort, { once: true });
    if (req.signal?.aborted) abort();
  });
  const disposers = [
    ctx.on('approval/request', (req, next) => owns(req.agent?.id ?? '') ? wait('approval', req) : next(), { prepend: true }),
    ctx.on('user-questions/request', (req, next) => owns(req.agent?.id ?? '') ? wait('question', req) : next(), { prepend: true }),
  ];
  return {
    list: sessionId => [...pending.values()].filter(p => p.sessionId === sessionId).map(({ finish: _finish, ...p }) => p),
    answer(sessionId, id, body) {
      const p = pending.get(id);
      if (!p || p.sessionId !== sessionId) throw failure('请求已经结束，请刷新。', 409);
      if (p.kind === 'approval') {
        if (!['allowed-once', 'rejected'].includes(body.outcome)) throw failure('无效的授权选择。');
        p.finish(body.outcome);
      } else {
        const answers = body.answers;
        if (!Array.isArray(answers) || answers.length !== p.questions.length ||
          p.questions.some(q => answers.filter(a => a.id === q.id).length !== 1)) throw failure('请回答每个问题。');
        for (const q of p.questions) {
          const a = answers.find(a => a.id === q.id);
          if (!Array.isArray(a.selected) || new Set(a.selected).size !== a.selected.length ||
            a.selected.some(label => !q.options?.some(o => o.label === label)) ||
            (!q.multiSelect && a.selected.length > 1) || (a.custom !== undefined && typeof a.custom !== 'string') ||
            (!a.selected.length && !a.custom?.trim()) || (q.intent?.kind === 'approval' && (a.custom || a.selected.length !== 1))) throw failure('回答不符合问题选项。');
        }
        p.finish({ answers });
      }
      return { accepted: true };
    },
    close() { for (const dispose of disposers) dispose(); for (const p of [...pending.values()]) p.finish(p.kind === 'approval' ? 'cancelled' : undefined, p.kind === 'question' ? new Error('Outlet closed') : undefined); },
  };
}

export async function startServer(ctx, config, native = {}) {
  if (typeof config.token !== 'string' || !config.token.trim()) throw new Error('ZHIXING_DSH_TOKEN is required');
  const token = Buffer.from(`Bearer ${config.token}`);
  const children = new Set([...native.metadata.revisions.entries()].flatMap(([, state]) => state.entries.map(entry => entry.child)));
  const owns = id => own(id) || children.has(id);
  const interactions = createInteractions(ctx, owns);
  const mutations = new Map();
  const serial = (id, action) => {
    const next = (mutations.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    mutations.set(id, next);
    void next.finally(() => { if (mutations.get(id) === next) mutations.delete(id); }).catch(() => {});
    return next;
  };
  const live = new Map();
  const sends = new Map();
  const stopStream = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (!owns(agent.id)) return;
    if (frame.type === 'start') live.set(agent.id, { attemptId: frame.attemptId, turn: frame.turn, step: frame.step, chunks: [] });
    if (frame.type === 'chunk') live.get(agent.id)?.chunks.push(frame.chunk);
    if (frame.type === 'end') live.delete(agent.id);
  });
  const signal = () => new AbortController().signal;
  const permissionModes = ['read-only', 'workspace-write', 'danger-full-access'];
  const permissions = current => {
    const service = ctx.get?.('permissionPresets');
    if (!service || !ctx.get?.('commands')) return null;
    const catalog = service.catalog();
    return { current: current ?? catalog.defaultPreset,
      options: permissionModes.filter(value => catalog.options.some(option => option.value === value)) };
  };
  const validatePermission = value => {
    const available = permissions();
    if (!available) throw failure('当前服务未提供权限设置。', 503);
    if (!available.options.includes(value)) throw failure('无效或不可用的权限模式。');
  };
  const selectPermission = async (id, value) => {
    validatePermission(value);
    const agent = await resolve(id);
    const service = ctx.get('permissionPresets');
    // Use the same command as DSH's own picker, including its policy-change notice.
    if (service.current(agent.session) !== value) {
      const result = await ctx.get('commands').execute(agent, `/permission ${value}`, [], signal());
      if (result?.result.kind !== 'success') throw failure(result?.result.text ?? '权限切换未完成。', 409);
    }
    await flush(id);
    const current = service.current(agent.session);
    if (current !== value) throw failure('权限尚未生效，请刷新后重试。', 409);
    return permissions(current);
  };
  const list = async () => {
    const all = (await ctx.sessionController.list({}, signal())).items;
    return Promise.all(all.filter(row => own(row.sessionId) && !native.metadata.deleted?.get(row.sessionId)).map(async root => {
      const activeId = await revisions.active(root.sessionId);
      const active = all.find(row => row.sessionId === activeId);
      return active ? { ...active, sessionId: root.sessionId, projections: { values: { ...active.projections?.values, title: root.projections?.values.title } } } : root;
    }));
  };
  const get = async id => {
    const row = (await list()).find(row => row.sessionId === id);
    if (!row) throw failure('对话不存在。', 404);
    return conversation(row);
  };
  const resolve = async id => {
    const result = await ctx.sessionController.resolveAgent(id);
    if (result.error) throw result.error;
    return result.agent;
  };
  const selectModel = async (sessionId, body) => {
    const defaults = (await ctx.sessionController.modelCatalog()).default;
    let selected;
    try { selected = body.model_id ? JSON.parse(body.model_id) : [defaults.provider, defaults.model]; }
    catch { throw failure('无效的模型标识。'); }
    if (!Array.isArray(selected) || selected.length !== 2 || selected.some(value => typeof value !== 'string' || !value)) throw failure('无效的模型标识。');
    const [provider, model] = selected;
    await ctx.sessionController.selectModel({ sessionId, provider, model,
      ...(body.reasoning_effort && body.reasoning_effort !== 'auto' ? { reasoningEffort: body.reasoning_effort } : {}) });
  };
  const flush = async id => { const session = ctx.sessions.get(id); if (session) await ctx.sessions.flush(session); };
  async function* records(id) {
    await flush(id);
    const reader = await ctx.sessionPersistence.open(id, 'read');
    try {
      for (let offset = 0;;) {
        const { events } = await reader.read(offset, 256);
        yield* events;
        if (events.length < 256) break;
        offset += events.length;
      }
    } finally { await reader.close(); }
  }
  const revisions = createRevisions(ctx, { records, resolve, flush, ...native, register: id => children.add(id) });
  const attachmentFor = async (id, attachmentId, type) => {
    for await (const event of records(id)) {
      const content = event.data?.message?.content ?? event.data?.content;
      const ref = Array.isArray(content) ? content.find(block => block.type === type && block.attachment?.attachmentId === attachmentId)?.attachment : undefined;
      if (ref) return ref;
    }
    throw failure('这段对话中没有这个附件。', 404);
  };
  const send = (id, body) => {
    if (typeof body.id !== 'string' || !body.id) throw failure('消息缺少请求编号。');
    // Serialize admission as well as using DSH's durable rpcId deduplication.
    const previous = sends.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const result = await ctx.sessionController.prompt({ sessionId: id, requestId: body.id,
        mode: body.intent === 'steer' ? 'steer' : 'queue',
        content: body.parts ?? [{ type: 'text', text: body.content ?? '' }] }, signal());
      await flush(id);
      return result;
    });
    sends.set(id, operation);
    void operation.finally(() => { if (sends.get(id) === operation) sends.delete(id); }).catch(() => {});
    return operation;
  };
  const server = createServer(async (req, res) => {
    const reply = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      const provided = Buffer.from(req.headers.authorization ?? '');
      if (provided.length !== token.length || !timingSafeEqual(provided, token)) throw failure('连接令牌无效。', 401);
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const method = req.method;
      if (method === 'GET' && path === '/v1/status') {
        const catalog = await ctx.sessionController.modelCatalog();
        return reply({ runtime: 'dsh', model_ready: catalog.routableProviders.includes(catalog.default.provider) && catalog.groups.some(g => g.id === catalog.default.provider && g.models.some(m => m.id === catalog.default.model)), worker_online: true,
          execution_available: true, business_connected: !!native.business, web_url: config.webUrl ?? null, permissions: permissions() });
      }
      if (method === 'GET' && path === '/v1/assistant') return reply({ name: '知行', persona: '' });
      if (method === 'GET' && path === '/v1/models') {
        const catalog = await ctx.sessionController.modelCatalog(), images = new Map();
        if (ctx.llm) await Promise.all(catalog.groups.flatMap(g => g.models.map(async m => {
          const info = await ctx.llm.resolveModelInfo(g.id, m.id);
          images.set(routeId({ provider: g.id, model: m.id }), info.inputModalities?.includes('image') ?? false);
        })));
        return reply(modelCatalog(catalog, images));
      }
      if (method === 'GET' && path === '/v1/agents') return reply(page(native.business ? ['finance', 'health'].map(id => ({ id,
        kind: 'service', service: id, name: id === 'finance' ? '财务助手' : '健康助手', description: 'DSH · 知行业务服务',
        instructions: '', tools: [], visible: true })) : []));
      if (method === 'GET' && ['/v1/conversations', '/v1/conversations/recent'].includes(path)) return reply({ ...page((await list()).map(conversation)),
        deleted_ids: [...native.metadata.deleted?.entries() ?? []].map(([id]) => id) });
      if (method === 'GET' && path === '/v1/conversations/search') {
        const needle = (url.searchParams.get('q') ?? '').trim().toLocaleLowerCase();
        if (!needle) return reply(page([]));
        const chats = (await list()).map(conversation).sort((a, b) =>
          url.searchParams.get('sort') === 'oldest' ? a.updated_at.localeCompare(b.updated_at) : b.updated_at.localeCompare(a.updated_at));
        // The stock Web profile may disable the optional DSH search index.
        // Search this outlet's cold-readable message records directly; no host configuration changes.
        const items = [];
        for (const chat of chats) {
          if (res.destroyed) return;
          let hit;
          const version = await revisions.active(chat.id);
          for await (const event of records(version)) {
            if (res.destroyed) return;
            const text = messageText(event), index = text.toLocaleLowerCase().indexOf(needle);
            if (index >= 0) { hit = { seq: event.seq, id: event.data.message?.id ?? event.data.id,
              snippet: text.slice(Math.max(0, index - 50), index + needle.length + 140) }; break; }
          }
          if (!hit && !chat.title.toLocaleLowerCase().includes(needle)) continue;
          items.push({ conversation_id: chat.id, title: chat.title, agent_id: chat.agent_id,
            updated_at: chat.updated_at, message_id: hit?.id ?? null, message_seq: hit?.seq ?? null, message_version: version, snippet: hit?.snippet ?? '' });
        }
        return reply(page(items));
      }
      if (method === 'POST' && path === '/v1/conversations') {
        const body = await json(req);
        if (body.permission != null) validatePermission(body.permission);
        const service = ['finance', 'health'].includes(body.agent_id) ? body.agent_id : 'main';
        const { sessionId } = await ctx.sessionController.create({ sessionId: `zhixing-${service}-${randomUUID()}` });
        if (body.permission != null) await selectPermission(sessionId, body.permission);
        // An upload may create the thread before its first message. Keep the
        // placeholder out of native rename so DSH can generate the real title.
        if (body.title?.trim() && body.title.trim() !== '新的对话') await ctx.sessionController.rename({ sessionId, title: body.title.trim() });
        if (body.model_id || body.reasoning_effort) await selectModel(sessionId, body);
        await flush(sessionId);
        return reply(await get(sessionId), 201);
      }
      const match = path.match(/^\/v1\/conversations\/([^/]+)(.*)$/);
      if (match && own(match[1])) {
        const [, root, suffix] = match;
        const handle = async () => {
        if (method === 'DELETE' && !suffix && native.metadata.deleted?.get(root)) return reply({ deleted: true });
        await get(root);
        const history = await revisions.summary(root);
        const id = history.active;
        if (method === 'DELETE' && !suffix) {
          const workspace = ctx.get?.('workspaceRegistry');
          if (!workspace || !native.metadata.deleted) throw failure('当前宿主未提供对话移除能力。', 503);
          const ledger = await revisions.load(root);
          for (const sessionId of new Set([root, ...ledger.entries.map(entry => entry.child)])) {
            // A revision's durable reservation may precede its native creation.
            if (sessionId !== root && !ctx.agents.get(sessionId) && !await ctx.sessionPersistence.stat(sessionId)) continue;
            const agent = ctx.agents.get(sessionId);
            await workspace.archiveSession(sessionId, { stopActivity: true });
            // Archive admission requests native cancellation. A cold session has
            // no turn to cancel; live agents must actually finish before the ACK.
            if (agent) await agent.whenIdle();
            await flush(sessionId);
          }
          await native.metadata.deleted.put(root, { deletedAt: new Date().toISOString() });
          return reply({ deleted: true });
        }
        if (method === 'GET' && !suffix) return reply(await get(root));
        if (method === 'POST' && suffix === '/dsh/revisions') return reply(await revisions.revise(root, await json(req)));
        if (method === 'PUT' && suffix === '/dsh/version') return reply(await revisions.select(root, await json(req)));
        if (method === 'PUT' && suffix === '/title') {
          const body = await json(req);
          if (typeof body.title !== 'string' || !body.title.trim()) throw failure('请填写对话名称。');
          await ctx.sessionController.rename({ sessionId: root, title: body.title.trim() });
          await flush(root); return reply(await get(root));
        }
        if (method === 'POST' && suffix === '/messages') {
          const body = await json(req);
          if (body.version && body.version !== id) throw failure('对话版本已改变，消息仍在草稿中。', 409);
          return reply(await send(id, body));
        }
        if (method === 'PUT' && suffix === '/model') {
          const body = await json(req);
          await selectModel(id, body);
          await flush(id); return reply(await get(root));
        }
        if (method === 'PUT' && suffix === '/dsh/permissions') {
          const body = await json(req);
          if (body.version !== id) throw failure('对话版本已改变，请刷新后再修改权限。', 409);
          return reply(await selectPermission(id, body.permission));
        }
        if (method === 'GET' && suffix === '/dsh') {
          const requested = Number(url.searchParams.get('offset') ?? 0);
          const offset = (url.searchParams.get('version') ?? id) === id ? requested : 0;
          if (!Number.isSafeInteger(requested) || requested < 0) throw failure('无效的事件位置。');
          await flush(id);
          const reader = await ctx.sessionPersistence.open(id, 'read');
          let events;
          try { ({ events } = await reader.read(offset, 256)); } finally { await reader.close(); }
          const agent = ctx.agents.get(id);
          const pending = [...interactions.list(id), ...(native.environment?.list(id) ?? [])];
          const projection = ctx.sessionController.projections ? await ctx.sessionController.projections({ sessionId: id }, signal()) : null;
          for (const question of projection?.values.userQuestions?.active ?? []) {
            if (question.state === 'continued') pending.push({ id: `continued:${question.callId}`, sessionId: id,
              kind: 'question', questions: question.questions, callId: question.callId });
          }
          const state = await ctx.sessionController.state({ sessionId: id }, signal());
          return reply({ history, events, next: offset + events.length, hasMore: events.length === 256,
            permissions: projection?.values.permissions ? permissions(projection.values.permissions.currentValue) : null,
            running: agent?.status === 'running', active: !!agent, pending,
            queue: (state.queue ?? []).filter(item => item.placement !== 'context'), live: live.get(id) ?? null });
        }
        if (method === 'POST' && suffix.startsWith('/dsh/queue/')) {
          const itemId = decodeURIComponent(suffix.slice('/dsh/queue/'.length));
          const action = await json(req);
          if (!['remove', 'steer', 'edit'].includes(action.kind)) throw failure('无效的队列操作。');
          const result = await ctx.sessionController.updateQueue({ sessionId: id, itemId, action });
          await flush(id); return reply(result);
        }
        const delivery = suffix.match(/^\/dsh\/deliveries\/(\d+)\/(\d+)(\/text)?$/);
        if (method === 'GET' && delivery) {
          const version = url.searchParams.get('version') ?? id;
          if (!history.versions.some(v => v.id === version)) throw failure('这个文件不属于当前对话。', 404);
          const target = await declaredFile(ctx, records, version, Number(delivery[1]), Number(delivery[2]));
          const abort = new AbortController();
          const disconnected = () => { if (!res.writableFinished) abort.abort(); };
          res.once('close', disconnected);
          try {
            if (delivery[3]) {
              const page = await ctx.workspaceFiles.read(target.scope, target.path, {}, abort.signal);
              return reply({ resource_id: `presented:${delivery[1]}:${delivery[2]}`, content: page.text,
                format: /\.(md|markdown)$/i.test(target.name) ? 'markdown' : 'text', truncated: !page.eof });
            }
            // Resolve access before sending headers; byte reads retain all Host filesystem policy.
            await ctx.workspaceFiles.stat(target.scope, target.path, abort.signal);
            res.writeHead(200, { 'Content-Type': textFile(target.name) ? 'text/plain; charset=utf-8' : 'application/octet-stream',
              'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(target.name)}`,
              'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
            await pipeline(Readable.from(deliveryBytes(ctx, target, abort.signal)), res);
            return;
          } finally { res.removeListener('close', disconnected); }
        }
        if (method === 'GET' && suffix.startsWith('/dsh/images/')) {
          const attachmentId = decodeURIComponent(suffix.slice('/dsh/images/'.length));
          // DSH's attachment reader validates bytes, but not session ownership.
          // Resolve the immutable reference from this conversation, never from a client path.
          const attachment = await attachmentFor(id, attachmentId, 'image');
          const result = await ctx.sessionController.attachment({ sessionId: id, attachment });
          res.writeHead(200, { 'Content-Type': result.attachment.mediaType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
          return res.end(Buffer.from(result.data, 'base64'));
        }
        const file = suffix.match(/^\/dsh\/files\/([^/]+)(\/text)?$/);
        if (method === 'GET' && file) {
          const attachment = await attachmentFor(id, decodeURIComponent(file[1]), 'file');
          const abort = new AbortController();
          const disconnected = () => { if (!res.writableFinished) abort.abort(); };
          res.once('close', disconnected);
          try {
            if (file[2]) {
              if (!textFile(attachment.name)) throw failure('此文件请下载后在其他应用打开。', 415);
              const limit = 256 * 1024, chunks = []; let bytes = 0, total = 0;
              for await (const chunk of ctx.attachments.readFileStream(attachment, abort.signal)) {
                total += chunk.length;
                if (bytes < limit) { const kept = Buffer.from(chunk.subarray(0, limit - bytes)); chunks.push(kept); bytes += kept.length; }
              }
              return reply({ resource_id: attachment.attachmentId, content: Buffer.concat(chunks).toString('utf8'),
                format: /\.(md|markdown)$/i.test(attachment.name) ? 'markdown' : 'text', truncated: total > limit });
            }
            res.writeHead(200, { 'Content-Type': textFile(attachment.name) ? 'text/plain; charset=utf-8' : 'application/octet-stream',
              'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
              // End the chunked response only after DSH's stream verifies integrity.
              'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
            await pipeline(Readable.from(ctx.attachments.readFileStream(attachment, abort.signal)), res);
            return;
          } finally { res.removeListener('close', disconnected); }
        }
        if (method === 'POST' && suffix === '/dsh/cancel') {
          const agent = ctx.agents.get(id);
          ctx.sessionController.cancel({ sessionId: id });
          if (agent) await agent.whenIdle();
          await flush(id);
          return reply({ stopped: true });
        }
        if (method === 'POST' && suffix.startsWith('/dsh/answers/')) {
          const requestId = suffix.split('/').at(-1), body = await json(req);
          if (requestId.startsWith('continued:')) {
            const agent = await resolve(id);
            if (!Array.isArray(body.answers) || body.answers.some(a => !a || typeof a.id !== 'string' || !Array.isArray(a.selected)
              || a.selected.some(s => typeof s !== 'string') || (a.custom !== undefined && typeof a.custom !== 'string'))) throw failure('无效的回答。');
            const accepted = ctx.userQuestions.answer(agent, requestId.slice('continued:'.length), body);
            if (!accepted) throw failure('问题已经结束，请刷新。', 409);
            await flush(id); return reply({ accepted });
          }
          return reply(interactions.answer(id, requestId, body));
        }
        if (method === 'POST' && suffix.startsWith('/dsh/environment/')) {
          if (!native.environment) throw failure('宿主尚未提供私密变量填写功能。', 503);
          const body = await json(req, 512 * 1024);
          if (body.version !== id) throw failure('对话版本已改变，请刷新后重新填写。', 409);
          return reply(await native.environment.answer(id, suffix.split('/').at(-1), body));
        }
        if (method === 'PUT' && suffix === '/dsh/files') {
          await resolve(id);
          const args = { sessionId: id, data: req, name: url.searchParams.get('name') || 'file' };
          const mediaType = url.searchParams.get('mediaType');
          return reply(await (mediaType?.startsWith('image/') ? ctx.fileUploads.uploadImageStream({ ...args, mediaType }) : ctx.fileUploads.uploadStream(args)));
        }
        throw failure('接口不存在。', 404);
        };
        // Stream uploads and human responses must not delay stopping a running tool.
        const independent = method === 'GET' || suffix === '/dsh/cancel' || suffix.startsWith('/dsh/answers/') || suffix.startsWith('/dsh/environment/') || (method === 'PUT' && suffix === '/dsh/files');
        return await (independent ? handle() : serial(root, handle));
      }
      if (businessPath(path)) {
        if (!native.business) throw failure('知行业务插件尚未就绪。', 503);
        return reply(await native.business.request(path + url.search, method, method === 'GET' ? undefined : await json(req)));
      }
      throw failure('此入口由 DSH 宿主管理，请在 DSH 中配置。', 404);
    } catch (error) {
      if (!res.headersSent) reply({ error: { code: error.code ?? 'dsh_error', message: error.message } }, error.status ?? 400);
      else res.destroy();
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port ?? 8001, config.host ?? '127.0.0.1', resolve); });
  } catch (error) { interactions.close(); stopStream(); throw error; }
  return { owns, address: server.address(), async close() {
    interactions.close(); stopStream();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
