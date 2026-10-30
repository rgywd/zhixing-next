// Run against an installed, pinned DSH CLI: DSH_BIN=/absolute/dsh npm run test:dsh:integration
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
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
`);
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
  const selectedModel = JSON.stringify(['zhixing-fixture', 'fixture-other']);
  const chat = await api('/conversations', { title: 'Native DSH acceptance', model_id: selectedModel });
  assert.equal(chat.model_id, selectedModel, 'creation honors the selected native model');
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
  const originalMetrics = structuredClone(state.statistics);
  assert.equal(originalMetrics.length, 1);
  const nativeStats = JSON.parse((await readFile(join(root, 'model.json.stats.jsonl'), 'utf8')).trim().split('\n').at(-1));
  assert.deepEqual(originalMetrics[0].stats, nativeStats.values.sessionStats);
  assert.deepEqual(originalMetrics[0].usage, nativeStats.values.tokenUsage);
  assert.deepEqual(state.context, { pressure: nativeStats.values.contextPressure, breakdown: nativeStats.values.contextBreakdown });
  assert.equal(state.context.pressure.contextWindow, 128000);
  assert.ok(state.context.pressure.projectedTokens > 0);
  assert.equal(originalMetrics[0].stats.steps, 4);
  assert.ok(originalMetrics[0].stats.toolMs > 0); assert.ok(originalMetrics[0].stats.ttftMs > 0);
  assert.equal(originalMetrics[0].usage.outputTokens, 160);
  const partial = await api(`${path}/dsh?offset=${originalMetrics[0].seq}`);
  assert.deepEqual(partial.statistics, originalMetrics, 'a tail-only page retains whole-log native totals');
  console.log('PASS exact native end-of-turn statistics, usage, context, and tail paging');

  const compactChat = await api('/conversations', { title: 'Compaction acceptance' });
  const cp = `/conversations/${compactChat.id}`;
  const compactSnapshot = () => api(`${cp}/dsh`);
  assert.deepEqual(await api(`${cp}/dsh/compact`, { version: compactChat.id }), { completed: true, compacted: false });
  for (let i = 0; i < 3; i++) {
    await api(`${cp}/messages`, { id: `history-${i}`, content: `CONTEXT-HISTORY-${i} ` + 'earlier acceptance context '.repeat(500) });
    await until(compactSnapshot, value => !value.running && value.statistics?.length === i + 1, 'compaction history');
  }
  const beforeCompact = await compactSnapshot();
  await rejected(`${cp}/dsh/compact`, { version: chat.id }, 409);
  const compact = api(`${cp}/dsh/compact`, { version: compactChat.id });
  await until(compactSnapshot, value => value.compaction.running && value.events.some(e => e.type === 'compaction/start'), 'manual compaction started');
  await rejected(`${cp}/dsh/compact`, { version: compactChat.id }, 409);
  await rejected(`${cp}/dsh/revisions`, { id: 'compact-revision', kind: 'retry', version: compactChat.id, seq: beforeCompact.events.find(e => e.type === 'assistant/message').seq }, 409);
  await api(`${cp}/messages`, { id: 'during-compact-a', content: 'AFTER-COMPACT-A', intent: 'steer' });
  await api(`${cp}/messages`, { id: 'during-compact-b', content: 'AFTER-COMPACT-B', intent: 'queue' });
  const duringCompact = await compactSnapshot();
  assert.equal(duringCompact.compaction.running, true, 'input admission does not wait for summary completion');
  assert.ok(duringCompact.queue.length > 0);
  assert.deepEqual(duringCompact.statistics, beforeCompact.statistics, 'in-progress work cannot change old snapshots');
  assert.equal((await compact).compacted, true);
  const afterCompact = await until(compactSnapshot, value => !value.running && !value.queue.length && value.events.some(e => e.type === 'user/message' && e.data.source?.rpcId === 'during-compact-b'), 'queued prompts after compaction');
  assert.ok(afterCompact.events.some(e => e.type === 'compaction/summary'));
  const compactEnd = afterCompact.events.find(e => e.type === 'compaction/end');
  assert.equal(compactEnd.data.error, undefined);
  for (const request of ['during-compact-a', 'during-compact-b']) {
    const messages = afterCompact.events.filter(e => e.type === 'user/message' && e.data.source?.rpcId === request);
    assert.equal(messages.length, 1); assert.ok(messages[0].seq > compactEnd.seq);
  }
  assert.deepEqual(afterCompact.statistics.slice(0, 3), beforeCompact.statistics);
  await writeFile(join(root, 'compaction.json'), JSON.stringify({ before: beforeCompact, during: duringCompact, after: afterCompact }, null, 2));
  console.log('PASS native compaction, real summary commit, input admission/steering/queue, version guards, frozen snapshots');
  const cancelCompact = fetch(`http://127.0.0.1:${appPort}/v1${cp}/dsh/compact`, { method: 'POST', headers, body: JSON.stringify({ version: compactChat.id }) });
  await until(compactSnapshot, value => value.compaction.running, 'cancel compaction start');
  await api(`${cp}/dsh/cancel`, {});
  assert.equal((await cancelCompact).status, 409);
  const cancelledCompact = await compactSnapshot();
  assert.equal(cancelledCompact.compaction.running, false);
  assert.ok(cancelledCompact.events.filter(e => e.type === 'compaction/end').at(-1).data.error);
  console.log('PASS native manual compaction cancellation waits for its terminal receipt');
  const failureChat = await api('/conversations', { title: 'Compaction failure acceptance' });
  const fp = `/conversations/${failureChat.id}`;
  for (let i = 0; i < 2; i++) {
    await api(`${fp}/messages`, { id: `failure-${i}`, content: 'COMPACT-SUMMARY-FAIL ' + 'preserve this history '.repeat(200) });
    await until(() => api(`${fp}/dsh`), value => !value.running && value.statistics.length === i + 1, 'failure history');
  }
  const beforeFailure = await api(`${fp}/dsh`);
  await rejected(`${fp}/dsh/compact`, { version: failureChat.id }, 409);
  const failedCompaction = await api(`${fp}/dsh`);
  assert.equal(failedCompaction.compaction.running, false);
  assert.ok(failedCompaction.events.filter(e => e.type === 'compaction/end').at(-1).data.error);
  assert.equal(failedCompaction.events.some(e => e.type === 'compaction/summary'), false);
  assert.deepEqual(failedCompaction.statistics, beforeFailure.statistics);
  assert.deepEqual(failedCompaction.context, beforeFailure.context);
  await api(`${fp}/messages`, { id: 'after-failure', content: 'Continue after summary failure' });
  await until(() => api(`${fp}/dsh`), value => !value.running && value.statistics.length === 3, 'continue after summary failure');
  console.log('PASS summary failure preserves history, statistics, context, and subsequent conversation');

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
  assert.deepEqual(state.statistics[0], originalMetrics[0], 'native snapshots survive host restart');
  assert.deepEqual((await compactSnapshot()).statistics.slice(0, 3), beforeCompact.statistics);
  assert.equal((await api(path)).model_id, selectedModel, 'native model selection survives host restart');
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
  assert.deepEqual((await revisions()).history.versions, regenerated.versions, 'native storage preserves message positions and version groups across restart');
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

  // Deliveries are native present declarations, with host access checks on each read.
  await rejected(`${path}/dsh/artifacts`, { id: 'obsolete', seq: 0, version: chat.id }, 404);
  await api(`${path}/messages`, { id: 'publish-model', content: 'PUBLISH-CHECK' });
  const publishedState = await until(snapshot, s => !s.running && s.events.some(e => e.type === 'user/message' && e.data.source?.rpcId === 'publish-model'), 'model publishes file');
  const publishResult = publishedState.events.findLast(e => e.type === 'tool/result');
  assert.ok(!publishResult.data.message.isError, JSON.stringify(publishResult));
  const declaration = publishedState.events.findLast(e => e.type === 'deliverables/presented');
  assert.ok(declaration, 'native present must append its own durable declaration');
  const deliveryPath = `${path}/dsh/deliveries/${declaration.seq}/0`;
  const download = () => fetch(`http://127.0.0.1:${appPort}/v1${deliveryPath}`, { headers }).then(r => r.text());
  assert.equal(await download(), 'export const answer = 42;\n');
  assert.equal((await api(`${deliveryPath}/text`)).content, 'export const answer = 42;');
  await writeFile(join(workspace, 'sample.js'), 'native current file\n');
  await stop(); await start();
  assert.equal(await download(), 'native current file\n', 'native present opens current source bytes after restart');
  await rejected(`${rp}/dsh/deliveries/${declaration.seq}/0`, undefined, 404, 'GET');
  await rejected(`${deliveryPath}?version=${"foreign-session"}`, undefined, 404, 'GET');
  console.log('PASS native present, source file preview/download, restart and conversation ownership');
  const schema = await api('/business/schema?domain=finance'); assert.ok(schema.schemas.TransactionInput);
  const meal = { source_id: 'native-source', entry_key: 'lunch', conversation_id: chat.id,
    meal: { occurred_at: '2026-10-29T12:30:00+08:00', description: '鸡肉饭' }, amount: '28', occurred_on: '2026-10-29' };
  const saved = await api('/life/meals', meal);
  assert.equal(saved.finance.amount, '28.00'); assert.equal(saved.meal.description, '鸡肉饭');
  await stop(); await start();
  assert.deepEqual(await api('/life/meals', meal), saved);
  assert.equal((await api('/finance/summary?month=2026-10')).totals.expense, '28.00');
  assert.equal((await api('/health/summary?date=2026-10-29')).meals.length, 1);
  await rejected('/life/meals', { ...meal, entry_key: 'invalid', meal: { ...meal.meal, description: '' } }, 422);
  assert.equal((await api('/finance/transactions?month=2026-10')).total, 1);
  await api(`${path}/messages`, { id: 'business', content: 'BUSINESS-SCHEMA' });
  state = await until(snapshot, s => !s.running && s.events.some(e => e.type === 'user/message' && e.data.source?.rpcId === 'business'), 'native business tool');
  assert.ok(state.events.some(e => e.type === 'tool/call' && e.data.name === 'zhixing_service'));
  const result = state.events.findLast(e => e.type === 'tool/result');
  assert.ok(!result.data.message.isError && JSON.stringify(result).includes('schemas'));
  for (const retired of ['/resources', '/memories', '/search-providers']) await rejected(retired, undefined, 404, 'GET');
  console.log('PASS native DSH business storage, restart replay, atomic rollback and model tool; no Python service');
  const untitled = await api('/conversations', { title: '新的对话' });
  await api(`/conversations/${untitled.id}/messages`, { id: 'native-title', content: 'UPLOAD-TITLE-CHECK' });
  await until(() => api(`/conversations/${untitled.id}`), c => c.title && c.title !== '新的对话', 'native title after upload-first placeholder');
  console.log('PASS native title generation after an upload-first conversation');

  const permissionModes = ['read-only', 'workspace-write', 'danger-full-access'];
  assert.deepEqual((await api('/status')).permissions.options, permissionModes);
  await rejected('/conversations', { permission: 'invented' }, 400);
  const restricted = await api('/conversations', { permission: 'read-only' });
  const pp = `/conversations/${restricted.id}`;
  const permissionState = () => api(`${pp}/dsh`);
  const choosePermission = async permission => api(`${pp}/dsh/permissions`, { permission,
    version: (await permissionState()).history.active }, 'PUT');
  const permissionRun = async (id, content) => {
    await api(`${pp}/messages`, { id, content });
    return until(permissionState, s => !s.running && s.events.some(e => e.type === 'user/message' && e.data.source?.rpcId === id), id);
  };
  const permissionFile = join(workspace, 'permission.txt'), escalationFile = join(workspace, 'escalation.txt');
  await writeFile(permissionFile, 'unchanged');
  assert.equal((await permissionState()).permissions.current, 'read-only');
  const denied = await permissionRun('read-only-write', 'PERMISSION-WRITE');
  assert.equal(denied.events.findLast(e => e.type === 'tool/result').data.message.isError, true);
  assert.match(JSON.stringify(denied.events.findLast(e => e.type === 'tool/result')), /read-only|sandbox|permission/i);
  assert.equal(await readFile(permissionFile, 'utf8'), 'unchanged');
  await choosePermission('workspace-write');
  const written = await permissionRun('workspace-write', 'PERMISSION-WRITE');
  assert.ok(!written.events.findLast(e => e.type === 'tool/result').data.message.isError);
  assert.equal(await readFile(permissionFile, 'utf8'), 'permission write executed\n');
  for (const outcome of ['rejected', 'allowed-once', 'cancelled']) {
    await rm(escalationFile, { force: true });
    const requestId = `escalation-${outcome}`;
    await api(`${pp}/messages`, { id: requestId, content: 'PERMISSION-ESCALATE' });
    const pending = await until(permissionState, s => s.pending.some(p => p.kind === 'approval'), 'native approval');
    await assert.rejects(readFile(escalationFile), { code: 'ENOENT' });
    if (outcome === 'cancelled') await api(`${pp}/dsh/cancel`, {});
    else await api(`${pp}/dsh/answers/${pending.pending[0].id}`, { outcome });
    const settled = await until(permissionState, s => !s.running && !s.pending.length, 'approval settlement');
    assert.ok(settled.events.some(e => e.type === 'approval/decided' && e.data.outcome === outcome));
    if (outcome === 'allowed-once') assert.equal(await readFile(escalationFile, 'utf8'), 'approved');
    else await assert.rejects(readFile(escalationFile), { code: 'ENOENT' });
  }
  await choosePermission('danger-full-access');
  const full = await permissionRun('full-access', 'PERMISSION-ESCALATE');
  assert.equal(full.pending.length, 0); assert.equal(await readFile(escalationFile, 'utf8'), 'approved');
  assert.equal(full.events.findLast(e => e.type === 'approval/policy').data.policy, 'never');
  await stop(); await start();
  assert.equal((await permissionState()).permissions.current, 'danger-full-access');
  await choosePermission('read-only');
  await writeFile(permissionFile, 'still read-only');
  const editTarget = full.events.find(e => e.type === 'user/message' && e.data.source?.rpcId === 'full-access');
  const permissionEdit = await api(`${pp}/dsh/revisions`, { id: 'permission-edit', kind: 'edit',
    version: restricted.id, seq: editTarget.seq, text: 'PERMISSION-WRITE', attachments: [] });
  const editedPermission = await until(permissionState, s => !s.running && s.history.active === permissionEdit.active, 'permission after edit');
  assert.equal(editedPermission.permissions.current, 'read-only');
  assert.equal(await readFile(permissionFile, 'utf8'), 'still read-only');
  await rejected(`${pp}/dsh/permissions`, { version: restricted.id, permission: 'danger-full-access' }, 409, 'PUT');
  await rejected(`${pp}/dsh/permissions`, { version: permissionEdit.active, permission: 'custom' }, 400, 'PUT');
  await choosePermission('workspace-write');
  await api(`${pp}/dsh/version`, { expected: permissionEdit.active, version: restricted.id }, 'PUT');
  assert.equal((await permissionState()).permissions.current, 'read-only', 'changing a revision does not mutate its parent');
  await stop(); await start();
  assert.equal((await permissionState()).permissions.current, 'read-only');
  console.log('PASS permissions: denied write, workspace write, actual approval/rejection/cancellation, full access, restart, revision inheritance and stale-version rejection');
  // Removing a chat archives every native history, waits for process exit, and
  // cannot reappear through another App read route or a host restart.
  const preservedPermissionFile = await readFile(permissionFile);
  await api(`${pp}/dsh/version`, { expected: restricted.id, version: permissionEdit.active }, 'PUT');
  await api(`${pp}/messages`, { id: 'delete-running', content: 'CANCEL-SHELL' });
  const deletionPid = await until(async () => {
    try { const value = Number(await readFile(join(workspace, 'running.pid'), 'utf8')); process.kill(value, 0); return value; } catch { return null; }
  }, Boolean, 'native process before deletion');
  await api(pp, undefined, 'DELETE');
  assert.throws(() => process.kill(deletionPid, 0), 'deletion acknowledges actual process exit');
  await rejected(pp, undefined, 404, 'GET');
  await rejected(`${pp}/dsh`, undefined, 404, 'GET');
  assert.equal((await api('/conversations')).items.some(chat => chat.id === restricted.id), false);
  await api(pp, undefined, 'DELETE');
  await stop(); await start();
  assert.equal((await api('/conversations')).items.some(chat => chat.id === restricted.id), false);
  assert.equal((await api('/conversations/search?q=PERMISSION')).items.some(chat => chat.conversation_id === restricted.id), false);
  await rejected(`${pp}/messages`, { id: 'deleted-cannot-send', content: 'READ-WRITE-CHECK' }, 404);
  await rejected(`${pp}/dsh/version`, { expected: permissionEdit.active, version: restricted.id }, 404, 'PUT');
  assert.deepEqual(await readFile(permissionFile), preservedPermissionFile, 'removing the conversation preserves workspace files');
  console.log('PASS chat removal: native cancellation, durable deletion, all histories inaccessible, retry and restart, workspace files preserved');
  const privateChat = await api('/conversations', { title: 'Private environment acceptance', permission: 'workspace-write' });
  const pv = `/conversations/${privateChat.id}`, privateState = () => api(`${pv}/dsh`);
  const privateValue = `TEST_ONLY_${randomUUID()}`, secondValue = `TEST_ONLY_${randomUUID()}`;
  const privateHash = createHash('sha256').update(privateValue).digest('hex');
  await api(`${pv}/messages`, { id: 'private-values', content: 'PRIVATE-VALUES' });
  const filling = await until(privateState, s => s.pending.some(p => p.kind === 'environment'), 'private variable card');
  const card = filling.pending.find(p => p.kind === 'environment');
  const privateBody = { version: privateChat.id, submissionId: randomUUID(), fields: card.fields.map((field, index) => ({ id: field.id,
    name: index ? field.name : 'DSH_SECRET_RENAMED_TOKEN', value: index ? secondValue : privateValue })) };
  await rejected(`${path}/dsh/environment/${card.id}`, { ...privateBody, version: chat.id }, 409);
  await rejected(`${pv}/dsh/environment/${card.id}`, { ...privateBody, version: 'stale' }, 409);
  await rejected(`${pv}/dsh/environment/${card.id}`, { ...privateBody, fields: privateBody.fields.map(item => ({ ...item, name: 'PATH' })) }, 400);
  const privateReceipt = await api(`${pv}/dsh/environment/${card.id}`, privateBody);
  assert.deepEqual(privateReceipt.names, ['DSH_SECRET_RENAMED_TOKEN', 'DSH_SECRET_API_KEY']);
  assert.deepEqual(await api(`${pv}/dsh/environment/${card.id}`, privateBody), privateReceipt, 'lost receipt can retry without another write');
  const privateDone = await until(privateState, s => !s.running && !s.pending.length, 'private execution and output guard');
  assert.match(JSON.stringify(privateDone), new RegExp(privateHash), 'native bash consumed the exact submitted bytes');
  assert.match(JSON.stringify(privateDone), /工具返回内容包含私密变量值/);
  for (const value of [privateValue, secondValue]) {
    assert.ok(!JSON.stringify(privateDone).includes(value));
    assert.ok(!(await readFile(join(root, 'model.json'), 'utf8')).includes(value), 'cloud model envelope has no private value');
  }
  const credentialsFile = join(root, 'home', '.credentials.yaml');
  assert.equal((await stat(credentialsFile)).mode & 0o777, 0o600);
  const privateBytes = await readFile(credentialsFile);
  await api(`${pv}/messages`, { id: 'private-cancel', content: 'PRIVATE-VALUES' });
  const cancelling = await until(privateState, s => s.pending.some(p => p.kind === 'environment'), 'private cancellation');
  const cancelId = cancelling.pending.find(p => p.kind === 'environment').id;
  await api(`${pv}/dsh/cancel`, {});
  await rejected(`${pv}/dsh/environment/${cancelId}`, { ...privateBody, submissionId: randomUUID() }, 409);
  assert.deepEqual(await readFile(credentialsFile), privateBytes, 'cancel never writes private values');
  await stop(); await start();
  await api(`${pv}/messages`, { id: 'private-restart', content: 'PRIVATE-RESTART' });
  const privateRestored = await until(privateState, s => !s.running && s.events.some(e => e.type === 'user/message' && e.data.source?.rpcId === 'private-restart'), 'persisted private execution');
  assert.match(JSON.stringify(privateRestored.events.filter(e => e.seq >= privateDone.next)), new RegExp(privateHash));
  // The snapshot uses native sessionPersistence.open/read after a host restart.
  // Inspect every decoded event rather than silently missing .jsonl.zstd files
  // or depending on the host's multi-frame storage codec.
  assert.equal(privateRestored.hasMore, false, 'all persisted private-input events must be inspected');
  const persistedPrivateEvents = JSON.stringify(privateRestored.events);
  assert.ok(privateRestored.events.some(e => e.type === 'tool/result' && JSON.stringify(e.data).includes('DSH_SECRET_RENAMED_TOKEN')),
    'the restored native log must contain the submitted variable-name receipt');
  assert.ok(!persistedPrivateEvents.includes(privateValue) && !persistedPrivateEvents.includes(secondValue), 'private values must not survive in the native session log');
  console.log('PASS private variables: editable multi-field card, authenticated version/session binding, exact native env bytes, retry, output guard, cancellation, private credential storage, restart and no values in model/session logs');
  await writeFile(join(root, 'final-events.json'), JSON.stringify(await snapshot(), null, 2));
  console.log(`Evidence: ${root}`);
} finally { await stop(); }
