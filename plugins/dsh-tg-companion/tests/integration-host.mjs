// Isolated acceptance only. No Telegram token; messages go to a receipt fixture.
import { readFileSync, writeFileSync } from 'node:fs';
import { createCompanion } from '../index.mjs';
import { openState } from '../state.mjs';
import { fetchNews } from '../news.mjs';
import { assembleContextFor } from '@deepseek-ai/dsh-agent';

export const inject = ['agents', 'agentPresets', 'sessions', 'sessionPersistence', 'systemPrompt', 'llm', 'tools', 'webServer'];
export async function apply(ctx, config) {
  let now = Date.now();
  const store = openState(config.stateFile, config.targetUserId, { now });
  const sent = [];
  const companion = createCompanion(ctx, config, store, { clock: () => now, news: () => fetchNews({ now }) });
  ctx.provide('zhixingCompanion', companion);
  const { Gateway } = await import(config.gatewayPath);
  const gateway = new Gateway(ctx, { telegram: { enabled: false, allowedUserIds: [config.targetUserId], progressEnabled: false },
    agent: { cwd: config.workspace, provider: 'deepseek-official', model: 'deepseek-flash', sessionScope: 'user', idleTimeoutMs: 3_600_000 }, media: {} });
  await gateway.start();
  gateway.adapters.set('telegram', { call: async (method, args) => {
    if (method !== 'sendMessage' || args.chat_id !== config.targetUserId) throw new Error('Unexpected delivery');
    const receipt = { message_id: 1000 + sent.length, args };
    sent.push(receipt); writeFileSync(config.receiptFile, JSON.stringify(sent, null, 2)); return receipt;
  } });
  companion.connect(gateway);
  ctx.effect(() => () => { companion.close(); gateway.stop(); });
  const input = { platform: 'telegram', chatId: config.targetUserId, userId: config.targetUserId, chatType: 'private', threadId: 0, attachments: [] };
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/companion-acceptance', handler: async (req, res) => {
    if (req.headers.authorization !== `Bearer ${config.token}`) { res.writeHead(401); res.end(); return; }
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}'); let output;
      const replies = [];
      if (body.action === 'turn') {
        const key = gateway.sessionKeyFor(input);
        await gateway.handleMessage({ ...input, text: body.text, reply: async value => { replies.push(value); } });
        await gateway.chats.get(key)?.busy;
        const id = store.get().sessionId;
        const agent = id && ctx.agents.get(id);
        if (agent) await ctx.sessions.flush(agent.session);
        output = { replies, sessionId: id, memoryId: companion.memoryId(id), state: store.get(),
          messages: id && await ctx.sessionPersistence.stat(id) ? await companion.recent(id) : [] };
      } else if (body.action === 'reap') {
        for (const c of gateway.chats.values()) c.lastUsed = 0;
        gateway.reapIdle(); await new Promise(resolve => setTimeout(resolve, 300));
        output = { active: gateway.chats.size, state: store.get() };
      } else if (body.action === 'restore-new-race') {
        for (const c of gateway.chats.values()) c.lastUsed = 0;
        gateway.reapIdle();
        const id = store.get().sessionId, key = gateway.sessionKeyFor(input);
        const opening = gateway.getOrCreateChat(key, input);
        await companion.beforeMessage(gateway, key, { ...input, text: '/new', reply: async v => { replies.push(v); } });
        const chat = await opening;
        output = { bindingPreserved: store.get().sessionId === id && chat.agent.id === id, replies };
      } else if (body.action === 'scope') {
        const own = await gateway.getOrCreateChat(gateway.sessionKeyFor(input), input);
        const { agent, dispose } = await ctx.agents.create({ sessionId: 'web-companion-scope-' + Date.now(), meta: { cwd: config.workspace },
          setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx); } });
        const ownPrompt = await ctx.systemPrompt.assemble(assembleContextFor(own.agent));
        const otherPrompt = await ctx.systemPrompt.assemble(assembleContextFor(agent));
        output = { ownTools: ownPrompt.tools.map(t => t.name), otherTools: otherPrompt.tools.map(t => t.name),
          otherMemoryScopeUnchanged: companion.memoryId(agent.id) === agent.id,
          otherPromptIsolated: !otherPrompt.sections.some(s => s.name === 'zhixing:companion-continuity') };
        await dispose();
      } else if (body.action === 'check') {
        now = body.now || now;
        if (body.prepare) store.change(s => { s.lastCheckAt = 0; s.lastInboundAt = now - 3 * 3_600_000; s.inboundVersion++; });
        output = { result: await companion.check(), state: store.get(), sent };
      } else if (body.action === 'live-news') {
        output = { items: await fetchNews() };
      } else if (body.action === 'memory') {
        output = JSON.parse(readFileSync(config.memoryDir + '/' + store.get().memoryId + '.json', 'utf8'));
      } else output = { state: store.get() };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(output));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message, stack: e.stack })); }
  } }));
}
