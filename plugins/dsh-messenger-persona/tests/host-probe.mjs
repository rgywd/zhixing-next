// Loaded only into an isolated acceptance host; never included in the package.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { assembleContextFor, installModelSelection } from '@deepseek-ai/dsh-agent';
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt';

export const inject = ['agents', 'systemPrompt', 'webServer', 'sessionPersistence', 'sessionController'];
export function apply(ctx, config) {
  const handles = new Map();
  const ensure = async id => {
    if (!handles.has(id) && await ctx.sessionPersistence.stat(id)) {
      const restored = await ctx.sessionController.resolveAgent(id);
      if (restored.error) throw restored.error;
      handles.set(id, { agent: restored.agent });
    }
    if (!handles.has(id)) handles.set(id, await ctx.agents.create({ sessionId: id, meta: { cwd: config.workspace },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
      setup: agentCtx => { installModelSelection(agentCtx, { current: { provider: 'deepseek-official', model: 'deepseek-flash' } }); },
    }));
    return handles.get(id).agent;
  };
  const assemble = agent => ctx.systemPrompt.assemble(assembleContextFor(agent));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/persona-acceptance', handler: async (req, res) => {
    if (req.headers.authorization !== `Bearer ${config.token}`) { res.writeHead(401); res.end(); return; }
    try {
      let text = ''; for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : {};
      const id = body.id || 'msgw-persona-loading-final';
      const agent = await ensure(id);
      let output;
      if (body.action === 'talk') {
        // Fish-memory 1.4.3 mounts through its own 500ms tick.
        await new Promise(resolve => setTimeout(resolve, 700));
        const before = agent.session.snapshotEvents().length;
        agent.followup(createUserMessage({ content: [{ type: 'text', text: body.text }],
          source: { kind: 'user', plugin: 'persona-acceptance', form: 'relay', origin: 'telegram' } }));
        await agent.whenIdle();
        const events = agent.session.snapshotEvents().slice(before);
        const texts = events.filter(e => e.type === 'assistant/message').flatMap(e =>
          (e.data.message?.content || []).filter(b => b.type === 'text').map(b => b.text));
        assert.ok(texts.length > 0, JSON.stringify(events.filter(e => e.type === 'turn/end').at(-1)?.data));
        output = { id, replies: texts, toolNames: events.filter(e => e.type === 'assistant/message').flatMap(e =>
          (e.data.message?.content || []).filter(b => b.type === 'tool-call').map(b => b.name)),
        end: events.filter(e => e.type === 'turn/end').at(-1)?.data,
        memoryContext: (await assemble(agent)).contexts.find(c => c.name === 'memory')?.text || '' };
      } else {
        const original = readFileSync(config.personaFile, 'utf8');
        const web = await ensure('web-persona-acceptance');
        const app = await ensure('zhixing-main-persona-acceptance');
        const baseline = await assemble(agent);
        const prompt = renderPrompt(baseline);
        assert.ok(prompt.includes('你以“三月七”的身份'));
        assert.equal(baseline.sections.filter(s => s.name === 'deployment:persona-prefix').length, 1);
        assert.ok(!renderPrompt(await assemble(web)).includes('你以“三月七”的身份'));
        assert.ok(!renderPrompt(await assemble(app)).includes('你以“三月七”的身份'));
        assert.equal(baseline.sections.filter(s => s.name === 'zhixing:messenger-channel').length, 1);
        assert.ok(!renderPrompt(await assemble(app)).includes('这是实际的线上聊天'));
        try {
          writeFileSync(config.personaFile + '.next', original + '\n热加载验收 {{literal_is_not_a_variable}}');
          renameSync(config.personaFile + '.next', config.personaFile);
          assert.ok(renderPrompt(await assemble(agent)).includes('{{literal_is_not_a_variable}}'));
          writeFileSync(config.personaFile, '');
          assert.ok(renderPrompt(await assemble(agent)).includes('热加载验收'));
        } finally { writeFileSync(config.personaFile, original); }
        const stable = renderPrompt(await assemble(agent));
        assert.equal(stable, renderPrompt(await assemble(agent)));
        assert.deepEqual((await assemble(agent)).tools.map(t => t.name), baseline.tools.map(t => t.name));
        output = { ok: true, id, assertions: ['native system section', 'no duplicate persona', 'web isolated', 'App isolated',
          'tool registrations unchanged', 'scoped channel guidance', 'same-session hot reload', 'literal braces', 'last-good fallback', 'recovery', 'stable prefix'],
        personaChars: original.length, toolCount: baseline.tools.length };
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(output));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message, stack: error.stack }));
    }
  } }));
}
