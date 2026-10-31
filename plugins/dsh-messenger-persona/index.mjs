import { fileURLToPath } from 'node:url';
import { openPersonaFile, isMessengerAgent } from './persona-file.mjs';

export const name = 'zhixing-messenger-persona';
export const inject = ['agents', 'systemPrompt'];

export function apply(ctx, config = {}) {
  const card = openPersonaFile(config.personaFile || fileURLToPath(new URL('./personas/march-seven.md', import.meta.url)),
    message => ctx.logger?.warn?.(message));
  const mounted = new Map();
  const mount = agent => {
    if (!isMessengerAgent(agent) || mounted.has(agent)) return;
    const personaOff = agent.ctx.systemPrompt.section({
      name: 'deployment:persona-prefix',
      order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      interpolate: false,
      text: () => card.read(),
    });
    const channelOff = agent.ctx.systemPrompt.section({
      name: 'zhixing:messenger-channel',
      order: 10210,
      interpolate: false,
      text: '这是实际的线上聊天。三月七的相机和列车是角色背景，当前没有真实相机、相册或离线生活。' +
        '回答“在干嘛”“今天做了什么”时，只依据本对话和真实工具记录：没有记录就自然回应当下，不能补出刚在翻照片、吃东西、出门、刷视频或等待了一整天。' +
        '活泼来自你对眼前内容的具体反应，不靠虚构刚发生的事情。没有新内容时一句话也够，不用每轮反问。' +
        '被问真人或 AI，简短如实回答即可，继续保持熟悉的口吻。',
    });
    const off = () => { personaOff(); channelOff(); };
    mounted.set(agent, off);
    // The agent may be disposed before the host plugin. Do not retain its
    // session/history, and allow a restored instance to mount independently.
    agent.ctx.on('dispose', () => { off(); mounted.delete(agent); });
  };
  ctx.on('agent/created', ({ agent }) => mount(agent));
  ctx.effect(() => () => {
    for (const off of mounted.values()) off();
    mounted.clear();
  });
  for (const agent of ctx.agents.list()) mount(agent);
}
