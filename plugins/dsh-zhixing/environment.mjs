import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Buffer } from 'node:buffer';

const safeError = Symbol('private-input-error');
const fail = (message, status = 400) => Object.assign(new Error(message), { status, [safeError]: true });
export const validVariableName = name => typeof name === 'string' && /^DSH_SECRET_[A-Z][A-Z0-9_]{0,79}$/.test(name);
const recordValues = record => {
  if (!record) return {};
  const values = record.kind === 'grant' && record.payload?.version === 1 && record.payload.values;
  if (!values || Array.isArray(values) || typeof values !== 'object' ||
    Object.entries(values).some(([name, value]) => !validVariableName(name) || typeof value !== 'string' || !value || value.includes('\0')))
    throw fail('私密变量存储不可用，请检查宿主凭据配置。', 503);
  return values;
};

/** Values travel only through the authenticated write endpoint and DSH credentials.
 * Native shellEnv owns injection; this plugin neither changes process.env nor runs a shell.
 */
export async function createEnvironment(ctx, owns, workspace = process.cwd()) {
  const directory = resolve(workspace);
  const key = `zhixing-app/environment-${createHash('sha256').update(directory).digest('hex')}`;
  const pending = new Map(), receipts = new Map(), registrations = new Map(), sensitive = new Set();
  let values = {}, closed = false, writes = Promise.resolve();
  const remember = value => {
    for (const text of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value).toString('base64')]) sensitive.add(text);
  };
  const sync = record => {
    const next = recordValues(record);
    for (const [name, value] of Object.entries(next)) {
      remember(value);
      if (!registrations.has(name)) registrations.set(name, ctx.shellEnv.register({
        name: `zhixing-secret-${name}`, variables: { [name]: { description: 'User-supplied private workspace variable. Never print its value.' } },
        resolve: execution => execution.agent && resolve(execution.agent.session.header.cwd || directory) === directory && values[name] !== undefined
          ? { [name]: values[name] } : {},
      }));
    }
    values = { ...next };
  };
  sync(await ctx.credentials.readRecord(key));
  // A record changed through another DSH surface must reach the next shell call.
  const unsubscribe = ctx.on('credentials/record-updated', async changed => {
    if (changed !== key || closed) return;
    try { sync(await ctx.credentials.readRecord(key)); } catch { values = {}; }
  });
  const containsSecret = value => {
    const text = JSON.stringify(value);
    return text && [...sensitive].some(secret => text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1)));
  };
  const stopFilter = ctx.on('tools/post-execute', async (_execution, result, next) => {
    const decision = await next();
    // Block the complete result, including structured values and error metadata,
    // before the native pipeline persists it or sends it to the model.
    if (!containsSecret(result) && !containsSecret(decision)) return decision;
    return { kind: 'block', feedback: [{ type: 'text', text: '工具返回内容包含私密变量值，已隐藏。执行可能已完成，请检查非敏感状态，不要重复操作或输出变量值。' }] };
  }, { prepend: true });
  const publicRequest = p => ({ id: p.id, sessionId: p.sessionId, kind: 'environment', title: p.title,
    fields: p.fields, configuredNames: Object.keys(values), scope: '当前 DSH 工作区' });
  return {
    list: sessionId => [...pending.values()].filter(p => p.sessionId === sessionId).map(publicRequest),
    request(args, execution) {
      if (closed || !execution.agent || !owns(execution.agent.id)) throw fail('请在知行 App 对话中填写私密变量。');
      if (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 160 ||
        !Array.isArray(args.fields) || !args.fields.length || args.fields.length > 12) throw fail('请提供用途和 1 到 12 个变量。');
      const names = new Set();
      const fields = args.fields.map((field, index) => {
        if (!field || !validVariableName(field.name) || names.has(field.name) ||
          typeof field.label !== 'string' || !field.label.trim() || field.label.length > 120)
          throw fail('变量名必须唯一，以 DSH_SECRET_ 开头，后接大写字母、数字或下划线。');
        names.add(field.name);
        return { id: String(index), name: field.name, label: field.label.trim() };
      });
      return new Promise(resolveRequest => {
        const id = randomUUID();
        const finish = result => { pending.delete(id); execution.signal.removeEventListener('abort', abort); resolveRequest(result); };
        const abort = () => { if (!pending.get(id)?.saving) finish({ status: 'cancelled', names: [] }); };
        pending.set(id, { id, sessionId: execution.agent.id, title: args.title.trim(), fields, signal: execution.signal, finish });
        execution.signal.addEventListener('abort', abort, { once: true });
        if (execution.signal.aborted) abort();
      });
    },
    async answer(sessionId, id, body) {
      const receipt = receipts.get(id);
      if (receipt && receipt.sessionId === sessionId && receipt.submissionId === body.submissionId) return receipt.result;
      const p = pending.get(id);
      if (!p || p.sessionId !== sessionId || p.signal.aborted || closed) throw fail('填写请求已结束，请刷新。', 409);
      if (body.cancelled === true) {
        if (p.saving) throw fail('正在保存，请稍候。', 409);
        p.finish({ status: 'cancelled', names: [] }); return { accepted: true, status: 'cancelled', names: [] };
      }
      if (typeof body.submissionId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.submissionId) ||
        !Array.isArray(body.fields) || body.fields.length !== p.fields.length) throw fail('请填写所有变量。');
      const names = new Set();
      const submitted = p.fields.map(field => {
        const matches = body.fields.filter(f => f?.id === field.id);
        const item = matches[0];
        if (matches.length !== 1 || !validVariableName(item.name) || names.has(item.name) ||
          typeof item.value !== 'string' || !item.value || item.value.includes('\0') || Buffer.byteLength(item.value) > 32768)
          throw fail('请检查变量名和填写内容；变量名不可重复，内容不可为空或超过 32 KiB。');
        names.add(item.name); return { ...item, replace: item.replace === true };
      });
      if (p.saving) throw fail('正在保存，请稍候。', 409);
      p.saving = true;
      const write = async () => {
        if (closed || p.signal.aborted) throw fail('填写请求已取消。', 409);
        // Reserve native names before the atomic credential write; conflicts cannot
        // produce a success receipt for a variable the executor cannot inject.
        const occupied = new Set(ctx.shellEnv.list().filter(v => !registrations.has(v.key)).map(v => v.key));
        if (submitted.some(item => occupied.has(item.name))) throw fail('变量名已被其他宿主插件使用，请修改名称。', 409);
        const record = await ctx.credentials.modifyRecord(key, async current => {
          if (closed || p.signal.aborted) throw fail('填写请求已取消。', 409);
          const currentValues = recordValues(current);
          if (submitted.some(item => Object.hasOwn(currentValues, item.name) && !item.replace)) throw fail('同名变量已经保存，请明确选择替换。', 409);
          return { kind: 'grant', payload: { version: 1, values: { ...currentValues, ...Object.fromEntries(submitted.map(item => [item.name, item.value])) } } };
        });
        sync(record);
        const result = { accepted: true, status: 'saved', names: [...names] };
        receipts.set(id, { sessionId, submissionId: body.submissionId, result });
        if (receipts.size > 256) receipts.delete(receipts.keys().next().value);
        p.finish({ status: 'saved', names: [...names], scope: 'current workspace', usage: 'Use these environment variables in native bash/pwsh calls. Never echo, log, display or include their values in tool arguments.' });
        return result;
      };
      const task = writes.then(write); writes = task.catch(() => undefined);
      try { return await task; }
      catch (error) {
        if (p.signal.aborted || closed) p.finish({ status: 'cancelled', names: [] });
        // Credential providers may mention values in errors; return only our own
        // validated messages and never forward a provider exception.
        throw fail(error[safeError] ? error.message : '私密变量未能保存，请重试。', error[safeError] ? error.status : 503);
      } finally { p.saving = false; for (const item of submitted) item.value = ''; }
    },
    async close() {
      closed = true;
      for (const p of pending.values()) if (!p.saving) p.finish({ status: 'cancelled', names: [] });
      await writes;
      unsubscribe(); stopFilter(); for (const dispose of registrations.values()) dispose();
      values = {}; sensitive.clear(); receipts.clear();
    },
  };
}
