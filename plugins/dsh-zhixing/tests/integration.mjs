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
async function rejected(path, body, status, method = 'POST') {
  const response = await fetch(`http://127.0.0.1:${appPort}/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal(response.status, status, await response.text());
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
  }, s => s?.model_ready, 'DSH startup').catch(e => { throw new Error(`${e.message}\n${logs}`); });
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
  await api(`${path}/messages`, { id: 'queued-message', content: 'QUEUE-MUST-NOT-RUN', intent: 'queue' });
  state = await snapshot();
  const queued = state.queue.find(item => item.rpcId === 'queued-message');
  assert.ok(queued); assert.equal(queued.placement, 'queued');
  await api(`${path}/dsh/queue/${queued.id}`, { kind: 'steer' });
  assert.equal((await snapshot()).queue.find(item => item.id === queued.id)?.placement, 'steering');
  await api(`${path}/dsh/queue/${queued.id}`, { kind: 'remove' });
  assert.equal((await snapshot()).queue.some(item => item.id === queued.id), false);
  console.log('PASS native queue inspection, steering and withdrawal');
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
  state = await until(snapshot, s => !s.running, 'attachment reply');
  const fileRef = state.events.find(e => e.type === 'user/message' && e.data.source?.rpcId === 'attachment').data.content.find(b => b.type === 'file').attachment;
  const fileUrl = `http://127.0.0.1:${appPort}/v1${path}/dsh/files/${encodeURIComponent(fileRef.attachmentId)}`;
  const fileDownload = await fetch(fileUrl, { headers }); assert.ok(fileDownload.ok); assert.equal(await fileDownload.text(), 'attachment acceptance');
  const filePreview = await (await fetch(`${fileUrl}/text`, { headers })).json(); assert.equal(filePreview.content, 'attachment acceptance'); assert.equal(filePreview.truncated, false);
  const renamed = await api(`${path}/title`, { title: '知行代码验收' }, 'PUT'); assert.equal(renamed.title, '知行代码验收');
  const hits = await api('/conversations/search?q=READ-WRITE-CHECK');
  const hit = hits.items.find(item => item.conversation_id === chat.id);
  assert.ok(hit && hit.message_seq != null);
  assert.equal(state.events.find(e => e.seq === hit.message_seq)?.data.source?.rpcId, 'read-write-check');
  console.log('PASS native file download/preview, rename and exact message search');
  const image = await fetch(`http://127.0.0.1:${appPort}/v1${path}/dsh/files?name=pixel.png&mediaType=image%2Fpng`, {
    method: 'PUT', headers: { Authorization: headers.Authorization, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64'),
  });
  assert.ok(image.ok, await image.clone().text());
  const imageReceipt = await image.json();
  await api(`${path}/messages`, { id: 'image', parts: [{ type: 'text', text: 'RESUME-CHECK with image' }, { type: 'file', receiptId: imageReceipt.receiptId }] });
  state = await until(snapshot, s => !s.running, 'image reply');
  const imageMessage = state.events.find(e => e.type === 'user/message' && e.data.source?.rpcId === 'image');
  const imageRef = imageMessage.data.content.find(block => block.type === 'image').attachment;
  const imageResponse = await fetch(`http://127.0.0.1:${appPort}/v1${path}/dsh/images/${imageRef.attachmentId}`, { headers });
  assert.ok(imageResponse.ok); assert.equal(imageResponse.headers.get('content-type'), 'image/png');
  assert.equal((await imageResponse.arrayBuffer()).byteLength, imageRef.bytes);
  await api(`${path}/messages`, { id: 'image', parts: [{ type: 'file', receiptId: imageReceipt.receiptId }] });
  assert.equal((await snapshot()).events.filter(e => e.type === 'user/message' && e.data.source?.rpcId === 'image').length, 1);
  console.log('PASS native image upload, authenticated preview and receipt retry');
  // Historical edits create real native histories; original user text and later turns stay in the old version.
  const revisionChat = await api('/conversations', { title: 'Revision acceptance' });
  const rp = `/conversations/${revisionChat.id}`;
  const revisions = () => api(`${rp}/dsh`);
  await api(`${rp}/messages`, { id: 'window', content: 'QUEUE-WINDOW' });
  await until(revisions, s => s.running && s.events.some(e => e.type === 'tool/call'), 'queue window');
  await rejected(`${rp}/dsh/revisions`, { id: 'busy-edit', kind: 'edit', version: revisionChat.id, seq: 1, text: 'blocked', attachments: [] }, 409);
  await api(`${rp}/messages`, { id: 'original', content: 'VERSION-ORIGINAL' });
  await api(`${rp}/messages`, { id: 'later', content: 'LATER-SHOULD-DISAPPEAR' });
  let revisionState = await until(revisions, s => !s.running && !s.queue.length && s.events.some(e => e.type === 'user/message' && e.data.source?.rpcId === 'later'), 'queued originals');
  const originalSeq = revisionState.events.find(e => e.type === 'user/message' && e.data.source?.rpcId === 'original').seq;
  const edit = { id: 'edit-first', kind: 'edit', version: revisionChat.id, seq: originalSeq, text: 'VERSION-EDITED', attachments: [] };
  const edited = await api(`${rp}/dsh/revisions`, edit);
  assert.notEqual(edited.active, revisionChat.id); assert.equal(edited.versions.length, 2);
  revisionState = await until(revisions, s => !s.running && s.events.some(e => e.type === 'user/message' && e.data.source?.rpcId === edit.id), 'edited reply');
  assert.equal(revisionState.events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'user').some(e => JSON.stringify(e.data.content).includes('LATER-SHOULD-DISAPPEAR')), false);
  let observed = JSON.parse(await readFile(join(root, 'model.json')));
  assert.ok(observed.userTexts.some(t => t === 'VERSION-EDITED'));
  assert.equal(observed.userTexts.some(t => /VERSION-ORIGINAL|LATER-SHOULD-DISAPPEAR/.test(t)), false);
  await api(`${rp}/dsh/revisions`, edit);
  assert.equal((await revisions()).history.versions.length, 2);
  const answer = revisionState.events.findLast(e => e.type === 'assistant/message');
  const retry = { id: 'retry-first', kind: 'retry', version: edited.active, seq: answer.seq };
  const regenerated = await api(`${rp}/dsh/revisions`, retry);
  revisionState = await until(revisions, s => !s.running && s.events.some(e => e.type === 'user/message' && e.data.source?.rpcId === retry.id), 'regenerated reply');
  assert.notEqual(revisionState.events.findLast(e => e.type === 'assistant/message').data.message.id, answer.data.message.id);
  assert.equal(regenerated.versions.length, 3);
  await rejected(`${rp}/dsh/revisions`, { ...edit, id: 'stale-edit' }, 409);
  await rejected(`${rp}/dsh/version`, { expected: regenerated.active, version: chat.id }, 404, 'PUT');
  await stop(); await start();
  assert.equal((await revisions()).history.active, regenerated.active);
  await api(`${rp}/dsh/revisions`, retry); // Durable lost-ACK retry after host restart.
  assert.equal((await revisions()).history.versions.length, 3);
  await api(`${rp}/dsh/version`, { expected: regenerated.active, version: revisionChat.id }, 'PUT');
  const old = await revisions();
  assert.ok(old.events.some(e => e.type === 'user/message' && e.seq === originalSeq && JSON.stringify(e.data.content).includes('VERSION-ORIGINAL')));
  assert.ok(old.events.some(e => e.type === 'user/message' && e.data.source?.rpcId === 'later'));
  await api(`${rp}/dsh/version`, { expected: revisionChat.id, version: edited.active }, 'PUT');
  assert.equal((await api(`${rp}/dsh?offset=999&version=${revisionChat.id}`)).events[0].seq, 0);
  console.log('PASS real edited/regenerated histories, queued-tail exclusion, durable retry and version switching');

  // Preserve native attachments when editing the actual user message.
  const uploadedUser = state.events.find(e => e.type === 'user/message' && e.data.source?.rpcId === 'attachment');
  const fileEdit = await api(`${path}/dsh/revisions`, { id: 'edit-file', kind: 'edit', version: chat.id, seq: uploadedUser.seq,
    text: 'RESUME-CHECK edited attachment', attachments: [fileRef.attachmentId] });
  const withFile = await until(snapshot, s => !s.running && s.events.some(e => e.type === 'user/message' && e.data.source?.rpcId === 'edit-file'), 'attachment edit');
  const retained = withFile.events.find(e => e.type === 'user/message' && e.data.source?.rpcId === 'edit-file').data.content.find(b => b.type === 'file').attachment;
  assert.equal(retained.attachmentId, fileRef.attachmentId);
  await api(`${path}/dsh/version`, { expected: fileEdit.active, version: chat.id }, 'PUT');
  const imageEdit = await api(`${path}/dsh/revisions`, { id: 'edit-image', kind: 'edit', version: chat.id, seq: imageMessage.seq,
    text: 'RESUME-CHECK edited image', attachments: [imageRef.attachmentId] });
  const withImage = await until(snapshot, s => !s.running && s.events.some(e => e.type === 'user/message' && e.data.source?.rpcId === 'edit-image'), 'image edit');
  assert.equal(withImage.events.find(e => e.type === 'user/message' && e.data.source?.rpcId === 'edit-image').data.content.find(b => b.type === 'image').attachment.attachmentId, imageRef.attachmentId);
  await api(`${path}/dsh/version`, { expected: imageEdit.active, version: chat.id }, 'PUT');

  // Both user-triggered publication and model-triggered publication freeze exact real bytes.
  const writeCall = (await snapshot()).events.find(e => e.type === 'tool/call' && e.data.name === 'write');
  const artifact = await api(`${path}/dsh/artifacts`, { id: 'publish-once', seq: writeCall.seq, version: chat.id });
  const publishedRef = artifact.content[0].attachment;
  await writeFile(join(workspace, 'sample.js'), 'changed after publication\n');
  await stop(); await start();
  const duplicateArtifact = await api(`${path}/dsh/artifacts`, { id: 'publish-once', seq: writeCall.seq, version: chat.id });
  assert.equal(duplicateArtifact.content[0].attachment.attachmentId, publishedRef.attachmentId);
  const artifactBytes = await (await fetch(`http://127.0.0.1:${appPort}/v1${path}/dsh/files/${encodeURIComponent(publishedRef.attachmentId)}`, { headers })).text();
  assert.equal(artifactBytes, 'export const answer = 42;\n');
  assert.equal((await snapshot()).artifacts[0].content[0].attachment.attachmentId, publishedRef.attachmentId);
  await rejected(`${rp}/dsh/files/${encodeURIComponent(publishedRef.attachmentId)}`, undefined, 404, 'GET');
  const inherited = await api(`${path}/dsh/revisions`, { id: 'edit-with-published-file', kind: 'edit', version: chat.id, seq: uploadedUser.seq,
    text: 'RESUME-CHECK inherit earlier publication', attachments: [] });
  const inheritedState = await until(snapshot, s => !s.running && s.events.some(e => e.type === 'user/message' && e.data.source?.rpcId === 'edit-with-published-file'), 'inherited publication');
  assert.equal(inheritedState.artifacts[0].content[0].attachment.attachmentId, publishedRef.attachmentId);
  await api(`${path}/dsh/version`, { expected: inherited.active, version: chat.id }, 'PUT');
  await api(`${path}/messages`, { id: 'publish-model', content: 'PUBLISH-CHECK' });
  const publishedState = await until(snapshot, s => !s.running && s.events.some(e => e.type === 'user/message' && e.data.source?.rpcId === 'publish-model'), 'model publishes file');
  const publishResult = publishedState.events.findLast(e => e.type === 'tool/result');
  assert.ok(!publishResult.data.message.isError, JSON.stringify(publishResult));
  const declaration = publishedState.events.findLast(e => e.type === 'deliverables/presented');
  assert.ok(declaration, 'native present must append its own durable declaration');
  const deliveryPath = `${path}/dsh/deliveries/${declaration.seq}/0`;
  const download = () => fetch(`http://127.0.0.1:${appPort}/v1${deliveryPath}`, { headers }).then(r => r.text());
  assert.equal(await download(), 'changed after publication\n');
  assert.equal((await api(`${deliveryPath}/text`)).content, 'changed after publication');
  await writeFile(join(workspace, 'sample.js'), 'native current file\n');
  await stop(); await start();
  assert.equal(await download(), 'native current file\n', 'native present opens current source bytes after restart');
  await rejected(`${rp}/dsh/deliveries/${declaration.seq}/0`, undefined, 404, 'GET');
  await rejected(`${deliveryPath}?version=${"foreign-session"}`, undefined, 404, 'GET');
  console.log('PASS native present, source file preview/download, restart and conversation ownership');
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
