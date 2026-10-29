import { z } from 'zod';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { contracts, copy, fail } from './common.mjs';
import { Finance } from './finance.mjs';
import { Health, initialHealthState } from './health.mjs';
import { Life } from './life.mjs';

export const tableNames = ['finance_observations', 'finance_budgets', 'finance_transactions', 'finance_mutations', 'health_state', 'health_rules', 'health_meals', 'health_weights', 'health_steps', 'health_recommendations', 'health_feedback', 'health_writes', 'health_mutations', 'life_events', 'life_receipts'];
export const emptyState = () => ({ tables: { ...Object.fromEntries(tableNames.map(k => [k, []])), health_state: [initialHealthState()] }, imported: null });
export const businessSpec = defineDomain({ name: 'zhixing_business', version: 1, layout: 'single',
  global: { schema: z.object({
    tables: z.object(Object.fromEntries(tableNames.map(k => [k, z.array(z.record(z.string(), z.json()))]))),
    imported: z.json().nullable(),
  }), initial: emptyState() }, tables: {} });

export const businessPath = path => /^\/v1\/(finance|health|life|business\/schema)(\/|\?|$)/.test(path);
export function dispatch(state, path, method = 'GET', body = {}) {
  const url = new URL(path, 'http://zhixing.invalid');
  if (url.origin !== 'http://zhixing.invalid' || !businessPath(url.pathname)) fail('Unknown business route', 'not_found', 404);
  const query = url.searchParams, pathname = url.pathname;
  const q = name => query.get(name) ?? undefined;
  const number = (name, fallback) => q(name) === undefined ? fallback : Number(q(name));
  const f = new Finance(state.tables), h = new Health(state.tables), life = new Life(state.tables);
  if (method === 'GET' && pathname === '/v1/business/schema') return schema(q('domain'));
  if (pathname === '/v1/finance/summary' && method === 'GET') return f.summary(q('month'), q('as_of'));
  if (pathname === '/v1/finance/observations' && method === 'GET') {
    return { items: copy(state.tables.finance_observations), scope: 'historical_observations', notice: '旧资产观察按原样保留，不代表当前余额，也不计入收支流水。' };
  }
  if (pathname === '/v1/finance/budget') {
    if (method === 'GET') return f.budget(q('month'));
    if (method === 'PUT') return f.setBudget(body);
    if (method === 'PATCH') return f.patchBudget(body);
    if (method === 'DELETE') {
      if (q('recurring') && !['true', 'false'].includes(q('recurring'))) fail('Invalid recurring value');
      return f.deleteBudget(q('month'), q('recurring') === 'true', q('idempotency_key'));
    }
  }
  if (pathname === '/v1/finance/transactions') {
    if (method === 'GET') return f.list(q('month'), number('limit', 50), number('offset', 0));
    if (method === 'POST') return f.create(body);
  }
  if (pathname === '/v1/finance/transactions/batch' && method === 'POST') return f.batch(body);
  const transaction = pathname.match(/^\/v1\/finance\/transactions\/([^/]+)$/);
  if (transaction) {
    if (method === 'PATCH') return f.update(decodeURIComponent(transaction[1]), body);
    if (method === 'DELETE') return f.delete(decodeURIComponent(transaction[1]), q('idempotency_key'));
  }
  if (pathname === '/v1/health/summary' && method === 'GET') return h.summary(q('date'));
  const health = pathname.match(/^\/v1\/health\/(profile|reminders|rules|meals|weights|steps|recommendations)(?:\/([^/]+))?(\/feedback)?$/);
  if (health) {
    const [, kind, identifier, feedback] = health, id = identifier && decodeURIComponent(identifier), key = q('idempotency_key');
    if (feedback) { if (kind === 'recommendations' && method === 'POST') return h.feedback(id, body, key); }
    else if (['profile', 'reminders'].includes(kind) && !id) {
      if (method === 'GET') return h[kind]();
      if (['PUT', 'PATCH'].includes(method)) return h.set(kind, body, key, method === 'PATCH');
    } else if (!id) {
      if (method === 'GET') return h.list(kind, { start: q('start'), end: q('end'), limit: number('limit', 100) });
      if (method === 'POST') return h.create(kind, body, key);
    } else {
      if (['PUT', 'PATCH'].includes(method)) return h.update(kind, id, body, key, method === 'PATCH');
      if (method === 'DELETE') {
        const revision = number('revision', null);
        if (!Number.isInteger(revision) || revision < 1) fail('A current revision is required');
        return h.delete(kind, id, revision, key);
      }
    }
  }
  if (pathname === '/v1/life/meals') {
    if (method === 'POST') return life.record(body);
    if (method === 'GET') return life.list(q('source_id'), number('limit', 30));
  }
  const event = pathname.match(/^\/v1\/life\/meals\/([^/]+)$/);
  if (event && method === 'PATCH') return life.correct(decodeURIComponent(event[1]), body);
  fail('Unknown business route', 'not_found', 404);
}

export function createBusinessService(global) {
  let tail = Promise.resolve();
  return {
    request(path, method = 'GET', body, signal) {
      const result = tail.then(async () => {
        signal?.throwIfAborted();
        const state = copy(await global.get());
        const output = dispatch(state, path, method, body);
        signal?.throwIfAborted();
        // One native DSH commit includes both meal/payment records and their retry receipts.
        if (method !== 'GET') await global.set(state);
        return output;
      });
      tail = result.catch(() => {});
      return result;
    },
    drained: () => tail,
  };
}
export async function openBusinessStorage(ctx, importPath) {
  const domain = await ctx.storageDomain.open(businessSpec);
  if (importPath) {
    try { await (await import('./import.mjs')).importBusiness(domain.global, importPath); }
    catch (error) { await domain.close(); throw error; }
  }
  const service = createBusinessService(domain.global);
  return { ...service, close: async () => { await service.drained(); await domain.close(); } };
}

function schema(domain) {
  const routes = [
    ['GET', '/finance/summary?month=YYYY-MM&as_of=YYYY-MM-DD'], ['GET', '/finance/budget?month=YYYY-MM'],
    ['GET', '/finance/observations'],
    ['PUT', '/finance/budget', 'BudgetInput'], ['PATCH', '/finance/budget', 'BudgetPatch'], ['DELETE', '/finance/budget?month=YYYY-MM&recurring=false&idempotency_key=unique'],
    ['GET', '/finance/transactions?month=YYYY-MM&limit=50&offset=0'], ['POST', '/finance/transactions', 'TransactionInput'],
    ['PATCH', '/finance/transactions/{id}', 'TransactionUpdate'], ['DELETE', '/finance/transactions/{id}?idempotency_key=unique'], ['POST', '/finance/transactions/batch', 'TransactionBatch'],
    ['GET', '/health/summary?date=YYYY-MM-DD'], ...['profile', 'reminders'].flatMap(k => [['GET', `/health/${k}`], ['PUT', `/health/${k}`, k === 'profile' ? 'ProfileInput' : 'RemindersInput'], ['PATCH', `/health/${k}`, 'partial settings; omitted fields preserved']]),
    ...Object.entries({ rules: 'RuleInput', meals: 'MealInput', weights: 'WeightInput', steps: 'StepsInput', recommendations: 'RecommendationInput' }).flatMap(([k, model]) => [
      ['GET', `/health/${k}?start=YYYY-MM-DD&end=YYYY-MM-DD&limit=100`], ['POST', `/health/${k}?idempotency_key=unique`, model],
      ...(k === 'recommendations' ? [['POST', '/health/recommendations/{id}/feedback?idempotency_key=unique', 'FeedbackInput']] : [['PUT', `/health/${k}/{id}`, model], ['PATCH', `/health/${k}/{id}`, 'partial record; omitted fields preserved'], ['DELETE', `/health/${k}/{id}?revision=current`]]),
    ]),
    ['POST', '/life/meals', 'source_id, entry_key, conversation_id, meal (MealInput actual fields), optional amount and occurred_on; atomic meal and explicit payment'],
    ['PATCH', '/life/meals/{event_id}', 'source_id, entry_key, meal_changes, finance_changes (amount, occurred_on, category, note)'], ['GET', '/life/meals?source_id=optional&limit=30'],
  ].filter(([, path]) => !domain || path.startsWith(`/${domain}/`));
  const needed = new Set(routes.map(r => r[2]).filter(n => contracts[n]));
  if (domain === 'life') needed.add('MealInput');
  return { routes: routes.map(([method, path, body]) => ({ method, path: `/v1${path}`, ...(body ? { body } : {}) })),
    schemas: Object.fromEntries([...needed].map(k => [k, contracts[k]])),
    notes: ['Read current summary before changes or advice; use revisions and stable request IDs for retries.', 'Only record supplied facts. Unknown dates, meals and payments stay unknown. No amount means no payment; accepting a recommendation is not actual intake.', 'Money is decimal text. Transfers of existing assets are not new income. Budget PATCH preserves omitted fields.', 'Search, memory, threads and files are native DSH/plugin capabilities, outside this business API.'] };
}
