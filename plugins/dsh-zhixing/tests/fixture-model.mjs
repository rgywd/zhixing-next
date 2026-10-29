// Deterministic model for real-host integration tests. Never used by the bundle.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const inject = ['llm'];
export function apply(ctx, config) {
  class Fixture extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'fixture', name: 'Local acceptance fixture' }]; }
    async resolveModel(provider, model) { return { provider, id: model, name: model, contextWindow: 128000, inputModalities: ['text', 'image'] }; }
    async *stream(options) {
      const messages = options.messages;
      const lastUser = messages.findLastIndex(m => m.role === 'user' && (m.source?.kind === 'user' || m.content?.some(p => p.type === 'text' && /READ-WRITE-CHECK|CANCEL-SHELL|ASK-QUESTION|RESUME-CHECK|BUSINESS-SCHEMA/.test(p.text))));
      const prompt = messages[lastUser]?.content?.filter(p => p.type === 'text').map(p => p.text).join('\n') ?? '';
      const results = messages.slice(lastUser + 1).filter(m => m.role === 'tool');
      await writeFile(config.evidence, JSON.stringify({ tools: options.tools?.map(t => t.name), prompt, results,
        userTexts: messages.filter(m => m.role === 'user').flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text)) }, null, 2));
      let block;
      const call = (name, args) => ({ type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) });
      if (prompt.includes('READ-WRITE-CHECK') && results.length < 3) {
        block = [
          () => call('read', { file_path: `${config.workspace}/sample.js` }),
          () => call('write', { file_path: `${config.workspace}/sample.js`, content: 'export const answer = 42;\n' }),
          () => call('bash', { command: "node --input-type=module -e \"import { answer } from './sample.js'; if (answer !== 42) process.exit(1); console.log('CHECK_PASSED')\"", description: 'Check the edited module returns forty two', workdir: config.workspace }),
        ][results.length]();
      } else if (prompt.includes('PUBLISH-CHECK') && !results.length) {
        block = call('zhixing_publish_file', { file_path: `${config.workspace}/sample.js`, name: 'delivered.js' });
      } else if (prompt.includes('QUEUE-WINDOW') && !results.length) {
        block = call('bash', { command: 'sleep 2', description: 'Keep a short queue window', workdir: config.workspace });
      } else if (prompt.includes('CANCEL-SHELL') && !results.length) {
        block = call('bash', { command: 'echo $$ > running.pid; sleep 45; echo unexpected > should-not-exist', description: 'Run a cancellable integration check command', workdir: config.workspace, timeoutMs: 60000 });
      } else if (prompt.includes('ASK-QUESTION') && !results.length) {
        block = call('ask_user_question', { questions: [{ id: 'choice', question: 'Choose acceptance option', options: [{ label: 'Proceed' }, { label: 'Stop' }] }] });
      } else if (prompt.includes('BUSINESS-SCHEMA') && !results.length) {
        block = call('zhixing_service', { method: 'GET', path: '/v1/business/schema' });
      } else block = { type: 'text', text: `FIXTURE_DONE: ${prompt}; priorMessages=${messages.length}; results=${JSON.stringify(results)}` };
      yield { type: 'block-start', index: 0, blockType: block.type };
      if (block.type === 'text') yield { type: 'text-delta', index: 0, text: block.text };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: block.type === 'tool-call' ? 'tool_calls' : 'stop' };
    }
  }
  ctx.llm.registerAdapter(['zhixing-fixture'], new Fixture());
}
