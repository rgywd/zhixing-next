import { defineTool } from '@deepseek-ai/dsh-tools';
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { startServer } from './server.mjs';
import { openChatStorage } from './storage.mjs';
import { openBusinessStorage } from './business/service.mjs';
import { toolBody } from './business/tool-context.mjs';
import { createEnvironment } from './environment.mjs';

export const name = 'zhixing-app';
export const inject = ['sessionController', 'sessionPersistence', 'sessions', 'agents', 'tools', 'fileUploads', 'attachments', 'userQuestions', 'systemPrompt', 'llm', 'storageDomain', 'fs', 'workingDirectory', 'workspaceFiles', 'sandboxPolicy', 'credentials', 'shellEnv'];

export async function apply(ctx, config) {
  const metadata = await openChatStorage(ctx);
  ctx.effect(() => () => metadata.close());
  const business = await openBusinessStorage(ctx, config.businessImport);
  ctx.effect(() => () => business.close());
  let server;
  const environment = await createEnvironment(ctx, id => server?.owns(id) ?? false);
  ctx.effect(() => () => environment.close());
  server = await startServer(ctx, config, {
    metadata, business, environment,
    async forkRevision(id, source, events, cut) {
      const inheritPermissions = agent => {
        // A cut or interrupted fork must not revive a wider historical preset.
        const permissions = ctx.get('permissionPresets');
        if (permissions) {
          const current = permissions.current(source.session);
          if (permissions.names.includes(current)) permissions.set(agent.session, current);
        }
        return agent;
      };
      if (ctx.agents.get(id)) return inheritPermissions(ctx.agents.get(id));
      if (await ctx.sessionPersistence.stat(id)) {
        const restored = await ctx.sessionController.resolveAgent(id);
        if (restored.error) throw restored.error;
        return inheritPermissions(restored.agent);
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
      return inheritPermissions(agent);
    },
  });
  ctx.effect(() => () => server.close());
  ctx.on('agent/created', ({ agent }) => {
    if (!server.owns(agent.id)) return;
    agent.ctx.systemPrompt.section({ name: 'zhixing-outlet', order: 10000, interpolate: false,
      text: '当前对话来自知行 Next App。你是知行，使用 DSH 宿主实际提供的模型、工具、插件和工作目录执行用户请求。App 展示你的正文、工具调用、执行结果和问题；没有自动提供手机屏幕或其他设备上下文。' +
        '需要交付工作区文件时，使用宿主原生 present 工具声明最终文件，App 会显示文件卡片并提供预览和分享。' +
        '需要用户提供密钥、token 或其他私密值时，用 zhixing_request_variables 发起填写卡，一次可以请求多个变量。不要让用户把密钥发进聊天或明文工作区文件；只提出用途和 DSH_SECRET_ 前缀的变量名，用户可以改名。保存后根据返回的实际变量名通过原生 bash/pwsh 环境使用，不打印值、不把值拼进工具参数，不关闭权限审批。' +
        '知行财务和健康记录通过 zhixing_service 读写，保存在宿主原生存储中；需要这些数据时先读取相应业务 schema，使用实际记录和接口回执回答。搜索、记忆、会话和文件使用宿主原生能力与已安装插件。' +
        '日常回复简明说明替用户完成了什么、实际金额和必要的下一步；内部编号、原子性、档案版本和接口路径留在工具详情，除非用户主动问实现细节。',
    });
  });
  ctx.tools.register(defineTool({
    name: 'zhixing_request_variables',
    description: 'Ask the user privately for credentials or other environment values in the Zhixing App. Supply a short purpose in title and fields as an array of {name, label}; names must start with DSH_SECRET_ followed by uppercase letters, digits or underscores. Never supply values. The user can edit names and fill up to 12 values together. Waits for explicit submission or cancellation. Returns only saved names/status. Values persist in the native DSH credential store for this workspace and enter subsequent native bash/pwsh environments. Never echo, log or insert the values in tool arguments; reference the returned variable names instead. This does not modify the host login environment or bypass DSH permissions.',
    parameters: { title: { type: 'string', required: true }, fields: { type: 'json', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) { return JSON.stringify(await environment.request(args, exec)); },
  }));
  ctx.tools.register(defineTool({
    name: 'zhixing_service',
    description: 'Read or change Zhixing finance and health records, persisted by DSH. First GET /v1/business/schema?domain=finance (or health, life) for exact fields. Read current records before changing data. Use /v1/life/meals when an actual meal and its explicit payment must be saved together. Source and conversation IDs are filled from the executing native session; omit source_id and conversation_id. Report only amounts and counts verified in saved records. Search, memory, files and sessions use the host and its other plugins.',
    parameters: {
      method: { type: 'string', required: true, enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      path: { type: 'string', required: true },
      body: { type: 'json' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      return JSON.stringify(await business.request(args.path, args.method, toolBody(args, exec), exec.signal));
    },
  }));
}
