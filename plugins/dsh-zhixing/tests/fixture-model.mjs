// Deterministic model for real-host integration tests. Never used by the bundle.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

export const inject = ['llm', 'sessionProjections'];
export function apply(ctx, config) {
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') appendFileSync(config.evidence + '.stats.jsonl', JSON.stringify({ id: session.id, seq: event.seq,
      values: ctx.sessionProjections.snapshot(session).values }) + '\n');
  });
  class Fixture extends LlmAdapter {
    async listModels(provider) { return ['fixture', 'fixture-other'].map(id => ({ provider, id, name: `Local acceptance ${id}` })); }
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 128000 }, inputModalities: ['text', 'image'] }; }
    async *stream(options) {
      const messages = options.messages;
      const summarizing = messages.at(-1)?.content?.some(p => p.type === 'text' && p.text.includes('You are now acting as a compaction engine'));
      if (summarizing) {
        await new Promise((resolve, reject) => {
          const stop = () => { clearTimeout(timer); reject(new Error('Fixture summary cancelled')); };
          const timer = setTimeout(() => { options.signal?.removeEventListener('abort', stop); resolve(); }, 1000);
          options.signal?.addEventListener('abort', stop, { once: true });
          if (options.signal?.aborted) stop();
        });
        if (JSON.stringify(messages).includes('COMPACT-SUMMARY-FAIL')) throw new Error('Fixture summary failure');
        const block = { type: 'text', text: 'Completed earlier acceptance work. Continue with the next user request.' };
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: block.text };
        yield { type: 'block-end', index: 0, block };
        yield { type: 'finish', reason: 'stop' };
        return;
      }
      const lastUser = messages.findLastIndex(m => m.role === 'user' && (m.source?.kind === 'user' || m.content?.some(p => p.type === 'text' && /READ-WRITE-CHECK|CANCEL-SHELL|ASK-QUESTION|RESUME-CHECK|BUSINESS-SCHEMA/.test(p.text))));
      const prompt = messages[lastUser]?.content?.filter(p => p.type === 'text').map(p => p.text).join('\n') ?? '';
      const results = messages.slice(lastUser + 1).filter(m => m.role === 'tool');
      await writeFile(config.evidence, JSON.stringify({ tools: options.tools?.map(t => t.name), prompt, results,
        userTexts: messages.filter(m => m.role === 'user').flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text)) }, null, 2));
      let block;
      const call = (name, args) => ({ type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) });
      if (prompt.includes('PRIVATE-VALUES') && results.length < 3) {
        if (!results.length) block = call('zhixing_request_variables', { title: '连接测试服务', fields: [
          { name: 'DSH_SECRET_BOT_TOKEN', label: 'Bot Token' }, { name: 'DSH_SECRET_API_KEY', label: 'API Key' },
        ] });
        else if (results.length === 1) block = call('bash', { description: 'Verify environment values without printing them', command:
          `node -e 'const c=require("node:crypto"); for(const n of ["DSH_SECRET_RENAMED_TOKEN","DSH_SECRET_API_KEY"]) {if(!process.env[n])process.exit(9); console.log(n+"="+c.createHash("sha256").update(process.env[n]).digest("hex"))}'` });
        else block = call('bash', { description: 'Exercise the private output guard', command: 'printf "%s" "$DSH_SECRET_RENAMED_TOKEN"' });
      } else if (prompt.includes('PRIVATE-RESTART') && !results.length) {
        block = call('bash', { description: 'Verify persisted private environment', command:
          `node -e 'const c=require("node:crypto");console.log(c.createHash("sha256").update(process.env.DSH_SECRET_RENAMED_TOKEN||"").digest("hex"))'` });
      } else if (prompt.includes('PERMISSION-WRITE') && results.length < 2) {
        block = results.length === 0 ? call('read', { file_path: `${config.workspace}/permission.txt` })
          : call('write', { file_path: `${config.workspace}/permission.txt`, content: 'permission write executed\n' });
      } else if (prompt.includes('PERMISSION-ESCALATE') && !results.length) {
        block = call('bash', { command: 'printf approved > escalation.txt', workdir: config.workspace,
          description: 'Write the permission regression marker', sandbox_permissions: 'danger-full-access',
          justification: 'Approve this isolated permission regression command.' });
      } else if (prompt.includes('READ-WRITE-CHECK') && results.length < 3) {
        block = [
          () => call('read', { file_path: `${config.workspace}/sample.js` }),
          () => call('write', { file_path: `${config.workspace}/sample.js`, content: 'export const answer = 42;\n' }),
          () => call('bash', { command: "node --input-type=module -e \"import { answer } from './sample.js'; if (answer !== 42) process.exit(1); console.log('CHECK_PASSED')\"", description: 'Check the edited module returns forty two', workdir: config.workspace }),
        ][results.length]();
      } else if (prompt.includes('PUBLISH-CHECK') && !results.length) {
        block = call('present', { files: [{ path: `${config.workspace}/sample.js`, description: '交付结果' }] });
      } else if (prompt.includes('QUEUE-WINDOW') && !results.length) {
        block = call('bash', { command: 'sleep 2', description: 'Keep a short queue window', workdir: config.workspace });
      } else if (prompt.includes('CANCEL-SHELL') && !results.length) {
        block = call('bash', { command: 'echo $$ > running.pid; sleep 45; echo unexpected > should-not-exist', description: 'Run a cancellable integration check command', workdir: config.workspace, timeoutMs: 60000 });
      } else if (prompt.includes('ASK-QUESTION') && !results.length) {
        block = call('ask_user_question', { questions: [{ id: 'choice', question: 'Choose acceptance option', options: [{ label: 'Proceed' }, { label: 'Stop' }] }] });
      } else if (prompt.includes('BUSINESS-SCHEMA') && !results.length) {
        block = call('zhixing_service', { method: 'GET', path: '/v1/business/schema' });
      } else block = { type: 'text', text: `FIXTURE_DONE: ${prompt}; priorMessages=${messages.length}; results=${JSON.stringify(results)}` };
      await new Promise(resolve => setTimeout(resolve, 15));
      yield { type: 'block-start', index: 0, blockType: block.type };
      if (block.type === 'text') yield { type: 'text-delta', index: 0, text: block.text };
      yield { type: 'block-end', index: 0, block };
      await new Promise(resolve => setTimeout(resolve, 20));
      yield { type: 'usage', usage: { inputTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 20, outputTokens: 40 } };
      yield { type: 'finish', reason: block.type === 'tool-call' ? 'tool_calls' : 'stop' };
    }
  }
  ctx.llm.registerAdapter(['zhixing-fixture'], new Fixture());
}
