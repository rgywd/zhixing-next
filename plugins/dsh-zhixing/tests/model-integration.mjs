import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, unlink, cp, realpath, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

if (!process.env.DSH_BIN || !process.env.DSH_GATEWAY_PATH) throw new Error('DSH_BIN and DSH_GATEWAY_PATH (prepared compatibility copy) are required');
const root = await mkdtemp(join(tmpdir(), 'zhixing-models-'));
// One native module graph: separate npm peer installs create incompatible Session brands.
let modules = dirname(await realpath(process.env.DSH_BIN));
while (basename(modules) !== 'node_modules' && dirname(modules) !== modules) modules = dirname(modules);
if (basename(modules) !== 'node_modules') throw new Error('Cannot locate the pinned DSH runtime modules');
await symlink(modules, join(root, 'node_modules'), 'dir');
await cp(fileURLToPath(new URL('../../dsh-tg-companion', import.meta.url)), join(root, 'companion'), {
  recursive: true, filter: path => !path.split('/').includes('node_modules'),
});
const home = join(root, 'home'), workspace = join(root, 'workspace'), profile = join(home, 'profiles/web');
await mkdir(workspace); await mkdir(profile, { recursive: true });
const gatewayDir = dirname(dirname(process.env.DSH_GATEWAY_PATH));
await mkdir(join(profile, 'node_modules/@goodandready'), { recursive: true });
await symlink(gatewayDir, join(profile, 'node_modules/@goodandready/dsh-messenger-gateway'), 'dir');
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true,
  dependencies: { '@goodandready/dsh-messenger-gateway': 'link:' + gatewayDir },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@goodandready/dsh-messenger-gateway'] } } }));
const port = async () => { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const value = server.address().port; await new Promise(r => server.close(r)); return value; };
const appPort = await port(), webPort = await port(), token = randomUUID();
const route = model => JSON.stringify(['zhixing-fixture', model]);
const patch = join(root, 'host.patch.json');
const plugin = relative => fileURLToPath(new URL(relative, import.meta.url));
const overrides = [
  { id: 'agent-default-model', config: { provider: 'zhixing-fixture', model: 'fixture' } },
  { id: 'dsh-messenger-gateway', config: { enabled: true, telegram: { enabled: false, allowedUserIds: [123], progressEnabled: false },
    agent: { cwd: workspace, provider: '', model: '', instructionPrefix: 'Channel: Telegram.', sessionScope: 'user', idleTimeoutMs: 3600000 } } },
];
if (process.env.DSH_OPENAI_KEY_FILE) {
  const key = (await readFile(process.env.DSH_OPENAI_KEY_FILE, 'utf8')).trim();
  await writeFile(join(home, '.credentials.yaml'), JSON.stringify({ version: 1, refs: { ZHIXING_OPENAI_API_KEY: key }, records: {} }), { mode: 0o600 });
  overrides.push({ id: 'llm-pi-ai', config: { providers: { openai: { displayName: 'OpenAI', api: 'openai-responses',
    apiKeyEnv: 'ZHIXING_OPENAI_API_KEY', baseURL: 'https://api.openai.com/v1', transport: 'sse', defaultMaxTokens: 128000,
    models: ['gpt-6-luna', 'gpt-6.1-terra'].map(id => ({ id, name: id, input: ['text', 'image'], contextWindow: 1050000,
      reasoningEfforts: { off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } })) } } } });
}
await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify(overrides));
await writeFile(patch, JSON.stringify([{ insert: [
  { id: 'zhixing-fixture', name: plugin('./fixture-model.mjs'), config: { workspace, evidence: join(root, 'model.json') } },
  { id: 'zhixing-app', name: plugin('../index.mjs'), config: { token, port: appPort } },
  { id: 'companion-model-probe', name: join(root, 'companion/tests/model-host.mjs'), config: { token, workspace } },
] }]));
let host, logs = '';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
async function call(path, body, method, probe = false) {
  const res = await fetch(`http://127.0.0.1:${probe ? webPort : appPort}${probe ? '/model-acceptance' : '/v1' + path}`, {
    headers, method: method ?? (body ? 'POST' : 'GET'), body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await res.json(); assert.ok(res.ok, JSON.stringify(result)); return result;
}
const probe = body => call('', body ?? {}, undefined, true);
async function until(read, predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Timed out: ' + label);
}
async function start() {
  logs = '';
  host = spawn(process.env.DSH_BIN, ['web', '--patch', patch, '--no-open', '--port', String(webPort)], { cwd: workspace,
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ZHIXING_DSH_BUSINESS_IMPORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout.on('data', c => { logs += c; }); host.stderr.on('data', c => { logs += c; });
  await until(async () => { if (host.exitCode !== null) throw new Error('Host exited'); try { return await probe(); } catch { return null; } }, s => !!s?.configured, 'host startup');
}
async function stop() { if (host && host.exitCode === null) { host.kill('SIGTERM'); await once(host, 'exit'); } }
async function choose(key, model_id) {
  const view = await call('/settings/models');
  try { return await call('/settings/models', { key, model_id, revision: view[key].revision }, 'PUT'); }
  catch (error) {
    await writeFile(join(root, 'model-settings-failure.json'), JSON.stringify({ settings: await call('/settings/models'), probe: await probe() }, null, 2));
    throw error;
  }
}
const receipt = {};
try {
  await start();
  const first = await probe({ action: 'turn', text: 'MODEL-FIRST' });
  assert.ok(first.current, JSON.stringify(first));
  assert.equal(first.current.model, 'fixture');
  await choose('telegram', route('fixture-other'));
  const configured = await probe();
  assert.equal(configured.connections, first.connections, 'a model edit must not restart Telegram polling');
  const second = await probe({ action: 'turn', text: 'MODEL-SECOND' });
  assert.equal(second.current.model, 'fixture-other');
  assert.equal(JSON.parse(await readFile(join(root, 'model.json'))).model, 'fixture-other');
  assert.equal(second.state.sessionId, first.state.sessionId);
  assert.equal(second.state.memoryId, first.state.memoryId);
  assert.deepEqual(second.recent.slice(0, first.recent.length), first.recent);
  await choose('default', route('fixture-other'));
  await choose('telegram', null);
  await choose('default', route('fixture'));
  const following = await probe({ action: 'turn', text: 'MODEL-FOLLOW' });
  assert.equal(following.current.model, 'fixture');
  await choose('telegram', route('fixture-other'));
  await probe({ action: 'reap' });
  const restored = await probe({ action: 'turn', text: 'MODEL-RESTORE' });
  assert.equal(restored.current.model, 'fixture-other');
  assert.equal(restored.state.sessionId, first.state.sessionId);
  await stop(); await start();
  const restarted = await probe({ action: 'turn', text: 'MODEL-RESTART' });
  assert.equal(restarted.current.model, 'fixture-other');
  assert.equal(restarted.state.sessionId, first.state.sessionId);
  assert.deepEqual(restarted.recent.slice(0, first.recent.length), first.recent);
  receipt.telegram = { actualModels: ['fixture', 'fixture-other', 'fixture', 'fixture-other', 'fixture-other'],
    noGatewayReconnect: true, bindingMemoryAndHistoryPreserved: true, restartPreserved: true, networkDisabled: true };
  console.log('PASS native Telegram config → existing turn, follow-default, idle restoration, restart, retained history, no polling restart');
  const controlChat = await call('/conversations', { title: 'Shared harness' });
  await call(`/conversations/${controlChat.id}/messages`, { id: randomUUID(), content: 'COMPANION-APP-REMOVE' });
  const controlled = await until(() => call(`/conversations/${controlChat.id}/dsh`), s => !s.running && s.events.some(e => e.type === 'turn/end'), 'App contact control');
  assert.ok(controlled.events.some(e => e.type === 'tool/result' && JSON.stringify(e).includes('GitHub')), 'App model really called shared control');
  const read = await probe({ action: 'turn', text: 'COMPANION-TG-READ' });
  assert.deepEqual(read.state.feeds.map(f => f.publisher), ['GitHub']);
  assert.deepEqual(read.state.excludedTopics, ['NASA']);
  assert.ok(JSON.stringify(read.replies).includes('excludedTopics'), 'TG model received the shared saved settings');
  const scheduled = await probe({ action: 'turn', text: 'COMPANION-SCHEDULE' });
  assert.ok(JSON.stringify(scheduled.replies).includes('Updated through native tool') && JSON.stringify(scheduled.replies).includes('deleted'), 'TG can create, update, list and delete native schedules');
  const slow = await call('/conversations', { title: 'Slow model isolation' });
  await call(`/conversations/${slow.id}/messages`, { id: randomUUID(), content: 'SLOW-MODEL' });
  await until(async () => JSON.parse(await readFile(join(root, 'model.json'))), s => s.prompt?.includes('SLOW-MODEL'), 'slow model started');
  const began = Date.now();
  await call('/status');
  await probe({ action: 'turn', text: 'COMPANION-TG-READ' });
  assert.ok(Date.now() - began < 5000, 'slow App model must not block TG or host HTTP');
  await until(() => call(`/conversations/${slow.id}/dsh`), s => !s.running, 'slow model settled');
  const timedOut = await probe({ action: 'timeout' });
  assert.equal(timedOut.running, false);
  assert.equal(timedOut.turnActive, false);
  assert.equal(timedOut.lastEnd.reason.kind, 'aborted');
  assert.ok(JSON.stringify(timedOut.replies).includes('回复超时'), 'the failed turn has a visible receipt');
  const recovered = await probe({ action: 'turn', text: 'COMPANION-TG-READ' });
  assert.equal(recovered.lastEnd.reason.kind, 'completed');
  const steered = await probe({ action: 'steer' });
  assert.equal(steered.lastInbox.target, 'next-step', 'busy Telegram additions use native steering');
  await stop(); await start();
  assert.deepEqual((await probe({ action: 'turn', text: 'COMPANION-TG-READ' })).state.excludedTopics, ['NASA']);
  receipt.harness = { appAndTelegramSharedPreferences: true, nativeScheduleCrud: true, concurrentSlowModel: true, restartPreserved: true,
    timeoutCancelledUnderlyingTurn: true, nextTurnRecovered: true, nativeSteering: true };
  console.log('PASS native App → shared contact preferences → TG read, schedule CRUD, concurrent slow model, restart');
  if (process.env.DSH_OPENAI_KEY_FILE) {
    receipt.openai = [];
    const catalog = await call('/models');
    for (const model of ['gpt-6-luna', 'gpt-6.1-terra']) {
      const id = JSON.stringify(['openai', model]);
      assert.equal(catalog.items.find(m => m.id === id)?.protocol, 'responses');
      assert.equal(catalog.items.find(m => m.id === id)?.ready, true);
      const chat = await call('/conversations', { title: `Isolated ${model}`, model_id: id, reasoning_effort: 'off' });
      await call(`/conversations/${chat.id}/messages`, { id: randomUUID(), content: '请调用 bash 执行 printf MODEL_TOOL_OK，然后只回复命令输出。' });
      const result = await until(() => call(`/conversations/${chat.id}/dsh`), s => !s.running && s.events.some(e => e.type === 'turn/end'), model, 180000);
      const tools = result.events.filter(e => e.type === 'tool/result');
      assert.ok(tools.length > 0 && tools.some(e => !e.data.message?.isError && JSON.stringify(e).includes('MODEL_TOOL_OK')), model + ' native tool result');
      const text = result.events.filter(e => e.type === 'assistant/message').flatMap(e => (e.data.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text)).join('\n');
      assert.ok(text.includes('MODEL_TOOL_OK'), model + ' final response');
      receipt.openai.push({ model, protocol: 'responses', nativeToolRoundTrip: true, text });
      console.log(`PASS ${model}: Responses → native bash → tool result → final reply`);
      if (model === 'gpt-6-luna') {
        await probe({ action: 'reset-preferences' });
        const contact = await call('/conversations', { title: 'Real shared contact control', model_id: id, reasoning_effort: 'off' });
        await call(`/conversations/${contact.id}/messages`, { id: randomUUID(), content: '把 TG 机器人主动新闻里的 NASA 删除，我不看 NASA。请保存修改，再简短告诉我结果。' });
        const saved = await until(() => call(`/conversations/${contact.id}/dsh`), s => !s.running && s.events.some(e => e.type === 'turn/end'), 'Luna shared contact control', 180000);
        const state = (await probe()).state;
        assert.ok(state.feeds && !state.feeds.some(f => /nasa/i.test(f.publisher + f.url)), 'real model persisted NASA removal');
        assert.ok(saved.events.some(e => e.type === 'tool/call' && JSON.stringify(e).includes('companion_contact')), 'real model discovered shared control');
        receipt.harness.realLunaContactControl = true;
        console.log('PASS real Luna: natural App request → shared contact tool → NASA removed');
      }
    }
  }
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log('Evidence: ' + root);
} catch (error) {
  // The isolated profile contains no Telegram credentials; protect even its local auth token.
  await writeFile(join(root, 'host-error.log'), logs.replaceAll(token, '[redacted]'), { mode: 0o600 });
  console.error('Failure evidence: ' + root);
  throw error;
} finally {
  await stop();
  if (process.env.DSH_OPENAI_KEY_FILE) await unlink(join(home, '.credentials.yaml')).catch(() => {});
}
