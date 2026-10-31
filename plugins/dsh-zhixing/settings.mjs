import { randomUUID } from 'node:crypto';

const fields = {
  permission: { ns: 'permission', path: 'defaultPreset' },
  busy: { ns: 'ui-conversation', path: 'busyEnter' },
};
const failure = (message, status = 400) => Object.assign(new Error(message), { status });

/** A narrow view of DSH's own settings document, never a second configuration store. */
export function createChatSettings(ctx) {
  // Native revisions restart with the host. A cached pre-restart editor must re-read.
  const epoch = randomUUID();
  const read = () => {
    const service = ctx.get?.('settings');
    if (!service) throw failure('当前 DSH 尚未提供配置服务，请更新服务后重试。', 503);
    const views = service.describe({ redactSecrets: true });
    const catalog = ctx.get?.('permissionPresets')?.catalog();
    const result = { writable: service.writable, permission: null, busy: null };
    for (const [key, field] of Object.entries(fields)) {
      const view = views.find(item => item.ns === field.ns);
      if (!view) continue;
      const options = key === 'permission' ? catalog?.defaultOptions?.map(option => option.value) ?? [] : ['queue', 'steer'];
      const value = view.value?.[field.path] ?? (key === 'permission' ? catalog?.defaultPreset : undefined);
      if (typeof value === 'string') result[key] = { value, options, revision: `${epoch}:${view.revision}` };
    }
    return result;
  };
  return {
    read,
    busyBehavior() {
      // Older/minimal profiles can still chat without a settings provider.
      const view = ctx.get?.('settings')?.describe({ redactSecrets: true }).find(item => item.ns === fields.busy.ns);
      return view?.value?.busyEnter === 'steer' ? 'steer' : 'queue';
    },
    async write(body) {
      if (!body || !Object.hasOwn(fields, body.key) || Object.keys(body).some(key => !['key', 'value', 'revision'].includes(key))) throw failure('无效的设置项。');
      const current = read(), item = current[body.key], field = fields[body.key];
      if (!current.writable || !item) throw failure('当前 DSH 不支持修改这项设置。', 503);
      if (typeof body.revision !== 'string' || body.revision !== item.revision) throw failure('云端设置已更新，请刷新后再选择。', 409);
      if (!item.options.includes(body.value)) throw failure('当前 DSH 不支持这个选项。');
      try {
        await ctx.get('settings').mutate(field.ns,
          [{ op: 'set', path: [field.path], value: body.value }], Number(item.revision.split(':').at(-1)));
      } catch (error) {
        if (error.code === 'SETTINGS_CONFLICT') throw failure('云端设置已更新，请刷新后再选择。', 409);
        throw failure('DSH 未能保存设置，请重试。');
      }
      const updated = read();
      if (updated[body.key]?.value !== body.value) throw failure('设置尚未生效，请刷新后重试。', 409);
      return updated;
    },
  };
}
