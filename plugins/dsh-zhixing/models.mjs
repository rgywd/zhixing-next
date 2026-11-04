import { randomUUID } from 'node:crypto';

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
export const modelId = selection => JSON.stringify([selection.provider, selection.model]);

export async function resolveSelection(ctx, id, reasoningEffort) {
  const catalog = await ctx.sessionController.modelCatalog();
  let pair;
  try { pair = id === null ? [catalog.default.provider, catalog.default.model] : JSON.parse(id); }
  catch { throw failure('无效的模型标识。'); }
  if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string' || !value)) throw failure('无效的模型标识。');
  const [provider, model] = pair;
  if (!catalog.routableProviders.includes(provider) || !catalog.groups.some(g => g.id === provider && g.models.some(m => m.id === model))) {
    throw failure('这个模型目前不可用，请刷新模型列表。', 409);
  }
  const selection = { provider, model, ...(reasoningEffort && reasoningEffort !== 'auto' ? { reasoningEffort } : {}) };
  try { await ctx.llm.resolveCallConfig(selection); }
  catch { throw failure('模型配置不可用，请检查云端配置。', 409); }
  return selection;
}

/** The host owns both choices. Only these model fields cross the App API. */
export function createModelSettings(ctx) {
  const epoch = randomUUID();
  const namespaces = { default: 'agent-default-model', telegram: 'dsh-messenger-gateway' };
  const views = () => ctx.get?.('settings')?.describe({ redactSecrets: true }) ?? [];
  const read = () => {
    const all = views(), defaults = ctx.get?.('agentDefaultModel')?.currentSelection();
    const result = {};
    for (const [key, ns] of Object.entries(namespaces)) {
      const view = all.find(v => v.ns === ns);
      if (!view || !defaults) { result[key] = null; continue; }
      const selected = key === 'default' ? defaults : view.value?.agent ?? {};
      const provider = selected.provider || defaults.provider, model = selected.model || defaults.model;
      const follows = key === 'telegram' && !selected.provider && !selected.model;
      result[key] = { model_id: follows ? null : modelId({ provider, model }), effective_model_id: modelId({ provider, model }),
        writable: !!ctx.get('settings').writable, revision: `${epoch}:${view.revision}` };
    }
    return result;
  };
  return { read, async write(body) {
    if (!body || !Object.hasOwn(namespaces, body.key) || Object.keys(body).some(k => !['key', 'model_id', 'revision'].includes(k)) ||
      (typeof body.model_id !== 'string' && !(body.key === 'telegram' && body.model_id === null))) throw failure('无效的模型设置。');
    const current = read()[body.key];
    if (!current?.writable) throw failure('当前服务不支持修改这项模型设置。', 503);
    if (body.revision !== current.revision) throw failure('云端设置已更新，请刷新后再选择。', 409);
    const selection = await resolveSelection(ctx, body.model_id);
    if (body.key === 'telegram' && ctx.get?.('zhixingCompanion')?.isBusy()) throw failure('TG 正在处理消息，请等这轮结束后再切换。', 409);
    const prefix = body.key === 'telegram' ? ['agent'] : [];
    const ops = ['provider', 'model'].map(k => ({ op: 'set', path: [...prefix, k], value: body.model_id === null ? '' : selection[k] }));
    // A reasoning level belongs to a model; let the new model choose its own default.
    if (body.key === 'default') ops.push({ op: 'unset', path: ['reasoningEffort'] });
    try { await ctx.get('settings').mutate(namespaces[body.key], ops, Number(current.revision.split(':').at(-1))); }
    catch (error) {
      if (error.code === 'SETTINGS_CONFLICT') throw failure('云端设置已更新，请刷新后再选择。', 409);
      throw failure('DSH 未能保存模型设置，请重试。', 503);
    }
    const updated = read();
    if (updated[body.key]?.model_id !== body.model_id) throw failure('模型设置尚未生效，请刷新后重试。', 409);
    return updated;
  } };
}

export function modelProtocols(ctx) {
  const profiles = ctx.get?.('settings')?.describe({ redactSecrets: true }).find(v => v.ns === 'llm-pi-ai')?.value?.providers ?? {};
  return new Map(Object.entries(profiles).map(([id, profile]) => [id,
    profile.api === 'openai-responses' ? 'responses' : profile.api === 'openai-completions' ? 'chat_completions' :
      profile.api === 'google-generative-ai' ? 'gemini' : 'unknown']));
}
