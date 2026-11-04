// Isolated native-host probe. Telegram networking must be disabled in its profile.
import { join } from 'node:path';
import { createCompanion } from '../index.mjs';
import { openState } from '../state.mjs';

export const inject = ['agents', 'agentPresets', 'sessions', 'sessionPersistence', 'systemPrompt', 'llm', 'tools', 'webServer'];
export function apply(ctx, config) {
  const store = openState(join(config.workspace, 'contact.json'), 123);
  const controller = createCompanion(ctx, config, store);
  let gateway, connections = 0;
  const connect = controller.connect;
  controller.connect = gw => { gateway = gw; connections++; connect(gw); };
  ctx.provide('zhixingCompanion', controller);
  ctx.effect(() => () => controller.close());
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/model-acceptance', handler: async (req, res) => {
    if (req.headers.authorization !== `Bearer ${config.token}`) { res.writeHead(401); res.end(); return; }
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      if (!gateway || gateway.tg().enabled) throw new Error('An isolated disabled Telegram gateway is required');
      const replies = [];
      const input = { platform: 'telegram', chatId: 123, userId: 123, threadId: 0, chatType: 'private', attachments: [],
        text: body.text || 'MODEL-CHOICE', reply: async text => { replies.push(text); } };
      const key = gateway.sessionKeyFor(input);
      if (body.action === 'turn') {
        await gateway.handleMessage(input);
        await gateway.chats.get(key)?.busy;
      }
      if (body.action === 'reap') {
        for (const chat of gateway.chats.values()) { await chat.dispose(); gateway.sessionToChat.delete(chat.agent.id); }
        gateway.chats.clear();
      }
      const chat = gateway.chats.get(key);
      if (chat) await ctx.sessions.flush(chat.agent.session);
      const output = { connections, replies, configured: gateway.resolveAgentModel(), current: chat?.agent.model.current(), state: store.get(),
        nativeAgent: ctx.get('settings').describe({ redactSecrets: true }).find(v => v.ns === 'dsh-messenger-gateway')?.value?.agent,
        recent: store.get().sessionId ? await controller.recent(store.get().sessionId, 30) : [] };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(output));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  } }));
}
