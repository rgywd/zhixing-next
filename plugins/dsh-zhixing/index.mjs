import { defineTool } from '@deepseek-ai/dsh-tools';
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { startServer, businessRequest } from './server.mjs';
import { openChatStorage } from './storage.mjs';

export const name = 'zhixing-app';
export const inject = ['sessionController', 'sessionPersistence', 'sessions', 'agents', 'tools', 'fileUploads', 'attachments', 'userQuestions', 'systemPrompt', 'llm', 'storageDomain', 'fs', 'workingDirectory', 'workspaceFiles', 'sandboxPolicy'];

export async function apply(ctx, config) {
  const metadata = await openChatStorage(ctx);
  ctx.effect(() => () => metadata.close());
  const server = await startServer(ctx, config, {
    metadata,
    async forkRevision(id, source, events, cut) {
      if (ctx.agents.get(id)) return ctx.agents.get(id);
      if (await ctx.sessionPersistence.stat(id)) {
        const restored = await ctx.sessionController.resolveAgent(id);
        if (restored.error) throw restored.error;
        return restored.agent;
      }
      const presets = ctx.get('agentPresets');
      const preset = presets?.composedPreset(source.ctx) ?? source.session.header.agentPreset;
      const selection = source.model.current();
      const { agent } = await ctx.agents.create({ sessionId: id, seed: buildForkSeed(events, cut), inheritedEventCount: cut + 1,
        meta: { isSeeded: true, ...(source.session.header.cwd ? { cwd: source.session.header.cwd } : {}), ...(preset ? { agentPreset: preset } : {}) },
        agentOptions: selection ? { provider: selection.provider, model: selection.model } : {},
        setup: async (childCtx, child) => {
          installModelSelection(childCtx);
          if (presets) presets.composeFrom(childCtx, source.ctx);
          // A history cut may contain future queued messages. Do not execute them in the new version.
          child.inbox.clear();
        },
      });
      const workspaces = ctx.get('workspaceRegistry');
      if (workspaces) for (const workspace of await workspaces.list()) {
        if (workspace.sessionIds.includes(source.id)) { await workspace.attachSession(id); break; }
      }
      if (selection) await ctx.sessionController.selectModel({ sessionId: id, ...selection });
      return agent;
    },
  });
  ctx.effect(() => () => server.close());
  ctx.on('agent/created', ({ agent }) => {
    if (!server.owns(agent.id)) return;
    agent.ctx.systemPrompt.section({ name: 'zhixing-outlet', order: 10000, interpolate: false,
      text: '当前对话来自知行 Next App。你是知行，使用 DSH 宿主实际提供的模型、工具、插件和工作目录执行用户请求。App 展示你的正文、工具调用、执行结果和问题；没有自动提供手机屏幕或其他设备上下文。' +
        '需要交付工作区文件时，使用宿主原生 present 工具声明最终文件，App 会显示文件卡片并提供预览和分享。' +
        (config.businessUrl ? '知行财务、健康、记忆和资料保存在 zhixing_service 中；需要这些数据时先读取业务 schema，使用实际记录和接口回执回答。' : '本宿主尚未连接知行业务数据库。'),
    });
  });
  if (config.businessUrl) ctx.tools.register(defineTool({
    name: 'zhixing_service',
    description: 'Use Zhixing personal finance, health, memory and resource services. First call GET /v1/business/schema for the exact API schemas; then use /v1/finance, /v1/health, /v1/life, /v1/memories or /v1/resources routes. This service stores user data; use it when the user asks to read or change that data. The host’s other tools remain available.',
    parameters: {
      method: { type: 'string', required: true, enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      path: { type: 'string', required: true },
      body: { type: 'json' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const response = await businessRequest(config, args.path, args.method, args.body, exec.signal);
      const text = await response.text();
      if (!response.ok) throw new Error(`Zhixing ${response.status}: ${text}`);
      return text;
    },
  }));
}
