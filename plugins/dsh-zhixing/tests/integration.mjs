// Run against an installed, pinned DSH CLI: DSH_BIN=/absolute/dsh npm run test:dsh:integration
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Buffer } from 'node:buffer';

if (!process.env.DSH_BIN) throw new Error('Set DSH_BIN to the installed @deepseek-ai/dsh@0.2.2-alpha.2 executable.');
const root = await mkdtemp(join(tmpdir(), 'zhixing-dsh-'));
const workspace = join(root, 'workspace'); await mkdir(workspace);
await writeFile(join(workspace, 'sample.js'), 'export const answer = 0;\n');
const token = randomUUID();
const port = async () => { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const appPort = await port(), webPort = await port();
const patch = join(root, 'fixture.patch.yml');
await writeFile(patch, `- id: agent-default-model
  config:
    provider: zhixing-fixture
    model: fixture
- insert:
    - id: zhixing-fixture
      name: ${JSON.stringify(fileURLToPath(new URL('./fixture-model.mjs', import.meta.url)))}
      config:
        workspace: ${JSON.stringify(workspace)}
        evidence: ${JSON.stringify(join(root, 'model.json'))}
    - id: zhixing-app
      name: ${JSON.stringify(fileURLToPath(new URL('../index.mjs', import.meta.url)))}
      config:
        token: ${JSON.stringify(token)}
        port: ${appPort}
${process.env.ZHIXING_TEST_BUSINESS_URL ? `        businessUrl: ${JSON.stringify(process.env.ZHIXING_TEST_BUSINESS_URL)}\n        businessToken: ${JSON.stringify(process.env.ZHIXING_TEST_BUSINESS_TOKEN)}\n` : ''}`);
let host;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
async function api(path, body, method) {
  const r = await fetch(`http://127.0.0.1:${appPort}/v1${path}`, { method: method ?? (body ? 'POST' : 'GET'), headers,
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json(); assert.ok(r.ok, JSON.stringify(data)); return data;
}
async function until(read, predicate, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await read(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
async function start() {
  host = spawn(process.env.DSH_BIN, ['web', '--patch', patch, '--no-open', '--port', String(webPort)], {
    cwd: workspace, env: { ...process.env, DSH_HOME: join(root, 'home'), DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  host.stdout.on('data', chunk => { logs += chunk.toString().replace(/token=[^\s]+/g, 'token=[redacted]'); });
  host.stderr.on('data', chunk => { logs += chunk; });
  await until(async () => {
    if (host.exitCode !== null) throw new Error(`DSH exited: ${logs}`);
    try { return await api('/status'); } catch { return null; }
  }, s => s?.model_ready, 'DSH startup');
}
async function stop() { if (host && host.exitCode === null) { host.kill('SIGTERM'); await once(host, 'exit'); } }
try {
  await start();
  const chat = await api('/conversations', { title: 'Native DSH acceptance' });
  const path = `/conversations/${chat.id}`;
  const snapshot = () => api(`${path}/dsh`);
  await api(`${path}/messages`, { id: 'read-write-check', content: 'READ-WRITE-CHECK' });
  let state = await until(snapshot, s => !s.running && s.events.some(e => e.type === 'turn/end'), 'code loop');
  assert.equal(await readFile(join(workspace, 'sample.js'), 'utf8'), 'export const answer = 42;\n');
  const toolResults = state.events.filter(e => e.type === 'tool/result');
  assert.equal(toolResults.length, 3); assert.ok(toolResults.every(e => !e.data.message.isError));
  assert.match(JSON.stringify(toolResults), /CHECK_PASSED/);
  const model = JSON.parse(await readFile(join(root, 'model.json')));
  for (const tool of ['bash', 'write', 'read', 'subagent', 'plugin_manager', 'schedule_create']) assert.ok(model.tools.includes(tool), tool);
  await writeFile(join(root, 'code-loop.json'), JSON.stringify(state, null, 2));
  console.log('PASS native read → write → shell check, host tools retained');
  await api(`${path}/messages`, { id: 'ask', content: 'ASK-QUESTION' });
  state = await until(snapshot, s => s.pending.length > 0, 'question');
  await api(`${path}/dsh/answers/${state.pending[0].id}`, { answers: [{ id: 'choice', selected: ['Proceed'] }] });
  await until(snapshot, s => !s.running, 'question answer');
  console.log('PASS native question answer');
  await api(`${path}/messages`, { id: 'cancel', content: 'CANCEL-SHELL' });
  const pid = await until(async () => { try { return Number(await readFile(join(workspace, 'running.pid'), 'utf8')); } catch { return null; } }, Boolean, 'real shell start');
  await api(`${path}/dsh/cancel`, {});
  assert.throws(() => process.kill(pid, 0));
  state = await snapshot(); assert.equal(state.running, false);
  assert.equal(state.events.filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'aborted');
  console.log('PASS cancellation waits for actual shell exit');
  const count = state.events.filter(e => e.type === 'user/message' && e.data.source?.rpcId === 'read-write-check').length;
  await stop(); await start();
  state = await snapshot(); assert.equal(state.active, false);
  await api(`${path}/messages`, { id: 'read-write-check', content: 'READ-WRITE-CHECK' });
  state = await snapshot();
  assert.equal(state.events.filter(e => e.type === 'user/message' && e.data.source?.rpcId === 'read-write-check').length, count);
  await api(`${path}/messages`, { id: 'resume', content: 'RESUME-CHECK' });
  state = await until(snapshot, s => !s.running && s.events.some(e => e.type === 'assistant/message' && JSON.stringify(e.data.message).includes('RESUME-CHECK')), 'resumed reply');
  assert.ok(state.events.some(e => e.type === 'tool/result' && JSON.stringify(e).includes('CHECK_PASSED')));
  console.log('PASS restart replay, durable duplicate retry and continued conversation');
  // File receipt admission is owned by the native attachment service.
  const upload = await fetch(`http://127.0.0.1:${appPort}/v1${path}/dsh/files?name=note.txt`, {
    method: 'PUT', headers: { Authorization: headers.Authorization, 'Content-Type': 'application/octet-stream' }, body: 'attachment acceptance',
  });
  assert.ok(upload.ok, await upload.clone().text());
  const receipt = await upload.json();
  await api(`${path}/messages`, { id: 'attachment', parts: [{ type: 'text', text: 'RESUME-CHECK with file' }, { type: 'file', receiptId: receipt.receiptId }] });
  await until(snapshot, s => !s.running, 'attachment reply'); console.log('PASS native attachment upload and prompt');
  const image = await fetch(`http://127.0.0.1:${appPort}/v1${path}/dsh/files?name=pixel.png&mediaType=image%2Fpng`, {
    method: 'PUT', headers: { Authorization: headers.Authorization, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64'),
  });
  assert.ok(image.ok, await image.clone().text());
  const imageReceipt = await image.json();
  await api(`${path}/messages`, { id: 'image', parts: [{ type: 'text', text: 'RESUME-CHECK with image' }, { type: 'file', receiptId: imageReceipt.receiptId }] });
  await until(snapshot, s => !s.running, 'image reply'); console.log('PASS native image upload and prompt');
  if (process.env.ZHIXING_TEST_BUSINESS_URL) {
    const schema = await api('/business/schema'); assert.ok(schema.paths['/v1/finance/summary']);
    const summary = await api('/finance/summary'); assert.ok(summary);
    await api(`${path}/messages`, { id: 'business', content: 'BUSINESS-SCHEMA' });
    state = await until(snapshot, s => !s.running, 'business tool');
    assert.ok(state.events.some(e => e.type === 'tool/result' && !e.data.message.isError && JSON.stringify(e).includes('知行业务数据')));
    console.log('PASS actual Python business API and DSH business tool');
  }
  await writeFile(join(root, 'final-events.json'), JSON.stringify(await snapshot(), null, 2));
  console.log(`Evidence: ${root}`);
} finally { await stop(); }
